import { describe, it, expect } from 'vitest';
import {
  parseSettingsDatabase, variantiInRotazione, scegliVariante, sidDatabaseDaEnv, tuttiISidDatabase,
  varianteDaTemplateSid, varianteDellaChat, testoAperturaDatabase, eNonMiInteressa, isChatDatabase,
  databaseContextNote, notaNonInteressaDatabase,
  VARIANTI_DATABASE, ENV_KEYS_DATABASE, FINE_VARIANTE_BF_MS, FUNNEL_CHAT_DATABASE,
  TETTO_GIORNO_DEFAULT, TETTO_NUMERO_DEFAULT, type VarianteDatabase,
} from './database-bot';

const ENV = {
  DATABASE_OPENING_SID_BF: 'HXbf', DATABASE_OPENING_SID_A: 'HXa', DATABASE_OPENING_SID_B: 'HXb',
  DATABASE_OPENING_SID_C: 'HXc', DATABASE_OPENING_SID_D: 'HXd',
};
const NOV = Date.parse('2026-11-12T10:00:00+01:00');

describe('impostazioni database_bot', () => {
  it('assente o illeggibile = spento, con i tetti di default', () => {
    for (const raw of [undefined, null, 'on', 7, [], true]) {
      const s = parseSettingsDatabase(raw);
      expect(s.attivo).toBe(false);
      expect(s.tettoGiorno).toBe(TETTO_GIORNO_DEFAULT);
      expect(s.tettoNumero).toBe(TETTO_NUMERO_DEFAULT);
    }
    expect(TETTO_GIORNO_DEFAULT).toBe(30);
    expect(TETTO_NUMERO_DEFAULT).toBe(6);
  });

  it('acceso solo con un si\' esplicito', () => {
    expect(parseSettingsDatabase({ attivo: true }).attivo).toBe(true);
    expect(parseSettingsDatabase({ attivo: 'on' }).attivo).toBe(true);
    expect(parseSettingsDatabase({ attivo: 'off' }).attivo).toBe(false);
    expect(parseSettingsDatabase({ attivo: 1 }).attivo).toBe(false);
    expect(parseSettingsDatabase({}).attivo).toBe(false);
  });

  it('tetti impostabili; un valore sporco vale il default, mai "senza tetto"', () => {
    expect(parseSettingsDatabase({ attivo: true, tetto_giorno: 60, tetto_numero: 10 })).toMatchObject({ tettoGiorno: 60, tettoNumero: 10 });
    expect(parseSettingsDatabase({ tetto_giorno: '45' }).tettoGiorno).toBe(45);
    expect(parseSettingsDatabase({ tetto_giorno: -1, tetto_numero: 'tanti' })).toMatchObject({ tettoGiorno: 30, tettoNumero: 6 });
    expect(parseSettingsDatabase({ tetto_giorno: 0 }).tettoGiorno).toBe(0);
  });

  it('varianti: assente = tutte e cinque; scritta = solo quelle, nell\'ordine canonico', () => {
    expect(parseSettingsDatabase({ attivo: true }).varianti).toEqual(['bf', 'a', 'b', 'c', 'd']);
    expect(parseSettingsDatabase({ varianti: ['d', 'A', ' bf ', 'zzz', 3] }).varianti).toEqual(['bf', 'a', 'd']);
    expect(parseSettingsDatabase({ varianti: [] }).varianti).toEqual([]);
  });
});

