import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings } from '@/lib/lancio-settings';
import { sendOutcome } from '@/lib/bot-outcome';
import { impostaFaseLancio, leggiIngressoLancioAt } from '@/lib/lancio-db';
import { congedoLancio } from '@/lib/lancio-effetti';
import { paroleDelCongedo, type RigaLancio } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { runPool } from '@/lib/run-pool';
import { batchMax, LANCIO_BLAST_CONCURRENCY } from '@/lib/lancio-zoom-blast';
import { ancoraLancio, haInteragito } from '@/lib/lancio-followup';
import {
  restituzioniAttive, fuoriFinestraCron, decideRestituzione, esitoRestituzioneDalCrm, NOTA_RESTITUZIONE,
  FASI_RESTITUIBILI, RESTITUZIONI_MAX_DEFAULT,
  type MotivoNiente, type MotivoRestituzione,
} from '@/lib/lancio-restituzioni';
import { autorizzatoCron, leggiParametriCron, logEvento, leggiCoda, allarmeEventoStantio, TEMPO_MASSIMO_MS } from '@/lib/lancio-blast-motore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Restituzioni al pool (spec §5.8): ogni ora da dopodomani (7/10, decisione PO del
// 19/09: il 6 e' tutto del bot, dal 7 i GDO possono chiamare). NON_RISPOSTO
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
/**
 * Quanto indietro si legge la cronologia: `lancio_evento_at` meno 30 giorni, come nel
 * cron del follow-up. Le chat RIUSATE si portano dietro mesi di messaggi di Mario, ma
 * tutto quello che serve qui — l'ancora, gli inbound del lancio, il congedo — vive dopo
 * l'inizio del lancio. Senza il taglio, un blocco di chat riusate sfonda il tetto righe.
 */
const GIORNI_STORICO = 30;
/** Nota del `DA_SCARTARE` ritentato dallo sweeper (C2): il lead aveva gia' detto no. */
export const NOTA_SCARTO_RITENTATO = 'Lancio Web Dev AI: aveva detto di no e il congedo era gia\' uscito; esito ritentato dal cron.';

const contatoreNiente = (): Record<MotivoNiente, number> =>
  ({ senza_crm: 0, esito_presente: 0, fase: 0, ancora_ignota: 0, incoerente: 0, attesa_24h: 0, ha_risposto: 0 });

