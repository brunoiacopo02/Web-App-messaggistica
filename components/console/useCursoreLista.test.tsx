// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useCursoreLista } from './useCursoreLista';

function premi(key: string) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    document.body.dispatchEvent(e);
  });
  return e;
}

function monta(chat: number | null = null) {
  const apri = vi.fn();
  const chiudi = vi.fn();
  const mostra = vi.fn();
  const h = renderHook((p: { chat: number | null }) =>
    useCursoreLista({ ids: [10, 20, 30], chiave: 'non_lette', chat: p.chat, apri, chiudi, mostra }), { initialProps: { chat } });
  return { h, apri, chiudi, mostra };
}

it('j sposta il cursore senza aprire la chat; Invio apre la riga evidenziata', () => {
  const { h, apri, mostra } = monta();
  premi('j');
  expect(h.result.current.cursore).toBe(10);
  premi('j');
  premi('ArrowDown');
  expect(h.result.current.cursore).toBe(30);
  premi('k');
  expect(h.result.current.cursore).toBe(20);
  expect(apri).not.toHaveBeenCalled();
  expect(mostra).toHaveBeenLastCalledWith(1);
  premi('Enter');
  expect(apri).toHaveBeenCalledExactlyOnceWith(20);
});

it('il cursore parte dalla chat aperta', () => {
  const { h } = monta(20);
  premi('j');
  expect(h.result.current.cursore).toBe(30);
});

it('Escape chiude la chat aperta, poi toglie il cursore, poi lascia il tasto al browser', () => {
  const { h, chiudi } = monta(20);
  premi('j');
  expect(premi('Escape').defaultPrevented).toBe(true);
  expect(chiudi).toHaveBeenCalledTimes(1);
  h.rerender({ chat: null });
  expect(premi('Escape').defaultPrevented).toBe(true);
  expect(h.result.current.cursore).toBeNull();
  expect(premi('Escape').defaultPrevented).toBe(false);
  expect(chiudi).toHaveBeenCalledTimes(1);
});

it('senza cursore e senza chat aperta, Invio apre la prima', () => {
  const { apri } = monta();
  premi('Enter');
  expect(apri).toHaveBeenCalledExactlyOnceWith(10);
});
