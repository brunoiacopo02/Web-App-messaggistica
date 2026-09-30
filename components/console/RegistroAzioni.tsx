'use client';

import { dataOraBreve } from '@/lib/console/thread';
import { SkeletonRighe, useCaricamentoVisibile } from './ui/Skeleton';
import { Errore, Vuoto } from './ui/Stato';
import { Tag } from './ui/Tag';
import type { RigaRegistro } from './useAvvisi';

/** Il nome leggibile di ogni azione della console, per il registro. */
export const NOME_AZIONE: Record<string, string> = {
  rinvia_esiti_403: 'Rinvia gli esiti rifiutati',
  recupera_agende_consegnate: 'Recupera le agende consegnate',
  rinvia_esito: "Rinvia l'esito di una chat",
  rilancia_cron: 'Rilancia un cron',
  interruttore: 'Interruttore',
  pausa_mario: 'Mette Mario in pausa',
  riprendi_mario: 'Ridà la chat a Mario',
};

export function parametriLeggibili(params: Record<string, unknown> | undefined): string {
  const voci = Object.entries(params ?? {});
  if (voci.length === 0) return 'nessuno';
  return voci
    .map(([k, v]) => (k === 'conversationId' ? `chat ${String(v)}` : `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`))
    .join(', ');
}

function EsitoRiga({ r }: { r: RigaRegistro }) {
  const e = r.payload?.esito;
  if (r.level === 'warn') return <Tag tono="attesa">Rifiutata</Tag>;
  if (!e) return <span className="muted">non registrato</span>;
  const conti = `${e.fatti ?? 0} fatti, ${e.falliti ?? 0} falliti`;
  return (
    <>
      <Tag tono={e.ok ? 'ok' : 'errore'}>{e.ok ? 'Riuscita' : 'Non riuscita'}</Tag>
      <span>{conti}</span>
    </>
  );
}

interface RegistroAzioniProps {
  righe: RigaRegistro[] | null;
  errore: boolean;
  onRiprova: () => void;
}

/** Tabella delle ultime 100 azioni lanciate dalla console: righe da 32 px. */
export function RegistroAzioni({ righe, errore, onRiprova }: RegistroAzioniProps) {
  const skeleton = useCaricamentoVisibile(righe === null && !errore);

  if (righe === null) {
    if (errore) {
      return (
        <Errore
          titolo="Non riesco a leggere il registro"
          testo="La richiesta al server non è andata a buon fine. Le azioni non sono cambiate: riprova tra un momento."
          onRiprova={onRiprova}
        />
      );
    }
    return <div aria-busy="true">{skeleton && <SkeletonRighe righe={8} altezza={32} />}</div>;
  }
  if (righe.length === 0) {
    return <Vuoto titolo="Nessuna azione lanciata" testo="Qui compare ogni azione confermata dalla console, con chi l'ha lanciata e com'è andata." />;
  }

  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">Ora</th>
            <th scope="col">Azione</th>
            <th scope="col">Parametri</th>
            <th scope="col">Esito</th>
            <th scope="col">Chi</th>
          </tr>
        </thead>
        <tbody>
          {righe.map((r) => (
            <tr key={r.id}>
              <td className="mono">{dataOraBreve(r.created_at) ?? r.created_at}</td>
              <td>{NOME_AZIONE[r.payload?.azione ?? ''] ?? r.payload?.azione ?? 'sconosciuta'}</td>
              <td className="mono tbl-par">{parametriLeggibili(r.payload?.params)}</td>
              <td>
                <div className="tbl-esito" title={r.payload?.esito?.messaggio ?? r.message ?? undefined}>
                  <EsitoRiga r={r} />
                </div>
              </td>
              <td className="mono tbl-chi">{r.payload?.by ?? 'sconosciuto'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
