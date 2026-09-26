'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, CircleAlert, Info, RefreshCw, Search, Settings, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LANCIO_FASI } from '@/lib/lancio-fase';
import {
  statoConsegnaLeggibile,
  eFallito,
  eConsegnato,
  type Avviso,
  type ChatLancio,
  type Contatori,
  type EventoMonitor,
} from '@/lib/lancio-monitor';

// ─────────────────────────── tipi della risposta ───────────────────────────

type UltimoBot = { at: string; stato: string | null; codice: number | null; template: boolean };
type Riga = ChatLancio & {
  anteprima: string | null;
  ultimoDelLead: boolean;
  ultimoBot: UltimoBot | null;
  pulsante: boolean;
  problemi: boolean;
};
type Risposta = {
  generatoAt: string;
  consegneAt: string | null;
  erroreConsegne: string | null;
  colonnaInizio: boolean;
  impostazioni: { attivo: boolean; pulsanteAttivo: boolean; eventoAt: string | null; blastPerimetro: string; videoLiveLink: boolean; zoomLink: boolean };
  contatori: Contatori;
  avvisi: Avviso[];
  lista: { totale: number; pagina: number; perPagina: number; righe: Riga[] };
};
type Messaggio = {
  id: number; direction: string; body: string; created_at: string; is_template: boolean;
  template_sid: string | null; templateNome: string | null; twilio_status: string | null; twilio_error_code: number | null; sender: string | null;
};
type Dettaglio = { chat: ChatLancio; colonnaInizio: boolean; messaggi: Messaggio[]; eventi: EventoMonitor[] };

const REFRESH_MS = 30_000;

// ─────────────────────────── formattazione ───────────────────────────

const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtOraSec = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long' });
const fmtBreve = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtNum = new Intl.NumberFormat('it-IT');
const giornoKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });

function quando(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return giornoKey.format(d) === giornoKey.format(new Date()) ? fmtOra.format(d) : fmtBreve.format(d);
}
const n = (v: number | null | undefined) => (v === null || v === undefined ? 'n/d' : fmtNum.format(v));

const ETICHETTA_FASE: Record<string, string> = {
  attesa: 'In attesa',
  posto_bloccato: 'Posto bloccato',
  link_inviato: 'Link inviato',
  post_pitch: 'Dopo il pitch',
  scelta_fatta: 'Scelta fatta',
  followup_inviato: 'Follow-up inviato',
  restituito: 'Restituito',
  chiuso: 'Chiuso',
};
const faseLeggibile = (c: Pick<ChatLancio, 'fase' | 'slug'>) => (!c.slug ? 'Fuori dal lancio' : ETICHETTA_FASE[c.fase ?? ''] ?? c.fase ?? 'Senza fase');

/** Le parole fra backtick degli avvisi diventano codice. */
function ConCodice({ testo }: { testo: string }) {
  const parti = testo.split('`');
  return (
    <>
      {parti.map((p, i) => (i % 2 === 1
        ? <code key={i} className="rounded-sm bg-[var(--lm-hover)] px-1 font-mono text-[12px]">{p}</code>
        : <span key={i}>{p}</span>))}
    </>
  );
}

// ─────────────────────────── componente ───────────────────────────

