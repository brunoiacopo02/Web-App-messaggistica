'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Composer } from '@/components/Composer';
import { toast } from 'sonner';

/**
 * Presa in carico di una chat: ferma il bot e apre il composer per rispondere a mano.
 *
 * Il pannello /chat nasce in sola lettura, e resta tale finché il bot governa la
 * conversazione: la scrittura si sblocca solo dopo il fermo, così non ci sono due
 * voci che scrivono insieme al lead. Stessa regola lato server (`/api/chat/messages`
 * rifiuta con 409 se il bot è attivo): il bottone disabilitato non è la guardia.
 */
export function ChatTakeover({ conversationId, paused: pausedIniziale, windowOpen }: {
  conversationId: number;
  paused: boolean;
  windowOpen: boolean;
}) {
  const [paused, setPaused] = useState(pausedIniziale);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const prossimo = !paused;
    setBusy(true);
    try {
      const res = await fetch('/api/chat/pause', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, paused: prossimo }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(prossimo ? 'Non sono riuscito a fermare il bot' : 'Non sono riuscito a riattivare il bot', {
          description: j.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setPaused(prossimo);
      toast.success(prossimo ? 'Bot fermo, la chat è tua' : 'Bot riattivato');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <span className="text-xs text-zinc-500">
          {paused
            ? 'Bot fermo su questa chat: rispondi tu, non partono più risposte automatiche né solleciti.'
            : 'Il bot sta gestendo questa chat.'}
        </span>
        <Button size="sm" variant={paused ? 'outline' : 'destructive'} onClick={toggle} disabled={busy}>
          {paused ? 'Riattiva il bot' : 'Ferma il bot'}
        </Button>
      </div>
      {paused && (
        <Composer
          conversationId={conversationId}
          windowOpen={windowOpen}
          campaigns={[]}
          sendPath="/api/chat/messages"
        />
      )}
    </div>
  );
}
