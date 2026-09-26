import type { getSupabaseAdmin } from './supabase/admin';
import { sendTemplate, getTemplateBody } from './twilio';
import { mittentePerNuovaConversazione } from './mittente';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type LeadInfo = {
  phone: string; // E.164
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  acContactId?: string | null;
};

export type NascitaConversazione = {
  /**
   * Il numero da scrivere in `wa_number` se la conversazione nasce adesso.
   * - assente (`undefined`): nasce sul primario (`mittentePerNuovaConversazione`). Chi
   *   vuole un secondario lo sceglie prima con `scegliMittenteNuovo`
   *   (lib/scelta-mittente.ts) e lo passa qui come stringa;
   * - una stringa: quel numero, perche' chi chiama sa gia' da dove mandera';
   * - `null`: nessun numero, perche' la conversazione non nasce dal bot Fenice.
   * Su una conversazione gia' esistente non ha nessun effetto: il numero e' il suo.
   */
  mittente?: string | null;
};

/**
 * Trova o crea lead (per telefono) e la sua conversazione. Non sovrascrive con null
 * i campi non forniti (così non cancella dati esistenti del lead).
 *
 * Alla nascita scrive `wa_number`, il numero da cui la chat parlera' per sempre: e'
 * l'unico momento in cui il mittente si sceglie. Da qui in poi ogni invio lo legge
 * (`mittenteDiConversazione`), perche' cambiare numero a chat aperta la spezza in due
 * thread e chiude la finestra delle 24 ore. `waNumber` torna al chiamante cosi' com'e'
 * a DB: `null` sulle conversazioni nate prima di questa regola.
 */
export async function findOrCreateLeadConversation(
  supabase: Supa,
  info: LeadInfo,
  nascita: NascitaConversazione = {},
): Promise<{ leadId: number; conversationId: number; waNumber: string | null }> {
  const payload: Record<string, unknown> = { phone_e164: info.phone };
  if (info.firstName != null) payload.first_name = info.firstName;
  if (info.lastName != null) payload.last_name = info.lastName;
  if (info.email != null) payload.email = info.email;
  if (info.acContactId != null) payload.ac_contact_id = info.acContactId;

  const { data: leadRow, error } = await supabase
    .from('leads')
    .upsert(payload as never, { onConflict: 'phone_e164' })
    .select('id')
    .single();
  if (error || !leadRow) throw new Error(`lead upsert fallito: ${error?.message}`);

  const { data: convExisting } = await supabase
    .from('conversations')
    .select('id, wa_number')
    .eq('lead_id', leadRow.id)
    .maybeSingle();
  if (convExisting) {
    return { leadId: leadRow.id, conversationId: convExisting.id, waNumber: convExisting.wa_number ?? null };
  }

  // Il numero si decide SOLO qui, sulla riga che sta nascendo: rifarlo su una chat
  // esistente vorrebbe dire cambiarle numero.
  const waNumber = nascita.mittente === undefined ? (mittentePerNuovaConversazione() ?? null) : nascita.mittente;
  const { data: convNew, error: convErr } = await supabase
    .from('conversations')
    .insert({ lead_id: leadRow.id, wa_number: waNumber })
    .select('id')
    .single();
  if (convErr || !convNew) throw new Error(`conversazione create fallita: ${convErr?.message}`);
  return { leadId: leadRow.id, conversationId: convNew.id, waNumber };
}

/**
 * Invia un template a una conversazione esistente e registra il messaggio (out).
 * In caso di errore Twilio registra comunque un messaggio 'failed'.
 */
export async function sendTemplateAndLog(
  supabase: Supa,
  conversationId: number,
  phone: string,
  templateSid: string,
  label: string,
  from?: string,
  variables: Record<string, string> = {},
  bodyOverride?: string,
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  // `from` anche qui: il testo del template si legge dall'account che possiede il
  // mittente, e il SID di un account sull'altro torna 404 (vedi `getTemplateBody`).
  const tplBody = bodyOverride ?? (await getTemplateBody(templateSid, from)) ?? `[template] ${label}`;
  try {
    const sent = await sendTemplate({ to: phone, contentSid: templateSid, variables, from });
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
      template_sid: templateSid,
      is_template: true,
      sender: 'automazione',
    });
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
    return { ok: true, sid: sent.sid };
  } catch (err: unknown) {
    const e = err as { message?: string; code?: number };
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_status: 'failed',
      twilio_error_code: e?.code ?? null,
      template_sid: templateSid,
      is_template: true,
      sender: 'automazione',
    });
    // Il MOTIVO va scritto da qualche parte. Prima si perdeva: gli errori che
    // non vengono da Twilio (le nostre guardie, una fetch andata male) non
    // hanno un `code` numerico, quindi la riga del messaggio restava con
    // `twilio_status='failed'` e basta — nessun codice, nessun testo. Il
    // 17/09/2026 per capire perche' 68 invii non erano partiti e' servito
    // rileggere il codice riga per riga, e la causa non si e' comunque vista
    // dai dati. Ora la si legge in una query.
    await supabase.from('event_log').insert({
      type: 'invio_template_fallito',
      payload: {
        conversationId, templateSid, label, from: from ?? null,
        code: e?.code ?? null,
      } as never,
      message: `[invio] template ${label} non partito da ${from ?? 'mittente predefinito'}: ${e?.message ?? 'errore sconosciuto'}`,
      level: 'error',
    });
    return { ok: false, error: e?.message ?? 'unknown' };
  }
}
