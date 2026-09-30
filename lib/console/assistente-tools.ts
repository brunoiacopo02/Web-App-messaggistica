import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { getSupabaseAdmin } from '@/lib/supabase/admin';
import { isConversazioneChat } from '@/lib/chat-perimetro';
import { erroreTwilio } from '@/lib/lancio-monitor';
import { isLancioFase } from '@/lib/lancio-fase';
import { PARAMS } from './azioni';
import { ID_AZIONI, ID_CRON, type IdAzione } from './azioni-tipi';
import type { AzioneRef } from './avvisi';
import { leggiAvvisi } from './avvisi-db';
import { leggiRegia } from './regia-db';
import { autoreDi } from './thread';
import { ETICHETTA_FASE, VISTA_META, VISTE } from './viste';
import { cercaChat, contaViste } from './viste-db';

/**
 * Gli strumenti dell'Assistente della Console. Tutti di SOLA LETTURA: nessuno scrive sul DB,
 * nessuno manda messaggi. `proponi_azione` e `bozza_risposta` restituiscono solo una proposta
 * e una bozza che l'admin vede nell'interfaccia: eseguirle o inviarle resta un suo gesto.
 */

type Supa = ReturnType<typeof getSupabaseAdmin>;
// Le letture per chiave JSON di event_log non sono tipizzate: lo stesso cast di `avvisi-db`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Grezzo = { from: (t: string) => any };
const grezzo = (s: Supa) => s as unknown as Grezzo;

export type Citazione = { tipo: 'chat' | 'avviso'; id: string | number; etichetta: string };
export type RisultatoStrumento = {
  contenuto: string;
  citazioni: Citazione[];
  /** La riga che l'interfaccia mostra mentre l'Assistente lavora ("Letti 214 eventi…"). */
  sintesi: string;
  /** `true` se lo strumento non ha potuto leggere: il `tool_result` va marcato `is_error`. */
  errore?: true;
  proposta?: AzioneRef;
  bozza?: { conversationId: number; testo: string };
};
export type ContestoStrumento = { s: Supa; now: Date };

const MAX_CONTENUTO = 2000;
const MAX_BOZZA = 4000;
const ORA = 3600_000;

/** Taglia il testo a `max` caratteri (puntini compresi): il contesto del modello non si gonfia. */
export function tronca(testo: string, max = MAX_CONTENUTO): string {
  return testo.length <= max ? testo : `${testo.slice(0, max - 1)}…`;
}

const fmtDataOra = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** `05/10, 21:00` a Roma; `—` se manca. */
function quando(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '—';
  return fmtDataOra.format(new Date(iso));
}

const unaRiga = (t: string | null | undefined, max: number) => tronca((t ?? '').replace(/\s+/g, ' ').trim(), max);
const fase = (f: string | null) => (f ? (isLancioFase(f) ? ETICHETTA_FASE[f] : f) : null);

// ─────────────────────────── definizioni per il modello ───────────────────────────

const conversationId = { type: 'integer', minimum: 1, description: "L'id della chat (conversations.id)." } as const;

