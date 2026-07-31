import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Perimetro del pannello /chat: il mondo Fenice.
 *
 * Una conversazione entra se è governata dal bot (`ai_owner='mario'`, che copre
 * sia i lead di Mario sia i lead GDO in modalità postino) oppure se appartiene a
 * una campagna di proprietà Fenice. Resta fuori tutta Serenamente.
 */

export type Mondo = 'GDO' | 'MARIO' | 'CAMPAGNA';

/**
 * Restringe una query su `conversations` al perimetro.
 *
 * NB: con lista vuota `campaign_id.in.()` è SQL invalido, da cui il ramo esplicito.
 * È il gemello speculare della trappola di `excludeFeniceCampaigns` in lib/campagne.ts,
 * dove il problema era il NOT IN che scarta i NULL.
 */
// Il tipo del query builder supabase-js non si presta a un generic semplice:
// `any` mirato, coerente con lo stile di lib/campagne.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function soloMondoFenice(query: any, feniceIds: number[]): any {
  if (feniceIds.length === 0) return query.eq('ai_owner', 'mario');
  return query.or(`ai_owner.eq.mario,campaign_id.in.(${feniceIds.join(',')})`);
}

/** True se la conversazione è nel perimetro del pannello /chat. */
export async function isConversazioneChat(
  client: SupabaseClient,
  conversationId: number,
): Promise<boolean> {
  const { data } = await client
    .from('conversations')
    .select('ai_owner, campaign_id, campaign:campaigns(owner)')
    .eq('id', conversationId)
    .maybeSingle();
  const row = data as { ai_owner?: string | null; campaign?: { owner?: string } | null } | null;
  if (!row) return false;
  return row.ai_owner === 'mario' || row.campaign?.owner === 'fenice';
}

/**
 * A quale mondo appartiene la conversazione.
 * L'ordine conta: una chat GDO ha comunque `ai_owner='mario'` e può avere un
 * `campaign_id` fenice ereditato da una campagna precedente.
 */
export function mondoDi(c: { gdo_agenda_at?: string | null; ai_owner?: string | null }): Mondo {
  if (c.gdo_agenda_at) return 'GDO';
  if (c.ai_owner === 'mario') return 'MARIO';
  return 'CAMPAGNA';
}
