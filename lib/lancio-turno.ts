import type { getSupabaseAdmin } from './supabase/admin';
import type { MarioTurn } from './mario';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { getLancioSettings, type LancioSettings } from './lancio-settings';
import { generateLancioReply } from './lancio-reply';
import { classificaLancio, type LancioReplyParsed } from './lancio-classifica';
import {
  congedoGiaInviato, contaScambiDomande, decideLancioTurno, faseGestitaB1, inboundDelLotto,
  MAX_SCAMBI_DOMANDE, paroleDelCongedo, tagliaRigheDalLancio, TESTO_CHIUSURA_DOMANDE, TESTO_CONGEDO,
  TESTO_PASSAGGIO_UMANO, ultimoTestoDelLotto,
  type ClasseLancio, type LancioAzione, type RigaLancio,
} from './lancio-fase';
import { impostaFaseLancio, leggiIngressoLancioAt, marcaCongedo } from './lancio-db';
import { turnoAssistenza } from './lancio-assistenza';
import { turnoPostPitch, turnoDopoScelta } from './lancio-post-pitch';
import { adessoLancio } from './lancio-orologio';
import type { LancioInfo } from './lancio-crm';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type TurnoLancioInput = {
  conversationId: number;
  phone: string;
  from: string;
  crmLeadId: string | null;
  fase: string | null;
  nome: string | null;
  rows: RigaLancio[];
  /** L'inbound che il drain ha scelto (il PRIMO rimasto senza risposta). Non e' su
   *  questo che si classifica — vedi `inboundDelLotto` — ma serve a distinguere il
   *  silenzio "non ha scritto niente" da quello "ha scritto prima del lancio". */
  inboundBody: string;
  /** Iniettabile nei test: di default il modello col prompt lancio. */
  genera?: typeof generateLancioReply;
  settings?: LancioSettings;
  /** `conversations.lancio_info` letto dal claim: le risposte del post-pitch (B4). */
  lancioInfo?: LancioInfo | null;
  /** L'orologio del turno (B4): di default `adessoLancio()`. Iniettabile nei test. */
  now?: Date;
};

/**
 * Un turno della chat del lancio. Chiamato dal drain al posto di Mario quando
 * `lancioInCorso` e' vero; restituisce lo stato finale che il drain scrive in
 * `ai_status`. Le fasi attesa/posto_bloccato (spec §5.2) sono qui sotto; link_inviato,
 * post_pitch e scelta_fatta (spec §5.3-5.4) stanno nei moduli del B4, a cui lo `switch`
 * in testa delega con le righe gia' tagliate al lancio.
 *
 * Ordine: taglio della cronologia al lancio; classificazione deterministica; il modello
 * solo se serve (domanda o incerto, e solo se puo' ancora rispondere); decisione pura
 * (`decideLancioTurno`); effetti. Una bolla sola per turno, sempre la traccia
 * `fenice_ai_reply` — anche nel silenzio — perche' il re-drive di bot-followups non
 * rimetta in coda lo stesso inbound ogni ora.
 */
