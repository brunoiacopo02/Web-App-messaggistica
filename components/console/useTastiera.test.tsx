// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTastiera } from './useTastiera';

function gestori() {
  return { onSu: vi.fn(), onGiu: vi.fn(), onApri: vi.fn(), onEsc: vi.fn(), onPalette: vi.fn(), onScheda: vi.fn() };
}

function premi(key: string, opts: KeyboardEventInit = {}, bersaglio: EventTarget = document.body) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  bersaglio.dispatchEvent(e);
  return e;
}

afterEach(() => {
  document.body.innerHTML = '';
});

it('j chiama onGiu, k onSu, le frecce fanno lo stesso', () => {
  const g = gestori();
  renderHook(() => useTastiera(g));
  premi('j');
  premi('ArrowDown');
  premi('k');
  premi('ArrowUp');
  expect(g.onGiu).toHaveBeenCalledTimes(2);
  expect(g.onSu).toHaveBeenCalledTimes(2);
});

it('Enter apre, Escape chiude, ] apre la scheda', () => {
  const g = gestori();
  renderHook(() => useTastiera(g));
  premi('Enter');
  premi('Escape');
  premi(']');
  expect(g.onApri).toHaveBeenCalledTimes(1);
  expect(g.onEsc).toHaveBeenCalledTimes(1);
  expect(g.onScheda).toHaveBeenCalledTimes(1);
});

it('dentro un <input> non chiama niente', () => {
  const g = gestori();
  renderHook(() => useTastiera(g));
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  premi('j', {}, input);
  premi('Enter', {}, input);
  premi(']', {}, input);
  const area = document.createElement('div');
  area.setAttribute('contenteditable', 'true');
  document.body.appendChild(area);
  premi('k', {}, area);
  expect(Object.values(g).every((f) => f.mock.calls.length === 0)).toBe(true);
});

it('Ctrl+K e Meta+K chiamano onPalette e bloccano il default del browser', () => {
  const g = gestori();
  renderHook(() => useTastiera(g));
  const e = premi('k', { ctrlKey: true });
  premi('K', { metaKey: true });
  expect(g.onPalette).toHaveBeenCalledTimes(2);
  expect(g.onSu).not.toHaveBeenCalled();
  expect(e.defaultPrevented).toBe(true);
});

it('smonta il listener', () => {
  const g = gestori();
  const { unmount } = renderHook(() => useTastiera(g));
  unmount();
  premi('j');
  expect(g.onGiu).not.toHaveBeenCalled();
});
