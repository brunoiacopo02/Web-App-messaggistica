import type { getSupabaseAdmin } from './supabase/admin';
import type { Json } from './supabase/types';
import type { LancioFase } from './lancio-fase';
import { FINESTRA_TETTO_MS } from './lancio-tetto';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Com'e' andata la scrittura della fase. Serve a chi scrive da un cron con `soloDaFasi`:
 * `non_cambiata` vuol dire che qualcun altro ha portato avanti quella chat mentre il run
 * era in volo, e chi chiama deve fermarsi li' invece di proseguire come se avesse scritto.
 */
export type EsitoFase = 'cambiata' | 'non_cambiata' | 'errore';

/**
 * Cambio di fase di una chat del lancio: un update e una traccia. E' l'unico punto che
 * scrive `lancio_fase`, cosi' la storia di ogni chat si ricostruisce da `event_log`
 * (`lancio_fase_cambiata`) senza interpretare gli altri eventi. B4 (link, post_pitch,
 * scelta) e B5 (follow-up, restituzione) passano da qui.
 */
export async function impostaFaseLancio(
  supabase: Supa,
  conversationId: number,
  fase: LancioFase,
  campi: { lancio_link_inviato_at?: string; lancio_followup_inviato_at?: string; lancio_info?: Json } = {},
  /**
   * `soloDaFasi`: compare-and-set sulla fase di partenza. Serve a chi scrive la fase da
   * un cron, in parallelo a un turno che sta girando sulla stessa chat — il blast del
   * link (B4) contro il turno dell'attesa (B1): il blast scriveva `link_inviato` alla
   * cieca e poteva riportare indietro una chat appena passata a `posto_bloccato`, col
   * link ormai partito. Con la guardia, se nel frattempo la fase e' avanzata la riga non
   * si tocca e resta la traccia `lancio_fase_non_cambiata`. Senza, il comportamento e'
   * quello di sempre: chi scrive dentro un turno gia' serializzato non ne ha bisogno.
   */
  opzioni: { soloDaFasi?: readonly LancioFase[] } = {},
): Promise<EsitoFase> {
  const base = supabase
    .from('conversations')
    .update({ lancio_fase: fase, ...campi })
    .eq('id', conversationId);
  const { error, cambiata } = opzioni.soloDaFasi
    ? await (async () => {
        const { data, error: e } = await base.in('lancio_fase', opzioni.soloDaFasi as LancioFase[]).select('id');
        return { error: e, cambiata: !e && (data ?? []).length > 0 };
      })()
    : { error: (await base).error, cambiata: true };
  const tipo = error ? 'lancio_fase_non_scritta' : cambiata ? 'lancio_fase_cambiata' : 'lancio_fase_non_cambiata';
  await supabase.from('event_log').insert({
    type: tipo,
    payload: {
      conversationId, fase, ...campi,
      ...(opzioni.soloDaFasi ? { soloDaFasi: opzioni.soloDaFasi } : {}),
      ...(error ? { errore: error.message } : {}),
    } as never,
    message: error
      ? `[lancio] conv ${conversationId}: fase ${fase} NON scritta — ${error.message}`
      : cambiata
        ? `[lancio] conv ${conversationId}: fase → ${fase}`
        : `[lancio] conv ${conversationId}: fase ${fase} non scritta, la chat era gia' oltre`,
    level: error ? 'error' : 'info',
  });
  return error ? 'errore' : cambiata ? 'cambiata' : 'non_cambiata';
}

/**
 * Il marcatore durevole del congedo su `conversations.lancio_info`: si scrive quando la
 * frase di congedo e' PARTITA, a prescindere da come e' andato l'esito al CRM.
 *
 * La cronologia da sola non basta: chi deve sapere che questa persona si e' tirata
 * indietro — la riapertura del webhook, il blast del link di B4, il follow-up di B5 —
 * ha davanti una riga `conversations`, non i messaggi, e la fase puo' essere rimasta
 * 'attesa' perche' il CRM ha rifiutato lo scarto. Il merge tiene le chiavi che B4 ci
 * scrive (le risposte di riscaldamento), quindi si legge prima di scrivere.
 *
 * Non lancia: un lead congedato resta congedato anche se questa riga non si scrive, e
 * il turno non deve morire qui.
 */
