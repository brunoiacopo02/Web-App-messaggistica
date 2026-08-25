import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { segmentOf } from '@/lib/lead-segments';
import { extractLeadInsight, aggregateInsights, normalizeStage, type LeadInsight, type ObjectionCategory } from '@/lib/lead-analysis';
import type { MarioTurn } from '@/lib/mario';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// 40 per run con un cron giornaliero voleva dire 40 analisi al giorno contro 78-300
// lead in ingresso: l'arretrato non si chiudeva mai (765 conversazioni analizzate su
// quasi 2.000). Il cron ora gira ogni ora, e il tetto per run tiene conto dei 300s.
const MAX_PER_RUN = 120;

// La funzione muore a 300s. Ci si ferma prima e si scrive comunque l'aggregato: un run
// troncato da Vercel non logga niente, e sembra che il cron non sia mai partito.
const BUDGET_MS = 240_000;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const admin = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Tutte le conversazioni Mario per conteggi + selezione estrazioni.
  // Paginate: `.limit(5000)` ne tornava 1.000 (tetto PostgREST) e per giunta sempre le
  // stesse, cioè le più vecchie — già analizzate. Il cron girava a vuoto (1 estrazione
  // per run contro 1.600 di arretrato) senza dare nessun errore.
  let convs: any[];
  try {
    convs = await fetchAllRows<any>((from, to) => admin
      .from('conversations')
      .select('id, ai_status, bot_outcome, last_inbound_at, last_message_at, ai_started_at, ai_insight_at, ai_dropoff_stage, ai_objection_category, ai_objection_note')
      .eq('ai_owner', 'mario')
      .order('id', { ascending: true })
      .range(from, to));
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'errore' }, { status: 500 });
  }

  const respondedNotTaken = convs.filter((c: any) =>
    c.last_inbound_at && c.bot_outcome !== 'APPUNTAMENTO');
  const maiRisposto = convs.filter((c: any) =>
    segmentOf({ bot_outcome: c.bot_outcome ?? null, last_inbound_at: c.last_inbound_at ?? null, ai_status: c.ai_status ?? null }, now) === 'MAI_RISPOSTO').length;

  // Selezione da (ri)analizzare. Mai analizzate PRIMA delle già analizzate da
  // aggiornare: con un tetto per run, mescolarle significa rianalizzare sempre le
  // stesse e non arrivare mai in fondo all'arretrato. A parità, le più recenti prima.
  const daFare = respondedNotTaken.filter((c: any) =>
    !c.ai_insight_at || (c.last_message_at && c.last_message_at > c.ai_insight_at));
  const perRecenza = (a: any, b: any) => String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? ''));
  const stale = [
    ...daFare.filter((c: any) => !c.ai_insight_at).sort(perRecenza),
    ...daFare.filter((c: any) => c.ai_insight_at).sort(perRecenza),
  ].slice(0, MAX_PER_RUN);

  let extracted = 0;
  let falliti = 0;
  let errori = 0;
  let esaurito = false;
  const scadenza = Date.now() + BUDGET_MS;
  for (const c of stale as any[]) {
    if (Date.now() > scadenza) { esaurito = true; break; }
    const { data: msgs } = await admin
      .from('messages')
      .select('direction, body, created_at')
      .eq('conversation_id', c.id)
      .gte('created_at', c.ai_started_at ?? '1970-01-01')
      .order('created_at', { ascending: true })
      .limit(200);
    const history: MarioTurn[] = (msgs ?? []).map((m: any) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));
    if (history.length === 0) continue;
    try {
      const res = await extractLeadInsight(history);
      // Un'estrazione fallita NON si scrive: prima diventava "non chiaro" + "altro" +
      // nota vuota, con ai_insight_at valorizzato, quindi non veniva mai più riprovata
      // e inquinava l'aggregato (741 casi su 765). Lasciandola non scritta, il prossimo
      // run ci riprova, e il log dice quante ne stiamo perdendo.
      if (!res.ok) {
        falliti++;
        await admin.from('event_log').insert({
          type: 'lead_insight_failed',
          payload: { conversationId: c.id, motivo: res.motivo, raw: res.raw.slice(0, 300) } as never,
          message: `[lead-analysis] estrazione fallita su conv ${c.id}: ${res.motivo}`,
          level: 'warn',
        });
        continue;
      }
      const { error: updateErr } = await admin.from('conversations').update({
        ai_dropoff_stage: res.insight.dropoffStage,
        ai_objection_category: res.insight.objectionCategory,
        ai_objection_note: res.insight.objectionNote,
        ai_insight_at: new Date().toISOString(),
      }).eq('id', c.id);
      if (updateErr) continue;
      extracted++;
    } catch (e) {
      // Prima questo catch era muto: un'API Anthropic che rifiuta (429, 529, credito a
      // zero) faceva sembrare il run riuscito con 0 estrazioni.
      errori++;
      if (errori <= 3) {
        await admin.from('event_log').insert({
          type: 'lead_insight_error',
          payload: { conversationId: c.id, error: e instanceof Error ? e.message : String(e) } as never,
          message: `[lead-analysis] errore su conv ${c.id}: ${e instanceof Error ? e.message : 'errore'}`,
          level: 'error',
        });
      }
    }
  }

  // Rileggi gli insight in cache (dopo gli update) per l'aggregato
  const cached = await fetchAllRows<any>((from, to) => admin
    .from('conversations')
    .select('ai_dropoff_stage, ai_objection_category, ai_objection_note, last_inbound_at, bot_outcome')
    .eq('ai_owner', 'mario')
    .not('ai_insight_at', 'is', null)
    .order('id', { ascending: true })
    .range(from, to)).catch(() => [] as any[]);

  // Le righe scritte prima del 24/08/2026 portano il vecchio fallback ("non chiaro" +
  // "altro" + nota vuota) di un'estrazione fallita: sono 741 su 765 e non sono analisi.
  // Fuori dall'aggregato, altrimenti continuano a dire che il 97% dei lead si blocca in
  // un punto imprecisato. Verranno rianalizzate ai prossimi run.
  const analisiFinta = (c: any) =>
    c.ai_dropoff_stage === 'non chiaro' && c.ai_objection_category === 'altro' && !c.ai_objection_note;

  const insights: LeadInsight[] = cached
    .filter((c: any) => c.last_inbound_at && c.bot_outcome !== 'APPUNTAMENTO' && c.ai_objection_category)
    .filter((c: any) => !analisiFinta(c))
    .map((c: any) => ({
      dropoffStage: normalizeStage(c.ai_dropoff_stage ?? ''),
      objectionCategory: (c.ai_objection_category ?? 'altro') as ObjectionCategory,
      objectionNote: c.ai_objection_note ?? '',
    }));

  const report = await aggregateInsights({ insights, maiRisposto, respondedNotTaken: respondedNotTaken.length });

  await admin.from('lead_analysis_reports').insert({ period: 'all', payload: report as any });
  await admin.from('event_log').insert({
    type: 'lead_analysis', level: 'info',
    message: `analisi lead: ${extracted} estratti, ${falliti} falliti, ${errori} in errore, ${insights.length} in aggregato${esaurito ? ' (tempo esaurito)' : ''}`,
    payload: { extracted, falliti, errori, esaurito, daFare: daFare.length, insights: insights.length, capped: stale.length === MAX_PER_RUN },
  });

  return NextResponse.json({ ok: true, extracted, falliti, errori, esaurito, daFare: daFare.length, aggregated: insights.length, capped: stale.length === MAX_PER_RUN });
}
