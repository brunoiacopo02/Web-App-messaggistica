'use client';

import { useState } from 'react';
import { Copy, ExternalLink, SquareTerminal } from 'lucide-react';
import { mondoLabel } from '@/lib/chat-perimetro';
import { isLancioFase } from '@/lib/lancio-fase';
import { ETICHETTA_FASE } from '@/lib/console/viste';
import { formattaTelefono, orarioRiga } from '@/lib/console/riga';
import { dataOraBreve, leggibile, numeroWa, statoCrm, testoEvento, type DettaglioChat } from '@/lib/console/thread';
import { Button } from './ui/Button';
import { Kbd } from './ui/Kbd';
import { toast } from './ui/toast';
import { useApriAssistente } from './Assistente';

const CRM_URL = 'https://crm-sales-fenice.vercel.app/?lead=';
const STORICO_BREVE = 8;

/** Il nome dei due numeri WhatsApp Fenice, per le ultime 4 cifre. */
const NOME_NUMERO: Record<string, string> = { '3199': 'storico', '0047': 'secondo' };

function Nessuno({ testo = 'Nessuno' }: { testo?: string }) {
  return <dd className="none">{testo}</dd>;
}

interface SchedaLeadProps {
  dettaglio: DettaglioChat;
  now: Date;
}

/** Scheda del lead nella cabina (mockup, parte bassa): dati, azioni, storico eventi compresso. */
export function SchedaLead({ dettaglio, now }: SchedaLeadProps) {
  const { conv, lead, crm, eventi } = dettaglio;
  const [tutti, setTutti] = useState(false);
  const { apri } = useApriAssistente();

  const wa = numeroWa(conv.waNumber);
  const esito = leggibile(conv.botOutcome);
  const fissato = dataOraBreve(conv.botScheduledAt);
  const fase = isLancioFase(conv.lancioFase) ? ETICHETTA_FASE[conv.lancioFase] : null;
  const storico = tutti ? eventi : eventi.slice(0, STORICO_BREVE);

  async function copia() {
    if (!lead.telefono) return;
    try {
      await navigator.clipboard.writeText(lead.telefono);
      toast.ok('Telefono copiato');
    } catch {
      toast.errore('Non riesco a copiare il telefono: il browser ha negato gli appunti. Selezionalo a mano.');
    }
  }

  return (
    <section className="lead-card" aria-label="Scheda lead">
      <div className="ch">
        <h2 className="ch-sub">Scheda lead</h2>
        <span className="sp" />
        <Kbd>]</Kbd>
      </div>
      <dl className="dl">
        <dt>Telefono</dt>
        {lead.telefono ? (
          <dd>
            <span className="mono">{formattaTelefono(lead.telefono)}</span>
            <button type="button" className="iconbtn copy" aria-label="Copia telefono" onClick={() => void copia()}>
              <Copy size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            </button>
          </dd>
        ) : (
          <Nessuno />
        )}

        <dt>ID lead</dt>
        {lead.id != null ? <dd><span className="mono">{lead.id}</span></dd> : <Nessuno />}

        <dt>Numero WA</dt>
        {wa ? (
          <dd>
            <span className="mono">{wa}</span>
            {NOME_NUMERO[wa] && <span className="muted">{NOME_NUMERO[wa]}</span>}
          </dd>
        ) : (
          <Nessuno />
        )}

        <dt>Mondo</dt>
        <dd>{mondoLabel(conv.mondo, 'estesa')}</dd>

        <dt>Fase</dt>
        {fase ? <dd className="ph-v">{fase}</dd> : <Nessuno testo="Fuori dal lancio" />}

        <dt>Esito bot</dt>
        {esito ? (
          <dd>
            {esito}
            {fissato && <span className="mono muted">{fissato}</span>}
          </dd>
        ) : (
          <Nessuno />
        )}

        <dt>Stato CRM</dt>
        {crm?.status ? <dd>{statoCrm(crm.status) ?? leggibile(crm.status)}</dd> : <Nessuno testo={conv.crmLeadId ? 'Non sincronizzato' : 'Non nel CRM'} />}

        {crm?.conferme_outcome && (
          <>
            <dt>Conferme</dt>
            <dd>{leggibile(crm.conferme_outcome)}</dd>
          </>
        )}
        {crm?.sales_outcome && (
          <>
            <dt>Venditore</dt>
            <dd>{leggibile(crm.sales_outcome)}</dd>
          </>
        )}
      </dl>

      {conv.aiSummary && (
        <div className="riassunto">
          <h3>Riassunto di Mario</h3>
          <p>{conv.aiSummary}</p>
        </div>
      )}

      <div className="lc-act">
        {conv.crmLeadId && (
          <a className="btn" href={`${CRM_URL}${encodeURIComponent(conv.crmLeadId)}`} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
            Apri nel CRM
          </a>
        )}
        <Button
          onClick={() => apri(`Com'è andata la chat ${conv.id}${lead.nome ? ` di ${lead.nome}` : ''}? Cosa serve adesso?`)}
          aria-label={`Chiedi all'Assistente com'è andata la chat di ${lead.nome ?? 'questo lead'}`}
        >
          <SquareTerminal size={16} strokeWidth={1.75} className="ico" aria-hidden="true" />
          Chiedi all&apos;Assistente…
        </Button>
      </div>

      <div className="hist">
        <h3>Storico</h3>
        {eventi.length === 0 ? (
          <p className="hist-vuoto">Nessun evento negli ultimi 7 giorni.</p>
        ) : (
          <ol>
            {storico.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="mono">{orarioRiga(e.at, now)}</span>
                <span className="hist-t">{testoEvento(e.tipo, e.testo)}</span>
              </li>
            ))}
          </ol>
        )}
        {eventi.length > STORICO_BREVE && (
          <Button variante="fantasma" className="hist-tutti" onClick={() => setTutti((t) => !t)}>
            {tutti ? 'Mostra solo gli ultimi' : `Mostra tutti (${eventi.length})`}
          </Button>
        )}
      </div>
    </section>
  );
}
