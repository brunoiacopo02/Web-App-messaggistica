// Le tre fasce di un "risentiamoci più avanti", decise dal codice e non dal modello.
//
// Fino al 22/09/2026 un lead che chiedeva di essere risentito diventava un RICHIAMO:
// nel CRM una `recallDate` sul lead del bot. Il bot però non telefona, quindi quel
// richiamo non lo faceva nessuno e il lead restava parcheggiato per sempre — 93 lead
// fermi così al 22/09. E quando il lead passava a un umano (coda /richieste-contatto)
// il GDO se lo ritrovava in "Richiami" a un orario che nessuno aveva scelto: la data
// era calcolata dalla macchina e portava anche i secondi (25/09 alle 09:02:49).
//
// Decisione del PO (22/09/2026): il bot non scrive più richiami. Guarda QUANDO il lead
// vuole essere risentito e sceglie fra tre comportamenti.
//
// Il calcolo sta qui e non nel prompt di proposito: a un modello non si chiede di fare
// differenze fra date. Mario riconosce l'intenzione e riporta il "quando"; la fascia la
// decide questa funzione, che è pura e si testa.

import { estraiPeriodo } from './periodo-richiamo';
import { paroleDelLead } from './bot-outcome-rules';
import { formatRomeDateTime } from './rome-time';

/** Entro questi giorni non si chiude niente: la sequenza di follow-up (SEQUENCE_END_DAYS
 *  = 4) lo ripesca da sola, quindi il lead viene davvero riseguito. */
export const RICHIAMO_FASCIA_APERTA_GG = 3;

/** Fin qui il lead torna a un GDO umano, che il richiamo lo può fare davvero.
 *  Oltre, si scarta: tenerlo aperto significherebbe non toccarlo più. */
export const RICHIAMO_FASCIA_RESTITUZIONE_GG = 7;

export type FasciaRichiamo = 'tieni_aperta' | 'restituisci' | 'scarta';

const GIORNO_MS = 24 * 3600_000;

/** Un periodo a parole che può stare dentro i 7 giorni. Tutto il resto è più lontano.
 *  "tra N giorni" si guarda il numero; "settimana prossima" può essere 3 come 10 giorni
 *  e si sceglie la lettura che NON butta via il lead (la restituzione). */
const NUMERO_A_PAROLE: Record<string, number> = {
  un: 1, una: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5,
  sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, quindici: 15, venti: 20,
};

function periodoEntroSetteGiorni(periodo: string): boolean {
  const t = periodo.toLowerCase();
  const giorni = t.match(/\b(?:tra|fra)\s+([a-zà-ù]+|\d{1,3})\s+giorn[oi]\b/);
  if (giorni) {
    const grezzo = giorni[1];
    const n = /^\d+$/.test(grezzo) ? Number(grezzo) : NUMERO_A_PAROLE[grezzo];
    return typeof n === 'number' && n <= RICHIAMO_FASCIA_RESTITUZIONE_GG;
  }
  // "la settimana prossima" / "settimana prossima": l'unica espressione vaga che può
  // cadere dentro la settimana. "mese", "anno" e le stagioni no.
  if (/\b(?:l[ao]\s+)?(?:prossima\s+settimana|settimana\s+prossima)\b/.test(t)) return true;
  return false;
}

/**
 * In quale fascia cade questo "risentiamoci"?
 *
 * `quando` è la cosa da mostrare a un umano: la data formattata in ora di Roma se il
 * lead l'ha detta, altrimenti le sue parole sul periodo, altrimenti `null`.
 *
 * Una data assente, illeggibile o nel passato NON è un esito: torna `tieni_aperta`, e
 * il chiamante manda al CRM la nota "giorno e ora da concordare" che già esiste. Non si
 * deduce mai una data da niente: è esattamente il bug chiuso il 06/08.
 */
export function classificaRichiamo(input: {
  date?: string;
  leadWords?: string;
  nowMs: number;
}): { fascia: FasciaRichiamo; quando: string | null } {
  const t = input.date ? Date.parse(input.date) : NaN;
  if (!Number.isNaN(t) && t >= input.nowMs) {
    const giorni = (t - input.nowMs) / GIORNO_MS;
    const quando = formatRomeDateTime(input.date!);
    if (giorni <= RICHIAMO_FASCIA_APERTA_GG) return { fascia: 'tieni_aperta', quando };
    if (giorni <= RICHIAMO_FASCIA_RESTITUZIONE_GG) return { fascia: 'restituisci', quando };
    return { fascia: 'scarta', quando };
  }

  const periodo = estraiPeriodo(input.leadWords);
  if (!periodo) return { fascia: 'tieni_aperta', quando: null };
  return {
    fascia: periodoEntroSetteGiorni(periodo) ? 'restituisci' : 'scarta',
    quando: periodo,
  };
}

/** La nota che accompagna la restituzione al GDO. Dice il fatto e il giorno, e non
 *  prende impegni a nome di nessuno: chi la legge decide se e quando telefonare. */
export function buildRichiamoRestituitoNote(input: {
  quando: string | null;
  leadWords?: string;
}): string {
  const parole = paroleDelLead(input.leadWords);
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  const quando = input.quando
    ? `Voleva essere risentito ${input.quando}.`
    : 'Voleva essere risentito più avanti ma non ha detto quando.';
  return (
    `VOLEVA ESSERE RISENTITO — il bot ha smesso di lavorarlo e te lo ridà. ${quando}` +
    citazione
  );
}

/** Il motivo che viaggia con il `DA_SCARTARE` della terza fascia. */
export function buildRichiamoScartatoReason(input: { quando: string | null }): string {
  const quando = input.quando ? `risentito ${input.quando}` : 'risentito più avanti';
  return `vuole essere ${quando}: gli è stato detto di riscrivere quando sarà il momento`;
}
