'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { VList, type VListHandle } from 'virtua';
import { Search } from 'lucide-react';
import { ETICHETTA_FASE, VISTA_META } from '@/lib/console/viste';
import type { RigaLista } from '@/lib/console/viste-db';
import { fondiPrimaPagina } from '@/lib/console/riga';
import { Kbd } from './ui/Kbd';
import { SkeletonRighe, useCaricamentoVisibile } from './ui/Skeleton';
import { Vuoto, Errore } from './ui/Stato';
import { RigaChat } from './RigaChat';
import { useStatoConsole } from './statoUrl';
import { rinfrescaConteggi, useConteggi } from './useConteggi';
import { useArrivi } from './useArrivi';
import { useCursoreLista } from './useCursoreLista';
import { useOra } from './useOra';

/** Altezza della riga (56) più 1 px di stacco, come il `gap` del mockup. */
const ALTEZZA_VOCE = 57;
const MANCANTI_PER_CARICARE = 10;
const OGNI = 10_000;
/** Durante il lancio gli inbound arrivano a raffica: al massimo una rilettura ogni 2 s. */
const RESPIRO_ARRIVI = 2_000;
const EVIDENZA_MS = 600;

type Pagina = { righe: RigaLista[]; prossimo: string | null };
type Dati = { chiave: string; righe: RigaLista[]; prossimo: string | null; errore: boolean };

const NESSUNA: RigaLista[] = [];

const fmt = new Intl.NumberFormat('it-IT');

