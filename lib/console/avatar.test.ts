import { it, expect } from 'vitest';
import { tintaAvatar, iniziali } from './avatar';
it('tinta stabile e nel range', () => {
  expect(tintaAvatar('Giulia Ferraresi')).toBe(tintaAvatar('Giulia Ferraresi'));
  for (const n of ['a', 'Marco', '+39 347', '']) expect([1, 2, 3, 4, 5, 6]).toContain(tintaAvatar(n));
});
it('iniziali', () => {
  expect(iniziali('Giulia Ferraresi')).toBe('GF');
  expect(iniziali('  marco  ')).toBe('M');
  expect(iniziali('Anna Maria De Luca')).toBe('AL');
  expect(iniziali(null)).toBe('');
  expect(iniziali('😀 Sara')).toBe('S');
});
