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

/** Entro questi giorni non si chiude niente: nessun esito al CRM, la chat resta aperta.
 *  Quello che succede dopo NON è la sequenza dei 4 giorni (SEQUENCE_END_DAYS vale solo
 *  per chi non ha mai risposto, Track A): il lead ha risposto, quindi sta sul Track B
 *  (`decideTrackB` in `lib/sequence.ts`) — un solo nudge free-text a 12-24h di silenzio,
 *  poi a 96h la restituzione a un GDO come INTERROTTO. Il cron (bot-followups) in quel
 *  momento rilegge l'evento `richiamo_tenuto_aperto` e mette nella nota dell'INTERROTTO
 *  `buildRichiamoRestituitoNote`: il GDO sa quando il lead voleva essere risentito. */
export const RICHIAMO_FASCIA_APERTA_GG = 3;

/** Fin qui il lead torna a un GDO umano, che il richiamo lo può fare davvero.
 *  Oltre, si scarta: tenerlo aperto significherebbe non toccarlo più. */
export const RICHIAMO_FASCIA_RESTITUZIONE_GG = 7;

export type FasciaRichiamo = 'tieni_aperta' | 'restituisci' | 'scarta';

/** I numeri a parole che il lead può usare in "tra N giorni/settimane/mesi", da "un"
 *  a "venti". Le espressioni senza un numero preciso ("qualche X", "un paio di X",
 *  "settimana prossima") non passano da questa mappa: le assegna direttamente
 *  `fasciaPeriodoVago`, senza fingere di conoscere un numero di giorni che non c'è
 *  (fix round 2, Minor: prima "settimana prossima" restituiva la SOGLIA
 *  `RICHIAMO_FASCIA_RESTITUZIONE_GG` spacciata per un numero di giorni). */
const NUMERO_A_PAROLE: Record<string, number> = {
  un: 1, una: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5,
  sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
  undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15,
  sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20,
};

/** Giorni civili che vale ciascuna unità del periodo, per confrontarla contro le
 *  soglie delle fasce (`fasciaDaGiorni`, sotto) senza avere questi numeri ripetuti
 *  altrove. */
function giorniPerUnita(unita: string): number {
  if (unita.startsWith('giorn')) return 1;
  if (unita.startsWith('settiman')) return 7;
  return 30; // mese/mesi
}

/** Converte un periodo a parole con un numero preciso ("tra N giorni/settimane/
 *  mesi", "tra un paio di X") nel numero di giorni civili che rappresenta, o
 *  `null` se non c'è un numero da leggere (es. "a settembre", "dopo le ferie",
 *  o un'espressione vaga come "qualche settimana" — quelle le assegna
 *  `fasciaPeriodoVago`, PRIMA di arrivare qui: vedi `classificaRichiamo`).
 *  "un paio di" vale sempre 2, con la stessa precisione di "due": non è
 *  un'espressione vaga, è solo scritta in tre parole invece di una. Stesso discorso
 *  per "una decina/ventina di" (fix round 4): lì il numero c'è — 10 e 20 sono la
 *  lettura più bassa possibile di quelle parole — quindi il confronto con le soglie
 *  lo fa `fasciaDaGiorni`, come per ogni altro numero, invece di una fascia costante
 *  scritta a mano che resterebbe ferma se un giorno le soglie si spostassero. */
function periodoInGiorni(periodo: string): number | null {
  const t = periodo.toLowerCase();
  const paio = t.match(/\b(?:tra|fra)\s+un\s+paio\s+di\s+(giorn[oi]|settiman[ae]|mes[ei])\b/);
  if (paio) return 2 * giorniPerUnita(paio[1]);
  const decina = t.match(/\b(?:tra|fra)\s+una\s+(decina|ventina)\s+di\s+(giorn[oi]|settiman[ae]|mes[ei])\b/);
  if (decina) return (decina[1] === 'decina' ? 10 : 20) * giorniPerUnita(decina[2]);
  const m = t.match(/\b(?:tra|fra)\s+([a-zà-ù]+|\d{1,3})\s+(giorn[oi]|settiman[ae]|mes[ei])\b/);
  if (m) {
    const grezzo = m[1];
    const n = /^\d+$/.test(grezzo) ? Number(grezzo) : NUMERO_A_PAROLE[grezzo];
    if (typeof n === 'number') return n * giorniPerUnita(m[2]);
  }
  return null;
}

