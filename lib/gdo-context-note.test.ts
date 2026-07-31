import { describe, it, expect } from 'vitest';
import { gdoContextNote, serveNoemi, NOTA_VIDEO, NOTA_NOEMI, type GdoNoteInput } from './gdo-context-note';
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
    expect(NOTA_NOEMI).toContain("conferma l'appuntamento");
  });

  it('ammette che il collega gliene ha già parlato', () => {
    expect(NOTA_NOEMI).toContain('collega');
  });

  it('non minaccia il lead', () => {
    expect(NOTA_NOEMI).toContain('non è un problema');
  });

  it('compare nella nota solo quando serve', () => {
    expect(gdoContextNote(base({ videoAppenaConfermato: true }))).toContain(NOTA_NOEMI);
    expect(gdoContextNote(base())).not.toContain(NOTA_NOEMI);
  });
});
