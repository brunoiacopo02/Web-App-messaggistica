// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvvisoConsole } from '@/lib/console/avvisi';
import type { Regia } from '@/lib/console/regia';

const stato = vi.hoisted(() => ({
  regia: null as unknown,
  avvisi: [] as unknown[],
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a>,
}));
vi.mock('./RegiaProvider', () => ({ useRegia: () => ({ regia: stato.regia, errore: false }) }));
vi.mock('./useAvvisi', () => ({
  useAvvisi: () => ({ dati: stato.avvisi, errore: false, aggiornatoAt: null, rileggi: async () => {} }),
}));
// La riga d'avviso ha i suoi test: qui basta sapere quali avvisi arrivano in sala.
vi.mock('./RigaAvviso', () => ({ RigaAvviso: ({ a }: { a: AvvisoConsole }) => <article data-testid="avviso">{a.id}</article> }));

const { SalaLancio, avvisoDelLancio } = await import('./SalaLancio');

afterEach(() => {
  document.body.innerHTML = '';
});

const perOra = Array.from({ length: 24 }, (_, ora) => ({ ora, inviati: ora === 20 ? 10 : 0, consegnati: 0, falliti: 0 }));

function regia(p: Partial<Regia> = {}): Regia {
  return {
    attivo: true,
    pulsanteAttivo: false,
    eventoAt: '2026-10-05T21:00:00+02:00',
    stato: { stato: 'prima', secondi: 100 },
    scaletta: [],
    numeri: { iscritti: 200, postoBloccato: 120, linkInviati: 80, consegnatiOggi: 300, fallitiOggi: 4 },
    perFase: { attesa: 60, posto_bloccato: 50, restituito: 7 },
    perOra,
    generatoAt: '2026-10-05T18:00:00Z',
    ...p,
  };
}

const avviso = (id: string, area: AvvisoConsole['area']) => ({ id, area }) as AvvisoConsole;

describe('SalaLancio', () => {
  it('lancio spento: dice come accenderlo e non mostra numeri', () => {
    stato.regia = regia({ attivo: false });
    render(<SalaLancio />);
    expect(screen.getByText('Nessun lancio attivo. Si accende da Impostazioni.')).toBeTruthy();
    expect(screen.queryByText('Dove sono ora')).toBeNull();
  });

  it('lancio acceso: numeri, restituiti dalle fasi, fasi linkate alla vista e stato del pulsante', () => {
    stato.regia = regia();
    stato.avvisi = [avviso('pulsante_spento', 'lancio'), avviso('twilio_63016', 'twilio'), avviso('fenice_ai_error', 'bot')];
    const { container } = render(<SalaLancio />);
    expect(screen.getByText('Restituiti').nextElementSibling?.textContent).toBe('7');
    // Il cumulativo dice chi ha bloccato il posto; le barre dicono dove sono ora.
    expect(screen.getByText('Hanno bloccato il posto').nextElementSibling?.textContent).toBe('120');
    const numeri = screen.getByLabelText('Numeri del lancio');
    expect(numeri.textContent).not.toContain('Posto bloccato');
    expect(screen.getByRole('heading', { name: 'Dove sono ora' })).toBeTruthy();
    expect(screen.queryByText('Fin dove sono arrivati')).toBeNull();
    const fase = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/console?vista=lancio&fase=posto_bloccato');
    expect(fase?.textContent).toContain('50');
    // Le barre per fase tengono l'etichetta della fase.
    expect(fase?.textContent).toContain('Posto bloccato');
    expect(container.querySelectorAll('.sala-fase')).toHaveLength(8);
    expect(screen.getByText('Pulsante del webinar').nextElementSibling?.textContent).toBe('spento');
    expect(container.querySelector('a[href="/console/impostazioni"]')).toBeTruthy();
    expect(screen.getAllByTestId('avviso').map((a) => a.textContent)).toEqual(['pulsante_spento', 'twilio_63016']);
  });
});

describe('avvisoDelLancio', () => {
  it('tiene area lancio e id twilio_*, scarta il resto', () => {
    expect(avvisoDelLancio(avviso('x', 'lancio'))).toBe(true);
    expect(avvisoDelLancio(avviso('twilio_invii', 'twilio'))).toBe(true);
    expect(avvisoDelLancio(avviso('cron_fermo', 'cron'))).toBe(false);
  });
});
