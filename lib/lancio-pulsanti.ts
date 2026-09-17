import { DOMANDA_SCELTA_GIORNO, DOMANDA_SCELTA_NOTTE, testoScelta } from './lancio-prompt';
import type { ModoPostPitch } from './lancio-scelta';

/**
 * La scelta della sera del webinar chiesta con i PULSANTI di WhatsApp (delibera PO 17/09).
 *
 * Il 14/09, in prova, alla domanda scritta il lead ha risposto "Adessi": una risposta
 * giusta che nessuna regex riconosce e che finiva al modello. Con due quick reply il lead
 * non scrive piu' niente — tocca — e il testo che arriva e' ESATTAMENTE il titolo del
 * pulsante. Da li' la classificazione torna deterministica e non costa un turno di modello.
 *
 * Qui dentro non c'e' rete: i due SID stanno nelle env (i template si creano con
 * `scripts/create-lancio-scelta-templates.mjs`), l'invio sta in `lancio-effetti.ts` e la
 * decisione del turno in `lancio-post-pitch.ts`.
 */

/** I titoli dei due pulsanti, notte e giorno. WhatsApp li taglia a 20 caratteri. */
export const PULSANTE_CHIAMA_ORA = 'Chiamami subito';
export const PULSANTE_FISSIAMO_DOMANI = 'Fissiamo domani';
export const PULSANTE_OGGI_POMERIGGIO = 'Oggi pomeriggio';
export const PULSANTE_DOMANI_MATTINA = 'Domani mattina';

export const PULSANTI_SCELTA_NOTTE = [PULSANTE_CHIAMA_ORA, PULSANTE_FISSIAMO_DOMANI] as const;
export const PULSANTI_SCELTA_GIORNO = [PULSANTE_OGGI_POMERIGGIO, PULSANTE_DOMANI_MATTINA] as const;

/** I pulsanti del modo corrente: e' la coppia che sta nel template di quel modo. */
export function pulsantiScelta(modo: ModoPostPitch): readonly string[] {
  return modo === 'notte' ? PULSANTI_SCELTA_NOTTE : PULSANTI_SCELTA_GIORNO;
}

/**
 * Minuscole, senza accenti, senza punteggiatura ne' emoji: "Chiamami subito!" e
 * "CHIAMAMI SUBITO 🚀" sono lo stesso tocco. WhatsApp rimanda il titolo tale e quale, ma
 * un client vecchio o un copia-incolla del lead possono aggiungerci qualcosa.
 */
function normalizza(testo: string): string {
  return testo
    .toLowerCase()
    .replace(/['’]/g, "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}

/** Cosa ha toccato il lead: il tag del lancio corrispondente, o `null` se non e' un tocco. */
export type TapScelta = 'CHIAMA_ORA' | 'SLOTS';

const TITOLI: ReadonlyArray<readonly [string, TapScelta]> = [
  [PULSANTE_CHIAMA_ORA, 'CHIAMA_ORA'],
  [PULSANTE_FISSIAMO_DOMANI, 'SLOTS'],
  [PULSANTE_OGGI_POMERIGGIO, 'SLOTS'],
  [PULSANTE_DOMANI_MATTINA, 'SLOTS'],
];

/**
 * Il tocco di un pulsante, riconosciuto PRIMA del modello.
 *
 * I quattro titoli valgono in tutti e due i modi, non solo nel proprio: il template della
 * notte resta nella chat, e un lead che la mattina dopo scorre indietro e tocca "Chiamami
 * subito" manda quel titolo di giorno. La regola dura sta a valle dov'e' sempre stata —
 * `CHIAMA_ORA` di giorno diventa il testo fisso "a quest'ora fissiamo la call" piu' le ore
 * — e non va duplicata qui.
 *
 * Il confronto e' ESATTO sul titolo normalizzato: "domani mattina va bene" e' una frase,
 * non un tocco, e continua ad andare al modello come prima.
 */
export function tapPulsanteScelta(testo: string | null | undefined): TapScelta | null {
  const t = normalizza((testo ?? '').trim());
  if (t === '') return null;
  return TITOLI.find(([titolo]) => normalizza(titolo) === t)?.[1] ?? null;
}

/**
 * Il modello ha appena scritto la domanda della scelta? Si confronta sul testo
 * normalizzato: la domanda sta nel prompt verbatim, ma il modello puo' metterci davanti
 * un "Perfetto," o cambiare la punteggiatura finale.
 */
export function eDomandaScelta(testo: string | null | undefined, modo: ModoPostPitch): boolean {
  const t = normalizza((testo ?? '').trim());
  if (t === '') return false;
  return t.includes(normalizza(modo === 'notte' ? DOMANDA_SCELTA_NOTTE : DOMANDA_SCELTA_GIORNO));
}

/**
 * Il Content SID del template a pulsanti del modo corrente, o `null` se l'env non c'e'.
 * Si legge a ogni turno e non una volta sola: su Vercel la env si aggiunge la sera stessa,
 * e una costante di modulo la leggerebbe solo al prossimo avvio a freddo.
 */
export function sidSceltaPulsanti(modo: ModoPostPitch): string | null {
  const raw = modo === 'notte'
    ? process.env.LANCIO_SCELTA_NOTTE_TEMPLATE_SID
    : process.env.LANCIO_SCELTA_GIORNO_TEMPLATE_SID;
  const v = (raw ?? '').trim();
  return v === '' ? null : v;
}

/** Il corpo del template del modo: la stessa stringa che il lead legge nel fallback. */
export function corpoSceltaPulsanti(modo: ModoPostPitch): string {
  return testoScelta(modo);
}