export const STRUMENTI: Anthropic.Tool[] = [
  {
    name: 'cerca_lead',
    description: 'Cerca le chat per nome, cognome o telefono del lead. Restituisce al massimo 10 chat, le più recenti prima, con id, nome, telefono, anteprima e contesto.',
    input_schema: { type: 'object', properties: { q: { type: 'string', description: 'Nome, cognome o parte del telefono.' } }, required: ['q'] },
  },
  {
    name: 'leggi_chat',
    description: 'Legge una chat: gli ultimi messaggi con mittente e ora (Roma) e la scheda (fase del lancio, esito del bot, Mario attivo o in pausa, stato nel CRM).',
    input_schema: {
      type: 'object',
      properties: { conversationId, ultimi: { type: 'integer', minimum: 1, maximum: 40, description: 'Quanti messaggi, al massimo 40 (predefinito 20).' } },
      required: ['conversationId'],
    },
  },
  {
    name: 'leggi_eventi',
    description: "Legge le righe recenti di event_log (al massimo 50, le più recenti prima): ora, tipo, messaggio. Filtri facoltativi per prefisso del tipo (es. 'twilio_status', 'lancio_', 'bot_outcome') e per chat.",
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'Prefisso del tipo evento, solo lettere minuscole, cifre e trattino basso.' },
        conversationId,
        ore: { type: 'integer', minimum: 1, maximum: 72, description: 'Quante ore indietro, al massimo 72 (predefinito 6).' },
      },
    },
  },
  {
    name: 'conta_viste',
    description: 'Quante chat ci sono in ogni vista della console (Serve te, Non lette, Con errori, Lancio, ecc.).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'elenca_avvisi',
    description: 'Gli avvisi aperti della console (lancio, CRM, Twilio, cron, bot, GDO): id, gravità, titolo, conteggio, cosa fare e le azioni collegate.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'spiega_errore_twilio',
    description: 'Il significato di un codice di errore Twilio/WhatsApp (es. 63016, 63018, 63049) e cosa farne.',
    input_schema: { type: 'object', properties: { code: { type: 'integer', description: 'Il codice di errore.' } }, required: ['code'] },
  },
  {
    name: 'stato_lancio',
    description: 'I numeri della barra di regia: lancio acceso o spento, orario del webinar, iscritti, posti bloccati, link inviati, consegnati e falliti di oggi, chat per fase.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'proponi_azione',
    description:
      "Mostra all'admin un'azione di rimedio da eseguire. NON la esegue: l'admin la prova a vuoto e la conferma lui. " +
      'Parametri per azione: rinvia_esiti_403 {}; recupera_agende_consegnate {}; rinvia_esito {conversationId}; ' +
      `rilancia_cron {cron: ${ID_CRON.join(' | ')}}; ` +
      'interruttore {chiave: lancio_attivo | lancio_pulsante_attivo | fenice_ai_autoreply, valore: boolean}; ' +
      'pausa_mario {conversationId}; riprendi_mario {conversationId}.',
    input_schema: {
      type: 'object',
      properties: {
        azione: { type: 'string', enum: [...ID_AZIONI] },
        params: { type: 'object', description: "I parametri dell'azione, esattamente come elencati." },
        motivo: { type: 'string', description: "Perché la proponi, in una frase per l'admin." },
      },
      required: ['azione', 'params', 'motivo'],
    },
  },
  {
    name: 'bozza_risposta',
    description:
      "Mostra all'admin una bozza di messaggio per un lead. NON la invia. Scrivi il testo tu, dopo aver letto la chat con leggi_chat. " +
      'Funziona solo se Mario è in pausa su quella chat: altrimenti proponi prima pausa_mario.',
    input_schema: {
      type: 'object',
      properties: { conversationId, testo: { type: 'string', description: 'Il testo completo del messaggio, in italiano.' } },
      required: ['conversationId', 'testo'],
    },
  },
];

// ─────────────────────────── input ───────────────────────────

const Id = z.number().int().positive();
const INPUT = {
  cerca_lead: z.object({ q: z.string().trim().min(1).max(100) }),
  leggi_chat: z.object({ conversationId: Id, ultimi: z.number().int().optional() }),
  leggi_eventi: z.object({
    tipo: z.string().regex(/^[a-z0-9_]{1,60}$/).optional(),
    conversationId: Id.optional(),
    ore: z.number().optional(),
  }),
  conta_viste: z.object({}),
  elenca_avvisi: z.object({}),
  spiega_errore_twilio: z.object({ code: z.number().int() }),
  stato_lancio: z.object({}),
  proponi_azione: z.object({ azione: z.string(), params: z.record(z.string(), z.unknown()).optional(), motivo: z.string().trim().min(1).max(300) }),
  bozza_risposta: z.object({ conversationId: Id, testo: z.string().trim().min(1).max(MAX_BOZZA) }),
} as const;
type NomeStrumento = keyof typeof INPUT;

