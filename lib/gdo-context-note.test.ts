import { describe, it, expect } from 'vitest';
import { gdoContextNote, serveNoemi, oraAppuntamento, NOTA_VIDEO, NOTA_NOEMI, type GdoNoteInput } from './gdo-context-note';
import { GDO_CONTEXT_NOTE } from './mario';

const base = (over: Partial<GdoNoteInput> = {}): GdoNoteInput => ({
  gdoVideoSentAt: '2026-08-01T15:00:00Z',
  gdoVideoWatchedAt: null,
  gdoNoemiRemindedAt: null,
  followupsSent: 0,
  videoAppenaConfermato: false,
  ...over,
});

describe('gdoContextNote', () => {
  it('parte sempre dal contesto postino esistente', () => {
    expect(gdoContextNote(base())).toContain(GDO_CONTEXT_NOTE);
  });

  it('ricorda il video finché non è confermato', () => {
    expect(gdoContextNote(base())).toContain(NOTA_VIDEO);
  });

  it('non lo ricorda più una volta confermato', () => {
    expect(gdoContextNote(base({ gdoVideoWatchedAt: '2026-08-01T20:00:00Z' }))).not.toContain(NOTA_VIDEO);
  });

  it('non lo ricorda se il video non è ancora partito', () => {
    expect(gdoContextNote(base({ gdoVideoSentAt: null }))).not.toContain(NOTA_VIDEO);
  });
});

describe('serveNoemi', () => {
  it('mai quando esce il recap: Noemi la porta il recap', () => {
    expect(serveNoemi(base({ videoAppenaConfermato: true, recapInUscita: true }))).toBe(false);
    expect(gdoContextNote(base({ videoAppenaConfermato: true, recapInUscita: true }))).not.toContain('PROMEMORIA NOEMI');
  });

  it('quando il lead conferma di aver visto il video', () => {
    expect(serveNoemi(base({ videoAppenaConfermato: true }))).toBe(true);
  });

  it('quando risponde dopo che gli è arrivato un sollecito', () => {
    expect(serveNoemi(base({ followupsSent: 1 }))).toBe(true);
  });

  it('mai due volte', () => {
    expect(serveNoemi(base({ videoAppenaConfermato: true, gdoNoemiRemindedAt: '2026-08-01T20:00:00Z' }))).toBe(false);
  });

  it('non a chi non ha ancora fatto niente', () => {
    expect(serveNoemi(base())).toBe(false);
  });
});

describe('contenuto del promemoria Noemi', () => {
  it('dice la durata vera, non "pochi minuti"', () => {
    expect(NOTA_NOEMI).toContain('5-10 minuti');
    expect(NOTA_NOEMI).not.toContain('pochi minuti');
  });

  it('dice che è il passaggio che conferma l\'appuntamento', () => {
    expect(NOTA_NOEMI).toContain('serve a confermare la videochiamata');
  });

  it('ammette che il collega gliene ha già parlato', () => {
    expect(NOTA_NOEMI).toContain('collega');
  });

  it('dice chiaro che deve rispondere, e come rimediare se la chiamata gli scappa', () => {
    expect(NOTA_NOEMI).toContain('se non risponde la videochiamata non è confermata');
    expect(NOTA_NOEMI).toContain('la richiami subito');
  });

  it('scrive il giorno della chiamata di Noemi per intero, col numero', () => {
    const mattina = gdoContextNote(base({ videoAppenaConfermato: true, gdoAppuntamentoAt: '2026-10-23T10:00:00+02:00', fissatoIl: new Date('2026-10-20T11:00:00+02:00') }));
    expect(mattina).toContain('la call è venerdì 23 alle 10:00');
    expect(mattina).toContain('giovedì 22');
    const sera = gdoContextNote(base({ videoAppenaConfermato: true, gdoAppuntamentoAt: '2026-10-23T18:00:00+02:00' }));
    expect(sera).toContain('lo stesso giorno, venerdì 23');
  });

  it('compare nella nota solo quando serve', () => {
    expect(gdoContextNote(base({ videoAppenaConfermato: true }))).toContain(NOTA_NOEMI);
    expect(gdoContextNote(base())).not.toContain(NOTA_NOEMI);
  });
});

describe('gdoContextNote — il video sta uscendo adesso', () => {
  const base = { gdoVideoSentAt: null, gdoVideoWatchedAt: null, gdoNoemiRemindedAt: null, followupsSent: 0, videoAppenaConfermato: false };

  it('con videoInUscita non dice al modello che il video è già stato mandato', () => {
    const n = gdoContextNote({ ...base, videoInUscita: true });
    expect(n).toContain('IL VIDEO ESCE ORA');
    expect(n).not.toContain('e il video da vedere prima della call');
  });

  it('con videoInUscita non chiede anche il promemoria video: sarebbe un doppione', () => {
    const n = gdoContextNote({ ...base, gdoVideoSentAt: '2026-08-06T10:00:00Z', videoInUscita: true });
    expect(n).not.toContain(NOTA_VIDEO);
  });

  it('vieta al modello di scrivere lui il link', () => {
    expect(gdoContextNote({ ...base, videoInUscita: true })).toMatch(/non mandare nessun link/i);
  });

  it('senza il flag il comportamento è quello di oggi', () => {
    const n = gdoContextNote({ ...base, gdoVideoSentAt: '2026-08-06T10:00:00Z' });
    expect(n).toContain(NOTA_VIDEO);
    expect(n).not.toContain('IL VIDEO ESCE ORA');
  });
});

