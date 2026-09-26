// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

afterEach(() => {
  document.body.innerHTML = '';
});

const now = new Date('2026-10-05T19:30:00Z');

function monta(onInvia: (t: string) => Promise<boolean>) {
  render(
    <Composer inPausa lastInboundAt="2026-10-05T19:14:00Z" now={now} pausaInCorso={false} onPausa={() => {}} onInvia={onInvia} />,
  );
  return screen.getByLabelText('Messaggio al lead') as HTMLTextAreaElement;
}

it('due Ctrl+Invio ravvicinati inviano una volta sola', async () => {
  let chiudi!: (ok: boolean) => void;
  const onInvia = vi.fn(() => new Promise<boolean>((r) => (chiudi = r)));
  const campo = monta(onInvia);
  fireEvent.change(campo, { target: { value: 'Ciao Giulia' } });
  // Nello stesso act: React non ridisegna tra i due tasti, lo stato `invio` è ancora false.
  act(() => {
    fireEvent.keyDown(campo, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(campo, { key: 'Enter', ctrlKey: true });
  });
  expect(onInvia).toHaveBeenCalledTimes(1);
  expect(onInvia).toHaveBeenCalledWith('Ciao Giulia');
  await act(async () => chiudi(true));
  expect(campo.value).toBe('');
});

it('Invio da solo non invia (va a capo)', () => {
  const onInvia = vi.fn(async () => true);
  const campo = monta(onInvia);
  fireEvent.change(campo, { target: { value: 'riga' } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  expect(onInvia).not.toHaveBeenCalled();
});

it('se l\'invio fallisce il testo resta nel campo', async () => {
  const onInvia = vi.fn(async () => false);
  const campo = monta(onInvia);
  fireEvent.change(campo, { target: { value: 'da rimandare' } });
  await act(async () => {
    fireEvent.keyDown(campo, { key: 'Enter', ctrlKey: true });
  });
  expect(campo.value).toBe('da rimandare');
});
