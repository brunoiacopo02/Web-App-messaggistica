// Modulo puro e client-safe: nessun import da supabase/twilio (lo usa anche il simulatore).

/** Gli unici link che il bot deve mai mandare. */
export const KNOWN_LINKS = [
  'https://corso.feniceacademy.it/conferenza-axmsbn9r50',
  'https://corso.feniceacademy.it/conferenza-bx',
  'https://corso.feniceacademy.it/conferenza-dx',
  'https://corso.feniceacademy.it/conferenza-ex',
  'https://form.jotform.com/240755654585063',
] as const;

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Per ogni link noto, una regex che tollera spazi e tab (mai a-capo: non
 * dobbiamo mai fondere due bolle) tra un carattere e l'altro. */
const REPAIR = KNOWN_LINKS.map((link) => ({
  link,
  re: new RegExp(link.split('').map(escapeRe).join('[ \\t]*'), 'g'),
}));

/** Rimette a posto i link noti che il modello ha spezzato con spazi o tab. */
export function sanitizeOutbound(text: string): string {
  let out = text;
  for (const { link, re } of REPAIR) out = out.replace(re, link);
  return out;
}

const FENICE_LINK_RE = /https:\/\/corso\.feniceacademy\.it\/\S+/g;

/** Punteggiatura di chiusura frase che il testo puo attaccare in coda a un URL
 * (mai in mezzo: `corso.feniceacademy.it` ha punti legittimi). */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

/** URL del dominio dei video che non sono nella lista ufficiale: vanno loggati,
 * significa che il modello si e inventato un link. */
export function unknownFeniceLinks(text: string): string[] {
  const found = text.match(FENICE_LINK_RE) ?? [];
  const cleaned = found.map((u) => u.replace(TRAILING_PUNCT_RE, ''));
  return cleaned.filter((u) => !(KNOWN_LINKS as readonly string[]).includes(u));
}
