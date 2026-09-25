import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { puoVedereMonitorLancio } from '@/lib/access';
import { leggiDettaglio, nomeTemplateDaEnv, nomeTemplateTwilio } from '@/lib/lancio-monitor-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dettaglio di una chat per il monitor del lancio (GET, sola lettura): tutti i messaggi,
 * col nome dei template e lo stato Twilio, e gli eventi della chat in timeline.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  if (!puoVedereMonitorLancio(user.email)) return NextResponse.json({ error: 'solo_admin' }, { status: 403 });

  const { id: raw } = await params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'id_non_valido' }, { status: 400 });

  try {
    const d = await leggiDettaglio(getSupabaseAdmin(), id);
    if (!d.chat) return NextResponse.json({ error: 'chat_non_trovata' }, { status: 404 });

    // Il nome dei template: prima le env (gratis), poi Twilio per quelli rimasti.
    const sids = [...new Set(d.messaggi.map((m) => m.template_sid).filter((s): s is string => !!s))];
    const nomi: Record<string, string | null> = {};
    await Promise.all(sids.map(async (sid) => {
      nomi[sid] = nomeTemplateDaEnv(sid) ?? (await nomeTemplateTwilio(sid));
    }));

    return NextResponse.json({
      chat: d.chat,
      colonnaInizio: d.colonnaInizio,
      messaggi: d.messaggi.map((m) => ({ ...m, templateNome: m.template_sid ? nomi[m.template_sid] ?? null : null })),
      eventi: d.eventi,
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'lettura_fallita', dettaglio: e instanceof Error ? e.message : 'errore' },
      { status: 500 },
    );
  }
}
