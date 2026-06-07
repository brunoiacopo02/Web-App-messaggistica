import { toE164 } from './phone';
import type { AcApiContact } from './ac-api';

export type PlannedSend = { contact: AcApiContact; phone: string };

export type BatchPlan = {
  toSend: PlannedSend[];
  invalidPhone: AcApiContact[];
  alreadySent: PlannedSend[];
  duplicates: PlannedSend[];
};

/**
 * Pianifica un invio batch a partire dai contatti AC e dall'insieme dei telefoni
 * già contattati per quella campagna (idempotenza). Funzione pura → testabile.
 *
 * - invalidPhone: telefono mancante o non normalizzabile in E.164
 * - alreadySent: telefono valido ma già contattato (skip)
 * - duplicates: stesso telefono presente più volte nella lista (inviato una sola volta)
 * - toSend: i destinatari effettivi
 */
export function planBatch(contacts: AcApiContact[], sentPhones: Set<string>): BatchPlan {
  const toSend: PlannedSend[] = [];
  const invalidPhone: AcApiContact[] = [];
  const alreadySent: PlannedSend[] = [];
  const duplicates: PlannedSend[] = [];
  const seen = new Set<string>();

  for (const contact of contacts) {
    const phone = toE164(contact.phone);
    if (!phone) {
      invalidPhone.push(contact);
      continue;
    }
    if (sentPhones.has(phone)) {
      alreadySent.push({ contact, phone });
      continue;
    }
    if (seen.has(phone)) {
      duplicates.push({ contact, phone });
      continue;
    }
    seen.add(phone);
    toSend.push({ contact, phone });
  }

  return { toSend, invalidPhone, alreadySent, duplicates };
}