export function MonitorLancio() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [dati, setDati] = useState<Risposta | null>(null);
  const [errore, setErrore] = useState<{ at: string; testo: string } | null>(null);
  const [caricando, setCaricando] = useState(false);
  const richiesta = useRef<AbortController | null>(null);

  const chatAperta = Number(sp.get('chat')) || null;
  const vista = sp.get('vista') === 'avvisi' ? 'avvisi' : 'chat';
  const qsLista = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of ['fase', 'pulsante', 'problemi', 'q', 'ids', 'pagina']) {
      const v = sp.get(k);
      if (v) p.set(k, v);
    }
    return p.toString();
  }, [sp]);

  const aggiorna = useCallback(async (qs: string) => {
    richiesta.current?.abort();
    const ctrl = new AbortController();
    richiesta.current = ctrl;
    setCaricando(true);
    try {
      const r = await fetch(`/api/fenice/lancio-monitor${qs ? `?${qs}` : ''}`, { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string; dettaglio?: string } | null;
        throw new Error(r.status === 403 ? 'questo account non vede il monitor' : j?.dettaglio ?? j?.error ?? `HTTP ${r.status}`);
      }
      setDati((await r.json()) as Risposta);
      setErrore(null);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setErrore({ at: new Date().toISOString(), testo: (e as Error).message });
    } finally {
      if (richiesta.current === ctrl) setCaricando(false);
    }
  }, []);

  // Refresh ogni 30s, sospeso a scheda nascosta; ripartito subito al ritorno.
  useEffect(() => {
    aggiorna(qsLista);
    const giro = () => { if (document.visibilityState === 'visible') aggiorna(qsLista); };
    const t = setInterval(giro, REFRESH_MS);
    document.addEventListener('visibilitychange', giro);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', giro); };
  }, [aggiorna, qsLista]);

  const imposta = useCallback((cambi: Record<string, string | null>, resetPagina = true) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(cambi)) { if (v === null || v === '') p.delete(k); else p.set(k, v); }
    if (resetPagina && !('pagina' in cambi)) p.delete('pagina');
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [sp, router, pathname]);

  const avvisi = dati?.avvisi ?? [];
  const critici = avvisi.filter((a) => a.gravita === 'critico').length;

  return (
    <div className="lm flex h-full min-h-0 flex-col text-[13px]">
      <Testata dati={dati} errore={errore} caricando={caricando} onAggiorna={() => aggiorna(qsLista)} />
      {dati && <Contatori dati={dati} />}

      <div className="flex min-h-0 flex-1">
        {/* Avvisi: colonna propria sugli schermi larghi */}
        <section aria-label="Avvisi" className="hidden w-[340px] shrink-0 flex-col border-r border-[var(--lm-line)] 2xl:flex">
          <PannelloAvvisi avvisi={avvisi} caricato={!!dati} onMostra={(a) => imposta({ ids: a.chat.join(','), vista: null, avviso: a.titolo })} />
        </section>

        {/* Lista (e avvisi sotto i 1536px) */}
        <section
          aria-label="Chat del lancio"
          className={cn('flex min-h-0 w-full flex-col border-r border-[var(--lm-line)] md:w-[380px] md:shrink-0', chatAperta && 'hidden md:flex')}
        >
          <div className="flex shrink-0 gap-1 border-b border-[var(--lm-line)] px-3 py-2 2xl:hidden" role="tablist">
            <Scheda attiva={vista === 'chat'} onClick={() => imposta({ vista: null }, false)}>Chat</Scheda>
            <Scheda attiva={vista === 'avvisi'} onClick={() => imposta({ vista: 'avvisi' }, false)}>
              Avvisi
              {avvisi.length > 0 && (
                <span className={cn('ml-1.5 tabular-nums', critici > 0 ? 'font-semibold text-[var(--lm-red)]' : 'text-[var(--lm-muted)]')}>
                  {critici > 0 ? `${critici} critici` : avvisi.length}
                </span>
              )}
            </Scheda>
          </div>
          {vista === 'avvisi' ? (
            <div className="min-h-0 flex-1 2xl:hidden">
              <PannelloAvvisi avvisi={avvisi} caricato={!!dati} onMostra={(a) => imposta({ ids: a.chat.join(','), vista: null, avviso: a.titolo })} />
            </div>
          ) : null}
          <div className={cn('flex min-h-0 flex-1 flex-col', vista === 'avvisi' && 'hidden 2xl:flex')}>
            <Lista dati={dati} sp={sp} imposta={imposta} chatAperta={chatAperta} />
          </div>
        </section>

        {/* Dettaglio */}
        <section aria-label="Dettaglio chat" className={cn('min-w-0 flex-1 flex-col', chatAperta ? 'flex' : 'hidden md:flex')}>
          {chatAperta
            ? <DettaglioChat key={chatAperta} id={chatAperta} onChiudi={() => imposta({ chat: null }, false)} />
            : <Vuoto titolo="Nessuna chat aperta" testo="Scegli una chat dalla lista per leggere i messaggi, lo stato di consegna di ognuno e gli eventi del lancio in ordine di tempo." />}
        </section>
      </div>
    </div>
  );
}

function Scheda({ attiva, onClick, children }: { attiva: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={attiva}
      onClick={onClick}
      className={cn(
        'rounded-md px-2.5 py-1 text-[13px] font-medium',
        attiva ? 'bg-[var(--lm-sel)] text-[var(--lm-fg)]' : 'text-[var(--lm-muted)] hover:bg-[var(--lm-hover)]',
      )}
    >
      {children}
    </button>
  );
}

// ─────────────────────────── testata ───────────────────────────

