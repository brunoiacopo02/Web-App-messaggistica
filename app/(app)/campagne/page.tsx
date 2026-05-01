import { getSupabaseServer } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { CampaignDrawer } from './_components/CampaignDrawer';
import { Plus, Pencil } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function CampagnePage() {
  const supabase = await getSupabaseServer();
  const { data } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false });
  const campaigns = (data ?? []) as any[];

  return (
    <div className="p-6 space-y-4 overflow-auto h-full">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-semibold">Campagne</h1>
        <CampaignDrawer trigger={<Button><Plus className="size-4 mr-1" /> Nuova campagna</Button>} />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nome</TableHead>
            <TableHead>Lista AC</TableHead>
            <TableHead>Template SID</TableHead>
            <TableHead>Variabili</TableHead>
            <TableHead>Attiva</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {campaigns.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-center text-zinc-500">Nessuna campagna ancora.</TableCell></TableRow>
          )}
          {campaigns.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell>{c.ac_list_match}</TableCell>
              <TableCell className="font-mono text-xs">{c.twilio_template_sid}</TableCell>
              <TableCell>{c.template_variables?.length ?? 0}</TableCell>
              <TableCell>{c.active ? <Badge>Attiva</Badge> : <Badge variant="outline">Disattivata</Badge>}</TableCell>
              <TableCell>
                <CampaignDrawer
                  initial={c}
                  trigger={<Button variant="ghost" size="icon"><Pencil className="size-4" /></Button>}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
