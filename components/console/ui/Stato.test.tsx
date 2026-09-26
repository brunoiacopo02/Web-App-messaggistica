// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Errore } from './Stato';
import { SkeletonRighe } from './Skeleton';

it('Errore mostra titolo, testo e chiama onRiprova al click su Riprova', () => {
  const onRiprova = vi.fn();
  render(<Errore titolo="Non riesco a caricare" testo="La rete non risponde." onRiprova={onRiprova} />);

  expect(screen.getByText('Non riesco a caricare')).toBeInTheDocument();
  expect(screen.getByText('La rete non risponde.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /riprova/i }));
  expect(onRiprova).toHaveBeenCalledTimes(1);
});

it('SkeletonRighe è presentazionale: rende subito il numero di righe passato', () => {
  const { container } = render(<SkeletonRighe righe={3} altezza={56} />);
  expect(container.querySelectorAll('.skel-riga')).toHaveLength(3);
});
