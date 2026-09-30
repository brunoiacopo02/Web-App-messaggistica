// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Cifre } from './Cifre';

it('il punto delle migliaia sta nel suo span stretto, il testo resta quello italiano', () => {
  const { container } = render(<p><Cifre n={10860} /></p>);
  expect(container.textContent).toBe('10.860');
  expect(container.querySelectorAll('.sep')).toHaveLength(1);
});

it('milioni: due separatori; sotto il mille nessuno; il suffisso resta in coda', () => {
  const { container: a } = render(<p><Cifre n={1234567} /></p>);
  expect(a.textContent).toBe('1.234.567');
  expect(a.querySelectorAll('.sep')).toHaveLength(2);
  const { container: b } = render(<p><Cifre n={999} suffisso="+" /></p>);
  expect(b.textContent).toBe('999+');
  expect(b.querySelectorAll('.sep')).toHaveLength(0);
});

it('Orario: i due punti nel loro span stretto, il testo invariato', async () => {
  const { Orario } = await import('./Cifre');
  const { container } = render(<p><Orario testo="18:12" /></p>);
  expect(container.textContent).toBe('18:12');
  expect(container.querySelectorAll('.sep')).toHaveLength(1);
});
