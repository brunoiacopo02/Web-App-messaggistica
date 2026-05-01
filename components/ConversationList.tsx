'use client';
import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { cn, formatRelativeShort } from '@/lib/utils';
import { PhoneAvatar } from './PhoneAvatar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getSupabaseBrowser } from '@/lib/supabase/client';

type Conv = {
  id: number;
  last_message_at: string;
  unread_count: number;
  lead: { id: number; phone_e164: string; first_name: string | null; last_name: string | null } | null;
  preview?: string;
};

export function ConversationList({ initial }: { initial: Conv[] }) {
  const params = useParams<{ conversationId?: string }>();
  const [items, setItems] = useState<Conv[]>(initial);
  const [filter, setFilter] = useState<'all' | 'unread' | 'recent'>('all');
  const [q, setQ] = useState('');
  const [, startTransition] = useTransition();

  async function refresh() {
    const url = new URL('/api/conversations', window.location.origin);
    url.searchParams.set('filter', filter);
    if (q) url.searchParams.set('q', q);
    const res = await fetch(url);
    const json = await res.json();
    setItems(json.data ?? []);
  }

  useEffect(() => { startTransition(refresh); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter, q]);

  useEffect(() => {
    const sb = getSupabaseBrowser();
    const ch = sb.channel('inbox-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => startTransition(refresh))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => startTransition(refresh))
      .subscribe();
    return () => { sb.removeChannel(ch); };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [filter, q]);

  return (
    <div className="flex flex-col h-full border-r w-full md:w-96 shrink-0">
      <div className="p-3 space-y-2 border-b">
        <Input placeholder="Cerca per nome o numero…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex gap-1">
          {(['all', 'unread', 'recent'] as const).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Tutte' : f === 'unread' ? 'Non lette' : 'Ultimi 7gg'}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && <p className="p-4 text-sm text-zinc-500">Nessuna conversazione.</p>}
        {items.map((c) => {
          const active = String(c.id) === params.conversationId;
          const name = c.lead
            ? [c.lead.first_name, c.lead.last_name].filter(Boolean).join(' ') || c.lead.phone_e164
            : 'Sconosciuto';
          return (
            <Link key={c.id} href={`/inbox/${c.id}`}
              className={cn('flex items-center gap-3 p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 border-b', active && 'bg-zinc-100 dark:bg-zinc-800')}>
              <PhoneAvatar firstName={c.lead?.first_name} lastName={c.lead?.last_name} phone={c.lead?.phone_e164 ?? ''} />
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline">
                  <span className="font-medium truncate">{name}</span>
                  <span className="text-xs text-zinc-500 shrink-0 ml-2">{formatRelativeShort(c.last_message_at)}</span>
                </div>
                <div className="flex justify-between items-center mt-0.5">
                  <span className="text-sm text-zinc-500 truncate">{c.preview ?? c.lead?.phone_e164}</span>
                  {c.unread_count > 0 && (
                    <Badge className="bg-emerald-500 hover:bg-emerald-500 h-5 px-1.5 text-xs">{c.unread_count}</Badge>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