const limita = (n: number | undefined, predefinito: number, max: number) =>
  Math.min(max, Math.max(1, Math.round(n ?? predefinito)));

// ─────────────────────────── strumenti ───────────────────────────

async function cercaLead(i: z.infer<typeof INPUT.cerca_lead>, c: ContestoStrumento): Promise<RisultatoStrumento> {
  const righe = await cercaChat(c.s, i.q, c.now);
  if (righe.length === 0) return { contenuto: `Nessuna chat trovata per "${i.q}".`, citazioni: [], sintesi: `Nessuna chat per "${i.q}"` };
  const contenuto = righe
    .map((r) => [r.id, r.nome ?? 'senza nome', r.telefono ?? '—', unaRiga(r.anteprima, 80) || '—', r.contesto?.testo ?? '—'].join(' · '))
    .join('\n');
  return {
    contenuto,
    citazioni: righe.map((r) => ({ tipo: 'chat', id: r.id, etichetta: r.nome ?? r.telefono ?? `Chat ${r.id}` })),
    sintesi: `Trovate ${righe.length} chat per "${i.q}"`,
  };
}

type ConvScheda = {
  id: number; ai_paused_at: string | null; ai_status: string | null; bot_outcome: string | null;
  lancio_fase: string | null; crm_lead_id: string | null; ai_summary: string | null; last_inbound_at: string | null;
  lead: { first_name: string | null; last_name: string | null; phone_e164: string | null } | null;
};
type MsgChat = {
  direction: 'in' | 'out'; body: string | null; created_at: string; sender: string | null;
  twilio_status: string | null; twilio_error_code: number | null;
};

const NON_TROVATA = (id: number): RisultatoStrumento => ({
  contenuto: `La chat ${id} non esiste o è fuori dal perimetro della console.`,
  citazioni: [],
  sintesi: `Chat ${id} non trovata`,
});

