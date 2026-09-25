import { describe, it, expect } from 'vitest';
import { convDaSegnareLetta } from './segna-letta';

const items = [
  { id: 1, unread_count: 3 },
  { id: 2, unread_count: 0 },
  { id: 3, unread_count: null },
];

describe('convDaSegnareLetta', () => {
  it('nessuna chat aperta: niente da segnare', () => {
    expect(convDaSegnareLetta(undefined, items, new Map())).toBeNull();
  });

  it('chat aperta con messaggi non letti: va segnata', () => {
    expect(convDaSegnareLetta('1', items, new Map())).toEqual({ id: 1, count: 3 });
  });

  it('chat aperta gia letta (0 o null): niente richiesta', () => {
    expect(convDaSegnareLetta('2', items, new Map())).toBeNull();
    expect(convDaSegnareLetta('3', items, new Map())).toBeNull();
  });

  it('chat aperta che non e nella lista: niente richiesta', () => {
    expect(convDaSegnareLetta('99', items, new Map())).toBeNull();
  });

  it('stesso contatore gia inviato: non si rimanda a ogni polling', () => {
    expect(convDaSegnareLetta('1', items, new Map([[1, 3]]))).toBeNull();
  });

  it('il lead scrive mentre la chat e aperta: il contatore nuovo si rimanda', () => {
    const dopo = [{ id: 1, unread_count: 4 }];
    expect(convDaSegnareLetta('1', dopo, new Map([[1, 3]]))).toEqual({ id: 1, count: 4 });
  });
});
