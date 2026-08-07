import type { getSupabaseAdmin } from './supabase/admin';
import { signPayload } from './bot-hmac';
import { validateOutcomeBody, type BotOutcome, type BotOutcomeBody, type BotReport } from './bot-contract';
import {
  buildContattoUmanoNote,
  buildLockedNote,
  buildRichiamoSenzaDataNote,
  checkDataRichiamo,
  resolveOutcomeAction,
} from './bot-outcome-rules';
import { noteFingerprint } from './note-dedup';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const DEFAULT_CRM_URL = 'https://crm-sales-fenice.vercel.app/api/bot/outcome';

/** Una nota con la stessa impronta è già partita per questa conversazione? */
async function notaGiaInviata(
  supabase: Supa,
  type: string,
  conversationId: number,
  fingerprint: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('event_log')
    .select('id')
    .eq('type', type)
    .eq('payload->>conversationId', String(conversationId))
    .eq('payload->>noteFingerprint', fingerprint)
    .limit(1);
  return (data ?? []).length > 0;
}

/** POST di una NOTA al CRM. Solo rete e log: nessuna decisione, nessuno stato locale. */
async function inviaNotaAlCrm(
  supabase: Supa,
  conversationId: number,
  crmLeadId: string,
  note: string,
  report: BotReport | undefined,
  secret: string,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const body: BotOutcomeBody = { leadId: crmLeadId, outcome: 'NOTA', note, ...(report ? { report } : {}) };
  const valid = validateOutcomeBody(body);
  if (!valid.ok) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, reason: valid.reason } as never,
      message: `[bot-fissatore] nota non valida per lead ${crmLeadId}: ${valid.reason}`,
      level: 'error',
    });
    return { sent: false, error: valid.reason };
  }
  const rawBody = JSON.stringify(body);
  const url = process.env.CRM_OUTCOME_URL ?? DEFAULT_CRM_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
    });
    if (res.ok) return { sent: true, status: res.status };
    const text = await res.text().catch(() => '');
    return { sent: false, status: res.status, error: text || `http_${res.status}` };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : 'errore' };
  }
}

/**
 * Canale solo-NOTA: per i lead che restano di proprietà di un GDO (vedi
 * `enrollGdoLeadAsPostino`). Manda al CRM una NOTA e basta — mai un esito, mai una
 * data — e non tocca né lo stato del lead né la conversazione: il bot qui fa il
 * postino, l'appuntamento l'ha preso il commerciale al telefono.
 */
