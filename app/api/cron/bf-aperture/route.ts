import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendSequenceTemplate, inviaAperturaMario } from '@/lib/apertura-mario-invio';
import { templateBfApprovatoSu, leggiModoAperturaBf } from '@/lib/black-friday-apertura';
import { aperturaBlackFridayText, MARKER_TESTO_APERTURA_BF } from '@/lib/black-friday';
import { getStatoQualitaNumeri, eHighEFuoriPausa } from '@/lib/tetti-numeri';
import { numeroPrimario } from '@/lib/mittente';
import { sceltaHighMenoCarico } from '@/lib/scelta-mittente';
import { inOpeningWindow } from '@/lib/sequence';
import { templateName } from '@/lib/name';
import { logCronQueryError } from '@/lib/cron-query-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Aperture Black Friday (PO 07/11/2026). L'unico punto che scrive per primo ai lead BF
 * (crm_funnel BLACK FRIDAY) che non ci hanno ancora risposto: sequence-touches li salta.
 *
 * - Stand-by: finche' il template BF (`BF_OPENING_TEMPLATE_SID`) non e' approvato da Meta
 *   sull'account del numero, non parte niente; si sblocca da solo appena e' approved.
 * - Un solo invio per chat: salta chi ha gia' in cronologia (dall'arruolamento) il testo
 *   dell'apertura BF, o una riga `bf_apertura_claim` in event_log (timbrata PRIMA dell'invio).
 * - Vale anche per chi ha gia' ricevuto un'altra apertura (Giovanna la neutra, Cristina
 *   quella Telegram): il template BF fa da apertura giusta. Mai a chi ha risposto: li'
 *   continua Mario in chat.
 * - Numero: quello della chat se HIGH e fuori pausa, altrimenti il HIGH meno carico (la
 *   chat passa a quel numero, come nel recupero aperture).
 * - Fascia 07-23 (`inOpeningWindow`), al massimo MAX_PER_GIRO invii a giro.
 */
const MAX_PER_GIRO = 40;
const H = 3600_000;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get('secret') === secret;
}

