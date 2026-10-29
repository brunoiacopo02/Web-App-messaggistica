/**
 * Riscaldamento del lead GDO: dopo il recap, due domande prima della call (cosa vuole e
 * perché adesso; 1.000-3.000 euro e chi decide). Le domande le scrive il CODICE, come il
 * recap: si accodano in fondo alla stessa bolla della risposta del modello, dopo una riga
 * vuota. Il modello non sa niente del riscaldamento e risponde come sempre.
 *
 * Prima (fino al 27/10/2026) le domande le scriveva il modello guidato da una nota nel
 * prompt, e il passo avanzava solo se rimetteva il tag `[RISCALDAMENTO:n]`: le regole fisse
 * del prompt ("fatto il video → ringrazia e chiudi") vincevano sulla nota, la domanda 1 e'
 * partita in 4 chat su 8 e la domanda 2 mai.
 *
 * Passi (`conversations.gdo_warmup_step`): null/0 = niente chiesto, 1 = domanda 1 inviata,
 * 2 = domanda 2 inviata, 3 = chiuso. Il passo avanza solo quando la bolla con la domanda e'
 * partita davvero.
 *
 * Il turno dopo una domanda, il testo del lead va SUBITO al CRM come nota (mai un esito,
 * mai un cambio di stato), con ⚠️ se contiene un segnale brutto.
 *
 * Lead che non risponde alla domanda (regola, 27/10/2026): una domanda non si ripete MAI.
 * Il messaggio del lead subito dopo una domanda e' la sua risposta: se e' una risposta vera
 * parte la nota, se non lo e' (disdetta, spostamento, solo "ok", solo "fatto", un esito)
 * non parte niente. In tutti e due i casi si passa oltre: dopo la domanda 1 la domanda 2
 * arriva al primo turno buono; dopo la domanda 2 il primo turno del lead chiude il
 * riscaldamento (passo 3). Chi smette di scrivere non riceve solleciti.
 */

/** Sotto le 3 ore dalla call non si fanno domande: il lead deve solo presentarsi. */
const MIN_ANTICIPO_MS = 3 * 3600_000;

/** Passo raggiunto a riscaldamento chiuso. */
export const RISCALDAMENTO_CHIUSO = 3;

/** Domanda 1: obiettivo e perché adesso. Regola 6 "SCRIVI FACILE": frasi corte, niente gergo. */
export const DOMANDA_1 =
  'Per preparare bene la tua videochiamata ti faccio una domanda veloce: cosa vuoi ottenere con questo percorso? E perché proprio adesso?';

/** Domanda 2: la cifra (mai rate in numeri) e chi decide. Chiusura data per scontata. */
export const DOMANDA_2 =
  'Ultima domanda: il percorso va da 1.000 a 3.000 euro e si può pagare anche a rate. Alla videochiamata decidi tu o insieme a qualcuno?';

export interface RiscaldamentoInput {
  /** `GDO_WARMUP_ENABLED === '1'`. */
  enabled: boolean;
  /** `gdo_warmup_step`: null = mai iniziato, 1-2 = domanda inviata, 3 = chiuso. */
  step: number | null;
  /** `gdo_recap_for_at`: senza recap mandato non si parte. */
  recapForAt: string | null;
  /** Il recap esce proprio in questo turno: le domande partono dal prossimo. */
  recapInQuestoTurno: boolean;
  /** Ora della call fissata dal GDO. */
  appuntamentoAt: string | null;
  /** In questo turno il modello deve spiegare Noemi: una cosa alla volta. */
  serveNoemi: boolean;
  nowMs: number;
}

/**
 * Perché la domanda del turno puo' partire (`in_prompt`: nome storico, tenuto per non
 * rompere le query sull'evento `gdo_warmup_nota`) o tace.
 */
export type MotivoRiscaldamento =
  | 'in_prompt'
  | 'spento'
  | 'cancel'
  | 'chiuso'
  | 'no_recap'
  | 'recap_turno'
  | 'noemi'
  | 'meno_3h'
  | 'non_postino';

export interface MotivoRiscaldamentoInput extends RiscaldamentoInput {
  /** Il turno e' del postino (agenda GDO e funnel Professioni che non vince). Default true. */
  postino?: boolean;
  /** Il lead ha chiesto di annullare. Default false. */
  cancelRequested?: boolean;
}

export function motivoRiscaldamento(i: MotivoRiscaldamentoInput): MotivoRiscaldamento {
  if (!i.enabled) return 'spento';
  if (i.postino === false) return 'non_postino';
  if (i.cancelRequested) return 'cancel';
  if ((i.step ?? 0) >= RISCALDAMENTO_CHIUSO) return 'chiuso';
  if (!i.recapForAt) return 'no_recap';
  if (i.recapInQuestoTurno) return 'recap_turno';
  if (i.serveNoemi) return 'noemi';
  const callMs = i.appuntamentoAt ? Date.parse(i.appuntamentoAt) : NaN;
  if (Number.isNaN(callMs) || callMs - i.nowMs < MIN_ANTICIPO_MS) return 'meno_3h';
  return 'in_prompt';
}

