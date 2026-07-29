import { createHash } from 'node:crypto';

/** Impronta stabile di una nota CRM: serve a riconoscere che stiamo per
 * rimandare esattamente la stessa nota gia inviata su questa conversazione. */
export function noteFingerprint(note: string): string {
  const normalizzata = note.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalizzata).digest('hex').slice(0, 16);
}
