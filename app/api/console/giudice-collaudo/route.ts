import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { contestoGiudiceDaDb, giudicaDisdetta, type MessaggioChat } from '@/lib/giudice-disdetta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Collaudo del giudice delle disdette (PO, 28/10/2026): fa girare il giudice su chat
 * storiche, nel punto in cui il bot aveva mandato la nota DISDETTA / SPOSTAMENTO, e
 * restituisce i verdetti. SOLO LETTURA: non scrive niente, non manda niente al CRM né ai
 * lead. Solo admin (area `all`). La chiave di Anthropic esiste solo in produzione, per
 * questo il collaudo gira qui e non in locale.
 *
 * Il corpo non porta l'esito vero dei lead (classificazione cieca): il confronto con la
 * chiave si fa fuori, dopo.
 */
const Corpo = z.object({
  casi: z
    .array(z.object({ conv: z.number().int().positive(), frase: z.string().max(2000).optional() }))
    .min(1)
    .max(12),
  system: z.string().min(200).max(30_000).optional(),
});

const DISDETTA_RE = /\b(annull|disdi|disdet|cancell|rimand|spost|rinvi|posticip|non (mi )?interess)|non posso piu|non riesco piu/;

function norm(t: string): string {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function parole(t: string): Set<string> {
  return new Set(norm(t).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}

type Supa = ReturnType<typeof getSupabaseAdmin>;

async function taglio(supabase: Supa, conv: number, frase?: string): Promise<{ fino: Date; come: string } | null> {
  const note = await Promise.all(
    ['DISDETTA%', 'SPOSTAMENTO CHIESTO%'].map((p) =>
      supabase
        .from('event_log')
        .select('created_at')
        .eq('type', 'bot_note_sent')
        .eq('payload->>conversationId', String(conv))
        .like('payload->>note', p)
        .order('created_at', { ascending: true })
        .limit(1),
    ),
  );
  const prime = note.flatMap((r) => (r.data ?? []) as { created_at: string }[]).map((r) => Date.parse(r.created_at));
  if (prime.length > 0) return { fino: new Date(Math.min(...prime)), come: 'nota' };

  const { data } = await supabase
    .from('messages')
    .select('direction, body, created_at')
    .eq('conversation_id', conv)
    .eq('direction', 'in')
    .order('created_at', { ascending: true })
    .limit(500);
  const inbound = (data ?? []) as MessaggioChat[];
  if (frase && frase.trim()) {
    const f = norm(frase);
    const esatto = inbound.find((m) => norm(m.body ?? '').includes(f.slice(0, 40)));
    if (esatto) return { fino: new Date(Date.parse(esatto.created_at) + 1000), come: 'frase_esatta' };
    const pf = parole(frase);
    let best: { m: MessaggioChat; s: number } | null = null;
    for (const m of inbound) {
      const pm = parole(m.body ?? '');
      let s = 0;
      for (const w of pf) if (pm.has(w)) s++;
      if (!best || s > best.s) best = { m, s };
    }
    if (best && best.s >= 2) return { fino: new Date(Date.parse(best.m.created_at) + 1000), come: `frase_simile_${best.s}` };
  }
  const re = [...inbound].reverse().find((m) => DISDETTA_RE.test(norm(m.body ?? '')));
  if (re) return { fino: new Date(Date.parse(re.created_at) + 1000), come: 'regex' };
  return null;
}

export async function POST(req: Request) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;
  const parsed = Corpo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'corpo_non_valido' }, { status: 400 });
  const supabase = getSupabaseAdmin();

  const risultati = await Promise.all(
    parsed.data.casi.map(async ({ conv, frase }) => {
      try {
        const t = await taglio(supabase, conv, frase);
        if (!t) return { conv, taglio: 'nessuno' };
        const { messaggi, fatti } = await contestoGiudiceDaDb(supabase, conv, t.fino);
        const g = await giudicaDisdetta(messaggi, fatti, { timeoutMs: 120_000, system: parsed.data.system });
        return { conv, taglio: t.come, fino: t.fino.toISOString(), giudizio: g };
      } catch (e) {
        return { conv, errore: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return NextResponse.json({ risultati });
}