/** Motivi per cui il riscaldamento non fa NIENTE: niente domanda, niente nota, passo fermo. */
export function riscaldamentoInerte(m: MotivoRiscaldamento | null): boolean {
  return m === null || m === 'spento' || m === 'non_postino' || m === 'cancel';
}

/** Cosa e' successo nel turno: ognuna di queste cose da sola blocca la domanda. */
export interface TurnoRiscaldamento {
  /** Il modello ha dato un esito (anche solo nota sul postino) o ha fissato. */
  esito: boolean;
  /** Passaggio a una persona. */
  passaggio: boolean;
  /** Il lead parla di disdire o spostare (vedi `parlaDiDisdireOSpostare`). */
  disdettaOSpostamento: boolean;
  /** Il testo e' stato rigenerato per spiegare Noemi. */
  spiegaNoemi: boolean;
  /** Il testo che parte e' un testo fisso di ripiego o di errore, non la risposta del modello. */
  fallback: boolean;
  /** Il video o il recap esce in questo turno. */
  videoInUscita: boolean;
  /** La risposta del modello che parte (gia' pulita dai tag). */
  rispostaModello: string;
  /** Il lead parla d'altro (problema tecnico): la domanda di prima resta in attesa. Default false. */
  fuoriTema?: boolean;
  /** Il messaggio e' arrivato a ridosso della domanda di prima: il lead stava ancora scrivendo. Default false. */
  continuazione?: boolean;
}

export type DomandaDecisa =
  | { domanda: { testo: string; step: 1 | 2 }; salto: null }
  | { domanda: null; salto: string };

/**
 * La domanda da accodare in questo turno, o il motivo per cui salta. La domanda 1 al
 * passo 0, la 2 al passo 1. Se il modello ha gia' fatto una domanda nella sua risposta la
 * nostra aspetta il turno dopo: mai due domande nella stessa bolla (regola 4 del prompt).
 */
export function decidiDomanda(motivo: MotivoRiscaldamento | null, step: number | null, t: TurnoRiscaldamento): DomandaDecisa {
  if (motivo !== 'in_prompt') return { domanda: null, salto: motivo ?? 'spento' };
  const s = step ?? 0;
  if (s >= 2) return { domanda: null, salto: 'gia_fatte' };
  if (t.esito) return { domanda: null, salto: 'esito' };
  if (t.passaggio) return { domanda: null, salto: 'passaggio' };
  if (t.disdettaOSpostamento) return { domanda: null, salto: 'disdetta_spostamento' };
  if (t.continuazione) return { domanda: null, salto: 'continuazione' };
  if (t.fuoriTema) return { domanda: null, salto: 'fuori_tema' };
  if (t.spiegaNoemi) return { domanda: null, salto: 'noemi' };
  if (t.fallback) return { domanda: null, salto: 'fallback' };
  if (t.videoInUscita) return { domanda: null, salto: 'video_in_uscita' };
  const risposta = t.rispostaModello.trim();
  if (!risposta) return { domanda: null, salto: 'risposta_vuota' };
  if (risposta.includes('?')) return { domanda: null, salto: 'modello_ha_chiesto' };
  return s === 0
    ? { domanda: { testo: DOMANDA_1, step: 1 }, salto: null }
    : { domanda: { testo: DOMANDA_2, step: 2 }, salto: null };
}

/**
 * Accoda la domanda in fondo all'ULTIMA bolla della risposta, dopo una riga vuota: una
 * bolla per risposta, mai una bolla in piu'. Senza bolle non si accoda niente (una domanda
 * da sola non parte mai). Torna le bolle nuove e la bolla che contiene la domanda.
 */
export function accodaDomanda(parts: readonly string[], domanda: string): { parts: string[]; bolla: string | null } {
  if (parts.length === 0) return { parts: [], bolla: null };
  const ultima = parts[parts.length - 1];
  if (parts.some((p) => p.includes(domanda))) return { parts: [...parts], bolla: null }; // mai due volte
  const bolla = `${ultima}\n\n${domanda}`;
  return { parts: [...parts.slice(0, -1), bolla], bolla };
}

type RigaChat = { direction: string; body: string | null; created_at?: string };

