import type { ReactNode } from 'react';
import { Inbox, TriangleAlert, RefreshCw } from 'lucide-react';
import { Button } from './Button';

interface VuotoProps {
  titolo: string;
  testo: string;
  azione?: ReactNode;
}

/** Stato vuoto di una vista: mai solo "nessun risultato", sempre titolo + spiegazione (+ azione opzionale). */
export function Vuoto({ titolo, testo, azione }: VuotoProps) {
  return (
    <div className="stato">
      <Inbox size={20} strokeWidth={1.75} className="ico" />
      <p className="stato-t">{titolo}</p>
      <p className="stato-m">{testo}</p>
      {azione}
    </div>
  );
}

interface ErroreProps {
  titolo: string;
  testo: string;
  onRiprova: () => void;
}

/** Stato di errore: dice cosa è successo e offre "Riprova"; mai "Qualcosa è andato storto" da solo. */
export function Errore({ titolo, testo, onRiprova }: ErroreProps) {
  return (
    <div className="stato stato-err">
      <TriangleAlert size={20} strokeWidth={1.75} className="ico" />
      <p className="stato-t">{titolo}</p>
      <p className="stato-m">{testo}</p>
      <Button onClick={onRiprova}>
        <RefreshCw size={14} strokeWidth={1.75} className="ico" />
        Riprova
      </Button>
    </div>
  );
}
