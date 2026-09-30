import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { getSupabaseAdmin } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendOutcome } from '@/lib/bot-outcome';
import type { BotOutcome } from '@/lib/bot-contract';
import {
  getLancioSettingValue,
  isAttivo,
  setLancioSetting,
  validateLancioSettingInput,
  type LancioSettingKey,
} from '@/lib/lancio-settings';
import { getAutoReply, setAutoReply } from '@/lib/fenice-settings';
import { isConversazioneChat } from '@/lib/chat-perimetro';
import { ID_CRON, type IdAzione, type IdCron } from './azioni-tipi';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type Anteprima = {
  azione: IdAzione;
  params: Record<string, unknown>;
  descrizione: string;
  conteggio: number | null;
  righe: string[];
  avvertenza: string | null;
  token: string;
  scadeAt: string;
};
export type Esito = { ok: boolean; fatti: number; falliti: number; dettagli: string[]; messaggio: string };
export type Contesto = { s: Supa; origin: string; email: string; now: Date; fetch?: typeof fetch };

/** I rifiuti prima dell'esecuzione: la rotta li traduce in 409 (o 503 per il segreto). */
export type CodiceErrore =
  | 'anteprima_scaduta'
  | 'gia_eseguita'
  | 'conteggio_cambiato'
  | 'nessun_esito'
  | 'chat_fuori_perimetro'
  | 'cron_secret_mancante';

export class ErroreAzione extends Error {
  constructor(public readonly codice: CodiceErrore, public readonly nuovaAnteprima?: Anteprima) {
    super(codice);
    this.name = 'ErroreAzione';
  }
}

const Conversazione = z.object({ conversationId: z.number().int().positive() }).strict();
const Vuoto = z.object({}).strict();

export const PARAMS: Record<IdAzione, z.ZodType> = {
  rinvia_esiti_403: Vuoto,
  recupera_agende_consegnate: Vuoto,
  rinvia_esito: Conversazione,
  rilancia_cron: z.object({ cron: z.enum(ID_CRON) }).strict(),
  interruttore: z.object({
    chiave: z.enum(['lancio_attivo', 'lancio_pulsante_attivo', 'fenice_ai_autoreply']),
    valore: z.boolean(),
  }).strict(),
  pausa_mario: Conversazione,
  riprendi_mario: Conversazione,
};

// Cosa fa ogni giro e se scrive ai lead: e' quello che l'admin legge prima di confermare.
export const DESCRIZIONE_CRON: Record<IdCron, string> = {
  'lancio-aperture': 'Manda il benvenuto del lancio ai lead in attesa. Scrive ai lead.',
  'lancio-zoom': 'Manda il link dello Zoom della live ai lead del lancio. Scrive ai lead.',
  'lancio-followup': 'Manda i solleciti del lancio a chi non ha ancora risposto. Scrive ai lead.',
  'lancio-restituzioni': 'Restituisce al CRM i lead del lancio rimasti fermi e manda il congedo. Scrive ai lead e al CRM.',
  'riapri-mute': "Rimanda l'apertura ai lead a cui il primo messaggio non è mai partito. Scrive ai lead.",
  'adotta-mai-risposti': 'Riaggancia chi ci ha scritto per primo e non ha mai avuto risposta. Scrive ai lead.',
  'bot-followups': 'Giro di controllo di Mario: riprende le risposte rimaste indietro, chiude le chat ferme e manda gli esiti al CRM. Può scrivere ai lead.',
  'crm-lead-status': 'Legge dal CRM lo stato aggiornato dei lead (presenze e vendite). Non scrive ai lead.',
};

// L'evento che ogni cron scrive a fine giro. Non tutti si chiamano `*_run`: riapri-mute e
// adotta-mai-risposti lo scrivono solo quando eseguono davvero, crm-lead-status sempre.
const EVENTO_GIRO: Record<IdCron, string> = {
  'lancio-aperture': 'lancio_aperture_run',
  'lancio-zoom': 'lancio_zoom_run',
  'lancio-followup': 'lancio_followup_run',
  'lancio-restituzioni': 'lancio_restituzioni_run',
  'riapri-mute': 'riapri_mute',
  'adotta-mai-risposti': 'adotta_mai_risposti',
  'bot-followups': 'bot_followups_run',
  'crm-lead-status': 'crm_lead_status',
};