/**
 * Sotto questo tempo dalla bolla con la domanda il messaggio del lead NON e' la risposta:
 * lo stava gia' scrivendo prima di leggerla (conv 28813, 29/10/2026: la seconda bolla
 * della risposta alla domanda 1 arriva 1,4 secondi dopo la domanda 2 e finiva nella nota
 * "budget e chi decide", mentre la risposta vera arrivava due minuti dopo e si perdeva).
 */
export const FINESTRA_CONTINUAZIONE_MS = 30_000;

/** Turni del lead entro cui una domanda resta in attesa di risposta (contando quello attuale). */
export const MAX_TURNI_RISPOSTA = 3;

export type DomandaInAttesa = {
  /** La domanda a cui il turno del lead puo' rispondere. */
  step: 1 | 2;
  /** Il messaggio e' arrivato a ridosso della domanda: e' il seguito del discorso di prima. */
  continuazione: boolean;
};

/**
 * La domanda del riscaldamento ancora in attesa di risposta all'inizio del turno del lead
 * (`idxTurno` = primo inbound non risposto), o null.
 *
 * Prima (fino al 29/10/2026) valeva solo se la domanda stava nella NOSTRA ULTIMA bolla:
 * quando il modello rifaceva la domanda con parole sue (conv 26100) la bolla dopo non la
 * conteneva piu' e la risposta vera si perdeva. Ora la domanda resta in attesa finche':
 * - il passo e' ancora quello della domanda (`step` 1 o 2);
 * - la risposta non e' gia' stata girata al CRM (`giaNotata`);
 * - non sono passati piu' di MAX_TURNI_RISPOSTA turni del lead dalla domanda.
 */
export function domandaInAttesa(
  rows: readonly RigaChat[],
  idxTurno: number,
  step: number | null,
  giaNotata: boolean,
): DomandaInAttesa | null {
  if (step !== 1 && step !== 2) return null;
  if (giaNotata || idxTurno < 0 || idxTurno >= rows.length) return null;
  const testo = step === 2 ? DOMANDA_2 : DOMANDA_1;
  let turni = 1; // il turno attuale
  for (let i = idxTurno - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.direction === 'out') {
      if (!(r.body ?? '').includes(testo)) continue;
      const tDomanda = Date.parse(r.created_at ?? '');
      const tLead = Date.parse(rows[idxTurno].created_at ?? '');
      const continuazione = Number.isFinite(tDomanda) && Number.isFinite(tLead) && tLead - tDomanda < FINESTRA_CONTINUAZIONE_MS;
      return { step, continuazione };
    }
    // Inizio di un turno del lead (un suo messaggio subito dopo un nostro).
    if (i > 0 && rows[i - 1].direction === 'out') {
      turni++;
      if (turni > MAX_TURNI_RISPOSTA) return null;
    }
  }
  return null;
}

const normalizza = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Il lead parla di disdire o spostare la call: in quel turno niente domande e niente nota. */
const DISDETTA_SPOSTAMENTO =
  /\b(spost\w*|rimand\w*|rinvi\w*|annull\w*|disdi\w*|disdett\w*|non posso (venire|esserci|partecipare|farla|farcela)|non ci sono|imprevist\w*)\b/;

export function parlaDiDisdireOSpostare(testo: string): boolean {
  return DISDETTA_SPOSTAMENTO.test(normalizza(testo));
}

/**
 * Segnali brutti nella risposta: la nota comincia con ⚠️. Lista piccola e chiara, a parole
 * intere sul testo minuscolo e senza accenti: soldi (anche "non ho soldi"), non posso
 * permettermi, costa, non mi interessa, non ricordo, curiosità, devo chiedere a.
 */
export const SEGNALI_BRUTTI: readonly RegExp[] = [
  /\bsoldi\b/,
  /\bnon (posso|me lo posso|me la posso) permetter\w*\b/,
  /\bcosta\b/,
  /\bnon mi interessa\b/,
  /\bnon (mi )?ricordo\b/,
  /\bcuriosita\b/,
  /\bdevo chiedere a\b/,
];

export function segnaleBrutto(testo: string): boolean {
  const t = normalizza(testo);
  return SEGNALI_BRUTTI.some((re) => re.test(t));
}

/**
 * Il messaggio parla d'altro: un problema tecnico (video, link, banner, browser…), non
 * la risposta alla domanda (conv 29034, 29/10/2026: «Non funziona, mi esce ancora anche
 * da Chrome» era finito nella nota "obiettivo e perche' adesso"). Si guarda solo un
 * messaggio corto e senza parole da risposta: chi risponde e cita il video resta una
 * risposta. In quel turno la domanda resta in attesa e la successiva non parte.
 */
const TECNICO =
  /\b(video|link|banner|bunner|chrome|safari|browser|app|account|errore|schermata|pagina|wifi|non funziona\w*|non si apre|non (si )?carica|non (riesco a |posso )?(vedere|vederlo|aprire|aprirlo|entrare|accedere))\b/;
