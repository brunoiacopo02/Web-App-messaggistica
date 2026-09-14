import type { getSupabaseAdmin } from './supabase/admin';
import type { MarioTurn } from './mario';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { getLancioSettings, type LancioSettings } from './lancio-settings';
import { generateLancioReply } from './lancio-reply';
import { classificaLancio, type LancioReplyParsed } from './lancio-classifica';
import {
  contaScambiDomande, decideLancioTurno, LANCIO_FASI_B1, MAX_SCAMBI_DOMANDE,
  TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO,
  type ClasseLancio,
} from './lancio-fase';
import { impostaFaseLancio } from './lancio-db';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type TurnoLancioInput = {
  conversationId: number;
  phone: string;
  from: string;
  crmLeadId: string | null;
  fase: string | null;
  nome: string | null;
  rows: { direction: string; body: string | null; template_sid: string | null }[];
  inboundBody: string;
  /** Iniettabile nei test: di default il modello col prompt lancio. */
  genera?: typeof generateLancioReply;
  settings?: LancioSettings;
};

/**
 * Un turno della chat del lancio nella fase di attesa (spec §5.2). Chiamato dal drain
 * al posto di Mario quando `lancioInCorso` e' vero. Restituisce lo stato finale che il
 * drain scrive in `ai_status`.
 *
 * Ordine: classificazione deterministica; il modello solo se serve (domanda o incerto);
 * decisione pura (`decideLancioTurno`); effetti. Una bolla sola per turno, sempre la
 * traccia `fenice_ai_reply` — anche nel silenzio — perche' il re-drive di bot-followups
 * non rimetta in coda lo stesso inbound ogni ora.
 */
export async function eseguiTurnoLancio(supabase: Supa, i: TurnoLancioInput): Promise<'active' | 'closed' | 'handed_off'> {
  const genera = i.genera ?? generateLancioReply;
  const settings = i.settings ?? (await getLancioSettings(supabase));

  let classe: ClasseLancio = classificaLancio(i.inboundBody);
  let modello: LancioReplyParsed | null = null;
  const scambi = contaScambiDomande(i.rows);
  // Nelle fasi che questo blocco non gestisce (B4/B5) il turno e' silenzio comunque:
  // il modello non va interpellato, altrimenti un [PASSAGGIO_UMANO] o una risposta
  // pensata per la fase di attesa uscirebbe su una chat che sta gia' oltre il link.
  const faseGestita = (LANCIO_FASI_B1 as readonly string[]).includes(i.fase ?? '');
  // Il modello si interpella solo se puo' ancora rispondere: dopo il terzo scambio si
  // tace, e chiedere una risposta per poi buttarla costa e basta.
  const serveModello = faseGestita && (classe === 'incerto' || (classe === 'domanda' && scambi < MAX_SCAMBI_DOMANDE));
  if (serveModello) {
    const history: MarioTurn[] = i.rows.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body ?? '' }));
    modello = await genera(history, { fase: i.fase, nome: i.nome, eventoAt: settings.eventoAt });
    if (classe === 'incerto') classe = modello.classe;
  }

  const azione = decideLancioTurno({ fase: i.fase, classe, scambiDomande: scambi, passToHuman: modello?.passToHuman ?? false });

  const invia = async (body: string): Promise<void> => {
    const sent = await sendFreeText({ to: i.phone, body, from: i.from });
    await supabase.from('messages').insert({
      conversation_id: i.conversationId, direction: 'out', body,
      twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
    });
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', i.conversationId);
  };
  const evento = async (type: string, extra: Record<string, unknown>, message: string, level: 'info' | 'warn' = 'info') => {
    await supabase.from('event_log').insert({
      type, payload: { conversationId: i.conversationId, crmLeadId: i.crmLeadId, fase: i.fase, classe, ...extra } as never, message, level,
    });
  };

  let finalStatus: 'active' | 'closed' | 'handed_off' = 'active';
  let motivoSilenzio: string | null = null;

  switch (azione.kind) {
    case 'posto_bloccato': {
      await invia(azione.testo);
      await impostaFaseLancio(supabase, i.conversationId, 'posto_bloccato');
      await evento('lancio_posto_bloccato', {}, `[lancio] conv ${i.conversationId}: posto bloccato`);
      break;
    }
    case 'congedo': {
      await invia(azione.testo);
      await impostaFaseLancio(supabase, i.conversationId, 'chiuso');
      if (i.crmLeadId) {
        const esito = await sendOutcome(supabase, i.conversationId, {
          outcome: 'DA_SCARTARE',
          discardReason: 'non interessato',
          note: "Lancio Web Dev AI: ha risposto no al benvenuto della lista d'attesa.",
          leadWords: i.inboundBody,
        });
        if (esito.sent || esito.error === 'note_duplicate') finalStatus = 'closed';
      } else {
        finalStatus = 'closed';
      }
      await evento('lancio_congedo', { finalStatus }, `[lancio] conv ${i.conversationId}: non interessato, congedato`);
      break;
    }
    case 'domanda': {
      const testo = (modello?.visibleReply ?? '').trim();
      if (!testo) {
        motivoSilenzio = 'risposta_vuota';
        break;
      }
      await invia(azione.chiudi ? `${testo}\n${TESTO_CHIUSURA_DOMANDE}` : testo);
      await evento('lancio_domanda', { scambio: scambi + 1, chiuso: azione.chiudi }, `[lancio] conv ${i.conversationId}: risposta a domanda ${scambi + 1}/3`);
      break;
    }
    case 'passaggio_umano': {
      await invia((modello?.visibleReply ?? '').trim() || TESTO_PASSAGGIO_UMANO);
      if (i.crmLeadId) {
        const esito = await sendOutcome(supabase, i.conversationId, { outcome: 'CONTATTO_UMANO', note: i.inboundBody });
        if (!esito.sent) {
          await evento('contatto_umano_non_segnalato', { error: esito.error ?? null, status: esito.status ?? null },
            `[lancio] conv ${i.conversationId}: passaggio a una persona non segnalato al CRM`, 'warn');
        }
      }
      await supabase.from('conversations')
        .update({ handed_off_at: new Date().toISOString(), handed_off_reason: i.inboundBody })
        .eq('id', i.conversationId);
      finalStatus = 'handed_off';
      break;
    }
    case 'silenzio': {
      motivoSilenzio = azione.motivo;
      break;
    }
  }

  if (motivoSilenzio) {
    await evento('lancio_silenzio', { motivo: motivoSilenzio }, `[lancio] conv ${i.conversationId}: nessuna risposta (${motivoSilenzio})`);
  }
  await supabase.from('event_log').insert({
    type: 'fenice_ai_reply',
    payload: { conversationId: i.conversationId, phone: i.phone, lancio: true, azione: azione.kind, appointmentFixed: false, passToHuman: azione.kind === 'passaggio_umano' } as never,
    message: `[lancio] turno su ${i.phone}: ${azione.kind}`,
    level: 'info',
  });
  return finalStatus;
}
