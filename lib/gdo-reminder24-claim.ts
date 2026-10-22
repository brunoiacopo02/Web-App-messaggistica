/**
 * La presa del promemoria del giorno prima di un lead GDO (app/api/cron/precall-reminders):
 * si prende PRIMA di mandare, con un update condizionale su
 * `conversations.gdo_reminder24_for_at`, come `claimRecap` in lib/gdo-recap-send.ts. Due
 * giri del cron (o un giro che ha perso la riga di event_log) non mandano lo stesso
 * promemoria due volte per la stessa call; uno spostamento della call lo riapre.
 */

type Supa = {
  from: (t: string) => any;
};

/** Esito della presa: il valore di prima serve a rilasciarla se l'invio non parte. */
export type PresaPromemoriaGdo = { at: string; prima: string | null };

/**
 * Segna il promemoria per la call di `appuntamentoAt` solo se per quella stessa call non
 * è già preso. Torna la presa (con il valore precedente della colonna) o `null` se un
 * altro giro l'ha già presa, o se l'update è fallito: nel dubbio non si manda.
 */
export async function claimPromemoriaGdo(
  supabase: Supa,
  conversationId: number,
  appuntamentoAt: string,
  prima: string | null,
): Promise<PresaPromemoriaGdo | null> {
  // Stessa scrittura ISO UTC del filtro: la colonna torna in fusi diversi dall'URL.
  const at = new Date(appuntamentoAt).toISOString();
  const { data, error } = await supabase
    .from('conversations')
    .update({ gdo_reminder24_for_at: at })
    .eq('id', conversationId)
    .or(`gdo_reminder24_for_at.is.null,gdo_reminder24_for_at.neq.${at}`)
    .select('id');
  if (error) {
    console.error(`[precall] claim del promemoria GDO fallito su conv ${conversationId}: ${error.message}`);
    return null;
  }
  if (!data || data.length === 0) return null;
  return { at, prima };
}

/**
 * Ripristina la colonna quando l'invio non è partito: il prossimo giro riprova. Solo se
 * porta ancora la nostra presa (uno spostamento arrivato nel frattempo non si tocca).
 * Torna il messaggio d'errore se il rilascio stesso fallisce.
 */
export async function rilasciaPromemoriaGdo(
  supabase: Supa,
  conversationId: number,
  presa: PresaPromemoriaGdo,
): Promise<string | null> {
  const { error } = await supabase
    .from('conversations')
    .update({ gdo_reminder24_for_at: presa.prima })
    .eq('id', conversationId)
    .eq('gdo_reminder24_for_at', presa.at);
  return error ? `rilascio del promemoria GDO fallito: ${error.message}` : null;
}
