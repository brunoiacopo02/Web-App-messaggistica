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
import { formatRomeDateTime, romeDaysBetween } from './rome-time';

/** Entro questi giorni non si chiude niente: la sequenza di follow-up (SEQUENCE_END_DAYS
 *  = 4) lo ripesca da sola, quindi il lead viene davvero riseguito. */
export const RICHIAMO_FASCIA_APERTA_GG = 3;

/** Fin qui il lead torna a un GDO umano, che il richiamo lo può fare davvero.
 *  Oltre, si scarta: tenerlo aperto significherebbe non toccarlo più. */
export const RICHIAMO_FASCIA_RESTITUZIONE_GG = 7;

export type FasciaRichiamo = 'tieni_aperta' | 'restituisci' | 'scarta';

/** Un periodo a parole che può stare dentro i 7 giorni. Tutto il resto è più lontano.
 *  "tra N giorni/settimane/mesi" si guarda il numero e l'unità; "settimana prossima"
 *  può essere 3 come 10 giorni e si sceglie la lettura che NON butta via il lead
 *  (la restituzione). */
const NUMERO_A_PAROLE: Record<string, number> = {
  un: 1, una: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5,
  sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
  undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15,
  sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20,
};

/** Giorni civili che vale ciascuna unità del periodo, per confrontarla contro
 *  `RICHIAMO_FASCIA_RESTITUZIONE_GG` senza avere quel numero ripetuto altrove. */
function giorniPerUnita(unita: string): number {
  if (unita.startsWith('giorn')) return 1;
  if (unita.startsWith('settiman')) return 7;
  return 30; // mese/mesi
}

function periodoEntroSetteGiorni(periodo: string): boolean {
  const t = periodo.toLowerCase();
  const m = t.match(/\b(?:tra|fra)\s+([a-zà-ù]+|\d{1,3})\s+(giorn[oi]|settiman[ae]|mes[ei])\b/);
  if (m) {
    const grezzo = m[1];
    const n = /^\d+$/.test(grezzo) ? Number(grezzo) : NUMERO_A_PAROLE[grezzo];
    if (typeof n !== 'number') return false;
    return n * giorniPerUnita(m[2]) <= RICHIAMO_FASCIA_RESTITUZIONE_GG;
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
 * Una data assente, illeggibile o nel passato NON è un esito: torna `tieni_aperta`. Il
 * chiamante (`sendOutcome`) in quel caso non manda NIENTE al CRM — nessuna nota, nessun
 * esito: la sequenza di follow-up ripesca da sola la conversazione entro
 * `RICHIAMO_FASCIA_APERTA_GG` giorni. Non si deduce mai una data da niente: è esattamente
 * il bug chiuso il 06/08.
 */
export function classificaRichiamo(input: {
  date?: string;
  /** Le parole del lead sul "quando", sintetizzate dal modello (per un RICHIAMO è il
   *  campo `note` del contratto: vedi `mario.ts`, tag `[RICHIAMO|...]`). Si prova QUI
   *  per primo: è il campo curato apposta per portare l'espressione temporale, e resta
   *  valido anche quando l'ultimo messaggio del lead non ne parla più ("ok va bene"
   *  due turni dopo aver detto "a novembre"). */
  periodoWords?: string;
  /** L'ultimo turno testuale del lead, verbatim. Si prova SOLO se `periodoWords` non
   *  contiene un periodo riconoscibile: è un ripiego, non la fonte primaria. */
  leadWords?: string;
  nowMs: number;
}): { fascia: FasciaRichiamo; quando: string | null } {
  const t = input.date ? Date.parse(input.date) : NaN;
  if (!Number.isNaN(t) && t >= input.nowMs) {
    // Giorni di CALENDARIO a Roma, non ore/24: sull'aritmetica in millisecondi il
    // cambio dell'ora legale (25/10/2026, notte di 25h) sposta di fascia una data che
    // sul calendario cade esattamente al confine (es. 7 giorni dopo diventa 7,04).
    const giorni = romeDaysBetween(new Date(input.nowMs), new Date(t));
    const quando = formatRomeDateTime(input.date!);
    if (giorni <= RICHIAMO_FASCIA_APERTA_GG) return { fascia: 'tieni_aperta', quando };
    if (giorni <= RICHIAMO_FASCIA_RESTITUZIONE_GG) return { fascia: 'restituisci', quando };
    return { fascia: 'scarta', quando };
  }

  // `periodoWords` prima, `leadWords` come ripiego: vedi il commento sui campi qui
  // sopra. Il primo dei due che produce un periodo vince.
  const periodo = estraiPeriodo(input.periodoWords) ?? estraiPeriodo(input.leadWords);
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
