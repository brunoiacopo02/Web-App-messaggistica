import type { getSupabaseAdmin } from './supabase/admin';
import { signPayload } from './bot-hmac';
import { validateOutcomeBody, type BotOutcome, type BotOutcomeBody, type BotReport } from './bot-contract';
import {
  buildAppuntamentoNonFissabileNote,
  buildContattoUmanoNote,
  buildLockedNote,
  buildRichiamoSenzaDataNote,
  checkDataAppuntamento,
  checkDataRichiamo,
  isRichiestaDisdetta,
  resolveOutcomeAction,
} from './bot-outcome-rules';
import { bookingBlackout } from './booking-blackout';
import { estraiPeriodo } from './periodo-richiamo';
import { categoriaPerCrm, disponibilitaDalTesto, motivoRichiesta } from './contatti-umani';
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

/** Segna che il lead ha chiesto di annullare o spostare. Non tocca bot_outcome: è un
 *  marcatore, non un declassamento. Spegne promemoria pre-call e solleciti GDO. */
async function marcaDisdetta(supabase: Supa, conversationId: number, crmLeadId: string, outcome: BotOutcome): Promise<void> {
  const at = new Date().toISOString();
  await supabase.from('conversations').update({ cancel_requested_at: at }).eq('id', conversationId);
  await supabase.from('event_log').insert({
    type: 'cancel_requested',
    payload: { conversationId, crmLeadId, outcome, at } as never,
    message: `[bot-fissatore] il lead ${crmLeadId} ha chiesto di annullare/spostare: automatismi spenti su questa chat`,
    level: 'info',
  });
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
  if (isRichiestaDisdetta(args.outcome)) await marcaDisdetta(supabase, conversationId, crmLeadId, args.outcome);
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
  waNumber?: string | null,
  scheduledAt?: string | null,
): Promise<{ sent: boolean; status?: number; error?: string; notifySuppressed?: true }> {
  const note = args.notaContattoUmano
    ?? buildContattoUmanoNote({ leadWords: args.note, motivo: args.discardReason });
  // Contratto v1.5: oltre alle parole del lead viaggiano la categoria e i pochi fatti
  // che sappiamo. Una notifica senza questi arriva comunque, ma chi richiama parte
  // alla cieca — ed e' il motivo per cui 52 richieste su 53 non erano state lavorate.
  // La categoria esce dalle stesse regole dell'elenco in `/api/bot/contatti-umani`,
  // applicate alle parole con cui il lead ha chiesto la persona.
  const motivo = args.motivoContattoUmano ?? categoriaPerCrm(
    motivoRichiesta([{ body: args.note ?? '', created_at: new Date().toISOString() }]).categoria,
  );
  const disponibilita = disponibilitaDalTesto(args.note);
  // Un lead con l'appuntamento già fissato è di competenza delle Conferme, non di chi
  // fissa: senza questo campo il CRM non ha modo di saperlo e instrada la segnalazione
  // al GDO come tutte le altre (13 su 66 finivano così). Solo se c'è: niente null.
  const info = {
    ...(disponibilita ? { disponibilita } : {}),
    ...(waNumber ? { telefonoPreferito: waNumber } : {}),
    ...(scheduledAt ? { appuntamento: scheduledAt } : {}),
  };
  const body: BotOutcomeBody = {
    leadId: crmLeadId,
    outcome: 'CONTATTO_UMANO',
    note,
    motivo,
    ...(Object.keys(info).length > 0 ? { info } : {}),
  };
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
        payload: { conversationId, crmLeadId, note, motivo, info } as never,
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
  /** L'ultimo messaggio del lead, testuale: finisce fra virgolette nella nota al CRM.
   *  `note` e `discardReason` sono la sintesi del modello, cioè una parafrasi — le
   *  Conferme hanno chiesto anche le parole vere. */
  leadWords?: string;
  /** Solo per `CONTATTO_UMANO`: la categoria da mandare al CRM al posto di quella
   *  dedotta dalle parole del lead. Serve ai casi che non nascono da una richiesta —
   *  la risposta dopo il terzo tentativo di chiamata, che le regole leggerebbero come
   *  un "altro" qualunque mentre per le Conferme è un lead da riaprire. */
  motivoContattoUmano?: string;
  /** Solo per `CONTATTO_UMANO`: la nota già scritta, al posto di quella standard che
   *  dice "il bot si è fatto da parte" — cosa che in quei casi non è vera. */
  notaContattoUmano?: string;
};

/**
 * Invia l'esito al CRM per una conversazione CRM-linked. No-op per lead non-CRM.
 * Su 2xx persiste bot_outcome/at/scheduled/report e chiude la conversazione.
 */
/**
 * Una NOTA diretta al CRM, senza passare da `resolveOutcomeAction` e senza toccare
 * nessuno stato locale. Serve per i fatti che non sono esiti — il bot che riprende una
 * chat già restituita: la logica del lead terminale li tradurrebbe in altro.
 */
