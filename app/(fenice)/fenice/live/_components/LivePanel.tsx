'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Send, UserPlus, Power, CheckCircle2, Inbox, MessagesSquare, Radio, CalendarCheck, UserCog } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatStatusPill } from '@/components/fenice/status';
import { StatCard } from '@/components/fenice/StatCard';

type Row = { id: number; status: string | null; phone: string; name: string; lastMessageAt: string };

export function LivePanel({ initialAutoReply, initialRows }: { initialAutoReply: boolean; initialRows: Row[] }) {
  const router = useRouter();
  const [autoReply, setAutoReply] = useState(initialAutoReply);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
      setMsg({ ok: true, text: `Apertura inviata a ${phone}. Da qui in poi risponde Mario.` });
      setPhone(''); setName('');
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Errore' });
    } finally {
      setBusy(false);
    }
  }

  const booked = initialRows.filter((r) => r.status === 'booked').length;
  const handoff = initialRows.filter((r) => r.status === 'handed_off').length;
  const active = initialRows.length - booked - handoff;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      {/* Live snapshot — derived from the leads Mario currently manages */}
      <div className="fenice-rise grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Gestiti da Mario" value={initialRows.length} icon={MessagesSquare} tone="ember" />
        <StatCard label="Attivi ora" value={active} icon={Radio} tone="sky" />
        <StatCard label="Appuntamenti" value={booked} icon={CalendarCheck} tone="emerald" />
        <StatCard label="A operatore" value={handoff} icon={UserCog} tone="rose" />
      </div>

      {/* Auto-reply master switch */}
      <div
        className={cn(
          'fenice-rise flex items-center gap-4 rounded-2xl border p-5 transition-colors',
          autoReply ? 'border-brand/30 bg-brand/[0.07]' : 'border-border/70 bg-card',
        )}
      >
        <span
          className={cn(
            'grid size-11 shrink-0 place-items-center rounded-xl transition-colors',
            autoReply ? 'bg-brand text-brand-foreground shadow-sm shadow-brand/30' : 'bg-muted text-muted-foreground',
          )}
        >
          <Power className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-semibold">
            Auto-risposta WhatsApp
            <span className={cn('text-xs font-bold uppercase tracking-wide', autoReply ? 'text-brand' : 'text-muted-foreground')}>
              {autoReply ? '· attiva' : '· spenta'}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Mario risponde automaticamente <strong>solo</strong> ai lead avviati qui sotto.
          </p>
        </div>
        <Switch checked={autoReply} onCheckedChange={toggle} />
      </div>

      {/* Enroll a new lead */}
      <div className="fenice-rise rounded-2xl border border-border/70 bg-card p-5" style={{ animationDelay: '60ms' }}>
        <div className="mb-3 flex items-center gap-2">
          <UserPlus className="size-4 text-brand" />
          <h2 className="font-semibold">Avvia un nuovo lead</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Invia il messaggio di apertura su WhatsApp. Mario prende in carico la conversazione da quel momento.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input placeholder="+39…" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-10 rounded-xl sm:max-w-[180px]" />
          <Input placeholder="Nome (opzionale)" value={name} onChange={(e) => setName(e.target.value)} className="h-10 rounded-xl" />
          <Button onClick={enroll} disabled={busy || !phone.trim()} className="h-10 shrink-0 rounded-xl">
            <Send className="mr-1.5 size-4" /> Invia apertura
          </Button>
        </div>
        {msg && (
          <div
            className={cn(
              'mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm',
              msg.ok
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300',
            )}
          >
            {msg.ok && <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <span>{msg.text}</span>
          </div>
        )}
      </div>

      {/* Managed leads */}
      <div className="fenice-rise overflow-hidden rounded-2xl border border-border/70 bg-card" style={{ animationDelay: '120ms' }}>
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-3">
          <h2 className="font-semibold">Lead gestiti da Mario</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {initialRows.length}
          </span>
        </div>

        {initialRows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-12 text-center text-muted-foreground">
            <Inbox className="size-7 opacity-60" />
            <p className="text-sm">Nessun lead avviato. Usa il riquadro qui sopra per partire.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Telefono</th>
                <th className="px-5 py-2.5 font-medium">Nome</th>
                <th className="px-5 py-2.5 text-right font-medium">Stato</th>
              </tr>
            </thead>
            <tbody>
              {initialRows.map((r) => (
                <tr key={r.id} className="border-t border-border/60 transition-colors hover:bg-muted/50">
                  <td className="px-5 py-3 font-medium tabular-nums">{r.phone}</td>
                  <td className="px-5 py-3 text-muted-foreground">{r.name || '—'}</td>
                  <td className="px-5 py-3 text-right">
                    <ChatStatusPill status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
