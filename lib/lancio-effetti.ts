import type { getSupabaseAdmin } from './supabase/admin';
import type { MarioTurn } from './mario';
import { sendFreeText, sendTemplate } from './twilio';
import { sendOutcome } from './bot-outcome';
import { impostaFaseLancio, marcaCongedo } from './lancio-db';
import { TESTO_CONGEDO, type RigaLancio } from './lancio-fase';
import type { LancioSettings } from './lancio-settings';
import type { TurnoLancioInput } from './lancio-turno';
import type { ModoPostPitch } from './lancio-scelta';
import { corpoSceltaPulsanti, sidSceltaPulsanti } from './lancio-pulsanti';

type Supa = ReturnType<typeof getSupabaseAdmin>;

// Gli effetti che i turni del B4 (assistenza, post-pitch, dopo la scelta) hanno in
// comune. Il turno del B1 (`eseguiTurnoLancio`, fasi attesa/posto_bloccato) tiene le sue
// copie inline: la sua versione del congedo ha addosso il caso "esito da ritentare" con
// le parole di allora, il conteggio degli scambi e un `evento()` che infila `classe` in
// ogni payload — estrarla non sarebbe uscita byte per byte uguale, e il congedo del B1 e'
// l'ultima cosa che vale la pena rifattorizzare a tre settimane dal lancio. Qui si evita
// pero' di riscriverla una terza e una quarta volta per B4/B5. Le SEMANTICHE sono quelle
// del B1, verificate riga per riga: chi le cambia qui le cambia anche li'.

/** L'evento se `lancio_evento_at` manca o è illeggibile: la data della spec. */
export const EVENTO_DEFAULT_ISO = '2026-10-05T21:00:00+02:00';

/**
 * L'istante dell'evento da cui derivano tutte le finestre del turno. Il cron del blast si
 * ferma se `lancio_evento_at` non si legge (manda messaggi a migliaia di persone: nel
 * dubbio non parte); un turno no — è già una conversazione aperta, e lasciarla muta
 * perché manca una riga di `app_settings` è il danno peggiore dei due.
 */
export function eventoAtDa(settings: LancioSettings): Date {
  const t = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  return new Date(Number.isNaN(t) ? Date.parse(EVENTO_DEFAULT_ISO) : t);
}

export type StatoTurno = 'active' | 'closed' | 'handed_off';
export type ContestoTurno = {
  conversationId: number;
  phone: string;
  from: string;
  crmLeadId: string | null;
  fase: string | null;
};

export function contestoDi(i: TurnoLancioInput): ContestoTurno {
  return { conversationId: i.conversationId, phone: i.phone, from: i.from, crmLeadId: i.crmLeadId, fase: i.fase };
}

export function historyDi(rows: RigaLancio[]): MarioTurn[] {
  return rows.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body ?? '' }));
}

/** Una bolla sola, registrata in `messages` come le altre del bot. */
export async function inviaBollaLancio(supabase: Supa, c: ContestoTurno, body: string): Promise<void> {
  const sent = await sendFreeText({ to: c.phone, body, from: c.from });
  await supabase.from('messages').insert({
    conversation_id: c.conversationId, direction: 'out', body,
    twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
  });
  await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', c.conversationId);
}

/** L'esito dell'invio della scelta: `motivo` c'e' solo quando i pulsanti NON sono partiti. */
export type EsitoSceltaPulsanti = { inviato: boolean; motivo?: string };

/**
 * La domanda della scelta, chiesta con i due pulsanti di WhatsApp (delibera PO 17/09).
 *
 * Si manda in sessione (il lead ha appena scritto: siamo dentro le 24h), ma resta un
 * Content template, quindi passa dallo stesso presidio categoria di tutti gli altri:
 * `sendTemplate` chiama `assertTemplateSendable`, e con `UTILITY_ONLY=1` un template non
 * UTILITY non parte. Qui quel blocco non deve MAI far fallire il turno: senza env, con il
 * template bloccato o con Twilio che risponde male, il lead riceve la stessa domanda
 * scritta di prima. Peggio dei pulsanti c'e' solo il silenzio nel mezzo della scelta.
 *
 * Il corpo salvato in `messages` e' quello del template, non una parafrasi del modello:
 * la cronologia che il turno dopo rilegge deve dire esattamente cosa ha letto il lead.
 */
export async function inviaSceltaLancio(
  supabase: Supa,
  c: ContestoTurno,
  modo: ModoPostPitch,
): Promise<EsitoSceltaPulsanti> {
  const body = corpoSceltaPulsanti(modo);
  const sid = sidSceltaPulsanti(modo);
  if (!sid) {
    await inviaBollaLancio(supabase, c, body);
    return { inviato: false, motivo: 'env_mancante' };
  }
  try {
    const sent = await sendTemplate({ to: c.phone, contentSid: sid, variables: {}, from: c.from });
    await supabase.from('messages').insert({
      conversation_id: c.conversationId, direction: 'out', body,
      twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
      template_sid: sid, is_template: true,
    });
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', c.conversationId);
    return { inviato: true };
  } catch (err) {
    await inviaBollaLancio(supabase, c, body);
    const msg = (err as { message?: string } | null)?.message;
    return { inviato: false, motivo: (msg ?? 'errore_invio').slice(0, 200) };
  }
}

