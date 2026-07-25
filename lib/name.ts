// Normalizzazione del nome del lead per i messaggi in uscita.
//
// Il CRM ha un campo unico `name` con nome E cognome (43% dei record contiene uno
// spazio), più sporcizia varia: MAIUSCOLO, minuscolo, email, numeri di telefono,
// segnaposto. Scrivere "Ciao Mario Rossi" su WhatsApp è la firma del mail-merge e
// alimenta la paura numero uno dei nostri lead ("potrebbe essere una truffa").
// Qui si normalizza al momento dell'invio: il DB conserva il nome completo (serve
// in inbox), gli invii usano solo il nome proprio.

const LETTER = "A-Za-zÀ-ÖØ-öø-ÿ'’\\-";
const VALID_TOKEN = new RegExp(`^[${LETTER}]{2,}$`);
const EDGE_JUNK = new RegExp(`^[^${LETTER}]+|[^${LETTER}]+$`, 'g');

/** Segnaposto visti nel campo nome: mai usarli come vocativo. */
const PLACEHOLDERS = new Set([
  'test', 'prova', 'asd', 'xxx', 'admin', 'nessuno', 'nome', 'cognome',
  'cliente', 'utente', 'privato',
]);

/** Se una QUALSIASI parola è una ragione sociale, il campo non è un nome di persona. */
const COMPANY_MARKERS = new Set(['azienda', 'ditta', 'srl', 'spa', 'sas', 'snc', 'sl']);

/** Vocativo neutro per i template Meta: la variabile {{1}} non può restare vuota
 * (il body è "Ciao {{1}},") e "benvenuto" sbagliava il genere a metà dei lead. */
export const NEUTRAL_VOCATIVE = 'a te';

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|['’-])([a-zà-öø-ÿ])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Solo il nome proprio, normalizzato; `null` se il campo non contiene un nome usabile. */
export function firstNameOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const words = raw.trim().split(/\s+/);
  if (words.some((w) => COMPANY_MARKERS.has(w.replace(EDGE_JUNK, '').toLowerCase()))) return null;
  const cleaned = (words[0] ?? '').replace(EDGE_JUNK, '');
  if (!VALID_TOKEN.test(cleaned)) return null;
  if (PLACEHOLDERS.has(cleaned.toLowerCase())) return null;
  return titleCase(cleaned);
}

/** Valore della variabile {{1}} dei template: nome proprio o vocativo neutro. */
export function templateName(raw: string | null | undefined): string {
  return firstNameOf(raw) ?? NEUTRAL_VOCATIVE;
}
