import { getSupabaseServer } from '@/lib/supabase/server';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function LogPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; status?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const tab = sp.tab ?? 'invii';
  const supabase = await getSupabaseServer();

  let messages: any[] = [];
  let events: any[] = [];

  if (tab === 'invii') {
    let q = supabase.from('messages').select(`
      id, body, twilio_status, twilio_error_code, created_at, conversation_id,
      conversation:conversations!inner( lead:leads(first_name, last_name, phone_e164), campaign:campaigns(name) )
    `).eq('direction', 'out').order('created_at', { ascending: false }).limit(50);
    if (sp.status) q = q.eq('twilio_status', sp.status);
    const { data } = await q;
    messages = data ?? [];
  } else {
    const { data } = await supabase.from('event_log').select('*').order('created_at', { ascending: false }).limit(200);
    events = data ?? [];
  }

  return (
    <div className="p-6 space-y-4 overflow-auto h-full">
      <h1 className="text-xl font-semibold">Log</h1>
      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="invii" asChild><Link href="/log?tab=invii">Invii</Link></TabsTrigger>
          <TabsTrigger value="eventi" asChild><Link href="/log?tab=eventi">Eventi sistema</Link></TabsTrigger>
        </TabsList>

        <TabsContent value="invii">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Lead</TableHead><TableHead>Campagna</TableHead>
              <TableHead>Stato</TableHead><TableHead>Errore</TableHead>
              <TableHead>Inviato il</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {messages.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link className="hover:underline" href={`/inbox/${m.conversation_id}`}>
                      {[m.conversation?.lead?.first_name, m.conversation?.lead?.last_name].filter(Boolean).join(' ') || m.conversation?.lead?.phone_e164}
                    </Link>
                    <div className="text-xs text-zinc-500">{m.conversation?.lead?.phone_e164}</div>
                  </TableCell>
                  <TableCell>{m.conversation?.campaign?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={m.twilio_status === 'failed' || m.twilio_status === 'undelivered' ? 'destructive' : 'outline'}>
                      {m.twilio_status ?? 'queued'}
                    </Badge>
                  </TableCell>
                  <TableCell>{m.twilio_error_code ?? '—'}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(m.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        <TabsContent value="eventi">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Tipo</TableHead><TableHead>Livello</TableHead>
              <TableHead>Messaggio</TableHead><TableHead>Data</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{e.type}</TableCell>
                  <TableCell><Badge variant={e.level === 'error' ? 'destructive' : e.level === 'warn' ? 'secondary' : 'outline'}>{e.level}</Badge></TableCell>
                  <TableCell className="text-sm">{e.message}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(e.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
    </div>
  );
}
