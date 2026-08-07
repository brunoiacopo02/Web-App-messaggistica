// Persona e aperture per-funnel (A/B) — modulo puro, nessun accesso a env/DB.
// Spec: docs/superpowers/specs/2026-07-24-apertura-marta-ab-design.md (§2: testi ESATTI per varianti 1-2);
// varianti 3-4 da questo piano (dichiarazioni IA per AI Act art. 50).

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

/** Variante A/B di un'apertura. 1 e 2 sono le storiche; 3 e 4 dichiarano l'IA
 *  (AI Act art. 50) e sono cloni della 1 con la sola presentazione cambiata. */
export type OpeningVariant = 1 | 2 | 3 | 4;

/** Quante vie ha l'A/B: 4 con le varianti dichiarate, 2 senza. */
export type OpeningWays = 2 | 4;

/** Assegnazione A/B per resto modulo `ways` del conversationId: 1→1, 2→2, 3→3, 0→ways.
 *  Il resto 0 mappa sull'ULTIMA variante, non sulla prima: con `r || 1` un id
 *  multiplo di `ways` finirebbe silenziosamente nel gruppo sbagliato.
 *  A due vie il risultato è quello storico: dispari → 1, pari → 2. */
export function variantIndexFor(conversationId: number, ways: OpeningWays = 4): OpeningVariant {
  const r = ((conversationId % ways) + ways) % ways;
  return (r === 0 ? ways : r) as OpeningVariant;
}

/**
 * Le vie dell'A/B per un funnel, in base ai template che esistono DAVVERO.
 *
 * Le varianti dichiarate (3 e 4) vivono su template Twilio separati, che vanno
 * creati e approvati da Meta prima di poter essere usati. Finché i loro SID non
 * sono configurati, assegnare un lead alla 3 o alla 4 lo farebbe cadere
 * sull'apertura legacy di Mario: metà dei nuovi lead perderebbe la persona Marta
 * per una configurazione mancante. Meglio restare a due vie e passare a quattro
 * da sé, il giorno in cui i template ci sono.
 */
export function openingWaysFor(funnel: FunnelKey, hasSid: (envKey: string) => boolean): OpeningWays {
  return hasSid(openingEnvKey(funnel, 3)) && hasSid(openingEnvKey(funnel, 4)) ? 4 : 2;
}

const FUNNEL_LETTER: Record<FunnelKey, 'C' | 'T' | 'J'> = {
  corso10: 'C',
  telegram: 'T',
  jobsim: 'J',
  other: 'C', // funnel non riconosciuto → aperture di CORSO 10 ORE
};

/** Nome della env che contiene il Content SID dell'apertura (es. OPENING_SID_C1). */
export function openingEnvKey(funnel: FunnelKey, variant: OpeningVariant): string {
  return `OPENING_SID_${FUNNEL_LETTER[funnel]}${variant}`;
}

/** I nomi env di TUTTE le aperture, in un posto solo: `martaSidsFromEnv` e il cron
 *  della sequenza li leggono da qui, così una variante nuova non può restare fuori
 *  da una delle due liste (era una lista copiata a mano in tre punti). */
export const OPENING_ENV_KEYS: readonly string[] = (['C', 'T', 'J'] as const).flatMap((l) =>
  ([1, 2, 3, 4] as const).map((v) => `OPENING_SID_${l}${v}`),
);

// Testi ESATTI della spec §2; {nome} = variabile {{1}} del template Twilio.
const OPENING_TEXTS: Record<'C' | 'T' | 'J', Record<OpeningVariant, (n: string) => string>> = {
  C: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy: il corso di 10 ore è gratuito davvero, l'accesso ti arriva via email. Tu che obiettivo hai: un'entrata extra o un nuovo lavoro da remoto?`,
    3: (n) =>
      `Ciao ${n}, sono Marta, l'assistente digitale di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?`,
    4: (n) =>
      `Ciao ${n}, sono Marta, digital assistant di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?`,
  },
  T: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy: l'ingresso nel canale Telegram è in arrivo via email. Curiosità: hai già una professione digitale in mente o vuoi capire quale fa per te?`,
    3: (n) =>
      `Ciao ${n}, sono Marta, l'assistente digitale di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?`,
    4: (n) =>
      `Ciao ${n}, sono Marta, digital assistant di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?`,
  },
  J: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy. Prima che il simulatore delle professioni digitali ti dia il verdetto: una professione in mente ce l'hai già o parti da zero?`,
    3: (n) =>
      `Ciao ${n}, sono Marta, l'assistente digitale di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?`,
    4: (n) =>
      `Ciao ${n}, sono Marta, digital assistant di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?`,
  },
};

/** Corpo dell'apertura con la variabile {{1}} sostituita: solo il nome proprio
 * (il CRM manda nome+cognome), vocativo neutro se non c'è un nome usabile. */
export function openingBody(funnel: FunnelKey, variant: OpeningVariant, name?: string | null): string {
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
