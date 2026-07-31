'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble';
import { formatDateGroup } from '@/lib/utils';
import { getSupabaseBrowser } from '@/lib/supabase/client';

type Msg = {
  id: number; conversation_id: number; direction: 'in' | 'out'; body: string; created_at: string;
  twilio_status: string | null; twilio_error_code: number | null; is_template: boolean | null;
  sender?: string | null;
};

function groupByDay(msgs: Msg[]): { day: string; items: Msg[] }[] {
  const groups: Record<string, Msg[]> = {};
  msgs.forEach((m) => {
    const k = m.created_at.slice(0, 10);
    (groups[k] ??= []).push(m);
  });
  return Object.entries(groups).map(([, items]) => ({ day: items[0].created_at, items }));
}

function mergeSorted(list: Msg[]): Msg[] {
  const byId = new Map<number, Msg>();
  for (const m of list) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function MessageThread({ conversationId, initial, campaignNamesById, apiBase = '/api/conversations', showSender = false }: {
  conversationId: number;
  initial: Msg[];
  campaignNamesById: Record<number, string>;
  apiBase?: string;
  showSender?: boolean;
}) {
  const [items, setItems] = useState<Msg[]>(initial);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Reset quando si cambia conversazione.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setItems(initial); }, [conversationId]);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/${conversationId}/messages`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      if (Array.isArray(json.data)) setItems(mergeSorted(json.data as Msg[]));
    } catch {
      /* noop */
    }
  }, [apiBase, conversationId]);

  // Rete di sicurezza: polling ogni 4s (garantisce l'aggiornamento anche senza realtime).
  useEffect(() => {
    const t = setInterval(refetch, 4000);
    return () => clearInterval(t);
  }, [refetch]);

  // Ricarica immediata dopo un invio dal Composer.
  useEffect(() => {
    const h = () => refetch();
    window.addEventListener('thread-refetch', h);
    return () => window.removeEventListener('thread-refetch', h);
  }, [refetch]);

  // Realtime (istantaneo) — il token va impostato PRIMA della subscribe o l'RLS blocca gli eventi.
  useEffect(() => {
    const sb = getSupabaseBrowser();
    let ch: ReturnType<typeof sb.channel> | null = null;
    let active = true;
    (async () => {
      const { data } = await sb.auth.getSession();
      sb.realtime.setAuth(data.session?.access_token ?? null);
      if (!active) return;
      ch = sb
        .channel(`thread-${conversationId}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        }, (payload) => setItems((prev) => mergeSorted([...prev, payload.new as Msg])))
        .on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        }, (payload) => setItems((prev) => prev.map((m) => (m.id === (payload.new as Msg).id ? (payload.new as Msg) : m))))
        .subscribe();
    })();
    return () => { active = false; if (ch) sb.removeChannel(ch); };
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [items.length]);

  const groups = groupByDay(items);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      {groups.map((g, i) => (
        <div key={i} className="space-y-2">
          <div className="text-center"><span className="text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 rounded-full px-2 py-0.5">{formatDateGroup(g.day)}</span></div>
          {g.items.map((m) => (
            <MessageBubble key={m.id} msg={m} campaignName={campaignNamesById[m.id]} showSender={showSender} />
          ))}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
