import { PROFESSIONI, isSlugProfessione, nomeProfessione, type SlugProfessione } from './professioni';

/**
 * Nota di contesto per chi arriva dal funnel Professioni (spec §2). Sta nella parte
 * variabile del prompt: il manuale di Mario resta identico e la cache non si rompe.
 */
export function professioniContextNote(slug: SlugProfessione | null): string {
  const corso = slug
    ? `Il corso che ha scelto e' ${nomeProfessione(slug)}.`
    : `Non sappiamo ancora quale corso: chiediglielo (falso bivio se e' indeciso). Slug possibili: ${PROFESSIONI.map((p) => p.slug).join(', ')}.`;
  const tag = slug ? `[SCHEDA:${slug}]` : '[SCHEDA:<slug>]';
  return [
    'CONTESTO FUNNEL PROFESSIONI: questo lead ci ha scritto per primo dalla pagina delle professioni e ha chiesto la scheda del corso.',
    corso,
    "APERTURA: digli che gli mandi volentieri la scheda del corso e che prima gli fai qualche domanda per capire cosa gli serve. Poi segui il flusso normale (situazione, famiglia, motivazioni, pitch con i prezzi, call, Noemi).",
    "LA SCHEDA ARRIVA DOPO L'APPUNTAMENTO: quando ha fissato, la scheda gli arriva in automatico insieme al video. Non mandarla prima e non promettere che arriva subito.",
    `SE INSISTE per averla prima di fissare (es. "mi avevate detto che me la mandavate"): mandala insieme al pitch, prezzi compresi, e nello stesso messaggio proponi comunque la call. Per mandarla scrivi in fondo al messaggio il tag ${tag}.`,
    `SE RIMANDA LA CALL PER GUARDARE PRIMA LA SCHEDA: mandala col tag ${tag} e prendi un impegno sul quando: deve averla vista entro domani, ci vogliono due minuti. Il quando lo dice lui (regola "PRIMA GUARDO IL CORSO").`,
    `Il tag ${tag} lo usi al massimo una volta: se la scheda e' gia' partita non rimandarla.`,
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
