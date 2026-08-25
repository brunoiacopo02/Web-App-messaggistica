// Un alert che si ripete a ogni giro di cron non è un alert: è rumore.
//
// 25/08/2026 — `stale_booked_no_outcome` girava senza guardia su un cron orario: 105
// righe in event_log per 2 conversazioni (100 per la sola conv 3401). Il watchdog
// gemello `stale_handed_off` la guardia ce l'aveva già; questa funzione la rende una
// sola, così il prossimo watchdog nasce corretto.

type Supa = {
  from: (t: string) => any;
};

export type AlertUnaVoltaArgs = {
  type: string;
  conversationId: number;
  message: string;
  level: 'info' | 'warn' | 'error';
  /** Campi aggiuntivi del payload. `conversationId` resta la chiave del dedup. */
  payload?: Record<string, unknown>;
};

/**
 * Scrive l'alert solo se per quella coppia (type, conversationId) non ce n'è già uno.
 * Torna `true` se l'ha scritto davvero.
 */
export async function alertUnaVolta(supabase: Supa, args: AlertUnaVoltaArgs): Promise<boolean> {
  const { data: prior } = await supabase
    .from('event_log')
    .select('id')
    .eq('type', args.type)
    .contains('payload', { conversationId: args.conversationId })
    .limit(1);
  if (prior && prior.length > 0) return false;

  await supabase.from('event_log').insert({
    type: args.type,
    payload: { conversationId: args.conversationId, ...(args.payload ?? {}) } as never,
    message: args.message,
    level: args.level,
  });
  return true;
}
