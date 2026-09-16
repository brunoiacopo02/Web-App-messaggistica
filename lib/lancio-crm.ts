import { signPayload } from './bot-hmac';
import { getSupabaseAdmin } from './supabase/admin';

/**
 * Client verso le tre rotte del lancio sul CRM (spec §6.2): `slots`, `book`, `call-now`.
 * Firma HMAC identica a `sendOutcome` (`x-bot-signature`), timeout proprio: queste
 * chiamate stanno dentro un turno del drain e dall'altra parte c'e' una persona che
 * aspetta la risposta in chat.
 *
 * Qui non si decide niente: si traduce il contratto del CRM in un'unione tipizzata e
 * si lascia una traccia. Le uniche due eccezioni, entrambe volute:
 *  - il `409 conflitto` si ritenta UNA volta (e' la corsa fra due scritture sulla stessa
 *    riga, non un rifiuto di merito: al secondo colpo di solito passa);
 *  - ogni chiamata scrive una riga `lancio_crm_call` su `event_log`. La sera del lancio
 *    e' l'unico posto da cui si ricostruisce cosa ha risposto il CRM a chi, e non si
 *    puo' dipendere dal chiamante per averla. La scrittura non fallisce mai verso
 *    l'alto: una prenotazione riuscita non muore perche' non si e' scritto un log.
 */

const DEFAULT_BASE = 'https://crm-sales-fenice.vercel.app/api/bot/lancio';
export const LANCIO_CRM_TIMEOUT_MS = 8_000;
/** Il `conflitto` e' una corsa fra due scritture: si riprova una volta e basta. */
const TENTATIVI_MAX = 2;
/** Quanto di un corpo di errore ha senso portarsi dietro in un log. */
const MAX_DETAIL = 300;

export type LancioKind = 'mattina' | 'pomeriggio' | 'dopodomani';
export type LancioVenditore = { id: string; nome: string };
export type LancioSlots = {
  date: string;
  /** Ore con posti liberi; `'conferme'` per il dopodomani (le prende il team Conferme). */
  mattina: { hour: number; liberi: number }[] | 'conferme';
  /** Gia' filtrato dal preavviso lato CRM: `aperto:false, ore:[]` e' un esito normale. */
  pomeriggio?: { aperto: boolean; ore: number[] };
  mattinaEsaurita?: boolean;
  /** Le ore tonde che `book` accettera' per questa data (mattina + pomeriggio). */
  oreAmmesse?: number[];
};
/** Il contenuto di `conversations.lancio_info`: le risposte di riscaldamento, piu' lo
 *  stato interno del turno post-pitch. Al CRM viaggia dentro `info`. */
export type LancioInfo = { risposte: string[]; slotsMostratiAt?: string | null };

export type LancioCrmErrore =
  /** 409: l'ora scelta e' stata presa da qualcun altro. `slots` e' la fotografia
   *  aggiornata da cui riproporre (null se il CRM non ha saputo ricalcolarla). */
  | { ok: false; motivo: 'ora_esaurita'; slots: LancioSlots | null }
  /** 409: questo lead ha gia' un appuntamento. Non e' un fallimento: e' la sua ora. */
  | { ok: false; motivo: 'gia_prenotato'; appointmentAt: string | null; kind: LancioKind | null }
  /** 409: corsa persa anche al secondo tentativo. */
  | { ok: false; motivo: 'conflitto' }
  /** 409 su call-now: nessun venditore nel turno SERA. */
  | { ok: false; motivo: 'nessun_venditore' }
  /** 422: data/ora fuori dalle regole del lancio. */
  | { ok: false; motivo: 'fuori_regole' }
  /** 400: `info` o `note` non rispettano il contratto (bug nostro, non del lead). */
  | { ok: false; motivo: 'info_non_valida' }
  /** 403: lead non del lancio, non in mano al bot, o gia' presentato. */
  | { ok: false; motivo: 'forbidden' }
  /** 404: il lead non esiste sul CRM. */
  | { ok: false; motivo: 'not_found' }
  /** Rete caduta, DNS, timeout: non sappiamo se il CRM ha visto la richiesta. */
  | { ok: false; motivo: 'rete'; detail: string }
  /** Qualsiasi altro status, o un 2xx che non si riesce a leggere. */
  | { ok: false; motivo: 'http'; status: number; detail: string }
  /** `BOT_WEBHOOK_SECRET` assente da questa parte: non si esce nemmeno in rete. */
  | { ok: false; motivo: 'not_configured' };

export type LancioSlotsResult = { ok: true; slots: LancioSlots } | LancioCrmErrore;
export type LancioBookResult =
  | { ok: true; kind: LancioKind; venditore?: LancioVenditore; deduped?: true }
  | LancioCrmErrore;
export type LancioCallNowResult =
  | { ok: true; venditore: LancioVenditore; deduped?: true }
  | LancioCrmErrore;

type Endpoint = 'slots' | 'book' | 'call-now';
type Grezza = { status: number; json: Record<string, unknown> | null; text: string; tentativi: number };
type Contesto = { leadId?: string; date?: string };

