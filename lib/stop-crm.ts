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
 * Da `lead-status` quei fatti li abbiamo già in casa: `presented`, `sold` e la
 * `discardReason` decisa da una persona.
 *
 * **La distinzione che regge tutto è fra scrivere per primi e rispondere.** Il primo giro
 * di questo codice trattava le due cose allo stesso modo, ed erano i dati a dire che era
 * sbagliato: sulle 185 chat vive con uno stop, **87 hanno un messaggio del lead negli
 * ultimi 14 giorni**, e 39 di quelle sono clienti o persone che alla call ci sono andate.
 * Zittire il bot lì non protegge nessuno: fa scrivere una persona e non le risponde.
 *
 * Quindi:
 * - **di nostra iniziativa** (sequenza, recupero delle mancate risposte, follow-up) non si
 *   scrive a nessuno che abbia uno di quegli stati, `irreperibile` compreso. Il dato che
 *   chiude la discussione è del CRM: sui lead scartati e ri-pushati al bot gli
 *   appuntamenti recuperati sono **zero su 50.380**, e lo scarto "irreperibile" arriva
 *   DOPO che la chat non ha convertito, non prima;
 * - **quando è il lead a scriverci**, la sua iniziativa vale più del nostro stato: il bot
 *   risponde. Tranne a chi è già cliente o si è già presentato — quelle non sono
 *   conversazioni da bot, e lì la risposta giusta non è il silenzio ma passare la chat a
 *   una persona (vedi `vuolePassaggioAUmano`).
 *
 * `confermeOutcome: 'scartato'` non ferma niente in nessuno dei due modi: dice solo che al
 * telefono non l'hanno preso, ed è tutto il senso del recupero delle mancate risposte.
 */
export type StatoCrm = {
  presented: boolean | null;
  sold: boolean | null;
  discard_reason: string | null;
};

export type MotivoStopCrm = 'gia_cliente' | 'gia_presentato' | 'scartato_da_persona';

/**
 * `iniziativa` = stiamo per scrivere noi per primi. `risposta` = il lead ci ha scritto e
 * stiamo per rispondergli.
 */
export type ModoScrittura = 'iniziativa' | 'risposta';

/** `null` = si può scrivere. Nessuno stato noto vale come "si può": il bot non deve
 *  tacere per un dato che non è mai arrivato. */
export function stopDalCrm(
  s: StatoCrm | null | undefined,
  modo: ModoScrittura = 'iniziativa',
): MotivoStopCrm | null {
  if (!s) return null;
  if (s.sold === true) return 'gia_cliente';
  if (s.presented === true) return 'gia_presentato';
  // Uno scarto deciso da una persona ferma chi scrive per primo. Se poi è il lead a farsi
  // vivo, quella decisione l'ha superata lui e rispondergli non è insistere.
  if (modo === 'risposta') return null;
  const scarto = (s.discard_reason ?? '').trim();
  if (scarto !== '') return 'scartato_da_persona';
  return null;
}

/** Vero quando lo stop dice "questa chat non è più roba da bot": va passata a una
 *  persona, non lasciata cadere nel vuoto. */
export function vuolePassaggioAUmano(motivo: MotivoStopCrm): boolean {
  return motivo === 'gia_cliente' || motivo === 'gia_presentato';
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
  modo: ModoScrittura = 'iniziativa',
): Promise<MotivoStopCrm | null> {
  if (!crmLeadId) return null;
  try {
    const { data } = await supabase
      .from('crm_lead_status')
      .select('presented, sold, discard_reason')
      .eq('lead_id', crmLeadId)
      .maybeSingle();
    return stopDalCrm(data as StatoCrm | null, modo);
  } catch {
    return null;
  }
}
