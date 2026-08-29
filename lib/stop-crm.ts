import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Quando il bot deve smettere di scrivere perché lo dice il CRM, non la chat.
 *
 * Il 29/08/2026 abbiamo evitato per un soffio di mandare "rifissiamo la call?" a sei
 * persone che erano clienti da tre settimane: gli otto appuntamenti che credevamo persi
 * erano stati fatti tutti, sotto il `leadId` del gemello. Ci siamo fermati perché il CRM
 * ha incrociato i dati a mano — non perché il bot lo sapesse.
 *
 * Da `lead-status` quei fatti li abbiamo già in casa, e sono due:
 *
 * - **`presented` / `sold`**: quella persona alla call c'è andata, e se ha comprato è un
 *   cliente. Non esiste nessun messaggio del bot che abbia senso mandarle.
 * - **`discardReason`**: uno scarto deciso da una persona per un motivo che dalla chat
 *   non si vede — non in target, numero sbagliato, non interessato. Un lead che in chat
 *   scrive "va bene, chiamatemi" può essere lo stesso che al telefono ha detto a un GDO
 *   di non chiamarlo più.
 *
 * `confermeOutcome: 'scartato'` **non** ferma niente, ed è la distinzione che conta:
 * quello dice solo che al telefono non l'hanno preso, ed è esattamente il caso in cui
 * vogliamo scrivere. È tutto il senso del recupero delle mancate risposte.
 */
export type StatoCrm = {
  presented: boolean | null;
  sold: boolean | null;
  discard_reason: string | null;
};

export type MotivoStopCrm = 'gia_cliente' | 'gia_presentato' | 'scartato_da_persona';

/** `null` = si può scrivere. Nessuno stato noto vale come "si può": il bot non deve
 *  tacere per un dato che non è mai arrivato. */
export function stopDalCrm(s: StatoCrm | null | undefined): MotivoStopCrm | null {
  if (!s) return null;
  if (s.sold === true) return 'gia_cliente';
  if (s.presented === true) return 'gia_presentato';
  const scarto = (s.discard_reason ?? '').trim();
  if (scarto !== '') return 'scartato_da_persona';
  return null;
}

/**
 * Lo stesso, leggendo la copia locale di `lead-status`. Non lancia: un errore di rete o
 * una tabella vuota non devono zittire il bot su una chat viva — il rischio simmetrico
 * (un messaggio a un cliente) è coperto solo quando il dato c'è davvero, ed è per questo
 * che il cron che riempie quella tabella non è opzionale.
 */
export async function stopDalCrmPerLead(
  supabase: Supa,
  crmLeadId: string | null,
): Promise<MotivoStopCrm | null> {
  if (!crmLeadId) return null;
  try {
    const { data } = await supabase
      .from('crm_lead_status')
      .select('presented, sold, discard_reason')
      .eq('lead_id', crmLeadId)
      .maybeSingle();
    return stopDalCrm(data as StatoCrm | null);
  } catch {
    return null;
  }
}