describe('varianti in rotazione', () => {
  const tutte = parseSettingsDatabase({ attivo: true });

  it('tutte e cinque da subito, se hanno il SID in env', () => {
    expect(variantiInRotazione({ settings: tutte, nowMs: NOV, env: ENV })).toEqual(['bf', 'a', 'b', 'c', 'd']);
  });

  it('una variante senza SID in env non gira', () => {
    expect(variantiInRotazione({ settings: tutte, nowMs: NOV, env: { ...ENV, DATABASE_OPENING_SID_C: '' } })).toEqual(['bf', 'a', 'b', 'd']);
    expect(variantiInRotazione({ settings: tutte, nowMs: NOV, env: {} })).toEqual([]);
  });

  it('spegnere una variante = toglierla dalla lista', () => {
    const s = parseSettingsDatabase({ attivo: true, varianti: ['bf', 'b'] });
    expect(variantiInRotazione({ settings: s, nowMs: NOV, env: ENV })).toEqual(['bf', 'b']);
  });

  it('la bf esce da sola dal 1/12/2026, anche se resta in lista', () => {
    expect(variantiInRotazione({ settings: tutte, nowMs: FINE_VARIANTE_BF_MS, env: ENV })).toContain('bf');
    expect(variantiInRotazione({ settings: tutte, nowMs: Date.parse('2026-11-30T23:00:00+01:00'), env: ENV })).toContain('bf');
    expect(variantiInRotazione({ settings: tutte, nowMs: Date.parse('2026-12-01T00:00:00+01:00'), env: ENV })).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('scegliVariante: ripartizione stabile per id della chat', () => {
  it('stessa chat, stessa variante', () => {
    expect(scegliVariante(40123, VARIANTI_DATABASE)).toBe(scegliVariante(40123, VARIANTI_DATABASE));
  });

  it('uniforme: 1.000 chat consecutive si dividono in parti uguali', () => {
    const conta: Record<string, number> = {};
    for (let id = 50_000; id < 51_000; id++) {
      const v = scegliVariante(id, VARIANTI_DATABASE) as VarianteDatabase;
      conta[v] = (conta[v] ?? 0) + 1;
    }
    expect(conta).toEqual({ bf: 200, a: 200, b: 200, c: 200, d: 200 });
  });

  it('solo fra le disponibili, qualunque sia l\'ordine in cui arrivano', () => {
    const due: VarianteDatabase[] = ['d', 'a'];
    const viste = new Set<string>();
    for (let id = 1; id <= 20; id++) viste.add(scegliVariante(id, due) as string);
    expect([...viste].sort()).toEqual(['a', 'd']);
    expect(scegliVariante(4, ['d', 'a'])).toBe(scegliVariante(4, ['a', 'd']));
    expect(scegliVariante(7, ['c'])).toBe('c');
  });

  it('nessuna disponibile = null', () => {
    expect(scegliVariante(1, [])).toBeNull();
  });
});

describe('SID e variante della chat', () => {
  it('i nomi delle env sono cinque, uno per variante', () => {
    expect(ENV_KEYS_DATABASE).toEqual([
      'DATABASE_OPENING_SID_BF', 'DATABASE_OPENING_SID_A', 'DATABASE_OPENING_SID_B',
      'DATABASE_OPENING_SID_C', 'DATABASE_OPENING_SID_D',
    ]);
  });

  it('senza env non c\'e\' nessun SID database (spento = niente di nuovo negli sblocchi)', () => {
    expect(sidDatabaseDaEnv({})).toEqual({});
    expect(tuttiISidDatabase({})).toEqual([]);
  });

  it('la variante si rilegge dal primo template database della cronologia', () => {
    expect(varianteDaTemplateSid('HXc', ENV)).toBe('c');
    expect(varianteDaTemplateSid('HXaltro', ENV)).toBeNull();
    expect(varianteDaTemplateSid(null, ENV)).toBeNull();
    expect(varianteDellaChat([
      { direction: 'out', template_sid: 'HXb' },
      { direction: 'in', template_sid: null },
      { direction: 'out', template_sid: null },
    ], ENV)).toBe('b');
    expect(varianteDellaChat([{ direction: 'out', template_sid: 'HXapertura_marta' }], ENV)).toBeNull();
  });

  it('il segno sulla chat non e\' il funnel "Database" del CRM', () => {
    expect(isChatDatabase(FUNNEL_CHAT_DATABASE)).toBe(true);
    expect(isChatDatabase(' database bot ')).toBe(true);
    expect(isChatDatabase('Database')).toBe(false);
    expect(isChatDatabase('DATABASE')).toBe(false);
    expect(isChatDatabase(null)).toBe(false);
  });
});

describe('testi', () => {
  it('ogni apertura porta il nome e si presenta come Marta', () => {
    for (const v of VARIANTI_DATABASE) {
      const t = testoAperturaDatabase(v, 'Giulia');
      expect(t.startsWith('Ciao Giulia, sono Marta di Fenice Academy. Tempo fa ci avevi chiesto informazioni sulle professioni digitali')).toBe(true);
      expect(t).not.toContain('{{');
    }
    expect(testoAperturaDatabase('bf', 'Giulia')).toContain('Fino al 30 novembre i nostri percorsi sono in offerta Black Friday');
    expect(testoAperturaDatabase('a', 'Giulia')).not.toContain('Black Friday');
  });

  it('"Non mi interessa" e\' solo il titolo del pulsante', () => {
    expect(eNonMiInteressa('Non mi interessa')).toBe(true);
    expect(eNonMiInteressa('  non mi  interessa. ')).toBe(true);
    expect(eNonMiInteressa('NON MI INTERESSA!')).toBe(true);
    expect(eNonMiInteressa('Non mi interessa adesso, magari a gennaio')).toBe(false);
    expect(eNonMiInteressa('Mi interessa')).toBe(false);
    expect(eNonMiInteressa('')).toBe(false);
    expect(eNonMiInteressa(null)).toBe(false);
  });

  it('la nota al CRM dice la variante', () => {
    expect(notaNonInteressaDatabase('c')).toContain('(variante c)');
    expect(notaNonInteressaDatabase(null)).not.toContain('variante');
  });
});

describe('nota di contesto per Marta', () => {
  it('sempre: lead vecchio ricontattato da noi', () => {
    for (const v of [...VARIANTI_DATABASE, null]) {
      const n = databaseContextNote({ variante: v, offertaBfNelPrompt: false });
      expect(n).toContain('LEAD DI DATABASE RICONTATTATO');
      expect(n).toContain('le abbiamo scritto NOI');
    }
  });

  it('varianti a-d: nessun accenno al Black Friday', () => {
    for (const v of ['a', 'b', 'c', 'd'] as const) {
      expect(databaseContextNote({ variante: v, offertaBfNelPrompt: true })).not.toContain('Black Friday');
    }
  });

  it('variante bf: sa che l\'offerta e\' gia\' stata nominata', () => {
    const conFatti = databaseContextNote({ variante: 'bf', offertaBfNelPrompt: true });
    expect(conFatti).toContain("OFFERTA GIA' NOMINATA");
    expect(conFatti).toContain('fino al 30 novembre');
    const senzaFatti = databaseContextNote({ variante: 'bf', offertaBfNelPrompt: false });
    expect(senzaFatti).toContain('non inventarli');
  });
});
