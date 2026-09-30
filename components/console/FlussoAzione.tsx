'use client';

import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FlaskConical, Play, TriangleAlert } from 'lucide-react';
import type { AzioneRef } from '@/lib/console/avvisi';
import type { Anteprima, Esito } from '@/lib/console/azioni';
import { oraRoma } from '@/lib/console/thread';
import { Button } from './ui/Button';
import { toast } from './ui/toast';

type Stato =
  | { fase: 'riposo' }
  | { fase: 'anteprima' }
  | { fase: 'pronta'; a: Anteprima; nota: string | null }
  | { fase: 'esecuzione'; a: Anteprima }
  | { fase: 'esito'; e: Esito }
  | { fase: 'errore'; messaggio: string };

type Corpo409 = { errore?: string; messaggio?: string; dettaglio?: string; nuovaAnteprima?: Anteprima };

const NIENTE = 'Niente è partito.';

/** Cosa dire all'admin per ogni rifiuto della rotta: cosa è successo e come si recupera. */
export function messaggioRifiuto(j: Corpo409, status: number): string {
  switch (j.errore) {
    case 'anteprima_scaduta':
      return `La prova è scaduta: rifalla. ${NIENTE}`;
    case 'gia_eseguita':
      return "Questa prova è già stata confermata una volta. Niente è partito da questo clic: guarda l'esito nel registro azioni, poi rifai la prova se serve ancora.";
    case 'azione_in_corso':
      return `${j.messaggio ?? 'Questa azione è già in corso. Aspetta che finisca.'} ${NIENTE} Rifai la prova quando ha finito.`;
    case 'esito_senza_data':
      return `L'esito di questa chat è senza data e il CRM non lo accetta. ${NIENTE} Apri la chat e controlla l'esito.`;
    case 'nessun_esito':
      return `Su questa chat non c'è nessun esito da rinviare. ${NIENTE}`;
    case 'chat_fuori_perimetro':
      return `La chat è fuori dal perimetro Fenice: la console non può agire su di lei. ${NIENTE}`;
    case 'cron_secret_mancante':
      return `Le azioni della console sono spente: sul server manca CRON_SECRET. ${NIENTE}`;
    default:
      break;
  }
  if (status === 401 || status === 403) return `La sessione è scaduta: rientra nella console e rifai la prova. ${NIENTE}`;
  return '';
}

async function leggiCorpo(r: Response): Promise<Corpo409> {
  try {
    return (await r.json()) as Corpo409;
  } catch {
    return {};
  }
}

function testoConferma(rif: AzioneRef, a: Anteprima): string {
  return a.conteggio === null ? `Conferma: ${rif.etichetta}` : `Conferma: ${rif.etichetta} ${a.conteggio}`;
}

interface FlussoAzioneProps {
  rif: AzioneRef;
  /** Dopo un'esecuzione arrivata al server (riuscita o no): chi la usa rilegge avvisi e registro. */
  onEseguita?: (e: Esito) => void;
}

/**
 * Prova a vuoto → conferma → esito, per una sola azione della console. Niente parte senza una
 * prova: la conferma porta il numero della prova e usa il suo token monouso. Riusato dalla pagina
 * Avvisi, dalla cabina e dall'Assistente.
 */
