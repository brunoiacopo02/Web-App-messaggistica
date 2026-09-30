import type { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { calcolaAvvisi, type EventoMonitor } from '@/lib/lancio-monitor';
import { fotografia } from '@/lib/lancio-monitor-db';
import { avvisiSistema, componiAvvisi, TIPI_SISTEMA, type AvvisoConsole } from './avvisi';

type Supa = ReturnType<typeof getSupabaseAdmin>;
type Pagina<T> = { data: T[] | null; error: { message: string } | null };
// Le letture di event_log non sono tipizzate: lo stesso cast di `lancio-monitor-db`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Grezzo = { from: (t: string) => any };
const grezzo = (s: Supa) => s as unknown as Grezzo;

const COLONNE = 'id, type, created_at, level, message, payload';
const GIORNO = 24 * 3600_000;

/**
 * Tutti gli avvisi della Console: quelli del lancio (`calcolaAvvisi`, gli stessi del monitor),
 * quelli di sistema (eventi delle ultime 24 h e cron fermi), meno quelli segnati risolti
 * finche' la loro firma non cambia.
 */
export async function leggiAvvisi(s: Supa, now: Date): Promise<AvvisoConsole[]> {
  const da24 = new Date(now.getTime() - GIORNO).toISOString();
  const da7 = new Date(now.getTime() - 7 * GIORNO).toISOString();

  const [foto, eventi, ultimoFollowups, righeRisolti] = await Promise.all([
    fotografia(s, now),
    fetchAllRows<EventoMonitor>(
      (a, b) =>
        grezzo(s).from('event_log').select(COLONNE)
          .in('type', Object.keys(TIPI_SISTEMA)).gte('created_at', da24)
          .order('created_at', { ascending: false }).range(a, b) as PromiseLike<Pagina<EventoMonitor>>,
      { max: 20_000 },
    ),
    grezzo(s).from('event_log').select('created_at')
      .eq('type', 'bot_followups_run').order('created_at', { ascending: false }).limit(1) as PromiseLike<Pagina<{ created_at: string }>>,
    fetchAllRows<EventoMonitor>(
      (a, b) =>
        grezzo(s).from('event_log').select(COLONNE)
          .eq('type', 'console_avviso_risolto').gte('created_at', da7)
          .order('created_at', { ascending: false }).range(a, b) as PromiseLike<Pagina<EventoMonitor>>,
    ),
  ]);
  if (ultimoFollowups.error) throw new Error(ultimoFollowups.error.message);

  const lancio = calcolaAvvisi({
    now,
    settings: foto.settings,
    chats: foto.chats,
    eventi: foto.eventiAvviso,
    statiTwilio: foto.statiTwilio,
    ultimiRun: foto.ultimiRun,
    colonnaInizio: foto.colonnaInizio,
  });

  // Dal piu' recente: vince la prima riga vista per ogni id.
  const risolti = new Map<string, string>();
  for (const r of righeRisolti) {
    const id = r.payload?.id;
    const firma = r.payload?.firma;
    if (typeof id === 'string' && typeof firma === 'string' && !risolti.has(id)) risolti.set(id, firma);
  }

  const sistema = avvisiSistema(eventi, { 'bot-followups': ultimoFollowups.data?.[0]?.created_at ?? null }, now);
  return componiAvvisi(lancio, sistema, risolti);
}
