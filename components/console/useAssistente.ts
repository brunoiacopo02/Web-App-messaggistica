'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AzioneRef } from '@/lib/console/avvisi';
import type { Citazione } from '@/lib/console/assistente-tools';

export type Passo = { nome: string; sintesi: string };
export type BozzaAssistente = { conversationId: number; testo: string };

/** Una domanda dell'admin e tutto quello che l'Assistente ha prodotto per rispondere. */
export type Turno = {
  id: number;
  domanda: string;
  passi: Passo[];
  testo: string;
  citazioni: Citazione[];
  proposte: AzioneRef[];
  bozze: BozzaAssistente[];
  errore: string | null;
  finito: boolean;
};

type EventoSse =
  | { tipo: 'strumento'; nome: string; sintesi: string }
  | { tipo: 'testo'; testo: string }
  | { tipo: 'citazioni'; citazioni: Citazione[] }
  | { tipo: 'proposta'; proposta: AzioneRef }
  | { tipo: 'bozza'; bozza: BozzaAssistente }
  | { tipo: 'fine' }
  | { tipo: 'errore'; messaggio: string };

/** Oltre questi la rotta risponde 400: si mandano gli ultimi, sempre chiusi dalla domanda nuova. */
const MAX_MESSAGGI = 20;
const MAX_TESTO = 4000;

/**
 * Aggiunge `pezzo` al `resto` della chiamata precedente, emette un evento per ogni riga `data:`
 * completa e restituisce la parte di riga ancora a metà. Righe diverse (commenti, righe vuote) e
 * JSON rotti si saltano: uno scarto non ferma il resto dello stream.
 */
export function analizzaSse(resto: string, pezzo: string, emetti: (e: EventoSse) => void): string {
  const righe = (resto + pezzo).split('\n');
  const ultima = righe.pop() ?? '';
  for (const r of righe) {
    const riga = r.endsWith('\r') ? r.slice(0, -1) : r;
    if (!riga.startsWith('data:')) continue;
    try {
      emetti(JSON.parse(riga.slice(5).trim()) as EventoSse);
    } catch {
      // riga rotta: si passa alla prossima
    }
  }
  return ultima;
}

function messaggioHttp(status: number): string {
  if (status === 401 || status === 403) return 'La sessione è scaduta: rientra nella console e rifai la domanda.';
  if (status === 400) return "La domanda non è stata accettata (troppo lunga o conversazione troppo lunga). Ricomincia e riprova.";
  return `L'Assistente non ha risposto (HTTP ${status}). Riprova tra un momento.`;
}

function storia(turni: Turno[], domanda: string) {
  const m: { ruolo: 'utente' | 'assistente'; testo: string }[] = [];
  for (const t of turni) {
    if (t.errore) continue;
    m.push({ ruolo: 'utente', testo: t.domanda.slice(0, MAX_TESTO) });
    if (t.testo.trim()) m.push({ ruolo: 'assistente', testo: t.testo.trim().slice(0, MAX_TESTO) });
  }
  m.push({ ruolo: 'utente', testo: domanda.slice(0, MAX_TESTO) });
  return m.slice(-MAX_MESSAGGI);
}

/**
 * La conversazione con l'Assistente (`POST /api/console/assistente`, SSE). Un turno alla volta:
 * una seconda `invia` mentre la prima è in corso si ignora. `riprova` rimanda la domanda dell'ultimo
 * turno finito in errore. I turni in errore non entrano nella storia mandata al modello.
 */
