// Mappa email -> area consentita. Nessun ruolo nel DB (scelta: dati condivisi).
// 'fenice' = solo /fenice. 'campagne' = solo /campagne-chat. 'chat' = solo /chat. 'all' = tutto.
export type Area = 'fenice' | 'campagne' | 'chat' | 'all';

const FENICE_ONLY = new Set(['fenicebot@fenice.com']);
const CAMPAGNE_ONLY = new Set(['campagne@fenice.com']);
const CHAT_ONLY = new Set(['fenice@academy.com']);

export function areaForEmail(email: string | null | undefined): Area {
  const e = email?.toLowerCase();
  if (e && FENICE_ONLY.has(e)) return 'fenice';
  if (e && CAMPAGNE_ONLY.has(e)) return 'campagne';
  if (e && CHAT_ONLY.has(e)) return 'chat';
  return 'all';
}

/** True se l'utente può aprire il path dato. */
export function canAccess(email: string | null | undefined, path: string): boolean {
  const area = areaForEmail(email);
  if (area === 'all') return true;
  if (area === 'campagne') {
    return path === '/campagne-chat' || path.startsWith('/campagne-chat/')
      || path === '/api/campagne-chat' || path.startsWith('/api/campagne-chat/');
  }
  if (area === 'chat') {
    return path === '/chat' || path.startsWith('/chat/')
      || path === '/api/chat' || path.startsWith('/api/chat/');
  }
  // fenice-only: solo /fenice (e relative API)
  return path === '/fenice' || path.startsWith('/fenice/')
    || path === '/api/fenice' || path.startsWith('/api/fenice/');
}

/** Dove mandare l'utente dopo il login. */
export function landingPath(email: string | null | undefined): string {
  const area = areaForEmail(email);
  if (area === 'fenice') return '/fenice';
  if (area === 'campagne') return '/campagne-chat';
  if (area === 'chat') return '/chat';
  return '/inbox';
}
