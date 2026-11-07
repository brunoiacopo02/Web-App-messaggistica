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
 *   PIU' VECCHIA alla piu' recente (PO 06/11 sera: si salvano prima quelle che stanno per
 *   superare i 5 giorni).
 * - Solo 09:30-20:30 Roma, al massimo RECUPERO_MAX_PER_GIRO per giro di cron, fino a
 *   `RECUPERO_APERTURE_GIORNALIERE` al giorno (assente/0 = spento). Il conteggio e' a
 *   parte (evento `recupero_apertura_inviata`) e NON scrive `mittente_apertura`: non ruba
 *   posti ai freschi nei tetti per numero.
 * - Numeri: solo quelli di `RECUPERO_NUMERI`, mai 8061 ne' 3199 (ne' il primario), HIGH
 *   e fuori pausa, con tetto > 0 in `tetti_numeri`, template spedibile. Vince il meno
 *   carico oggi (aperture di Mario + recuperi), senza superare il tetto di recupero del
 *   numero (`RECUPERO_TETTI_NUMERO`, es. "+393522018718:25,+393522070047:20"; un numero
 *   non elencato ha solo il tetto totale, uno a 0 non recupera). Un numero elencato li' con
 *   tetto > 0 e qualita' UNKNOWN mai valutata (nessuna lettura diversa da UNKNOWN) e'
 *   ammesso: sono i numeri nuovi, in prova con pochi invii. MEDIUM/LOW/pausa mai. Prima dell'invio la chat passa a quel
 *   numero: lecito, nessun messaggio e' mai partito, non c'e' un thread da spezzare.
 * - Oltre RECUPERO_MAX_GIORNI_ASSOLUTO (= RECUPERO_MAX_GIORNI, 5: deciso dal PO il 07/11
 *   dopo una prova a 14 la mattina stessa) la chat torna
 *   al CRM come lead mai contattato, con lo stesso esito della rete
 *   (`esitoAperturaMaiPartita`), evento `recupero_apertura_restituita`.
 * - Prima di ogni invio (e di ogni restituzione) si guarda la copia locale del CRM: un
 *   lead che il CRM ha gia' lavorato (stato diverso da NEW, appuntamento, richiamo, esito
 *   Conferme) non riceve un'apertura a freddo. Prima di ogni invio, un telefono che su
 *   qualunque chat ha gia' avuto un errore definitivo di destinatario (63024 = non e' su
 *   WhatsApp, 63003, 21211, 21614) non si riprova. 63016 (fuori finestra 24h) non dice
 *   niente del numero: non esclude.
 * - Stesso template e stesso percorso dell'apertura differita (lib/apertura-mario-invio.ts).
 */
import { APERTURA_MAI_PARTITA_DAL_MS, romeMinutes } from './sequence';

const H = 3600_000;
const D = 24 * H;

/** La coda e' fatta delle chat che la rete esclude: arruolate prima di questo istante. */
export const RECUPERO_FINO_AL_MS = APERTURA_MAI_PARTITA_DAL_MS;
/** Limite basso della coda: l'incidente comincia il 03/11. Le chat piu' vecchie non si toccano. */
export const RECUPERO_CODA_DAL_MS = Date.parse('2026-11-01T00:00:00Z');
/** Entro questa eta' (dall'arruolamento) un lead e' "recente": passa per primo. */
export const RECUPERO_MAX_GIORNI = 5;
/** Oltre questa eta' non si apre piu': si restituisce al CRM (PO 07/11 pomeriggio: resta a 5, i follow-up stanno comunque dentro i 5 giorni). */
export const RECUPERO_MAX_GIORNI_ASSOLUTO = RECUPERO_MAX_GIORNI;
/** Errori Twilio che dicono che il telefono non e' raggiungibile su WhatsApp, per sempre. */
export const ERRORI_DESTINATARIO_DEFINITIVI = [63024, 63003, 21211, 21614];
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

export type ConfigRecupero = {
  tetto: number;
  numeri: string[];
  maxPerGiro: number;
  /** Tetto giornaliero di recupero per numero (`whatsapp:+39...`). Assente = solo il totale. */
  tettiNumero: Map<string, number>;
};

