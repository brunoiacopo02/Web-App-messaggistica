'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble';
import { formatDateGroup } from '@/lib/utils';
import { getSupabaseBrowser } from '@/lib/supabase/client';

type Msg = {
  id: number; conversation_id: number; direction: 'in' | 'out'; body: string; created_at: string;
  twilio_status: string | null; twilio_error_code: number | null; is_template: boolean | null;
};

function groupByDay(msgs: Msg[]): { day: string; items: Msg[] }[] {
  const groups: Record<string, Msg[]> = {};
  msgs.forEach((m) => {
    const k = m.created_at.slice(0, 10);
    (groups[k] ??= []).push(m);
  });
  return Object.entries(groups).map(([, items]) => ({ day: items[0].created_at, items }));
}

export function MessageThread({ conversationId, initial, campaignNamesById }: {
  conversationId: number;
  initial: Msg[];
  campaignNamesById: Record<number, string>;
}) {
  const [items, setItems] = useState<Msg[]>(initial);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [items.length]);

  useEffect(() => {
    const sb = getSupabaseBrowser();
    const ch = sb.channel(`thread-${conversationId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => setItems((prev) => [...prev, payload.new as Msg]))
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => setItems((prev) => prev.map((m) => m.id === (payload.new as Msg).id ? (payload.new as Msg) : m)))
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [conversationId]);

  const groups = groupByDay(items);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      {groups.map((g, i) => (
        <div key={i} className="space-y-2">
          <div className="text-center"><span className="text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 rounded-full px-2 py-0.5">{formatDateGroup(g.day)}</span></div>
          {g.items.map((m) => (
            <MessageBubble key={m.id} msg={m} campaignName={campaignNamesById[m.id]} />
          ))}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
