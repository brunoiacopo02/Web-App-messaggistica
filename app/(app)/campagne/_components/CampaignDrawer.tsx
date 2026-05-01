'use client';
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TemplateVariablesEditor } from '@/components/TemplateVariablesEditor';
import { useRouter } from 'next/navigation';

type Campaign = {
  id?: number; name: string; ac_list_match: string;
  twilio_template_sid: string; template_variables: { key: string; source: 'lead_field' | 'static'; value: string }[]; active: boolean;
};

export function CampaignDrawer({ trigger, initial }: {
  trigger: React.ReactNode;
  initial?: Campaign;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [c, setC] = useState<Campaign>(initial ?? {
    name: '', ac_list_match: '', twilio_template_sid: '', template_variables: [], active: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    const url = c.id ? `/api/campaigns/${c.id}` : '/api/campaigns';
    const res = await fetch(url, {
      method: c.id ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: c.name, ac_list_match: c.ac_list_match,
        twilio_template_sid: c.twilio_template_sid,
        template_variables: c.template_variables, active: c.active,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({} as any));
      setErr(j.details ? JSON.stringify(j.details) : (j.error ?? 'Errore'));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader><SheetTitle>{c.id ? 'Modifica campagna' : 'Nuova campagna'}</SheetTitle></SheetHeader>
        <div className="space-y-4 mt-6 px-1">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="Es. Webinar Marzo" />
          </div>
          <div className="space-y-2">
            <Label>Lista AC trigger</Label>
            <Input value={c.ac_list_match} onChange={(e) => setC({ ...c, ac_list_match: e.target.value })} placeholder="Nome esatto della lista o ID" />
            <p className="text-xs text-zinc-500">Inserisci il nome esatto della lista o l&apos;ID che AC passa nel webhook.</p>
          </div>
          <div className="space-y-2">
            <Label>Template Content SID</Label>
            <Input value={c.twilio_template_sid} onChange={(e) => setC({ ...c, twilio_template_sid: e.target.value })} placeholder="HX..." />
          </div>
          <div className="space-y-2">
            <Label>Variabili template</Label>
            <TemplateVariablesEditor
              value={c.template_variables ?? []}
              onChange={(vars) => setC({ ...c, template_variables: vars })} />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={c.active} onCheckedChange={(v) => setC({ ...c, active: v })} />
            <Label>Attiva</Label>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <SheetFooter className="mt-6">
          <Button onClick={save} disabled={busy}>{c.id ? 'Salva' : 'Crea'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
