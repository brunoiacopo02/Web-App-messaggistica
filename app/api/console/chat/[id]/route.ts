import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { richiediAdmin } from '@/lib/console/guardia';
import { isConversazioneChat, mondoDi } from '@/lib/chat-perimetro';
import { contestoRiga } from '@/lib/console/viste';
import { TIPI_EVENTI_THREAD } from '@/lib/console/thread';
import { idsConErrori } from '@/lib/console/viste-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TRENTA_GIORNI = 30 * 24 * 3600_000;
const MAX_EVENTI = 60;
/** Tetto di tempo per gli eventi: in produzione la query è stata vista a 8,5 s. Oltre, la chat si apre senza. */
const TETTO_EVENTI_MS = 3000;

type RigaEvento = { created_at: string; type: string; message: string | null; level: string };

/** Legge gli eventi senza mai far fallire la rotta: errore o timeout diventano `null`. */
async function leggiEventi(s: ReturnType<typeof getSupabaseAdmin>, convId: number, now: Date): Promise<RigaEvento[] | null> {
  try {
    const r = await s
      .from('event_log')
      .select('created_at, type, message, level')
      .in('type', [...TIPI_EVENTI_THREAD])
      .eq('payload->>conversationId', String(convId))
      .gte('created_at', new Date(now.getTime() - TRENTA_GIORNI).toISOString())
      .order('created_at', { ascending: false })
      .limit(MAX_EVENTI)
      .abortSignal(AbortSignal.timeout(TETTO_EVENTI_MS));
    return r.error ? null : ((r.data ?? []) as RigaEvento[]);
  } catch {
    return null;
  }
}

const COLONNE =
  'id, ai_owner, ai_status, ai_paused_at, bot_outcome, bot_scheduled_at, lancio_fase, lancio_slug, wa_number, ' +
  'crm_lead_id, ai_summary, handed_off_reason, last_inbound_at, gdo_agenda_at, gdo_video_sent_at, campaign_id, ' +
  'unread_count, lead:leads(id, first_name, last_name, phone_e164)';

type RigaConv = {
  id: number; ai_owner: string | null; ai_status: string | null; ai_paused_at: string | null;
  bot_outcome: string | null; bot_scheduled_at: string | null; lancio_fase: string | null; lancio_slug: string | null;
  wa_number: string | null; crm_lead_id: string | null; ai_summary: string | null; handed_off_reason: string | null;
  last_inbound_at: string | null; gdo_agenda_at: string | null; gdo_video_sent_at: string | null;
  campaign_id: number | null; unread_count: number | null;
  lead: { id: number; first_name: string | null; last_name: string | null; phone_e164: string | null } | null;
};

/** Dettaglio di una chat per la console: la conversazione, il lead, lo stato CRM e gli eventi. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const admin = await richiediAdmin();
  if (!admin.ok) return admin.risposta;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'id_non_valido' }, { status: 400 });
  const convId = Number(id);

  const s = getSupabaseAdmin();
  if (!(await isConversazioneChat(s, convId))) return NextResponse.json({ error: 'chat_non_trovata' }, { status: 404 });

  const letta = await s.from('conversations').select(COLONNE).eq('id', convId).maybeSingle();
  if (letta.error) return NextResponse.json({ error: 'lettura_fallita', dettaglio: letta.error.message }, { status: 500 });
  const c = letta.data as unknown as RigaConv | null;
  if (!c) return NextResponse.json({ error: 'chat_non_trovata' }, { status: 404 });

  const now = new Date();
  const [crm, eventi, errori] = await Promise.all([
    c.crm_lead_id
      ? s.from('crm_lead_status').select('status, conferme_outcome, sales_outcome').eq('lead_id', c.crm_lead_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    leggiEventi(s, convId, now),
    // Stessa fonte della lista (cache 15 s): una chat con l'ultimo invio fallito mostra il tono errore.
    idsConErrori(s, now).catch(() => [] as number[]),
  ]);
  if (crm.error) return NextResponse.json({ error: 'lettura_fallita', dettaglio: crm.error.message }, { status: 500 });

  const nome = [c.lead?.first_name, c.lead?.last_name].map((x) => x?.trim()).filter(Boolean).join(' ') || null;

  return NextResponse.json({
    conv: {
      id: c.id,
      aiOwner: c.ai_owner,
      aiStatus: c.ai_status,
      aiPausedAt: c.ai_paused_at,
      botOutcome: c.bot_outcome,
      botScheduledAt: c.bot_scheduled_at,
      lancioFase: c.lancio_fase,
      lancioSlug: c.lancio_slug,
      waNumber: c.wa_number,
      crmLeadId: c.crm_lead_id,
      aiSummary: c.ai_summary,
      handedOffReason: c.handed_off_reason,
      lastInboundAt: c.last_inbound_at,
      mondo: mondoDi(c),
      // Oltre al contratto del brief: servono a `convDaSegnareLetta` e al Tag dell'intestazione.
      unreadCount: c.unread_count ?? 0,
      contesto: contestoRiga(c, { now, conErrori: new Set(errori) }),
    },
    lead: { id: c.lead?.id ?? null, nome, telefono: c.lead?.phone_e164 ?? null },
    crm: crm.data ?? null,
    // Dal più vecchio al più recente: la query legge i più recenti (tetto 60), il thread li vuole in ordine.
    eventi: (eventi ?? [])
      .map((e) => ({ at: e.created_at, tipo: e.type, testo: e.message ?? '', livello: e.level }))
      .reverse(),
    eventiParziali: eventi === null,
  });
}
