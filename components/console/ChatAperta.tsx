'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { convDaSegnareLetta } from '@/lib/segna-letta';
import { cursoreDopo, fondiMessaggi, type DettaglioChat, type Msg } from '@/lib/console/thread';
import { SkeletonRighe, useCaricamentoVisibile } from './ui/Skeleton';
import { Errore, Vuoto } from './ui/Stato';
import { toast } from './ui/toast';
import { Thread } from './Thread';
import { SchedaLead } from './SchedaLead';
import { Cabina } from './Cabina';
import { useStatoConsole } from './statoUrl';
import { rinfrescaConteggi } from './useConteggi';
import { useOra } from './useOra';
import { useTastiera } from './useTastiera';
import { CHAT_CAMBIATA } from './ComposerBridge';

/** Messaggi della chat aperta: polling a 5 s (brief). */
const OGNI_MESSAGGI = 5_000;
/** Dettaglio (stato, scheda, eventi): la lettura di event_log costa ~0,5 s, quindi 30 s, più una
 *  rilettura subito quando arriva un messaggio del lead (serve a segnare letta la chat). */
const OGNI_DETTAGLIO = 30_000;

type TipoErrore = 'rete' | 'non_trovata';
type Dati = { id: number; dettaglio: DettaglioChat | null; messaggi: Msg[] | null; errore: TipoErrore | null };

class HttpErrore extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

async function leggiJson<T>(url: string, segnale?: AbortSignal): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', signal: segnale });
  if (!r.ok) throw new HttpErrore(r.status);
  return (await r.json()) as T;
}

const leggiDettaglio = (id: number, s?: AbortSignal) => leggiJson<DettaglioChat>(`/api/console/chat/${id}`, s);
/** Gli ultimi 500 (`dopo` assente) o solo quelli con id > `dopo`, sempre crescenti. */
const leggiMessaggi = (id: number, dopo: number | null, s?: AbortSignal) =>
  leggiJson<{ messaggi: Msg[] }>(`/api/console/chat/${id}/messaggi${dopo != null ? `?dopo=${dopo}` : ''}`, s).then(
    (j) => j.messaggi ?? [],
  );

async function messaggioErrore(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { error?: string };
    return j.error ?? `HTTP ${r.status}`;
  } catch {
    return `HTTP ${r.status}`;
  }
}

/** Colonna centrale (thread) e colonna destra (cabina con la scheda lead) della chat aperta
 *  nell'URL (`?chat=`). Un solo stato dati per le due colonne: una lettura, due viste. */
