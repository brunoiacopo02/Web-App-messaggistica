// Mappa email -> area consentita. Nessun ruolo nel DB (scelta: dati condivisi).
// 'fenice' = solo /fenice. 'all' = CRM completo + /fenice.
export type Area = 'fenice' | 'all';

const FENICE_ONLY = new Set(['fenicebot@fenice.com']);

export function areaForEmail(email: string | null | undefined): Area {
  if (email && FENICE_ONLY.has(email.toLowerCase())) return 'fenice';
  return 'all';
}

/** True se l'utente può aprire il path dato. */
export function canAccess(email: string | null | undefined, path: string): boolean {
  if (areaForEmail(email) === 'all') return true;
  // fenice-only: solo /fenice (e relative API)
  return path === '/fenice' || path.startsWith('/fenice/')
    || path === '/api/fenice' || path.startsWith('/api/fenice/');
}

/** Dove mandare l'utente dopo il login. */
export function landingPath(email: string | null | undefined): string {
  return areaForEmail(email) === 'fenice' ? '/fenice' : '/inbox';
}