export function FlussoAzione({ rif, onEseguita }: FlussoAzioneProps) {
  const [stato, setStato] = useState<Stato>({ fase: 'riposo' });
  const [dettagli, setDettagli] = useState(false);
  // Guardia sincrona: due clic nello stesso giro di React vedono ancora il bottone abilitato.
  const inVolo = useRef(false);

  async function prova() {
    if (inVolo.current) return;
    inVolo.current = true;
    setStato({ fase: 'anteprima' });
    try {
      const r = await fetch('/api/console/azioni/anteprima', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ azione: rif.azione, params: rif.params }),
      });
      if (r.ok) {
        setStato({ fase: 'pronta', a: (await r.json()) as Anteprima, nota: null });
        return;
      }
      const j = await leggiCorpo(r);
      const testo = messaggioRifiuto(j, r.status)
        || `La prova a vuoto non è riuscita${j.dettaglio ? `: ${j.dettaglio}` : ` (HTTP ${r.status})`}. ${NIENTE}`;
      setStato({ fase: 'errore', messaggio: testo });
    } catch {
      setStato({ fase: 'errore', messaggio: `Il server non ha risposto alla prova a vuoto. ${NIENTE}` });
    } finally {
      inVolo.current = false;
    }
  }

  async function conferma(a: Anteprima) {
    if (inVolo.current) return;
    inVolo.current = true;
    setStato({ fase: 'esecuzione', a });
    try {
      const r = await fetch('/api/console/azioni/esegui', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: a.token, conferma: true }),
      });
      if (r.ok) {
        const e = (await r.json()) as Esito;
        setDettagli(false);
        setStato({ fase: 'esito', e });
        // Anche nel toast: se la rilettura toglie l'avviso, la riga con l'esito sparisce con lui.
        (e.ok ? toast.ok : toast.errore)(`${rif.etichetta}: ${e.fatti} fatti, ${e.falliti} falliti`);
        onEseguita?.(e);
        return;
      }
      const j = await leggiCorpo(r);
      if (j.errore === 'conteggio_cambiato' && j.nuovaAnteprima) {
        const n = j.nuovaAnteprima;
        setStato({
          fase: 'pronta',
          a: n,
          nota: `Il numero è cambiato da ${a.conteggio ?? '?'} a ${n.conteggio ?? '?'} dopo la prova. ${NIENTE} Controlla e conferma di nuovo.`,
        });
        return;
      }
      const testo = messaggioRifiuto(j, r.status)
        || `L'esecuzione non è riuscita${j.dettaglio ? `: ${j.dettaglio}` : ` (HTTP ${r.status})`}. Guarda il registro azioni prima di rifare la prova.`;
      setStato({ fase: 'errore', messaggio: testo });
    } catch {
      setStato({
        fase: 'errore',
        messaggio: "Il server non ha risposto: non so se l'azione è partita. Guarda il registro azioni prima di rifare la prova.",
      });
    } finally {
      inVolo.current = false;
    }
  }

  if (stato.fase === 'riposo' || stato.fase === 'anteprima') {
    const inProva = stato.fase === 'anteprima';
    return (
      <div className="flusso">
        <div className="flusso-riga">
          <span className="flusso-et">{rif.etichetta}</span>
          <Button caricamento={inProva} onClick={() => void prova()} aria-label={`Prova a vuoto: ${rif.etichetta}`}>
            <FlaskConical size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            {inProva ? 'Prova in corso…' : 'Prova a vuoto'}
          </Button>
        </div>
      </div>
    );
  }

  if (stato.fase === 'pronta' || stato.fase === 'esecuzione') {
    const { a } = stato;
    const inCorso = stato.fase === 'esecuzione';
    const vuota = a.conteggio === 0;
    return (
      <div className="flusso flusso-box" aria-live="polite">
        {stato.fase === 'pronta' && stato.nota && <p className="flusso-nota">{stato.nota}</p>}
        <p className="flusso-desc">{a.descrizione}</p>
        {a.righe.length > 0 && (
          <ul className="flusso-righe mono">
            {a.righe.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        {a.avvertenza && (
          <p className="flusso-avv">
            <TriangleAlert size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            {a.avvertenza}
          </p>
        )}
        {vuota && <p className="flusso-meta">Nessun elemento da trattare: non c&apos;è niente da confermare.</p>}
        <div className="flusso-act">
          <Button variante="primario" caricamento={inCorso} disabled={vuota} onClick={() => void conferma(a)}>
            <Play size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            {inCorso ? 'In corso…' : testoConferma(rif, a)}
          </Button>
          <Button variante="fantasma" disabled={inCorso} onClick={() => setStato({ fase: 'riposo' })}>
            Annulla
          </Button>
          <span className="flusso-meta mono">prova valida fino alle {oraRoma(a.scadeAt)}</span>
        </div>
      </div>
    );
  }

  if (stato.fase === 'esito') {
    const { e } = stato;
    return (
      <div className={`flusso flusso-box ${e.ok ? 'flusso-ok' : 'flusso-ko'}`} aria-live="polite">
        <p className="flusso-esito">
          <span>{`${e.fatti} fatti, ${e.falliti} falliti`}</span>
        </p>
        <p className="flusso-desc">{e.messaggio}</p>
        <div className="flusso-act">
          {e.dettagli.length > 0 && (
            <Button variante="fantasma" aria-expanded={dettagli} onClick={() => setDettagli((d) => !d)}>
              {dettagli ? (
                <ChevronDown size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
              ) : (
                <ChevronRight size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
              )}
              Vedi dettagli
            </Button>
          )}
          <Button variante="fantasma" onClick={() => setStato({ fase: 'riposo' })}>
            Chiudi
          </Button>
        </div>
        {dettagli && (
          <ul className="flusso-righe mono">
            {e.dettagli.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="flusso flusso-box flusso-ko" role="alert">
      <p className="flusso-desc">{stato.messaggio}</p>
      <div className="flusso-act">
        <Button onClick={() => void prova()}>
          <FlaskConical size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
          Rifai la prova
        </Button>
        <Button variante="fantasma" onClick={() => setStato({ fase: 'riposo' })}>
          Annulla
        </Button>
      </div>
    </div>
  );
}