/** La riga `lancio_crm_call`. Non lancia MAI: `getSupabaseAdmin` puo' esplodere se
 *  mancano le env, e l'insert puo' fallire — in nessuno dei due casi la chiamata al CRM
 *  che abbiamo appena fatto diventa meno vera. */
async function registra(
  endpoint: Endpoint,
  esito: { ok: true } | LancioCrmErrore,
  dati: { status: number | null; ms: number; tentativi: number; detail?: string } & Contesto,
): Promise<void> {
  const motivo = esito.ok ? null : esito.motivo;
  const level = esito.ok
    ? 'info'
    : motivo === 'rete' || motivo === 'http' || motivo === 'not_configured' || motivo === 'info_non_valida'
      ? 'error'
      : 'warn';
  try {
    await getSupabaseAdmin().from('event_log').insert({
      type: 'lancio_crm_call',
      payload: {
        endpoint,
        status: dati.status,
        motivo,
        ms: dati.ms,
        tentativi: dati.tentativi,
        ...(dati.leadId ? { leadId: dati.leadId } : {}),
        ...(dati.date ? { date: dati.date } : {}),
        ...(dati.detail ? { detail: dati.detail.slice(0, MAX_DETAIL) } : {}),
      } as never,
      message: `[lancio] CRM ${endpoint}: ${motivo ?? 'ok'} (${dati.status ?? '-'}) in ${dati.ms}ms`,
      level,
    });
  } catch {
    /* la traccia e' un di piu': non si porta giu' la chiamata. */
  }
}

/** Una singola POST firmata, con il suo timeout. L'abort e tutto il resto tornano `rete`:
 *  da qui non si distingue una richiesta mai partita da una risposta mai arrivata. */
async function unaChiamata(
  url: string,
  rawBody: string,
  firma: string,
): Promise<Omit<Grezza, 'tentativi'> | { ok: false; motivo: 'rete'; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LANCIO_CRM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': firma },
      body: rawBody,
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      const letto: unknown = JSON.parse(text);
      if (letto && typeof letto === 'object' && !Array.isArray(letto)) json = letto as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } catch (e) {
    return { ok: false, motivo: 'rete', detail: e instanceof Error ? e.message : 'errore' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Il giro completo di una delle tre rotte: firma, POST (col ritentativo sul
 * `conflitto`), lettura della risposta tramite `mappa`, riga su `event_log`. Le tre
 * funzioni pubbliche qui sotto differiscono solo per `mappa`.
 */
async function chiamaLancio<T extends { ok: true }>(
  endpoint: Endpoint,
  body: unknown,
  contesto: Contesto,
  mappa: (g: Grezza) => T | LancioCrmErrore,
): Promise<T | LancioCrmErrore> {
  const inizio = Date.now();
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) {
    const err: LancioCrmErrore = { ok: false, motivo: 'not_configured' };
    await registra(endpoint, err, { status: null, ms: 0, tentativi: 0, ...contesto });
    return err;
  }
  const base = (process.env.CRM_LANCIO_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const rawBody = JSON.stringify(body);
  const firma = signPayload(rawBody, secret);
  const url = `${base}/${endpoint}`;

  let esito = await unaChiamata(url, rawBody, firma);
  let tentativi = 1;
  // Solo il `conflitto` si ritenta: e' l'unico esito che dice "riprova", ed e' idempotente
  // (se nel frattempo la scrittura e' passata, il secondo giro torna `deduped`).
  while (
    tentativi < TENTATIVI_MAX &&
    !('ok' in esito) &&
    esito.status === 409 &&
    esito.json?.motivo === 'conflitto'
  ) {
    esito = await unaChiamata(url, rawBody, firma);
    tentativi += 1;
  }

  if ('ok' in esito) {
    await registra(endpoint, esito, { status: null, ms: Date.now() - inizio, tentativi, detail: esito.detail, ...contesto });
    return esito;
  }
  const risultato = mappa({ ...esito, tentativi });
  await registra(endpoint, risultato, {
    status: esito.status,
    ms: Date.now() - inizio,
    tentativi,
    ...(!risultato.ok && 'detail' in risultato ? { detail: risultato.detail } : {}),
    ...contesto,
  });
  return risultato;
}

/** Traduce gli status del contratto in errori tipizzati; `null` se e' un 2xx leggibile. */
function erroreDaStatus(g: Grezza): LancioCrmErrore | null {
  const motivo = typeof g.json?.motivo === 'string' ? g.json.motivo : null;
  if (g.status === 403) return { ok: false, motivo: 'forbidden' };
  if (g.status === 404) return { ok: false, motivo: 'not_found' };
  if (g.status === 422) return { ok: false, motivo: 'fuori_regole' };
  if (g.status === 400 && motivo === 'info_non_valida') return { ok: false, motivo: 'info_non_valida' };
  if (g.status === 409) {
    if (motivo === 'ora_esaurita') return { ok: false, motivo: 'ora_esaurita', slots: leggiSlots(g.json?.slots) };
    if (motivo === 'gia_prenotato') {
      return {
        ok: false,
        motivo: 'gia_prenotato',
        appointmentAt: typeof g.json?.appointmentAt === 'string' ? g.json.appointmentAt : null,
        kind: leggiKind(g.json?.kind),
      };
    }
    if (motivo === 'conflitto') return { ok: false, motivo: 'conflitto' };
    if (motivo === 'nessun_venditore') return { ok: false, motivo: 'nessun_venditore' };
  }
  if (g.status < 200 || g.status >= 300) return httpErrore(g);
  return null;
}

/** L'ultima spiaggia: status inatteso, o 2xx che non si riesce a leggere. Il `detail` e'
 *  quello del CRM se c'e', altrimenti il corpo grezzo — serve a chi legge il log. */
function httpErrore(g: Grezza): LancioCrmErrore {
  const detail = typeof g.json?.detail === 'string' ? g.json.detail : g.text;
  return { ok: false, motivo: 'http', status: g.status, detail: detail.slice(0, MAX_DETAIL) };
}

function leggiKind(raw: unknown): LancioKind | null {
  return raw === 'mattina' || raw === 'pomeriggio' || raw === 'dopodomani' ? raw : null;
}

function leggiSlots(raw: unknown): LancioSlots | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.date !== 'string') return null;
  const mattina =
    o.mattina === 'conferme'
      ? ('conferme' as const)
      : Array.isArray(o.mattina)
        ? o.mattina
            .filter((s): s is { hour: number; liberi?: unknown } =>
              !!s && typeof s === 'object' && typeof (s as { hour?: unknown }).hour === 'number')
            .map((s) => ({ hour: s.hour, liberi: typeof s.liberi === 'number' ? s.liberi : 0 }))
        : [];
  const pom = o.pomeriggio && typeof o.pomeriggio === 'object'
    ? (o.pomeriggio as { aperto?: unknown; ore?: unknown })
    : null;
  return {
    date: o.date,
    mattina,
    ...(pom
      ? {
          pomeriggio: {
            aperto: pom.aperto === true,
            ore: Array.isArray(pom.ore) ? pom.ore.filter((h): h is number => typeof h === 'number') : [],
          },
        }
      : {}),
    ...(typeof o.mattinaEsaurita === 'boolean' ? { mattinaEsaurita: o.mattinaEsaurita } : {}),
    ...(Array.isArray(o.oreAmmesse)
      ? { oreAmmesse: o.oreAmmesse.filter((h): h is number => typeof h === 'number') }
      : {}),
  };
}