/** "+39...:25,+39...:20" -> Map(`whatsapp:+39...` -> 25). Voci malformate o negative ignorate. */
export function parseTettiRecupero(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const voce of (raw ?? '').split(',')) {
    const i = voce.lastIndexOf(':');
    if (i <= 0) continue;
    const n = soloNum(voce.slice(0, i));
    const grezzo = voce.slice(i + 1).trim();
    const v = grezzo === '' ? NaN : Number(grezzo);
    if (!n || !/^\+\d{6,15}$/.test(n) || !Number.isInteger(v) || v < 0) continue;
    out.set(`whatsapp:${n}`, v);
  }
  return out;
}

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
  const tettiNumero = parseTettiRecupero(env.RECUPERO_TETTI_NUMERO);
  // Un numero col tetto di recupero a 0 non recupera: lo si toglie subito.
  const ammessi = numeri.filter((n) => tettiNumero.get(n) !== 0);
  return { tetto, numeri: ammessi, maxPerGiro: RECUPERO_MAX_PER_GIRO, tettiNumero };
}

export type QualitaLetta = { storico: Record<string, Record<string, string>>; pause: Record<string, unknown> } | null;

/**
 * Pura: la qualita' del numero ammette il recupero? HIGH (oggi, o ieri se oggi manca) e
 * fuori pausa, come per le aperture. In piu' (PO 06/11): UNKNOWN se il numero ha un tetto
 * di recupero > 0 e non e' MAI stato letto diverso da UNKNOWN (numero nuovo, in prova).
 * Stato illeggibile, pausa, MEDIUM, LOW, lettura vecchia = no.
 */
export function qualitaAmmessaRecupero(
  stato: QualitaLetta, numero: string, oggi: string, ieri: string, tettoRecupero: number | undefined,
): 'HIGH' | 'UNKNOWN_IN_PROVA' | null {
  if (!stato) return null;
  const n = soloNum(numero);
  if (stato.pause[n]) return null;
  const giorni = stato.storico[n] ?? {};
  const ultima = giorni[oggi] ?? giorni[ieri];
  if (ultima === 'HIGH') return 'HIGH';
  if (ultima === 'UNKNOWN' && (tettoRecupero ?? 0) > 0 && Object.values(giorni).every((q) => q === 'UNKNOWN')) {
    return 'UNKNOWN_IN_PROVA';
  }
  return null;
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
  | { azione: 'invia'; oltreCinqueGiorni: boolean }
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
  if (nowMs - arr > RECUPERO_MAX_GIORNI_ASSOLUTO * D) return { azione: 'restituisci' };
  if (!c.phone) return { azione: 'salta', motivo: 'senza_telefono' };
  return { azione: 'invia', oltreCinqueGiorni: nowMs - arr > RECUPERO_MAX_GIORNI * D };
}

/** La copia locale dello stato CRM (`crm_lead_status`) che serve qui. */
export type StatoCrmRecupero = {
  status: string | null;
  appointment_date: string | null;
  recall_at: string | null;
  conferme_outcome: string | null;
};

/**
 * Pura: il CRM ha gia' lavorato questo lead? Allora non gli si scrive a freddo (ne' lo si
 * restituisce: ce l'ha gia' una persona). Riga assente = nessun fatto noto = si scrive,
 * come in lib/stop-crm.ts.
 */
export function motivoLavoratoDalCrm(s: StatoCrmRecupero | null | undefined): string | null {
  if (!s) return null;
  if (s.appointment_date) return 'crm_appuntamento';
  if (s.conferme_outcome) return 'crm_esito_conferme';
  if (s.recall_at) return 'crm_richiamo';
  const st = (s.status ?? '').trim().toUpperCase();
  if (st !== '' && st !== 'NEW') return `crm_${st.toLowerCase()}`;
  return null;
}

export type NumeroRecupero = {
  numero: string;
  /** Aperture di Mario + recuperi di oggi: decide chi e' il meno carico. */
  carico: number;
  /** Recuperi di oggi da questo numero. */
  recuperiOggi?: number;
  /** Tetto di recupero del numero; assente = nessun tetto per numero. */
  tettoRecupero?: number;
};

/** Pura: il numero meno carico fra quelli sotto il proprio tetto di recupero; a parita' l'ordine di `RECUPERO_NUMERI`. */
export function scegliNumeroRecupero(numeri: NumeroRecupero[]): string | null {
  const liberi = numeri
    .map((n, i) => ({ ...n, i }))
    .filter((n) => n.tettoRecupero === undefined || (n.recuperiOggi ?? 0) < n.tettoRecupero);
  if (liberi.length === 0) return null;
  liberi.sort((a, b) => (a.carico - b.carico) || (a.i - b.i));
  return liberi[0].numero;
}

