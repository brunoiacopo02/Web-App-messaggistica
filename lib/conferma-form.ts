// "Noemi" — la prova che il lead ha davvero compilato il form di prenotazione.
//
// Il flusso di chiusura manda il link JotForm e poi chiede: "quando hai cliccato su
// invia, che nome ti è comparso?". La pagina di ringraziamento del form mostra "Noemi",
// quindi il lead che risponde "Noemi" sta dicendo: ho prenotato.
//
// Perché serve un rilevatore e non basta il classificatore: fino al 22/09/2026 una chat
// che si fermava lì veniva riletta da `classifyInterrupted` e, se il modello non vedeva
// la conferma, chiusa come INTERROTTO — cioè restituita a un GDO come lead freddo. Su
// 650 conversazioni con la conferma del form, 83 non sono diventate appuntamento e 54
// sono state restituite o scartate: 53 solo a settembre. Un appuntamento già preso non
// può dipendere da un modello che legge bene: questa funzione dà sempre la stessa
// risposta.
//
// Il confine è stretto di proposito. "Noemi" DA SOLA — o dentro una frase brevissima che
// non dice altro ("mi è comparso Noemi", "Noemi mi è comparso") — è la risposta alla
// verifica. "Ho provato a telefonare a Noemi" la nomina e basta: quella è una richiesta
// di contatto, non una conferma, e trattarla come tale manderebbe alle Conferme un
// appuntamento che non esiste.

const NOME_FORM = /noem[iy]i?/;

/** La domanda che il bot fa dopo aver mandato il link: "Dimmi, quando hai cliccato su
 *  invia, che nome ti è comparso?". È il segnale più forte che abbiamo — molto più
 *  affidabile di qualunque analisi della frase del lead. */
const DOMANDA_VERIFICA = /che nome ti (?:e|e') compars|nome ti (?:e|e') compars|che nome ti compare|nome comparso sul form/;

/** Le sole parole ammesse attorno al nome perché resti una risposta alla verifica.
 *  Deve accettare anche la stringa vuota: "Noemi" da sola è il caso più frequente. */
const CONTORNO = /^(?:mi\s+)?(?:e|e')?\s*(?:comparso|comparsa|uscito|uscita|apparso|apparsa|il\s+nome|nome)?\s*$/;

function normalizza(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Questo messaggio del lead è la risposta alla verifica del form?
 *
 * Vero solo se, tolto il nome, quello che resta prima E dopo è soltanto contorno
 * ("mi è comparso", "il nome"). Il contorno si controlla su tutti e due i lati perché il
 * lead lo mette indifferentemente prima ("mi è comparso Noemi") o dopo ("Noemi mi è
 * comparso"). Una frase che parla d'altro e nomina Noemi torna falso.
 */
export function rispostaAllaVerificaForm(body: string | null | undefined): boolean {
  const t = normalizza(body ?? '');
  if (!t) return false;
  const m = t.match(NOME_FORM);
  if (!m || m.index === undefined) return false;
  const prima = t.slice(0, m.index).trim();
  const dopo = t.slice(m.index + m[0].length).trim();
  return CONTORNO.test(prima) && CONTORNO.test(dopo);
}

/** Questo messaggio del bot è la domanda di verifica del form? */
export function domandaDiVerificaForm(body: string | null | undefined): boolean {
  return DOMANDA_VERIFICA.test(normalizza(body ?? ''));
}

/**
 * Il lead ha confermato il form in un punto qualsiasi di questa conversazione?
 *
 * Due segnali, in OR, e il primo è il forte: se il bot ha appena chiesto "che nome ti è
 * comparso?" e il lead risponde nominando Noemi, quella è una conferma, comunque sia
 * girata la frase. Il secondo copre il caso in cui la domanda sta più indietro nella
 * chat e il lead risponde secco.
 *
 * La prima versione guardava solo la forma della frase e perdeva conferme vere come
 * "Il nome comparso è Noemi", "Fatto, Noemi", "Cmq nome NOEMI" e "Noemi. Ma ho potuto
 * selezionare solamente 17" — quest'ultima ci dava pure l'orario scelto. Qui un falso
 * negativo costa un appuntamento buttato via, un falso positivo costa una restituzione
 * in meno: la soglia sta di proposito dal lato che non perde nessuno.
 */
export function haConfermatoIlForm(
  msgs: { direction: string; body: string | null }[],
): boolean {
  let domandaFatta = false;
  for (const m of msgs) {
    if (m.direction === 'out') {
      // La domanda resta "aperta" finché non risponde: fra la domanda e la risposta il
      // bot a volte infila altre bolle.
      if (domandaDiVerificaForm(m.body)) domandaFatta = true;
      continue;
    }
    const nominaNoemi = NOME_FORM.test(normalizza(m.body ?? ''));
    if (nominaNoemi && (domandaFatta || rispostaAllaVerificaForm(m.body))) return true;
    // Un inbound che non c'entra chiude la finestra della domanda.
    if (domandaFatta && !nominaNoemi) domandaFatta = false;
  }
  return false;
}

/**
 * Cosa fare del ramo `interrotto_classify` del cron rispetto alla conferma del form —
 * decisione pura, senza I/O, per poterla testare senza un Supabase finto.
 *
 * `giaTrattenuta` arriva da fuori (una riga `event_log` di tipo
 * `restituzione_bloccata_conferma_form` già scritta per questa conversazione in un run
 * precedente): senza quella guardia il cron richiamerebbe `classifyInterrupted` — una
 * chiamata a pagamento a Claude — a ogni giro, per sempre, perché una conversazione
 * trattenuta non tocca né `ai_status` né `bot_outcome` e quindi resta idonea allo stesso
 * ramo al giro successivo (vedi `decideTrackB` in `lib/sequence.ts`).
 *
 * - `'salta'`: già segnalata e trattenuta prima. Niente classificatore, niente nuova
 *   riga, niente nuovo `CONTATTO_UMANO` — il chiamante deve fare `continue` subito, PRIMA
 *   di chiamare `classifyInterrupted`.
 * - `'segnala_e_trattieni'`: prima volta che si vede la conferma del form su questa
 *   conversazione. Il chiamante manda `CONTATTO_UMANO`, scrive la riga di guardia e fa
 *   `continue` — niente restituzione.
 * - `'prosegui'`: nessuna conferma del form. Tutto come prima di questa guardia.
 */
export type AzioneConfermaForm = 'salta' | 'segnala_e_trattieni' | 'prosegui';

export function decidiSuConfermaForm(input: {
  confermaForm: boolean;
  giaTrattenuta: boolean;
}): AzioneConfermaForm {
  if (!input.confermaForm) return 'prosegui';
  return input.giaTrattenuta ? 'salta' : 'segnala_e_trattieni';
}
