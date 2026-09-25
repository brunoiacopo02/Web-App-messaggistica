import type { getSupabaseAdmin } from './supabase/admin';
import { fetchAllRows } from './supabase/paginate';
import { LANCIO_SLUG } from './lancio-fase';
import { getLancioSettings, type LancioSettings } from './lancio-settings';
import {
  CRON_LANCIO,
  LANCIO_MONITOR_DA,
  TIPI_EVENTI_AVVISO,
  TIPI_EVENTI_CONTATORI,
  calcolaConsegne,
  congedoDi,
  convIdDi,
  type ChatLancio,
  type Consegne,
  type CronLancio,
  type EventoMonitor,
  type MessaggioConsegna,
  type SidLancio,
} from './lancio-monitor';

/**
 * Le letture del monitor del lancio: solo `select`, mai una scrittura.
 *
 * PostgREST taglia a 1.000 righe: tutto quello che puo' superarle passa da
 * `fetchAllRows`, e le liste di id lunghe si spezzano a blocchi (un `in.(...)` con
 * 4.000 id non sta in un URL). Due cache in memoria tengono basso il costo del
 * refresh ogni 30 secondi: la fotografia delle chat e degli eventi (20s) e le consegne
 * dei template (90s, sono la lettura piu' pesante e cambiano piu' lentamente).
 */

type Supa = ReturnType<typeof getSupabaseAdmin>;