export async function marcaCongedo(
  supabase: Supa,
  conversationId: number,
  quandoIso: string = new Date().toISOString(),
): Promise<void> {
  const { data, error: erroreLettura } = await supabase
    .from('conversations')
    .select('lancio_info')
    .eq('id', conversationId)
    .maybeSingle();
  // Lettura fallita: NON si scrive. Con un fallback a `{}` l'update sostituirebbe
  // `lancio_info` per intero e butterebbe le chiavi che B4 ci ha messo (le risposte di
  // riscaldamento) — un marcatore in piu' non vale la perdita di quello che c'era. Il
  // congedo resta comunque congedo: la fase e la cronologia lo dicono lo stesso.
  if (erroreLettura) {
    await supabase.from('event_log').insert({
      type: 'lancio_congedo_non_marcato',
      payload: { conversationId, errore: erroreLettura.message, fase: 'lettura' } as never,
      message: `[lancio] conv ${conversationId}: lancio_info non letto, marcatore del congedo NON scritto — ${erroreLettura.message}`,
      level: 'warn',
    });
    return;
  }
  const attuale = (data as { lancio_info?: Json | null } | null)?.lancio_info;
  const base =
    attuale && typeof attuale === 'object' && !Array.isArray(attuale)
      ? (attuale as Record<string, unknown>)
      : {};
  const { error } = await supabase
    .from('conversations')
    .update({ lancio_info: { ...base, congedo_at: quandoIso } as Json })
    .eq('id', conversationId);
  if (error) {
    await supabase.from('event_log').insert({
      type: 'lancio_congedo_non_marcato',
      payload: { conversationId, errore: error.message, fase: 'scrittura' } as never,
      message: `[lancio] conv ${conversationId}: marcatore del congedo NON scritto — ${error.message}`,
      level: 'warn',
    });
  }
}

/**
 * Il marcatore durevole dell'ultima nota mandata al CRM per un lead gia' restituito al
 * pool (ruling C8): e' quello che tiene la finestra di un'ora di `serveNotaRestituzione`.
 *
 * Stessa disciplina di `marcaCongedo`, e per la stessa ragione: `lancio_info` porta anche
 * le chiavi di B4 e il congedo, quindi si rilegge prima di scrivere e su una lettura
 * fallita non si scrive niente. Il costo di non scrivere e' una nota in piu' alla
 * prossima, quello di sovrascrivere sarebbe perdere il congedo.
 *
 * Non lancia: il webhook deve rispondere a Twilio comunque.
 */
export async function marcaNotaRestituzione(
  supabase: Supa,
  conversationId: number,
  quandoIso: string = new Date().toISOString(),
): Promise<void> {
  const { data, error: erroreLettura } = await supabase
    .from('conversations')
    .select('lancio_info')
    .eq('id', conversationId)
    .maybeSingle();
  if (erroreLettura) {
    await supabase.from('event_log').insert({
      type: 'lancio_nota_restituzione_non_marcata',
      payload: { conversationId, errore: erroreLettura.message, fase: 'lettura' } as never,
      message: `[lancio] conv ${conversationId}: lancio_info non letto, marcatore della nota NON scritto — ${erroreLettura.message}`,
      level: 'warn',
    });
    return;
  }
  const attuale = (data as { lancio_info?: Json | null } | null)?.lancio_info;
  const base =
    attuale && typeof attuale === 'object' && !Array.isArray(attuale)
      ? (attuale as Record<string, unknown>)
      : {};
  const { error } = await supabase
    .from('conversations')
    .update({ lancio_info: { ...base, restituito_nota_at: quandoIso } as Json })
    .eq('id', conversationId);
  if (error) {
    await supabase.from('event_log').insert({
      type: 'lancio_nota_restituzione_non_marcata',
      payload: { conversationId, errore: error.message, fase: 'scrittura' } as never,
      message: `[lancio] conv ${conversationId}: marcatore della nota NON scritto — ${error.message}`,
      level: 'warn',
    });
  }
}

/**
 * Quando questa chat e' entrata nel lancio, letto dall'evento `lancio_intake`. E' il
 * taglio della cronologia sulle chat riusate, dove `ai_started_at` resta quello del giro
 * di Mario (scelta dell'intake: la storia non si azzera). Si interroga solo quando il
 * benvenuto del lancio non e' in cronologia — cioe' proprio nel caso del riuso.
 */