export function useAssistente() {
  const [messaggi, setMessaggi] = useState<Turno[]>([]);
  const [inCorso, setInCorso] = useState(false);
  // Guardia sincrona: due invii nello stesso giro di React vedono ancora `inCorso` a false.
  const occupato = useRef(false);
  const turniRef = useRef<Turno[]>([]);
  const prossimoId = useRef(1);
  const ac = useRef<AbortController | null>(null);

  useEffect(() => {
    turniRef.current = messaggi;
  });
  useEffect(() => () => ac.current?.abort(), []);

  const avvia = useCallback(async (domanda: string, precedenti: Turno[]) => {
    const id = prossimoId.current++;
    const vuoto: Turno = { id, domanda, passi: [], testo: '', citazioni: [], proposte: [], bozze: [], errore: null, finito: false };
    turniRef.current = [...precedenti, vuoto];
    setMessaggi(turniRef.current);
    setInCorso(true);

    const aggiorna = (f: (t: Turno) => Turno) => setMessaggi((ts) => ts.map((t) => (t.id === id ? f(t) : t)));
    const chiudi = (errore: string | null) => aggiorna((t) => ({ ...t, errore, finito: true }));

    const controller = new AbortController();
    ac.current = controller;
    try {
      const r = await fetch('/api/console/assistente', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messaggi: storia(precedenti, domanda) }),
        signal: controller.signal,
      });
      if (!r.ok || !r.body) {
        chiudi(messaggioHttp(r.status));
        return;
      }
      let chiuso = false;
      const suEvento = (e: EventoSse) => {
        if (chiuso) return;
        switch (e.tipo) {
          case 'strumento':
            aggiorna((t) => ({ ...t, passi: [...t.passi, { nome: e.nome, sintesi: e.sintesi }] }));
            break;
          case 'testo':
            aggiorna((t) => ({ ...t, testo: t.testo + e.testo }));
            break;
          case 'citazioni':
            aggiorna((t) => ({ ...t, citazioni: [...t.citazioni, ...e.citazioni] }));
            break;
          case 'proposta':
            aggiorna((t) => ({ ...t, proposte: [...t.proposte, e.proposta] }));
            break;
          case 'bozza':
            aggiorna((t) => ({ ...t, bozze: [...t.bozze, e.bozza] }));
            break;
          case 'fine':
            chiuso = true;
            chiudi(null);
            break;
          case 'errore':
            chiuso = true;
            chiudi(e.messaggio);
            break;
        }
      };
      const lettore = r.body.getReader();
      const dec = new TextDecoder();
      let resto = '';
      for (;;) {
        const { done, value } = await lettore.read();
        if (done) break;
        resto = analizzaSse(resto, dec.decode(value, { stream: true }), suEvento);
      }
      analizzaSse(resto, dec.decode() + '\n', suEvento);
      if (!chiuso) chiudi("La risposta si è interrotta a metà. Riprova: l'Assistente rilegge da capo.");
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      chiudi("Il server non ha risposto all'Assistente. Controlla la connessione e riprova.");
    } finally {
      // Dopo `ricomincia` il turno non è più quello corrente: lo stato l'ha già azzerato lei, e un
      // turno nuovo partito nel frattempo non va sbloccato da quello vecchio.
      if (ac.current === controller) {
        ac.current = null;
        occupato.current = false;
        setInCorso(false);
      }
    }
  }, []);

  const invia = useCallback(
    (testo: string) => {
      const domanda = testo.trim();
      if (domanda === '' || occupato.current) return;
      occupato.current = true;
      void avvia(domanda, turniRef.current);
    },
    [avvia],
  );

  const riprova = useCallback(() => {
    const turni = turniRef.current;
    const ultimo = turni.at(-1);
    if (!ultimo?.errore || occupato.current) return;
    occupato.current = true;
    void avvia(ultimo.domanda, turni.slice(0, -1));
  }, [avvia]);

  const ricomincia = useCallback(() => {
    ac.current?.abort();
    ac.current = null;
    occupato.current = false;
    turniRef.current = [];
    setMessaggi([]);
    setInCorso(false);
  }, []);

  const ultimo = messaggi.at(-1);
  return {
    messaggi,
    invia,
    inCorso,
    passi: ultimo?.passi ?? [],
    errore: ultimo?.errore ?? null,
    riprova,
    ricomincia,
  };
}

type DatiSuggerimenti = {
  conteggi: { errori?: number; serve_te?: number } | null;
  avviso: { titolo: string } | null;
  lancioAttivo: boolean;
};

/** Le tre domande dello stato vuoto, fatte coi numeri di adesso (contatori delle viste, primo
 *  avviso, lancio). Dove un dato manca si ripiega su domande sempre utili. */
export function domandeSuggerite({ conteggi, avviso, lancioAttivo }: DatiSuggerimenti): string[] {
  const d: string[] = [];
  const errori = conteggi?.errori ?? 0;
  const serveTe = conteggi?.serve_te ?? 0;
  if (errori > 0) d.push(`Perché ${errori} ${errori === 1 ? 'chat ha' : 'chat hanno'} un invio non riuscito?`);
  else if (serveTe > 0) d.push(`Da quali delle ${serveTe} chat che aspettano te parto?`);
  if (avviso) d.push(`Cosa c'è dietro l'avviso "${avviso.titolo}"?`);
  if (lancioAttivo) d.push("Com'è messo il lancio?");
  for (const riserva of ["Chi scrive 'disdetta' oggi?", "Cosa è cambiato nelle ultime 6 ore?", 'Quali chat aspettano una risposta da più tempo?']) {
    if (d.length >= 3) break;
    if (!d.includes(riserva)) d.push(riserva);
  }
  return d.slice(0, 3);
}

export type ConversazioneAssistente = ReturnType<typeof useAssistente>;
