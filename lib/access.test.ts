import { describe, it, expect } from 'vitest';
import { areaForEmail, canAccess, landingPath } from './access';

describe('access map', () => {
  it('fenicebot vede solo fenice', () => {
    expect(areaForEmail('fenicebot@fenice.com')).toBe('fenice');
    expect(canAccess('fenicebot@fenice.com', '/fenice')).toBe(true);
    expect(canAccess('fenicebot@fenice.com', '/inbox')).toBe(false);
    expect(landingPath('fenicebot@fenice.com')).toBe('/fenice');
  });

  it('utente normale vede CRM + fenice', () => {
    expect(areaForEmail('brunoiacopo02@gmail.com')).toBe('all');
    expect(canAccess('brunoiacopo02@gmail.com', '/inbox')).toBe(true);
    expect(canAccess('brunoiacopo02@gmail.com', '/fenice')).toBe(true);
    expect(landingPath('brunoiacopo02@gmail.com')).toBe('/inbox');
  });

  it('email sconosciuta: default CRM', () => {
    expect(areaForEmail('x@y.com')).toBe('all');
    expect(canAccess('x@y.com', '/fenice')).toBe(true);
  });
});
