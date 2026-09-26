// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { Errore } from './Stato';
import { SkeletonRighe } from './Skeleton';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('Errore mostra titolo, testo e chiama onRiprova al click su Riprova', () => {
  const onRiprova = vi.fn();
  render(<Errore titolo="Non riesco a caricare" testo="La rete non risponde." onRiprova={onRiprova} />);

  expect(screen.getByText('Non riesco a caricare')).toBeInTheDocument();
  expect(screen.getByText('La rete non risponde.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /riprova/i }));
  expect(onRiprova).toHaveBeenCalledTimes(1);
});

it('SkeletonRighe non rende nulla prima di 200 ms', () => {
  vi.useFakeTimers();
  const { container } = render(<SkeletonRighe righe={3} altezza={56} />);
  expect(container).toBeEmptyDOMElement();

  act(() => {
    vi.advanceTimersByTime(199);
  });
  expect(container).toBeEmptyDOMElement();

  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(container.querySelectorAll('.skel-riga')).toHaveLength(3);
});