// Le uniche due rotte cron con una prova a vuoto vera: POST { esegui:false } non manda niente.
const CRON_CON_PROVA: readonly IdCron[] = ['riapri-mute', 'adotta-mai-risposti'];

const VALIDITA_MS = 5 * 60_000;
const TIMEOUT_MS = 280_000;
// La rotta `esegui` muore a 300 s: prova a vuoto di controllo + giro vero devono starci dentro.
const BUDGET_ESEGUI_MS = 290_000;
const SOGLIA_CAMBIO = 0.2;
const MAX_RIGHE = 10;

type Voce = {
  azione: IdAzione;
  params: Record<string, unknown>;
  conteggio: number | null;
  descrizione: string;
  scadeAt: number;
  usato: boolean;
};
const token = new Map<string, Voce>();

/** Solo per i test, come `_svuotaCacheMonitor`. */
export function _svuotaToken(): void {
  token.clear();
}

function pulisciScaduti(now: number): void {
  for (const [k, v] of token) if (v.scadeAt <= now) token.delete(k);
}

type Bozza = Omit<Anteprima, 'azione' | 'params' | 'token' | 'scadeAt'>;

export async function anteprima(azione: IdAzione, params: unknown, ctx: Contesto): Promise<Anteprima> {
  const schema = PARAMS[azione];
  if (!schema) throw new Error('azione_sconosciuta');
  const p = schema.parse(params ?? {}) as Record<string, unknown>;
  const bozza = await calcolaAnteprima(azione, p, ctx, TIMEOUT_MS);
  return registra(azione, p, bozza, ctx.now);
}

function registra(azione: IdAzione, params: Record<string, unknown>, b: Bozza, now: Date): Anteprima {
  pulisciScaduti(now.getTime());
  const id = randomUUID();
  const scadeAt = now.getTime() + VALIDITA_MS;
  token.set(id, { azione, params, conteggio: b.conteggio, descrizione: b.descrizione, scadeAt, usato: false });
  return { azione, params, ...b, token: id, scadeAt: new Date(scadeAt).toISOString() };
}

export async function esegui(t: string, ctx: Contesto): Promise<Esito> {
  const inizio = Date.now();
  const voce = token.get(t);
  if (!voce || voce.scadeAt <= ctx.now.getTime()) throw new ErroreAzione('anteprima_scaduta');
  if (voce.usato) throw new ErroreAzione('gia_eseguita');
  // Marcato prima di qualunque effetto: un doppio clic non deve mai partire due volte.
  voce.usato = true;

  const restante = () => Math.max(5_000, Math.min(TIMEOUT_MS, BUDGET_ESEGUI_MS - (Date.now() - inizio)));

  if (voce.conteggio !== null && haProvaAVuoto(voce)) {
    const nuova = await calcolaAnteprima(voce.azione, voce.params, ctx, restante());
    if (cambiatoTroppo(voce.conteggio, nuova.conteggio)) {
      throw new ErroreAzione('conteggio_cambiato', registra(voce.azione, voce.params, nuova, ctx.now));
    }
  }

  let esito: Esito;
  try {
    esito = await eseguiAzione(voce, ctx, restante);
  } catch (e) {
    if (e instanceof ErroreAzione) throw e;
    esito = { ok: false, fatti: 0, falliti: 0, dettagli: [], messaggio: `Errore imprevisto: ${messaggioDi(e)}` };
  }

  // Il registro non blocca l'azione: se la riga non si scrive, l'esito resta comunque vero.
  try {
    await ctx.s.from('event_log').insert({
      type: 'console_azione',
      level: esito.ok ? 'info' : 'error',
      message: `[console] ${voce.azione} da ${ctx.email}: ${esito.messaggio}`,
      payload: {
        azione: voce.azione,
        params: voce.params,
        anteprima: { conteggio: voce.conteggio, descrizione: voce.descrizione },
        esito,
        by: ctx.email,
      } as never,
    });
  } catch {
    // best effort
  }
  return esito;
}

function haProvaAVuoto(v: Voce): boolean {
  if (v.azione === 'rinvia_esiti_403' || v.azione === 'recupera_agende_consegnate') return true;
  return v.azione === 'rilancia_cron' && CRON_CON_PROVA.includes(v.params.cron as IdCron);
}

