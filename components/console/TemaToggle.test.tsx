// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTema } from './TemaToggle';

it('parte scuro e ricorda la scelta', () => {
  localStorage.clear();
  const { result } = renderHook(() => useTema());
  expect(result.current[0]).toBe('dark');
  act(() => result.current[1]('light'));
  expect(localStorage.getItem('console-tema')).toBe('light');
});
it('regge un localStorage che lancia', () => {
  const orig = Storage.prototype.getItem;
  Storage.prototype.getItem = () => { throw new Error('bloccato'); };
  const { result } = renderHook(() => useTema());
  expect(result.current[0]).toBe('dark');
  Storage.prototype.getItem = orig;
});