function leggiVenditore(raw: unknown): LancioVenditore | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.nome !== 'string' || !o.nome.trim()) return undefined;
  return { id: String(o.id ?? ''), nome: o.nome.trim() };
}

export async function lancioSlots(date: string): Promise<LancioSlotsResult> {
  return chiamaLancio('slots', { date }, { date }, (g) => {
    const err = erroreDaStatus(g);
    if (err) return err;
    const slots = leggiSlots(g.json);
    // Un 200 che non contiene una data leggibile non e' una risposta: meglio il ramo
    // "CRM giu'" (pomeriggio e dopodomani restano proponibili) che ore inventate.
    return slots ? { ok: true as const, slots } : httpErrore(g);
  });
}

export async function lancioBook(args: {
  leadId: string;
  at: string;
  info?: LancioInfo;
  note?: string;
}): Promise<LancioBookResult> {
  const body = {
    leadId: args.leadId,
    at: args.at,
    ...(args.info ? { info: args.info } : {}),
    ...(args.note ? { note: args.note } : {}),
  };
  return chiamaLancio('book', body, { leadId: args.leadId }, (g) => {
    const err = erroreDaStatus(g);
    if (err) return err;
    const kind = leggiKind(g.json?.kind);
    // Senza un `kind` la conferma al lead non si puo' nemmeno scrivere (il testo cambia
    // fra mattina, pomeriggio e dopodomani): meglio un errore che una frase a caso.
    if (!kind) return httpErrore(g);
    const venditore = leggiVenditore(g.json?.venditore);
    return {
      ok: true as const,
      kind,
      ...(venditore ? { venditore } : {}),
      ...(g.json?.deduped === true ? { deduped: true as const } : {}),
    };
  });
}

export async function lancioCallNow(args: {
  leadId: string;
  info?: LancioInfo;
  note?: string;
}): Promise<LancioCallNowResult> {
  const body = {
    leadId: args.leadId,
    ...(args.info ? { info: args.info } : {}),
    ...(args.note ? { note: args.note } : {}),
  };
  return chiamaLancio('call-now', body, { leadId: args.leadId }, (g) => {
    const err = erroreDaStatus(g);
    if (err) return err;
    const venditore = leggiVenditore(g.json?.venditore);
    // Senza un nome la conferma fissa "ti chiama <nome>" non si puo' scrivere: meglio un
    // errore leggibile che un lead a cui promettiamo una chiamata da nessuno.
    if (!venditore) return httpErrore(g);
    return { ok: true as const, venditore, ...(g.json?.deduped === true ? { deduped: true as const } : {}) };
  });
}
