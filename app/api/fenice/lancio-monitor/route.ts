import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { puoVedereMonitorLancio } from '@/lib/access';
import { calcolaAvvisi, calcolaContatori, filtraChat, leggiFiltri, PER_PAGINA } from '@/lib/lancio-monitor';
import { arricchisciPagina, consegne, fotografia } from '@/lib/lancio-monitor-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Monitor del lancio (GET, sola lettura): testata, avvisi e una pagina della lista chat.
 * Tutto in una risposta: la pagina la richiede ogni 30 secondi e a ogni cambio di filtro,
 * e la fotografia sotto e' in cache per 20 secondi, quindi un cambio di filtro non
 * rilegge il DB.
 *
 * Porte: la sessione (401) e l'area admin (403). Nessuna scrittura, da nessuna parte.
 */
export async function GET(req: NextRequest) {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  if (!puoVedereMonitorLancio(user.email)) return NextResponse.json({ error: 'solo_admin' }, { status: 403 });

  const admin = getSupabaseAdmin();
  const now = new Date();
  try {
    const foto = await fotografia(admin, now);
    // Le consegne sono la lettura piu' lenta: se falliscono la pagina resta in piedi
    // con i contatori di consegna a "n/d" e l'errore detto, invece di un 500.
    let cons: Awaited<ReturnType<typeof consegne>> | null = null;
    let erroreConsegne: string | null = null;
    try {
      cons = await consegne(admin, foto, now);
    } catch (e) {
      erroreConsegne = e instanceof Error ? e.message : 'errore';
    }

    const filtri = leggiFiltri(req.nextUrl.searchParams);
    const problemi = cons?.consegne.problemi ?? new Set<number>();
    const lista = filtraChat(foto.chats, filtri, { pulsante: foto.pulsante, problemi });
    const { anteprime, ultimoBot } = await arricchisciPagina(admin, lista.righe.map((c) => c.id));

    return NextResponse.json({
      generatoAt: foto.generatoAt,
      consegneAt: cons?.at ?? null,
      erroreConsegne,
      colonnaInizio: foto.colonnaInizio,
      impostazioni: {
        attivo: foto.settings.attivo,
        pulsanteAttivo: foto.settings.pulsanteAttivo,
        eventoAt: foto.settings.eventoAt,
        blastPerimetro: foto.settings.blastPerimetro,
        videoLiveLink: !!foto.settings.videoLiveLink,
        zoomLink: !!foto.settings.zoomLink,
      },
      contatori: calcolaContatori(foto.chats, foto.eventiContatori, cons?.consegne ?? null, foto.colonnaInizio),
      avvisi: calcolaAvvisi({
        now,
        settings: foto.settings,
        chats: foto.chats,
        eventi: foto.eventiAvviso,
        statiTwilio: foto.statiTwilio,
        ultimiRun: foto.ultimiRun,
        colonnaInizio: foto.colonnaInizio,
      }),
      lista: {
        totale: lista.totale,
        pagina: filtri.pagina,
        perPagina: PER_PAGINA,
        righe: lista.righe.map((c) => ({
          ...c,
          anteprima: anteprime.get(c.id) ?? null,
          ultimoDelLead: !!c.lastInboundAt && (!c.lastMessageAt || Date.parse(c.lastInboundAt) >= Date.parse(c.lastMessageAt) - 1000),
          ultimoBot: ultimoBot.get(c.id) ?? null,
          pulsante: foto.pulsante.has(c.id),
          problemi: problemi.has(c.id),
        })),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'lettura_fallita', dettaglio: e instanceof Error ? e.message : 'errore' },
      { status: 500 },
    );
  }
}
