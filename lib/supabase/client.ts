import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './types';

// Singleton: un solo client browser condiviso, così il token di sessione
// (necessario al Realtime per superare le policy RLS) è impostato una volta sola.
let _client: ReturnType<typeof createBrowserClient<Database>> | null = null;

export function getSupabaseBrowser() {
  if (_client) return _client;
  _client = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return _client;
}
