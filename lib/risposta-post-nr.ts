import type { getSupabaseAdmin } from './supabase/admin';
import { sendOutcome } from './bot-outcome';
import { buildRispostaPostNrNote } from './bot-outcome-rules';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il lead ha risposto al messaggio che gli abbiamo mandato dopo il TERZO tentativo di
 * chiamata andato a vuoto.
 *
 * Perché serve una segnalazione apposta (29/08/2026, dal team CRM): al terzo NR il loro
 * sistema **scarta già** il lead, in automatico e nello stesso istante, e non lo riapre
 * da solo — l'evento è partito verso il marketing e ha già contato nelle statistiche di
 * conferma, e un lead che entra ed esce dai numeri per conto suo li rende inaffidabili.
 * Solo le Conferme possono riaprirlo, a mano.
 *
 * Fin qui mandavamo `CONTATTO_UMANO` solo quando il lead **chiedeva** di parlare con
 * una persona. Ma chi risponde "sì scusate, ero al lavoro" non sta chiedendo niente:
 * per noi era un lead che aveva semplicemente risposto, e dall'altra parte restava
 * scartato per sempre. Da qui in poi qualsiasi risposta dopo il terzo tentativo diventa
 * una segnalazione.
 *
 * Non tocca lo stato della conversazione: il bot continua a lavorare la chat. Questa è
 * una notifica a chi deve riaprire il lead, non un passaggio di consegne.
 */
export const MOTIVO_RISPOSTA_NR = 'risposta_dopo_terzo_nr';

/** Il tentativo che fa scattare la segnalazione: il terzo, quello che li scarta. */
export const TENTATIVO_TERMINALE = 3;

export type StatoRisposta = {
  /** Quando è partito il nostro messaggio di terzo tentativo, o `null` se mai. */
  terzoNrInviatoAt: string | null;
  /** L'ultimo messaggio DEL LEAD, o `null` se non ha mai scritto. */
  ultimoInboundAt: string | null;
  /** Per questa conversazione la segnalazione è già partita. */
  giaSegnalato: boolean;
};

/**
 * Si segnala una volta sola, e solo se il lead ha scritto DOPO il nostro messaggio.
 * Una risposta precedente al terzo tentativo è la conversazione di prima: segnalarla
 * manderebbe le Conferme a riaprire un lead che non ha detto niente di nuovo.
 */
export function deveSegnalare(s: StatoRisposta): boolean {
  if (!s.terzoNrInviatoAt || !s.ultimoInboundAt) return false;
  if (s.giaSegnalato) return false;
  const nr = Date.parse(s.terzoNrInviatoAt);
  const inbound = Date.parse(s.ultimoInboundAt);
  if (Number.isNaN(nr) || Number.isNaN(inbound)) return false;
  return inbound > nr;
}

/**
 * Legge lo stato, decide, e se serve segnala. Chiamata dal webhook Twilio a ogni
 * messaggio in ingresso, fuori dal `drainMarioReplies`: il drain claima solo le
 * conversazioni `active`, e questa segnalazione deve partire anche da una chat che è
 * rimasta `booked` — cioè proprio da quella di un lead con l'appuntamento in piedi, che
 * è il caso per cui esiste.
 *
 * Non lancia mai: un errore qui non deve far fallire il webhook di Twilio.
 */
export async function segnalaRispostaDopoTerzoNr(
  supabase: Supa,
  conversationId: number,
  crmLeadId: string,
): Promise<{ segnalato: boolean; motivo?: string }> {
  try {
    const { data: nr } = await supabase
      .from('event_log')
      .select('created_at')
      .eq('type', 'recupero_nr_inviato')
      .eq('payload->>conversationId', String(conversationId))
      .eq('payload->>tentativo', String(TENTATIVO_TERMINALE))
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const terzoNrInviatoAt = (nr as { created_at: string } | null)?.created_at ?? null;
    if (!terzoNrInviatoAt) return { segnalato: false, motivo: 'nessun_terzo_tentativo' };

    const { data: gia } = await supabase
      .from('event_log')
      .select('id')
      .eq('type', 'risposta_post_nr_segnalata')
      .eq('payload->>conversationId', String(conversationId))
      .limit(1)
      .maybeSingle();

    const { data: ultimo } = await supabase
      .from('messages')
      .select('body, created_at')
      .eq('conversation_id', conversationId)
      .eq('direction', 'in')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const inbound = ultimo as { body: string | null; created_at: string } | null;

    if (!deveSegnalare({
      terzoNrInviatoAt,
      ultimoInboundAt: inbound?.created_at ?? null,
      giaSegnalato: Boolean(gia),
    })) {
      return { segnalato: false, motivo: 'niente_da_segnalare' };
    }

    // Il lucchetto si scrive PRIMA della chiamata al CRM, come nel recupero NR: due
    // messaggi ravvicinati del lead (che nelle chat vere sono la norma: "sì" e poi
    // "scusate ero al lavoro") arriverebbero altrimenti come due notifiche.
    const { error: erroreClaim } = await supabase.from('event_log').insert({
      type: 'risposta_post_nr_segnalata',
      payload: { conversationId, crmLeadId, tentativo: TENTATIVO_TERMINALE } as never,
      message: `[crm] il lead ${crmLeadId} ha risposto dopo il terzo tentativo di chiamata: segnalato alle Conferme`,
      level: 'info',
    });
    if (erroreClaim) return { segnalato: false, motivo: 'lucchetto_non_scrivibile' };

    const esito = await sendOutcome(supabase, conversationId, {
      outcome: 'CONTATTO_UMANO',
      note: inbound?.body ?? undefined,
      motivoContattoUmano: MOTIVO_RISPOSTA_NR,
      notaContattoUmano: buildRispostaPostNrNote({
        leadWords: inbound?.body ?? undefined,
        quandoNrIso: terzoNrInviatoAt,
      }),
    });
    if (!esito.sent) {
      // La riga del lucchetto resta: ritentare vorrebbe dire riprovare a ogni messaggio
      // del lead e riempire la coda delle Conferme di doppioni. Si registra l'errore,
      // che è visibile come tutti gli altri.
      await supabase.from('event_log').insert({
        type: 'risposta_post_nr_non_segnalata',
        payload: { conversationId, crmLeadId, error: esito.error ?? null, status: esito.status ?? null } as never,
        message: `[crm] conv ${conversationId}: risposta dopo il terzo NR non segnalata al CRM (${esito.error ?? esito.status})`,
        level: 'error',
      });
      return { segnalato: false, motivo: 'crm_ko' };
    }
    return { segnalato: true };
  } catch {
    return { segnalato: false, motivo: 'errore' };
  }
}
