import { inOpeningWindow } from './sequence';

/**
 * Il benvenuto del lancio che non e' partito all'intake (fuori dalla fascia 07-23 o
 * `lancio_attivo` spento) lo manda il cron `/api/cron/lancio-aperture`, non
 * `sequence-touches`: quelle chat la sequenza le esclude (`FILTRO_FUORI_LANCIO`) e
 * senza questo cron resterebbero mute per sempre.
 *
 * Modulo PURO: niente env, niente DB, niente rete. Il route legge e agisce.
 */

/** Quante volte si RITENTA dopo un invio fallito. Tentativi totali = 1 + questi.
 *  Oltre non si insiste: il numero e' morto o il template e' bloccato. */
export const MAX_TENTATIVI_BENVENUTO = 2;

/** Silenzio outbound richiesto prima di scrivere: e' la stessa soglia della guardia
 *  `apertura_recente` dell'intake (12h). Una chat riusata puo' avere addosso
 *  l'apertura di Mario di poco fa: il benvenuto del lancio non le va sopra. */
export const GAP_MIN_OUTBOUND_MS = 12 * 60 * 60 * 1000;

/** L'altra guardia dell'intake (`conversazione_viva`): se il lead ha scritto negli
 *  ultimi 7 giorni sta parlando con qualcuno, e un template non gli cade in mezzo a
 *  una conversazione. Le due guardie dell'intake valgono identiche qui: il cron manda
 *  lo stesso messaggio, solo piu' tardi. */
export const GAP_MIN_INBOUND_MS = 7 * 24 * 60 * 60 * 1000;

/** Meta: "troppi messaggi a questo numero". Non e' un invio fallito per colpa del
 *  numero, e' un rinvio: non consuma il budget dei ritentativi. */
export const CODICE_FREQUENCY_CAP = 63049;

/** Scarto di tolleranza sull'ancora dell'ingresso nel lancio: l'intake manda il
 *  benvenuto e SOLO DOPO scrive il proprio evento, quindi fra i due c'e' un attimo. E'
 *  lo stesso buffer 5' dei cron che tagliano la cronologia su `ai_started_at`. */
export const BUFFER_ANCORA_MS = 5 * 60_000;

/**
 * Dopo quanti minuti dall'inizio della live il benvenuto del lancio non parte piu'
 * (decisione PO del 25/09): la live dura ~90 minuti, piu' 10 di margine per chi resta
 * collegato. Da `lancio_evento_at` + 100' in poi un benvenuto direbbe ancora "lunedi' 5
 * alle 21" con un link Zoom morto: chi si iscrive dopo — o era in coda senza benvenuto —
 * lo prende Mario standard, che fissa la call e manda la registrazione
 * (`lancio_video_live_link`).
 */
export const BENVENUTO_CHIUSO_MIN_DOPO_EVENTO = 100;

/**
 * La finestra del benvenuto e' chiusa? Vero da `lancio_evento_at` + 100' in poi.
 * Evento assente o illeggibile = no: senza una data non si chiude niente, e si resta sul
 * comportamento di prima (benvenuto se il lancio e' acceso).
 */
export function benvenutoLancioChiuso(nowMs: number, eventoAtIso: string | null | undefined): boolean {
  if (!eventoAtIso) return false;
  const t = Date.parse(eventoAtIso);
  if (Number.isNaN(t)) return false;
  return nowMs >= t + BENVENUTO_CHIUSO_MIN_DOPO_EVENTO * 60_000;
}

export type AperturaLancioAzione = 'invia' | 'attendi' | 'salta';

/** Una riga `messages` in uscita, come serve qui. */
export type RigaOutbound = {
  template_sid: string | null;
  twilio_status: string | null;
  twilio_error_code: number | null;
  created_at: string | null;
};

/** Gli unici due stati Twilio che dicono "non e' arrivato". `queued`/`sent`/`accepted`
 *  (e lo stato ancora ignoto) valgono partito: nel dubbio non si ripete un template. */
const STATI_FALLITI: ReadonlySet<string> = new Set(['failed', 'undelivered']);

export type RiassuntoOutbound = {
  benvenutiRiusciti: number;
  benvenutiFalliti: number;
  ultimoOutboundMs: number | null;
};

/**
 * Cosa dice la cronologia in uscita di una chat del lancio.
 *
 * "Benvenuto gia' mandato" NON e' "c'e' almeno un outbound": una chat riusata porta
 * l'apertura di Mario del giro precedente, e un benvenuto fallito e' una riga anche
 * lui. Si guarda il SID del template del lancio e lo stato Twilio.
 *
 * E' la rete di sicurezza, non la prova principale: quella e' la colonna
 * `lancio_benvenuto_at`. Questo conteggio serve per il budget dei ritentativi e per le
 * righe nate prima che la colonna esistesse (in produzione: nessuna).
 */