export function ChatAperta() {
  const [{ chat }] = useStatoConsole();
  const now = useOra();
  const [dati, setDati] = useState<Dati | null>(null);
  const [tentativo, setTentativo] = useState(0);
  const [pausaInCorso, setPausaInCorso] = useState(false);
  const [schedaAperta, setSchedaAperta] = useState(true);

  const datiRef = useRef<Dati | null>(null);
  const inviate = useRef(new Map<number, number>());
  // Numero d'ordine delle letture: una risposta arrivata dopo una più recente si scarta.
  const seqMessaggi = useRef(0);
  const seqDettaglio = useRef(0);
  useEffect(() => {
    datiRef.current = dati;
  });

  const attuali = chat != null && dati?.id === chat ? dati : null;
  const caricamento = chat != null && attuali === null;
  const skeleton = useCaricamentoVisibile(caricamento);

  useTastiera({ onScheda: () => setSchedaAperta((s) => !s) });

  // Apertura: dettaglio e ultimi messaggi insieme.
  useEffect(() => {
    if (chat == null) return;
    const ac = new AbortController();
    const sm = ++seqMessaggi.current;
    const sd = ++seqDettaglio.current;
    Promise.all([leggiDettaglio(chat, ac.signal), leggiMessaggi(chat, null, ac.signal)]).then(
      ([dettaglio, messaggi]) => {
        if (sm !== seqMessaggi.current || sd !== seqDettaglio.current) return;
        setDati({ id: chat, dettaglio, messaggi, errore: null });
      },
      (e: unknown) => {
        if ((e as Error).name === 'AbortError' || sm !== seqMessaggi.current) return;
        const errore: TipoErrore = e instanceof HttpErrore && (e.status === 404 || e.status === 403) ? 'non_trovata' : 'rete';
        setDati({ id: chat, dettaglio: null, messaggi: null, errore });
      },
    );
    return () => ac.abort();
  }, [chat, tentativo]);

  /** Letta perché aperta: stessa regola del pannello /chat (la rotta azzera solo le chat di Mario).
   *  Se la richiesta fallisce il conteggio si dimentica, e il prossimo giro di polling ci riprova. */
  const segnaLetta = useCallback((id: number) => {
    const d = datiRef.current;
    if (!d || d.id !== id || !d.dettaglio) return;
    const da = convDaSegnareLetta(String(id), [{ id, unread_count: d.dettaglio.conv.unreadCount }], inviate.current);
    if (!da) return;
    inviate.current.set(da.id, da.count);
    fetch(`/api/chat/conversations/${da.id}/read`, { method: 'POST' }).then(
      (r) => {
        if (r.ok) rinfrescaConteggi();
        else inviate.current.delete(da.id);
      },
      () => inviate.current.delete(da.id),
    );
  }, []);

  const rileggiDettaglio = useCallback(async (id: number) => {
    const n = ++seqDettaglio.current;
    try {
      const dettaglio = await leggiDettaglio(id);
      if (n !== seqDettaglio.current) return;
      setDati((d) => (d && d.id === id && !d.errore ? { ...d, dettaglio } : d));
    } catch {
      // Un giro fallito non svuota la scheda: ci riprova il prossimo.
    }
  }, []);

  const rileggiMessaggi = useCallback(
    async (id: number) => {
      const prima = datiRef.current;
      if (!prima || prima.id !== id || prima.errore || !prima.messaggi) return;
      const n = ++seqMessaggi.current;
      let nuovi: Msg[];
      try {
        // Rilegge anche gli ultimi 20 già in pagina: il loro stato di consegna cambia dopo l'invio.
        nuovi = await leggiMessaggi(id, cursoreDopo(prima.messaggi));
      } catch {
        return;
      }
      if (n !== seqMessaggi.current) return;
      const visti = new Set(prima.messaggi.map((m) => m.id));
      const nuovoInbound = nuovi.some((m) => m.direction === 'in' && !visti.has(m.id));
      setDati((d) => (d && d.id === id && !d.errore && d.messaggi ? { ...d, messaggi: fondiMessaggi(d.messaggi, nuovi) } : d));
      if (nuovoInbound) void rileggiDettaglio(id);
    },
    [rileggiDettaglio],
  );

  // Polling della chat aperta, solo con la scheda del browser in primo piano.
  useEffect(() => {
    if (chat == null) return;
    const visibile = () => document.visibilityState === 'visible';
    const m = setInterval(() => {
      if (!visibile()) return;
      void rileggiMessaggi(chat);
      segnaLetta(chat);
    }, OGNI_MESSAGGI);
    const d = setInterval(() => visibile() && void rileggiDettaglio(chat), OGNI_DETTAGLIO);
    return () => {
      clearInterval(m);
      clearInterval(d);
    };
  }, [chat, rileggiMessaggi, rileggiDettaglio, segnaLetta]);

  // Un'azione eseguita dalla palette o dall'Assistente: stato di Mario riletto subito.
  useEffect(() => {
    if (chat == null) return;
    const rileggi = () => void rileggiDettaglio(chat);
    window.addEventListener(CHAT_CAMBIATA, rileggi);
    return () => window.removeEventListener(CHAT_CAMBIATA, rileggi);
  }, [chat, rileggiDettaglio]);

  // Subito all'apertura e a ogni nuovo conteggio di non letti.
  const nonLetti = attuali?.dettaglio?.conv.unreadCount ?? 0;
  useEffect(() => {
    if (chat != null && nonLetti > 0) segnaLetta(chat);
  }, [chat, nonLetti, segnaLetta]);

  const pausa = useCallback(
    async (inPausa: boolean) => {
      if (chat == null) return;
      setPausaInCorso(true);
      try {
        const r = await fetch('/api/chat/pause', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversation_id: chat, paused: inPausa }),
        });
        if (!r.ok) {
          toast.errore(
            inPausa
              ? `Mario non si è fermato (${await messaggioErrore(r)}): la chat è ancora sua. Riprova.`
              : `Mario non è ripartito (${await messaggioErrore(r)}): la chat resta in pausa. Riprova.`,
          );
          return;
        }
        toast.ok(inPausa ? 'Mario in pausa su questa chat' : 'Chat ridata a Mario');
        await rileggiDettaglio(chat);
        rinfrescaConteggi();
      } catch {
        toast.errore('Il server non ha risposto: lo stato di Mario non è cambiato. Riprova.');
      } finally {
        setPausaInCorso(false);
      }
    },
    [chat, rileggiDettaglio],
  );

  const invia = useCallback(
    async (testo: string): Promise<boolean> => {
      if (chat == null) return false;
      try {
        const r = await fetch('/api/chat/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversation_id: chat, mode: 'free', body: testo }),
        });
        if (r.status === 409) {
          toast.errore('Mario è ancora attivo su questa chat: mettilo in pausa prima di scrivere.');
          void rileggiDettaglio(chat);
          return false;
        }
        if (!r.ok) {
          toast.errore(`Messaggio non inviato (${await messaggioErrore(r)}). Il testo è rimasto nel campo: riprova.`);
          return false;
        }
        await rileggiMessaggi(chat);
        return true;
      } catch {
        toast.errore('Il server non ha risposto: il messaggio non è partito. Il testo è rimasto nel campo.');
        return false;
      }
    },
    [chat, rileggiDettaglio, rileggiMessaggi],
  );

  let thread: React.ReactNode;
  let scheda: React.ReactNode = null;
  if (chat == null) {
    thread = (
      <section className="thread" aria-label="Conversazione">
        <Vuoto titolo="Seleziona una chat" testo="La conversazione si apre qui. Scorri la lista con j e k, apri con Invio." />
      </section>
    );
  } else if (attuali === null) {
    thread = (
      <section className="thread" aria-label="Conversazione" aria-busy="true">
        {skeleton && (
          <div style={{ padding: '20px 24px' }}>
            <SkeletonRighe righe={6} altezza={40} />
          </div>
        )}
      </section>
    );
  } else if (attuali.errore === 'non_trovata') {
    thread = (
      <section className="thread" aria-label="Conversazione">
        <Vuoto titolo="Questa chat non è nella console" testo="Non esiste o è fuori dal perimetro Fenice. Scegline un'altra dalla lista." />
      </section>
    );
  } else if (attuali.errore || !attuali.dettaglio || !attuali.messaggi) {
    thread = (
      <section className="thread" aria-label="Conversazione">
        <Errore
          titolo="Non riesco ad aprire la chat"
          testo="La richiesta al server non è andata a buon fine. Nulla è cambiato sulla chat: riprova tra un momento."
          onRiprova={() => {
            setDati(null);
            setTentativo((t) => t + 1);
          }}
        />
      </section>
    );
  } else {
    thread = (
      <Thread
        dettaglio={attuali.dettaglio}
        messaggi={attuali.messaggi}
        now={now}
        pausaInCorso={pausaInCorso}
        onPausa={(p) => void pausa(p)}
        onInvia={invia}
        schedaAperta={schedaAperta}
        onScheda={() => setSchedaAperta((s) => !s)}
      />
    );
    if (schedaAperta) scheda = <SchedaLead key={attuali.id} dettaglio={attuali.dettaglio} now={now} />;
  }

  return (
    <>
      {thread}
      {/* La cabina: gli avvisi urgenti in alto, sotto la scheda del lead. */}
      <Cabina>{scheda}</Cabina>
    </>
  );
}
