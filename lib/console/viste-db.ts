import type { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { getFeniceCampaignIds } from '@/lib/campagne';
import { soloMondoFenice } from '@/lib/chat-perimetro';
import { VISTE, applicaVista, contestoRiga, type RigaVista, type Vista } from './viste';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const TTL = 15_000;
const PER_PAGINA = 50;
const COLONNE =
  'id, ai_owner, ai_status, ai_paused_at, bot_outcome, gdo_agenda_at, gdo_video_sent_at, campaign_id, ' +
  'lancio_slug, lancio_fase, last_inbound_at, unread_count, last_message_at, last_message_preview, ' +
  'lead:leads(first_name, last_name, phone_e164)';

/**
 * Le chat con l'ultimo messaggio in uscita non consegnato, nelle ultime 48h.
 *
 * "Ultimo" per chat: una `failed` seguita da una `delivered` di un retry manuale non deve
 * restare marcata come errore. Cache 15s: la vista "Con errori" e i contatori la
 * interrogano nello stesso giro di rendering, e senza cache raddoppierebbe la lettura di
 * `messages`.
 */
let cacheErrori: { at: number; p: Promise<number[]> } | null = null;
export function idsConErrori(s: Supa, now: Date): Promise<number[]> {
  if (cacheErrori && now.getTime() - cacheErrori.at < TTL) return cacheErrori.p;
  const da = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const p = fetchAllRows<{ conversation_id: number; twilio_status: string | null }>(
    (a, b) =>
      s
        .from('messages')
        .select('conversation_id, twilio_status')
        .eq('direction', 'out')
        .gte('created_at', da)
        .order('created_at', { ascending: false })
        .range(a, b) as never,
    { max: 30_000 },
  ).then((righe) => {
    const visti = new Set<number>();
    const ko: number[] = [];
    for (const m of righe) {
      if (visti.has(m.conversation_id)) continue;
      visti.add(m.conversation_id);
      if (m.twilio_status === 'failed' || m.twilio_status === 'undelivered') ko.push(m.conversation_id);
    }
    return ko;
  });
  cacheErrori = { at: now.getTime(), p };
  p.catch(() => {
    if (cacheErrori?.p === p) cacheErrori = null;
  });
  return p;
}

/** I conteggi delle nove viste, cache 15s (stesso motivo di `idsConErrori`). */
let cacheConteggi: { at: number; p: Promise<Record<Vista, number>> } | null = null;
export function contaViste(s: Supa, now: Date): Promise<Record<Vista, number>> {
  if (cacheConteggi && now.getTime() - cacheConteggi.at < TTL) return cacheConteggi.p;
  const p = (async () => {
    const [fenice, errori] = await Promise.all([getFeniceCampaignIds(s), idsConErrori(s, now)]);
    const coppie = await Promise.all(
      VISTE.map(async (v) => {
        const base = soloMondoFenice(s.from('conversations').select('id', { count: 'exact', head: true }), fenice);
        const q = applicaVista(base, v, { now, conErrori: errori });
        if (q === null) return [v, 0] as const;
        const { count, error } = await q;
        if (error) throw new Error(`${v}: ${error.message}`);
        return [v, count ?? 0] as const;
      }),
    );
    return Object.fromEntries(coppie) as Record<Vista, number>;
  })();
  cacheConteggi = { at: now.getTime(), p };
  p.catch(() => {
    if (cacheConteggi?.p === p) cacheConteggi = null;
  });
  return p;
}

export function codificaCursore(at: string, id: number): string {
  return Buffer.from(`${at}|${id}`).toString('base64url');
}

export function leggiCursore(c: string): { at: string; id: number } | null {
  try {
    const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
    const n = Number(id);
    if (!at || !Number.isInteger(n) || Number.isNaN(Date.parse(at))) return null;
    return { at, id: n };
  } catch {
    return null;
  }
}

export type RigaLista = {
  id: number;
  nome: string | null;
  telefono: string | null;
  ultimoAt: string | null;
  anteprima: string | null;
  nonLetti: number;
  contesto: ReturnType<typeof contestoRiga>;
  fase: string | null;
};

type RigaConversazioneLead = { first_name: string | null; last_name: string | null; phone_e164: string | null };
type RigaConversazione = RigaVista & {
  last_message_at: string | null;
  last_message_preview: string | null;
  lead: RigaConversazioneLead | RigaConversazioneLead[] | null;
};

function leadDellaRiga(lead: RigaConversazioneLead | RigaConversazioneLead[] | null): RigaConversazioneLead | null {
  if (Array.isArray(lead)) return lead[0] ?? null;
  return lead;
}

function mappaRiga(r: RigaConversazione, ctx: { now: Date; conErrori: ReadonlySet<number> }): RigaLista {
  const lead = leadDellaRiga(r.lead);
  const nome = [lead?.first_name, lead?.last_name].filter((v): v is string => !!v && v.trim() !== '').join(' ');
  return {
    id: r.id,
    nome: nome || null,
    telefono: lead?.phone_e164 ?? null,
    ultimoAt: r.last_message_at,
    anteprima: r.last_message_preview,
    nonLetti: r.unread_count ?? 0,
    contesto: contestoRiga(r, ctx),
    fase: r.lancio_fase,
  };
}

/**
 * Risolve gli id dei lead che corrispondono a `search` (nome, cognome o telefono).
 * Copiata da `leadIdsPerRicerca` in `app/api/chat/conversations/route.ts`, stesso escape:
 * PostgREST vuole il pattern fra doppi apici per non spezzare l'espressione `.or()` se
 * contiene virgole o parentesi.
 */
async function leadIdsPerRicerca(s: Supa, search: string): Promise<number[]> {
  const pattern = `"%${search.replace(/["\\]/g, '\\$&')}%"`;
  const { data } = await s
    .from('leads')
    .select('id')
    .or(`first_name.ilike.${pattern},last_name.ilike.${pattern},phone_e164.ilike.${pattern}`);
  return ((data ?? []) as { id: number }[]).map((l) => l.id);
}

const MAX_ID_LEAD = 200;

export async function paginaChat(
  s: Supa,
  p: { vista: Vista; fase?: string; soloNonLette?: boolean; q?: string; cursore?: string; now: Date },
): Promise<{ righe: RigaLista[]; prossimo: string | null }> {
  let leadIds: number[] | null = null;
  if (p.q && p.q.trim() !== '') {
    leadIds = await leadIdsPerRicerca(s, p.q.trim());
    if (leadIds.length === 0) return { righe: [], prossimo: null };
    if (leadIds.length > MAX_ID_LEAD) {
      console.warn(`[console] ricerca "${p.q}": ${leadIds.length} lead trovati, uso solo i primi ${MAX_ID_LEAD}`);
      leadIds = leadIds.slice(0, MAX_ID_LEAD);
    }
  }

  const errori = await idsConErrori(s, p.now);
  if (p.vista === 'errori' && errori.length === 0) return { righe: [], prossimo: null };

  const fenice = await getFeniceCampaignIds(s);
  const base = soloMondoFenice(s.from('conversations').select(COLONNE), fenice);
  const conErrori = new Set(errori);
  const applicata = applicaVista(base, p.vista, { now: p.now, conErrori: errori });
  if (applicata === null) return { righe: [], prossimo: null };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = applicata;
  if (p.fase) query = query.eq('lancio_fase', p.fase);
  if (p.soloNonLette) query = query.gt('unread_count', 0);
  if (leadIds) query = query.in('lead_id', leadIds);
  if (p.cursore) {
    const cur = leggiCursore(p.cursore);
    if (cur) query = query.or(`last_message_at.lt.${cur.at},and(last_message_at.eq.${cur.at},id.lt.${cur.id})`);
  }
  query = query.order('last_message_at', { ascending: false }).order('id', { ascending: false }).limit(PER_PAGINA + 1);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const righeGrezze = (data ?? []) as RigaConversazione[];
  const haProssima = righeGrezze.length > PER_PAGINA;
  const pagina = haProssima ? righeGrezze.slice(0, PER_PAGINA) : righeGrezze;
  const righe = pagina.map((r) => mappaRiga(r, { now: p.now, conErrori }));
  const ultima = pagina[pagina.length - 1];
  const prossimo = haProssima && ultima?.last_message_at ? codificaCursore(ultima.last_message_at, ultima.id) : null;
  return { righe, prossimo };
}
