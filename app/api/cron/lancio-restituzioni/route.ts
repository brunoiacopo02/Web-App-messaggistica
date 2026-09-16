import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings } from '@/lib/lancio-settings';
import { sendOutcome } from '@/lib/bot-outcome';
import { impostaFaseLancio, leggiIngressoLancioAt } from '@/lib/lancio-db';
import { congedoLancio } from '@/lib/lancio-effetti';
import { paroleDelCongedo, type RigaLancio } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import { runPool } from '@/lib/run-pool';
import { batchMax, LANCIO_BLAST_CONCURRENCY } from '@/lib/lancio-zoom-blast';
import { ancoraLancio, haInteragito } from '@/lib/lancio-followup';
import {
  restituzioniAttive, decideRestituzione, esitoRestituzioneDalCrm, NOTA_RESTITUZIONE,
  type MotivoNiente, type MotivoRestituzione,
} from '@/lib/lancio-restituzioni';
import { autorizzatoCron, leggiParametriCron, logEvento, leggiCoda, TEMPO_MASSIMO_MS } from '@/lib/lancio-blast-motore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Restituzioni al pool (spec §5.8): ogni ora dal giorno dopo dopodomani. NON_RISPOSTO
// al CRM con la nota fissa, poi `restituito` + `closed`. Pre-passo (C2): gli scarti
// rifiutati dal CRM dopo un congedo si ritentano senza bolla. NON dipende da
// `lancio_attivo`: spegnere il lancio non deve lasciare lead appesi al bot.

type Supa = ReturnType<typeof getSupabaseAdmin>;
type Candidata = {
  id: number;
  crm_lead_id: string | null;
  lancio_fase: string | null;
  lancio_info: unknown;
  lancio_benvenuto_at: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  bot_outcome: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};
type RigaMessaggio = RigaLancio & { conversation_id: number };

const BLOCCO_VALUTAZIONE = 200;
const MAX_RIGHE_BLOCCO = BLOCCO_VALUTAZIONE * 40;
/** Nota del `DA_SCARTARE` ritentato dallo sweeper (C2): il lead aveva gia' detto no. */
export const NOTA_SCARTO_RITENTATO = 'Lancio Web Dev AI: aveva detto di no e il congedo era gia\' uscito; esito ritentato dal cron.';

const contatoreNiente = (): Record<MotivoNiente, number> =>
  ({ senza_crm: 0, esito_presente: 0, fase: 0, ancora_ignota: 0, incoerente: 0, attesa_48h: 0, ha_risposto: 0 });

