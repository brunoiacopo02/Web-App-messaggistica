import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings } from '@/lib/lancio-settings';
import { richiediAdmin } from '@/lib/console/guardia';
import { ASSISTENTE_MODEL, systemPrompt } from '@/lib/console/assistente-prompt';
import { STRUMENTI, eseguiStrumento, type Citazione } from '@/lib/console/assistente-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_GIRI = 8;
const TETTO_MS = 90_000;

const Corpo = z.object({
  messaggi: z
    .array(z.object({ ruolo: z.enum(['utente', 'assistente']), testo: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(20)
    .refine((m) => m.at(-1)?.ruolo === 'utente', "L'ultimo messaggio deve essere dell'utente"),
});

type Evento =
  | { tipo: 'strumento'; nome: string; sintesi: string }
  | { tipo: 'testo'; testo: string }
  | { tipo: 'citazioni'; citazioni: Citazione[] }
  | { tipo: 'proposta'; proposta: NonNullable<Awaited<ReturnType<typeof eseguiStrumento>>['proposta']> }
  | { tipo: 'bozza'; bozza: NonNullable<Awaited<ReturnType<typeof eseguiStrumento>>['bozza']> }
  | { tipo: 'fine' }
  | { tipo: 'errore'; messaggio: string };

class Scaduto extends Error {}

/** Il messaggio per l'admin: cosa è successo e come si recupera. */
function messaggioErrore(e: unknown): string {
  if (e instanceof Scaduto) return "L'Assistente non ha risposto entro 90 secondi. Riprova con una domanda più precisa.";
  const err = e as { status?: number; message?: string; name?: string };
  const status = typeof err.status === 'number' ? err.status : null;
  if (err.message?.includes('ANTHROPIC_API_KEY')) return "Manca ANTHROPIC_API_KEY sul server: l'Assistente non può rispondere finché non viene impostata.";
  if (status === 401 || status === 403) return "Anthropic ha rifiutato la chiave dell'Assistente: va controllata ANTHROPIC_API_KEY sul server.";
  if (status === 429) return 'Troppe richieste ad Anthropic in questo momento. Riprova fra un minuto.';
  if (status !== null && status >= 500) return 'Anthropic è sovraccarico o non risponde. Riprova fra qualche minuto.';
  if (status === 400) return 'Anthropic ha rifiutato la richiesta. Ricomincia la conversazione e riprova.';
  return "L'Assistente si è interrotto per un errore imprevisto. Riprova; se succede ancora, ricomincia la conversazione.";
}

/**
 * L'Assistente della Console: un ciclo di al massimo 8 giri col modello, che legge con gli
 * strumenti di sola lettura e restituisce eventi SSE (`data: {json}` per riga). Lo stream
 * finisce sempre con `fine` o con `errore`.
 */
export async function POST(req: Request) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  let corpo: z.infer<typeof Corpo>;
  try {
    const p = Corpo.safeParse(await req.json());
    if (!p.success) {
      return NextResponse.json({ error: 'richiesta_non_valida', messaggio: p.error.issues[0]?.message ?? '' }, { status: 400 });
    }
    corpo = p.data;
  } catch {
    return NextResponse.json({ error: 'richiesta_non_valida', messaggio: 'Il corpo non è JSON.' }, { status: 400 });
  }

  // La conversazione per il modello comincia sempre dall'utente.
  const inizio = corpo.messaggi.findIndex((m) => m.ruolo === 'utente');
  const messages: Anthropic.MessageParam[] = corpo.messaggi.slice(inizio).map((m) => ({
    role: m.ruolo === 'utente' ? 'user' : 'assistant',
    content: m.testo,
  }));

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const invia = (e: Evento) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          // Il client ha chiuso: il resto del giro si perde senza danni, niente scrive.
        }
      };

      const tetto = new AbortController();
      const timer = setTimeout(() => tetto.abort(new Scaduto()), TETTO_MS);
      // Anche gli strumenti stanno sotto il tetto: una lettura lenta non tiene aperta la rotta.
      const entroIlTetto = <T,>(p: Promise<T>): Promise<T> =>
        new Promise<T>((ok, ko) => {
          if (tetto.signal.aborted) return ko(new Scaduto());
          const scade = () => ko(new Scaduto());
          tetto.signal.addEventListener('abort', scade, { once: true });
          // Il listener si toglie a ogni passo: in 8 giri si accumulerebbero oltre il limite di Node.
          p.then(ok, ko).finally(() => tetto.signal.removeEventListener('abort', scade));
        });

      try {
        const now = new Date();
        const s = getSupabaseAdmin();
        const lancio = await entroIlTetto(getLancioSettings(s));
        const system = systemPrompt(now, { attivo: lancio.attivo, eventoAt: lancio.eventoAt });
        const client = new Anthropic();
        const citazioni = new Map<string, Citazione>();

        for (let giro = 0; giro < MAX_GIRI; giro++) {
          const risposta = await entroIlTetto(
            client.messages.create(
              { model: ASSISTENTE_MODEL, max_tokens: 2000, system, tools: STRUMENTI, messages },
              { signal: tetto.signal },
            ),
          );

          if (risposta.stop_reason === 'tool_use') {
            messages.push({ role: 'assistant', content: risposta.content });
            const risultati: Anthropic.ToolResultBlockParam[] = [];
            for (const blocco of risposta.content) {
              if (blocco.type !== 'tool_use') continue;
              const r = await entroIlTetto(eseguiStrumento(blocco.name, blocco.input, { s, now: new Date() }));
              invia({ tipo: 'strumento', nome: blocco.name, sintesi: r.sintesi });
              if (r.proposta) invia({ tipo: 'proposta', proposta: r.proposta });
              if (r.bozza) invia({ tipo: 'bozza', bozza: r.bozza });
              for (const c of r.citazioni) citazioni.set(`${c.tipo}:${c.id}`, c);
              risultati.push({ type: 'tool_result', tool_use_id: blocco.id, content: r.contenuto, ...(r.errore ? { is_error: true } : {}) });
            }
            messages.push({ role: 'user', content: risultati });
            continue;
          }

          if (risposta.stop_reason === 'refusal') {
            invia({ tipo: 'errore', messaggio: "L'Assistente non risponde a questa richiesta. Riformulala." });
            return;
          }

          const testo = risposta.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
          if (testo) invia({ tipo: 'testo', testo });
          if (citazioni.size > 0) invia({ tipo: 'citazioni', citazioni: [...citazioni.values()] });
          invia({ tipo: 'fine' });
          return;
        }
        invia({
          tipo: 'errore',
          messaggio: "L'Assistente ha fatto troppi passaggi senza arrivare a una risposta. Riprova con una domanda più precisa.",
        });
      } catch (e) {
        const scaduto = tetto.signal.aborted ? new Scaduto() : e;
        if (!(scaduto instanceof Scaduto)) console.error('[console/assistente]', (e as Error)?.message ?? e);
        invia({ tipo: 'errore', messaggio: messaggioErrore(scaduto) });
      } finally {
        clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // già chiuso dal client
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
