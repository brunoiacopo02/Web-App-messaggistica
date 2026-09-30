/**
 * Filtri e forma della pagina Log della console (`GET /api/console/log`).
 *
 * `event_log` è la tabella più grande del database (~17.000 righe al giorno): ogni lettura
 * ha una finestra su `created_at`, così la query scende sugli indici `(created_at desc, level)`
 * e `(type, created_at desc)` e non scandisce mai l'intera tabella, nemmeno con il filtro per
 * conversazione (che legge `payload->>conversationId`, senza indice).
 */

export const LIVELLI_LOG = ['info', 'warn', 'error'] as const;
export type LivelloLog = (typeof LIVELLI_LOG)[number];

/** Righe per pagina. */
export const LIMITE_LOG = 100;
/** Ampiezza della finestra di una lettura: dal cursore (o da adesso) indietro di 7 giorni. */
export const FINESTRA_LOG_MS = 7 * 24 * 3600_000;

export type RigaLog = {
  id: number;
  type: string;
  level: string;
  message: string | null;
  created_at: string;
  payload: unknown;
};

export type RispostaLog = {
  righe: RigaLog[];
  /** Il cursore della pagina dopo (`prima=`): l'ultima riga se la pagina è piena, altrimenti l'inizio della finestra. */
  prossimo: string;
  /** L'inizio della finestra letta: sotto questa data la pagina non ha guardato. */
  finestraDa: string;
  /** La pagina è piena: nella stessa finestra ci sono altre righe. */
  piena: boolean;
};

export type FiltriLog = { tipo: string | null; livello: LivelloLog | null; conv: number | null; prima: string | null };

const TIPO_VALIDO = /^[a-z0-9_.:-]{1,80}$/i;

/** Un timestamp ISO come lo scrive Postgres: fino ai microsecondi, con `Z` o con l'offset. */
const TIMESTAMP_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/**
 * Il cursore `prima=` così com'è arrivato, solo validato. Non passa da `Date`: `created_at` ha i
 * microsecondi e `toISOString()` li taglia ai millisecondi, e con `lt` a millisecondi le righe
 * dello stesso millesimo (ma con microsecondi minori) si salterebbero o si ripeterebbero.
 * Un `+` dell'offset arrivato non codificato nella query diventa uno spazio: si rimette.
 */
export function cursoreLog(grezzo: string): string | null {
  const s = grezzo.trim().replace(/(:\d{2}(?:\.\d{1,6})?) (\d{2}(?::?\d{2})?)$/, '$1+$2');
  if (!TIMESTAMP_ISO.test(s) || Number.isNaN(Date.parse(s))) return null;
  return s;
}

/** Legge e valida i parametri: `null` se uno è presente ma non valido (la rotta risponde 400). */
export function leggiFiltriLog(sp: URLSearchParams): FiltriLog | null {
  const pulito = (k: string) => sp.get(k)?.trim() || null;
  const tipo = pulito('tipo');
  const livello = pulito('livello');
  const conv = pulito('conv');
  const prima = pulito('prima');

  if (tipo !== null && !TIPO_VALIDO.test(tipo)) return null;
  if (livello !== null && !(LIVELLI_LOG as readonly string[]).includes(livello)) return null;
  if (conv !== null && !/^\d{1,12}$/.test(conv)) return null;
  const cursore = prima === null ? null : cursoreLog(prima);
  if (prima !== null && cursore === null) return null;

  return {
    tipo,
    livello: livello as LivelloLog | null,
    conv: conv === null ? null : Number(conv),
    prima: cursore,
  };
}

/** I filtri come query string della rotta, senza i vuoti. */
export function queryLog(f: Partial<FiltriLog>): string {
  const sp = new URLSearchParams();
  if (f.tipo) sp.set('tipo', f.tipo);
  if (f.livello) sp.set('livello', f.livello);
  if (f.conv !== null && f.conv !== undefined) sp.set('conv', String(f.conv));
  if (f.prima) sp.set('prima', f.prima);
  const s = sp.toString();
  return s ? `?${s}` : '';
}
