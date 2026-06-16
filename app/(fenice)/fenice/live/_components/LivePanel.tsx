'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

type Row = { id: number; status: string | null; phone: string; name: string; lastMessageAt: string };

export function LivePanel({ initialAutoReply, initialRows }: { initialAutoReply: boolean; initialRows: Row[] }) {
  const router = useRouter();
  const [autoReply, setAutoReply] = useState(initialAutoReply);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function toggle(on: boolean) {
    setAutoReply(on);
    await fetch('/api/fenice/autoreply', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }),
    });
  }

  async function enroll() {
    if (!phone.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/fenice/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), firstName: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Errore');
      setMsg(`Template inviato a ${phone}. Mario gestirà le risposte.`);
      setPhone(''); setName('');
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Errore');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Switch checked={autoReply} onCheckedChange={toggle} />
        <div>
          <div className="font-medium">Auto-risposta WhatsApp {autoReply ? 'ATTIVA' : 'spenta'}</div>
          <div className="text-sm text-zinc-500">Mario risponde solo ai lead arruolati qui sotto.</div>
        </div>
      </div>

      <div className="rounded-lg border p-4 space-y-3">
        <div className="font-medium">Avvia un lead</div>
        <div className="flex gap-2">
          <Input placeholder="+39…" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input placeholder="Nome (opzionale)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button onClick={enroll} disabled={busy || !phone.trim()}>Invia apertura</Button>
        </div>
        {msg && <div className="text-sm text-zinc-600 dark:text-zinc-300">{msg}</div>}
      </div>

      <div className="rounded-lg border">
        <div className="px-4 py-2 font-medium border-b">Lead gestiti da Mario</div>
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr><th className="px-4 py-2">Telefono</th><th className="px-4 py-2">Nome</th><th className="px-4 py-2">Stato</th></tr>
          </thead>
          <tbody>
            {initialRows.length === 0 && (
              <tr><td className="px-4 py-3 text-zinc-400" colSpan={3}>Nessun lead arruolato.</td></tr>
            )}
            {initialRows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-2">{r.phone}</td>
                <td className="px-4 py-2">{r.name}</td>
                <td className="px-4 py-2">
                  {r.status === 'booked' && <Badge className="bg-emerald-600">appuntamento</Badge>}
                  {r.status === 'handed_off' && <Badge variant="destructive">a operatore</Badge>}
                  {(!r.status || r.status === 'active') && <Badge variant="secondary">attivo</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
