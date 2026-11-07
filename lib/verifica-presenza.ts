// Verifica presenza un'ora prima (PO 07/11/2026).
//
// Dal 07/11 le Conferme fanno la 1a chiamata il giorno lavorativo prima della call
// (CRM src/lib/conferme/boardWindow.ts). Un lead CONFERMATO IL GIORNO PRIMA rischia di
// sparire più di uno confermato la mattina stessa: un'ora prima della call il bot gli
// scrive, dal numero della chat, un promemoria che chiede di confermare la presenza.
//
// - Coorte: nel feed del CRM (`crm_lead_status`) `conferme_outcome = 'confermato'` e la
//   conferma è di un giorno di Roma PRIMA del giorno della call. La data della call è
//   quella del CRM (regola intoccabile 3: sugli appuntamenti la verità è il CRM).
// - Quando: da `max(T-60 min, 08:30)` a T-45 min. Il lead ha 30 minuti per rispondere,
//   le Conferme almeno 15 per chiamarlo prima della call. Una call alle 9:00 resta fuori
//   (il messaggio cadrebbe alle 8:00, fuori fascia invii).
// - Risposta: "sì / ci sarò / ok" = confermato col bot. Una risposta che dice di non
//   poter venire, spostare o annullare = `non_conferma`: le Conferme lo sanno subito, e
//   la chat la gestiscono i flussi di sempre (nota DISDETTA, giudice, SPOSTAMENTO).
//   Qualunque altra risposta = `risposta` (da leggere). Silenzio per 30 minuti = il CRM
//   lo mette fra i "da chiamare" (lo calcola lui dall'istante dell'invio).
// - Niente doppioni: sui lead della coorte che riceveranno questo messaggio il T-3h del
//   bot non parte (stesso contenuto, due ore prima: sarebbe una catena).
//
// Qui le regole pure (testate) e i due accessi al DB/CRM che servono alle route.

import type { getSupabaseAdmin } from './supabase/admin';
import { signPayload } from './bot-hmac';
import { clampToSendWindow, slotLabel } from './precall-reminders';
import { romeDayKey } from './rome-time';
import { templateName } from './name';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const MIN = 60_000;

/** Il messaggio parte un'ora prima della call... */
export const VERIFICA_ANTICIPO_MS = 60 * MIN;
/** ...e non più tardi di 45 minuti prima: 30 per rispondere, 15 per chiamarlo. */
export const VERIFICA_ULTIMO_MS = 45 * MIN;
/** Tempo concesso al lead per rispondere. Oltre, per il CRM è "da chiamare". */
export const VERIFICA_TIMEOUT_MS = 30 * MIN;

export const ESITO_CONFERMATO_CONFERME = 'confermato';

export type EsitoVerifica = 'in_attesa' | 'confermato' | 'non_conferma' | 'risposta';
export type ClasseRisposta = 'conferma' | 'non_conferma' | 'altro';

/** L'interruttore del ramo: spento salvo `VERIFICA_1H_ENABLED=1`. */
export function verificaAccesa(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERIFICA_1H_ENABLED === '1';
}

/** Il lead è nella coorte "confermato dalle Conferme il giorno prima"? */
export function inCoorteVerifica(r: {
  confermeOutcome: string | null | undefined;
  confermeOutcomeAt: string | null | undefined;
  appointmentAt: string | null | undefined;
}): boolean {
  if (r.confermeOutcome !== ESITO_CONFERMATO_CONFERME) return false;
  const conf = r.confermeOutcomeAt ? Date.parse(r.confermeOutcomeAt) : NaN;
  const call = r.appointmentAt ? Date.parse(r.appointmentAt) : NaN;
  if (Number.isNaN(conf) || Number.isNaN(call)) return false;
  // 'YYYY-MM-DD' di Roma: il confronto fra stringhe è quello fra giorni.
  return romeDayKey(new Date(conf)) < romeDayKey(new Date(call));
}

/**
 * Il primo istante in cui può partire la verifica, o `null` se per questa call non
 * parte mai (il primo istante utile cadrebbe dopo T-45, es. una call alle 9:00).
 */
