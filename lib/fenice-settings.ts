import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;
const KEY = 'fenice_ai_autoreply';

export async function getAutoReply(supabase: Supa): Promise<boolean> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return data?.value === true;
}

export async function setAutoReply(supabase: Supa, on: boolean): Promise<void> {
  await supabase.from('app_settings')
    .upsert({ key: KEY, value: on as never, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}
