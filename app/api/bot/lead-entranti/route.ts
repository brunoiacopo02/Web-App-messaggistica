import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { checkRateLimit } from '@/lib/rate-limit';
import { fetchAllRows } from '@/lib/supabase/paginate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * I lead che il bot sta lavorando e che il CRM non ha mai visto.
 *
 * Chi ci scrive per primo su WhatsApp non e' passato da nessun form, quindi dal lato CRM
 * non esiste e non ha un `leadId`. Senza quel numero `canSendOutcome` vieta l'invio
 * dell'esito (`lib/fenice-autoreply.ts`): il bot puo' fissare un appuntamento e quello
 * non arriva da nessuna parte. Questo e' l'elenco da cui il CRM crea i lead mancanti;
 * appena ce li rimanda con l'intake, `crm_lead_id` si riempie e il lead esce dalla lista
 * da solo.
 *
 * Stessa autenticazione di `/api/bot/intake` e `/api/bot/contatti-umani`.
 * POST, corpo opzionale: `{ "limit": 500 }`.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`leadentranti:${ip}`, 30, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let opts: { limit?: number } = {};
  if (rawBody.trim() !== '') {
    try { opts = JSON.parse(rawBody) as typeof opts; }
    catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);

  const admin = getSupabaseAdmin();
  let convs: any[];
  try {
    // Il criterio e' esattamente "lo lavoriamo noi e voi non lo conoscete": preso in
    // carico da Mario, senza `crm_lead_id`. Ci finiscono sia gli adottati dal webhook
    // sia i pochi arruolati a mano da /api/fenice/enroll — anche quelli il CRM non li ha.
    convs = await fetchAllRows<any>((from, to) => admin
      .from('conversations')
      .select('id, crm_funnel, ai_status, bot_outcome, bot_scheduled_at, ai_started_at, last_message_at, leads(phone_e164, first_name, last_name)')
      .eq('ai_owner', 'mario')
      .is('crm_lead_id', null)
      // Chi e' passato a una persona non entra nella lista: il CRM ci manderebbe
      // l'intake sopra una chat che sta lavorando qualcuno in carne e ossa.
      .is('handed_off_at', null)
      .order('ai_started_at', { ascending: true, nullsFirst: true })
      .range(from, to));
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'errore' }, { status: 500 });
  }

  const scelte = convs.slice(0, limit);
  const lead = [];
  for (const c of scelte) {
    // Il primo messaggio del lead: e' con quello che si e' presentato, ed e' il testo da
    // cui abbiamo dedotto la provenienza. Al CRM serve per sapere chi sta creando.
    const { data: primi } = await admin
      .from('messages')
      .select('body, created_at')
      .eq('conversation_id', c.id)
      .eq('direction', 'in')
      .order('created_at', { ascending: true })
      .limit(1);
    const primo = (primi ?? [])[0] as { body: string | null; created_at: string } | undefined;
    const nome = [c.leads?.first_name, c.leads?.last_name].filter(Boolean).join(' ').trim();
    lead.push({
      telefono: (c.leads?.phone_e164 ?? null) as string | null,
      nome: nome || null,
      provenienza: (c.crm_funnel ?? 'INBOUND') as string,
      primoMessaggio: (primo?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null,
      scrittoIl: primo?.created_at ?? null,
      conversationId: c.id as number,
      statoBot: (c.ai_status ?? null) as string | null,
      // Valorizzati quando il bot ha gia' concluso prima che loro creassero il lead:
      // cosi' al momento della creazione sanno che quella persona ha gia' una call in
      // agenda, invece di scoprirlo al giro dopo.
      esito: (c.bot_outcome ?? null) as string | null,
      appuntamento: (c.bot_scheduled_at ?? null) as string | null,
    });
  }

  return NextResponse.json({ ok: true, totale: lead.length, lead });
}
