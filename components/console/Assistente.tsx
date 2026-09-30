'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bell, ChevronDown, ChevronRight, FileText, MessagesSquare, PenLine, RotateCcw, SquareTerminal, X } from 'lucide-react';
import type { Citazione } from '@/lib/console/assistente-tools';
import { FlussoAzione } from './FlussoAzione';
import { segnalaChatCambiata, useComposerBridge } from './ComposerBridge';
import { contenitoreConsole } from './ui/portale';
import { Button } from './ui/Button';
import { Kbd } from './ui/Kbd';
import { toast } from './ui/toast';
import { useAvvisi } from './useAvvisi';
import { rinfrescaConteggi, useConteggi } from './useConteggi';
import { useRegia } from './RegiaProvider';
import { domandeSuggerite, useAssistente, type BozzaAssistente, type ConversazioneAssistente, type Turno } from './useAssistente';

export const PAGINA_ASSISTENTE = '/console/assistente';

type ContestoAssistente = {
  aperto: boolean;
  /** Apre il pannello (sulla pagina dell'Assistente resta la pagina). `domanda` precompila il campo;
   *  con `invia: true` parte subito (la palette, dove l'admin l'ha già scritta). */
  apri: (domanda?: string, opz?: { invia?: boolean }) => void;
  chiudi: () => void;
  conversazione: ConversazioneAssistente;
  domanda: string;
  setDomanda: (d: string) => void;
};

const Ctx = createContext<ContestoAssistente | null>(null);

/** Una sola conversazione per la console: il pannello laterale e la pagina `/console/assistente`
 *  mostrano la stessa, così passare dall'uno all'altra non la perde. */
export function AssistenteProvider({ children }: { children: ReactNode }) {
  const conversazione = useAssistente();
  const [aperto, setAperto] = useState(false);
  const [domanda, setDomanda] = useState('');
  const pathname = usePathname();
  const { invia } = conversazione;

  const apri = useCallback(
    (d?: string, opz?: { invia?: boolean }) => {
      if (pathname !== PAGINA_ASSISTENTE) setAperto(true);
      if (d === undefined) return;
      if (opz?.invia) {
        invia(d);
        setDomanda('');
      } else {
        setDomanda(d);
      }
    },
    [pathname, invia],
  );
  const chiudi = useCallback(() => setAperto(false), []);

  const valore = useMemo(
    () => ({ aperto, apri, chiudi, conversazione, domanda, setDomanda }),
    [aperto, apri, chiudi, conversazione, domanda],
  );
  return <Ctx.Provider value={valore}>{children}</Ctx.Provider>;
}

const SENZA_PROVIDER: Pick<ContestoAssistente, 'apri' | 'chiudi'> = { apri: () => {}, chiudi: () => {} };

/** `apri(domanda?)` e `chiudi()` per i bottoni "Chiedi all'Assistente…". Fuori dal provider non fanno niente. */
export function useApriAssistente(): Pick<ContestoAssistente, 'apri' | 'chiudi'> {
  const c = useContext(Ctx);
  return c ? { apri: c.apri, chiudi: c.chiudi } : SENZA_PROVIDER;
}

// ─────────── pezzi del turno ───────────