export async function GET(req: NextRequest) {
  if (!autorizzatoCron(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase: Supa = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);
  const scriviRun = (payload: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') =>
    logEvento(supabase, 'lancio_restituzioni_run', payload, message, level);

  const parametri = leggiParametriCron(req, { nowRichiedeSolo: true });
  if (!parametri.ok) return NextResponse.json({ ok: false, error: parametri.errore }, { status: 400 });
  const { now, forza, solo, dry } = parametri;

  const eventoMs = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  if (Number.isNaN(eventoMs)) {
    await logEvento(supabase, 'lancio_restituzioni_config_error', { missing: ['lancio_evento_at'] }, '[lancio] restituzioni saltate: manca lancio_evento_at', 'error');
    await scriviRun({ motivo: 'config', candidati: 0, restituiti: 0 }, '[lancio] restituzioni: run saltato per configurazione mancante', 'error');
    return NextResponse.json({ ok: true, skipped: 'config', missing: ['lancio_evento_at'] });
  }
  const evento = new Date(eventoMs);
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE ?? '';
  const welcomeSid = process.env.LANCIO_WELCOME_TEMPLATE_SID || null;

  if (!forza && !restituzioniAttive(now, evento)) {
    await scriviRun({ motivo: 'prima_della_data', candidati: 0, restituiti: 0 }, '[lancio] restituzioni: prima della data, nessun ritorno al pool');
    return NextResponse.json({ ok: true, skipped: 'prima_della_data' });
  }

  const t0 = Date.now();
  const { righe: coda, queryKo } = await leggiCoda<Candidata>(supabase, 'lancio_restituzioni_query_error', (da, a) => {
    let q = supabase
      .from('conversations')
      .select('id, crm_lead_id, lancio_fase, lancio_info, lancio_benvenuto_at, lancio_followup_inviato_at, last_inbound_at, bot_outcome, leads(phone_e164, first_name)')
      .not('lancio_slug', 'is', null)
      // Tutto quello che non e' terminale: le fasi restituibili E gli scarti da
      // ritentare (che possono stare in qualunque fase, `post_pitch` compresa).
      .not('lancio_fase', 'in', '(chiuso,restituito)')
      .not('crm_lead_id', 'is', null);
    if (solo !== null) q = q.eq('id', solo);
    return q.order('id', { ascending: true }).range(da, a);
  });

  // ─────────────── valutazione a blocchi ───────────────
  const max = batchMax(process.env.LANCIO_BATCH_MAX);
  const niente = contatoreNiente();
  const daRestituire: { c: Candidata; motivo: MotivoRestituzione }[] = [];
  const scartiDaRitentare: { c: Candidata; rows: RigaLancio[] }[] = [];
  let valutati = 0;
  for (let i = 0; i < coda.length && daRestituire.length < max; i += BLOCCO_VALUTAZIONE) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    const blocco = coda.slice(i, i + BLOCCO_VALUTAZIONE);
    const { data, error } = await supabase
      .from('messages')
      .select('conversation_id, direction, body, template_sid, created_at')
      .in('conversation_id', blocco.map((c) => c.id))
      .order('created_at', { ascending: true })
      .limit(MAX_RIGHE_BLOCCO);
    if (error) {
      await logCronQueryError(supabase, 'lancio_restituzioni_messages_query_error', error);
      break;
    }
    const perConv = new Map<number, RigaLancio[]>();
    for (const r of (data ?? []) as unknown as RigaMessaggio[]) {
      const lista = perConv.get(r.conversation_id) ?? [];
      lista.push(r);
      perConv.set(r.conversation_id, lista);
    }
    for (const c of blocco) {
      valutati++;
      const rows = perConv.get(c.id) ?? [];
      const ancoraNota = ancoraLancio({ rows, welcomeSid, benvenutoAt: c.lancio_benvenuto_at, ingressoAt: null });
      const ancora = ancoraNota ?? (await leggiIngressoLancioAt(supabase, c.id));
      const decisione = decideRestituzione({
        lancio_fase: c.lancio_fase, lancio_followup_inviato_at: c.lancio_followup_inviato_at, last_inbound_at: c.last_inbound_at,
        crm_lead_id: c.crm_lead_id, bot_outcome: c.bot_outcome, lancio_info: c.lancio_info, ancora, haInteragito: haInteragito(rows, ancora),
      }, now.getTime());
      if (decisione.kind === 'niente') { niente[decisione.motivo]++; continue; }
      if (decisione.kind === 'ritenta_scarto') { scartiDaRitentare.push({ c, rows }); continue; }
      daRestituire.push({ c, motivo: decisione.motivo });
      if (daRestituire.length >= max) break;
    }
  }

  if (dry) {
    const motivi = daRestituire.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.motivo]: (acc[d.motivo] ?? 0) + 1 }), {});
    return NextResponse.json({ ok: true, dry: true, candidati: coda.length, valutati, daRestituire: daRestituire.length, motivi, scartiDaRitentare: scartiDaRitentare.length, niente, queryKo });
  }

  // ─────────────── C2: gli scarti rifiutati dopo un congedo ───────────────
  let scartiRitentati = 0;
  let scartiChiusi = 0;
  for (const { c, rows } of scartiDaRitentare) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    if (c.bot_outcome !== null) {
      // Il CRM ha gia' registrato l'esito (o `sendOutcome` l'ha chiuso localmente sul
      // 403): manca solo la fase. Nessuna chiamata al CRM.
      await impostaFaseLancio(supabase, c.id, 'chiuso');
      scartiChiusi++;
      continue;
    }
    const phone = c.leads?.phone_e164 ?? null;
    if (!phone) continue;
    const esito = await congedoLancio(
      supabase,
      { conversationId: c.id, phone, from, crmLeadId: c.crm_lead_id, fase: c.lancio_fase },
      paroleDelCongedo(rows) ?? '',
      NOTA_SCARTO_RITENTATO,
      { giaInviato: true },
    );
    scartiRitentati++;
    await logEvento(supabase, 'lancio_scarto_ritentato_da_cron', { conversationId: c.id, crmLeadId: c.crm_lead_id, fase: c.lancio_fase, stato: esito },
      `[lancio] conv ${c.id}: scarto dopo congedo ritentato dal cron (${esito})`, esito === 'closed' ? 'info' : 'warn');
  }

  // ─────────────── restituzioni ───────────────
  let restituiti = 0;
  let giaRestituiti = 0;
  let rifiutati = 0;
  let rifiutateDalCrm = 0;
  let nonConfermate = 0;
  let errori = 0;
  const lotto = daRestituire;
  let serviti = 0;
  await runPool(lotto, LANCIO_BLAST_CONCURRENCY, async ({ c, motivo }) => {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) return;
    serviti++;
    try {
      const res = await sendOutcome(supabase, c.id, { outcome: 'NON_RISPOSTO', note: NOTA_RESTITUZIONE[motivo] });
      // Si legge il CORPO della risposta, non solo lo status: il CRM risponde 200 anche
      // quando NON ha rimesso il lead nel pool (`returnedToPool: false, skipped`).
      const { esito, skipped } = esitoRestituzioneDalCrm(res);
      if (esito === 'ritenta') {
        errori++;
        await logEvento(supabase, 'lancio_restituzione_error', { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, status: res.status ?? null, error: res.error ?? null },
          `[lancio] conv ${c.id}: restituzione non riuscita (${res.error ?? res.status ?? 'errore'}), riprovo al prossimo run`, 'error');
        return;
      }
      if (esito === 'rifiutato_dal_crm' || esito === 'non_confermato') {
        // Il CRM ha detto di no (call in agenda, scelta gia' fatta, lead non del bot) o
        // non si e' capito: la fase NON si tocca e lo guarda una persona. `sendOutcome`
        // ha gia' scritto bot_outcome localmente, quindi al run dopo questa riga esce
        // con `esito_presente`: nessun loop, ma il rifiuto resta solo qui.
        if (esito === 'rifiutato_dal_crm') rifiutateDalCrm++; else nonConfermate++;
        await logEvento(supabase, 'lancio_restituzione_rifiutata', { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, esito, skipped, status: res.status ?? null },
          `[lancio] conv ${c.id}: il CRM non ha rimesso il lead nel pool (${skipped ?? 'corpo illeggibile'}): fase intatta, da guardare a mano`, 'warn');
        return;
      }
      await impostaFaseLancio(supabase, c.id, 'restituito');
      // `sendOutcome` chiude gia' su 2xx e 403; sul 404 no. Idempotente.
      await supabase.from('conversations').update({ ai_status: 'closed' }).eq('id', c.id);
      await logEvento(supabase, 'lancio_restituito', { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, esito, status: res.status ?? null, sent: res.sent },
        esito === 'terminale'
          ? `[lancio] conv ${c.id}: il CRM ha rifiutato (${res.status}), segnata restituita per non ritentare`
          : `[lancio] conv ${c.id} restituita al pool (${esito}): ${NOTA_RESTITUZIONE[motivo]}`,
        esito === 'terminale' ? 'warn' : 'info');
      if (esito === 'restituito') restituiti++;
      else if (esito === 'gia_restituito') giaRestituiti++;
      else rifiutati++;
    } catch (err) {
      errori++;
      await logEvento(supabase, 'lancio_restituzione_error', { conversationId: c.id, motivo, error: err instanceof Error ? err.message : 'errore' },
        `[lancio] conv ${c.id}: restituzione esplosa — ${err instanceof Error ? err.message : 'errore ignoto'}`, 'error');
    }
  });

  const residui = lotto.length - serviti;
  const nonValutati = coda.length - valutati;
  const riepilogo = {
    candidati: coda.length, valutati, nonValutati, daRestituire: lotto.length,
    restituiti, giaRestituiti, rifiutati, rifiutateDalCrm, nonConfermate, errori, residui,
    scartiRitentati, scartiChiusi, niente, max, queryKo,
  };
  await scriviRun(
    riepilogo,
    `[lancio] restituzioni: ${restituiti} restituiti, ${giaRestituiti} gia' restituiti, ${rifiutati} rifiutati (403/404), ${rifiutateDalCrm} non rimessi nel pool dal CRM, ${nonConfermate} non confermati, ${errori} errori, ${scartiRitentati} scarti ritentati, ${scartiChiusi} scarti chiusi, ${residui} residui (su ${lotto.length} da restituire, ${coda.length} candidati)`,
    errori > 0 || rifiutateDalCrm > 0 || nonConfermate > 0 || queryKo ? 'warn' : 'info',
  );
  return NextResponse.json({ ok: true, ...riepilogo });
}
