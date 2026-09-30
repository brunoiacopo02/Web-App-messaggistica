import { Fragment } from 'react';

const fmt = new Intl.NumberFormat('it-IT');

/**
 * Un numero intero formattato all'italiana ("10.860") con cifre tabellari ma punto stretto.
 *
 * La `tnum` di Schibsted Grotesk allarga anche il punto delle migliaia alla larghezza di una cifra,
 * e "10.860" si legge "10 . 860". Il separatore sta in uno `<span class="sep">` con la variante
 * numerica normale: le cifre restano allineate e non scattano ai rinfreschi, il punto torna stretto.
 * Nel font mono (JetBrains) ogni glyph è largo uguale e questo componente non serve.
 */
export function Cifre({ n, suffisso }: { n: number; suffisso?: string }) {
  const parti = fmt.format(n).split('.');
  return (
    <>
      {parti.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="sep">.</span>}
          {p}
        </Fragment>
      ))}
      {suffisso}
    </>
  );
}

/** Un orario o una data ("18:12", "Ieri", "28/09") con cifre tabellari e due punti stretti:
 *  la `tnum` allarga anche ":" e "18:12" si legge "18 : 12". */
export function Orario({ testo }: { testo: string }) {
  const parti = testo.split(':');
  return (
    <>
      {parti.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="sep">:</span>}
          {p}
        </Fragment>
      ))}
    </>
  );
}
