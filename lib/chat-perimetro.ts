import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Perimetro del pannello /chat: il mondo Fenice.
 *
 * Una conversazione entra se è governata dal bot (`ai_owner='mario'`, che copre
 * sia i lead di Mario sia i lead GDO in modalità postino), se appartiene a una
 * campagna di proprietà Fenice, oppure se ha ricevuto il video di preparazione GDO
 * dallo script `invio-video-agenda-gdo.mjs` (`gdo_video_sent_at` valorizzato): quei
 * lead sono deliberatamente senza `ai_owner` e senza `campaign_id` — vedi la nota in
 * testa allo script — ma vanno comunque visti da chi supervisiona. Resta fuori tutta
 * Serenamente.
 */

export type Mondo = 'GDO' | 'MARIO' | 'CAMPAGNA';

/**
 * Restringe una query su `conversations` al perimetro.
 *
 * NB: con lista vuota `campaign_id.in.()` è SQL invalido: quella clausola entra
 * nell'`.or()` solo se ci sono campagne fenice. È il gemello speculare della trappola
 * di `excludeFeniceCampaigns` in lib/campagne.ts, dove il problema era il NOT IN che
 * scarta i NULL.
 */
// Il tipo del query builder supabase-js non si presta a un generic semplice:
// `any` mirato, coerente con lo stile di lib/campagne.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function soloMondoFenice(query: any, feniceIds: number[]): any {
  const clausole = ['ai_owner.eq.mario', 'gdo_video_sent_at.not.is.null'];
  if (feniceIds.length > 0) clausole.push(`campaign_id.in.(${feniceIds.join(',')})`);
  return query.or(clausole.join(','));
}

/** True se la conversazione è nel perimetro del pannello /chat. */
export async function isConversazioneChat(
  client: SupabaseClient,
  conversationId: number,
): Promise<boolean> {
  const { data } = await client
    .from('conversations')
    .select('ai_owner, campaign_id, gdo_video_sent_at, campaign:campaigns(owner)')
    .eq('id', conversationId)
    .maybeSingle();
  const row = data as {
    ai_owner?: string | null;
    gdo_video_sent_at?: string | null;
    campaign?: { owner?: string } | null;
  } | null;
  if (!row) return false;
  return row.ai_owner === 'mario' || row.campaign?.owner === 'fenice' || row.gdo_video_sent_at != null;
}

/**
 * A quale mondo appartiene la conversazione.
 * L'ordine conta: una chat GDO ha comunque `ai_owner='mario'` e può avere un
 * `campaign_id` fenice ereditato da una campagna precedente. `gdo_video_sent_at` senza
 * `gdo_agenda_at` è un lead GDO che ha ricevuto solo il video (script video-only),
 * senza mai passare dal bot: è comunque GDO, non una campagna.
 */
export function mondoDi(c: {
  gdo_agenda_at?: string | null;
  ai_owner?: string | null;
  gdo_video_sent_at?: string | null;
}): Mondo {
  if (c.gdo_agenda_at) return 'GDO';
  if (c.ai_owner === 'mario') return 'MARIO';
  if (c.gdo_video_sent_at) return 'GDO';
  return 'CAMPAGNA';
}

/**
 * Etichetta del mondo per l'interfaccia. Due rese volutamente diverse — 'compatta' per
 * il badge nella lista conversazioni, 'estesa' per l'intestazione della chat — ma
 * derivate da un solo posto invece di essere duplicate nei componenti.
 */
export function mondoLabel(mondo: Mondo, variante: 'compatta' | 'estesa' = 'compatta'): string {
  if (mondo === 'MARIO') return 'Mario';
  if (mondo === 'CAMPAGNA') return 'Campagna';
  return variante === 'estesa' ? 'GDO · postino' : 'GDO';
}