async function sendCrmNoteOnly(
  supabase: Supa,
  conversationId: number,
  crmLeadId: string,
  args: SendOutcomeArgs,
  existingDate: string | null,
  secret: string,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const note = buildLockedNote(args, existingDate);
  const fp = noteFingerprint(note);
  if (await notaGiaInviata(supabase, 'bot_note_sent', conversationId, fp)) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_note_duplicate',
      payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, noteFingerprint: fp, note, noteOnly: true } as never,
      message: `[gdo] nota identica già inviata per lead ${crmLeadId} (esito ${args.outcome}): non rimandata al CRM`,
      level: 'info',
    });
    return { sent: false, error: 'note_duplicate' };
  }

  const body: BotOutcomeBody = {
    leadId: crmLeadId,
    outcome: 'NOTA',
    note,
    ...(args.report ? { report: args.report } : {}),
  };
  const valid = validateOutcomeBody(body);
  if (!valid.ok) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, reason: valid.reason, noteOnly: true } as never,
      message: `[gdo] nota non valida per lead ${crmLeadId}: ${valid.reason}`,
      level: 'error',
    });
    return { sent: false, error: valid.reason };
  }

  const rawBody = JSON.stringify(body);
  const url = process.env.CRM_OUTCOME_URL ?? DEFAULT_CRM_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
    });
    if (res.ok) {
      await supabase.from('event_log').insert({
        type: 'bot_note_sent',
        payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, note, noteFingerprint: fp } as never,
        message: `[gdo] nota inviata al CRM per lead ${crmLeadId} (esito ${args.outcome} non applicato: lead del GDO)`,
        level: 'info',
      });
      return { sent: true, status: res.status };
    }
    const text = await res.text().catch(() => '');
    // Anche il 403 qui è solo informativo: non c'è nessuno stato locale da
    // congelare, la conversazione va avanti comunque.
    await supabase.from('event_log').insert({
      type: res.status === 403 ? 'bot_outcome_rejected' : 'bot_outcome_error',
      payload: { conversationId, crmLeadId, outcome: args.outcome, status: res.status, body: text, noteOnly: true } as never,
      message: `[gdo] il CRM ha risposto ${res.status} alla nota per lead ${crmLeadId}`,
      level: res.status === 403 ? 'warn' : 'error',
    });
    return { sent: false, status: res.status, error: text || `http_${res.status}` };
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, error: e instanceof Error ? e.message : 'errore', noteOnly: true } as never,
      message: `[gdo] invio nota al CRM fallito (rete) per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, error: e instanceof Error ? e.message : 'errore' };
  }
}

/**
 * `CONTATTO_UMANO`: il lead ha chiesto di parlare con una persona. Non è un esito, è
 * una segnalazione — non cambia stato, non riassegna, non tocca l'appuntamento. Prima
 * del 06/08 il tag [PASSAGGIO_UMANO] impostava solo `ai_status='handed_off'` in locale
 * e la richiesta non usciva mai dal nostro database.
 *
 * Il CRM sopprime la notifica se ce n'è già stata una nelle 24h sullo stesso lead
 * (`notifySuppressed: true`): non è un errore e non si ritenta.
 */
async function inviaContattoUmano(
  supabase: Supa,
  conversationId: number,
  crmLeadId: string,
  args: SendOutcomeArgs,
  secret: string,
): Promise<{ sent: boolean; status?: number; error?: string; notifySuppressed?: true }> {
  const note = buildContattoUmanoNote({ leadWords: args.note, motivo: args.discardReason });
  const body: BotOutcomeBody = { leadId: crmLeadId, outcome: 'CONTATTO_UMANO', note };
  const valid = validateOutcomeBody(body);
  if (!valid.ok) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, reason: valid.reason, outcome: 'CONTATTO_UMANO' } as never,
      message: `[bot-fissatore] contatto umano non valido per lead ${crmLeadId}: ${valid.reason}`,
      level: 'error',
    });
    return { sent: false, error: valid.reason };
  }

  const rawBody = JSON.stringify(body);
  const url = process.env.CRM_OUTCOME_URL ?? DEFAULT_CRM_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
    });
    const testo = await res.text().catch(() => '');
    if (res.ok) {
      let soppressa = false;
      // Un corpo che non è JSON vale come notifica passata: il 2xx l'ha già detto.
      try { soppressa = (JSON.parse(testo) as { notifySuppressed?: boolean })?.notifySuppressed === true; } catch { /* niente */ }
      await supabase.from('event_log').insert({
        type: soppressa ? 'bot_contatto_umano_soppresso' : 'bot_contatto_umano_inviato',
        payload: { conversationId, crmLeadId, note } as never,
        message: soppressa
          ? `[bot-fissatore] contatto umano già segnalato nelle ultime 24h per lead ${crmLeadId}: notifica soppressa dal CRM`
          : `[bot-fissatore] contatto umano segnalato al CRM per lead ${crmLeadId}`,
        level: 'info',
      });
      return soppressa
        ? { sent: true, status: res.status, notifySuppressed: true }
        : { sent: true, status: res.status };
    }
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, outcome: 'CONTATTO_UMANO', status: res.status, body: testo } as never,
      message: `[bot-fissatore] il CRM ha risposto ${res.status} al contatto umano per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, status: res.status, error: testo || `http_${res.status}` };
  } catch (e) {
    const errore = e instanceof Error ? e.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, outcome: 'CONTATTO_UMANO', error: errore } as never,
      message: `[bot-fissatore] segnalazione del contatto umano fallita (rete) per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, error: errore };
  }
}

export type SendOutcomeArgs = {
  outcome: BotOutcome;
  date?: string;
  note?: string;
  discardReason?: string;
  report?: BotReport;
};

/**
 * Invia l'esito al CRM per una conversazione CRM-linked. No-op per lead non-CRM.
 * Su 2xx persiste bot_outcome/at/scheduled/report e chiude la conversazione.
 */
export type SendOutcomeOpts = {
  /** RICHIAMO non-terminale: POST al CRM per visibilità, ma la conversazione resta
   * aperta e bot_outcome non viene toccato (la sequenza continua). */
  interim?: boolean;
  /** Lead di proprietà di un GDO: al CRM va solo una NOTA, mai un esito. Non tocca
   * lo stato del lead, non tocca l'appuntamento, non chiude la conversazione. */
  noteOnly?: boolean;
};

export async function sendOutcome(
  supabase: Supa,
  conversationId: number,
  args: SendOutcomeArgs,
  opts: SendOutcomeOpts = {},
): Promise<{ sent: boolean; status?: number; error?: string; keepOpen?: true; notifySuppressed?: true }> {
  const interim = opts.interim === true && args.outcome === 'RICHIAMO';
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { sent: false, error: 'not_configured' };

  const { data: conv } = await supabase
    .from('conversations')
    .select('crm_lead_id, bot_outcome, bot_scheduled_at')
    .eq('id', conversationId)
    .maybeSingle();
  const row = conv as { crm_lead_id: string | null; bot_outcome: string | null; bot_scheduled_at: string | null } | null;
  const crmLeadId = row?.crm_lead_id ?? null;
  if (!crmLeadId) return { sent: false, error: 'not_crm_lead' };

  if (opts.noteOnly === true) {
    return sendCrmNoteOnly(supabase, conversationId, crmLeadId, args, row?.bot_scheduled_at ?? null, secret);
  }

  // Passa PRIMA di resolveOutcomeAction apposta: su un lead già APPUNTAMENTO il ramo
  // locked lo tradurrebbe in una nota generica "appuntamento mantenuto", e la richiesta
  // di parlare con una persona si perderebbe un'altra volta.
  if (args.outcome === 'CONTATTO_UMANO') {
    return inviaContattoUmano(supabase, conversationId, crmLeadId, args, secret);
  }

  // Un RICHIAMO senza una data che regga non è un richiamo: è un'ora inventata che
  // finisce in agenda a un commerciale. Al CRM va una nota con le parole del lead, e
  // la conversazione resta aperta — il bot deve poter ancora chiedere quando.
  const dataCheck = args.outcome === 'RICHIAMO' ? checkDataRichiamo(args.date, Date.now()) : { ok: true as const };
  if (!dataCheck.ok) {
    const note = buildRichiamoSenzaDataNote({ motivo: dataCheck.motivo, leadWords: args.note });
    await supabase.from('event_log').insert({
      type: 'richiamo_senza_data',
      payload: { conversationId, crmLeadId, motivo: dataCheck.motivo, dataScartata: args.date ?? null, note } as never,
      message: `[bot-fissatore] RICHIAMO senza data utilizzabile (${dataCheck.motivo}) per lead ${crmLeadId}: inviato come nota`,
      level: 'warn',
    });
    const esito = await inviaNotaAlCrm(supabase, conversationId, crmLeadId, note, args.report, secret);
    return { ...esito, keepOpen: true };
  }

  const action = resolveOutcomeAction(
    (row?.bot_outcome ?? null) as BotOutcome | null,
    args,
    row?.bot_scheduled_at ?? null,
  );

  // RICHIAMO interim: mai su lead già esitati (un RICHIAMO su un APPUNTAMENTO lo
  // riporterebbe indietro di stato lato CRM — avvertenza esplicita del loro team).
  if (interim && action.kind !== 'normal') {
    return { sent: false, error: 'interim_skipped_locked' };
  }

  // Una nota identica a una gia inviata su questa conversazione non aggiunge
  // informazione: il commerciale la vedrebbe solo duplicata sul CRM.
  if (action.kind === 'locked') {
    const fp = noteFingerprint(action.note);
    if (await notaGiaInviata(supabase, 'bot_outcome_locked', conversationId, fp)) {
      // Questa è l'unica guardia che fa sparire un dato diretto al CRM: senza una
      // traccia esplicita una soppressione sbagliata sarebbe invisibile.
      await supabase.from('event_log').insert({
        type: 'bot_outcome_note_duplicate',
        payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, noteFingerprint: fp, note: action.note } as never,
        message: `[bot-fissatore] nota identica già inviata per lead ${crmLeadId} (esito ${args.outcome}): non rimandata al CRM`,
        level: 'info',
      });
      // La nota non parte perché era già partita: l'esito resta terminale, quindi la
      // conversazione va chiusa come nel ramo di invio riuscito. Se restasse 'active'
      // il cron backstop la riclassificherebbe al run successivo (finestra fino a
      // un'ora con una riga aperta che ha già un esito terminale).
      await supabase.from('conversations').update({ ai_status: 'closed' }).eq('id', conversationId);
      return { sent: false, error: 'note_duplicate' };
    }
  }

  const body: BotOutcomeBody = action.kind === 'locked'
    ? {
        leadId: crmLeadId,
        outcome: 'NOTA',
        note: action.note,
        ...(args.report ? { report: args.report } : {}),
      }
    : {
        leadId: crmLeadId,
        outcome: args.outcome,
        ...(args.date ? { date: args.date } : {}),
        ...(args.note ? { note: args.note } : {}),
        ...(args.discardReason ? { discardReason: args.discardReason } : {}),
        ...(args.report ? { report: args.report } : {}),
      };

  const valid = validateOutcomeBody(body);
  if (!valid.ok) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, reason: valid.reason } as never,
      message: `[bot-fissatore] outcome non valido per lead ${crmLeadId}: ${valid.reason}`,
      level: 'error',
    });
    return { sent: false, error: valid.reason };
  }

  const rawBody = JSON.stringify(body);
  const url = process.env.CRM_OUTCOME_URL ?? DEFAULT_CRM_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
    });
    if (res.ok) {
      if (interim) {
        // Visibilità sul cruscotto CRM, ma la lavorazione continua: niente
        // bot_outcome, niente chiusura.
        await supabase.from('event_log').insert({
          type: 'bot_outcome_sent',
          payload: { conversationId, crmLeadId, outcome: args.outcome, interim: true } as never,
          message: `[bot-fissatore] RICHIAMO interim inviato per lead ${crmLeadId} (sequenza in corso)`,
          level: 'info',
        });
        return { sent: true, status: res.status };
      }
      if (action.kind === 'normal') {
        await supabase.from('conversations').update({
          bot_outcome: args.outcome,
          bot_outcome_at: new Date().toISOString(),
          bot_scheduled_at: args.date ?? null,
          bot_report: (args.report ?? null) as never,
          ai_status: 'closed',
        }).eq('id', conversationId);
        await supabase.from('event_log').insert({
          type: 'bot_outcome_sent',
          payload: { conversationId, crmLeadId, outcome: args.outcome } as never,
          message: `[bot-fissatore] esito ${args.outcome} inviato per lead ${crmLeadId}`,
          level: 'info',
        });
      } else {
        // Lead terminale: l'esito resta congelato (niente bot_outcome/date), ma la
        // conversazione va richiusa: se restasse 'active' il cron backstop la
        // riclassificherebbe a ogni run, reinviando una NOTA al CRM ad ogni giro.
        await supabase.from('conversations').update({ ai_status: 'closed' }).eq('id', conversationId);
        await supabase.from('event_log').insert({
          type: 'bot_outcome_locked',
          payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, keptOutcome: 'APPUNTAMENTO', sentAs: 'NOTA', note: action.note, noteFingerprint: noteFingerprint(action.note) } as never,
          message: `[bot-fissatore] esito ${args.outcome} intercettato (lead ${crmLeadId} già APPUNTAMENTO) → nota CRM`,
          level: 'info',
        });
      }
      return { sent: true, status: res.status };
    }
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      // Il CRM rifiuta l'esito (lead non più assegnato al bot, es. già richiamato
      // nel pool umano): ritentare non può che ridare 403, quindi registra l'esito
      // localmente e chiudi la conversazione per fermare il loop del cron.
      // (Per gli interim niente persistenza: RICHIAMO non è un esito nostro.)
      if (action.kind === 'normal' && !interim) {
        await supabase.from('conversations').update({
          bot_outcome: args.outcome,
          bot_outcome_at: new Date().toISOString(),
          bot_scheduled_at: args.date ?? null,
          bot_report: (args.report ?? null) as never,
          ai_status: 'closed',
        }).eq('id', conversationId);
      } else if (!interim) {
        // Lead terminale: mai declassare bot_outcome, chiudi soltanto.
        await supabase.from('conversations').update({ ai_status: 'closed' }).eq('id', conversationId);
      }
      await supabase.from('event_log').insert({
        type: 'bot_outcome_rejected',
        payload: { conversationId, crmLeadId, outcome: args.outcome, status: res.status, body: text } as never,
        message: `[bot-fissatore] CRM ha rifiutato (403) l'esito ${args.outcome} per lead ${crmLeadId}: chiuso localmente`,
        level: 'warn',
      });
      return { sent: false, status: res.status, error: text || 'http_403' };
    }
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, status: res.status, body: text } as never,
      message: `[bot-fissatore] callback CRM ha risposto ${res.status} per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, status: res.status, error: text || `http_${res.status}` };
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] callback CRM fallito (rete) per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, error: e instanceof Error ? e.message : 'errore' };
  }
}
