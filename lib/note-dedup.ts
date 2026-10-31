import { createHash } from 'node:crypto';

/** Impronta stabile di una nota CRM: serve a riconoscere che stiamo per
 * rimandare esattamente la stessa nota gia inviata su questa conversazione. */
export function noteFingerprint(note: string): string {
  const normalizzata = note.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalizzata).digest('hex').slice(0, 16);
}

/**
 * Replica la chiave di dedup del CRM (il meccanismo è descritto per esteso nel
 * commento sopra `neutralizzaMarcatoreMotivo` in `lib/bot-outcome.ts`, da leggere prima
 * di toccare questa funzione): il testo fino a "motivo:" se quella sequenza compare da
 * qualche parte (substring nudo, case-insensitive, nessun confine di parola — il
 * parser del CRM non ne ha), altrimenti il testo fino al primo punto seguito da uno
 * spazio. Se non c'è nessuno dei due, la chiave è l'intera nota: non c'è niente su cui
 * il loro parser possa tagliare.
 */
export function crmDedupKey(note: string): string {
  const idxMotivo = note.toLowerCase().indexOf('motivo:');
  if (idxMotivo !== -1) return note.slice(0, idxMotivo);
  const idxPunto = note.indexOf('. ');
  return idxPunto === -1 ? note : note.slice(0, idxPunto);
}

/** Una nota NOTA già mandata al CRM per lo stesso lead, nella finestra di dedup: la
 *  chiave che il CRM ne ha derivato e l'impronta del suo testo completo. */
export type NotaCrmPrecedente = { chiave: string; fingerprint: string };

export type DivergenzaChiave =
  | { note: string; chiave: string; irriducibile: false }
  | { note: string; chiave: string; irriducibile: true; collisione: NotaCrmPrecedente };

/**
 * Difesa "controllo esatto": a differenza della soglia di lunghezza in
 * `neutralizzaMarcatoreMotivo` — un proxy della specificità, che un preambolo lungo ma
 * generico supera restando comunque identico per fatti diversi — qui confrontiamo
 * direttamente la proprietà che ci interessa: le due note, noi, le abbiamo entrambe.
 *
 * Se la chiave della nota nuova coincide con quella di una nota già inviata allo stesso
 * lead (`notePrecedenti`, tipicamente filtrate dal chiamante agli ultimi 15 minuti — la
 * finestra di dedup del CRM) MA l'impronta del testo completo è diversa, sono due fatti
 * diversi che il CRM tratterebbe come lo stesso: la seconda campanella alle Conferme non
 * scatterebbe. Si sposta allora il primo punto prematuro (". " → " —", che non è più un
 * punto: lo stesso meccanismo di `neutralizzaMarcatoreMotivo`) e si ricalcola, finché la
 * chiave diverge o non ci sono più punti da spostare (tetto di iterazioni incluso).
 *
 * Se invece la chiave coincide E l'impronta è la stessa, è lo stesso fatto re-inviato:
 * le chiavi DEVONO restare uguali, è così che il CRM lo riconosce come re-invio — quel
 * caso non è una collisione, e la funzione non tocca nulla.
 */
export function divergiChiaveDaNotePrecedenti(
  note: string,
  fingerprint: string,
  notePrecedenti: readonly NotaCrmPrecedente[],
): DivergenzaChiave {
  const MAX_ITERAZIONI = 20;
  let out = note;
  for (let i = 0; i < MAX_ITERAZIONI; i++) {
    const chiave = crmDedupKey(out);
    const collisione = notePrecedenti.find((p) => p.chiave === chiave && p.fingerprint !== fingerprint);
    if (!collisione) return { note: out, chiave, irriducibile: false };
    const idxPunto = out.indexOf('. ');
    if (idxPunto === -1) return { note: out, chiave, irriducibile: true, collisione };
    out = `${out.slice(0, idxPunto)} —${out.slice(idxPunto + 1)}`;
  }
  const chiaveFinale = crmDedupKey(out);
  const collisioneFinale = notePrecedenti.find((p) => p.chiave === chiaveFinale && p.fingerprint !== fingerprint);
  return collisioneFinale
    ? { note: out, chiave: chiaveFinale, irriducibile: true, collisione: collisioneFinale }
    : { note: out, chiave: chiaveFinale, irriducibile: false };
}

/** Etichette che hanno una regola loro e restano fuori da quella "una per tipo":
 *  «IL BOT HA RIPRESO LA CHAT» (una ogni 6 ore in `lib/bot-riscritto.ts`) e la call
 *  fissata dal bot che il CRM ha rifiutato con 403 (`buildAppuntamentoRifiutatoNote`). */
const ETICHETTE_ESCLUSE = new Set(['IL BOT HA RIPRESO LA CHAT', 'CALL FISSATA DAL BOT']);

/**
 * Il TIPO di una nota al CRM, per la regola "al massimo una nota per tipo per
 * conversazione ogni 2 ore" (PO, 31/10/2026). Il tipo è l'etichetta in testa, la parte
 * prima di " — " scritta tutta in maiuscolo (SPOSTAMENTO CHIESTO, DISDETTA, DA
 * RICHIAMARE, RICONFERMA...). Per gli SPOSTAMENTO conta anche la data chiesta dal lead:
 * chiedere giovedì e poi venerdì sono due fatti, e la seconda nota deve passare.
 *
 * `null` = la regola non si applica: niente etichetta (note libere, «Riscaldamento – ...»,
 * secondo recapito), etichetta non in maiuscolo, o etichetta esclusa.
 *
 * Funziona anche sulla chiave di dedup del CRM (`crmDedupKey`, la prima frase): la data
 * di uno SPOSTAMENTO CHIESTO sta nella prima frase.
 */
export function tipoNota(note: string): string | null {
  const idx = note.indexOf(' — ');
  if (idx <= 0) return null;
  const etichetta = note.slice(0, idx).trim();
  if (!etichetta || etichetta !== etichetta.toUpperCase() || !/[A-Z]/.test(etichetta)) return null;
  if (ETICHETTE_ESCLUSE.has(etichetta)) return null;
  if (!etichetta.startsWith('SPOSTAMENTO')) return etichetta;
  // "spostare a giovedì 29 ottobre alle 15:00." (SPOSTAMENTO CHIESTO) oppure
  // "spostare la call (giovedì 29 ottobre alle 15:00) ma" (SPOSTAMENTO NON REGISTRATO).
  const data = /spostare (?:a |la call \()([^.)]+)/.exec(note)?.[1]?.trim() ?? '';
  return `${etichetta}|${data}`;
}

/** Le parole del lead citate nella nota (`Parole del lead: "..."` o fra « »), se ci sono. */
export function paroleLeadDallaNota(note: string): string | null {
  const m = /Parole del lead: "([\s\S]*?)"\.?\s*$/.exec(note) ?? /«([\s\S]*?)»/.exec(note);
  return m ? m[1] : null;
}
