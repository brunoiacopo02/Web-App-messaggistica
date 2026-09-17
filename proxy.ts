import { type NextRequest, NextResponse } from 'next/server';
import { refreshSession } from '@/lib/supabase/middleware';
import { canAccess, landingPath } from '@/lib/access';

// /api/bot è macchina-a-macchina: si autentica via firma HMAC, mai via sessione.
// Va esentato dal redirect a /login (come /api/webhooks e /api/cron).
// `/api/admin/secondo-numero` sta qui per lo stesso motivo di `/api/cron`: si
// autentica da se' con un segreto proprio (ADMIN_TOOLS_SECRET), non con una
// sessione. E' elencato per percorso ESATTO e non come `/api/admin`, cosi' una
// rotta admin aggiunta domani non si trova esentata senza che nessuno l'abbia
// deciso.
const PUBLIC_PATHS = ['/login', '/api/webhooks', '/api/cron', '/api/bot', '/api/send-agenda', '/api/send-template', '/api/admin/secondo-numero'];

export async function proxy(request: NextRequest) {
  const { response, user } = await refreshSession(request);
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('from', path);
    return NextResponse.redirect(url);
  }

  if (user && path === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = landingPath(user.email);
    return NextResponse.redirect(url);
  }

  // Gate per area: un utente fenice-only fuori da /fenice -> torna a /fenice
  if (user && !isPublic && !canAccess(user.email, path)) {
    if (path.startsWith('/api')) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const url = request.nextUrl.clone();
    url.pathname = landingPath(user.email);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
