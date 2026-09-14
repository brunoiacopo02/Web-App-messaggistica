import { describe, it, expect } from 'vitest';
import { buildLancioSystem } from './lancio-prompt';

const base = { fase: 'attesa', nome: 'ANNA BIANCHI', eventoAt: '2026-10-05T21:00:00+02:00' };

describe('buildLancioSystem — fase attesa', () => {
  const s = buildLancioSystem(base);

  it('si dichiara assistente virtuale (AI Act art. 50) e usa il solo nome proprio', () => {
    expect(s).toMatch(/assistente virtuale/i);
    expect(s).toContain('Anna');
    expect(s).not.toContain('BIANCHI');
  });
  it('dice data e ora della live in italiano', () => {
    expect(s).toContain('lunedì 5 ottobre alle 21:00');
  });
  it('gratuito, niente prezzi, "ne parliamo dopo la live"', () => {
    expect(s).toMatch(/gratuit/i);
    expect(s).toMatch(/prezzi non li dici mai/i);
    expect(s).toMatch(/ne parliamo dopo la live/i);
  });
  it('spiega i tre tag e il passaggio umano', () => {
    for (const tag of ['[LANCIO:SI]', '[LANCIO:NO]', '[LANCIO:DOMANDA]', '[PASSAGGIO_UMANO]']) expect(s).toContain(tag);
  });
  it('sulla logistica non promette che non serve installare niente: dice Zoom da telefono o computer', () => {
    expect(s).not.toMatch(/non serve installare niente/i);
    expect(s).toMatch(/da telefono conviene avere l'app Zoom/);
  });
  it('non promette registrazioni né replay', () => {
    expect(s).toMatch(/non prometti NESSUNA registrazione né replay/);
    expect(s).toMatch(/in diretta/i);
  });
  it('dà del tu, risponde in italiano, niente markdown, tetto di parole', () => {
    expect(s).toMatch(/Dai sempre del tu e rispondi sempre in italiano/);
    expect(s).toMatch(/Niente asterischi, niente markdown, niente trattino lungo; al massimo 35 parole/);
  });
  it('non chiede il nome né dati personali', () => {
    expect(s).toMatch(/non chiederglielo e non inventarlo/);
    expect(s).toMatch(/Non chiedere mai dati personali/);
  });
  it('una domanda vince sul sì e il posto si blocca solo con [LANCIO:SI]', () => {
    expect(s).toMatch(/contiene una domanda è sempre \[LANCIO:DOMANDA\]/);
    expect(s).toMatch(/il posto si blocca solo con \[LANCIO:SI\]/);
  });
  it('non contiene nulla del prompt di Mario: jotform, quote, call, video', () => {
    expect(s).not.toMatch(/jotform|1\.000|3\.000|noemi|conferenza-|form\.jotform/i);
    expect(s).toMatch(/Non proporre MAI una chiamata, una call, un video, un modulo/);
  });
});

describe('buildLancioSystem — fase posto_bloccato e ripieghi', () => {
  it('in posto_bloccato dice al modello che il posto è già bloccato', () => {
    expect(buildLancioSystem({ ...base, fase: 'posto_bloccato' })).toMatch(/GIÀ confermato/);
    expect(buildLancioSystem(base)).not.toMatch(/GIÀ confermato/);
  });
  it('senza nome usabile non inventa un nome', () => {
    const s = buildLancioSystem({ ...base, nome: 'azienda srl' });
    expect(s).toContain('una persona');
  });
  it('senza data in impostazioni usa il 5 ottobre alle 21', () => {
    expect(buildLancioSystem({ ...base, eventoAt: null })).toContain('lunedì 5 ottobre alle 21:00');
    expect(buildLancioSystem({ ...base, eventoAt: 'boh' })).toContain('lunedì 5 ottobre alle 21:00');
  });
});