/** Espressioni a parole SENZA un numero di giorni preciso ("settimana
 *  prossima", "qualche X", "pochi X", "una decina/ventina di X"): la fascia si
 *  assegna direttamente, invece di far finta di conoscere un numero di giorni
 *  che non c'è (fix round 2, Minor: la versione precedente faceva tornare a
 *  `periodoInGiorni` la SOGLIA `RICHIAMO_FASCIA_RESTITUZIONE_GG` spacciata per
 *  un conteggio di giorni — un numero che dichiara di essere un conteggio ma
 *  in realtà è una soglia presa in prestito si rompe in silenzio se le due
 *  costanti smettono di stare alla stessa distanza).
 *
 *  La scelta è sempre quella che NON sovrapromette una chat che resta aperta:
 *  mai `tieni_aperta` per un "quando" che non sappiamo quantificare (fix round
 *  3: regola esplicita, non più un giudizio lasciato al lettore). Il
 *  ragionamento è asimmetrico apposta:
 *  - se classifichiamo `restituisci` un "quando" che in realtà era vicino, il
 *    lead va comunque a un GDO umano che lo richiama: costo basso, il lead
 *    non si perde;
 *  - se classifichiamo `tieni_aperta` un "quando" che in realtà era lontano,
 *    il bot ha appena detto al lead (nel prompt, per un "quando" oltre la
 *    settimana) "da qui non ti scrivo più io", e poi il nudge del Track B
 *    gli riscrive lo stesso entro 24 ore: è una promessa rotta a
 *    una persona vera, non un dettaglio interno.
 *  Nel dubbio si sbaglia dalla parte che non tradisce nessuno: mai
 *  `tieni_aperta` da qui in giù. */
function fasciaPeriodoVago(periodo: string): FasciaRichiamo | null {
  const t = periodo.toLowerCase();
  // "la settimana prossima" / "settimana prossima": può essere 3 come 10 giorni
  // a seconda di che giorno è oggi.
  if (/\b(?:l[ao]\s+)?(?:prossima\s+settimana|settimana\s+prossima)\b/.test(t)) return 'restituisci';
  // "qualche giorno" / "pochi giorni" (fix round 3: stesso trattamento di "qualche",
  // colloquiale quanto lui): in pratica 2-6 giorni, può benissimo superare i 3.
  if (/\b(?:qualche|poch[ei])\s+giorn[oi]\b/.test(t)) return 'restituisci';
  // "qualche settimana/mese" / "poche settimane" / "pochi mesi": sempre oltre la
  // settimana.
  if (/\b(?:qualche|poch[ei])\s+(?:settiman[ae]|mes[ei])\b/.test(t)) return 'scarta';
  // NB: "una decina/ventina di X" NON sta qui. È l'unica di queste espressioni che un
  // numero ce l'ha (10, 20), quindi la legge `periodoInGiorni` e la fascia gliela dà
  // `fasciaDaGiorni` come a qualsiasi altro numero — vedi il commento lì. Fino al fix
  // round 4 tornava `scarta` come costante, con un ragionamento sul numero scritto nel
  // commento invece che nel codice: se domani la soglia diventasse 14 giorni, "una
  // decina di giorni" avrebbe continuato a scartare in silenzio un lead da restituire.
  return null;
}

/** Le stesse due soglie della fascia calcolata sulla data ISO (righe sopra),
 *  applicate a un numero di giorni già ricavato dal periodo a parole (fix round
 *  2, I-1: prima il percorso con la data aveva la STESSA scala riscritta a
 *  mano — due copie della stessa regola, condannate a divergere in silenzio.
 *  Ora `classificaRichiamo` chiama questa funzione da entrambi i percorsi). Un
 *  periodo non leggibile come giorni ("a settembre") si tratta come "oltre la
 *  finestra": si scarta, come già faceva il codice prima di questo fix. */
function fasciaDaGiorni(giorni: number | null): FasciaRichiamo {
  if (giorni === null) return 'scarta';
  if (giorni <= RICHIAMO_FASCIA_APERTA_GG) return 'tieni_aperta';
  if (giorni <= RICHIAMO_FASCIA_RESTITUZIONE_GG) return 'restituisci';
  return 'scarta';
}