export async function eseguiTurnoLancio(supabase: Supa, i: TurnoLancioInput): Promise<'active' | 'closed' | 'handed_off' | 'handed_to_mario'> {
  const genera = i.genera ?? generateLancioReply;

  // Ha risposto al follow-up del giorno dopo (spec §5.5): da qui la chat e' di Mario
  // standard. Si chiude il lancio e si torna 'handed_to_mario': il drain lo intercetta
  // nel ciclo dei giri, esce dal ramo lancio e prosegue NELLO STESSO drain col flusso
  // classico (prompt Mario, slot, form, Conferme), con la sola differenza del video (la
  // live editata, via contextNote). 'handed_to_mario' NON e' uno stato di ai_status.
  // Niente bolla qui, niente traccia `fenice_ai_reply`: a questo inbound risponde Mario
  // fra un istante, e la traccia la scrive lui. Il taglio delle righe non serve: non si
  // interpella nessuno. Nessun `soloDaFasi`: dentro un turno il lucchetto del drain
  // serializza gia'.
  if (i.fase === 'followup_inviato') {
    await impostaFaseLancio(supabase, i.conversationId, 'chiuso');
    await supabase.from('event_log').insert({
      type: 'lancio_followup_risposta',
      payload: { conversationId: i.conversationId, crmLeadId: i.crmLeadId, testo: i.inboundBody.slice(0, 300) } as never,
      message: `[lancio] conv ${i.conversationId}: ha risposto al follow-up, la chat passa a Mario`,
      level: 'info',
    });
    return 'handed_to_mario';
  }

  // Solo quello che il lead ha scritto DENTRO il lancio: su una chat riusata il drain
  // carica anche il giro precedente di Mario (vedi `tagliaRigheDalLancio`).
  const welcomeSid = process.env.LANCIO_WELCOME_TEMPLATE_SID || null;
  const conBenvenuto = welcomeSid != null && i.rows.some((m) => m.template_sid === welcomeSid);
  const righe = tagliaRigheDalLancio(
    i.rows,
    welcomeSid,
    conBenvenuto ? null : await leggiIngressoLancioAt(supabase, i.conversationId),
  );

  // Dal blast in poi ogni fase ha il suo turno (B4). Le righe che passano di qui sono
  // gia' tagliate al lancio: il taglio si fa una volta sola, prima dello switch, o su una
  // chat riusata il giro precedente di Mario finirebbe nella cronologia che assistenza e
  // post-pitch mandano al modello. L'orologio e' uno solo per il turno: da li' passano le
  // regole di finestra e le ore proponibili.
  if (i.fase === 'link_inviato' || i.fase === 'post_pitch' || i.fase === 'scelta_fatta') {
    const ctx = { settings: i.settings ?? (await getLancioSettings(supabase)), now: i.now ?? adessoLancio() };
    const iB4 = { ...i, rows: righe };
    switch (i.fase) {
      case 'link_inviato': return turnoAssistenza(supabase, iB4, ctx);
      case 'post_pitch': return turnoPostPitch(supabase, iB4, ctx);
      case 'scelta_fatta': return turnoDopoScelta(supabase, iB4, ctx);
    }
  }
  // attesa / posto_bloccato: il turno del B1 qui sotto; followup_inviato: B5.

  const scambi = contaScambiDomande(righe);
  const faseGestita = faseGestitaB1(i.fase);
  // Il congedo e' uscito ma la fase non e' terminale: il CRM aveva rifiutato l'esito e
  // questo turno serve solo a ritentarlo. Niente modello, niente seconda bolla e
  // nessuna riclassificazione — chi ha detto no resta un no anche se poi scrive "ok".
  const daRitentare = faseGestita && congedoGiaInviato(righe);

  // Si risponde al LOTTO, non al singolo inbound che il drain ha scelto: il drain passa
  // il primo messaggio rimasto senza risposta, e classificare quello lasciava nel buio
  // tutti i successivi. Uno sticker seguito da "sì" faceva un turno muto (e la traccia
  // `fenice_ai_reply` toglieva pure il re-drive: quel sì non bloccava il posto mai
  // piu'); un "ok" seguito da "toglimi dalla lista" mandava al CRM il primo e buttava
  // il secondo.
  const lotto = inboundDelLotto(righe);
  const testoLead = ultimoTestoDelLotto(lotto);

  // Il drain sceglie l'inbound dalle righe NON tagliate: su una chat riusata puo' essere
  // un messaggio di prima del lancio, rimasto senza risposta nel giro di Mario. Dentro
  // il lancio non c'e' nessun messaggio del lead, quindi il lotto e' vuoto: non e' la
  // risposta al benvenuto e non va letta come tale — il turno tace e lascia la traccia,
  // cosi' il re-drive non ci ritorna sopra ogni ora.
  const inboundFuoriLancio = lotto.length === 0 && i.inboundBody.trim() !== '';

  let classe: ClasseLancio = classificaLancio(testoLead);
  let modello: LancioReplyParsed | null = null;
  // Il modello si interpella solo se puo' ancora rispondere: nelle fasi di B4/B5 il
  // turno e' silenzio comunque, dopo il terzo scambio si tace, e su un inbound senza
  // testo (una foto, un audio) non c'e' niente da leggere. Chiedere una risposta per poi
  // buttarla costa e basta — e su una fase non gestita un [PASSAGGIO_UMANO] pensato per
  // l'attesa uscirebbe su una chat che sta gia' oltre il link.
  const serveModello =
    faseGestita && !daRitentare && !inboundFuoriLancio
    && testoLead !== '' && scambi < MAX_SCAMBI_DOMANDE
    && (classe === 'incerto' || classe === 'domanda');
  if (serveModello) {
    const settings = i.settings ?? (await getLancioSettings(supabase));
    // Tutta la storia del lancio, lotto compreso: il modello legge anche i messaggi del
    // lead che vengono prima di quello su cui abbiamo classificato.
    const history: MarioTurn[] = righe.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body ?? '' }));
    modello = await genera(history, { fase: i.fase, nome: i.nome, eventoAt: settings.eventoAt });
    if (classe === 'incerto') classe = modello.classe;
  }

  const azione: LancioAzione = daRitentare
    ? { kind: 'congedo', testo: TESTO_CONGEDO }
    : inboundFuoriLancio
      ? { kind: 'silenzio', motivo: 'inbound_fuori_lancio' }
      : decideLancioTurno({ fase: i.fase, classe, scambiDomande: scambi, passToHuman: modello?.passToHuman ?? false });

  const invia = async (body: string): Promise<void> => {
    const sent = await sendFreeText({ to: i.phone, body, from: i.from });
    await supabase.from('messages').insert({
      conversation_id: i.conversationId, direction: 'out', body,
      twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
    });
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', i.conversationId);
  };
  const evento = async (type: string, extra: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') => {
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
      if (!daRitentare) {
        await invia(azione.testo);
        // Il marcatore va scritto qui, sull'invio, non a valle dell'esito: il CRM puo'
        // rifiutarlo e la fase restare 'attesa', ma il lead si e' gia' tirato indietro
        // e da questo momento nessuno deve piu' scrivergli per il lancio.
        await marcaCongedo(supabase, i.conversationId);
      }
      // La fase diventa terminale SOLO quando il CRM ha preso in carico lo scarto.
      // Prima si chiudeva comunque: se il callback falliva, il lead che aveva appena
      // detto "non mi interessa" tornava a Mario al messaggio dopo e il DA_SCARTARE non
      // veniva piu' ritentato da nessuno.
      // Su un esito ritentato le parole da mandare al CRM sono quelle di allora: quello
      // che il lead ha scritto DOPO il congedo non e' il motivo dello scarto.
      const parole = daRitentare ? paroleDelCongedo(righe) ?? undefined : testoLead;
      let motivo: string | null = null;
      let accettato = true;
      if (i.crmLeadId) {
        const esito = await sendOutcome(supabase, i.conversationId, {
          outcome: 'DA_SCARTARE',
          discardReason: 'non interessato',
          note: "Lancio Web Dev AI: ha risposto no al benvenuto della lista d'attesa.",
          ...(parole ? { leadWords: parole } : {}),
        });
        // Il 403 e' definitivo quanto un 200: il CRM rifiuta l'esito (lead non piu' del
        // bot) e `sendOutcome` lo registra localmente chiudendo la conversazione.
        // Trattarlo come ritentabile lascerebbe la fase su 'attesa' per sempre — il lead
        // resterebbe nel pubblico che B4 va a chiamare e ogni suo messaggio ri-POSTerebbe
        // lo stesso scarto.
        accettato = esito.sent || esito.error === 'note_duplicate' || esito.status === 403;
        motivo = esito.sent ? null
          : esito.status === 403 ? 'crm_403'
            : esito.error === 'note_duplicate' ? 'nota_duplicata'
              : (esito.error ?? `http_${esito.status ?? '?'}`);
      }
      if (accettato) {
        await impostaFaseLancio(supabase, i.conversationId, 'chiuso');
        finalStatus = 'closed';
      }
      await evento('lancio_congedo', { finalStatus, ritentato: daRitentare, accettato, motivo },
        `[lancio] conv ${i.conversationId}: non interessato, congedato${accettato ? '' : ' (esito al CRM da ritentare)'}`,
        accettato ? 'info' : 'warn');
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
        const esito = await sendOutcome(supabase, i.conversationId, { outcome: 'CONTATTO_UMANO', note: testoLead });
        if (!esito.sent) {
          await evento('contatto_umano_non_segnalato', { error: esito.error ?? null, status: esito.status ?? null },
            `[lancio] conv ${i.conversationId}: passaggio a una persona non segnalato al CRM`, 'warn');
        }
      }
      // Come nel percorso di Mario: se la colonna non c'e' l'errore non si propaga, ma
      // resta scritto che il motivo del passaggio non e' stato registrato.
      const { error: errHandoff } = await supabase.from('conversations')
        .update({ handed_off_at: new Date().toISOString(), handed_off_reason: testoLead })
        .eq('id', i.conversationId);
      if (errHandoff) {
        await evento('handed_off_non_registrato', { error: errHandoff.message },
          `[lancio] conv ${i.conversationId}: motivo del passaggio non registrato (${errHandoff.message})`, 'warn');
      }
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
