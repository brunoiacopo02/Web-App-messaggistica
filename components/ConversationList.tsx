'use client';
import { useCallback, useEffect, useState, useTransition } from 'react';
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
  mondo?: string;
};

export function ConversationList({ initial, apiPath = '/api/conversations', basePath = '/inbox', channelName = 'inbox-list' }: {
  initial: Conv[];
  apiPath?: string;
  basePath?: string;
  channelName?: string;
}) {
  const params = useParams<{ conversationId?: string }>();
  const [items, setItems] = useState<Conv[]>(initial);
  const [filter, setFilter] = useState<'all' | 'unread' | 'recent'>('all');
  const [q, setQ] = useState('');
  const [, startTransition] = useTransition();

  // merge=true (refresh in background): nella vista "Non lette" mantiene visibili le
  // chat appena aperte/lette (badge azzerato), così la lista non collassa sotto di te.
  // merge=false (cambio filtro/ricerca): lista fresca.
  const refresh = useCallback(async (merge = false) => {
    const url = new URL(apiPath, window.location.origin);
    url.searchParams.set('filter', filter);
    if (q) url.searchParams.set('q', q);
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json();
    const fetched: Conv[] = json.data ?? [];

    if (merge && filter === 'unread') {
      setItems((prev) => {
        const fetchedIds = new Set(fetched.map((c) => c.id));
        const stickyRead = prev
          .filter((c) => !fetchedIds.has(c.id))
          .map((c) => ({ ...c, unread_count: 0 }));
        return [...fetched, ...stickyRead].sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
      });
    } else {
      setItems(fetched);
    }
  }, [apiPath, filter, q]);

  // Cambio filtro/ricerca → lista fresca.
  useEffect(() => { startTransition(() => refresh(false)); }, [refresh]);

  // Rete di sicurezza: polling ogni 5s (merge → sticky in "Non lette").
  useEffect(() => {
    const t = setInterval(() => startTransition(() => refresh(true)), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  // Realtime (istantaneo): token impostato prima della subscribe.
  useEffect(() => {
    const sb = getSupabaseBrowser();
    let ch: ReturnType<typeof sb.channel> | null = null;
    let active = true;
    (async () => {
      const { data } = await sb.auth.getSession();
      sb.realtime.setAuth(data.session?.access_token ?? null);
      if (!active) return;
      ch = sb
        .channel(channelName)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => startTransition(() => refresh(true)))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => startTransition(() => refresh(true)))
        .subscribe();
    })();
    return () => { active = false; if (ch) sb.removeChannel(ch); };
  }, [channelName, refresh]);

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
            <Link key={c.id} href={`${basePath}/${c.id}`}
              className={cn('flex items-center gap-3 p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 border-b', active && 'bg-zinc-100 dark:bg-zinc-800')}>
              <PhoneAvatar firstName={c.lead?.first_name} lastName={c.lead?.last_name} phone={c.lead?.phone_e164 ?? ''} />
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="font-medium truncate">{name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    {/* Il badge compare solo dove l'API lo manda (pannello /chat): gli altri
                        pannelli non hanno `mondo` e restano identici a prima. */}
                    {c.mondo && (
                      <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                        {c.mondo === 'GDO' ? 'GDO' : c.mondo === 'MARIO' ? 'Mario' : 'Campagna'}
                      </span>
                    )}
                    <span className="text-xs text-zinc-500">{formatRelativeShort(c.last_message_at)}</span>
                  </span>
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
