// Persona e aperture per-funnel (A/B) — modulo puro, nessun accesso a env/DB.
// Spec: docs/superpowers/specs/2026-07-24-apertura-marta-ab-design.md (§2: testi ESATTI).

import { templateName } from './name';

export type Persona = 'mario' | 'marta';
export type FunnelKey = 'corso10' | 'telegram' | 'jobsim' | 'other';

export const PERSONA_NAME: Record<Persona, string> = { mario: 'Mario', marta: 'Marta' };

/** Mappa il `crm_funnel` grezzo del CRM sulla chiave funnel. Case-insensitive, trim.
 * Funnel reali: 'CORSO 10 ORE', 'TELEGRAM', 'TELEGRAM-TK', 'JOB SIMULATOR'. Resto → other. */
export function normalizeFunnel(f: string | null | undefined): FunnelKey {
  const v = (f ?? '').trim().toUpperCase();
  if (v === 'CORSO 10 ORE') return 'corso10';
  if (v === 'TELEGRAM' || v === 'TELEGRAM-TK') return 'telegram';
  if (v === 'JOB SIMULATOR') return 'jobsim';
  return 'other';
}

/** Assegnazione A/B per parità di conversationId: dispari → variante 1, pari → variante 2. */
export function variantIndexFor(conversationId: number): 1 | 2 {
  return conversationId % 2 !== 0 ? 1 : 2;
}

const FUNNEL_LETTER: Record<FunnelKey, 'C' | 'T' | 'J'> = {
  corso10: 'C',
  telegram: 'T',
  jobsim: 'J',
  other: 'C', // funnel non riconosciuto → aperture di CORSO 10 ORE
};

/** Nome della env che contiene il Content SID dell'apertura (es. OPENING_SID_C1). */
export function openingEnvKey(funnel: FunnelKey, variant: 1 | 2): string {
  return `OPENING_SID_${FUNNEL_LETTER[funnel]}${variant}`;
}

// Testi ESATTI della spec §2; {nome} = variabile {{1}} del template Twilio.
const OPENING_TEXTS: Record<'C' | 'T' | 'J', Record<1 | 2, (n: string) => string>> = {
  C: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy: il corso di 10 ore è gratuito davvero, l'accesso ti arriva via email. Tu che obiettivo hai: un'entrata extra o un nuovo lavoro da remoto?`,
  },
  T: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy: l'ingresso nel canale Telegram è in arrivo via email. Curiosità: hai già una professione digitale in mente o vuoi capire quale fa per te?`,
  },
  J: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy. Prima che il simulatore delle professioni digitali ti dia il verdetto: una professione in mente ce l'hai già o parti da zero?`,
  },
};

/** Corpo dell'apertura con la variabile {{1}} sostituita: solo il nome proprio
 * (il CRM manda nome+cognome), vocativo neutro se non c'è un nome usabile. */
export function openingBody(funnel: FunnelKey, variant: 1 | 2, name?: string | null): string {
  return OPENING_TEXTS[FUNNEL_LETTER[funnel]][variant](templateName(name));
}

/** Persona di una conversazione, derivata dai messaggi (ordine cronologico):
 * 'marta' se il PRIMO out con template_sid è in martaSids, oppure se non c'è alcun out
 * (conversazione nuova / apertura differita); altrimenti 'mario'. Gli out free-form
 * (senza template_sid) non contano ai fini della decisione. */
export function personaForConversation(
  msgs: { direction: string; template_sid: string | null }[],
  martaSids: Set<string>,
): Persona {
  const outs = msgs.filter((m) => m.direction === 'out');
  if (outs.length === 0) return 'marta';
  const firstTemplated = outs.find((m) => m.template_sid != null);
  return firstTemplated && martaSids.has(firstTemplated.template_sid as string) ? 'marta' : 'mario';
}