function Stato({ acceso, si, no }: { acceso: boolean; si: string; no: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-medium',
      acceso ? 'bg-[var(--lm-green-bg)] text-[var(--lm-green)]' : 'bg-[var(--lm-red-bg)] text-[var(--lm-red)]')}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {acceso ? si : no}
    </span>
  );
}

function Testata({ dati, errore, caricando, onAggiorna }: {
  dati: Risposta | null; errore: { at: string; testo: string } | null; caricando: boolean; onAggiorna: () => void;
}) {
  const evento = dati?.impostazioni.eventoAt ? new Date(dati.impostazioni.eventoAt) : null;
  const eventoValido = evento && !Number.isNaN(evento.getTime());
  return (
    <header className="shrink-0 border-b border-[var(--lm-line)] px-4 py-2.5 md:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-tight">Monitor del lancio</h1>
          <p className="text-[12px] text-[var(--lm-muted)]">
            Web Developer AI{eventoValido ? `, live di ${fmtGiorno.format(evento!)} alle ${fmtOra.format(evento!)}` : ', data della live non impostata'}
          </p>
        </div>
        {dati && (
          <div className="flex flex-wrap items-center gap-2">
            <Stato acceso={dati.impostazioni.attivo} si="Lancio acceso" no="Lancio spento" />
            <Stato acceso={dati.impostazioni.pulsanteAttivo} si="Pulsante acceso" no="Pulsante spento" />
            <span className="text-[12px] text-[var(--lm-muted)]">Perimetro blast: {dati.impostazioni.blastPerimetro === 'risposto' ? 'solo chi ha risposto' : 'tutti'}</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-3">
          {dati && (
            <span className="text-[12px] text-[var(--lm-muted)]" aria-live="polite">
              Aggiornato alle <span className="tabular-nums text-[var(--lm-fg)]">{fmtOraSec.format(new Date(dati.generatoAt))}</span>
              {dati.consegneAt && <> , consegne alle <span className="tabular-nums">{fmtOra.format(new Date(dati.consegneAt))}</span></>}
            </span>
          )}
          <button
            type="button"
            onClick={onAggiorna}
            disabled={caricando}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--lm-line)] px-2 py-1 text-[12px] font-medium hover:bg-[var(--lm-hover)] disabled:opacity-60"
          >
            <RefreshCw className={cn('size-3.5', caricando && 'animate-spin motion-reduce:animate-none')} />
            {caricando ? 'Aggiorno…' : 'Aggiorna'}
          </button>
          <Link href="/fenice/impostazioni" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[var(--lm-muted)] hover:bg-[var(--lm-hover)] hover:text-[var(--lm-fg)]">
            <Settings className="size-3.5" /> Impostazioni
          </Link>
        </div>
      </div>
      {errore && (
        <p role="alert" className="mt-2 rounded-md bg-[var(--lm-red-bg)] px-2.5 py-1.5 text-[12px] text-[var(--lm-red)]">
          Aggiornamento delle {fmtOraSec.format(new Date(errore.at))} non riuscito: {errore.testo}.{' '}
          {dati ? 'I numeri qui sotto sono quelli dell’ultimo aggiornamento riuscito. ' : ''}Riprovo fra 30 secondi.
        </p>
      )}
      {dati?.erroreConsegne && (
        <p className="mt-2 text-[12px] text-[var(--lm-amber)]">
          Consegne non lette ({dati.erroreConsegne}): i conteggi dei consegnati e il filtro «Errori di consegna» sono vuoti fino al prossimo giro.
        </p>
      )}
    </header>
  );
}

// ─────────────────────────── contatori ───────────────────────────

function Cella({ etichetta, valore, nota, segnale }: { etichetta: string; valore: string; nota?: string; segnale?: 'rosso' | 'ambra' }) {
  return (
    <div className="min-w-[112px] px-3 py-2">
      <div className={cn('text-[16px] font-semibold leading-tight tabular-nums',
        segnale === 'rosso' && 'text-[var(--lm-red)]', segnale === 'ambra' && 'text-[var(--lm-amber)]')}
      >
        {valore}
      </div>
      <div className="text-[12px] leading-snug text-[var(--lm-muted)]">{etichetta}</div>
      {nota && <div className="text-[11px] leading-snug text-[var(--lm-muted)] tabular-nums">{nota}</div>}
    </div>
  );
}