export async function sendCrmNota(
  supabase: Supa,
  conversationId: number,
  note: string,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { sent: false, error: 'not_configured' };
  const { data: conv } = await supabase
    .from('conversations')
    .select('crm_lead_id')
    .eq('id', conversationId)
    .maybeSingle();
  const crmLeadId = (conv as { crm_lead_id: string | null } | null)?.crm_lead_id ?? null;
  if (!crmLeadId) return { sent: false, error: 'not_crm_lead' };
  return inviaNotaAlCrm(supabase, conversationId, crmLeadId, note, undefined, secret);
}

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
    .select('crm_lead_id, bot_outcome, bot_scheduled_at, gdo_appuntamento_at, wa_number')
    .eq('id', conversationId)
    .maybeSingle();
  const row = conv as {
    crm_lead_id: string | null;
    bot_outcome: string | null;
    bot_scheduled_at: string | null;
    wa_number?: string | null;
    gdo_appuntamento_at?: string | null;
  } | null;
  const crmLeadId = row?.crm_lead_id ?? null;
  if (!crmLeadId) return { sent: false, error: 'not_crm_lead' };

  if (opts.noteOnly === true) {
    // Sui lead dei GDO l'appuntamento l'ha preso il commerciale al telefono e
    // bot_scheduled_at è nullo: la disdetta arrivava al CRM senza dire QUALE
    // appuntamento. `gdo_appuntamento_at` è la data che ci manda il CRM
    // (POST /api/appointment-set) ed è l'unica che abbiamo per quei lead.
    const dataNota = row?.bot_scheduled_at ?? row?.gdo_appuntamento_at ?? null;
    return sendCrmNoteOnly(supabase, conversationId, crmLeadId, args, dataNota, secret);
  }

  // Passa PRIMA di resolveOutcomeAction apposta: su un lead già APPUNTAMENTO il ramo
  // locked lo tradurrebbe in una nota generica "appuntamento mantenuto", e la richiesta
  // di parlare con una persona si perderebbe un'altra volta.
  if (args.outcome === 'CONTATTO_UMANO') {
    // Quale appuntamento ha davvero questo lead, e solo se ce l'ha.
    //
    // `bot_scheduled_at` da sola non basta e non basta nemmeno da sola: la valorizza il
    // ramo normale per QUALSIASI esito con una data, RICHIAMO compreso, e un lead con
    // un richiamo arriverebbe al CRM marcato "gia' fissato" e finirebbe alle Conferme
    // per un appuntamento che non esiste. Vale quindi solo quando l'esito e'
    // APPUNTAMENTO, come fa il cron dei promemoria pre-call.
    // `gdo_appuntamento_at` invece e' gia' di per se' un appuntamento -- l'ha preso un
    // commerciale al telefono e ce lo manda il CRM -- ed e' l'unica data che i lead
    // postino hanno: senza, escono senza data e il CRM li instrada al GDO invece che
    // alle Conferme, cioe' esattamente il caso che questo campo esiste per chiudere.
    const appuntamento =
      ((row?.bot_outcome ?? null) === 'APPUNTAMENTO' ? row?.bot_scheduled_at ?? null : null)
      ?? row?.gdo_appuntamento_at ?? null;
    return inviaContattoUmano(supabase, conversationId, crmLeadId, args, secret, row?.wa_number ?? null, appuntamento);
  }

  // Un lead con l'appuntamento già fissato che chiede di annullare o spostare va
  // marcato SUBITO: sotto, il ramo "RICHIAMO senza data" ritorna presto (prima di
  // arrivare a resolveOutcomeAction) e perderebbe la marcatura se non lo facessimo
  // qui. L'interim è un aggiornamento automatico della sequenza, non una richiesta
  // del lead: non marca mai.
  const holdsAppointment = (row?.bot_outcome ?? null) === 'APPUNTAMENTO';
  if (holdsAppointment && !interim && isRichiestaDisdetta(args.outcome)) {
    await marcaDisdetta(supabase, conversationId, crmLeadId, args.outcome);
  }

  // Un RICHIAMO senza una data che regga non è un richiamo: è un'ora inventata che
  // finisce in agenda a un commerciale. Al CRM va una nota con le parole del lead, e
  // la conversazione resta aperta — il bot deve poter ancora chiedere quando.
  // Esclude l'interim: quel RICHIAMO non è una richiesta del lead ma un ping
  // automatico della sequenza di follow-up, con data calcolata dal cron — se questa
  // guardia lo intercettasse lo tradurrebbe in una nota che racconta al commerciale
  // qualcosa che il lead non ha mai detto. L'interim ha già il suo percorso e le sue
  // regole più sotto (vedi `interim && action.kind !== 'normal'`).
  const dataCheck = args.outcome === 'RICHIAMO' && !interim ? checkDataRichiamo(args.date, Date.now()) : { ok: true as const };
  // Dal contratto v1.5 un richiamo senza data certa non deve piu' degradare a nota: se
  // il lead ha detto QUANDO con parole sue ("a settembre"), quelle parole viaggiano nel
  // campo `periodo` e il CRM lo registra come RICHIAMO vero. Nessuna deduzione: senza
  // un'espressione di tempo nelle sue parole si resta sulla nota di prima.
  const periodo = !dataCheck.ok ? estraiPeriodo(args.note) : null;
  if (!dataCheck.ok && periodo) {
    await supabase.from('event_log').insert({
      type: 'richiamo_con_periodo',
      payload: { conversationId, crmLeadId, motivo: dataCheck.motivo, dataScartata: args.date ?? null, periodo } as never,
      message: `[bot-fissatore] RICHIAMO senza data (${dataCheck.motivo}) per lead ${crmLeadId}: mandato come periodo "${periodo}"`,
      level: 'info',
    });
  }
  if (!dataCheck.ok && !periodo) {
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

  // Un appuntamento in un giorno chiuso, di domenica o fuori dalla fascia 09-21 non è
  // un appuntamento: è una riga in agenda a cui non risponde nessuno, e le Conferme e
  // il venditore la leggono come vera. Le regole stavano solo nel prompt, quindi
  // valevano finché era il bot a proporre il giorno e cadevano appena lo proponeva il
  // lead (27 call dentro la chiusura di ferragosto, 3 a mezzanotte).
  //
  // Dopo `resolveOutcomeAction` di proposito: su un lead che ha GIÀ un appuntamento
  // questo esito è una richiesta di spostamento, non un nuovo fissaggio, e ha già il
  // suo percorso (`locked` → NOTA). Qui si guarda solo il fissaggio vero.
  const appuntamentoCheck =
    args.outcome === 'APPUNTAMENTO' && !interim && (action.kind === 'normal' || action.kind === 'reschedule')
      ? checkDataAppuntamento(args.date, Date.now(), bookingBlackout(process.env.BOOKING_BLACKOUT))
      : { ok: true as const };
  if (!appuntamentoCheck.ok) {
    const note = buildAppuntamentoNonFissabileNote({
      motivo: appuntamentoCheck.motivo,
      dataScartata: args.date,
      leadWords: args.leadWords ?? args.note,
    });
    await supabase.from('event_log').insert({
      type: 'appuntamento_non_fissabile',
      payload: { conversationId, crmLeadId, motivo: appuntamentoCheck.motivo, dataScartata: args.date ?? null, note } as never,
      message: `[bot-fissatore] APPUNTAMENTO scartato (${appuntamentoCheck.motivo}) per lead ${crmLeadId}: inviato come nota`,
      level: 'warn',
    });
    const esito = await inviaNotaAlCrm(supabase, conversationId, crmLeadId, note, args.report, secret);
    return { ...esito, keepOpen: true };
  }

  // La marcatura (se dovuta) è già stata scritta sopra, prima del ramo "RICHIAMO
  // senza data": qui action.kind === 'locked' equivale a holdsAppointment, quindi non
  // si ripete. Resta comunque PRIMA della dedup che segue, altrimenti una nota già
  // inviata farebbe perdere il marcatore.

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
        // Col periodo la data non parte: e' proprio quella che non ci fidavamo a mandare.
        ...(periodo ? { periodo } : args.date ? { date: args.date } : {}),
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
      if (action.kind === 'reschedule') {
        // Si aggiorna la DATA, non l'esito. `bot_outcome_at` resta quello del primo
        // fissaggio di proposito: un lead spostato tre volte comparirebbe tre volte
        // fra gli appuntamenti presi oggi, e i nostri numeri direbbero il falso.
        // `cancel_requested_at` si azzera: l'appuntamento e' di nuovo vivo e i
        // promemoria pre-call devono ripartire sulla data nuova.
        await supabase.from('conversations').update({
          bot_scheduled_at: action.date,
          cancel_requested_at: null,
          ai_status: 'closed',
        }).eq('id', conversationId);
        await supabase.from('event_log').insert({
          type: 'bot_appuntamento_rifissato',
          payload: { conversationId, crmLeadId, da: row?.bot_scheduled_at ?? null, a: action.date } as never,
          message: `[bot-fissatore] appuntamento del lead ${crmLeadId} spostato al ${action.date}`,
          level: 'info',
        });
      } else if (action.kind === 'normal') {
        await supabase.from('conversations').update({
          bot_outcome: args.outcome,
          bot_outcome_at: new Date().toISOString(),
          bot_scheduled_at: periodo ? null : (args.date ?? null),
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
          bot_scheduled_at: periodo ? null : (args.date ?? null),
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
