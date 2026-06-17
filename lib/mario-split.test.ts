import { describe, it, expect } from 'vitest';
import { splitMarioMessages } from './mario-split';

describe('splitMarioMessages', () => {
  it('divide su righe vuote', () => {
    expect(splitMarioMessages('ciao\n\ncome stai?')).toEqual(['ciao', 'come stai?']);
  });
  it('divide anche su singolo a capo', () => {
    expect(splitMarioMessages('ciao\ncome stai?')).toEqual(['ciao', 'come stai?']);
  });
  it('messaggio singolo resta uno', () => {
    expect(splitMarioMessages('ciao come stai?')).toEqual(['ciao come stai?']);
  });
  it('rimuove spazi e righe vuote multiple', () => {
    expect(splitMarioMessages('  uno  \n\n\n  due ')).toEqual(['uno', 'due']);
  });
  it('vuoto -> array vuoto', () => {
    expect(splitMarioMessages('   ')).toEqual([]);
  });
});