function Gruppo({ titolo, children }: { titolo: string; children: React.ReactNode }) {
  return (
    <div className="flex items-stretch">
      <div className="flex w-[84px] shrink-0 items-center px-3 text-[12px] font-medium text-[var(--lm-muted)]">{titolo}</div>
      <div className="flex flex-wrap divide-x divide-[var(--lm-line)]">{children}</div>
    </div>
  );
}

function Contatori({ dati }: { dati: Risposta }) {
  const k = dati.contatori;
  const perc = (a: number | null, b: number) => (a === null || b === 0 ? undefined : `${Math.round((a / b) * 100)}% consegnati`);
  return (
    <section aria-label="Numeri del lancio" className="shrink-0 overflow-x-auto border-b border-[var(--lm-line)] bg-[var(--lm-panel)]">
      <div className="flex min-w-max flex-col divide-y divide-[var(--lm-line)]">
        <Gruppo titolo="Iscrizioni">
          <Cella etichetta="Iscritti" valore={n(k.iscritti)} nota={Object.entries(k.perIngresso).map(([i, v]) => `${i === 'pulsante_webinar' ? 'pulsante' : i} ${fmtNum.format(v)}`).join(', ')} />
          <Cella etichetta="Benvenuti inviati" valore={n(k.benvenutiInviati)} nota={k.benvenutiConsegnati === null ? 'consegnati n/d' : `${n(k.benvenutiConsegnati)} consegnati`} />
          <Cella etichetta="Hanno risposto" valore={n(k.risposte)} nota={k.benvenutiInviati ? `${Math.round((k.risposte / k.benvenutiInviati) * 100)}% dei benvenuti` : undefined} />
          <Cella etichetta="Posto bloccato" valore={n(k.postoBloccato)} />
          <Cella etichetta="Congedi" valore={n(k.congedi)} />
          <Cella etichetta="Restituiti" valore={n(k.restituiti)} />
        </Gruppo>
        <Gruppo titolo="Serata">
          <Cella etichetta="Link Zoom inviati" valore={n(k.linkZoomInviati)} nota={perc(k.linkZoomConsegnati, k.linkZoomInviati) ?? (k.linkZoomConsegnati === null ? 'consegnati n/d' : undefined)} />
          <Cella
            etichetta="Messaggio delle 21"
            valore={k.messaggio21Inviati === null ? 'n/d' : n(k.messaggio21Inviati)}
            nota={k.messaggio21Inviati === null ? 'colonna non ancora nel DB' : k.messaggio21Consegnati === null ? undefined : `${n(k.messaggio21Consegnati)} consegnati`}
          />
          <Cella etichetta="Pulsante premuto" valore={n(k.pulsantePremuto)} nota={k.pulsanteOrfani ? `${n(k.pulsanteOrfani)} senza guida` : undefined} segnale={k.pulsanteOrfani ? 'ambra' : undefined} />
          <Cella etichetta="Scelte fatte" valore={n(k.scelteFatte.totale)} nota={`chiamata ${n(k.scelteFatte.chiamaOra)}, prenotate ${n(k.scelteFatte.prenota)}, già fissate ${n(k.scelteFatte.giaPrenotato)}`} />
        </Gruppo>
        <Gruppo titolo="Pulsanti">
          {Object.entries(k.tocchi).map(([titolo, v]) => <Cella key={titolo} etichetta={titolo} valore={n(v)} />)}
        </Gruppo>
      </div>
    </section>
  );
}

// ─────────────────────────── avvisi ───────────────────────────

const GRAVITA = {
  critico: { etichetta: 'Critico', Icona: CircleAlert, cls: 'text-[var(--lm-red)]' },
  attenzione: { etichetta: 'Da guardare', Icona: AlertTriangle, cls: 'text-[var(--lm-amber)]' },
  info: { etichetta: 'Informativo', Icona: Info, cls: 'text-[var(--lm-muted)]' },
} as const;

