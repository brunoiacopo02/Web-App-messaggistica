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