export function istanteVerifica(callMs: number): number | null {
  const primo = clampToSendWindow(callMs - VERIFICA_ANTICIPO_MS);
  // clampToSendWindow porta indietro a 20:30 un orario serale: per la verifica non
  // conta (le call finiscono alle 21, T-60 = 20:00), ma un orario anticipato non deve
  // mai valere come "già dentro la finestra".
  if (primo < callMs - VERIFICA_ANTICIPO_MS) return null;
  if (primo > callMs - VERIFICA_ULTIMO_MS) return null;
  return primo;
}

/** Questa call riceverà la verifica (adesso o più tardi)? La usa il T-3h per tacere. */
export function verificaRaggiungibile(callMs: number, nowMs: number): boolean {
  const primo = istanteVerifica(callMs);
  if (primo === null) return false;
  return nowMs <= callMs - VERIFICA_ULTIMO_MS;
}

export interface DecisioneVerificaInput {
  enabled: boolean;
  callMs: number;
  nowMs: number;
  /** La chat punta proprio a questo lead del CRM (non a un gemello). */
  chatDelLead: boolean;
  aiPausedAt: string | null;
  /** Disdetta/spostamento chiesto in chat DOPO la conferma: non si chiede di confermare. */
  disdettaDopoConferma: boolean;
  /** Già presa per QUESTA data della call. */
  giaInviata: boolean;
  /** Finestra 24h aperta sul numero da cui si manda (lib/finestra-numero.ts). */
  finestraAperta: boolean;
  haTemplate: boolean;
}

/** La verifica: in template, in testo libero (finestra aperta), o niente. */
export function decideVerifica(i: DecisioneVerificaInput): 'template' | 'testo' | null {
  if (!i.enabled || !i.chatDelLead || i.aiPausedAt || i.disdettaDopoConferma || i.giaInviata) return null;
  const primo = istanteVerifica(i.callMs);
  if (primo === null || i.nowMs < primo || i.nowMs > i.callMs - VERIFICA_ULTIMO_MS) return null;
  // Fuori fascia invii non si scrive mai.
  if (clampToSendWindow(i.nowMs) !== i.nowMs) return null;
  if (i.finestraAperta) return 'testo';
  return i.haTemplate ? 'template' : null;
}

export type VerificaVars = { '1': string; '2': string };

export function verificaVars(nome: string | null | undefined, callMs: number, nowMs: number): VerificaVars {
  return { '1': templateName(nome ?? null), '2': slotLabel(callMs, nowMs) };
}

/** Il testo del template `fenice_verifica_presenza_v1` (e del testo libero a finestra aperta). */
export function verificaText(v: VerificaVars): string {
  return `Promemoria appuntamento: ciao ${v['1']}, la tua videocall con Fenice Academy è in programma ${v['2']}. ` +
    'Mi confermi che ci sarai? Rispondi pure qui.';
}

/** Il bottone di risposta rapida del template. */
export const VERIFICA_BOTTONE = { id: 'verifica_si', title: 'Sì, ci sarò' } as const;

