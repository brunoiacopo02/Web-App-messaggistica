import { KNOWN_LINKS } from './outbound-sanitize';

/** Copy canonica del passaggio 4, non dipende dalla situazione del lead.
 * Deve restare identica a quella in lib/mario-prompt.ts. */
export const STEP4_TEXT = 'poi scrivimi FATTO qui quando l\'hai visto, così lo segno';

/** Testo del pitch del video (passaggio 3). Nel prompt (lib/mario-prompt.ts) le stesse
 * parole sono su tre righe distinte, cioè tre bolle separate quando il modello le genera
 * da sole. Qui sono un'unica stringa perché, quando il pitch manca del tutto, va anteposto
 * dentro la stessa bolla del link (una sola bolla in più, non tre): la formattazione
 * cambia per necessità strutturale, il contenuto resta identico. */
export const VIDEO_PITCH_TEXT =
  'Qui dentro ci sono le professioni, i pacchetti e le quote di investimento. Sono 20 minuti e servono perché in call partiamo dal tuo caso invece che dalle basi. Quando riesci a vederlo, stasera o domani?';

const VIDEO_LINKS = (KNOWN_LINKS as readonly string[]).filter((l) => l.includes('conferenza-'));

const hasVideoLink = (p: string) => VIDEO_LINKS.some((l) => p.includes(l));
const isStep4 = (p: string) => /\bFATTO\b/.test(p);

/**
 * Marcatori di CONTENUTO del pitch (non della lunghezza della bolla): in produzione il
 * pitch arriva a volte spezzato su più bolle attorno al link (conv 3312: "professioni/
 * pacchetti/quote" in una bolla, il link da solo, "20 minuti" e "quando riesci a vederlo"
 * in altre due), a volte fuso in un'unica bolla col link (conv 3349). In entrambi i casi
 * il pitch è presente e non va duplicato. Una bolla corta ma senza contenuto tipo
 * "dacci un'occhiata 👉 <link>" invece NON è un pitch, anche se non è "nuda".
 */
const PITCH_MARKERS: RegExp[] = [
  /professioni|pacchetti|quote\b|investimento/i, // di cosa parla il video
  /20\s*minuti/i, // durata
  /quando\s+(riesci|puoi)|stasera|domani/i, // invito a guardarlo
];
/** Bastano due marcatori su tre: tollera piccole riformulazioni del modello mantenendo
 * la capacità di distinguere il vero pitch dal semplice riempimento. */
const PITCH_PRESENCE_THRESHOLD = 2;

/** Vero se il pitch del video è già presente da qualche parte nel blocco, in una bolla
 * qualsiasi: il criterio guarda il contenuto dell'intero blocco, non la singola bolla
 * del link. */
const pitchPresent = (parts: string[]) => {
  const testo = parts.join('\n');
  return PITCH_MARKERS.filter((re) => re.test(testo)).length >= PITCH_PRESENCE_THRESHOLD;
};

/**
 * Garantisce che il blocco di conferma post-appuntamento arrivi completo:
 * il pitch del video presente da qualche parte nel blocco, e il passaggio FATTO in coda.
 * Non inventa mai il link: se manca lo segnala e basta.
 */
export function ensureConfirmationBlock(
  parts: string[],
): { parts: string[]; added: string[]; missingVideoLink: boolean } {
  const out = [...parts];
  const added: string[] = [];

  const videoIdx = out.findIndex(hasVideoLink);
  if (videoIdx >= 0 && !pitchPresent(out)) {
    out[videoIdx] = `${VIDEO_PITCH_TEXT} ${out[videoIdx].trim()}`;
    added.push('videoPitch');
  }

  if (!out.some(isStep4)) {
    out.push(STEP4_TEXT);
    added.push('step4');
  }

  return { parts: out, added, missingVideoLink: videoIdx < 0 };
}
