'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, MessagesSquare, Pause, Play, SquareTerminal } from 'lucide-react';
import type { AzioneRef } from '@/lib/console/avvisi';
import type { RigaLista } from '@/lib/console/viste-db';
import { VISTA_META, type Vista } from '@/lib/console/viste';
import { formattaTelefono } from '@/lib/console/riga';
import { FlussoAzione } from './FlussoAzione';
import { useApriAssistente } from './Assistente';
import { segnalaChatCambiata, useComposerBridge } from './ComposerBridge';
import { GRUPPI, ICONA_VISTA, SISTEMA } from './Nav';
import { useStatoConsole } from './statoUrl';
import { rinfrescaConteggi } from './useConteggi';
import { contenitoreConsole } from './ui/portale';
import { Button } from './ui/Button';
import { Kbd } from './ui/Kbd';

const ATTESA_RICERCA = 250;
const MIN_RICERCA = 2;

type Ricerca = { stato: 'corta' } | { stato: 'cerco' } | { stato: 'errore' } | { stato: 'ok'; righe: RigaLista[] };

/** Ricerca chat con `GET /api/console/cerca`, 250 ms dopo l'ultimo tasto. Il risultato vale solo
 *  per il testo con cui è stato chiesto: se il testo è cambiato, si mostra "Cerco…". */