export async function GET(req: NextRequest) {
  if (!autorizzatoCron(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase: Supa = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);
  // Ogni run porta con se' la data dell'evento e la bandierina del calendario: le date
  // del cron stanno scritte a mano in vercel.json e non seguono `lancio_evento_at`.
  let contesto: Record<string, unknown> = { evento_at: settings.eventoAt ?? null };
  const scriviRun = (payload: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') =>
    logEvento(supabase, 'lancio_restituzioni_run', { ...contesto, ...payload }, message, level);

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
  // Allarme e basta, non ferma il run. Qui l'evento passato e' il caso NORMALE (le
  // restituzioni girano proprio dopo), quindi la soglia e' 14 giorni: si suona solo se la
  // data e' il residuo di un lancio precedente. Una volta al giorno, non a ogni run.
  await allarmeEventoStantio(supabase, 'lancio-restituzioni', now, evento);
  contesto = { ...contesto, fuori_finestra_cron: fuoriFinestraCron(now, evento) };
  const tagliaStorico = new Date(eventoMs - GIORNI_STORICO * 24 * 60 * 60 * 1000).toISOString();
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
  // Tetto suo (`LANCIO_RESTITUZIONI_MAX`, 500): da qui non esce nessun messaggio
  // WhatsApp — si chiama il CRM e si scrive una fase — quindi il tetto del blast, che
  // esiste per non bruciare il numero, non c'entra niente.
  const max = batchMax(process.env.LANCIO_RESTITUZIONI_MAX, RESTITUZIONI_MAX_DEFAULT);
  const niente = contatoreNiente();
  const daRestituire: { c: Candidata; motivo: MotivoRestituzione }[] = [];
  const scartiDaRitentare: { c: Candidata; rows: RigaLancio[] }[] = [];
  let valutati = 0;
  let blocchiTroncati = 0;
  for (let i = 0; i < coda.length && daRestituire.length < max; i += BLOCCO_VALUTAZIONE) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    const blocco = coda.slice(i, i + BLOCCO_VALUTAZIONE);
    // Si PAGINA, non si mette un `.limit()`: PostgREST taglia comunque a 1.000 righe
    // qualunque numero gli si chieda, quindi con `.limit(8000)` la guardia qui sotto
    // non poteva scattare mai e si decideva su una storia monca. Con `fetchAllRows` le
    // righe arrivano tutte, e il tetto torna a essere quello che voleva essere: una
    // rete di sicurezza per i blocchi davvero enormi.
    let righeBlocco: RigaMessaggio[];
    try {
      righeBlocco = await fetchAllRows<RigaMessaggio>(
        (da, a) =>
          supabase
            .from('messages')
            .select('conversation_id, direction, body, template_sid, created_at')
            .in('conversation_id', blocco.map((c) => c.id))
            // Prima del lancio non c'e' niente che serva a decidere: il taglio tiene le
            // chat riusate dentro il tetto righe.
            .gte('created_at', tagliaStorico)
            .order('created_at', { ascending: true })
            .range(da, a) as unknown as PromiseLike<{ data: RigaMessaggio[] | null; error: { message: string } | null }>,
        { max: MAX_RIGHE_BLOCCO },
      );
    } catch (e) {
      await logCronQueryError(supabase, 'lancio_restituzioni_messages_query_error', { message: e instanceof Error ? e.message : String(e) });
      break;
    }
    // Il troncamento non e' innocuo (stessa difesa del cron del follow-up, commit
    // dec4428): l'ordine e' crescente, quindi a cadere sono le righe PIU' NUOVE di tutte
    // le chat del blocco. Una chat letta a meta' sembra "non ha mai scritto" — e qui non
    // significa saltare un template, significa mandare il lead nel pool con la nota
    // sbagliata, cioe' una decisione che il CRM non annulla piu'. Su una lettura tagliata
    // non si decide niente: il blocco conta `ancora_ignota` e si rivaluta al run dopo
    // (lo sweeper C2 compreso: anche `paroleDelCongedo` leggerebbe una storia monca).
    if (righeBlocco.length >= MAX_RIGHE_BLOCCO) {
      blocchiTroncati++;
      valutati += blocco.length;
      niente.ancora_ignota += blocco.length;
      await logEvento(supabase, 'lancio_restituzioni_blocco_troncato',
        { blocco: Math.floor(i / BLOCCO_VALUTAZIONE), righe: righeBlocco.length, tetto: MAX_RIGHE_BLOCCO, conversazioni: blocco.length, primaChat: blocco[0]?.id ?? null, ultimaChat: blocco[blocco.length - 1]?.id ?? null },
        `[lancio] restituzioni: cronologia troncata sul blocco da ${blocco.length} chat (${righeBlocco.length} righe, tetto ${MAX_RIGHE_BLOCCO}) — nessuna decisione presa su queste chat`,
        'warn');
      continue;
    }
    const perConv = new Map<number, RigaLancio[]>();
    for (const r of righeBlocco) {
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
    const prova = { dry: true, candidati: coda.length, valutati, daRestituire: daRestituire.length, motivi, scartiDaRitentare: scartiDaRitentare.length, niente, blocchiTroncati, queryKo };
    // Il run si scrive SEMPRE, prova compresa: un dry senza traccia e' indistinguibile
    // da un cron che non e' partito, ed e' proprio la domanda che ci si fa il giorno dopo.
    await scriviRun(prova, `[lancio] restituzioni (prova): ${daRestituire.length} da restituire su ${coda.length} candidati, ${scartiDaRitentare.length} scarti da ritentare`, queryKo ? 'warn' : 'info');
    return NextResponse.json({ ok: true, ...prova });
  }

  // ─────────────── C2: gli scarti rifiutati dopo un congedo ───────────────
  // `senza_telefono` e `residui` esistono perche' un lead che questo passo non riesce a
  // chiudere ci ricasca a ogni run: senza un numero nel riepilogo nessuno se ne accorge.
  const scarti = { ritentati: 0, chiusi: 0, senza_telefono: 0, residui: 0 };
  let scartiVisti = 0;
  for (const { c, rows } of scartiDaRitentare) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    scartiVisti++;
    if (c.bot_outcome !== null) {
      // Il CRM ha gia' registrato l'esito (o `sendOutcome` l'ha chiuso localmente sul
      // 403): manca solo la fase. Nessuna chiamata al CRM.
      await impostaFaseLancio(supabase, c.id, 'chiuso');
      scarti.chiusi++;
      continue;
    }
    const phone = c.leads?.phone_e164 ?? null;
    if (!phone) {
      // Senza numero il congedo non si puo' ritentare: la riga resta appesa a ogni run
      // finche' qualcuno non guarda il lead. Una volta per run, per chat, lo si dice.
      scarti.senza_telefono++;
      await logEvento(supabase, 'lancio_scarto_senza_telefono', { conversationId: c.id, crmLeadId: c.crm_lead_id, fase: c.lancio_fase },
        `[lancio] conv ${c.id}: scarto dopo congedo non ritentabile, manca il numero di telefono`, 'warn');
      continue;
    }
    const esito = await congedoLancio(
      supabase,
      { conversationId: c.id, phone, from, crmLeadId: c.crm_lead_id, fase: c.lancio_fase },
      paroleDelCongedo(rows) ?? '',
      NOTA_SCARTO_RITENTATO,
      { giaInviato: true },
    );
    scarti.ritentati++;
    await logEvento(supabase, 'lancio_scarto_ritentato_da_cron', { conversationId: c.id, crmLeadId: c.crm_lead_id, fase: c.lancio_fase, stato: esito },
      `[lancio] conv ${c.id}: scarto dopo congedo ritentato dal cron (${esito})`, esito === 'closed' ? 'info' : 'warn');
  }

  // ─────────────── restituzioni ───────────────
  let restituiti = 0;
  let giaRestituiti = 0;
  let rifiutati = 0;
  let rifiutateDalCrm = 0;
  let nonConfermate = 0;
  let faseCambiata = 0;
  let faseErrore = 0;
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
      // Compare-and-set sulla fase di partenza. Le candidate si leggono a t0 e il CRM
      // puo' rispondere fino a 240s dopo: in mezzo il lead puo' aver risposto e Mario
      // aver chiuso la chat (`chiuso`), o il pulsante averla riportata avanti. Timbrare
      // `restituito` alla cieca scriverebbe la nostra fase sopra una conversazione che
      // non e' piu' del cron, e la chiusura di `ai_status` le toglierebbe la parola.
      const esitoFase = await impostaFaseLancio(supabase, c.id, 'restituito', {}, { soloDaFasi: FASI_RESTITUIBILI });
      // Tutto quello che non e' `cambiata` vuol dire che a DB la fase e' rimasta dov'era:
      // da qui in poi non si chiude `ai_status` e non si scrive `lancio_restituito`, o il
      // riepilogo direbbe che il lead e' fuori mentre la riga dice il contrario. In
      // nessuno dei due casi si ritenta dentro questo run: al giro dopo la riga si
      // ripresenta e il CRM risponde `already_returned`, che e' un ritorno buono.
      if (esitoFase !== 'cambiata') {
        // `non_cambiata` = qualcun altro ha portato avanti la chat mentre il CRM
        // rispondeva. `errore` = l'update e' proprio fallito; il messaggio del DB sta
        // nell'evento `lancio_fase_non_scritta` che `impostaFaseLancio` ha appena scritto
        // per questa stessa conversazione.
        if (esitoFase === 'errore') faseErrore++; else faseCambiata++;
        await logEvento(supabase,
          esitoFase === 'errore' ? 'lancio_restituzione_fase_non_scritta' : 'lancio_restituzione_fase_cambiata',
          { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, esito, esitoFase, status: res.status ?? null },
          esitoFase === 'errore'
            ? `[lancio] conv ${c.id}: esito mandato al CRM ma la fase NON si e' scritta (vedi lancio_fase_non_scritta): non si chiude, si riprova al run dopo`
            : `[lancio] conv ${c.id}: esito mandato al CRM ma la fase si era gia' mossa: non si timbra restituito`,
          'warn');
        return;
      }
      // `sendOutcome` chiude gia' su 2xx e 403; sul 404 no. Idempotente.
      await supabase.from('conversations').update({ ai_status: 'closed' }).eq('id', c.id);
      // Evento distinto sui terminali: `lancio_restituito` deve restare contabile come
      // "lead davvero tornati nel pool", senza dentro i 403/404 che pool non hanno visto.
      await logEvento(supabase, esito === 'terminale' ? 'lancio_restituito_terminale' : 'lancio_restituito',
        { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, esito, status: res.status ?? null, sent: res.sent },
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

  scarti.residui = scartiDaRitentare.length - scartiVisti;
  const residui = lotto.length - serviti;
  const nonValutati = coda.length - valutati;
  const riepilogo = {
    candidati: coda.length, valutati, nonValutati, daRestituire: lotto.length,
    restituiti, giaRestituiti, rifiutati, rifiutateDalCrm, nonConfermate, faseCambiata, faseErrore, errori, residui,
    // `scartiRitentati`/`scartiChiusi` restano piatti: sono il contratto del route.
    scartiRitentati: scarti.ritentati, scartiChiusi: scarti.chiusi, scarti,
    niente, blocchiTroncati, max, queryKo,
  };
  await scriviRun(
    riepilogo,
    `[lancio] restituzioni: ${restituiti} restituiti, ${giaRestituiti} gia' restituiti, ${rifiutati} rifiutati (403/404), ${rifiutateDalCrm} non rimessi nel pool dal CRM, ${nonConfermate} non confermati, ${faseCambiata} con la fase gia' mossa, ${faseErrore} con la fase non scritta, ${errori} errori, ${scarti.ritentati} scarti ritentati, ${scarti.chiusi} scarti chiusi, ${scarti.senza_telefono} scarti senza telefono, ${scarti.residui} scarti residui, ${residui} residui (su ${lotto.length} da restituire, ${coda.length} candidati)`,
    errori > 0 || rifiutateDalCrm > 0 || nonConfermate > 0 || faseCambiata > 0 || faseErrore > 0 || scarti.senza_telefono > 0 || queryKo ? 'warn' : 'info',
  );
  return NextResponse.json({ ok: true, ...riepilogo });
}
