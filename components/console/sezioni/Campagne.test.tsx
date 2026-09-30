// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Campagne, type Campagna } from './Campagne';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  refresh.mockReset();
  // Lo Switch di Radix dentro un <form> misura il suo input nascosto: jsdom non ha ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function risposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

type Chiamata = { url: string; metodo: string; body: unknown };

function fetchFinto(risponde: (c: Chiamata) => Response) {
  const chiamate: Chiamata[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c = { url, metodo: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    chiamate.push(c);
    return risponde(c);
  }));
  return chiamate;
}

const SID = 'HX0123456789abcdef0123456789abcdef';

const esistente: Campagna = {
  id: 5, name: 'Webinar ottobre', ac_list_match: '133', twilio_template_sid: SID,
  template_variables: [{ key: '1', source: 'lead_field', value: 'first_name' }], active: true,
};

async function clic(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

function scrivi(nome: string, valore: string) {
  fireEvent.change(screen.getByRole('textbox', { name: nome }), { target: { value: valore } });
}

it('creare una campagna chiede una conferma che dice cosa parte, e solo dopo fa POST con il corpo del drawer vecchio', async () => {
  const chiamate = fetchFinto(() => risposta({ data: { id: 9 } }));
  render(<Campagne campagne={[]} />);

  await clic(screen.getByRole('button', { name: 'Nuova campagna…' }));
  scrivi('Nome', 'Lancio Web Dev');
  scrivi('Lista AC trigger', 'Web Dev AI');
  scrivi('Template Content SID', SID);
  await clic(screen.getByRole('button', { name: 'Aggiungi variabile' }));
  await clic(screen.getByRole('button', { name: 'Crea…' }));

  expect(chiamate).toHaveLength(0);
  const conferma = screen.getByRole('group', { name: 'Conferma la campagna' });
  expect(conferma.textContent).toContain('Web Dev AI');
  expect(conferma.textContent).toContain(SID);
  expect(conferma.textContent).toContain('in automatico');
  expect(conferma.textContent).toContain('non si sa in anticipo');

  await clic(within(conferma).getByRole('button', { name: 'Sì, crea e accendi' }));
  expect(chiamate).toEqual([{
    url: '/api/campaigns',
    metodo: 'POST',
    body: {
      name: 'Lancio Web Dev', ac_list_match: 'Web Dev AI', twilio_template_sid: SID,
      template_variables: [{ key: '1', source: 'lead_field', value: 'first_name' }], active: true,
    },
  }]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('group', { name: 'Conferma la campagna' })).toBeNull();
});

it('una campagna spenta lo dice nella conferma; Torna al modulo non chiama la rotta', async () => {
  const chiamate = fetchFinto(() => risposta({ data: {} }));
  render(<Campagne campagne={[]} />);

  await clic(screen.getByRole('button', { name: 'Nuova campagna…' }));
  scrivi('Nome', 'Prova');
  await clic(screen.getByRole('switch', { name: 'Attiva' }));
  await clic(screen.getByRole('button', { name: 'Crea…' }));
  expect(screen.getByRole('group', { name: 'Conferma la campagna' }).textContent).toContain('non parte nessun messaggio');

  await clic(screen.getByRole('button', { name: 'Torna al modulo' }));
  expect(chiamate).toHaveLength(0);
  expect(screen.getByRole('textbox', { name: 'Nome' })).toHaveProperty('value', 'Prova');
});

it('un 400 di validazione resta nel pannello come "Non salvata", con il campo che non va', async () => {
  fetchFinto(() => risposta({
    error: 'validation',
    details: { formErrors: [], fieldErrors: { twilio_template_sid: ['Formato Content SID non valido (HX...)'] } },
  }, 400));
  render(<Campagne campagne={[]} />);

  await clic(screen.getByRole('button', { name: 'Nuova campagna…' }));
  scrivi('Nome', 'Prova');
  await clic(screen.getByRole('button', { name: 'Crea…' }));
  await clic(screen.getByRole('button', { name: 'Sì, crea e accendi' }));

  const errore = screen.getByRole('alert');
  expect(errore.textContent).toContain('Non salvata');
  expect(errore.textContent).toContain('Template Content SID: Formato Content SID non valido (HX...)');
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Nome' })).toBeTruthy();
});

it('modificare una campagna mostra prima → dopo e fa PATCH sul suo id', async () => {
  const chiamate = fetchFinto(() => risposta({ data: {} }));
  render(<Campagne campagne={[esistente]} />);

  const riga = screen.getByRole('row', { name: /Webinar ottobre/ });
  expect(riga.textContent).toContain('Attiva');
  await clic(within(riga).getByRole('button', { name: 'Modifica Webinar ottobre…' }));
  scrivi('Lista AC trigger', '134');
  await clic(screen.getByRole('button', { name: 'Salva…' }));

  const conferma = screen.getByRole('group', { name: 'Conferma la campagna' });
  expect(conferma.textContent).toContain('133 → 134');
  await clic(within(conferma).getByRole('button', { name: 'Sì, salva' }));
  expect(chiamate).toEqual([{
    url: '/api/campaigns/5',
    metodo: 'PATCH',
    body: {
      name: 'Webinar ottobre', ac_list_match: '134', twilio_template_sid: SID,
      template_variables: [{ key: '1', source: 'lead_field', value: 'first_name' }], active: true,
    },
  }]);
});