/**
 * In quale fascia cade questo "risentiamoci"?
 *
 * `quando` è la cosa da mostrare a un umano: la data formattata in ora di Roma se il
 * lead l'ha detta, altrimenti le sue parole sul periodo, altrimenti `null`.
 *
 * Una data assente, illeggibile o nel passato NON è un esito: torna `tieni_aperta`. Il
 * chiamante (`sendOutcome`) in quel caso non manda NIENTE al CRM — nessuna nota, nessun
 * esito: la chat resta aperta e segue il Track B (nudge a 12-24h, restituzione come
 * INTERROTTO a 96h — vedi `RICHIAMO_FASCIA_APERTA_GG`). Non si deduce mai una data da niente: è esattamente
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
    return { fascia: fasciaDaGiorni(giorni), quando };
  }

  // `periodoWords` prima, `leadWords` come ripiego: vedi il commento sui campi qui
  // sopra. Il primo dei due che produce un periodo vince.
  const periodo = estraiPeriodo(input.periodoWords) ?? estraiPeriodo(input.leadWords);
  if (!periodo) return { fascia: 'tieni_aperta', quando: null };
  return {
    // Le espressioni vaghe (senza un numero di giorni preciso) si classificano
    // da sole, PRIMA di provare a leggerle come un numero: vedi `fasciaPeriodoVago`.
    fascia: fasciaPeriodoVago(periodo) ?? fasciaDaGiorni(periodoInGiorni(periodo)),
    quando: periodo,
  };
}

/**
 * Il periodo detto a parole, ma SOLO se è così lontano da giustificare la chiusura
 * della conversazione. Altrimenti `null`, cioè "nessun periodo" per chi chiama.
 *
 * Serve ai due chiamanti che usavano `estraiPeriodo` come semaforo binario "c'è un
 * periodo / non c'è": `sendOutcome` sul lead che ha GIÀ l'appuntamento in piedi, e
 * `registraEsitoSenzaLeadId` sugli adottati (quelli senza `crm_lead_id`). Per loro un
 * periodo riconosciuto significa registrare l'esito e chiudere la chat. Finché
 * `estraiPeriodo` agganciava solo i "quando" espliciti la cosa reggeva; da quando
 * riconosce anche le formule vicine («tra pochi giorni», «tra un paio di giorni») si è
 * rovesciata: le stesse parole che sul percorso delle tre fasce lasciano il lead vivo
 * — chat aperta, o ritorno a un GDO umano — qui gli chiudevano la porta in faccia.
 *
 * La regola, scritta una volta sola e in termini di fasce, non di numeri:
 * - `tieni_aperta` → `null`. È il "quando" vicino: la chat resta aperta ovunque, come
 *   sul percorso principale.
 * - `restituisci` → `null` anche qui, e questo è il punto che NON si legge dalle tre
 *   fasce: su questi due rami non c'è nessuno a cui restituire il lead. L'adottato non
 *   ha un lead nel CRM da ridare a un GDO, e chi ha già l'appuntamento non è un lead da
 *   consegnare ma una persona che chiede di spostare la sua call. Lì `restituisci` non
 *   ha una destinazione: l'unica cosa che resta della chiusura è "non lo tocca più
 *   nessuno", cioè il lead parcheggiato che questo piano esiste per eliminare.
 * - `scarta` → il periodo. È la sola fascia in cui la chiusura è voluta: il bot congeda
 *   il lead (vedi `lib/mario-prompt.ts`, voce di glossario RICHIAMO) e la chat finisce
 *   davvero lì, con la porta che il lead può riaprire scrivendo lui.
 *
 * Le soglie non sono riscritte qui: le applica `classificaRichiamo`, unica scala.
 */
export function periodoDaCongedo(
  parole: string | undefined,
  nowMs: number,
): string | null {
  const { fascia, quando } = classificaRichiamo({ periodoWords: parole, nowMs });
  return fascia === 'scarta' ? quando : null;
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

/** Il motivo che viaggia con il `DA_SCARTARE` della terza fascia.
 *
 *  Fix round 1, "Important": il congedo ("da qui non ti scrivo più, scrivi tu
 *  quando vuoi") è un'istruzione data al modello nel prompt, non un fatto che
 *  questo modulo può garantire — dipende dal giudizio di Mario sul turno, non
 *  da questa soglia. La frase precedente ("gli è stato detto...") lo dava per
 *  certo; questa lo riporta come l'istruzione che il bot aveva, non come
 *  cronaca di quello che ha effettivamente scritto. */
export function buildRichiamoScartatoReason(input: { quando: string | null }): string {
  const quando = input.quando ? `risentito ${input.quando}` : 'risentito più avanti';
  return `vuole essere ${quando}: il bot aveva l'istruzione di dirgli che può riscrivere lui quando sarà il momento`;
}