export function riassumiOutboundLancio(
  rows: RigaOutbound[],
  welcomeSid: string | null,
  /**
   * Quando questa chat e' entrata nel giro corrente del lancio (`lancio_intake` piu'
   * recente, vedi `leggiIngressiLancioAt`). I benvenuti si contano solo da li' in avanti.
   *
   * Su una chat normale non cambia niente: l'ingresso viene prima del benvenuto, quindi
   * la rete anti-doppione resta quella di sempre — nessun allentamento su un numero a
   * qualita' LOW. Su una RIPARTENZA (chi aveva chiuso e si e' riscritto al lancio)
   * l'ingresso e' nuovo, quindi i benvenuti della vita precedente smettono di contare: e'
   * l'unico modo perche' il benvenuto riparta davvero anche quando l'intake lo differisce
   * — di notte, a lancio spento o oltre il tetto orario. Senza, la ripartenza e' una chat
   * muta con l'etichetta cambiata.
   *
   * `null` (nessun evento di ingresso: chi e' entrato dal pulsante della live, o le righe
   * piu' vecchie) = si conta su tutta la cronologia, cioe' il comportamento di sempre.
   */
  ingressoMs: number | null = null,
): RiassuntoOutbound {
  // L'intake manda il benvenuto PRIMA di scrivere il proprio evento, quindi il benvenuto
  // di questo stesso giro puo' avere un `created_at` di poco precedente all'ancora. Senza
  // lo scarto non verrebbe contato, e la rete dipenderebbe dall'ordine di due insert. E'
  // lo stesso buffer 5' che usano sequence-touches, bot-followups e gdo-video-followups.
  const taglio = ingressoMs === null ? null : ingressoMs - BUFFER_ANCORA_MS;
  let benvenutiRiusciti = 0;
  let benvenutiFalliti = 0;
  let ultimoOutboundMs: number | null = null;
  for (const r of rows) {
    const at = r.created_at ? Date.parse(r.created_at) : NaN;
    // Data illeggibile: la riga conta comunque. Si sbaglia dalla parte del non mandare.
    const dentroIlGiro = taglio === null || Number.isNaN(at) || at >= taglio;
    if (welcomeSid && r.template_sid === welcomeSid && dentroIlGiro) {
      if (STATI_FALLITI.has((r.twilio_status ?? '').toLowerCase())) {
        // Il frequency cap non e' un tentativo bruciato: la riga resta (la scrive
        // l'intake) e pesa sulla guardia 12h, ma il budget non la conta.
        if (r.twilio_error_code !== CODICE_FREQUENCY_CAP) benvenutiFalliti++;
      } else benvenutiRiusciti++;
    }
    // Il silenzio outbound NON si taglia sull'ingresso: serve a non scrivere sopra un
    // messaggio recente, e un messaggio recente disturba anche se e' della vita
    // precedente. Le 12 ore valgono su tutta la cronologia, come prima.
    if (!Number.isNaN(at) && (ultimoOutboundMs === null || at > ultimoOutboundMs)) {
      ultimoOutboundMs = at;
    }
  }
  return { benvenutiRiusciti, benvenutiFalliti, ultimoOutboundMs };
}

/**
 * Manda il benvenuto differito, aspetta, o lascia perdere questa chat.
 *
 * - `salta` e' definitivo per questo lead (fase avanzata, benvenuto gia' arrivato,
 *   tentativi esauriti): il run dopo lo scartera' allo stesso modo;
 * - `attendi` e' temporaneo (lancio spento, notte, outbound recente): si ripresenta.
 *
 * Il frequency cap Meta (63049) non passa di qui: non lascia righe e si ritenta al run
 * dopo, come nella sequenza.
 */
export function decideAperturaLancio(i: {
  nowMs: number;
  attivo: boolean;
  fase: string | null;
  /** `conversations.lancio_benvenuto_at`: timbrato = il benvenuto e' gia' partito. */
  benvenutoAt: string | null;
  benvenutiRiusciti: number;
  benvenutiFalliti: number;
  ultimoOutboundMs: number | null;
  ultimoInboundMs: number | null;
}): AperturaLancioAzione {
  if (i.fase !== 'attesa') return 'salta';
  if (i.benvenutoAt) return 'salta';
  if (i.benvenutiRiusciti > 0) return 'salta';
  if (i.benvenutiFalliti > MAX_TENTATIVI_BENVENUTO) return 'salta';
  if (!i.attivo) return 'attendi';
  if (!inOpeningWindow(i.nowMs)) return 'attendi';
  if (i.ultimoInboundMs !== null && i.nowMs - i.ultimoInboundMs < GAP_MIN_INBOUND_MS) return 'attendi';
  if (i.ultimoOutboundMs !== null && i.nowMs - i.ultimoOutboundMs < GAP_MIN_OUTBOUND_MS) return 'attendi';
  return 'invia';
}
