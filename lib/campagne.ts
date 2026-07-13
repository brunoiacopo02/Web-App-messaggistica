import type { SupabaseClient } from '@supabase/supabase-js';

/** Id delle campagne di proprietà Fenice Academy (owner='fenice'). */
export async function getFeniceCampaignIds(client: SupabaseClient): Promise<number[]> {
  const { data } = await client.from('campaigns').select('id').eq('owner', 'fenice');
  return (data ?? []).map((c: { id: number }) => c.id);
}

/** True se la conversazione appartiene a una campagna Fenice. */
export async function isFeniceConversation(client: SupabaseClient, conversationId: number): Promise<boolean> {
  const { data } = await client
    .from('conversations')
    .select('campaign_id, campaign:campaigns(owner)')
    .eq('id', conversationId)
    .maybeSingle();
  return (data as { campaign?: { owner?: string } | null } | null)?.campaign?.owner === 'fenice';
}

/**
 * Esclude da una query PostgREST le conversazioni di campagne Fenice.
 * NB: NOT IN in SQL scarta anche i NULL, quindi serve l'OR esplicito con is.null.
 */
// Il tipo esatto del query builder supabase-js (PostgrestFilterBuilder con generics su
// Database/Schema/Row) non si presta a un generic semplice qui; usiamo `any` mirato
// coerente con lo stile del codebase.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function excludeFeniceCampaigns(query: any, feniceIds: number[]): any {
  if (feniceIds.length === 0) return query;
  return query.or(`campaign_id.is.null,campaign_id.not.in.(${feniceIds.join(',')})`);
}