export async function eventoLancio(
  supabase: Supa,
  c: ContestoTurno,
  type: string,
  extra: Record<string, unknown>,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  await supabase.from('event_log').insert({
    type,
    payload: { conversationId: c.conversationId, crmLeadId: c.crmLeadId, fase: c.fase, ...extra } as never,
    message,
    level,
  });
}

/**
 * La traccia che dice al re-drive di `bot-followups` "a questo inbound abbiamo già
 * risposto": senza, lo stesso turno ripartirebbe ogni ora (vedi `serveRedrive`). Stessa
 * forma del B1 — `type`, `payload.conversationId`, `lancio: true`, `azione` — più la
 * fase, che al re-drive non serve ma rende leggibile la riga in `event_log`.
 */
export async function tracciaTurnoLancio(
  supabase: Supa,
  c: ContestoTurno,
  azione: string,
  passToHuman = false,
): Promise<void> {
  await supabase.from('event_log').insert({
    type: 'fenice_ai_reply',
    payload: {
      conversationId: c.conversationId, phone: c.phone, lancio: true, fase: c.fase,
      azione, appointmentFixed: false, passToHuman,
    } as never,
    message: `[lancio] turno su ${c.phone} (${c.fase}): ${azione}`,
    level: 'info',
  });
}

/**
 * Un turno senza risposta. `definitivo=true` scrive anche la traccia (nessuno risponderà
 * a questo inbound: dopo mezzanotte, dopo la scelta); `false` la omette apposta, così il
 * re-drive delle 08:30 fa rispondere (post-pitch fra le 03:00 e le 08:30).
 */
export async function silenzioLancio(
  supabase: Supa,
  c: ContestoTurno,
  motivo: string,
  definitivo: boolean,
): Promise<'active'> {
  await eventoLancio(supabase, c, 'lancio_silenzio', { motivo, definitivo }, `[lancio] conv ${c.conversationId}: nessuna risposta (${motivo})`);
  if (definitivo) await tracciaTurnoLancio(supabase, c, 'silenzio');
  return 'active';
}

/**
 * Il no: testo fisso, marcatore durevole, `DA_SCARTARE` al CRM, fase `chiuso`. Le regole
 * sono quelle del congedo del B1, nello stesso ordine e con gli stessi confini:
 *
 * - il marcatore (`lancio_info.congedo_at`) si scrive sull'INVIO, non a valle dell'esito:
 *   il CRM può rifiutarlo e la fase restare com'era, ma il lead si è già tirato indietro
 *   e da quel momento né il blast del link né il follow-up devono più raggiungerlo;
 * - la fase diventa terminale SOLO se il CRM ha preso in carico lo scarto. Un 403 è
 *   definitivo quanto un 200 (il CRM dice "questo lead non è più del bot" e `sendOutcome`
 *   chiude la conversazione da solo): trattarlo come ritentabile lascerebbe la fase
 *   aperta per sempre. Un timeout o un 500 invece no: lo stato resta `active` e il turno
 *   dopo ritenta l'esito — con `giaInviato` per non mandare una seconda volta la frase.
 *
 * `opts.testo` esiste per il post-pitch (B4): là il congedo arriva DOPO la live, e la
 * frase del B1 ("non ti scrivo più per questo evento") parlerebbe di un evento che è
 * già passato. Il default resta `TESTO_CONGEDO`: tutto quello che c'era prima di questo
 * parametro si comporta esattamente come prima.
 */
export async function congedoLancio(
  supabase: Supa,
  c: ContestoTurno,
  leadWords: string,
  nota: string,
  opts: { giaInviato?: boolean; testo?: string } = {},
): Promise<StatoTurno> {
  const ritentato = opts.giaInviato === true;
  if (!ritentato) {
    await inviaBollaLancio(supabase, c, opts.testo ?? TESTO_CONGEDO);
    await marcaCongedo(supabase, c.conversationId);
  }

  let stato: StatoTurno = 'active';
  let accettato = true;
  let motivo: string | null = null;
  if (c.crmLeadId) {
    const esito = await sendOutcome(supabase, c.conversationId, {
      outcome: 'DA_SCARTARE',
      discardReason: 'non interessato',
      note: nota,
      ...(leadWords ? { leadWords } : {}),
    });
    accettato = esito.sent || esito.error === 'note_duplicate' || esito.status === 403;
    motivo = esito.sent
      ? null
      : esito.status === 403
        ? 'crm_403'
        : esito.error === 'note_duplicate'
          ? 'nota_duplicata'
          : (esito.error ?? `http_${esito.status ?? '?'}`);
  }
  if (accettato) {
    await impostaFaseLancio(supabase, c.conversationId, 'chiuso');
    stato = 'closed';
  }

  await eventoLancio(
    supabase, c, 'lancio_congedo', { finalStatus: stato, ritentato, accettato, motivo },
    `[lancio] conv ${c.conversationId}: non interessato, congedato${accettato ? '' : ' (esito al CRM da ritentare)'}`,
    accettato ? 'info' : 'warn',
  );
  await tracciaTurnoLancio(supabase, c, 'congedo');
  return stato;
}