function normalizza(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Frasi con "non" che sono un sì: si tolgono prima di cercare i segnali di disdetta.
const SI_CON_NON = [
  /non vedo l'?ora/g,
  /non manchero/g,
  /non mancher[oa]/g,
  /nessun problema/g,
  /senza problemi?/g,
  /non c'?e problema/g,
];

const NON_CONFERMA = [
  /\bnon\b/,
  /^no\b/,
  /\bno[,.!]/,
  /\bsposta/,
  /\brimand/,
  /\bposticip/,
  /\banticip/,
  /\bdisdic/,
  /\bdisdett/,
  /\bannull/,
  /\bcancell/,
  /\bimprevist/,
  /\bimpegn/,
  /\bun altro giorno\b/,
  /\baltro orario\b/,
  /\bpiu tardi\b/,
  /\bin ritardo\b/,
  /\britardo\b/,
];

const CONFERMA = [
  /^(si+|s[iì]|sii+)\b/,
  /\bsi\b/,
  /\bcerto\b/,
  /\bcertamente\b/,
  /\bconferm/,
  /\bci sono\b/,
  /\bci saro\b/,
  /\bpresente\b/,
  /\bperfetto\b/,
  /\bok+\b/,
  /\bokay\b/,
  /\bva bene\b/,
  /\bbenissimo\b/,
  /\bd'?accordo\b/,
  /\besatto\b/,
  /\bassolutamente\b/,
  /\bsicuro\b/,
  /\bsicuramente\b/,
  /\byes\b/,
  /\bovvio\b/,
  /\bcontaci\b/,
  /\bnon vedo l'?ora\b/,
  /\bnon manchero\b/,
  /\bnessun problema\b/,
];

const EMOJI_SI = /^[\s👍👌✅🙏💪😊🙂😀😁☺️❤️👏🤝✔️]+$/u;

/**
 * Cosa dice la risposta del lead alla verifica. Prima i segnali di non conferma (un
 * "sì ma devo spostare" non è un sì), poi quelli di conferma; il resto è da leggere.
 * Sbagliare verso `altro` costa una telefonata in più alle Conferme; sbagliare verso
 * `conferma` costa una call persa: le regole sono strette apposta.
 */
export function classificaRisposta(testo: string | null | undefined): ClasseRisposta {
  const raw = (testo ?? '').trim();
  if (!raw) return 'altro';
  if (EMOJI_SI.test(raw)) return 'conferma';
  const t = normalizza(raw);
  let senzaSiConNon = t;
  for (const re of SI_CON_NON) senzaSiConNon = senzaSiConNon.replace(re, ' ');
  if (NON_CONFERMA.some((re) => re.test(senzaSiConNon))) return 'non_conferma';
  // Un messaggio lungo non è un "sì": è una conversazione, la legge una persona.
  if (t.length > 120) return 'altro';
  if (CONFERMA.some((re) => re.test(t))) return 'conferma';
  return 'altro';
}

/** L'esito nuovo della verifica dopo una risposta, o `null` se non cambia niente. */
export function esitoDopoRisposta(attuale: EsitoVerifica, classe: ClasseRisposta): EsitoVerifica | null {
  // Un sì chiude tutto e non torna indietro per un messaggio successivo ("ok grazie"),
  // ma una disdetta dopo il sì sì: è l'informazione più importante per le Conferme.
  if (classe === 'non_conferma') return attuale === 'non_conferma' ? null : 'non_conferma';
  if (attuale === 'confermato') return null;
  if (classe === 'conferma') return 'confermato';
  // Una risposta qualunque non declassa una non conferma già data.
  if (attuale === 'in_attesa') return 'risposta';
  return null;
}

// ── Accesso al DB e al CRM ────────────────────────────────────────────────────

export const TABELLA_VERIFICHE = 'verifiche_presenza';

export const DEFAULT_CRM_VERIFICA_URL = 'https://crm-sales-fenice.vercel.app/api/bot/verifica-presenza';

export type RigaVerifica = {
  id: number;
  conversation_id: number;
  crm_lead_id: string;
  appuntamento_at: string;
  inviata_at: string | null;
  esito: EsitoVerifica;
};

// La tabella è nuova e lib/supabase/types.ts si rigenera da un'altra sessione: qui si
// accede senza i tipi generati, in un punto solo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tab = (supabase: Supa) => (supabase as any).from(TABELLA_VERIFICHE);

/**
 * La presa PRIMA dell'invio: una riga per (chat, data della call), vincolo UNIQUE.
 * Due giri sovrapposti non mandano due verifiche. `null` = già presa.
 */
export async function prendiVerifica(
  supabase: Supa,
  r: { conversationId: number; crmLeadId: string; appuntamentoAt: string },
): Promise<number | null> {
  const { data, error } = await tab(supabase)
    .insert({ conversation_id: r.conversationId, crm_lead_id: r.crmLeadId, appuntamento_at: r.appuntamentoAt })
    .select('id')
    .single();
  if (error || !data) return null;
  return Number(data.id);
}

/** Invio fallito: la presa si toglie, il prossimo giro riprova (se è ancora in tempo). */
export async function rilasciaVerifica(supabase: Supa, id: number): Promise<void> {
  await tab(supabase).delete().eq('id', id).is('inviata_at', null);
}

export async function segnaInviata(supabase: Supa, id: number, canale: 'template' | 'testo', at: string): Promise<void> {
  await tab(supabase).update({ inviata_at: at, canale }).eq('id', id);
}

/** Le chat che hanno già la verifica presa per una data della call (chiave conv|ISO). */
export async function verificheGiaPrese(supabase: Supa, conversationIds: number[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (conversationIds.length === 0) return out;
  const { data } = await tab(supabase)
    .select('conversation_id, appuntamento_at')
    .in('conversation_id', conversationIds);
  for (const r of (data ?? []) as { conversation_id: number; appuntamento_at: string }[]) {
    out.add(`${r.conversation_id}|${new Date(r.appuntamento_at).toISOString()}`);
  }
  return out;
}

export type EventoVerificaCrm =
  | { evento: 'inviata'; leadId: string; appuntamentoAt: string; at: string; canale: 'template' | 'testo' }
  | { evento: 'risposta'; leadId: string; appuntamentoAt: string; at: string; esito: Exclude<EsitoVerifica, 'in_attesa'>; testo: string };

/** Avvisa il CRM (contratto v1.13, Direzione 7). Mai un'eccezione: torna lo status. */
export async function avvisaCrm(e: EventoVerificaCrm): Promise<{ ok: boolean; status?: number; error?: string }> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { ok: false, error: 'BOT_WEBHOOK_SECRET mancante' };
  const url = process.env.CRM_VERIFICA_PRESENZA_URL || DEFAULT_CRM_VERIFICA_URL;
  const body = JSON.stringify(e);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(body, secret) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'errore di rete' };
  }
}

