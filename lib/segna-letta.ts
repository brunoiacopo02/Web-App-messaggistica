/**
 * Quale conversazione la lista deve segnare come letta, adesso.
 *
 * Una chat si legge perché è aperta: se la conversazione attiva ha ancora un
 * `unread_count` positivo (appena aperta, oppure il lead ha scritto mentre era sotto
 * gli occhi dell'operatore) va segnata letta. `inviate` ricorda, per conversazione,
 * il contatore per cui la richiesta è già partita: lo stesso valore non si rimanda,
 * così un endpoint che risponde senza azzerare (in /chat le chat di campagna restano
 * di chi lavora /campagne-chat) non genera una richiesta a ogni polling di 5 secondi.
 * Un contatore diverso (nuovo messaggio arrivato) invece si rimanda.
 */
export function convDaSegnareLetta(
  activeId: string | undefined,
  items: ReadonlyArray<{ id: number; unread_count: number | null }>,
  inviate: ReadonlyMap<number, number>,
): { id: number; count: number } | null {
  if (!activeId) return null;
  const conv = items.find((c) => String(c.id) === activeId);
  const count = conv?.unread_count ?? 0;
  if (!conv || count <= 0) return null;
  if (inviate.get(conv.id) === count) return null;
  return { id: conv.id, count };
}
