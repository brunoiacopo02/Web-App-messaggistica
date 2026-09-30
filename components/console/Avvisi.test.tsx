// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useScorriAllAncora } from './Avvisi';

afterEach(() => {
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

it("/console/avvisi#id: quando la lista arriva scorre all'avviso una volta sola", () => {
  window.history.replaceState(null, '', '/console/avvisi#crm%3A403');
  const el = document.createElement('article');
  el.id = 'crm:403';
  el.tabIndex = -1;
  const scorri = vi.fn();
  el.scrollIntoView = scorri;
  document.body.appendChild(el);

  const { rerender } = renderHook(({ pronto }) => useScorriAllAncora(pronto), { initialProps: { pronto: false } });
  expect(scorri).not.toHaveBeenCalled();
  rerender({ pronto: true });
  expect(scorri).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(el);
  rerender({ pronto: true });
  expect(scorri).toHaveBeenCalledTimes(1);
});

it('Azioni manuali: la select dei cron mostra lancio-inizio', async () => {
  vi.resetModules();
  vi.doMock('./useAvvisi', () => ({
    useAvvisi: () => ({ dati: [], errore: null, rileggi: () => {} }),
    useRegistro: () => ({ dati: [], errore: null, rileggi: () => {} }),
  }));
  const { render, screen } = await import('@testing-library/react');
  const { Avvisi } = await import('./Avvisi');
  render(
    <div data-console>
      <Avvisi />
    </div>,
  );
  const opzioni = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
  expect(opzioni).toContain('lancio-inizio');
  vi.doUnmock('./useAvvisi');
});