const PAROLE_DA_RISPOSTA =
  /\b(vorrei|voglio|lavor\w*|cambiare|obiettiv\w*|futuro|perche|decid\w*|soldi|euro|rate|budget|insieme|moglie|marito|fidanzat\w*|famiglia|genitori|madre|padre|mamma|papa)\b/;
const MAX_PAROLE_FUORI_TEMA = 25;

export function parlaDAltro(testo: string): boolean {
  const t = normalizza(testo);
  if (!t || !TECNICO.test(t)) return false;
  if (t.split(' ').length > MAX_PAROLE_FUORI_TEMA) return false;
  return !PAROLE_DA_RISPOSTA.test(t);
}

/**
 * Con chi decide il lead, se non decide da solo (PO 29/10/2026: "⚠️ Decide con: moglie"
 * nella nota alle Conferme). Solo l'avviso: nessun altro cambiamento di flusso.
 */
const DECIDE_CON: readonly { chi: string; re: RegExp }[] = [
  { chi: 'moglie', re: /\bmoglie\b/ },
  { chi: 'marito', re: /\bmarito\b/ },
  { chi: 'fidanzato/a', re: /\bfidanzat[oaie]\b/ },
  { chi: 'compagno/a', re: /\b(mio|mia|il mio|la mia) compagn[oa]\b/ },
  { chi: 'ragazzo/a', re: /\b(mio|mia|il mio|la mia) ragazz[oa]\b/ },
  { chi: 'madre', re: /\b(madre|mamma)\b/ },
  { chi: 'padre', re: /\b(padre|papa|babbo)\b/ },
  { chi: 'genitori', re: /\bgenitori\b/ },
  { chi: 'famiglia', re: /\b(famiglia|familiari)\b/ },
  { chi: 'fratello/sorella', re: /\b(mio fratello|mia sorella)\b/ },
  { chi: 'socio', re: /\b(mio socio|mia socia)\b/ },
];
/** "ne parlo con…", "devo sentire…", "insieme a…" senza un nome della lista sopra. */
const DECIDE_CON_GENERICO =
  /\b(ne (devo )?parl\w* con|devo (sentire|chiedere|confrontarmi|parlarne)|insieme a|insieme con|con qualcuno|non decido da sol[oa])\b/;

export function decideCon(testo: string): string[] {
  const t = normalizza(testo);
  if (!t) return [];
  const chi = DECIDE_CON.filter((d) => d.re.test(t)).map((d) => d.chi);
  if (chi.length > 0) return chi;
  return DECIDE_CON_GENERICO.test(t) ? ['qualcun altro'] : [];
}

/** Lunghezza massima delle parole del lead nella nota: oltre si taglia con "…". */
const MAX_TESTO_NOTA = 600;

/**
 * La nota al CRM con le parole del lead, e se ha il ⚠️. Se il lead decide con qualcun
 * altro la nota comincia con "⚠️ Decide con: …". `continua`: il seguito della risposta
 * alla domanda, arrivato a ridosso della domanda dopo.
 */
export function notaRisposta(domanda: 1 | 2, testoLead: string, opts: { continua?: boolean } = {}): { nota: string; alert: boolean } {
  const pulito = testoLead.replace(/\s+/g, ' ').trim();
  const testo = pulito.length > MAX_TESTO_NOTA ? `${pulito.slice(0, MAX_TESTO_NOTA - 1)}…` : pulito;
  const conChi = decideCon(pulito);
  const brutto = segnaleBrutto(pulito);
  const titolo = (domanda === 1 ? 'obiettivo e perché adesso' : 'budget e chi decide') + (opts.continua ? ' (continua)' : '');
  const avviso = conChi.length > 0 ? `⚠️ Decide con: ${conChi.join(', ')} — ` : brutto ? '⚠️ ' : '';
  return { nota: `${avviso}Riscaldamento – ${titolo}: «${testo}»`, alert: brutto || conChi.length > 0 };
}

/**
 * Il messaggio del lead e' una risposta da girare al CRM? No se il turno ha un esito o un
 * passaggio, se parla di disdire o spostare, se e' solo una presa d'atto ("ok", emoji,
 * media) o solo la conferma del video ("fatto").
 */
export function eRispostaDaNotare(i: {
  testo: string;
  esito: boolean;
  passaggio: boolean;
  soloPresaDAtto: boolean;
  soloConfermaVideo: boolean;
}): boolean {
  if (!i.testo.trim()) return false;
  if (i.esito || i.passaggio || i.soloPresaDAtto || i.soloConfermaVideo) return false;
  if (parlaDAltro(i.testo)) return false;
  return !parlaDiDisdireOSpostare(i.testo);
}
