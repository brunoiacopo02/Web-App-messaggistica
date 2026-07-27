import { KNOWN_LINKS } from './outbound-sanitize';

/** Copy canonica dei passaggi che non dipendono dalla situazione del lead.
 * Deve restare identica a quella in lib/mario-prompt.ts. */
export const STEP4_TEXT = 'poi scrivimi FATTO qui quando l\'hai visto, così lo segno';
export const VIDEO_PITCH_TEXT =
  'Qui dentro ci sono le professioni, i pacchetti e le quote di investimento. Sono 20 minuti e servono perché in call partiamo dal tuo caso invece che dalle basi. Quando riesci a vederlo, stasera o domani?';

const VIDEO_LINKS = (KNOWN_LINKS as readonly string[]).filter((l) => l.includes('conferenza-'));

const hasVideoLink = (p: string) => VIDEO_LINKS.some((l) => p.includes(l));
const isStep4 = (p: string) => /\bFATTO\b/.test(p);
/** Il link e "nudo" se nella sua bolla non c'e nient'altro di sostanziale. */
const isBareLink = (p: string) => {
  const senzaLink = VIDEO_LINKS.reduce((acc, l) => acc.split(l).join(''), p).replace(/[\s👉]/g, '');
  return senzaLink.length < 12;
};

/**
 * Garantisce che il blocco di conferma post-appuntamento arrivi completo:
 * il link video accompagnato dal suo testo, e il passaggio FATTO in coda.
 * Non inventa mai il link: se manca lo segnala e basta.
 */
export function ensureConfirmationBlock(
  parts: string[],
): { parts: string[]; added: string[]; missingVideoLink: boolean } {
  const out = [...parts];
  const added: string[] = [];

  const videoIdx = out.findIndex(hasVideoLink);
  if (videoIdx >= 0 && isBareLink(out[videoIdx])) {
    out[videoIdx] = `${VIDEO_PITCH_TEXT} ${out[videoIdx].trim()}`;
    added.push('videoPitch');
  }

  if (!out.some(isStep4)) {
    out.push(STEP4_TEXT);
    added.push('step4');
  }

  return { parts: out, added, missingVideoLink: videoIdx < 0 };
}
