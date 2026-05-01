'use client';
import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase/client';

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    audioRef.current = new Audio('/notify.mp3');
  }, []);

  // Chiedi permesso Notification al primo accesso a /inbox
  useEffect(() => {
    if (pathname?.startsWith('/inbox') && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, [pathname]);

  // Subscription globale: nuovi inbound
  useEffect(() => {
    const sb = getSupabaseBrowser();
    const ch = sb.channel('global-inbound')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: 'direction=eq.in',
      }, (payload) => {
        const msg: any = payload.new;
        router.refresh();

        try { audioRef.current?.play().catch(() => {}); } catch {}

        const inThisConv = pathname?.startsWith(`/inbox/${msg.conversation_id}`);
        if (!inThisConv && 'Notification' in window && Notification.permission === 'granted') {
          const n = new Notification('Nuova risposta WhatsApp', {
            body: msg.body?.slice(0, 120) ?? '',
            tag: `conv-${msg.conversation_id}`,
          });
          n.onclick = () => {
            window.focus();
            window.location.href = `/inbox/${msg.conversation_id}`;
          };
        }
      })
      .subscribe();
    return () => {
      sb.removeChannel(ch);
    };
  }, [router, pathname]);

  return <>{children}</>;
}
