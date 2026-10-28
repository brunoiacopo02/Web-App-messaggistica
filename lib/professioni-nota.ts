import { PROFESSIONI, PROVENIENZA_PROFESSIONI, isMarkerProfessioni, isSlugProfessione, nomeProfessione, type SlugProfessione } from './professioni';
import { lancioInCorso } from './lancio-fase';
import { oraAppuntamento } from './gdo-context-note';

/**
 * Nota di contesto per chi arriva dal funnel Professioni (spec §2). Sta nella parte
 * variabile del prompt: il manuale di Mario resta identico e la cache non si rompe.
 *
 * Nelle adv promettiamo la brochure subito (PO 28/10/2026): la scheda parte in automatico
 * alla prima risposta, prima del testo di Mario (`schedaSubito`). `schedaInviata` dice se
 * e' gia' in chat, `appenaInviata` se e' partita in questo turno, sopra la risposta.
 */
export function professioniContextNote(
  slug: SlugProfessione | null,
  opts?: { schedaInviata?: boolean; appenaInviata?: boolean },
): string {
  const corso = slug
    ? `Il corso che ha scelto e' ${nomeProfessione(slug)}.`
    : `Non sappiamo ancora quale corso: chiediglielo (falso bivio se e' indeciso). Slug possibili: ${PROFESSIONI.map((p) => p.slug).join(', ')}.`;
  const tag = slug ? `[SCHEDA:${slug}]` : '[SCHEDA:<slug>]';
  const inviata = !!(opts?.schedaInviata || opts?.appenaInviata);
  const flusso = 'Poi segui il flusso normale (situazione, famiglia, motivazioni, pitch con i prezzi, call, Noemi).';
  return [
    'CONTESTO FUNNEL PROFESSIONI: questo lead ci ha scritto per primo dalla pagina delle professioni e ha chiesto la scheda del corso.',
    corso,
    ...(opts?.appenaInviata && slug
      ? [`LA SCHEDA GLI E' APPENA ARRIVATA: e' partita in automatico qui sopra, prima del tuo messaggio (il PDF con "Ecco la scheda del corso di ${nomeProfessione(slug)} 👇"). Non dire che gliela mandi e non ripetere "ecco la scheda": in mezza riga digli di darci un'occhiata con calma e passa subito alla prima domanda per capire la sua situazione. ${flusso}`]
      : inviata
        ? [`LA SCHEDA L'HA GIA' RICEVUTA: e' sopra in chat. Se te la richiede (scheda, pdf, brochure, programma), digli che gliel'hai mandata qui sopra in chat e che la trova scorrendo un attimo, poi vai avanti. Non rimandarla e non usare il tag [SCHEDA:...]. ${flusso}`]
        : [
            slug
              ? `LA SCHEDA NON E' ANCORA PARTITA: se te la chiede mandagliela subito scrivendo in fondo al messaggio il tag ${tag}, e nello stesso messaggio vai avanti con le domande. ${flusso}`
              : `APPENA TI DICE IL CORSO mandagli subito la scheda scrivendo in fondo al messaggio il tag ${tag}, e nello stesso messaggio vai avanti con le domande. ${flusso}`,
            `Il tag ${tag} lo usi al massimo una volta. Se fissa la call senza averla ancora ricevuta, gli arriva in automatico insieme al video.`,
          ]),
    `SE RIMANDA LA CALL PER GUARDARE PRIMA LA SCHEDA: prendi un impegno sul quando: deve averla vista entro domani, ci vogliono due minuti. Il quando lo dice lui (regola "PRIMA GUARDO IL CORSO").${inviata ? '' : ` Se non l'ha ancora ricevuta, mandala col tag ${tag}.`}`,
    "LA SCHEDA ESISTE SEMPRE: non dire mai che non c'e' o che non abbiamo una scheda, una brochure o un pdf da mandare.",
  ].join('\n');
}

export function schedaDaInviare(i: {
  professione: string | null;
  schedaInviataAt: string | null;
  schedaRichiesta?: SlugProfessione;
  appuntamentoConVideoOra: boolean;
}): { slug: SlugProfessione; momento: 'pre_appuntamento' | 'post_appuntamento' } | null {
  if (i.schedaInviataAt) return null;
  if (i.appuntamentoConVideoOra && isSlugProfessione(i.professione)) return { slug: i.professione, momento: 'post_appuntamento' };
  if (i.schedaRichiesta) return { slug: i.schedaRichiesta, momento: 'pre_appuntamento' };
  return null;
}