function Ricerca({ iniziale, onCambia, inputRef }: { iniziale: string; onCambia: (q: string) => void; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [testo, setTesto] = useState(iniziale);
  const [visto, setVisto] = useState(iniziale);
  // Ricerca azzerata da fuori (la Nav cambia vista o la riseleziona): il campo si svuota.
  if (iniziale !== visto) {
    setVisto(iniziale);
    if (iniziale === '') setTesto('');
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <label className="search">
      <Search size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
      <input
        ref={inputRef}
        value={testo}
        placeholder="Nome o telefono"
        aria-label="Cerca nelle chat per nome o telefono"
        onChange={(e) => {
          const v = e.target.value;
          setTesto(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => onCambia(v.trim()), 300);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
      />
      <Kbd>/</Kbd>
    </label>
  );
}

/** Lista delle chat della vista corrente: virtualizzata (migliaia di righe durante il lancio),
 *  paginata a cursore, rinfrescata dal polling della prima pagina e dagli arrivi Realtime. */
export function ListaChat() {
  const [{ vista, fase, solo, q, chat }, setStato] = useStatoConsole();
  const chiave = JSON.stringify([vista, fase, solo, q]);
  const now = useOra();
  const { conteggi } = useConteggi();

  const [dati, setDati] = useState<Dati | null>(null);
  const [tentativo, setTentativo] = useState(0);
  const [appena, setAppena] = useState<ReadonlySet<number>>(new Set());

  const listaRef = useRef<VListHandle>(null);
  const ricercaRef = useRef<HTMLInputElement>(null);
  const chiaveRef = useRef(chiave);
  const datiRef = useRef<Dati | null>(null);
  const altroInVolo = useRef(false);
  const aggiornaInVolo = useRef(false);
  const ancora = useRef<{ id: number; scarto: number } | null>(null);
  const ultimoAggiornamento = useRef(0);
  const rilettura = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerEvidenza = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    chiaveRef.current = chiave;
    datiRef.current = dati;
  });

  const attuali = dati?.chiave === chiave ? dati : null;
  const righe = attuali?.righe ?? NESSUNA;
  const caricamento = attuali === null;
  const skeleton = useCaricamentoVisibile(caricamento);

  const leggi = useCallback(
    async (cursore: string | null, segnale?: AbortSignal): Promise<Pagina> => {
      const p = new URLSearchParams({ vista });
      if (fase) p.set('fase', fase);
      if (solo) p.set('solo', solo);
      if (q) p.set('q', q);
      if (cursore) p.set('cursore', cursore);
      const r = await fetch(`/api/console/chat?${p}`, { cache: 'no-store', signal: segnale });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as Pagina;
    },
    [vista, fase, solo, q],
  );

  // Prima pagina a ogni cambio di vista/filtri (e a ogni "Riprova").
  useEffect(() => {
    const ac = new AbortController();
    leggi(null, ac.signal).then(
      (p) => {
        ultimoAggiornamento.current = Date.now();
        setDati({ chiave, righe: p.righe, prossimo: p.prossimo, errore: false });
      },
      (e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        setDati({ chiave, righe: [], prossimo: null, errore: true });
      },
    );
    return () => ac.abort();
  }, [leggi, chiave, tentativo]);

  const evidenzia = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    setAppena(new Set(ids));
    if (timerEvidenza.current) clearTimeout(timerEvidenza.current);
    timerEvidenza.current = setTimeout(() => setAppena(new Set()), EVIDENZA_MS);
  }, []);

  // Rilegge la prima pagina e la fonde con quanto già caricato, tenendo ferma la riga in vista.
  const aggiorna = useCallback(async () => {
    const k = chiaveRef.current;
    const prima = datiRef.current;
    if (aggiornaInVolo.current) return; // una risposta vecchia non deve sovrascriverne una nuova
    if (!prima || prima.chiave !== k || prima.errore || document.visibilityState !== 'visible') return;
    aggiornaInVolo.current = true;
    ultimoAggiornamento.current = Date.now();
    let p: Pagina;
    try {
      p = await leggi(null);
    } catch {
      return; // un giro di polling fallito non svuota la lista: ci riprova il prossimo
    } finally {
      aggiornaInVolo.current = false;
    }
    const ora = datiRef.current;
    if (chiaveRef.current !== k || !ora || ora.chiave !== k) return;
    const f = fondiPrimaPagina(ora.righe, p, ora.prossimo);
    const h = listaRef.current;
    if (h && h.scrollOffset > 0) {
      const i = h.findItemIndex(h.scrollOffset);
      const r = ora.righe[i];
      if (r) ancora.current = { id: r.id, scarto: h.scrollOffset - h.getItemOffset(i) };
    }
    setDati({ chiave: k, righe: f.righe, prossimo: f.prossimo, errore: false });
    evidenzia(f.arrivate);
  }, [leggi, evidenzia]);

  // Dopo la fusione: la riga che era in cima alla finestra resta lì (niente salti mentre si legge).
  useLayoutEffect(() => {
    const a = ancora.current;
    const h = listaRef.current;
    if (!a || !h) return;
    ancora.current = null;
    const i = righe.findIndex((r) => r.id === a.id);
    if (i >= 0) h.scrollTo(h.getItemOffset(i) + a.scarto);
  }, [righe]);

  useEffect(() => {
    const id = setInterval(() => void aggiorna(), OGNI);
    // Al ritorno sulla scheda si rilegge subito, senza aspettare il prossimo giro.
    const suVisibilita = () => {
      if (document.visibilityState === 'visible') void aggiorna();
    };
    document.addEventListener('visibilitychange', suVisibilita);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', suVisibilita);
    };
  }, [aggiorna]);

  useEffect(
    () => () => {
      if (rilettura.current) clearTimeout(rilettura.current);
      if (timerEvidenza.current) clearTimeout(timerEvidenza.current);
    },
    [],
  );

  useArrivi(() => {
    if (rilettura.current) return;
    const attesa = Math.max(0, RESPIRO_ARRIVI - (Date.now() - ultimoAggiornamento.current));
    rilettura.current = setTimeout(() => {
      rilettura.current = null;
      void aggiorna();
      rinfrescaConteggi();
    }, attesa);
  });

  const caricaAltro = useCallback(async () => {
    const d = datiRef.current;
    if (altroInVolo.current || !d || d.chiave !== chiaveRef.current || !d.prossimo) return;
    altroInVolo.current = true;
    try {
      const p = await leggi(d.prossimo);
      const ora = datiRef.current;
      if (!ora || ora.chiave !== d.chiave || ora.prossimo !== d.prossimo) return;
      const visti = new Set(ora.righe.map((r) => r.id));
      setDati({ ...ora, righe: [...ora.righe, ...p.righe.filter((r) => !visti.has(r.id))], prossimo: p.prossimo });
    } catch {
      // Nessun cambio di stato: il prossimo scroll verso il fondo ci riprova.
    } finally {
      altroInVolo.current = false;
    }
  }, [leggi]);

  const vicinoAlFondo = useCallback(() => {
    const h = listaRef.current;
    const d = datiRef.current;
    if (!h || !d) return;
    const ultimaVisibile = h.findItemIndex(h.scrollOffset + h.viewportSize);
    if (ultimaVisibile >= d.righe.length - MANCANTI_PER_CARICARE) void caricaAltro();
  }, [caricaAltro]);

  // Una pagina che non riempie la finestra non fa scattare lo scroll: controllo anche qui.
  useEffect(() => {
    if (attuali?.prossimo) vicinoAlFondo();
  }, [attuali, vicinoAlFondo]);

  const ids = useMemo(() => righe.map((r) => r.id), [righe]);
  const { cursore, punta } = useCursoreLista({
    ids,
    chiave,
    chat,
    apri: (id) => void setStato({ chat: id }),
    chiudi: () => void setStato({ chat: null }),
    onCerca: () => ricercaRef.current?.focus(),
    mostra: (i) => listaRef.current?.scrollToIndex(i, { align: 'nearest' }),
  });
  const puntaRef = useRef(punta);
  useEffect(() => {
    puntaRef.current = punta;
  });
  // Clic su una riga: la apre e ci porta il cursore (stabile, per non ridisegnare le righe memo).
  const apri = useCallback(
    (id: number) => {
      puntaRef.current(id);
      void setStato({ chat: id });
    },
    [setStato],
  );
  const filtrata = !!(fase || solo || q);
  const totale = filtrata
    ? attuali && !attuali.errore
      ? `${fmt.format(righe.length)}${attuali.prossimo ? '+' : ''}`
      : ''
    : conteggi
      ? fmt.format(conteggi[vista])
      : '';
  const titolo = fase ? `${VISTA_META[vista].etichetta}: ${ETICHETTA_FASE[fase].toLowerCase()}` : VISTA_META[vista].etichetta;

  let corpo: React.ReactNode;
  if (caricamento) {
    corpo = skeleton ? (
      <div style={{ padding: '0 8px' }}>
        <SkeletonRighe righe={12} altezza={56} />
      </div>
    ) : null;
  } else if (attuali.errore) {
    corpo = (
      <Errore
        titolo="Non riesco a caricare le chat"
        testo="La richiesta al server non è andata a buon fine. Le chat non sono cambiate: riprova tra un momento."
        onRiprova={() => {
          setDati(null);
          setTentativo((t) => t + 1);
        }}
      />
    );
  } else if (righe.length === 0) {
    corpo = q ? (
      <Vuoto titolo={`Nessuna chat per “${q}”`} testo="Controlla il nome o il numero, oppure cerca in un'altra vista." />
    ) : (
      <Vuoto titolo="Nessuna chat in questa vista." testo="Le nuove arrivano qui da sole." />
    );
  } else {
    corpo = (
      <VList
        ref={listaRef}
        data={righe}
        itemSize={ALTEZZA_VOCE}
        role="listbox"
        aria-label={`Chat: ${titolo}`}
        aria-activedescendant={cursore != null ? `riga-chat-${cursore}` : undefined}
        tabIndex={0}
        style={{ flex: 1, minHeight: 0 }}
        onScroll={vicinoAlFondo}
      >
        {(r: RigaLista) => (
          <div key={r.id} style={{ padding: '0 8px 1px' }}>
            <RigaChat riga={r} selezionata={r.id === chat} cursore={r.id === cursore} appena={appena.has(r.id)} now={now} onApri={apri} />
          </div>
        )}
      </VList>
    );
  }

  return (
    <section className="list" aria-label={`Chat: ${titolo}`} style={{ height: '100%' }}>
      <div className="lh">
        <h2>{titolo}</h2>
        <span className="muted num">{totale}</span>
        <span className="sp" />
        {vista !== 'non_lette' && (
          <button
            type="button"
            className="btn ghost filtro"
            aria-pressed={solo === 'non_lette'}
            onClick={() => void setStato({ solo: solo ? null : 'non_lette' })}
          >
            Solo non lette
          </button>
        )}
      </div>
      <Ricerca key={vista} iniziale={q ?? ''} inputRef={ricercaRef} onCambia={(v) => void setStato({ q: v || null })} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{corpo}</div>
    </section>
  );
}
