import { PROFESSIONI, nomeProfessione, type SlugProfessione } from './professioni';

/**
 * Template della scheda del corso per la campagna brochure (PO 10/11/2026).
 *
 * La campagna Meta promette il PDF del corso nel modulo. Il testo libero (`inviaScheda`)
 * parte solo a finestra delle 24 ore aperta: per mandare la scheda come PRIMO messaggio, o
 * a chi ha la finestra chiusa (es. Naomi), serve un template approvato. Due varianti,
 * create su tutti e tre gli account da scripts/crea-template-scheda-brochure.ts e chieste
 * come UTILITY (rispondono alla richiesta fatta nel modulo):
 *
 *  - `fenice_scheda_corso_v1`: corso noto, PDF come header documento.
 *      {{1}} nome proprio, {{2}} nome del corso, {{3}} file del PDF in public/schede/.
 *  - `fenice_scheda_scelta_corso_v1`: corso non noto ("Video 2 generale"), niente PDF e
 *      niente corso: chiede quale dei sei vuole conoscere, poi Mario manda la scheda giusta
 *      col testo libero (la finestra a quel punto e' aperta).
 *      {{1}} nome proprio.
 *
 * SID dell'account principale in `SCHEDA_TEMPLATE_SID` e `SCHEDA_SCELTA_TEMPLATE_SID`
 * (gli altri account li ritrovano per nome). Interruttore: `SCHEDA_TEMPLATE_ENABLED=1`.
 * Spento finche' Meta non li approva; anche acceso, parte solo se il template e'
 * approvato e spedibile dall'account del numero (vedi `templateSchedaApprovatoSu`).
 */
export const NOME_TEMPLATE_SCHEDA = 'fenice_scheda_corso_v1';
export const NOME_TEMPLATE_SCELTA_CORSO = 'fenice_scheda_scelta_corso_v1';

/** Host fisso del PDF: Meta accetta la variabile solo in coda al percorso. */
export const BASE_URL_SCHEDE = 'https://web-app-messaggistica.vercel.app/schede/';

export function testoTemplateScheda(nome: string, corso: string): string {
  return `Ciao ${nome}, ti scrivo da Fenice Academy: come richiesto nel modulo della nostra pubblicità, ti mando la scheda del corso di ${corso}. Dagli un'occhiata con calma, poi dimmi una cosa per capire da dove partire: oggi lavori o stai cercando lavoro?`;
}

/** I sei corsi nell'ordine del catalogo, scritti per il lead. */
export function elencoCorsi(): string {
  const nomi = PROFESSIONI.map((p) => p.nome);
  return `${nomi.slice(0, -1).join(', ')} o ${nomi[nomi.length - 1]}`;
}

export function testoTemplateSceltaCorso(nome: string): string {
  return `Ciao ${nome}, ti scrivo da Fenice Academy per la scheda del corso che hai richiesto nel modulo della nostra pubblicità. Così ti mando quella giusta: quale percorso vuoi conoscere tra ${elencoCorsi()}?`;
}

export function fileScheda(slug: SlugProfessione): string {
  const p = PROFESSIONI.find((x) => x.slug === slug);
  if (!p) throw new Error(`corso sconosciuto: ${slug}`);
  return p.file;
}

export type SceltaTemplateScheda =
  | { tipo: 'scheda'; envKey: 'SCHEDA_TEMPLATE_SID'; slug: SlugProfessione; variabili: Record<string, string>; testo: string }
  | { tipo: 'scelta_corso'; envKey: 'SCHEDA_SCELTA_TEMPLATE_SID'; variabili: Record<string, string>; testo: string };

/** Puro: quale delle due varianti, con variabili e testo da salvare in `messages`. */
export function templateSchedaPer(nome: string, slug: SlugProfessione | null): SceltaTemplateScheda {
  if (slug) {
    const corso = nomeProfessione(slug);
    return {
      tipo: 'scheda', envKey: 'SCHEDA_TEMPLATE_SID', slug,
      variabili: { '1': nome, '2': corso, '3': fileScheda(slug) },
      testo: testoTemplateScheda(nome, corso),
    };
  }
  return { tipo: 'scelta_corso', envKey: 'SCHEDA_SCELTA_TEMPLATE_SID', variabili: { '1': nome }, testo: testoTemplateSceltaCorso(nome) };
}

/** Interruttore generale (spento di default). */
export function templateSchedaAcceso(env: Record<string, string | undefined> = process.env): boolean {
  return env.SCHEDA_TEMPLATE_ENABLED === '1';
}
