'use client';

import { memo } from 'react';
import type { RigaLista } from '@/lib/console/viste-db';
import { nomeRiga, orarioRiga, prefissoAnteprima } from '@/lib/console/riga';
import { Orario } from './ui/Cifre';
import { Avatar } from './ui/Avatar';
import { Tag } from './ui/Tag';

interface RigaChatProps {
  riga: RigaLista;
  selezionata: boolean;
  /** Evidenziata dal cursore da tastiera (j/k), che non apre la chat. */
  cursore: boolean;
  /** La riga è appena arrivata o risalita: evidenziazione di 600 ms, solo opacità di uno sfondo. */
  appena: boolean;
  now: Date;
  onApri: (id: number) => void;
}

/** Contesto della riga, uno solo, come nel mockup: "Serve te" è l'unico badge pieno; l'errore è
 *  testo rosso; fase del lancio e mondo sono testo attenuato, per non trasformare la lista in un
 *  muro di etichette. */
function Contesto({ contesto, secondario }: { contesto: RigaLista['contesto']; secondario: string | null }) {
  if (contesto?.tono === 'urgente') {
    return (
      <span className="ctx">
        <Tag tono="urgente">{contesto.testo}</Tag>
      </span>
    );
  }
  if (contesto) return <span className={contesto.tono === 'errore' ? 'ctx err' : 'ctx'}>{contesto.testo}</span>;
  if (secondario) return <span className="ctx">{secondario}</span>;
  return null;
}

export const RigaChat = memo(function RigaChat({ riga, selezionata, cursore, appena, now, onApri }: RigaChatProps) {
  const { principale, secondario } = nomeRiga(riga);
  const nonLetta = riga.nonLetti > 0;
  const anteprima = prefissoAnteprima(riga.anteprima);
  const classi = ['row', nonLetta && 'unread', cursore && 'cursore', appena && 'appena'].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      id={`riga-chat-${riga.id}`}
      role="option"
      aria-selected={selezionata}
      className={classi}
      onClick={() => onApri(riga.id)}
      data-chat-id={riga.id}
    >
      <Avatar nome={riga.nome} telefono={riga.telefono} />
      <span style={{ minWidth: 0 }}>
        <span className="l1">
          <span className={secondario ? 'nm mono nm-tel' : 'nm'}>{principale}</span>
          <Contesto contesto={riga.contesto} secondario={secondario} />
          <span className="tm" style={riga.contesto || secondario ? undefined : { marginLeft: 'auto' }}>
            <Orario testo={orarioRiga(riga.ultimoAt, now)} />
          </span>
        </span>
        <span className="l2">
          <span className="pv">{anteprima || 'Nessun messaggio'}</span>
          {nonLetta && (
            <span className="un" aria-label={`${riga.nonLetti} non letti`}>
              {riga.nonLetti > 99 ? '99+' : riga.nonLetti}
            </span>
          )}
        </span>
      </span>
    </button>
  );
});