async function leggiChat(i: z.infer<typeof INPUT.leggi_chat>, c: ContestoStrumento): Promise<RisultatoStrumento> {
  const ultimi = limita(i.ultimi, 20, 40);
  if (!(await isConversazioneChat(c.s, i.conversationId))) return NON_TROVATA(i.conversationId);
  const [conv, msg] = await Promise.all([
    c.s
      .from('conversations')
      .select('id, ai_paused_at, ai_status, bot_outcome, lancio_fase, crm_lead_id, ai_summary, last_inbound_at, lead:leads(first_name, last_name, phone_e164)')
      .eq('id', i.conversationId)
      .maybeSingle(),
    c.s
      .from('messages')
      .select('direction, body, created_at, sender, twilio_status, twilio_error_code')
      .eq('conversation_id', i.conversationId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(ultimi),
  ]);
  if (conv.error) throw new Error(conv.error.message);
  if (msg.error) throw new Error(msg.error.message);
  const cv = conv.data as unknown as ConvScheda | null;
  if (!cv) return NON_TROVATA(i.conversationId);

  const crm = cv.crm_lead_id
    ? await c.s.from('crm_lead_status').select('status, conferme_outcome, sales_outcome').eq('lead_id', cv.crm_lead_id).maybeSingle()
    : { data: null, error: null };
  const stato = crm.data as { status: string | null; conferme_outcome: string | null; sales_outcome: string | null } | null;

  const nome = [cv.lead?.first_name, cv.lead?.last_name].map((x) => x?.trim()).filter(Boolean).join(' ') || null;
  const scheda = [
    `Chat ${cv.id} · ${nome ?? 'senza nome'} · ${cv.lead?.phone_e164 ?? '—'}`,
    `Mario: ${cv.ai_paused_at ? `in pausa dal ${quando(cv.ai_paused_at)}` : 'attivo'} · stato ${cv.ai_status ?? '—'} · esito bot ${cv.bot_outcome ?? '—'} · fase lancio ${fase(cv.lancio_fase) ?? '—'}`,
    `CRM: ${stato ? `stato ${stato.status ?? '—'}, conferme ${stato.conferme_outcome ?? '—'}, venditore ${stato.sales_outcome ?? '—'}` : 'nessuno stato'} · ultimo messaggio del lead ${quando(cv.last_inbound_at)}`,
  ];
  if (cv.ai_summary) scheda.push(`Riassunto di Mario: ${unaRiga(cv.ai_summary, 300)}`);

  // Dal più vecchio al più recente; se non ci stanno tutti, cadono i più vecchi.
  const messaggi = ((msg.data ?? []) as MsgChat[]).reverse().map((m) => {
    const chi = m.direction === 'in' ? 'Lead' : autoreDi(m.sender);
    const ko = m.twilio_status === 'failed' || m.twilio_status === 'undelivered'
      ? ` [non consegnato${m.twilio_error_code ? `, errore ${m.twilio_error_code}` : ''}]`
      : '';
    return `${quando(m.created_at)} · ${chi}: ${unaRiga(m.body, 280)}${ko}`;
  });
  const testa = scheda.join('\n');
  let omessi = 0;
  const componi = () => [testa, omessi ? `(${omessi} messaggi più vecchi omessi)` : '', ...messaggi.slice(omessi)].filter(Boolean).join('\n');
  while (omessi < messaggi.length && componi().length > MAX_CONTENUTO) omessi++;

  return {
    contenuto: componi(),
    citazioni: [{ tipo: 'chat', id: cv.id, etichetta: nome ?? cv.lead?.phone_e164 ?? `Chat ${cv.id}` }],
    sintesi: `Letta la chat ${cv.id}, ultimi ${messaggi.length} messaggi`,
  };
}

/** Oltre questo tempo la lettura di event_log si abbandona (con il filtro per chat è lenta). */
const TETTO_EVENTI_MS = 8000;

async function leggiEventi(i: z.infer<typeof INPUT.leggi_eventi>, c: ContestoStrumento): Promise<RisultatoStrumento> {
  const ore = limita(i.ore, 6, 72);
  let q = grezzo(c.s)
    .from('event_log')
    .select('created_at, type, message, conv:payload->>conversationId')
    .gte('created_at', new Date(c.now.getTime() - ore * ORA).toISOString());
  if (i.tipo) q = q.like('type', `${i.tipo}%`);
  if (i.conversationId) q = q.eq('payload->>conversationId', String(i.conversationId));
  const { data, error } = await q.order('created_at', { ascending: false }).limit(50).abortSignal(AbortSignal.timeout(TETTO_EVENTI_MS));
  if (error) throw new Error(error.message);
  const righe = (data ?? []) as { created_at: string; type: string; message: string | null; conv: string | null }[];
  const intervallo = ore === 1 ? "nell'ultima ora" : `ultime ${ore} ore`;
  if (righe.length === 0) return { contenuto: `Nessun evento ${intervallo}.`, citazioni: [], sintesi: `Nessun evento in event_log, ${intervallo}` };

  const chat = new Set<number>();
  const contenuto = righe
    .map((e) => {
      const id = Number(e.conv);
      if (Number.isInteger(id) && id > 0) chat.add(id);
      return `${quando(e.created_at)} · ${e.type} · ${unaRiga(e.message, 140)}${e.conv ? ` (chat ${e.conv})` : ''}`;
    })
    .join('\n');
  return {
    contenuto,
    citazioni: [...chat].slice(0, 10).map((id) => ({ tipo: 'chat', id, etichetta: `Chat ${id}` })),
    sintesi: `Letti ${righe.length} eventi di event_log, ${intervallo}`,
  };
}

async function contaLeViste(c: ContestoStrumento): Promise<RisultatoStrumento> {
  const n = await contaViste(c.s, c.now);
  return {
    contenuto: VISTE.map((v) => `${VISTA_META[v].etichetta}: ${n[v] ?? 0}`).join('\n'),
    citazioni: [],
    sintesi: 'Contate le chat delle viste',
  };
}

async function elencaAvvisi(c: ContestoStrumento): Promise<RisultatoStrumento> {
  const avvisi = await leggiAvvisi(c.s, c.now);
  if (avvisi.length === 0) return { contenuto: 'Nessun avviso aperto.', citazioni: [], sintesi: 'Nessun avviso aperto' };
  const contenuto = avvisi
    .map((a) => {
      const azioni = a.azioni.map((x) => `${x.azione} ${JSON.stringify(x.params)}`).join('; ');
      return `[${a.id}] ${a.gravita} · ${a.titolo} · ${a.conteggio} · cosa fare: ${unaRiga(a.cosaFare, 200)}${azioni ? ` · azioni: ${azioni}` : ''}`;
    })
    .join('\n');
  return {
    contenuto,
    citazioni: avvisi.map((a) => ({ tipo: 'avviso', id: a.id, etichetta: a.titolo })),
    sintesi: `Letti ${avvisi.length} avvisi aperti`,
  };
}

function spiegaErrore(i: z.infer<typeof INPUT.spiega_errore_twilio>): RisultatoStrumento {
  const e = erroreTwilio(i.code);
  return {
    contenuto: `Errore ${i.code}: ${e.nome} (${e.gravita}).\nSignificato: ${e.significato}\nCosa fare: ${e.cosaFare}`,
    citazioni: [],
    sintesi: `Spiegato l'errore Twilio ${i.code}`,
  };
}

function durata(secondi: number): string {
  const min = Math.round(secondi / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

async function statoLancio(c: ContestoStrumento): Promise<RisultatoStrumento> {
  const r = await leggiRegia(c.s, c.now);
  if (!r.attivo) {
    return {
      contenuto: `Lancio spento. Webinar impostato: ${quando(r.eventoAt)}.`,
      citazioni: [],
      sintesi: 'Letto lo stato del lancio: spento',
    };
  }
  const onda = {
    nessuno: 'orario del webinar non impostato',
    prima: `mancano ${durata(r.stato.secondi)} al webinar`,
    in_onda: `webinar in onda da ${durata(r.stato.secondi)}`,
    dopo: `webinar chiuso da ${durata(r.stato.secondi)}`,
  }[r.stato.stato];
  const n = r.numeri;
  const perFase = Object.entries(r.perFase).map(([f, v]) => `${fase(f)} ${v}`).join(', ');
  const contenuto = [
    `Lancio acceso · webinar ${quando(r.eventoAt)} · ${onda}`,
    `Iscritti ${n.iscritti} · posto bloccato ${n.postoBloccato} · link inviati ${n.linkInviati}`,
    `Oggi: consegnati ${n.consegnatiOggi}, falliti ${n.fallitiOggi}`,
    perFase ? `Per fase: ${perFase}` : '',
    r.scaletta.length ? `Scaletta: ${r.scaletta.map((v) => `${v.etichetta} ${quando(v.at)}`).join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return { contenuto, citazioni: [], sintesi: 'Letti i numeri della regia' };
}

function proponiAzione(i: z.infer<typeof INPUT.proponi_azione>): RisultatoStrumento {
  if (!(ID_AZIONI as readonly string[]).includes(i.azione)) {
    return {
      contenuto: `Azione non valida: "${i.azione}" non esiste. Le azioni possibili sono: ${ID_AZIONI.join(', ')}.`,
      citazioni: [],
      sintesi: 'Proposta scartata: azione inesistente',
      errore: true,
    };
  }
  const azione = i.azione as IdAzione;
  const p = PARAMS[azione].safeParse(i.params ?? {});
  if (!p.success) {
    const dove = p.error.issues.map((x) => `${x.path.join('.') || 'params'}: ${x.message}`).join('; ');
    return { contenuto: `Parametri non validi per ${azione}: ${dove}.`, citazioni: [], sintesi: `Proposta scartata: parametri di ${azione}`, errore: true };
  }
  const params = p.data as Record<string, unknown>;
  const conv = typeof params.conversationId === 'number' ? params.conversationId : null;
  return {
    contenuto: "Proposta mostrata all'admin: la esegue solo lui dopo la prova a vuoto.",
    citazioni: conv ? [{ tipo: 'chat', id: conv, etichetta: `Chat ${conv}` }] : [],
    sintesi: `Proposta l'azione ${azione}`,
    proposta: { azione, params, etichetta: i.motivo },
  };
}

async function bozzaRisposta(i: z.infer<typeof INPUT.bozza_risposta>, c: ContestoStrumento): Promise<RisultatoStrumento> {
  if (!(await isConversazioneChat(c.s, i.conversationId))) return NON_TROVATA(i.conversationId);
  const { data, error } = await c.s.from('conversations').select('ai_paused_at').eq('id', i.conversationId).maybeSingle();
  if (error) throw new Error(error.message);
  const conv = data as { ai_paused_at: string | null } | null;
  if (!conv) return NON_TROVATA(i.conversationId);
  if (!conv.ai_paused_at) {
    return {
      contenuto: 'Rifiutato: Mario è attivo su questa chat. Proponi prima pausa_mario.',
      citazioni: [],
      sintesi: `Bozza rifiutata: Mario attivo sulla chat ${i.conversationId}`,
      errore: true,
    };
  }
  return {
    contenuto: "Bozza mostrata all'admin: la invia lui.",
    citazioni: [{ tipo: 'chat', id: i.conversationId, etichetta: `Chat ${i.conversationId}` }],
    sintesi: `Preparata una bozza per la chat ${i.conversationId}`,
    bozza: { conversationId: i.conversationId, testo: i.testo },
  };
}

// ─────────────────────────── ingresso ───────────────────────────

async function esegui(nome: NomeStrumento, input: unknown, c: ContestoStrumento): Promise<RisultatoStrumento> {
  switch (nome) {
    case 'cerca_lead': return cercaLead(INPUT.cerca_lead.parse(input), c);
    case 'leggi_chat': return leggiChat(INPUT.leggi_chat.parse(input), c);
    case 'leggi_eventi': return leggiEventi(INPUT.leggi_eventi.parse(input), c);
    case 'conta_viste': return contaLeViste(c);
    case 'elenca_avvisi': return elencaAvvisi(c);
    case 'spiega_errore_twilio': return spiegaErrore(INPUT.spiega_errore_twilio.parse(input));
    case 'stato_lancio': return statoLancio(c);
    case 'proponi_azione': return proponiAzione(INPUT.proponi_azione.parse(input));
    case 'bozza_risposta': return bozzaRisposta(INPUT.bozza_risposta.parse(input), c);
  }
}

/**
 * Esegue uno strumento e non lancia mai: input sbagliati e letture fallite tornano come
 * contenuto d'errore (con `errore: true`), così il modello può correggersi o dirlo all'admin.
 */
export async function eseguiStrumento(nome: string, input: unknown, ctx: ContestoStrumento): Promise<RisultatoStrumento> {
  if (!Object.hasOwn(INPUT, nome)) {
    return { contenuto: `Strumento sconosciuto: ${nome}.`, citazioni: [], sintesi: `Strumento sconosciuto: ${nome}`, errore: true };
  }
  let r: RisultatoStrumento;
  try {
    r = await esegui(nome as NomeStrumento, input ?? {}, ctx);
  } catch (e) {
    const msg = e instanceof z.ZodError
      ? `parametri non validi (${e.issues.map((x) => `${x.path.join('.') || 'input'}: ${x.message}`).join('; ')})`
      : `lettura non riuscita (${(e as Error).message})`;
    r = { contenuto: `Strumento ${nome}: ${msg}.`, citazioni: [], sintesi: `${nome} non riuscito`, errore: true };
  }
  return { ...r, contenuto: tronca(r.contenuto) };
}