function useRicercaChat(testo: string): Ricerca {
  const q = testo.trim();
  const [ultimo, setUltimo] = useState<{ q: string; righe: RigaLista[] | null }>({ q: '', righe: null });

  useEffect(() => {
    if (q.length < MIN_RICERCA) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/console/cerca?q=${encodeURIComponent(q)}`, { cache: 'no-store', signal: ac.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ righe?: RigaLista[] }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(
          (j) => setUltimo({ q, righe: j.righe ?? [] }),
          (e: Error) => {
            if (e.name !== 'AbortError') setUltimo({ q, righe: null });
          },
        );
    }, ATTESA_RICERCA);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  if (q.length < MIN_RICERCA) return { stato: 'corta' };
  if (ultimo.q !== q) return { stato: 'cerco' };
  return ultimo.righe ? { stato: 'ok', righe: ultimo.righe } : { stato: 'errore' };
}

/** cmdk prende Invio sulla radice per selezionare la voce: dentro la prova di un'azione Invio
 *  deve restare ai bottoni. */
const tieniInvio = (e: KeyboardEvent) => {
  if (e.key === 'Enter') e.stopPropagation();
};

interface PaletteProps {
  aperto: boolean;
  onCambia: (aperto: boolean) => void;
}

/**
 * Palette Ctrl+K (cmdk, 560 px, senza animazione d'apertura): vai a una vista o pagina, cerca una
 * chat, metti in pausa o ridai a Mario la chat aperta (sempre con prova a vuoto e conferma), chiedi
 * all'Assistente il testo digitato.
 */
export function Palette({ aperto, onCambia }: PaletteProps) {
  const [cerca, setCerca] = useState('');
  const [azione, setAzione] = useState<AzioneRef | null>(null);
  const ricerca = useRicercaChat(cerca);
  const router = useRouter();
  const pathname = usePathname();
  const [, setStato] = useStatoConsole();
  const composer = useComposerBridge();
  const { apri: apriAssistente } = useApriAssistente();
  const testo = cerca.trim();

  function cambia(o: boolean) {
    if (!o) {
      setCerca('');
      setAzione(null);
    }
    onCambia(o);
  }

  function vaiVista(v: Vista) {
    cambia(false);
    if (pathname === '/console') void setStato({ vista: v, fase: null, q: null, solo: null });
    else router.push(`/console?vista=${v}`);
  }

  function vaiPagina(href: string) {
    cambia(false);
    router.push(href);
  }

  function vaiChat(id: number) {
    cambia(false);
    if (pathname === '/console') void setStato({ chat: id });
    else router.push(`/console?chat=${id}`);
  }

  function chiedi() {
    cambia(false);
    if (testo) apriAssistente(testo, { invia: true });
    else apriAssistente();
  }

  const viste = GRUPPI.flatMap((g) => g.viste);
  const gruppoAssistente = (
    <Command.Group heading="Assistente" forceMount>
      <Command.Item value={`__assistente ${testo}`} forceMount onSelect={chiedi}>
        <SquareTerminal size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        <span className="pal-t">{testo ? `Chiedi all'Assistente: ${testo}` : "Apri l'Assistente…"}</span>
      </Command.Item>
    </Command.Group>
  );

  return (
    <Command.Dialog
      open={aperto}
      onOpenChange={cambia}
      label="Palette dei comandi"
      container={contenitoreConsole()}
      overlayClassName="pal-overlay"
      contentClassName="pal"
      shouldFilter={azione === null}
      loop
    >
      <RadixDialog.Title className="sr-only">Palette dei comandi</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">
        Vai a una vista, cerca una chat, agisci sulla chat aperta o chiedi all&apos;Assistente.
      </RadixDialog.Description>

      {azione ? (
        <div className="pal-azione" onKeyDown={tieniInvio}>
          <div className="pal-azione-hd">
            <Button variante="fantasma" onClick={() => setAzione(null)}>
              <ArrowLeft size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
              Indietro
            </Button>
            <span className="muted">
              Chat <span className="mono">{String(azione.params.conversationId)}</span>
            </span>
          </div>
          <FlussoAzione
            rif={azione}
            onEseguita={() => {
              rinfrescaConteggi();
              segnalaChatCambiata();
            }}
          />
        </div>
      ) : (
        <>
          <div className="pal-in">
            <Command.Input value={cerca} onValueChange={setCerca} placeholder="Vai a, cerca una chat o chiedi all'Assistente…" />
            <Kbd>Esc</Kbd>
          </div>
          <Command.List className="pal-list">
            <Command.Empty className="pal-vuoto">Nessuna voce con questo testo.</Command.Empty>

            <Command.Group heading="Vai a">
              {viste.map((v) => {
                const Icona = ICONA_VISTA[v];
                return (
                  <Command.Item key={v} value={`vista ${VISTA_META[v].etichetta}`} onSelect={() => vaiVista(v)}>
                    <Icona size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
                    <span className="pal-t">{VISTA_META[v].etichetta}</span>
                  </Command.Item>
                );
              })}
              {SISTEMA.map((s) => {
                const Icona = s.icona;
                return (
                  <Command.Item key={s.href} value={`pagina ${s.etichetta}`} onSelect={() => vaiPagina(s.href)}>
                    <Icona size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
                    <span className="pal-t">{s.etichetta}</span>
                  </Command.Item>
                );
              })}
            </Command.Group>

            {composer && (
              <Command.Group heading="Azioni sulla chat aperta">
                {composer.inPausa ? (
                  <Command.Item
                    value="azione ridai la chat a Mario riprendi"
                    onSelect={() =>
                      setAzione({ azione: 'riprendi_mario', params: { conversationId: composer.conversationId }, etichetta: 'Ridai la chat a Mario' })
                    }
                  >
                    <Play size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
                    <span className="pal-t">Ridai la chat a Mario…</span>
                    <span className="mono muted">{composer.conversationId}</span>
                  </Command.Item>
                ) : (
                  <Command.Item
                    value="azione metti in pausa Mario"
                    onSelect={() =>
                      setAzione({ azione: 'pausa_mario', params: { conversationId: composer.conversationId }, etichetta: 'Metti in pausa Mario' })
                    }
                  >
                    <Pause size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
                    <span className="pal-t">Metti in pausa Mario…</span>
                    <span className="mono muted">{composer.conversationId}</span>
                  </Command.Item>
                )}
              </Command.Group>
            )}
            {/* Dopo le poche voci di navigazione che combaciano: chiedere all'Assistente resta a vista,
                sopra le dieci chat trovate. */}
            {gruppoAssistente}

            {testo.length >= MIN_RICERCA && (
              <Command.Group heading="Chat" forceMount>
                {ricerca.stato === 'cerco' && (
                  <Command.Item value={`__cerco ${testo}`} forceMount disabled className="pal-nota">
                    Cerco…
                  </Command.Item>
                )}
                {ricerca.stato === 'errore' && (
                  <Command.Item value={`__errore ${testo}`} forceMount disabled className="pal-nota">
                    Ricerca non riuscita: riscrivi per riprovare.
                  </Command.Item>
                )}
                {ricerca.stato === 'ok' && ricerca.righe.length === 0 && (
                  <Command.Item value={`__nessuna ${testo}`} forceMount disabled className="pal-nota">
                    Nessuna chat per &quot;{testo}&quot;.
                  </Command.Item>
                )}
                {ricerca.stato === 'ok' &&
                  ricerca.righe.map((r) => (
                    <Command.Item key={r.id} value={`chat ${r.id} ${testo}`} forceMount onSelect={() => vaiChat(r.id)}>
                      <MessagesSquare size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
                      <span className="pal-t">{r.nome ?? 'Senza nome'}</span>
                      {r.telefono && <span className="mono muted">{formattaTelefono(r.telefono)}</span>}
                    </Command.Item>
                  ))}
              </Command.Group>
            )}
          </Command.List>
        </>
      )}

      <div className="pl-foot">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd>scorri</span>
        <span><Kbd>Invio</Kbd>apri</span>
        <span><Kbd>Esc</Kbd>chiudi</span>
      </div>
    </Command.Dialog>
  );
}