function cambiatoTroppo(prima: number, dopo: number | null): boolean {
  if (dopo === null) return true;
  return Math.abs(dopo - prima) / Math.max(prima, 1) > SOGLIA_CAMBIO;
}

// ---------------------------------------------------------------------------------------
// Anteprime

async function calcolaAnteprima(azione: IdAzione, p: Record<string, unknown>, ctx: Contesto, timeout: number): Promise<Bozza> {
  switch (azione) {
    case 'rinvia_esiti_403':
    case 'recupera_agende_consegnate': {
      const r = await chiamaCron(ctx, 'arretrati', 'POST', { cosa: cosaArretrati(azione), esegui: false, max: 1000 }, timeout);
      const j = richiediJsonOk(r, 'arretrati');
      return {
        descrizione: azione === 'rinvia_esiti_403'
          ? 'Rimanda al CRM, come nota, gli esiti rifiutati con 403 perché il lead era già tornato a una persona. Scrive al CRM, non ai lead.'
          : "Avvisa il CRM delle agende GDO consegnate di cui non ha mai saputo niente. Scrive al CRM, non ai lead.",
        conteggio: numero(j.candidate) ?? 0,
        righe: righeDa(j.esempi),
        avvertenza: null,
      };
    }
    case 'rinvia_esito': {
      const id = p.conversationId as number;
      const c = await leggiConversazione(ctx.s, id);
      const e = c ? esitoDa(c) : null;
      if (!c || !e) {
        return {
          descrizione: `Rinvia al CRM l'esito della chat ${id}.`,
          conteggio: 0,
          righe: [],
          avvertenza: 'Nessun esito da rinviare su questa chat',
        };
      }
      return {
        descrizione: `Rinvia al CRM l'esito ${e.outcome} della chat ${id}${c.crm_lead_id ? ` (lead ${c.crm_lead_id})` : ''}.`,
        conteggio: 1,
        righe: e.date ? [`${e.outcome} per il ${e.date}`] : [e.outcome],
        avvertenza: c.crm_lead_id ? null : 'La chat non è collegata a un lead del CRM: il rinvio non partirà.',
      };
    }
    case 'rilancia_cron': {
      const cron = p.cron as IdCron;
      const giro = await ultimoGiro(ctx.s, cron);
      const righeGiro = giro ? [`Ultimo giro: ${giro.created_at} — ${giro.message}`] : ['Nessun giro registrato.'];
      if (CRON_CON_PROVA.includes(cron)) {
        const r = await chiamaCron(ctx, cron, 'POST', { esegui: false }, timeout);
        const j = richiediJsonOk(r, cron);
        return {
          descrizione: DESCRIZIONE_CRON[cron],
          conteggio: numero(j.candidate) ?? 0,
          righe: [...righeGiro, ...righeDa(j.esempi)].slice(0, MAX_RIGHE),
          avvertenza: 'Manda messaggi WhatsApp ai lead.',
        };
      }
      return {
        descrizione: DESCRIZIONE_CRON[cron],
        conteggio: null,
        righe: righeGiro,
        avvertenza: 'Questo giro non ha una prova a vuoto: parte davvero.',
      };
    }
    case 'interruttore': {
      const chiave = p.chiave as string;
      const valore = p.valore as boolean;
      const prima = chiave === 'fenice_ai_autoreply'
        ? await getAutoReply(ctx.s)
        : isAttivo(await getLancioSettingValue(ctx.s, chiave as LancioSettingKey));
      return {
        descrizione: `${chiave}: ${statoLeggibile(prima)} → ${statoLeggibile(valore)}`,
        conteggio: null,
        righe: [],
        avvertenza: prima === valore ? 'È già così: la conferma non cambia niente.' : null,
      };
    }
    case 'pausa_mario':
    case 'riprendi_mario': {
      const id = p.conversationId as number;
      await richiediPerimetro(ctx.s, id);
      const { data } = await ctx.s.from('conversations').select('ai_paused_at').eq('id', id).maybeSingle();
      const inPausa = (data as { ai_paused_at: string | null } | null)?.ai_paused_at != null;
      const pausa = azione === 'pausa_mario';
      return {
        descrizione: pausa ? `Ferma Mario sulla chat ${id}: da qui risponde una persona.` : `Riattiva Mario sulla chat ${id}.`,
        conteggio: null,
        righe: [`Adesso: ${inPausa ? 'Mario in pausa' : 'Mario attivo'}`],
        avvertenza: pausa === inPausa ? 'È già così: la conferma non cambia niente.' : null,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------
// Esecuzioni

async function eseguiAzione(v: Voce, ctx: Contesto, timeout: () => number): Promise<Esito> {
  const p = v.params;
  switch (v.azione) {
    case 'rinvia_esiti_403':
    case 'recupera_agende_consegnate': {
      const r = await chiamaCronSicura(ctx, 'arretrati', 'POST', { cosa: cosaArretrati(v.azione), esegui: true, max: 1000 }, timeout());
      if ('esito' in r) return r.esito;
      const j = r.json ?? {};
      if (!r.ok || j.ok === false) return fallitoHttp(r);
      const fatti = numero(v.azione === 'rinvia_esiti_403' ? j.inviate : j.avvisate) ?? 0;
      const falliti = numero(j.fallite) ?? 0;
      const verbo = v.azione === 'rinvia_esiti_403' ? 'rinviati al CRM' : 'avvisi accettati dal CRM';
      return {
        ok: true, fatti, falliti, dettagli: righeDa(j.esempi),
        messaggio: `${fatti} ${verbo}, ${falliti} falliti su ${numero(j.candidate) ?? '?'} candidati`,
      };
    }
    case 'rinvia_esito': {
      const id = p.conversationId as number;
      const c = await leggiConversazione(ctx.s, id);
      const e = c ? esitoDa(c) : null;
      if (!e) throw new ErroreAzione('nessun_esito');
      const res = await sendOutcome(ctx.s, id, { outcome: e.outcome, date: e.date });
      // La stessa riga di app/api/cron/resend-outcome: chi legge il registro non deve
      // distinguere un rinvio dalla console da uno a mano.
      await ctx.s.from('event_log').insert({
        type: 'admin_resend_outcome',
        payload: { conversationId: id, outcome: e.outcome, result: res } as never,
        message: `[admin] resend-outcome conv ${id}: ${e.outcome} → ${res.sent ? 'ok' : res.error ?? res.status}`,
        level: res.sent ? 'info' : 'error',
      });
      return res.sent
        ? { ok: true, fatti: 1, falliti: 0, dettagli: [], messaggio: `Esito ${e.outcome} della chat ${id} accettato dal CRM` }
        : { ok: false, fatti: 0, falliti: 1, dettagli: [], messaggio: `Il CRM non ha preso l'esito ${e.outcome} della chat ${id}: ${res.error ?? `HTTP ${res.status}`}` };
    }
    case 'rilancia_cron': {
      const cron = p.cron as IdCron;
      const conProva = CRON_CON_PROVA.includes(cron);
      const r = await chiamaCronSicura(ctx, cron, conProva ? 'POST' : 'GET', conProva ? { esegui: true } : undefined, timeout());
      if ('esito' in r) return r.esito;
      const j = r.json ?? {};
      if (!r.ok || j.ok === false) return fallitoHttp(r);
      return {
        ok: true,
        fatti: numero(j.inviati ?? j.inviate ?? j.scritti) ?? 0,
        falliti: numero(j.falliti ?? j.fallite) ?? 0,
        dettagli: righeDa(j.errori),
        messaggio: `${cron}: ${sintesi(j)}`,
      };
    }
    case 'interruttore': {
      const chiave = p.chiave as string;
      const valore = p.valore as boolean;
      if (chiave === 'fenice_ai_autoreply') {
        const prima = await getAutoReply(ctx.s);
        await setAutoReply(ctx.s, valore);
        await ctx.s.from('event_log').insert({
          type: 'console_autoreply_cambiata',
          payload: { key: chiave, old: prima, new: valore, who: ctx.email } as never,
          message: `[console] ${chiave}: ${prima} → ${valore} (${ctx.email})`,
          level: 'info',
        });
        return { ok: true, fatti: 1, falliti: 0, dettagli: [], messaggio: `${chiave}: ${statoLeggibile(prima)} → ${statoLeggibile(valore)}` };
      }
      const valid = validateLancioSettingInput(chiave, valore);
      if (!valid.ok) return { ok: false, fatti: 0, falliti: 1, dettagli: [], messaggio: `Valore non accettato per ${chiave}: ${valid.reason}` };
      const k = chiave as LancioSettingKey;
      const prima = await getLancioSettingValue(ctx.s, k);
      const scritto = await setLancioSetting(ctx.s, k, valid.value);
      if (!scritto.ok) {
        return { ok: false, fatti: 0, falliti: 1, dettagli: [], messaggio: `${chiave} NON salvata: ${scritto.error}. Il valore è rimasto quello di prima.` };
      }
      // Stesso formato di app/api/fenice/lancio-settings: prima, dopo e chi.
      const leggibile = valid.value === '' ? '(vuoto)' : String(valid.value);
      await ctx.s.from('event_log').insert({
        type: 'lancio_setting_cambiata',
        payload: { key: k, old: prima ?? null, new: valid.value, who: ctx.email } as never,
        message: `[lancio] ${k}: ${prima === null || prima === undefined ? '(vuoto)' : String(prima)} → ${leggibile} (${ctx.email})`,
        level: 'info',
      });
      return { ok: true, fatti: 1, falliti: 0, dettagli: [], messaggio: `${chiave}: ${statoLeggibile(isAttivo(prima))} → ${statoLeggibile(valore)}` };
    }
    case 'pausa_mario':
    case 'riprendi_mario': {
      const id = p.conversationId as number;
      await richiediPerimetro(ctx.s, id);
      const pausa = v.azione === 'pausa_mario';
      const pausedAt = pausa ? ctx.now.toISOString() : null;
      const { error } = await ctx.s.from('conversations').update({ ai_paused_at: pausedAt }).eq('id', id);
      if (error) {
        return { ok: false, fatti: 0, falliti: 1, dettagli: [], messaggio: `La chat ${id} non è stata aggiornata: ${error.message}` };
      }
      // Stesso formato di app/api/chat/pause.
      await ctx.s.from('event_log').insert({
        type: pausa ? 'bot_paused' : 'bot_resumed',
        payload: { conversationId: id, by: ctx.email } as never,
        message: pausa
          ? `[chat] bot fermato sulla conv ${id} da ${ctx.email}`
          : `[chat] bot riattivato sulla conv ${id} da ${ctx.email}`,
        level: 'warn',
      });
      return { ok: true, fatti: 1, falliti: 0, dettagli: [], messaggio: pausa ? `Mario fermato sulla chat ${id}` : `Mario riattivato sulla chat ${id}` };
    }
  }
}

// ---------------------------------------------------------------------------------------
// Chiamate alle rotte cron

type Risposta = { ok: boolean; status: number; json: Record<string, unknown> | null; testo: string };

async function chiamaCron(
  ctx: Contesto, cron: IdCron | 'arretrati', metodo: 'GET' | 'POST', corpo: unknown, timeout: number,
): Promise<Risposta> {
  const segreto = process.env.CRON_SECRET;
  if (!segreto) throw new ErroreAzione('cron_secret_mancante');
  const f = ctx.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${segreto}` };
    if (metodo === 'POST') headers['content-type'] = 'application/json';
    const r = await f(`${ctx.origin}/api/cron/${cron}`, {
      method: metodo,
      headers,
      body: metodo === 'POST' ? JSON.stringify(corpo) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const testo = await r.text();
    let json: Record<string, unknown> | null = null;
    try {
      const x = JSON.parse(testo);
      json = x && typeof x === 'object' && !Array.isArray(x) ? x : null;
    } catch {
      json = null;
    }
    return { ok: r.ok, status: r.status, json, testo };
  } finally {
    clearTimeout(timer);
  }
}

/** Come `chiamaCron`, ma un errore di rete o un timeout diventano un esito fallito. */
async function chiamaCronSicura(
  ctx: Contesto, cron: IdCron | 'arretrati', metodo: 'GET' | 'POST', corpo: unknown, timeout: number,
): Promise<Risposta | { esito: Esito }> {
  try {
    return await chiamaCron(ctx, cron, metodo, corpo, timeout);
  } catch (e) {
    if (e instanceof ErroreAzione) throw e;
    const abort = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return {
      esito: {
        ok: false, fatti: 0, falliti: 0, dettagli: [],
        messaggio: abort
          ? `Nessuna risposta da ${cron} entro ${Math.round(timeout / 1000)} s: il giro potrebbe essere ancora in corso. Controlla il registro prima di rifarlo.`
          : `Chiamata a ${cron} non riuscita: ${messaggioDi(e)}`,
      },
    };
  }
}

function richiediJsonOk(r: Risposta, cron: string): Record<string, unknown> {
  if (!r.ok || !r.json || r.json.ok === false) {
    throw new Error(`prova_a_vuoto_fallita: ${cron} ha risposto HTTP ${r.status} ${erroreDi(r)}`.trim());
  }
  return r.json;
}

function fallitoHttp(r: Risposta): Esito {
  return { ok: false, fatti: 0, falliti: 0, dettagli: [], messaggio: `Il giro ha risposto con un errore (HTTP ${r.status}): ${erroreDi(r)}` };
}

function erroreDi(r: Risposta): string {
  const e = r.json?.error;
  return typeof e === 'string' ? e : r.testo.slice(0, 200);
}

// ---------------------------------------------------------------------------------------
// Letture e formati

type RigaConv = { bot_outcome: string | null; bot_scheduled_at: string | null; ai_status: string | null; crm_lead_id: string | null };

async function leggiConversazione(s: Supa, id: number): Promise<RigaConv | null> {
  const { data } = await s.from('conversations')
    .select('bot_outcome, bot_scheduled_at, ai_status, crm_lead_id').eq('id', id).maybeSingle();
  return (data as RigaConv | null) ?? null;
}

const ESITI: readonly string[] = ['APPUNTAMENTO', 'DA_SCARTARE', 'RICHIAMO', 'NON_RISPOSTO', 'INTERROTTO', 'NOTA', 'CONTATTO_UMANO'];

function esitoDa(c: RigaConv): { outcome: BotOutcome; date: string | undefined } | null {
  if (c.bot_outcome && ESITI.includes(c.bot_outcome)) {
    return { outcome: c.bot_outcome as BotOutcome, date: c.bot_outcome === 'APPUNTAMENTO' ? c.bot_scheduled_at ?? undefined : undefined };
  }
  if (!c.bot_outcome && c.ai_status === 'booked' && c.bot_scheduled_at) {
    return { outcome: 'APPUNTAMENTO', date: c.bot_scheduled_at };
  }
  return null;
}

async function ultimoGiro(s: Supa, cron: IdCron): Promise<{ created_at: string; message: string } | null> {
  const { data } = await s.from('event_log').select('created_at, message')
    .eq('type', EVENTO_GIRO[cron]).order('created_at', { ascending: false }).limit(1);
  const r = (data ?? [])[0] as { created_at: string; message: string | null } | undefined;
  return r ? { created_at: r.created_at, message: r.message ?? '' } : null;
}

async function richiediPerimetro(s: Supa, id: number): Promise<void> {
  if (!(await isConversazioneChat(s as unknown as SupabaseClient, id))) throw new ErroreAzione('chat_fuori_perimetro');
}

function cosaArretrati(a: 'rinvia_esiti_403' | 'recupera_agende_consegnate'): string {
  return a === 'rinvia_esiti_403' ? 'esiti-403' : 'agenda-delivery';
}

function statoLeggibile(b: boolean): string {
  return b ? 'acceso' : 'spento';
}

function numero(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function righeDa(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.slice(0, MAX_RIGHE).map(formattaEsempio);
}

function formattaEsempio(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    return Object.entries(x as Record<string, unknown>).map(([k, v]) => `${k} ${v ?? '—'}`).join(' · ');
  }
  return String(x);
}

/** Una riga leggibile dal JSON del cron: i valori semplici, le liste come conteggi. */
function sintesi(j: Record<string, unknown>): string {
  const parti: string[] = [];
  for (const [k, v] of Object.entries(j)) {
    if (k === 'ok' || k === 'esempi' || k === 'errori') continue;
    if (Array.isArray(v)) parti.push(`${k}: ${v.length} elementi`);
    else if (v && typeof v === 'object') {
      const dentro = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x === null || typeof x !== 'object')
        .map(([a, b]) => `${a} ${b}`).join(', ');
      parti.push(`${k}: {${dentro}}`);
    } else parti.push(`${k}: ${typeof v === 'string' ? v.slice(0, 80) : v}`);
    if (parti.length >= 10) break;
  }
  return parti.length ? parti.join(', ') : 'risposta vuota';
}

function messaggioDi(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
