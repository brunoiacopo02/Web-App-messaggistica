const fmt = new Intl.NumberFormat('it-IT');

export interface VoceBarra {
  etichetta: string;
  valore: number;
}

interface BarListProps {
  /** Nome della lista per i lettori di schermo. */
  titolo: string;
  voci: readonly VoceBarra[];
  vuoto?: string;
}

/**
 * Barre orizzontali in SVG, una per voce: etichetta, barra in scala sulla voce più alta, numero.
 * Serie in neutro (`--bar`), nessuna animazione; il numero è sempre scritto, la barra è solo
 * un aiuto a confrontare.
 */
export function BarList({ titolo, voci, vuoto = 'Nessun dato.' }: BarListProps) {
  if (voci.length === 0) return <p className="bl-vuoto">{vuoto}</p>;
  const massimo = Math.max(...voci.map((v) => v.valore), 1);
  return (
    <ul className="bl" aria-label={titolo}>
      {voci.map((v) => (
        <li key={v.etichetta} className="bl-riga">
          <span className="bl-nm" title={v.etichetta}>{v.etichetta}</span>
          <svg className="bl-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
            <rect className="bl-t" x="0" y="0" width="100" height="8" />
            <rect className="bl-f" x="0" y="0" width={Math.max(0, (v.valore / massimo) * 100)} height="8" />
          </svg>
          <span className="bl-n">{fmt.format(v.valore)}</span>
        </li>
      ))}
    </ul>
  );
}