/**
 * Una risposta del lead arrivata sul webhook: se la chat ha una verifica aperta per una
 * call non ancora passata, la classifica e, se l'esito cambia, lo scrive e avvisa il
 * CRM. Non risponde al lead: la chat la porta avanti chi la porta sempre.
 */
export async function registraRispostaVerifica(
  supabase: Supa,
  conversationId: number,
  testo: string,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const { data } = await tab(supabase)
      .select('id, conversation_id, crm_lead_id, appuntamento_at, inviata_at, esito')
      .eq('conversation_id', conversationId)
      .not('inviata_at', 'is', null)
      .gte('appuntamento_at', new Date(nowMs - 15 * MIN).toISOString())
      .order('appuntamento_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const v = data as RigaVerifica | null;
    if (!v || !v.inviata_at || Date.parse(v.inviata_at) > nowMs) return;

    const classe = classificaRisposta(testo);
    const nuovo = esitoDopoRisposta(v.esito, classe);
    if (!nuovo || nuovo === 'in_attesa') return;

    const at = new Date(nowMs).toISOString();
    // Compare-and-set sull'esito: di due inbound in volo insieme ne vince uno.
    const { data: upd } = await tab(supabase)
      .update({ esito: nuovo, esito_at: at, risposta: testo.slice(0, 500) })
      .eq('id', v.id)
      .eq('esito', v.esito)
      .select('id');
    if (!upd || (upd as unknown[]).length === 0) return;

    const r = await avvisaCrm({
      evento: 'risposta', leadId: v.crm_lead_id,
      appuntamentoAt: new Date(v.appuntamento_at).toISOString(), at, esito: nuovo, testo: testo.slice(0, 500),
    });
    await tab(supabase).update(r.ok ? { crm_avvisato_at: at, crm_errore: null } : { crm_errore: r.error ?? `http_${r.status}` }).eq('id', v.id);
    await supabase.from('event_log').insert({
      type: 'verifica_presenza_risposta',
      payload: { conversationId, crmLeadId: v.crm_lead_id, esito: nuovo, classe, crm: r.ok ? 'ok' : (r.error ?? r.status ?? null) } as never,
      message: `[verifica] conv ${conversationId}: il lead ha risposto alla verifica (${nuovo})`,
      level: r.ok ? 'info' : 'warn',
    });
  } catch (err) {
    await supabase.from('event_log').insert({
      type: 'verifica_presenza_error',
      payload: { conversationId, fase: 'risposta' } as never,
      message: `[verifica] conv ${conversationId}: risposta non registrata: ${err instanceof Error ? err.message : 'errore'}`,
      level: 'error',
    });
  }
}
