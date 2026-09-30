// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AvvisoConsole } from '@/lib/console/avvisi';

vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a>,
}));
vi.mock('./Assistente', () => ({ useApriAssistente: () => ({ apri: () => {} }) }));
vi.mock('./FlussoAzione', () => ({ FlussoAzione: () => null }));

const { RigaAvviso } = await import('./RigaAvviso');

afterEach(() => {
  document.body.innerHTML = '';
});

function avviso(p: Partial<AvvisoConsole> = {}): AvvisoConsole {
  return {
    id: 'pulsante_spento',
    gravita: 'attenzione',
    titolo: 'Pulsante del webinar spento',
    significato: 'x',
    cosaFare: 'y',
    conteggio: 1,
    chat: [],
    ultimoAt: null,
    primoAt: null,
    area: 'lancio',
    azioni: [],
    firma: 'pulsante_spento:',
    ...p,
  };
}

describe('RigaAvviso', () => {
  it('"Apri le impostazioni…" porta alle impostazioni della console, non a /fenice', () => {
    const { container } = render(<RigaAvviso a={avviso({ impostazioni: true })} onCambio={() => {}} />);
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('Apri le impostazioni'));
    expect(link?.getAttribute('href')).toBe('/console/impostazioni');
    expect(container.querySelector('a[href^="/fenice"]')).toBeNull();
  });

  it('senza impostazioni non mostra il link', () => {
    const { container } = render(<RigaAvviso a={avviso()} onCambio={() => {}} />);
    expect(container.querySelector('a[href="/console/impostazioni"]')).toBeNull();
  });
});
