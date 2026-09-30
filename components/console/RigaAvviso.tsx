'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CircleCheck, Info, MessagesSquare, OctagonAlert, SquareTerminal, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Gravita } from '@/lib/lancio-monitor';
import type { AvvisoConsole } from '@/lib/console/avvisi';
import { dataOraBreve } from '@/lib/console/thread';
import { FlussoAzione } from './FlussoAzione';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Sheet } from './ui/Sheet';
import { toast } from './ui/toast';
import { useApriAssistente } from './Assistente';

/** Parola, classe e icona di ogni gravità: lo stato non passa mai dal solo colore. */
export const GRAVITA: Record<Gravita, { parola: string; classe: string; icona: LucideIcon }> = {
  critico: { parola: 'Critico', classe: 'crit', icona: OctagonAlert },
  attenzione: { parola: 'Attenzione', classe: 'warn', icona: TriangleAlert },
  info: { parola: 'Info', classe: 'info', icona: Info },
};

/** Oltre queste, le azioni di un avviso (fino a 20 rinvii, uno per chat) restano dietro un bottone. */
const AZIONI_VISIBILI = 3;

function Occorrenze({ a }: { a: AvvisoConsole }) {
  const prima = dataOraBreve(a.primoAt);
  const ultima = dataOraBreve(a.ultimoAt);
  if (!prima && !ultima) return null;
  return (
    <p className="avv-quando">
      {prima && prima !== ultima && (
        <>
          prima <span className="mono">{prima}</span>
          {ultima ? ', ' : null}
        </>
      )}
      {ultima && (
        <>
          ultima <span className="mono">{ultima}</span>
        </>
      )}
    </p>
  );
}

function VediChat({ chat }: { chat: number[] }) {
  const [aperto, setAperto] = useState(false);
  if (chat.length === 0) return null;
  if (chat.length === 1) {
    return (
      <Link className="btn ghost" href={`/console?chat=${chat[0]}`}>
        <MessagesSquare size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        Vedi 1 chat
      </Link>
    );
  }
  return (
    <>
      <Button variante="fantasma" onClick={() => setAperto(true)}>
        <MessagesSquare size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        Vedi {chat.length} chat…
      </Button>
      <Sheet aperto={aperto} onCambia={setAperto} titolo={`Chat coinvolte (${chat.length})`}>
        <ul className="avv-chat">
          {chat.map((id) => (
            <li key={id}>
              <Link href={`/console?chat=${id}`} onClick={() => setAperto(false)}>
                Chat <span className="mono">{id}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}

function SegnaRisolto({ a, onRisolto }: { a: AvvisoConsole; onRisolto: () => void }) {
  const [aperto, setAperto] = useState(false);
  const [nota, setNota] = useState('');
  const [invio, setInvio] = useState(false);

  async function segna() {
    if (invio) return;
    setInvio(true);
    try {
      const r = await fetch('/api/console/avvisi', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: a.id, firma: a.firma, ...(nota.trim() ? { nota: nota.trim() } : {}) }),
      });
      if (!r.ok) {
        toast.errore(`L'avviso non è stato segnato risolto (HTTP ${r.status}): resta aperto. Riprova.`);
        return;
      }
      toast.ok('Avviso segnato risolto');
      setAperto(false);
      setNota('');
      onRisolto();
    } catch {
      toast.errore("Il server non ha risposto: l'avviso resta aperto. Riprova.");
    } finally {
      setInvio(false);
    }
  }

  return (
    <>
      <Button variante="fantasma" onClick={() => setAperto(true)}>
        <CircleCheck size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
        Segna risolto…
      </Button>
      <Dialog
        aperto={aperto}
        onCambia={setAperto}
        titolo="Segna risolto"
        footer={
          <>
            <Button variante="fantasma" onClick={() => setAperto(false)}>
              Annulla
            </Button>
            <Button variante="primario" caricamento={invio} onClick={() => void segna()}>
              Segna risolto
            </Button>
          </>
        }
      >
        <p className="avv-dlg-t">{a.titolo}</p>
        <p className="avv-dlg-m">L&apos;avviso sparisce finché non arriva un evento nuovo dello stesso tipo.</p>
        <label className="avv-nota">
          <span>Nota (facoltativa)</span>
          <textarea value={nota} maxLength={500} rows={3} onChange={(e) => setNota(e.target.value)} placeholder="Cosa hai fatto, per chi legge dopo" />
        </label>
      </Dialog>
    </>
  );
}

interface RigaAvvisoProps {
  a: AvvisoConsole;
  onCambio: () => void;
}

/** Un avviso nella pagina Avvisi: gravità, testo, occorrenze, chat coinvolte e azioni con prova. */
export function RigaAvviso({ a, onCambio }: RigaAvvisoProps) {
  const [tutte, setTutte] = useState(false);
  const { apri } = useApriAssistente();
  const g = GRAVITA[a.gravita];
  const Icona = g.icona;
  const azioni = tutte ? a.azioni : a.azioni.slice(0, AZIONI_VISIBILI);
  const nascoste = a.azioni.length - AZIONI_VISIBILI;

  return (
    <article id={a.id} className={`avv-riga ${g.classe}`} aria-labelledby={`${a.id}-t`}>
      <div className="avv-corpo">
        <div className="al-top">
          <Icona size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
          {g.parola}
        </div>
        <h3 id={`${a.id}-t`} className="al-t">
          {a.titolo}
        </h3>
        <p className="al-m">{a.significato}</p>
        <p className="avv-fare">{a.cosaFare}</p>
        <Occorrenze a={a} />
      </div>
      <div className="avv-conto">
        <span className="num">{a.conteggio}</span>
        <span className="muted">{a.chat.length > 0 ? 'chat' : a.conteggio === 1 ? 'evento' : 'eventi'}</span>
      </div>

      {a.azioni.length > 0 && (
        <div className="avv-azioni">
          {azioni.map((rif, i) => (
            <FlussoAzione key={`${rif.azione}-${i}`} rif={rif} onEseguita={onCambio} />
          ))}
          {nascoste > 0 && (
            <Button variante="fantasma" className="avv-altre" aria-expanded={tutte} onClick={() => setTutte((t) => !t)}>
              {tutte ? 'Mostra meno' : `Mostra altre ${nascoste} azioni`}
            </Button>
          )}
        </div>
      )}

      <div className="al-act">
        <VediChat chat={a.chat} />
        {a.impostazioni && (
          <Link className="btn ghost" href="/console/impostazioni">
            Apri le impostazioni…
          </Link>
        )}
        <Button
          variante="fantasma"
          onClick={() => apri(`Cosa c'è dietro l'avviso "${a.titolo}" (id ${a.id})? Da cosa parto?`)}
          aria-label={`Chiedi all'Assistente dell'avviso: ${a.titolo}`}
        >
          <SquareTerminal size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
          Chiedi all&apos;Assistente…
        </Button>
        <SegnaRisolto a={a} onRisolto={onCambio} />
      </div>
    </article>
  );
}