/**
 * Pura: l'ordine della coda, a parita' l'id.
 * 1. Entro i 5 giorni, dalla piu' vecchia alla piu' recente (PO 06/11: si salvano prima
 *    quelle vicine ai 5 giorni; sono comunque le piu' fresche di tutta la coda).
 * 2. Oltre i 5 giorni, dalla piu' RECENTE alla piu' vecchia: li' non c'e' piu' una
 *    scadenza da battere e un lead perde valore col passare dei giorni (il 94% di chi
 *    compra lo fa entro 14 giorni), quindi il posto del giorno va a chi ne ha di piu'.
 * Senza arruolamento in fondo.
 */
export function ordinaCoda(coda: ChatCoda[], nowMs: number): ChatCoda[] {
  const limite = nowMs - RECUPERO_MAX_GIORNI * D;
  const t = (c: ChatCoda): number | null => {
    const v = c.ai_started_at ? Date.parse(c.ai_started_at) : NaN;
    return Number.isNaN(v) ? null : v;
  };
  const fascia = (c: ChatCoda) => {
    const v = t(c);
    return v === null ? 2 : v >= limite ? 0 : 1;
  };
  return [...coda].sort((a, b) => {
    const fa = fascia(a);
    const fb = fascia(b);
    if (fa !== fb) return fa - fb;
    const ta = t(a) ?? 0;
    const tb = t(b) ?? 0;
    return (fa === 1 ? tb - ta : ta - tb) || (a.id - b.id);
  });
}

export type EsitoInvio = { ok: boolean; capped?: boolean; error?: string };

export type DepsRecupero = {
  /** Recuperi gia' inviati oggi (giorno di Roma). null = conteggio fallito: niente invii. */
  contaInviateOggi: () => Promise<number | null>;
  /** La coda gia' filtrata sulle colonne (l'ordine lo rifa' `ordinaCoda`). */
  caricaCoda: () => Promise<ChatCoda[]>;
  /** Messaggi di sempre per chat. Una chat assente dalla mappa = nessun messaggio. null = lettura fallita. */
  contaMessaggi: (ids: number[]) => Promise<Map<number, ConteggioMessaggi> | null>;
  stopCrm: (crmLeadId: string | null) => Promise<string | null>;
  /** Il lead e' gia' in mano al CRM? Motivo (`crm_...`) o null. Lettura fallita = 'crm_illeggibile'. */
  lavoratoDalCrm: (crmLeadId: string | null) => Promise<string | null>;
  /** Il telefono ha gia' avuto un errore definitivo di destinatario? null = lettura fallita. */
  numeroNonWhatsapp: (phone: string) => Promise<boolean | null>;
  /** Numeri ammessi oggi, col carico; gli scarti finiscono nel riepilogo del run. */
  numeriUtilizzabili: () => Promise<{ ok: NumeroRecupero[]; scarti: { numero: string; motivo: string }[] }>;
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
  /** Di cui oltre i 5 giorni dall'arruolamento. */
  inviateOltreCinque: number;
  restituite: number;
  saltate: Record<string, number>;
  gia_aperte: number;
  inCoda: number;
  residuoOggi: number;
  scartiNumeri?: { numero: string; motivo: string }[];
};