function PannelloAvvisi({ avvisi, caricato, onMostra }: { avvisi: Avviso[]; caricato: boolean; onMostra: (a: Avviso) => void }) {
  if (!caricato) return <Scheletro righe={4} alta />;
  if (avvisi.length === 0) {
    return <Vuoto titolo="Nessun avviso" testo="Freni, template bloccati, errori Twilio dell’ultima ora, chat senza risposta ed errori verso il CRM compaiono qui appena succedono." />;
  }
  return (
    <ol className="h-full overflow-y-auto divide-y divide-[var(--lm-line)]">
      {avvisi.map((a) => {
        const g = GRAVITA[a.gravita];
        return (
          <li key={a.id} className="px-4 py-3">
            <div className={cn('flex items-center gap-1.5 text-[12px] font-medium', g.cls)}>
              <g.Icona className="size-3.5" aria-hidden />
              {g.etichetta}
              {a.ultimoAt && <span className="ml-auto font-normal text-[var(--lm-muted)] tabular-nums">ultimo alle {quando(a.ultimoAt)}</span>}
            </div>
            <h3 className="mt-1 text-[13px] font-semibold leading-snug">{a.titolo}</h3>
            <p className="mt-1 leading-snug text-[var(--lm-muted)]"><ConCodice testo={a.significato} /></p>
            <p className="mt-1 leading-snug"><span className="font-medium">Cosa fare: </span><ConCodice testo={a.cosaFare} /></p>
            {(a.chat.length > 0 || a.impostazioni) && (
              <div className="mt-2 flex flex-wrap gap-2">
                {a.chat.length > 0 && (
                  <button type="button" onClick={() => onMostra(a)} className="rounded-md border border-[var(--lm-line)] px-2 py-0.5 text-[12px] font-medium hover:bg-[var(--lm-hover)]">
                    Mostra {a.chat.length === 1 ? 'la chat' : `le ${a.chat.length} chat`}{a.conteggio > a.chat.length ? ` (su ${fmtNum.format(a.conteggio)})` : ''}
                  </button>
                )}
                {a.impostazioni && (
                  <Link href="/fenice/impostazioni" className="rounded-md border border-[var(--lm-line)] px-2 py-0.5 text-[12px] font-medium hover:bg-[var(--lm-hover)]">
                    Apri Impostazioni
                  </Link>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ─────────────────────────── lista ───────────────────────────

function Lista({ dati, sp, imposta, chatAperta }: {
  dati: Risposta | null;
  sp: URLSearchParams;
  imposta: (c: Record<string, string | null>, resetPagina?: boolean) => void;
  chatAperta: number | null;
}) {
  const [q, setQ] = useState(sp.get('q') ?? '');
  const primo = useRef(true);
  useEffect(() => {
    if (primo.current) { primo.current = false; return; }
    const t = setTimeout(() => imposta({ q: q.trim() || null }), 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const fase = sp.get('fase') ?? '';
  const pulsante = sp.get('pulsante') === '1';
  const problemi = sp.get('problemi') === '1';
  const ids = sp.get('ids');
  const lista = dati?.lista;
  const pagine = lista ? Math.max(1, Math.ceil(lista.totale / lista.perPagina)) : 1;

  return (
    <>
      <div className="shrink-0 space-y-2 border-b border-[var(--lm-line)] px-3 py-2.5">
        <label className="relative block">
          <span className="sr-only">Cerca per nome o telefono</span>
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-[var(--lm-muted)]" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cerca nome o telefono…"
            className="h-8 w-full rounded-md border border-[var(--lm-line)] bg-[var(--lm-bg)] pl-7 pr-2 text-[13px] placeholder:text-[var(--lm-muted)]"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="sr-only" htmlFor="lm-fase">Fase</label>
          <select
            id="lm-fase"
            value={fase}
            onChange={(e) => imposta({ fase: e.target.value || null })}
            className="h-7 rounded-md border border-[var(--lm-line)] bg-[var(--lm-bg)] px-1.5 text-[12px]"
          >
            <option value="">Tutte le fasi</option>
            {LANCIO_FASI.map((f) => (
              <option key={f} value={f}>{ETICHETTA_FASE[f]}{dati ? ` (${fmtNum.format(dati.contatori.perFase[f] ?? 0)})` : ''}</option>
            ))}
            <option value="congedo">Congedati</option>
            <option value="fuori_lancio">Fuori dal lancio (pulsante senza guida)</option>
          </select>
          <Interruttore attivo={pulsante} onClick={() => imposta({ pulsante: pulsante ? null : '1' })}>Ha premuto il pulsante</Interruttore>
          <Interruttore attivo={problemi} onClick={() => imposta({ problemi: problemi ? null : '1' })}>Errori di consegna</Interruttore>
        </div>
        {ids && (
          <div className="flex items-center gap-2 rounded-md bg-[var(--lm-hover)] px-2 py-1 text-[12px]">
            <span className="min-w-0 truncate">Chat dell’avviso: {sp.get('avviso') ?? 'selezione'}</span>
            <button type="button" onClick={() => imposta({ ids: null, avviso: null })} className="ml-auto inline-flex items-center gap-1 font-medium text-[var(--lm-muted)] hover:text-[var(--lm-fg)]">
              <X className="size-3.5" aria-hidden /> Togli
            </button>
          </div>
        )}
        {lista && (
          <p className="text-[12px] text-[var(--lm-muted)] tabular-nums">
            {lista.totale === 0 ? 'Nessuna chat' : `${fmtNum.format(lista.totale)} chat`}
            {pagine > 1 && `, pagina ${lista.pagina} di ${pagine}`}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!dati ? <Scheletro righe={10} /> : lista!.righe.length === 0 ? (
          <Vuoto
            titolo="Nessuna chat con questi filtri"
            testo={q || fase || pulsante || problemi || ids ? 'Togli un filtro o cambia la ricerca.' : 'Le chat del lancio compaiono qui appena un iscritto entra.'}
          />
        ) : (
          <ul className="lm-rows">
            {lista!.righe.map((r) => <RigaChat key={r.id} r={r} aperta={r.id === chatAperta} onApri={() => imposta({ chat: String(r.id) }, false)} />)}
          </ul>
        )}
      </div>

      {lista && pagine > 1 && (
        <div className="flex shrink-0 items-center justify-between border-t border-[var(--lm-line)] px-3 py-1.5 text-[12px]">
          <button type="button" disabled={lista.pagina <= 1} onClick={() => imposta({ pagina: String(lista.pagina - 1) }, false)} className="rounded-md px-2 py-0.5 font-medium hover:bg-[var(--lm-hover)] disabled:opacity-40">Precedenti</button>
          <span className="tabular-nums text-[var(--lm-muted)]">{lista.pagina} / {pagine}</span>
          <button type="button" disabled={lista.pagina >= pagine} onClick={() => imposta({ pagina: String(lista.pagina + 1) }, false)} className="rounded-md px-2 py-0.5 font-medium hover:bg-[var(--lm-hover)] disabled:opacity-40">Successive</button>
        </div>
      )}
    </>
  );
}

function Interruttore({ attivo, onClick, children }: { attivo: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={attivo}
      onClick={onClick}
      className={cn('h-7 rounded-md border px-2 text-[12px] font-medium',
        attivo ? 'border-[var(--lm-accent)] bg-[var(--lm-sel)] text-[var(--lm-fg)]' : 'border-[var(--lm-line)] text-[var(--lm-muted)] hover:bg-[var(--lm-hover)]')}
    >
      {children}
    </button>
  );
}

function StatoConsegna({ stato, codice, compatto }: { stato: string | null; codice: number | null; compatto?: boolean }) {
  const ko = eFallito(stato);
  const ok = eConsegnato(stato);
  return (
    <span className={cn('whitespace-nowrap text-[12px] tabular-nums',
      ko ? 'font-medium text-[var(--lm-red)]' : ok ? 'text-[var(--lm-green)]' : 'text-[var(--lm-muted)]')}
    >
      {statoConsegnaLeggibile(stato)}{codice ? `${compatto ? ' ' : ', errore '}${codice}` : ''}
    </span>
  );
}

function RigaChat({ r, aperta, onApri }: { r: Riga; aperta: boolean; onApri: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onApri}
        aria-current={aperta ? 'true' : undefined}
        className={cn('grid w-full grid-cols-[1fr_auto] gap-x-3 border-b border-[var(--lm-line)] px-3 py-2 text-left',
          aperta ? 'bg-[var(--lm-sel)] shadow-[inset_2px_0_0_var(--lm-accent)]' : 'hover:bg-[var(--lm-hover)]')}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium">{r.nome ?? 'Senza nome'}</span>
          <span className="shrink-0 font-mono text-[11px] text-[var(--lm-muted)]">{r.telefono ?? ''}</span>
        </span>
        <span className="text-right text-[12px] text-[var(--lm-muted)] tabular-nums">{quando(r.lastMessageAt)}</span>
        <span className="min-w-0 truncate text-[12px] text-[var(--lm-muted)]">
          {r.anteprima ? <>{r.ultimoDelLead ? '' : 'Bot: '}{r.anteprima}</> : <span className="italic">nessun messaggio</span>}
        </span>
        <span className="text-right">
          {r.ultimoBot ? <StatoConsegna stato={r.ultimoBot.stato} codice={r.ultimoBot.codice} compatto /> : null}
        </span>
        <span className="col-span-2 mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--lm-muted)]">
          <span className="font-medium text-[var(--lm-fg)]">{faseLeggibile(r)}</span>
          {r.pulsante && <span>premuto il pulsante</span>}
          {r.congedoAt && <span>congedato</span>}
          {r.problemi && <span className="font-medium text-[var(--lm-red)]">errori di consegna</span>}
          {r.ultimoDelLead && r.fase === 'post_pitch' && <span className="font-medium text-[var(--lm-amber)]">attende risposta</span>}
        </span>
      </button>
    </li>
  );
}

// ─────────────────────────── dettaglio ───────────────────────────

type Voce = { t: number; tipo: 'msg'; m: Messaggio } | { t: number; tipo: 'ev'; e: EventoMonitor };

function DettaglioChat({ id, onChiudi }: { id: number; onChiudi: () => void }) {
  const [d, setD] = useState<Dettaglio | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [eventi, setEventi] = useState(true);
  const fondo = useRef<HTMLDivElement | null>(null);
  const primaVolta = useRef(true);

  useEffect(() => {
    let vivo = true;
    const leggi = async () => {
      try {
        const r = await fetch(`/api/fenice/lancio-monitor/chat/${id}`, { cache: 'no-store' });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string; dettaglio?: string } | null;
          throw new Error(r.status === 404 ? 'chat non trovata' : j?.dettaglio ?? j?.error ?? `HTTP ${r.status}`);
        }
        const j = (await r.json()) as Dettaglio;
        if (vivo) { setD(j); setErrore(null); }
      } catch (e) {
        if (vivo) setErrore((e as Error).message);
      }
    };
    leggi();
    const t = setInterval(() => { if (document.visibilityState === 'visible') leggi(); }, REFRESH_MS);
    return () => { vivo = false; clearInterval(t); };
  }, [id]);

  useEffect(() => {
    if (d && primaVolta.current) { primaVolta.current = false; fondo.current?.scrollIntoView({ block: 'end' }); }
  }, [d]);

  const voci = useMemo<Voce[]>(() => {
    if (!d) return [];
    const v: Voce[] = d.messaggi.map((m) => ({ t: Date.parse(m.created_at), tipo: 'msg' as const, m }));
    if (eventi) for (const e of d.eventi) v.push({ t: Date.parse(e.created_at), tipo: 'ev', e });
    return v.sort((a, b) => a.t - b.t);
  }, [d, eventi]);

  const c = d?.chat;
  return (
    <>
      <div className="shrink-0 border-b border-[var(--lm-line)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onChiudi} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-[var(--lm-muted)] hover:bg-[var(--lm-hover)] md:hidden">
            <ArrowLeft className="size-3.5" aria-hidden /> Lista
          </button>
          <h2 className="min-w-0 truncate text-[14px] font-semibold">{c ? c.nome ?? 'Senza nome' : 'Chat'}</h2>
          {c?.telefono && <span className="font-mono text-[12px] text-[var(--lm-muted)]">{c.telefono}</span>}
          <span className="font-mono text-[11px] text-[var(--lm-muted)]">conv {id}</span>
          <label className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-[var(--lm-muted)]">
            <input type="checkbox" checked={eventi} onChange={(e) => setEventi(e.target.checked)} className="accent-[var(--lm-accent)]" />
            Eventi del lancio
          </label>
          <button type="button" onClick={onChiudi} aria-label="Chiudi la chat" className="hidden rounded-md p-1 text-[var(--lm-muted)] hover:bg-[var(--lm-hover)] md:inline-flex">
            <X className="size-4" />
          </button>
        </div>
        {c && (
          <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px] sm:grid-cols-3 xl:grid-cols-6">
            <Dato k="Fase" v={faseLeggibile(c)} />
            <Dato k="Ingresso" v={c.ingresso === 'pulsante_webinar' ? 'pulsante del webinar' : c.ingresso ?? '—'} />
            <Dato k="Benvenuto" v={quando(c.benvenutoAt) || '—'} />
            <Dato k="Link Zoom" v={quando(c.linkAt) || '—'} />
            <Dato k="Messaggio 21" v={d?.colonnaInizio === false ? 'n/d' : quando(c.inizioAt) || '—'} />
            <Dato k="Congedo" v={quando(c.congedoAt) || '—'} />
          </dl>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {errore && (
          <p role="alert" className="mb-3 rounded-md bg-[var(--lm-red-bg)] px-2.5 py-1.5 text-[12px] text-[var(--lm-red)]">
            Lettura della chat non riuscita: {errore}. Riprovo fra 30 secondi.
          </p>
        )}
        {!d && !errore && <Scheletro righe={6} alta />}
        {d && voci.length === 0 && <Vuoto titolo="Chat vuota" testo="Nessun messaggio e nessun evento del lancio su questa chat." />}
        <ol className="space-y-1.5">
          {voci.map((v, i) => {
            const giorno = giornoKey.format(new Date(v.t));
            const nuovoGiorno = i === 0 || giornoKey.format(new Date(voci[i - 1].t)) !== giorno;
            return (
              <li key={`${v.tipo}${v.tipo === 'msg' ? v.m.id : v.e.id}`}>
                {nuovoGiorno && <div className="my-2 text-center text-[11px] font-medium text-[var(--lm-muted)]">{fmtGiorno.format(new Date(v.t))}</div>}
                {v.tipo === 'msg' ? <Bolla m={v.m} /> : <RigaEvento e={v.e} />}
              </li>
            );
          })}
        </ol>
        <div ref={fondo} />
      </div>
    </>
  );
}

function Dato({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex min-w-0 gap-1.5">
      <dt className="shrink-0 text-[var(--lm-muted)]">{k}</dt>
      <dd className="min-w-0 truncate tabular-nums">{v}</dd>
    </div>
  );
}

function Bolla({ m }: { m: Messaggio }) {
  const out = m.direction === 'out';
  return (
    <div className={cn('flex', out ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[min(65ch,85%)] rounded-lg px-3 py-1.5', out ? 'bg-[var(--lm-bubble-out)]' : 'bg-[var(--lm-bubble-in)]')}>
        {m.is_template || m.template_sid ? (
          <div className="mb-0.5 text-[11px] font-medium text-[var(--lm-muted)]">
            Template: {m.templateNome ?? <span className="font-mono">{m.template_sid ?? 'senza SID'}</span>}
          </div>
        ) : out && m.sender ? (
          <div className="mb-0.5 text-[11px] text-[var(--lm-muted)]">{m.sender}</div>
        ) : null}
        <p className="whitespace-pre-wrap break-words leading-snug">{m.body || <span className="italic text-[var(--lm-muted)]">senza testo</span>}</p>
        <div className="mt-0.5 flex justify-end gap-2 text-[11px] text-[var(--lm-muted)]">
          <span className="tabular-nums">{fmtOra.format(new Date(m.created_at))}</span>
          {out && <StatoConsegna stato={m.twilio_status} codice={m.twilio_error_code} />}
        </div>
      </div>
    </div>
  );
}

function RigaEvento({ e }: { e: EventoMonitor }) {
  const grave = e.level === 'error' || e.level === 'warn';
  const testo = (e.message ?? '').replace(/^\[[^\]]+\]\s*/, '');
  return (
    <div className="flex gap-2 py-0.5 text-[12px] text-[var(--lm-muted)]">
      <span className="shrink-0 tabular-nums">{fmtOra.format(new Date(e.created_at))}</span>
      <span className={cn('shrink-0 font-mono text-[11px] leading-[18px]', grave && (e.level === 'error' ? 'text-[var(--lm-red)]' : 'text-[var(--lm-amber)]'))}>{e.type}</span>
      <span className="min-w-0 break-words">{testo}</span>
    </div>
  );
}

// ─────────────────────────── stati ───────────────────────────

function Vuoto({ titolo, testo }: { titolo: string; testo: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-10">
      <div className="max-w-xs text-center">
        <p className="font-medium">{titolo}</p>
        <p className="mt-1 text-[12px] leading-snug text-[var(--lm-muted)]">{testo}</p>
      </div>
    </div>
  );
}

function Scheletro({ righe, alta }: { righe: number; alta?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Caricamento" className="divide-y divide-[var(--lm-line)]">
      {Array.from({ length: righe }, (_, i) => (
        <div key={i} className={cn('space-y-1.5 px-3', alta ? 'py-4' : 'py-2.5')}>
          <div className="h-3 w-2/5 rounded bg-[var(--lm-hover)]" />
          <div className="h-2.5 w-4/5 rounded bg-[var(--lm-hover)]" />
        </div>
      ))}
    </div>
  );
}