// Il client e' tipizzato sullo schema generato, che non conosce la colonna del messaggio
// delle 21 (branch lancio-messaggio-21): le select qui sono stringhe costruite a runtime,
// quindi si passa da un client senza schema.
type Grezzo = {
  from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const grezzo = (s: Supa) => s as unknown as Grezzo;

type Pagina<T> = { data: T[] | null; error: { message: string; code?: string } | null };

const COLONNE_CHAT =
  'id, lancio_slug, lancio_fase, lancio_ingresso, lancio_benvenuto_at, lancio_link_inviato_at, ' +
  'lancio_followup_inviato_at, last_inbound_at, last_message_at, ai_status, ' +
  'congedo_at:lancio_info->>congedo_at, leads(first_name, last_name, phone_e164)';
const COLONNA_INIZIO = 'lancio_inizio_inviato_at';

type RigaChat = {
  id: number;
  lancio_slug: string | null;
  lancio_fase: string | null;
  lancio_ingresso: string | null;
  lancio_benvenuto_at: string | null;
  lancio_link_inviato_at: string | null;
  lancio_followup_inviato_at: string | null;
  lancio_inizio_inviato_at?: string | null;
  last_inbound_at: string | null;
  last_message_at: string | null;
  ai_status: string | null;
  congedo_at: string | null;
  leads: { first_name: string | null; last_name: string | null; phone_e164: string | null } | null;
};

export function nomeLead(l: RigaChat['leads']): string | null {
  const n = [l?.first_name, l?.last_name].map((x) => (x ?? '').trim()).filter(Boolean).join(' ');
  return n || null;
}

function aChat(r: RigaChat, colonnaInizio: boolean): ChatLancio {
  return {
    id: r.id,
    nome: nomeLead(r.leads),
    telefono: r.leads?.phone_e164 ?? null,
    slug: r.lancio_slug,
    fase: r.lancio_fase,
    ingresso: r.lancio_ingresso,
    benvenutoAt: r.lancio_benvenuto_at,
    linkAt: r.lancio_link_inviato_at,
    followupAt: r.lancio_followup_inviato_at,
    ...(colonnaInizio ? { inizioAt: r.lancio_inizio_inviato_at ?? null } : {}),
    lastInboundAt: r.last_inbound_at,
    lastMessageAt: r.last_message_at,
    congedoAt: congedoDi(r),
    aiStatus: r.ai_status,
  };
}

/** La colonna non esiste: PostgREST risponde 42703 o nomina la colonna nel messaggio. */
export function colonnaAssente(err: { message?: string; code?: string } | null | undefined, colonna: string): boolean {
  if (!err) return false;
  return err.code === '42703' || (err.message ?? '').includes(colonna);
}

/** Si ricorda che la colonna manca, per non sbattere su un 400 a ogni refresh. Si
 *  riprova ogni 10 minuti: la migration puo' arrivare a pagina aperta. */
let inizioAssenteFinoA = 0;

async function leggiChatDelLancio(s: Supa): Promise<{ chats: ChatLancio[]; colonnaInizio: boolean }> {
  const leggi = (colonne: string) => fetchAllRows<RigaChat>((da, a) =>
    grezzo(s).from('conversations').select(colonne).eq('lancio_slug', LANCIO_SLUG).order('id', { ascending: true }).range(da, a),
    { max: 20_000 },
  );
  if (Date.now() >= inizioAssenteFinoA) {
    try {
      const righe = await leggi(`${COLONNE_CHAT}, ${COLONNA_INIZIO}`);
      return { chats: righe.map((r) => aChat(r, true)), colonnaInizio: true };
    } catch (e) {
      if (!colonnaAssente({ message: (e as Error).message }, COLONNA_INIZIO)) throw e;
      inizioAssenteFinoA = Date.now() + 10 * 60 * 1000;
    }
  }
  const righe = await leggi(COLONNE_CHAT);
  return { chats: righe.map((r) => aChat(r, false)), colonnaInizio: false };
}

/** Chat per id (le orfane del pulsante, il dettaglio), a blocchi da 200. */
export async function leggiChatPerId(s: Supa, ids: readonly number[], colonnaInizio: boolean): Promise<ChatLancio[]> {
  const out: ChatLancio[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const blocco = ids.slice(i, i + 200);
    const colonne = colonnaInizio ? `${COLONNE_CHAT}, ${COLONNA_INIZIO}` : COLONNE_CHAT;
    const { data, error } = (await grezzo(s).from('conversations').select(colonne).in('id', blocco)) as Pagina<RigaChat>;
    if (error) throw new Error(error.message);
    for (const r of data ?? []) out.push(aChat(r, colonnaInizio));
  }
  return out;
}

async function leggiEventi(s: Supa, tipi: readonly string[], da: string, extra?: (q: any) => any): Promise<EventoMonitor[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return fetchAllRows<EventoMonitor>((a, b) => {
    let q = grezzo(s).from('event_log').select('id, type, created_at, level, message, payload')
      .in('type', tipi as string[]).gte('created_at', da);
    if (extra) q = extra(q);
    return q.order('created_at', { ascending: false }).range(a, b);
  }, { max: 30_000 });
}

async function ultimoRun(s: Supa, cron: CronLancio): Promise<EventoMonitor | null> {
  const { data, error } = (await grezzo(s).from('event_log').select('id, type, created_at, level, message, payload')
    .eq('type', `lancio_${cron}_run`).order('created_at', { ascending: false }).limit(1)) as Pagina<EventoMonitor>;
  if (error) throw new Error(error.message);
  return data?.[0] ?? null;
}

/** I SID dei template del lancio dalle env (account storico). */
export function sidDalleEnv(env: Record<string, string | undefined> = process.env): SidLancio {
  const l = (...k: string[]) => k.map((x) => env[x]).filter((x): x is string => !!x);
  return {
    benvenuto: l('LANCIO_WELCOME_TEMPLATE_SID'),
    zoom: l('LANCIO_ZOOM_TEMPLATE_SID'),
    inizio: l('LANCIO_INIZIO_TEMPLATE_SID'),
    followup: l('LANCIO_FOLLOWUP_TEMPLATE_SID'),
    scelta: l('LANCIO_SCELTA_NOTTE_TEMPLATE_SID', 'LANCIO_SCELTA_GIORNO_TEMPLATE_SID'),
  };
}

/** Il nome leggibile di un SID noto dalle env. */
export function nomeTemplateDaEnv(sid: string, env: Record<string, string | undefined> = process.env): string | null {
  const nomi: Record<string, string> = {
    LANCIO_WELCOME_TEMPLATE_SID: 'benvenuto del lancio',
    LANCIO_ZOOM_TEMPLATE_SID: 'link Zoom',
    LANCIO_INIZIO_TEMPLATE_SID: 'la live sta iniziando (21:00)',
    LANCIO_FOLLOWUP_TEMPLATE_SID: 'follow-up del 6/10',
    LANCIO_SCELTA_NOTTE_TEMPLATE_SID: 'scelta con pulsanti (notte)',
    LANCIO_SCELTA_GIORNO_TEMPLATE_SID: 'scelta con pulsanti (giorno)',
    FENICE_OPENING_TEMPLATE_SID: 'apertura Fenice',
    MARTA_REENGAGE_TEMPLATE_SID: 'riaggancio',
    AGENDA_GDO_TEMPLATE_SID: 'agenda GDO',
    AGENDA_TEMPLATE_SID: 'agenda',
    REMINDER_24H_TEMPLATE_SID: 'promemoria 24h',
    REMINDER_24H_NOVIDEO_TEMPLATE_SID: 'promemoria 24h senza video',
    REMINDER_3H_TEMPLATE_SID: 'promemoria 3h',
    NR1_TEMPLATE_SID: 'non risponde 1',
    NR3_TEMPLATE_SID: 'non risponde 3',
    VIDEO_TEMPLATE_SID: 'video',
    SOLLECITO_VIDEO_GDO_SID: 'sollecito video GDO',
    SEQ_TEMPLATE_SID_1: 'sequenza 1', SEQ_TEMPLATE_SID_2: 'sequenza 2', SEQ_TEMPLATE_SID_3: 'sequenza 3', SEQ_TEMPLATE_SID_4: 'sequenza 4',
  };
  for (const [k, nome] of Object.entries(nomi)) if (env[k] && env[k] === sid) return nome;
  return null;
}

/** I messaggi in uscita che servono alle consegne: template e fallimenti, dal 14/09. */
async function leggiConsegne(s: Supa, ids: readonly number[]): Promise<MessaggioConsegna[]> {
  const blocchi: number[][] = [];
  for (let i = 0; i < ids.length; i += 200) blocchi.push(ids.slice(i, i + 200) as number[]);
  const out: MessaggioConsegna[] = [];
  // Quattro blocchi alla volta: abbastanza per non metterci un minuto, pochi per non
  // mettere in fila il DB del bot la sera in cui serve a tutto il resto.
  for (let i = 0; i < blocchi.length; i += 4) {
    const giro = await Promise.all(blocchi.slice(i, i + 4).map((blocco) =>
      fetchAllRows<MessaggioConsegna>((a, b) => grezzo(s).from('messages')
        .select('conversation_id, created_at, template_sid, is_template, twilio_status, twilio_error_code')
        .in('conversation_id', blocco).eq('direction', 'out').gte('created_at', LANCIO_MONITOR_DA)
        .or('is_template.eq.true,twilio_status.in.(failed,undelivered)')
        .order('id', { ascending: true }).range(a, b), { max: 20_000 }),
    ));
    for (const g of giro) out.push(...g);
  }
  return out;
}

// ─────────────────────────── fotografia ───────────────────────────

export type Fotografia = {
  generatoAt: string;
  settings: LancioSettings;
  colonnaInizio: boolean;
  /** Le chat del lancio piu' le orfane del pulsante (slug nullo). */
  chats: ChatLancio[];
  eventiContatori: EventoMonitor[];
  eventiAvviso: EventoMonitor[];
  statiTwilio: EventoMonitor[];
  ultimiRun: Partial<Record<CronLancio, EventoMonitor | null>>;
  pulsante: Set<number>;
};

export type FotografiaConsegne = { at: string; consegne: Consegne };

let cacheFoto: { at: number; p: Promise<Fotografia> } | null = null;
let cacheConsegne: { at: number; p: Promise<FotografiaConsegne> } | null = null;
const TTL_FOTO = 20_000;
const TTL_CONSEGNE = 90_000;

async function scatta(s: Supa, now: Date): Promise<Fotografia> {
  const ieri = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const unOraFa = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const [settings, base, eventiContatori, eventiAvviso, statiTwilio, runs] = await Promise.all([
    getLancioSettings(s),
    leggiChatDelLancio(s),
    leggiEventi(s, TIPI_EVENTI_CONTATORI, LANCIO_MONITOR_DA),
    leggiEventi(s, TIPI_EVENTI_AVVISO, ieri),
    // Solo i fallimenti: la callback di stato scrive `warn` per failed/undelivered.
    leggiEventi(s, ['twilio_status'], unOraFa, (q) => q.eq('level', 'warn')),
    Promise.all(CRON_LANCIO.map(async (c) => [c, await ultimoRun(s, c)] as const)),
  ]);
  const pulsante = new Set<number>();
  for (const e of eventiContatori) if (e.type === 'lancio_pulsante') { const id = convIdDi(e); if (id) pulsante.add(id); }
  const noti = new Set(base.chats.map((c) => c.id));
  const orfane = [...pulsante].filter((id) => !noti.has(id));
  const chats = orfane.length ? [...base.chats, ...(await leggiChatPerId(s, orfane, base.colonnaInizio))] : base.chats;
  return {
    generatoAt: now.toISOString(),
    settings,
    colonnaInizio: base.colonnaInizio,
    chats,
    eventiContatori,
    eventiAvviso,
    statiTwilio,
    ultimiRun: Object.fromEntries(runs),
    pulsante,
  };
}

/** La fotografia, riusata per 20s: piu' schede aperte e i cambi di filtro non
 *  rileggono 4.000 chat ogni volta. Un errore non resta in cache. */
export function fotografia(s: Supa, now = new Date()): Promise<Fotografia> {
  if (cacheFoto && now.getTime() - cacheFoto.at < TTL_FOTO) return cacheFoto.p;
  const p = scatta(s, now);
  cacheFoto = { at: now.getTime(), p };
  p.catch(() => { if (cacheFoto?.p === p) cacheFoto = null; });
  return p;
}

export function consegne(s: Supa, foto: Fotografia, now = new Date()): Promise<FotografiaConsegne> {
  if (cacheConsegne && now.getTime() - cacheConsegne.at < TTL_CONSEGNE) return cacheConsegne.p;
  const p = (async () => {
    const messaggi = await leggiConsegne(s, foto.chats.map((c) => c.id));
    const perId = new Map(foto.chats.map((c) => [c.id, c]));
    return { at: now.toISOString(), consegne: calcolaConsegne(messaggi, perId, sidDalleEnv()) };
  })();
  cacheConsegne = { at: now.getTime(), p };
  p.catch(() => { if (cacheConsegne?.p === p) cacheConsegne = null; });
  return p;
}

/** Per i test: svuota le cache. */
export function _svuotaCacheMonitor(): void {
  cacheFoto = null;
  cacheConsegne = null;
  inizioAssenteFinoA = 0;
}

// ─────────────────────────── righe della pagina ───────────────────────────

export type UltimoBot = { at: string; stato: string | null; codice: number | null; template: boolean };

/** Anteprima dell'ultimo messaggio e stato dell'ultimo messaggio del bot, per le righe
 *  di UNA pagina (al massimo 50 chat). */
export async function arricchisciPagina(s: Supa, ids: readonly number[]): Promise<{
  anteprime: Map<number, string | null>;
  ultimoBot: Map<number, UltimoBot>;
}> {
  const anteprime = new Map<number, string | null>();
  const ultimoBot = new Map<number, UltimoBot>();
  if (ids.length === 0) return { anteprime, ultimoBot };
  const [conv, msg] = await Promise.all([
    grezzo(s).from('conversations').select('id, last_message_preview').in('id', ids as number[]) as Promise<Pagina<{ id: number; last_message_preview: string | null }>>,
    grezzo(s).from('messages').select('conversation_id, created_at, twilio_status, twilio_error_code, is_template')
      .in('conversation_id', ids as number[]).eq('direction', 'out').gte('created_at', LANCIO_MONITOR_DA)
      .order('created_at', { ascending: false }).limit(1000) as Promise<Pagina<{
        conversation_id: number; created_at: string; twilio_status: string | null; twilio_error_code: number | null; is_template: boolean;
      }>>,
  ]);
  if (conv.error) throw new Error(conv.error.message);
  if (msg.error) throw new Error(msg.error.message);
  for (const r of conv.data ?? []) anteprime.set(r.id, r.last_message_preview);
  for (const m of msg.data ?? []) {
    if (ultimoBot.has(m.conversation_id)) continue; // arrivano dal piu' recente
    ultimoBot.set(m.conversation_id, { at: m.created_at, stato: m.twilio_status, codice: m.twilio_error_code, template: m.is_template });
  }
  return { anteprime, ultimoBot };
}

// ─────────────────────────── dettaglio ───────────────────────────

/** I tipi di evento della timeline di una chat: tutti quelli del lancio che portano un
 *  `conversationId`, piu' gli errori di invio e gli esiti verso il CRM. Elenco chiuso e
 *  non un `like 'lancio_%'`: cosi' la query resta sull'indice (type, created_at). */
export const TIPI_TIMELINE = [
  'lancio_intake', 'lancio_ingresso', 'lancio_apertura_inviata', 'lancio_apertura_freq_capped', 'lancio_apertura_meta_incompleta',
  'lancio_benvenuto_senza_link', 'lancio_mittente_ripiego', 'lancio_posto_bloccato', 'lancio_congedo', 'lancio_congedo_non_marcato',
  'lancio_domanda', 'lancio_silenzio', 'lancio_passaggio_umano_ignorato', 'lancio_assistenza',
  'lancio_pulsante', 'lancio_pulsante_colonne_non_scritte', 'lancio_link_sviluppatore', 'lancio_link_colonne_non_scritte',
  'lancio_fase_cambiata', 'lancio_fase_non_scritta', 'lancio_fase_non_cambiata',
  'lancio_riarruolamento_ignorato', 'lancio_riarruolamento_ripartito',
  'lancio_zoom_freq_capped', 'lancio_zoom_esito_incerto', 'lancio_zoom_claim_error', 'lancio_zoom_messaggio_non_costruito', 'lancio_zoom_meta_incompleta', 'lancio_zoom_error', 'lancio_zoom_config_error',
  'lancio_inizio_freq_capped', 'lancio_inizio_esito_incerto', 'lancio_inizio_claim_error', 'lancio_inizio_messaggio_non_costruito', 'lancio_inizio_meta_incompleta', 'lancio_inizio_error', 'lancio_inizio_config_error',
  'lancio_post_pitch_domanda', 'lancio_scelta_pulsanti', 'lancio_scelta_pulsante_tap', 'lancio_scelta', 'lancio_dopo_scelta',
  'lancio_slots_mostrati', 'lancio_slots_vuoti', 'lancio_slots_non_letti', 'lancio_at_non_valido',
  'lancio_crm_errore', 'lancio_crm_call', 'lancio_lead_senza_crm', 'lancio_nota_dopo_scelta_non_inviata',
  'lancio_followup', 'lancio_followup_inviato', 'lancio_followup_risposta', 'lancio_followup_freq_capped', 'lancio_followup_esito_incerto',
  'lancio_followup_congedo_da_cron', 'lancio_followup_congedo_senza_telefono', 'lancio_followup_ancora_non_marcata', 'lancio_followup_config_error',
  'lancio_restituito', 'lancio_restituito_terminale', 'lancio_restituzione_error', 'lancio_restituzione_rifiutata',
  'lancio_restituzione_fase_cambiata', 'lancio_restituzione_fase_non_scritta', 'lancio_inbound_dopo_restituzione',
  'lancio_nota_restituzione_non_marcata', 'lancio_scarto_senza_telefono', 'lancio_scarto_ritentato_da_cron',
  'lancio_video_live_link_missing', 'lancio_aperture_config_error',
  'send_error', 'bot_outcome_error', 'bot_outcome_rejected', 'bot_outcome_sent',
] as const;

export type MessaggioDettaglio = {
  id: number;
  direction: string;
  body: string;
  created_at: string;
  is_template: boolean;
  template_sid: string | null;
  twilio_status: string | null;
  twilio_error_code: number | null;
  sender: string | null;
};

export async function leggiDettaglio(s: Supa, id: number): Promise<{
  chat: ChatLancio | null;
  aiStatus: string | null;
  messaggi: MessaggioDettaglio[];
  eventi: EventoMonitor[];
  colonnaInizio: boolean;
}> {
  let colonnaInizio = Date.now() >= inizioAssenteFinoA;
  let chats: ChatLancio[];
  try {
    chats = await leggiChatPerId(s, [id], colonnaInizio);
  } catch (e) {
    if (!colonnaInizio || !colonnaAssente({ message: (e as Error).message }, COLONNA_INIZIO)) throw e;
    colonnaInizio = false;
    chats = await leggiChatPerId(s, [id], false);
  }
  const chat = chats[0] ?? null;
  if (!chat) return { chat: null, aiStatus: null, messaggi: [], eventi: [], colonnaInizio };
  const [messaggi, eventi] = await Promise.all([
    fetchAllRows<MessaggioDettaglio>((a, b) => grezzo(s).from('messages')
      .select('id, direction, body, created_at, is_template, template_sid, twilio_status, twilio_error_code, sender')
      .eq('conversation_id', id).order('created_at', { ascending: true }).range(a, b), { max: 5_000 }),
    fetchAllRows<EventoMonitor>((a, b) => grezzo(s).from('event_log').select('id, type, created_at, level, message, payload')
      .in('type', TIPI_TIMELINE as unknown as string[]).eq('payload->>conversationId', String(id))
      .gte('created_at', LANCIO_MONITOR_DA).order('created_at', { ascending: true }).range(a, b), { max: 2_000 }),
  ]);
  return { chat, aiStatus: chat.aiStatus, messaggi, eventi, colonnaInizio };
}

/** Il friendly name di un template chiesto a Twilio (account storico, poi il secondo),
 *  in cache per processo. Best effort: 3 secondi e poi si rinuncia, il SID resta. */
const _nomiTwilio = new Map<string, string | null>();
export async function nomeTemplateTwilio(sid: string): Promise<string | null> {
  if (_nomiTwilio.has(sid)) return _nomiTwilio.get(sid)!;
  const account = [
    [process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN],
    [process.env.TWILIO_ACCOUNT_SID_2, process.env.TWILIO_AUTH_TOKEN_2],
  ].filter((x): x is [string, string] => !!x[0] && !!x[1]);
  let risposto = false;
  for (const [accSid, token] of account) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`https://content.twilio.com/v1/Content/${encodeURIComponent(sid)}`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${accSid}:${token}`).toString('base64') },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      risposto = true;
      if (!r.ok) continue;
      const j = (await r.json()) as { friendly_name?: string };
      if (j.friendly_name) { _nomiTwilio.set(sid, j.friendly_name); return j.friendly_name; }
    } catch {
      // rete o timeout: si prova l'altro account, poi si rinuncia
    }
  }
  // Il "non esiste" si ricorda; un errore di rete no, al prossimo dettaglio si riprova.
  if (risposto) _nomiTwilio.set(sid, null);
  return null;
}
