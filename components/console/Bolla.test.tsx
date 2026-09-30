// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Msg } from '@/lib/console/thread';
import { Bolla } from './Bolla';

const m = (body: string): Msg => ({
  id: 1, direction: 'in', body, created_at: '2026-09-25T10:12:00Z', is_template: false, twilio_status: null, twilio_error_code: null, sender: null,
});

it('un messaggio senza testo non è una bolla vuota: dice che è un allegato', () => {
  const { container } = render(<Bolla m={m('  ')} primo />);
  expect(container.querySelector('.b')?.textContent).toMatch(/senza testo/);
});

it('il testo resta com\'è', () => {
  const { container } = render(<Bolla m={m('Ciao')} primo />);
  expect(container.querySelector('.b')?.textContent).toBe('Ciao');
});
