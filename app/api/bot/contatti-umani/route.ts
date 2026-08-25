import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { checkRateLimit } from '@/lib/rate-limit';
import { motivoRichiesta, type MessaggioIn } from '@/lib/contatti-umani';
import { fetchAllRows } from '@/lib/supabase/paginate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * L'elenco dei lead che hanno chiesto di parlare con una persona.
 *
 * Il `CONTATTO_UMANO` che mandiamo al CRM al momento della richiesta è una notifica:
 * arriva una volta e, se nessuno la vede, il lead resta lì. Questo endpoint è l'elenco
 * completo, sempre interrogabile, da cui il CRM può popolare la sua sezione "da
 * assegnare": chi ha chiesto, quando, con che parole e per che motivo.
 *
 * POST perché la firma HMAC si calcola sul corpo, come per `/api/bot/intake`.
 * Corpo (tutto opzionale): `{ "stato": "aperti" | "tutti", "limit": 500 }`.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`contattiumani:${ip}`, 30, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let opts: { stato?: string; limit?: number } = {};
  if (rawBody.trim() !== '') {
    try { opts = JSON.parse(rawBody) as typeof opts; }
    catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }
  }
  const soloAperti = opts.stato !== 'tutti';
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);

  const admin = getSupabaseAdmin();
  let convs: any[];
  try {
    convs = await fetchAllRows<any>((from, to) => {
      let q = admin
        .from('conversations')
        .select('id, crm_lead_id, ai_status, bot_outcome, last_message_at, ai_started_at, leads(phone_e164, first_name, last_name)')
        .eq('ai_owner', 'mario')
        .eq('ai_status', 'handed_off')
        .not('crm_lead_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, to);
      // "aperti" = nessuno ha ancora chiuso il lead da parte nostra. Con `tutti` si
      // rileggono anche quelli già esitati, per una riconciliazione.
      if (soloAperti) q = q.is('bot_outcome', null);
      return q;
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'errore' }, { status: 500 });
  }

  // Il motivo registrato al momento del passaggio, quando c'è. La colonna è recente
  // (migration 20260825000001): se manca, si resta all'euristica sui messaggi e
  // l'endpoint continua a rispondere.
  const motivoRegistrato = new Map<number, { at: string | null; reason: string | null }>();
  {
    const { data: extra } = await admin
      .from('conversations')
      .select('id, handed_off_at, handed_off_reason')
      .eq('ai_owner', 'mario')
      .eq('ai_status', 'handed_off')
      .limit(1000);
    for (const r of (extra ?? []) as any[]) {
      motivoRegistrato.set(r.id, { at: r.handed_off_at ?? null, reason: r.handed_off_reason ?? null });
    }
  }

  const scelte = convs.slice(0, limit);
  const lead = [];
  for (const c of scelte) {
    const { data: msgs } = await admin
      .from('messages')
      .select('body, created_at')
      .eq('conversation_id', c.id)
      .eq('direction', 'in')
      .gte('created_at', c.ai_started_at ?? '1970-01-01')
      .order('created_at', { ascending: true })
      .limit(200);
    const euristico = motivoRichiesta((msgs ?? []) as MessaggioIn[]);
    const registrato = motivoRegistrato.get(c.id);
    // Registrato batte euristico: sono le parole vere del turno in cui il bot ha
    // passato la chat, non il messaggio che gli somiglia di più.
    const motivo = registrato?.reason
      ? motivoRichiesta([{ body: registrato.reason, created_at: registrato.at ?? c.last_message_at ?? new Date(0).toISOString() }])
      : euristico;
    const nome = [c.leads?.first_name, c.leads?.last_name].filter(Boolean).join(' ').trim();
    lead.push({
      leadId: c.crm_lead_id as string,
      conversationId: c.id as number,
      phone: (c.leads?.phone_e164 ?? null) as string | null,
      nome: nome || null,
      richiestoIl: motivo.richiestoIl,
      motivoRegistrato: Boolean(registrato?.reason),
      motivo: motivo.categoria,
      paroleDelLead: motivo.parole,
      ultimoMessaggioIl: (c.last_message_at ?? null) as string | null,
      esitoBot: (c.bot_outcome ?? null) as string | null,
      // Il contesto per chi richiamerà: la categoria è un aiuto, non la verità. Su una
      // richiesta generica ("se ci incagliamo già su questo…") sono queste righe a
      // dire all'operatore con cosa ha a che fare.
      ultimiMessaggi: ((msgs ?? []) as MessaggioIn[])
        .filter((m) => (m.body ?? '').trim() !== '')
        .slice(-3)
        .map((m) => ({ quando: m.created_at, testo: (m.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) })),
    });
  }

  // Prima chi aspetta da più tempo: è l'ordine in cui vanno assegnati.
  lead.sort((a, b) => String(a.richiestoIl ?? '').localeCompare(String(b.richiestoIl ?? '')));

  return NextResponse.json({ ok: true, count: lead.length, troncato: convs.length > scelte.length, lead });
}
