/**
 * Recupero delle aperture mai partite (PO 06/11/2026). SPENTO di default.
 *
 * Fra il 03/11 e la notte del 06/11 ~130 lead freschi arruolati nel bot non hanno mai
 * ricevuto l'apertura (chat `active` senza nessun messaggio in uscita; quasi tutti col
 * wa_number dell'8061, che dal 06/11 ha tetto 15). La rete `apertura_mai_partita`
 * (lib/sequence.ts) vale solo per le chat arruolate dal 06/11 07:00 UTC: queste restano
 * fuori. Il PO non vuole darle ai GDO (saturi): il bot le apre "piano piano".
 *
 * Regole:
 * - Coda: chat attive di lead CRM, arruolate prima di APERTURA_MAI_PARTITA_DAL_MS (e non
 *   prima di RECUPERO_CODA_DAL_MS), senza alcun messaggio in uscita ne' in entrata, dalla
 *   PIU' RECENTE alla piu' vecchia.
 * - Solo 09:30-20:30 Roma, al massimo RECUPERO_MAX_PER_GIRO per giro di cron, fino a
 *   `RECUPERO_APERTURE_GIORNALIERE` al giorno (assente/0 = spento). Il conteggio e' a
 *   parte (evento `recupero_apertura_inviata`) e NON scrive `mittente_apertura`: non ruba
 *   posti ai freschi nei tetti per numero.
 * - Numeri: solo quelli di `RECUPERO_NUMERI`, mai 8061 ne' 3199 (ne' il primario), HIGH
 *   e fuori pausa, con tetto > 0 in `tetti_numeri`, template spedibile. Vince il meno
 *   carico oggi (aperture di Mario + recuperi). Prima dell'invio la chat passa a quel
 *   numero: lecito, nessun messaggio e' mai partito, non c'e' un thread da spezzare.
 * - Oltre RECUPERO_MAX_GIORNI dall'arruolamento non si apre piu': la chat torna al CRM
 *   come lead mai contattato, con lo stesso esito della rete (`esitoAperturaMaiPartita`),
 *   evento `recupero_apertura_restituita`.
 * - Stesso template e stesso percorso dell'apertura differita (lib/apertura-mario-invio.ts).
 */
import { APERTURA_MAI_PARTITA_DAL_MS, romeMinutes } from './sequence';

const H = 3600_000;
const D = 24 * H;

/** La coda e' fatta delle chat che la rete esclude: arruolate prima di questo istante. */
export const RECUPERO_FINO_AL_MS = APERTURA_MAI_PARTITA_DAL_MS;
/** Limite basso della coda: l'incidente comincia il 03/11. Le chat piu' vecchie non si toccano. */
export const RECUPERO_CODA_DAL_MS = Date.parse('2026-11-01T00:00:00Z');
/** Oltre questa eta' (dall'arruolamento) un lead non e' piu' "recente": si restituisce. */
export const RECUPERO_MAX_GIORNI = 5;
/** Tetto per giro di cron (il cron gira ogni 20'). */
export const RECUPERO_MAX_PER_GIRO = 8;
/** Restituzioni al CRM per giro: un tetto solo per tenere corto il run. */
export const RECUPERO_MAX_RESTITUZIONI_PER_GIRO = 20;
/** Mai da questi numeri, qualunque cosa dica l'env: 8061 (tetto 15, qualita' in calo) e 3199. */
export const NUMERI_MAI_RECUPERO = ['+393520158061', '+393520413199'];

export const EVENTO_RECUPERO_INVIATA = 'recupero_apertura_inviata';
export const EVENTO_RECUPERO_SALTATA = 'recupero_apertura_saltata';
export const EVENTO_RECUPERO_RESTITUITA = 'recupero_apertura_restituita';
export const EVENTO_RECUPERO_RUN = 'recupero_aperture_run';

const soloNum = (n: string | null | undefined) => (n ?? '').trim().replace(/^whatsapp:/i, '');

export type ConfigRecupero = { tetto: number; numeri: string[]; maxPerGiro: number };

/** Legge le env. `tetto` 0 = spento. Numeri in forma `whatsapp:+39…`, deduplicati. */
export function configRecupero(env: Record<string, string | undefined> = process.env): ConfigRecupero {
  const t = Number((env.RECUPERO_APERTURE_GIORNALIERE ?? '').trim());
  const tetto = Number.isInteger(t) && t > 0 ? t : 0;
  const vietati = new Set([...NUMERI_MAI_RECUPERO, soloNum(env.TWILIO_WHATSAPP_NUMBER_FENICE)].filter(Boolean));
  const visti = new Set<string>();
  const numeri: string[] = [];
  for (const grezzo of (env.RECUPERO_NUMERI ?? '').split(',')) {
    const n = soloNum(grezzo);
    if (!n || vietati.has(n) || visti.has(n)) continue;
    visti.add(n);
    numeri.push(`whatsapp:${n}`);
  }
  return { tetto, numeri, maxPerGiro: RECUPERO_MAX_PER_GIRO };
}