function Passi({ turno }: { turno: Turno }) {
  const [aperti, setAperti] = useState(true);
  if (turno.passi.length === 0) return null;
  const n = turno.passi.length;
  return (
    <div className="as-passi">
      <button type="button" className="as-passi-t" aria-expanded={aperti} onClick={() => setAperti((a) => !a)}>
        {aperti ? (
          <ChevronDown size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        ) : (
          <ChevronRight size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        )}
        {n === 1 ? '1 lettura' : `${n} letture`}
      </button>
      {aperti && (
        <ul>
          {turno.passi.map((p, i) => (
            <li key={i} className="tool">
              <FileText size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
              <span className="tool-s">{p.sintesi}</span>
              <span className="mono r">{p.nome}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function hrefCitazione(c: Citazione): string {
  return c.tipo === 'chat' ? `/console?chat=${encodeURIComponent(String(c.id))}` : `/console/avvisi#${encodeURIComponent(String(c.id))}`;
}

function Fonti({ citazioni, onVai }: { citazioni: Citazione[]; onVai: () => void }) {
  if (citazioni.length === 0) return null;
  return (
    <div className="srcs" aria-label="Fonti">
      {citazioni.map((c, i) => {
        const Icona = c.tipo === 'chat' ? MessagesSquare : Bell;
        return (
          <Link key={`${c.tipo}:${c.id}`} className="src" href={hrefCitazione(c)} onClick={onVai}>
            <span className="cite">{i + 1}</span>
            <span className="src-t">
              <Icona size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
              <span className="src-e">{c.etichetta}</span>
            </span>
            <span className="mono">{c.tipo === 'chat' ? `chat ${c.id}` : String(c.id)}</span>
          </Link>
        );
      })}
    </div>
  );
}

function Bozza({ b, onMessa }: { b: BozzaAssistente; onMessa: () => void }) {
  const composer = useComposerBridge();
  const aperta = composer?.conversationId === b.conversationId;

  function metti() {
    if (!composer || !aperta) return;
    composer.impostaBozza(b.testo);
    toast.ok('Bozza nel composer: rileggila e inviala tu.');
    onMessa();
  }

  return (
    <div className="as-bozza">
      <div className="as-bozza-t">
        <PenLine size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        Bozza per la chat <span className="mono">{b.conversationId}</span>
      </div>
      <p className="as-bozza-testo">{b.testo}</p>
      <div className="as-bozza-act">
        {aperta ? (
          composer.inPausa ? (
            <Button onClick={metti}>Metti nel composer</Button>
          ) : (
            <span className="muted">Mario è attivo su questa chat: mettilo in pausa per usare la bozza.</span>
          )
        ) : (
          <Link className="btn ghost" href={`/console?chat=${b.conversationId}`}>
            Apri la chat {b.conversationId}…
          </Link>
        )}
      </div>
    </div>
  );
}

function Risposta({ testo }: { testo: string }) {
  const paragrafi = testo.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragrafi.length === 0) return null;
  return (
    <div className="ans">
      {paragrafi.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

function VistaTurno({ turno, ultimo, conv, onVai }: { turno: Turno; ultimo: boolean; conv: ConversazioneAssistente; onVai: () => void }) {
  return (
    <article className="as-turno" aria-busy={!turno.finito || undefined}>
      <div className="as-q">
        <SquareTerminal size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        <p>{turno.domanda}</p>
      </div>
      <Passi turno={turno} />
      {!turno.finito && <p className="as-lavoro" aria-live="polite">Sto leggendo…</p>}
      <Risposta testo={turno.testo} />
      <Fonti citazioni={turno.citazioni} onVai={onVai} />
      {turno.proposte.map((p, i) => (
        <div key={i} className="propose">
          <FlussoAzione
            rif={p}
            onEseguita={() => {
              rinfrescaConteggi();
              segnalaChatCambiata();
            }}
          />
        </div>
      ))}
      {turno.bozze.map((b, i) => (
        <Bozza key={i} b={b} onMessa={onVai} />
      ))}
      {turno.errore && (
        <div className="as-err" role="alert">
          <p>{turno.errore}</p>
          {ultimo && (
            <Button onClick={conv.riprova} disabled={conv.inCorso}>
              <RotateCcw size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
              Riprova
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

function Suggerimenti({ onScegli }: { onScegli: (d: string) => void }) {
  const { conteggi } = useConteggi();
  const { dati } = useAvvisi();
  const { regia } = useRegia();
  const primo = dati?.find((a) => a.gravita !== 'info') ?? dati?.[0] ?? null;
  const domande = domandeSuggerite({
    conteggi,
    avviso: primo ? { titolo: primo.titolo } : null,
    lancioAttivo: !!regia?.attivo,
  });
  return (
    <div className="as-vuoto">
      <p className="as-vuoto-t">Chiedi cosa sta succedendo: l&apos;Assistente legge chat, eventi e avvisi, e ti dice da dove l&apos;ha preso.</p>
      <ul>
        {domande.map((d) => (
          <li key={d}>
            <button type="button" className="as-sugg" onClick={() => onScegli(d)}>
              {d}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted">Non esegue niente da solo: propone, e sei tu a provare e confermare.</p>
    </div>
  );
}

// ─────────── corpo (pannello e pagina) ───────────

/** Il contenuto dell'Assistente: i turni come un terminale (domanda in cima, letture, risposta,
 *  fonti, proposte e bozze) e il campo della domanda in fondo. `onVai` chiude il pannello quando
 *  un link porta altrove. */
export function CorpoAssistente({ onVai, nelPannello = false }: { onVai?: () => void; nelPannello?: boolean }) {
  const c = useContext(Ctx);
  const campo = useRef<HTMLTextAreaElement>(null);
  const lista = useRef<HTMLDivElement>(null);
  const ultimo = c?.conversazione.messaggi.at(-1);

  useEffect(() => {
    campo.current?.focus();
  }, []);
  // Segue il turno in corso man mano che arrivano letture e risposta.
  useEffect(() => {
    const el = lista.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ultimo]);

  if (!c) return null;
  const { conversazione: conv, domanda, setDomanda } = c;
  const vai = onVai ?? (() => {});

  function manda(testo: string) {
    if (conv.inCorso || testo.trim() === '') return;
    conv.invia(testo);
    setDomanda('');
  }

  return (
    <div className="as-corpo">
      <div className="as-turni" ref={lista}>
        {conv.messaggi.length === 0 ? (
          <Suggerimenti onScegli={manda} />
        ) : (
          conv.messaggi.map((t, i) => (
            <VistaTurno key={t.id} turno={t} ultimo={i === conv.messaggi.length - 1} conv={conv} onVai={vai} />
          ))
        )}
      </div>
      <form
        className="as-in"
        onSubmit={(e) => {
          e.preventDefault();
          manda(domanda);
        }}
      >
        <textarea
          ref={campo}
          value={domanda}
          rows={2}
          maxLength={4000}
          aria-label="Domanda all'Assistente"
          placeholder={conv.inCorso ? 'Sto leggendo…' : "Chiedi all'Assistente. Invio chiede, Maiusc+Invio va a capo."}
          onChange={(e) => setDomanda(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              manda(domanda);
            }
          }}
        />
        <div className="pl-foot">
          <span><Kbd>Invio</Kbd>chiedi</span>
          {!nelPannello && <span><Kbd>Maiusc Invio</Kbd>a capo</span>}
          {nelPannello && <span><Kbd>Esc</Kbd>chiudi</span>}
          <span className="sp" />
          {conv.messaggi.length > 0 && (
            <Button variante="fantasma" onClick={conv.ricomincia}>
              Ricomincia
            </Button>
          )}
          <Button type="submit" variante="primario" caricamento={conv.inCorso} disabled={domanda.trim() === ''}>
            Chiedi
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Il pannello laterale (440 px) dell'Assistente, fuori dalla sua pagina. Nessuna animazione di
 *  apertura; Esc chiude. */
export function PannelloAssistente() {
  const c = useContext(Ctx);
  const pathname = usePathname();
  const lasciaFocus = useRef(false);
  if (!c || pathname === PAGINA_ASSISTENTE) return null;

  const vai = () => {
    // Link o bozza: il focus va dove l'admin sta andando, non torna al bottone che ha aperto.
    lasciaFocus.current = true;
    c.chiudi();
  };

  return (
    <RadixDialog.Root open={c.aperto} onOpenChange={(o) => (o ? c.apri() : c.chiudi())}>
      <RadixDialog.Portal container={contenitoreConsole()}>
        <RadixDialog.Overlay className="overlay as-overlay" />
        <RadixDialog.Content
          className="sheet as-sheet"
          onCloseAutoFocus={(e) => {
            if (lasciaFocus.current) e.preventDefault();
            lasciaFocus.current = false;
          }}
        >
          <div className="sheet-hd">
            <SquareTerminal size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            <RadixDialog.Title className="dialog-title">Assistente</RadixDialog.Title>
            <Link className="btn ghost" href={PAGINA_ASSISTENTE} onClick={vai}>
              A tutta pagina
            </Link>
            <RadixDialog.Close className="iconbtn" aria-label="Chiudi l'Assistente">
              <X size={16} strokeWidth={1.75} />
            </RadixDialog.Close>
          </div>
          <RadixDialog.Description className="sr-only">
            Domande sullo stato della console. L&apos;Assistente legge e propone, non esegue.
          </RadixDialog.Description>
          <CorpoAssistente onVai={vai} nelPannello />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** La pagina `/console/assistente`: lo stesso corpo del pannello, a tutta pagina. */
export function PaginaAssistente() {
  return (
    <section className="as-pagina" aria-labelledby="as-pagina-t">
      <div className="ch">
        <SquareTerminal size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        <h1 id="as-pagina-t">Assistente</h1>
        <span className="muted">Legge chat, eventi e avvisi. Propone, non esegue.</span>
      </div>
      <CorpoAssistente />
    </section>
  );
}
