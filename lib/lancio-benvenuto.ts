/**
 * Le variabili (e il corpo) del benvenuto del lancio, presi dal template VERO.
 *
 * Il benvenuto in uso fino al 20/09/2026 (`fenice_lancio_benvenuto_v1`) ha UNA
 * variabile: il nome. La versione approvata da Meta il 20/09 come UTILITY
 * (`fenice_lancio_benvenuto_v2`, HXcf2f16a2afbdafda977f188507599566) ne ha DUE, e la
 * seconda e' il link della stanza Zoom:
 *
 *   "Ciao {{1}}, confermo la tua iscrizione alla live Web Developer AI di lunedi' 5
 *    ottobre alle 21:00. Questo e' il link per collegarti: {{2}} - ..."
 *
 * Il codice non puo' quindi mandare "una variabile" a scatola chiusa: scambiare la env
 * `LANCIO_WELCOME_TEMPLATE_SID` senza toccare il codice farebbe partire a tutti gli
 * iscritti un messaggio col buco al posto del link. E non puo' nemmeno mandarne
 * SEMPRE due, perche' sul template vecchio la seconda non esiste.
 *
 * Quante ne vuole il template lo dice il template: `getTemplateBody` chiede a Twilio il
 * corpo approvato (una sola chiamata per processo, poi in cache) e qui si contano i
 * segnaposto `{{n}}`. Cosi' la env si scambia — e si torna indietro — senza rimettere
 * mano al codice, che e' il punto.
 *
 * Due regole, e sono entrambe fail-closed:
 *  - template a due variabili e `lancio_zoom_link` vuoto => NON si manda, e resta un
 *    evento `error`. Meglio un benvenuto non partito e un allarme che 342 persone con
 *    un messaggio monco: il benvenuto non e' perso, la chat resta senza timbro e il
 *    cron `lancio-aperture` lo manda appena il link c'e';
 *  - un template con segnaposto oltre `{{2}}` non lo sappiamo riempire (nessuno ci ha
 *    detto cosa vada li' dentro) => non si manda, stesso allarme. Indovinare qui vuol
 *    dire lo stesso buco di prima.
 *
 * Il corpo del messaggio si ricava dal testo approvato, non da una copia scritta a
 * mano: la riga `messages` che i pannelli mostrano dice cosi' quello che il lead ha
 * ricevuto davvero, anche dopo uno scambio di template. Se il testo non e' leggibile si
 * ripiega sul testo storico (`lancioBenvenutoText`), che e' esattamente il v1.
 */

import { getTemplateBody } from './twilio';
import { renderBodyTemplate } from './campaigns';
import { templateName } from './name';
import { lancioBenvenutoText } from './lancio-fase';

/**
 * I corpi dei benvenuti che conosciamo, per SID. E' solo la RETE DI SICUREZZA per
 * quando la Content API non risponde: senza, un'API muta al momento sbagliato
 * riporterebbe il conteggio a "una variabile" e il template a due partirebbe monco.
 * La fonte di verita' resta Twilio; questa mappa si aggiorna quando si aggiunge un
 * template, e se un SID non e' qui dentro (ne' leggibile) ci si comporta come si e'
 * sempre fatto: una variabile, il nome.
 */
const CORPI_NOTI: Record<string, string> = {
  // fenice_lancio_benvenuto_v1 (in uso fino allo scambio)
  HX03b5c6a365331cd547c1c22cbedf2c64:
    "Ciao {{1}}, sono l'assistente virtuale di Fenice Academy. Complimenti per esserti iscritto alla " +
    "lista d'attesa dell'evento del 5 ottobre: ti invieremo il link per collegarti alla live " +
    'direttamente qui su WhatsApp il giorno stesso. Rispondi a questo messaggio se sei realmente ' +
    'interessato, per bloccare il posto.',
  // fenice_lancio_benvenuto_v2 — approvato UTILITY il 20/09/2026, due variabili
  HXcf2f16a2afbdafda977f188507599566:
    "Ciao {{1}}, confermo la tua iscrizione alla live Web Developer AI di lunedi' 5 ottobre alle " +
    "21:00. Questo e' il link per collegarti: {{2}} - te lo ricordiamo anche il giorno stesso. " +
    "Rispondi a questo messaggio per confermare che il numero e' attivo.",
};

