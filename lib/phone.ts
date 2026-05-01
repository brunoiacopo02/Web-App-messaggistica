const DEFAULT_COUNTRY_PREFIX = '+39';

export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;

  // strip whatsapp: prefix
  s = s.replace(/^whatsapp:/i, '');

  // 0039... -> +39...
  if (s.startsWith('00')) s = '+' + s.slice(2);

  // remove spaces, dashes, parentheses, dots
  s = s.replace(/[\s().\-]/g, '');

  // se inizia con + ma non è valido, fallisci
  if (s.startsWith('+')) {
    return isValidE164(s) ? s : null;
  }

  // aggiungi prefisso default
  // ma solo se è puramente numerico
  if (!/^\d+$/.test(s)) return null;

  // rimuovi eventuale 0 iniziale (es. 0333... -> 333...)
  s = s.replace(/^0+/, '');

  if (s.length < 9 || s.length > 12) return null;

  const candidate = DEFAULT_COUNTRY_PREFIX + s;
  return isValidE164(candidate) ? candidate : null;
}

export function isValidE164(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^\+[1-9]\d{7,14}$/.test(s);
}