export async function leggiIngressoLancioAt(
  supabase: Supa,
  conversationId: number,
): Promise<string | null> {
  const { data } = await supabase
    .from('event_log')
    .select('created_at')
    .eq('type', 'lancio_intake')
    .eq('payload->>conversationId', String(conversationId))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}

/**
 * Lo stesso ingresso, per un lotto di conversazioni: una query sola invece di N.
 *
 * Serve al cron `lancio-aperture`, che da qui sa da quando contare i benvenuti gia'
 * partiti. Su una chat normale l'ingresso precede il benvenuto e non cambia niente; su
 * una chat che ha RIPARTITO (era `chiuso`/`restituito` e la persona si e' riscritta al
 * lancio) l'ingresso e' nuovo, e i benvenuti della vita precedente smettono di contare —
 * altrimenti il cron la salterebbe per sempre e la ripartenza resterebbe muta.
 *
 * Si tiene il piu' RECENTE per conversazione: e' l'ingresso del giro corrente. Una
 * conversazione senza evento — chi e' entrato dal pulsante della live, o le righe piu'
 * vecchie — semplicemente non compare nella mappa, e chi legge conta su tutta la
 * cronologia come si e' sempre fatto.
 */
export async function leggiIngressiLancioAt(
  supabase: Supa,
  conversationIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (conversationIds.length === 0) return out;
  const { data } = await supabase
    .from('event_log')
    .select('created_at, payload')
    .eq('type', 'lancio_intake')
    .in('payload->>conversationId', conversationIds.map(String))
    .order('created_at', { ascending: false });
  for (const riga of (data ?? []) as unknown as { created_at: string; payload: { conversationId?: number | string } | null }[]) {
    const id = Number(riga.payload?.conversationId);
    // Ordine discendente: la prima riga per conversazione e' gia' la piu' recente.
    if (Number.isFinite(id) && !out.has(id)) out.set(id, riga.created_at);
  }
  return out;
}

/**
 * Quanti benvenuti del lancio sono partiti nell'ultima ora, su TUTTE le conversazioni
 * (spec §11.3). E' il numeratore del tetto orario: il rischio e' del numero WhatsApp, non
 * della singola chat, quindi si conta per template e non per conversazione.
 *
 * Una sola query di conteggio (`head: true`): non serve nessuna riga, serve il numero.
 *
 * Righe contate: outbound con il SID del benvenuto e stato Twilio diverso da
 * failed/undelivered — la stessa definizione di "partito" di `riassumiOutboundLancio`.
 * `queued`/`sent`/`accepted` contano: sono messaggi gia' consegnati a Meta, ed e' Meta a
 * misurare la qualita'.
 *
 * Se la query fallisce si torna `null`, NON zero: chi chiama deve trattarlo come "tetto
 * raggiunto" e differire. Il tetto esiste per non ripetere il 15/09, e un conteggio che
 * non si legge non e' una licenza di mandare — il benvenuto differito lo riprende il cron
 * ogni 15 minuti, quindi il prezzo di sbagliare in questa direzione e' un ritardo, quello
 * di sbagliare nell'altra e' un numero bruciato. Resta la traccia
 * (`lancio_tetto_non_letto`): un tetto che non si legge piu' e' da vedere subito.
 */
export async function contaBenvenutiUltimaOra(
  supabase: Supa,
  welcomeSid: string,
  nowMs: number = Date.now(),
): Promise<number | null> {
  const soglia = new Date(nowMs - FINESTRA_TETTO_MS).toISOString();
  const { count, error } = await supabase
    .from('messages')
    .select('id', { head: true, count: 'exact' })
    .eq('direction', 'out')
    .eq('template_sid', welcomeSid)
    .gte('created_at', soglia)
    .not('twilio_status', 'in', '(failed,undelivered)');
  if (error) {
    await supabase.from('event_log').insert({
      type: 'lancio_tetto_non_letto',
      payload: { welcomeSid, errore: error.message } as never,
      message: `[lancio] tetto orario non leggibile, benvenuti differiti — ${error.message}`,
      level: 'warn',
    });
    return null;
  }
  return count ?? 0;
}