/** 09:30 (inclusa) – 20:30 (esclusa), Europe/Rome. */
export function inFinestraRecupero(nowMs: number): boolean {
  const m = romeMinutes(nowMs);
  return m >= 9 * 60 + 30 && m < 20 * 60 + 30;
}

export type ChatCoda = {
  id: number;
  ai_started_at: string | null;
  crm_lead_id: string | null;
  crm_funnel: string | null;
  wa_number: string | null;
  phone: string | null;
  firstName: string | null;
};

export type ConteggioMessaggi = { out: number; in: number };

export type DecisioneChat =
  | { azione: 'invia' }
  | { azione: 'restituisci' }
  | { azione: 'ignora'; motivo: 'gia_aperta' | 'fuori_coda' }
  | { azione: 'salta'; motivo: 'ha_scritto_lui' | 'senza_telefono' | 'senza_arruolamento' };

/** Pura: cosa fare di una chat della coda, dati i suoi messaggi di sempre. */
export function decidiChat(c: ChatCoda, m: ConteggioMessaggi, nowMs: number): DecisioneChat {
  // Gia' partito qualcosa: non e' un'apertura mai partita, e il numero non si tocca piu'.
  if (m.out > 0) return { azione: 'ignora', motivo: 'gia_aperta' };
  const arr = c.ai_started_at ? Date.parse(c.ai_started_at) : NaN;
  if (Number.isNaN(arr)) return { azione: 'salta', motivo: 'senza_arruolamento' };
  if (arr >= RECUPERO_FINO_AL_MS || arr < RECUPERO_CODA_DAL_MS) return { azione: 'ignora', motivo: 'fuori_coda' };
  // Ci ha scritto lui senza risposta: non e' un'apertura da mandare a freddo, e la chat
  // e' legata al numero a cui ha scritto.
  if (m.in > 0) return { azione: 'salta', motivo: 'ha_scritto_lui' };
  if (nowMs - arr > RECUPERO_MAX_GIORNI * D) return { azione: 'restituisci' };
  if (!c.phone) return { azione: 'salta', motivo: 'senza_telefono' };
  return { azione: 'invia' };
}

/** Pura: il numero meno carico; a parita' l'ordine di `RECUPERO_NUMERI`. */
export function scegliNumeroRecupero(numeri: { numero: string; carico: number }[]): string | null {
  if (numeri.length === 0) return null;
  const ordinati = numeri.map((n, i) => ({ ...n, i })).sort((a, b) => (a.carico - b.carico) || (a.i - b.i));
  return ordinati[0].numero;
}

export type EsitoInvio = { ok: boolean; capped?: boolean; error?: string };

export type DepsRecupero = {
  /** Recuperi gia' inviati oggi (giorno di Roma). null = conteggio fallito: niente invii. */
  contaInviateOggi: () => Promise<number | null>;
  /** La coda gia' filtrata sulle colonne, dalla piu' recente. */
  caricaCoda: () => Promise<ChatCoda[]>;
  /** Messaggi di sempre per chat. Una chat assente dalla mappa = nessun messaggio. null = lettura fallita. */
  contaMessaggi: (ids: number[]) => Promise<Map<number, ConteggioMessaggi> | null>;
  stopCrm: (crmLeadId: string | null) => Promise<string | null>;
  /** Numeri ammessi oggi, col carico; gli scarti finiscono nel riepilogo del run. */
  numeriUtilizzabili: () => Promise<{ ok: { numero: string; carico: number }[]; scarti: { numero: string; motivo: string }[] }>;
  riassegnaNumero: (id: number, numero: string) => Promise<boolean>;
  invia: (c: ChatCoda, numero: string) => Promise<EsitoInvio & { configMancante?: boolean }>;
  restituisci: (c: ChatCoda) => Promise<{ sent: boolean; status?: number; error?: string }>;
  /** Gia' scritto oggi un `recupero_apertura_saltata` per questa chat e motivo? */
  saltataOggi: (id: number, motivo: string) => Promise<boolean>;
  log: (type: string, level: 'info' | 'warn', payload: Record<string, unknown>, message: string) => Promise<void>;
};

export type ReportRecupero = {
  disabled?: true;
  fuoriFinestra?: true;
  inviate: number;
  restituite: number;
  saltate: Record<string, number>;
  gia_aperte: number;
  inCoda: number;
  residuoOggi: number;
  scartiNumeri?: { numero: string; motivo: string }[];
};

