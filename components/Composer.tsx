'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

type Campaign = { id: number; name: string; twilio_template_sid: string; template_variables: any[]; active: boolean };

export function Composer({ conversationId, windowOpen, campaigns }: {
  conversationId: number;
  windowOpen: boolean;
  campaigns: Campaign[];
}) {
  const [mode, setMode] = useState<'free' | 'template'>(windowOpen ? 'free' : 'template');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState<string>('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const selectedTemplate = campaigns.find((c) => String(c.id) === templateId);

  async function send() {
    setSending(true);
    try {
      const payload = mode === 'free'
        ? { conversation_id: conversationId, mode, body }
        : { conversation_id: conversationId, mode, template_id: parseInt(templateId, 10), vars };
      const res = await fetch('/api/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        toast.error('Invio fallito', { description: j.error ?? `HTTP ${res.status}` });
        return;
      }
      setBody(''); setVars({});
    } finally { setSending(false); }
  }

  if (!windowOpen) {
    return (
      <div className="border-t p-3 space-y-2">
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 text-yellow-900 dark:text-yellow-100 text-sm px-3 py-2 rounded-md">
          Sono passate più di 24 ore dall&apos;ultima risposta. Puoi inviare solo template approvati.
        </div>
        <div className="flex gap-2 flex-wrap">
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger className="w-64"><SelectValue placeholder="Scegli template" /></SelectTrigger>
            <SelectContent>
              {campaigns.filter((c) => c.active).map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedTemplate?.template_variables?.map((v: any) => (
            <input key={v.key}
              placeholder={v.source === 'lead_field' ? `{{${v.key}}} → ${v.value}` : `{{${v.key}}}`}
              className="flex-1 border rounded-md px-2 py-1 text-sm bg-transparent"
              value={vars[v.key] ?? (v.source === 'static' ? v.value : '')}
              onChange={(e) => setVars((prev) => ({ ...prev, [v.key]: e.target.value }))}
            />
          ))}
          <Button onClick={send} disabled={!templateId || sending}>Invia</Button>
        </div>
      </div>
    );
  }

  return (
    <Tabs value={mode} onValueChange={(m) => setMode(m as 'free' | 'template')} className="border-t">
      <div className="px-3 pt-2">
        <TabsList>
          <TabsTrigger value="free">Libero</TabsTrigger>
          <TabsTrigger value="template">Template</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="free" className="p-3">
        <div className="flex gap-2">
          <Textarea
            placeholder="Scrivi una risposta… (Cmd/Ctrl+Enter per inviare)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
            }}
            rows={2}
          />
          <Button onClick={send} disabled={!body.trim() || sending}>Invia</Button>
        </div>
        <div className="text-xs text-zinc-500 mt-1">{body.length}/4096</div>
      </TabsContent>
      <TabsContent value="template" className="p-3">
        <div className="flex gap-2 flex-wrap">
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger className="w-64"><SelectValue placeholder="Scegli template" /></SelectTrigger>
            <SelectContent>
              {campaigns.filter((c) => c.active).map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedTemplate?.template_variables?.map((v: any) => (
            <input key={v.key}
              placeholder={`{{${v.key}}}`}
              className="border rounded-md px-2 py-1 text-sm bg-transparent"
              value={vars[v.key] ?? (v.source === 'static' ? v.value : '')}
              onChange={(e) => setVars((prev) => ({ ...prev, [v.key]: e.target.value }))}
            />
          ))}
          <Button onClick={send} disabled={!templateId || sending}>Invia</Button>
        </div>
      </TabsContent>
    </Tabs>
  );
}
