import { Suspense } from 'react';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase/server';
import { puoVedereMonitorLancio } from '@/lib/access';
import { MonitorLancio } from './_components/MonitorLancio';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Monitor lancio' };

/**
 * Monitor del lancio "Web Developer AI" (decisione PO 3, 25/09/2026): numeri live,
 * chat, pulsante del webinar e avvisi. Sola lettura: l'unica azione e' il link alle
 * Impostazioni, dove stanno gli interruttori.
 */
export default async function MonitorLancioPage() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!puoVedereMonitorLancio(user?.email)) {
    return (
      <div className="lm flex h-full items-center justify-center px-4">
        <div className="max-w-sm text-sm">
          <h1 className="text-base font-semibold">Monitor riservato agli admin</h1>
          <p className="mt-1 text-[var(--lm-muted)]">
            Questa pagina mostra nomi, telefoni e chat di tutti gli iscritti al lancio. Con questo account si vedono le{' '}
            <Link href="/fenice/impostazioni" className="underline underline-offset-2">Impostazioni</Link> del lancio.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="lm h-full" />}>
      <MonitorLancio />
    </Suspense>
  );
}