const baseNoemi = {
  gdoVideoSentAt: '2026-09-09T10:00:00Z',
  gdoVideoWatchedAt: '2026-09-09T11:00:00Z',
  gdoNoemiRemindedAt: null,
  followupsSent: 0,
  videoAppenaConfermato: true,
};

// PO 24/10/2026: dal 27/10 Noemi attacca alle 9 e le call del mattino si chiamano la
// mattina stessa. Il giorno prima si chiamano solo quelle fissate con anticipo (e le 9).
describe('nota Noemi: dipende dall ora dell appuntamento e da quanto manca', () => {
  const now = new Date('2026-10-26T11:00:00+01:00'); // lunedì 26/10, quando si fissa
  const nota = (iso: string, extra: Partial<GdoNoteInput> = {}) =>
    gdoContextNote({ ...baseNoemi, botScheduledAt: iso, gdoAppuntamentoAt: null, fissatoIl: now, ...extra });

  it('mattina di domani: la mattina stessa, dalle 9', () => {
    const n = nota('2026-10-27T10:00:00+01:00');
    expect(n).toContain('la mattina stessa, martedì 27 dalle 9');
    expect(n).not.toContain('il giorno prima');
  });

  it('mattina di dopodomani: il giorno prima, e se non lo trova la mattina stessa', () => {
    const n = nota('2026-10-28T11:00:00+01:00');
    expect(n).toContain('il giorno prima, martedì 27');
    expect(n).toContain('la mattina stessa, mercoledì 28 dalle 9');
  });

  it('le 14 di domani sono ancora mattina: la mattina stessa', () => {
    expect(nota('2026-10-27T14:00:00+01:00')).toContain('la mattina stessa');
  });

  it('le 9: sempre il giorno prima, mai la mattina stessa', () => {
    const n = nota('2026-10-27T09:00:00+01:00');
    expect(n).toContain('il giorno prima, lunedì 26');
    expect(n).not.toContain('la mattina stessa');
  });

  it('le 9 fissate dopo le 19 del giorno prima: alle 9 in punto, non il giorno prima', () => {
    const n = nota('2026-10-30T09:00:00+01:00', { fissatoIl: new Date('2026-10-29T20:30:00+01:00') });
    expect(n).toContain('alle 9 in punto');
    expect(n).not.toContain('il giorno prima, ');
  });

  it('il giorno prima di un lunedì è il sabato, non la domenica', () => {
    const giovedi = new Date('2026-10-22T11:00:00+02:00');
    const n = nota('2026-10-26T09:00:00+01:00', { fissatoIl: giovedi });
    expect(n).toContain('il giorno prima, sabato 24');
  });

  it('dalle 15 in poi: lo stesso giorno, qualche ora prima (invariato)', () => {
    for (const iso of ['2026-10-27T15:00:00+01:00', '2026-10-27T18:00:00+01:00', '2026-10-28T16:00:00+01:00']) {
      const n = nota(iso);
      expect(n).toContain('lo stesso giorno');
      expect(n).not.toContain('il giorno prima');
    }
  });

  it('non dice più che Noemi la mattina non chiama', () => {
    const n = nota('2026-10-27T10:00:00+01:00');
    expect(n).not.toContain('non la mattina della call');
    expect(n).not.toContain('nel pomeriggio');
  });

  it('vince la data piu recente fra le due colonne', () => {
    const n = nota('2026-10-27T10:00:00+01:00', { gdoAppuntamentoAt: '2026-10-28T16:00:00+01:00' });
    expect(n).toContain('lo stesso giorno');
  });

  it('senza nessuna data non inventa un orario', () => {
    const n = gdoContextNote({ ...baseNoemi, botScheduledAt: null, gdoAppuntamentoAt: null, fissatoIl: now });
    expect(n).not.toContain('il giorno prima');
    expect(n).not.toContain('lo stesso giorno');
    expect(n).toContain('PROMEMORIA NOEMI');
  });
});

describe('oraAppuntamento', () => {
  it('torna null quando non c e nessuna data valida', () => {
    expect(oraAppuntamento(null, null)).toBeNull();
    expect(oraAppuntamento('non-una-data', null)).toBeNull();
  });
});

describe('gdoContextNote: riscaldamento', () => {
  it('nessuna istruzione di riscaldamento al modello: le domande le scrive il codice', () => {
    expect(gdoContextNote(base({}))).not.toMatch(/RISCALDAMENTO/i);
  });
});