export async function eseguiRecupero(cfg: ConfigRecupero, deps: DepsRecupero, nowMs: number): Promise<ReportRecupero> {
  const report: ReportRecupero = { inviate: 0, restituite: 0, saltate: {}, gia_aperte: 0, inCoda: 0, residuoOggi: 0 };
  if (cfg.tetto <= 0) return { ...report, disabled: true };
  if (!inFinestraRecupero(nowMs)) return { ...report, fuoriFinestra: true };

  const saltata = async (c: ChatCoda, motivo: string, extra: Record<string, unknown> = {}) => {
    report.saltate[motivo] = (report.saltate[motivo] ?? 0) + 1;
    if (await deps.saltataOggi(c.id, motivo)) return;
    await deps.log(EVENTO_RECUPERO_SALTATA, 'info',
      { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, aiStartedAt: c.ai_started_at, ...extra },
      `[recupero-aperture] conv ${c.id}: saltata (${motivo})`);
  };

  const giaOggi = await deps.contaInviateOggi();
  // Conteggio fallito = nessun invio (fallisce chiuso); le restituzioni restano.
  let residuo = giaOggi === null ? 0 : Math.max(0, cfg.tetto - giaOggi);
  let perGiro = cfg.maxPerGiro;

  const coda = await deps.caricaCoda();
  const msgs = await deps.contaMessaggi(coda.map((c) => c.id));
  if (msgs === null) {
    await deps.log(EVENTO_RECUPERO_RUN, 'warn', { errore: 'lettura_messaggi_fallita' },
      '[recupero-aperture] lettura dei messaggi fallita: nessun invio');
    return report;
  }

  // I numeri si leggono solo se c'e' qualcosa da mandare.
  let numeri: { numero: string; carico: number }[] | null = null;
  let senzaNumero = false;

  for (const c of coda) {
    const d = decidiChat(c, msgs.get(c.id) ?? { out: 0, in: 0 }, nowMs);
    if (d.azione === 'ignora') { if (d.motivo === 'gia_aperta') report.gia_aperte++; continue; }
    if (d.azione === 'salta') { await saltata(c, d.motivo); continue; }

    if (d.azione === 'restituisci') {
      if (report.restituite >= RECUPERO_MAX_RESTITUZIONI_PER_GIRO) continue;
      const stop = await deps.stopCrm(c.crm_lead_id);
      if (stop) { await saltata(c, `stop_crm_${stop}`); continue; }
      const r = await deps.restituisci(c);
      if (r.sent) report.restituite++;
      await deps.log(EVENTO_RECUPERO_RESTITUITA, r.sent ? 'info' : 'warn', {
        conversationId: c.id, crmLeadId: c.crm_lead_id, aiStartedAt: c.ai_started_at,
        sent: r.sent, status: r.status ?? null, error: r.error ?? null,
      }, `[recupero-aperture] conv ${c.id}: oltre ${RECUPERO_MAX_GIORNI} giorni senza apertura, restituita al CRM come mai contattata (${r.sent ? 'ok' : r.error ?? r.status ?? 'errore'})`);
      continue;
    }

    // d.azione === 'invia'
    report.inCoda++;
    if (residuo <= 0 || perGiro <= 0 || senzaNumero) continue;

    const stop = await deps.stopCrm(c.crm_lead_id);
    if (stop) { await saltata(c, `stop_crm_${stop}`); continue; }

    if (numeri === null) {
      const n = await deps.numeriUtilizzabili();
      numeri = n.ok;
      report.scartiNumeri = n.scarti;
    }
    const numero = scegliNumeroRecupero(numeri);
    if (!numero) {
      senzaNumero = true;
      await deps.log(EVENTO_RECUPERO_SALTATA, 'warn', { motivo: 'nessun_numero', scarti: report.scartiNumeri ?? [] },
        '[recupero-aperture] nessun numero ammesso utilizzabile (HIGH, fuori pausa, tetto > 0, template spedibile): nessun invio');
      report.saltate.nessun_numero = (report.saltate.nessun_numero ?? 0) + 1;
      continue;
    }

    const numeroPrima = c.wa_number;
    if (soloNum(numeroPrima) !== soloNum(numero)) {
      const ok = await deps.riassegnaNumero(c.id, numero);
      if (!ok) { await saltata(c, 'riassegnazione_fallita', { numero }); continue; }
    }

    const r = await deps.invia({ ...c, wa_number: numero }, numero);
    if (r.configMancante) {
      await saltata(c, 'config_mancante', { numero });
      perGiro = 0;
      continue;
    }
    if (!r.ok) {
      await saltata(c, r.capped ? 'frequency_cap' : 'invio_fallito', { numero, error: r.error ?? null });
      continue;
    }
    report.inviate++;
    residuo--;
    perGiro--;
    const voce = numeri.find((x) => x.numero === numero);
    if (voce) voce.carico++;
    await deps.log(EVENTO_RECUPERO_INVIATA, 'info', {
      conversationId: c.id, crmLeadId: c.crm_lead_id, numero, numeroPrima,
      aiStartedAt: c.ai_started_at,
      oreDallArruolamento: c.ai_started_at ? Math.round((nowMs - Date.parse(c.ai_started_at)) / H) : null,
    }, `[recupero-aperture] conv ${c.id}: apertura recuperata da ${numero}${numeroPrima && soloNum(numeroPrima) !== soloNum(numero) ? ` (era ${numeroPrima})` : ''}`);
  }

  report.residuoOggi = residuo;
  await deps.log(EVENTO_RECUPERO_RUN, 'info', { ...report, tetto: cfg.tetto, giaOggi },
    `[recupero-aperture] run: ${report.inviate} inviate, ${report.restituite} restituite, ${report.inCoda} in coda, residuo oggi ${residuo}`);
  return report;
}
