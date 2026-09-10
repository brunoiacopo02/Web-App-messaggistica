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

describe('nota Noemi: dipende dall ora dell appuntamento', () => {
  it('appuntamento di mattina: Noemi chiama il pomeriggio prima', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T10:00:00+02:00',
      gdoAppuntamentoAt: null,
    });
    expect(nota).toContain('il pomeriggio del giorno prima');
    expect(nota).not.toContain('lo stesso giorno');
  });

  it('appuntamento di pomeriggio: Noemi chiama lo stesso giorno', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T16:00:00+02:00',
      gdoAppuntamentoAt: null,
    });
    expect(nota).toContain('lo stesso giorno');
  });

  it('appuntamento alle 13:00: sotto soglia, Noemi chiama il giorno prima', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T13:00:00+02:00',
      gdoAppuntamentoAt: null,
    });
    expect(nota).toContain('il pomeriggio del giorno prima');
    expect(nota).not.toContain('lo stesso giorno');
  });

  it('appuntamento alle 14:00: sotto soglia, Noemi chiama il giorno prima', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T14:00:00+02:00',
      gdoAppuntamentoAt: null,
    });
    expect(nota).toContain('il pomeriggio del giorno prima');
    expect(nota).not.toContain('lo stesso giorno');
  });

  it('appuntamento alle 15:00: soglia raggiunta, Noemi chiama lo stesso giorno', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T15:00:00+02:00',
      gdoAppuntamentoAt: null,
    });
    expect(nota).toContain('lo stesso giorno');
    expect(nota).not.toContain('il pomeriggio del giorno prima');
  });

  it('appuntamento alle 18:00: stesso giorno', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T18:00:00+02:00',
      gdoAppuntamentoAt: null,
    });
    expect(nota).toContain('lo stesso giorno');
    expect(nota).not.toContain('il pomeriggio del giorno prima');
  });

  it('vince la data piu recente fra le due colonne', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T10:00:00+02:00',
      gdoAppuntamentoAt: '2026-09-12T16:00:00+02:00',
    });
    expect(nota).toContain('lo stesso giorno');
  });

  it('senza nessuna data non inventa un orario', () => {
    const nota = gdoContextNote({ ...baseNoemi, botScheduledAt: null, gdoAppuntamentoAt: null });
    expect(nota).not.toContain('il pomeriggio del giorno prima');
    expect(nota).not.toContain('lo stesso giorno');
    expect(nota).toContain('PROMEMORIA NOEMI');
  });
});

describe('oraAppuntamento', () => {
  it('torna null quando non c e nessuna data valida', () => {
    expect(oraAppuntamento(null, null)).toBeNull();
    expect(oraAppuntamento('non-una-data', null)).toBeNull();
  });
});
