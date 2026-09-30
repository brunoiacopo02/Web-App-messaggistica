// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsegneOra } from '@/lib/console/regia';
import { GraficoOre } from './GraficoOre';

afterEach(() => {
  document.body.innerHTML = '';
});

const vuote = (): ConsegneOra[] => Array.from({ length: 24 }, (_, ora) => ({ ora, inviati: 0, consegnati: 0, falliti: 0 }));

function conInvii(): ConsegneOra[] {
  const perOra = vuote();
  perOra[9] = { ora: 9, inviati: 40, consegnati: 38, falliti: 0 };
  perOra[19] = { ora: 19, inviati: 260, consegnati: 250, falliti: 3 };
  perOra[20] = { ora: 20, inviati: 640, consegnati: 600, falliti: 12 };
  return perOra;
}

describe('GraficoOre', () => {
  it('24 barre di consegna e una barra di fallimento solo per le ore con falliti', () => {
    const { container } = render(<GraficoOre perOra={conInvii()} />);
    expect(container.querySelectorAll('rect.b')).toHaveLength(24);
    const ko = container.querySelectorAll('rect.ko');
    expect(ko).toHaveLength(2);
    expect(screen.queryByText('Ancora nessun invio oggi')).toBeNull();
  });

  it('anche nella versione grande: 24 consegne, fallimenti solo dove servono', () => {
    const { container } = render(<GraficoOre perOra={conInvii()} altezza={180} />);
    expect(container.querySelectorAll('rect.b')).toHaveLength(24);
    expect(container.querySelectorAll('rect.ko')).toHaveLength(2);
    expect(container.querySelector('svg')?.style.height).toBe('180px');
  });

  it('tutte a zero: dice che non è partito ancora niente, senza barre', () => {
    const { container } = render(<GraficoOre perOra={vuote()} />);
    expect(screen.getByText('Ancora nessun invio oggi')).toBeTruthy();
    expect(container.querySelectorAll('rect')).toHaveLength(0);
  });
});