/**
 * I segnaposto `{{n}}` di un corpo approvato. Accetta anche gli spazi dentro le graffe,
 * che `renderBodyTemplate` (lib/campaigns.ts, quello che rende il corpo per la riga
 * `messages`) non sostituisce: qui si CONTA, e contare una variabile in piu' fa chiedere
 * il link, mentre contarne una in meno fa partire il messaggio col buco.
 */
const SEGNAPOSTO = /\{\{\s*(\d+)\s*\}\}/g;

/**
 * L'indice piu' alto fra i segnaposto del corpo, cioe' quante variabili chiede il
 * template. `{{1}}` e `{{3}}` senza `{{2}}` contano 3: e' un template che non sappiamo
 * riempire, e deve risultare tale.
 */
export function contaVariabili(corpo: string): number {
  let max = 0;
  for (const m of corpo.matchAll(SEGNAPOSTO)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Perche' il benvenuto non si puo' comporre. In entrambi i casi non si manda. */
export type MotivoBenvenutoNonComponibile = 'link_mancante' | 'variabili_sconosciute';

export type EsitoBenvenutoLancio =
  | { ok: true; variables: Record<string, string>; corpo: string; variabili: number }
  | { ok: false; motivo: MotivoBenvenutoNonComponibile; variabili: number };

/**
 * Le variabili e il corpo del benvenuto per questo lead, sul template configurato.
 *
 * `zoomLink` e' `lancio_zoom_link` di `app_settings` (via `getLancioSettings`): la
 * seconda variabile del benvenuto e' il link della live, per contratto col template.
 */
export async function componiBenvenutoLancio(i: {
  templateSid: string;
  nome?: string | null;
  zoomLink: string | null;
}): Promise<EsitoBenvenutoLancio> {
  // Il template si legge sull'account che lo possiede (nessun `from`): la copia sul
  // secondo account e' lo stesso messaggio con un SID diverso, e le variabili che
  // chiede sono per forza le stesse. Chiedere quella del mittente costerebbe una
  // traduzione e, sul secondo account, tornerebbe null proprio quando serve.
  let corpoTemplate: string | null = null;
  try {
    corpoTemplate = await getTemplateBody(i.templateSid);
  } catch {
    corpoTemplate = null;
  }
  corpoTemplate = corpoTemplate ?? CORPI_NOTI[i.templateSid] ?? null;

  // Nessun corpo leggibile e SID sconosciuto: si resta al comportamento di sempre (il
  // nome e basta). Fermarsi qui vorrebbe dire zero benvenuti per un raffreddore della
  // Content API, ed e' un prezzo piu' alto di quello che si evita.
  const variabili = corpoTemplate ? contaVariabili(corpoTemplate) : 1;
  const link = (i.zoomLink ?? '').trim();

  if (variabili > 2) return { ok: false, motivo: 'variabili_sconosciute', variabili };
  if (variabili === 2 && !link) return { ok: false, motivo: 'link_mancante', variabili };

  const variables: Record<string, string> = { '1': templateName(i.nome) };
  if (variabili === 2) variables['2'] = link;

  return {
    ok: true,
    variables,
    // Il corpo reso e' quello che finisce nella riga `messages`, cioe' quello che i
    // pannelli mostrano: stessa strada del follow-up del lancio (`renderBodyTemplate`
    // sul testo chiesto a Twilio, testo storico solo se Twilio non risponde).
    corpo: corpoTemplate ? renderBodyTemplate(corpoTemplate, variables) : lancioBenvenutoText(i.nome),
    variabili,
  };
}

/** L'evento `error` scritto quando il benvenuto non si compone: il messaggio umano. */
export function messaggioBenvenutoNonComponibile(
  motivo: MotivoBenvenutoNonComponibile,
  conversationId: number,
  templateSid: string,
): string {
  return motivo === 'link_mancante'
    ? `[lancio] conv ${conversationId}: il template ${templateSid} vuole il link della live e ` +
      "`lancio_zoom_link` e' vuoto: benvenuto NON inviato (partirebbe senza link). Si riempie " +
      'la chiave in app_settings e il cron lancio-aperture lo manda.'
    : `[lancio] conv ${conversationId}: il template ${templateSid} chiede variabili che non ` +
      'sappiamo riempire: benvenuto NON inviato.';
}