function giornoRoma(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

type Conv = {
  id: number; ai_started_at: string | null; wa_number: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });
  const supabase = getSupabaseAdmin();
  const now = Date.now();

  const { data, error } = await supabase
    .from('conversations')
    .select('id, ai_started_at, wa_number, leads(phone_e164, first_name)')
    .ilike('crm_funnel', 'black friday')
    .eq('ai_owner', 'mario')
    .eq('ai_status', 'active')
    .is('ai_paused_at', null)
    .is('gdo_agenda_at', null)
    .not('crm_lead_id', 'is', null)
    .order('id', { ascending: true })
    .limit(1000);
  if (error) {
    await logCronQueryError(supabase, 'bf_aperture_query_error', error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  const convs = (data ?? []) as unknown as Conv[];

  let inviati = 0, giaFatti = 0, risposto = 0, inAttesa = 0, falliti = 0, senzaNumero = 0;
  const dettaglio: Record<string, unknown>[] = [];
  const fascia = inOpeningWindow(now);
  const modo = await leggiModoAperturaBf(supabase);
  const stato = await getStatoQualitaNumeri(supabase);
  const oggiG = giornoRoma(now);
  const ieriG = giornoRoma(now - 24 * H);
  const primario = numeroPrimario();

  for (const c of convs) {
    const phone = c.leads?.phone_e164;
    if (!phone) continue;
    const da = c.ai_started_at ? new Date(Date.parse(c.ai_started_at) - 5 * 60_000).toISOString() : '1970-01-01T00:00:00Z';
    const { data: msgs } = await supabase.from('messages')
      .select('direction, body, twilio_sid').eq('conversation_id', c.id).gte('created_at', da);
    const righe = (msgs ?? []) as { direction: string; body: string | null; twilio_sid: string | null }[];
    if (righe.some((m) => m.direction === 'in')) { risposto++; continue; }
    // Solo un invio PARTITO (con SID) conta come fatto: un fallito prima di Twilio si ritenta.
    if (righe.some((m) => m.direction === 'out' && !!m.twilio_sid && (m.body ?? '').includes(MARKER_TESTO_APERTURA_BF))) { giaFatti++; continue; }
    // Il claim e' un lucchetto contro due run sovrapposti, non un "fatto": vale 15 minuti.
    const { count: claim } = await supabase.from('event_log').select('id', { count: 'exact', head: true })
      .eq('type', 'bf_apertura_claim').eq('payload->>conversationId', String(c.id))
      .gte('created_at', new Date(now - 15 * 60_000).toISOString());
    if ((claim ?? 0) > 0) { giaFatti++; continue; }

    // Il numero: quello della chat se HIGH, altrimenti il HIGH meno carico.
    let numero = c.wa_number ?? (primario ? `whatsapp:${primario.replace(/^whatsapp:/, '')}` : null);
    if (!numero) { senzaNumero++; continue; }
    if (!eHighEFuoriPausa(stato, numero, oggiG, ieriG)) {
      const sidBf = process.env.BF_OPENING_TEMPLATE_SID?.trim();
      const alt = sidBf && primario ? await sceltaHighMenoCarico(supabase, { templateSids: [sidBf], primario }) : null;
      if (!alt) { senzaNumero++; continue; }
      numero = alt.numero;
    }
    const ok = await templateBfApprovatoSu(numero);
    if (!ok.ok || !ok.sid) {
      // Interruttore `bf_apertura_modo` = 'neutra': chi non ha ancora ricevuto niente
      // riceve subito l'apertura neutra; il template BF arrivera' quando approvato.
      const nessunOut = !righe.some((m) => m.direction === 'out' && !!m.twilio_sid);
      if ((modo ?? '').trim().toLowerCase() === 'neutra' && nessunOut && fascia && inviati < MAX_PER_GIRO) {
        const r = await inviaAperturaMario(supabase, {
          conversationId: c.id, phone, firstName: c.leads?.first_name ?? null, funnel: 'BLACK FRIDAY', from: numero,
          logConfigError: async () => undefined, logOpeningConfigError: async () => undefined,
        });
        if (r.tentato && r.ok) inviati++;
        else if (r.tentato) falliti++;
        dettaglio.push({ conversationId: c.id, numero, neutra: true, ok: r.ok });
        continue;
      }
      inAttesa++;
      continue;
    }
    if (!fascia) { inAttesa++; continue; }
    if (inviati >= MAX_PER_GIRO) { inAttesa++; continue; }

    await supabase.from('event_log').insert({
      type: 'bf_apertura_claim', level: 'info',
      payload: { conversationId: String(c.id), numero } as never,
      message: `[bf] conv ${c.id}: apertura Black Friday in invio da ${numero}`,
    });
    if (numero !== c.wa_number) {
      await supabase.from('conversations').update({ wa_number: numero }).eq('id', c.id);
    }
    const nome = templateName(c.leads?.first_name ?? null);
    const r = await sendSequenceTemplate(
      supabase, c.id, phone, ok.sid, 'Apertura Black Friday', numero, { '1': nome }, aperturaBlackFridayText(nome),
    );
    if (r.ok) inviati++; else falliti++;
    dettaglio.push({ conversationId: c.id, numero, ok: r.ok, error: r.error ?? null });
    await supabase.from('event_log').insert({
      type: r.ok ? 'bf_apertura_inviata' : 'bf_apertura_fallita', level: r.ok ? 'info' : 'warn',
      payload: { conversationId: String(c.id), numero, error: r.error ?? null } as never,
      message: r.ok ? `[bf] conv ${c.id}: apertura Black Friday inviata da ${numero}` : `[bf] conv ${c.id}: apertura Black Friday fallita (${r.error ?? 'errore'})`,
    });
  }

  const riepilogo = { ok: true, candidati: convs.length, inviati, giaFatti, risposto, inAttesa, falliti, senzaNumero, fascia, modo };
  if (inviati || falliti) {
    await supabase.from('event_log').insert({
      type: 'bf_aperture_run', level: falliti ? 'warn' : 'info',
      payload: { ...riepilogo, dettaglio } as never,
      message: `[bf] aperture Black Friday: ${inviati} inviate, ${falliti} fallite, ${inAttesa} in attesa`,
    });
  }
  return NextResponse.json(riepilogo);
}
