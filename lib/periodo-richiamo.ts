// "Ci risentiamo a settembre" — il periodo del richiamo, con le parole del lead.
//
// Fino al contratto v1.5 ogni RICHIAMO pretendeva un timestamp ISO. Quando il lead
// diceva "a settembre" il bot non aveva modo di scriverlo e INVENTAVA un giorno e
// un'ora: su 26 RICHIAMO, 22 cadevano su ore tonde che nessun lead aveva mai
// pronunciato. Da v1.5 il CRM accetta `periodo`, testo libero.
//
// Questa funzione non parafrasa e non deduce: cerca un'espressione di tempo DENTRO le
// parole del lead e restituisce quella. Se non la trova torna `null`, e chi chiama
// resta sulla strada di prima (una NOTA senza data). Meglio nessun periodo che un
// periodo inventato: e' esattamente il bug che stiamo chiudendo.

const MESI =
  'gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre';

const NUMERI = "un|una|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|quindici|venti|\\d{1,3}";

/**
 * I pattern sono in ordine di precisione: il primo che aggancia vince. Ognuno cattura
 * la frase intera che verra' spedita, non il solo pezzo riconosciuto — al commerciale
 * serve leggere "tra due settimane", non "settimane".
 */
const PATTERN: RegExp[] = [
  // "a settembre", "in settembre", "per settembre", "a meta' settembre"
  new RegExp(`\\b(?:a|in|per|entro|verso)\\s+(?:(?:meta|meta'|inizio|fine)\\s+)?(?:${MESI})\\b`),
  // "a fine mese", "a inizio anno"
  /\b(?:a|per|entro|verso)\s+(?:fine|inizio|meta|meta')\s+(?:mese|anno|settimana)\b/,
  // "la settimana prossima", "la prossima settimana", "il mese prossimo"
  /\b(?:l[ao]|il)\s+(?:prossim[ao]\s+(?:settimana|mese|anno)|(?:settimana|mese|anno)\s+prossim[ao])\b/,
  // "settimana prossima" senza articolo
  /\b(?:settimana|mese|anno)\s+prossim[ao]\b/,
  // "tra due settimane", "fra 10 giorni"
  new RegExp(`\\b(?:tra|fra)\\s+(?:${NUMERI})\\s+(?:giorn[oi]|settiman[ae]|mes[ei])\\b`),
  // "dopo le ferie", "dopo l'estate", "dopo Natale"
  /\bdopo\s+(?:le\s+ferie|l'estate|le\s+vacanze|natale|pasqua|ferragosto|l'estate)\b/,
  // "in autunno", "in primavera"
  /\b(?:in|a|per)\s+(?:autunno|primavera|estate|inverno)\b/,
];

const senzaAccenti = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Piu' lungo di cosi' non e' piu' un periodo, e' un pezzo di conversazione. */
const MAX = 60;

/**
 * L'espressione di tempo nelle parole del lead, o `null` se non ce n'e' una.
 * Restituisce il testo COME LO HA SCRITTO IL LEAD (minuscolo e spazi normalizzati),
 * mai una riformulazione.
 */
export function estraiPeriodo(parole: string | null | undefined): string | null {
  if (!parole) return null;
  const testo = parole.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!testo) return null;
  // Il confronto ignora gli accenti (meta'/metà), ma si ritaglia dal testo originale
  // usando gli indici: cosi' le parole restituite restano quelle scritte davvero.
  const piatto = senzaAccenti(testo);

  let migliore: { start: number; end: number } | null = null;
  for (const re of PATTERN) {
    const m = piatto.match(re);
    if (!m || m.index === undefined) continue;
    // Fra piu' pattern che agganciano vince quello che compare prima nella frase:
    // e' l'ordine in cui il lead ha parlato.
    if (!migliore || m.index < migliore.start) {
      migliore = { start: m.index, end: m.index + m[0].length };
    }
  }
  if (!migliore) return null;
  const estratto = testo.slice(migliore.start, migliore.end).trim();
  return estratto.length > MAX ? estratto.slice(0, MAX).trim() : estratto;
}
