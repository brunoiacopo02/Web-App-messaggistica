'use client';

import { useEffect, useRef } from 'react';
import { getSupabaseBrowser } from '@/lib/supabase/client';

/** Avvisa quando entra un messaggio da un lead. Stesso schema di `components/RealtimeProvider.tsx`
 *  (token impostato prima della subscribe, altrimenti l'RLS blocca gli eventi), ma su un canale
 *  suo, `console-inbound`: quello globale non si tocca. La callback si legge da un ref, così
 *  cambiarla non chiude e riapre il canale. */
export function useArrivi(onNuovoInbound: (conversationId: number) => void) {
  const ref = useRef(onNuovoInbound);
  useEffect(() => {
    ref.current = onNuovoInbound;
  });

  useEffect(() => {
    const sb = getSupabaseBrowser();
    let ch: ReturnType<typeof sb.channel> | null = null;
    let attivo = true;
    (async () => {
      const { data } = await sb.auth.getSession();
      sb.realtime.setAuth(data.session?.access_token ?? null);
      if (!attivo) return;
      ch = sb
        .channel('console-inbound')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: 'direction=eq.in' },
          (payload) => {
            const id = Number((payload.new as { conversation_id?: unknown }).conversation_id);
            if (Number.isInteger(id)) ref.current(id);
          },
        )
        .subscribe();
    })();
    return () => {
      attivo = false;
      if (ch) void sb.removeChannel(ch);
    };
  }, []);
}
