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

type RigaChat = { direction: string; body: string | null };

/**
 * Quale domanda c'era nel nostro ultimo messaggio prima del turno del lead (`idxTurno` =
 * primo inbound non risposto): 1, 2 o null. E' "il turno dopo una domanda inviata".
 */
export function domandaPrecedente(rows: readonly RigaChat[], idxTurno: number): 1 | 2 | null {
  for (let i = idxTurno - 1; i >= 0; i--) {
    if (rows[i].direction !== 'out') continue;
    const body = rows[i].body ?? '';
    if (body.includes(DOMANDA_2)) return 2;
    if (body.includes(DOMANDA_1)) return 1;
    return null;
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

/** Lunghezza massima delle parole del lead nella nota: oltre si taglia con "…". */
const MAX_TESTO_NOTA = 600;

/** La nota al CRM con le parole del lead, e se ha il ⚠️. */
export function notaRisposta(domanda: 1 | 2, testoLead: string): { nota: string; alert: boolean } {
  const pulito = testoLead.replace(/\s+/g, ' ').trim();
  const testo = pulito.length > MAX_TESTO_NOTA ? `${pulito.slice(0, MAX_TESTO_NOTA - 1)}…` : pulito;
  const alert = segnaleBrutto(pulito);
  const titolo = domanda === 1 ? 'obiettivo e perché adesso' : 'budget e chi decide';
  return { nota: `${alert ? '⚠️ ' : ''}Riscaldamento – ${titolo}: «${testo}»`, alert };
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
  return !parlaDiDisdireOSpostare(i.testo);
}
