// Il numero della chat negli script di invio massivo (06/11/2026).
//
// Copia in .mjs di `mittenteInvioChat` / `numeroChatDopoInvio` (lib/mittente.ts), perche'
// gli script girano con node puro e non importano il TypeScript dell'app. La regola e'
// la stessa dell'app:
//   - verso una chat che ha gia' un numero si scrive DA QUEL numero;
//   - chi forza un altro numero (FORZA_MITTENTE=1, o le agende GDO che partono sempre
//     dal 3199 per decisione del PO del 24/09) puo' farlo, ma dopo l'invio riuscito la
//     chat passa a quel numero: e' li' che il lead rispondera'. Prima gli script
//     mandavano da FROM_OVERRIDE e lasciavano `wa_number` dov'era, e il lead si trovava
//     due thread scollegati.

const soloNumero = (n) => String(n ?? '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '').replace(/^whatsapp:/i, '');
const inFormaWhatsapp = (n) => `whatsapp:${soloNumero(n)}`;

/**
 * Da quale numero parte l'invio verso una chat.
 * `predefinito` vale per le chat senza numero (nuove o nate prima di `wa_number`);
 * con `forza` vince sempre `predefinito` (eccezione agende GDO, o FORZA_MITTENTE=1).
 */
export function mittenteScript(waNumberChat, predefinito, { forza = false } = {}) {
  if (!forza && soloNumero(waNumberChat)) return inFormaWhatsapp(waNumberChat);
  if (!soloNumero(predefinito)) return null;
  return inFormaWhatsapp(predefinito);
}

/** Il numero da scrivere in `wa_number` dopo un invio riuscito, o null se e' gia' quello. */
export function numeroChatDopoInvio(waNumber, inviatoDa) {
  const nuovo = soloNumero(inviatoDa);
  if (!nuovo || soloNumero(waNumber) === nuovo) return null;
  return inFormaWhatsapp(nuovo);
}

/**
 * Dopo un invio RIUSCITO: porta la chat sul numero usato e lo registra in event_log
 * (`chat_segue_mittente`, lo stesso evento dell'app). `sb` e' l'helper PostgREST dello
 * script. Ritorna il numero scritto, o null.
 */
export async function allineaNumeroChatScript(sb, conversationId, waNumberPrima, inviatoDa, origine) {
  const nuovo = numeroChatDopoInvio(waNumberPrima, inviatoDa);
  if (!nuovo) return null;
  await sb(`conversations?id=eq.${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ wa_number: nuovo }),
    headers: { Prefer: 'return=minimal' },
  });
  await sb('event_log', {
    method: 'POST',
    body: JSON.stringify({
      type: 'chat_segue_mittente',
      payload: { conversationId, numeroChat: waNumberPrima ?? null, inviatoDa: nuovo, origine },
      message: `[invio] conv ${conversationId}: inviato da ${nuovo} (${origine}), la chat passa da ${waNumberPrima ?? 'nessun numero'} a ${nuovo}`,
      level: 'info',
    }),
    headers: { Prefer: 'return=minimal' },
  });
  return nuovo;
}
