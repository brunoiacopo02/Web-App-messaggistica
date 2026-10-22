import { firstNameOf } from './name';
import { giornoRoma, oraRoma, romeHour, sameInstant } from './rome-time';

/**
 * Recap in una sola bolla per il lead prenotato da un GDO: data della videochiamata,
 * chiamata di preselezione di Noemi, video da guardare. Qui solo testi e regole di
 * decisione, senza I/O: l'invio sta altrove.
 */

/** Come in `gdo-context-note`: sotto le 15 Noemi non c'è ancora, si chiama il giorno prima. */
const SOGLIA_STESSO_GIORNO = 15;
/** Sotto questo anticipo il recap non serve più: la call è troppo vicina. */
const ANTICIPO_MIN_MS = 60 * 60_000;
/** Finestra di 24h di WhatsApp dall'ultimo messaggio del lead. */
const FINESTRA_MS = 24 * 3600_000;

export type RecapTipo = 'completo' | 'senza-video' | 'spostamento';
export type RecapOccasione = 'turno-video' | 'registrato' | 'spostato';

/** "giovedì 22 nel pomeriggio" oppure "venerdì 23, qualche ora prima". */
export function quandoNoemi(call: Date): string {
  if (romeHour(call) < SOGLIA_STESSO_GIORNO) {
    return `${giornoRoma(new Date(call.getTime() - 24 * 3600_000))} nel pomeriggio`;
  }
  return `${giornoRoma(call)}, qualche ora prima`;
}

function saluto(nome: string | null): string {
  const n = firstNameOf(nome);
  return n ? `Ciao ${n}` : 'Ciao';
}

export function gdoRecapText(i: { nome: string | null; call: Date; videoLink: string | null }): string {
  const righe = [
    `${saluto(i.nome)}, ti riassumo tutto 👇`,
    `La tua videochiamata è *${giornoRoma(i.call)} alle ${oraRoma(i.call)}*. A quell'ora devi essere libero.`,
    `*Ti chiama Noemi, una nostra collega, ${quandoNoemi(i.call)}* da un numero di cellulare. Sono 5-10 minuti: rispondi, perché se non rispondi la videochiamata non è confermata.`,
  ];
  if (i.videoLink) {
    righe.push(
      `*Prima della videochiamata guarda questo video*, dura 20 minuti 👉 ${i.videoLink}`,
      "Quando l'hai visto scrivimi FATTO qui",
    );
  } else {
    righe.push("Il video te l'ho mandato qui sopra: guardalo prima della videochiamata e poi scrivimi FATTO qui");
  }
  return righe.join('\n');
}

export function gdoSpostamentoText(i: { nome: string | null; call: Date }): string {
  return `${saluto(i.nome)}, la tua videochiamata ora è *${giornoRoma(i.call)} alle ${oraRoma(i.call)}*. A quell'ora devi essere libero.`;
}

export interface RecapInput {
  enabled: boolean;
  occasione: RecapOccasione;
  gdoAgendaAt: string | null;
  botOutcome: string | null;
  appuntamentoAt: string | null;
  recapForAt: string | null;
  videoSentAt: string | null;
  lastInboundAtMs: number | null;
  aiPausedAt: string | null;
  cancelRequestedAt: string | null;
  nowMs: number;
}

/** Quale recap mandare adesso, o `null` se nessuno. */
export function decideGdoRecap(i: RecapInput): RecapTipo | null {
  if (!i.enabled || !i.gdoAgendaAt || i.botOutcome === 'APPUNTAMENTO') return null;
  if (i.aiPausedAt || i.cancelRequestedAt) return null;
  if (!i.appuntamentoAt) return null;
  const callMs = Date.parse(i.appuntamentoAt);
  if (Number.isNaN(callMs) || callMs - i.nowMs < ANTICIPO_MIN_MS) return null;
  if (i.lastInboundAtMs === null || i.nowMs - i.lastInboundAtMs > FINESTRA_MS) return null;
  // Già riassunto per questa stessa call.
  if (sameInstant(i.recapForAt, i.appuntamentoAt)) return null;

  switch (i.occasione) {
    case 'turno-video':
      return 'completo';
    case 'registrato':
      // Senza video già mandato il recap uscirà insieme al video.
      return i.videoSentAt ? 'senza-video' : null;
    case 'spostato':
      if (i.recapForAt) return 'spostamento';
      return i.videoSentAt ? 'senza-video' : null;
  }
}
