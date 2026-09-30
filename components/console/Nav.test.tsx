// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/console' }));
vi.mock('./useConteggi', () => ({ useConteggi: () => ({ conteggi: null }) }));
vi.mock('./RegiaProvider', () => ({ useRegia: () => ({ regia: null }) }));
const signOutAction = vi.fn();
vi.mock('@/app/(auth)/login/actions', () => ({ signOutAction }));

const { Nav } = await import('./Nav');

function monta() {
  render(
    <NuqsTestingAdapter>
      <div data-console>
        <Nav />
      </div>
    </NuqsTestingAdapter>,
  );
}

it('in fondo: "Interfaccia vecchia" porta a /dashboard', () => {
  monta();
  const link = screen.getByRole('link', { name: 'Interfaccia vecchia' });
  expect(link.getAttribute('href')).toBe('/dashboard');
});

it('in fondo: "Esci" è un bottone di submit dentro un form, non dentro un testo', () => {
  monta();
  const esci = screen.getByRole('button', { name: 'Esci' });
  expect(esci.getAttribute('type')).toBe('submit');
  expect(esci.closest('form')).not.toBeNull();
  expect(esci.closest('span, p')).toBeNull();
});
