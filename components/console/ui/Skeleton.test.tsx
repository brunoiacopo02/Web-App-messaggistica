// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useCaricamentoVisibile } from './Skeleton';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('non visibile a 199 ms, visibile a 200 ms', () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useCaricamentoVisibile(true));
  expect(result.current).toBe(false);

  act(() => {
    vi.advanceTimersByTime(199);
  });
  expect(result.current).toBe(false);

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current).toBe(true);
});

it('un caricamento che finisce prima di 200 ms non compare mai', () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ caricamento }) => useCaricamentoVisibile(caricamento), {
    initialProps: { caricamento: true },
  });

  act(() => {
    vi.advanceTimersByTime(100);
  });
  rerender({ caricamento: false });

  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(result.current).toBe(false);
});

it('un caricamento finito a 250 ms resta visibile fino a 600 ms, poi sparisce', () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ caricamento }) => useCaricamentoVisibile(caricamento), {
    initialProps: { caricamento: true },
  });

  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(result.current).toBe(true);

  act(() => {
    vi.advanceTimersByTime(50); // t = 250 ms: il caricamento finisce qui
  });
  rerender({ caricamento: false });

  act(() => {
    vi.advanceTimersByTime(349); // t = 599 ms: ancora dentro i 400 ms minimi dalla comparsa (200 ms)
  });
  expect(result.current).toBe(true);

  act(() => {
    vi.advanceTimersByTime(1); // t = 600 ms
  });
  expect(result.current).toBe(false);
});

it('un nuovo caricamento dopo che il precedente è sparito riparte da zero', () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ caricamento }) => useCaricamentoVisibile(caricamento), {
    initialProps: { caricamento: true },
  });

  act(() => {
    vi.advanceTimersByTime(200);
  });
  rerender({ caricamento: false });
  act(() => {
    vi.advanceTimersByTime(400); // t = 600 ms: sparito
  });
  expect(result.current).toBe(false);

  rerender({ caricamento: true });
  act(() => {
    vi.advanceTimersByTime(199);
  });
  expect(result.current).toBe(false);

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current).toBe(true);
});