/**
 * Senza l'ora della call sulla riga (3 chat postino su 4), la call GDO si considera ancora
 * da fare per 7 giorni dall'agenda: sulle 663 chat che hanno entrambe le date, la call cade
 * al massimo 6,9 giorni dopo l'agenda (p99 3,6 giorni, dati del 15/10/2026).
 */
export const FINESTRA_CALL_GDO_SENZA_ORA_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * La chat e' del funnel Professioni anche se e' stata del lancio o di un GDO? (PO 15/10/2026,
 * conv 3292: un vecchio lead del lancio con un'agenda GDO di settembre scrive la frase delle
 * Professioni e chiede la brochure; la nota era spenta e Mario rispondeva che non c'e'.)
 *
 * Vince quando ha scelto un corso (o e' entrata nel funnel PROFESSIONI) E:
 * - il lancio non e' in corso: niente `lancio_slug`, o fase terminale (LANCIO_FASI_TERMINALI:
 *   'chiuso', 'restituito'). Una fase attiva o nulla con lo slug resta del lancio.
 *   'restituito' conta come lancio finito, ma in pratica qui non arriva: quelle chat il
 *   webhook non le riapre mai (app/api/webhooks/twilio/route.ts, ramo `restituito`),
 *   il lead e' tornato al GDO e il bot non gli risponde piu';
 * - non c'e' una call GDO ancora da fare: niente agenda, oppure l'ora della call (la piu'
 *   recente fra `bot_scheduled_at` e `gdo_appuntamento_at`, come `oraAppuntamento`) e' passata;
 *   senza ora, o con un'ora precedente all'agenda, l'agenda e' piu' vecchia di
 *   FINESTRA_CALL_GDO_SENZA_ORA_MS. Un'agenda illeggibile resta protetta.
 */
export function professioniVince(i: {
  professione: string | null;
  crmFunnel: string | null;
  lancioSlug: string | null | undefined;
  lancioFase: string | null | undefined;
  gdoAgendaAt: string | null;
  botScheduledAt: string | null;
  gdoAppuntamentoAt: string | null;
  now: number;
}): boolean {
  if (i.professione === null && i.crmFunnel !== PROVENIENZA_PROFESSIONI) return false;
  if (lancioInCorso({ lancio_slug: i.lancioSlug, lancio_fase: i.lancioFase })) return false;
  if (i.gdoAgendaAt === null) return true;
  const agenda = Date.parse(i.gdoAgendaAt);
  if (Number.isNaN(agenda)) return false;
  // Una call precedente all'agenda e' di un giro vecchio rimasto sulla riga: non dice
  // niente della call fissata con questa agenda, quindi vale la finestra dall'agenda.
  const call = oraAppuntamento(i.botScheduledAt, i.gdoAppuntamentoAt);
  if (call && call.getTime() >= agenda) return call.getTime() <= i.now;
  return agenda + FINESTRA_CALL_GDO_SENZA_ORA_MS <= i.now;
}

// Conv 3292 (PO 15/10/2026, seconda prova): "me lo mandi ora?" + "il pdf intendo" e Mario
// rispondeva che il pdf non c'era. Dal 28/10/2026 la richiesta (come la frase del link) fa
// partire la scheda subito, se non e' ancora in chat (`schedaSubito`).
const RICHIESTA_SCHEDA = /\b(scheda|pdf|brou?chure|depliant|programma)\b/i;

/** I messaggi del lead in questo turno chiedono la scheda? La frase del link non conta. */
export function chiedeLaScheda(testi: readonly string[]): boolean {
  return testi.some((t) => !isMarkerProfessioni(t) && RICHIESTA_SCHEDA.test(t));
}

/**
 * La scheda parte SUBITO, prima della risposta di Mario (PO 28/10/2026: nelle adv
 * promettiamo la brochure subito)? Si' quando il turno e' del funnel (`professioniVince`,
 * stesse condizioni di prima: mai nel postino ne' nel lancio in corso), il corso e' noto,
 * la scheda non e' ancora in chat, e il lead in questo turno ha mandato la frase del link
 * o l'ha chiesta. Una chat vecchia che non la chiede non se la vede arrivare a meta' discorso.
 */
export function schedaSubito(i: {
  vinceProfessioni: boolean;
  professione: string | null;
  schedaInviataAt: string | null;
  testiTurno: readonly string[];
}): SlugProfessione | null {
  if (!i.vinceProfessioni || i.schedaInviataAt || !isSlugProfessione(i.professione)) return null;
  const vuole = i.testiTurno.some((t) => isMarkerProfessioni(t)) || chiedeLaScheda(i.testiTurno);
  return vuole ? i.professione : null;
}
