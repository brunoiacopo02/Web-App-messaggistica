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

  it('fenice-only: blocca route sibling con prefisso simile', () => {
    expect(canAccess('fenicebot@fenice.com', '/fenice-admin')).toBe(false);
    expect(canAccess('fenicebot@fenice.com', '/fenice/live')).toBe(true);
    expect(canAccess('fenicebot@fenice.com', '/api/fenice/sim')).toBe(true);
  });
});

describe('area campagne', () => {
  it('campagne vede solo /campagne-chat', () => {
    expect(areaForEmail('campagne@fenice.com')).toBe('campagne');
    expect(canAccess('campagne@fenice.com', '/campagne-chat')).toBe(true);
    expect(canAccess('campagne@fenice.com', '/campagne-chat/42')).toBe(true);
    expect(canAccess('campagne@fenice.com', '/api/campagne-chat/conversations')).toBe(true);
    expect(canAccess('campagne@fenice.com', '/inbox')).toBe(false);
    expect(canAccess('campagne@fenice.com', '/fenice')).toBe(false);
    expect(canAccess('campagne@fenice.com', '/api/conversations')).toBe(false);
    expect(canAccess('campagne@fenice.com', '/api/messages')).toBe(false);
    expect(canAccess('campagne@fenice.com', '/campagne')).toBe(false);
    expect(landingPath('campagne@fenice.com')).toBe('/campagne-chat');
  });
  it('fenicebot non vede /campagne-chat', () => {
    expect(canAccess('fenicebot@fenice.com', '/campagne-chat')).toBe(false);
  });
  it('gli account all vedono anche /campagne-chat', () => {
    expect(canAccess('brunoiacopo02@gmail.com', '/campagne-chat')).toBe(true);
  });
});