export async function eseguiRecupero(cfg: ConfigRecupero, deps: DepsRecupero, nowMs: number): Promise<ReportRecupero> {
  const report: ReportRecupero = { inviate: 0, inviateOltreCinque: 0, restituite: 0, saltate: {}, gia_aperte: 0, inCoda: 0, residuoOggi: 0 };
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

  const coda = ordinaCoda(await deps.caricaCoda(), nowMs);
  const msgs = await deps.contaMessaggi(coda.map((c) => c.id));
  if (msgs === null) {
    await deps.log(EVENTO_RECUPERO_RUN, 'warn', { errore: 'lettura_messaggi_fallita' },
      '[recupero-aperture] lettura dei messaggi fallita: nessun invio');
    return report;
  }

  // I numeri si leggono solo se c'e' qualcosa da mandare.
  let numeri: NumeroRecupero[] | null = null;
  let senzaNumero = false;

  for (const c of coda) {
    const d = decidiChat(c, msgs.get(c.id) ?? { out: 0, in: 0 }, nowMs);
    if (d.azione === 'ignora') { if (d.motivo === 'gia_aperta') report.gia_aperte++; continue; }
    if (d.azione === 'salta') { await saltata(c, d.motivo); continue; }

    if (d.azione === 'restituisci') {
      if (report.restituite >= RECUPERO_MAX_RESTITUZIONI_PER_GIRO) continue;
      const stop = await deps.stopCrm(c.crm_lead_id);
      if (stop) { await saltata(c, `stop_crm_${stop}`); continue; }
      const lavorato = await deps.lavoratoDalCrm(c.crm_lead_id);
      if (lavorato) { await saltata(c, lavorato); continue; }
      const r = await deps.restituisci(c);
      if (r.sent) report.restituite++;
      await deps.log(EVENTO_RECUPERO_RESTITUITA, r.sent ? 'info' : 'warn', {
        conversationId: c.id, crmLeadId: c.crm_lead_id, aiStartedAt: c.ai_started_at,
        sent: r.sent, status: r.status ?? null, error: r.error ?? null,
      }, `[recupero-aperture] conv ${c.id}: oltre ${RECUPERO_MAX_GIORNI_ASSOLUTO} giorni senza apertura, restituita al CRM come mai contattata (${r.sent ? 'ok' : r.error ?? r.status ?? 'errore'})`);
      continue;
    }

    // d.azione === 'invia'
    report.inCoda++;
    if (residuo <= 0 || perGiro <= 0 || senzaNumero) continue;

    const stop = await deps.stopCrm(c.crm_lead_id);
    if (stop) { await saltata(c, `stop_crm_${stop}`); continue; }
    const lavorato = await deps.lavoratoDalCrm(c.crm_lead_id);
    if (lavorato) { await saltata(c, lavorato); continue; }
    const nonWa = await deps.numeroNonWhatsapp(c.phone as string);
    if (nonWa !== false) { await saltata(c, nonWa === null ? 'errori_illeggibili' : 'numero_non_whatsapp'); continue; }

    if (numeri === null) {
      const n = await deps.numeriUtilizzabili();
      numeri = n.ok;
      report.scartiNumeri = n.scarti;
    }
    const numero = scegliNumeroRecupero(numeri);
    if (!numero) {
      senzaNumero = true;
      await deps.log(EVENTO_RECUPERO_SALTATA, 'warn', {
        motivo: 'nessun_numero', scarti: report.scartiNumeri ?? [],
        aTetto: numeri.map((x) => ({ numero: x.numero, recuperiOggi: x.recuperiOggi ?? 0, tettoRecupero: x.tettoRecupero ?? null })),
      }, '[recupero-aperture] nessun numero ammesso sotto il proprio tetto di recupero (HIGH o UNKNOWN in prova, fuori pausa, tetto > 0, template spedibile): nessun altro invio');
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
    if (d.oltreCinqueGiorni) report.inviateOltreCinque++;
    residuo--;
    perGiro--;
    const voce = numeri.find((x) => x.numero === numero);
    if (voce) { voce.carico++; voce.recuperiOggi = (voce.recuperiOggi ?? 0) + 1; }
    await deps.log(EVENTO_RECUPERO_INVIATA, 'info', {
      conversationId: c.id, crmLeadId: c.crm_lead_id, numero, numeroPrima,
      aiStartedAt: c.ai_started_at,
      oltreCinqueGiorni: d.oltreCinqueGiorni,
      oreDallArruolamento: c.ai_started_at ? Math.round((nowMs - Date.parse(c.ai_started_at)) / H) : null,
    }, `[recupero-aperture] conv ${c.id}: apertura recuperata da ${numero}${numeroPrima && soloNum(numeroPrima) !== soloNum(numero) ? ` (era ${numeroPrima})` : ''}`);
  }

  report.residuoOggi = residuo;
  await deps.log(EVENTO_RECUPERO_RUN, 'info', { ...report, tetto: cfg.tetto, giaOggi },
    `[recupero-aperture] run: ${report.inviate} inviate, ${report.restituite} restituite, ${report.inCoda} in coda, residuo oggi ${residuo}`);
  return report;
}
