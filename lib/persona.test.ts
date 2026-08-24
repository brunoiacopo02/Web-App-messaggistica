import { describe, it, expect } from 'vitest';
import {
  normalizeFunnel,
  variantIndexFor,
  openingEnvKey,
  openingBody,
  openingWaysFor,
  personaForConversation,
  PERSONA_NAME,
  OPENING_ENV_KEYS,
  type FunnelKey,
} from './persona';

describe('normalizeFunnel', () => {
  it('CORSO 10 ORE → corso10', () => expect(normalizeFunnel('CORSO 10 ORE')).toBe('corso10'));
  it('TELEGRAM → telegram', () => expect(normalizeFunnel('TELEGRAM')).toBe('telegram'));
  it('TELEGRAM-TK → telegram', () => expect(normalizeFunnel('TELEGRAM-TK')).toBe('telegram'));
  it('JOB SIMULATOR → jobsim', () => expect(normalizeFunnel('JOB SIMULATOR')).toBe('jobsim'));
  it('case-insensitive', () => {
    expect(normalizeFunnel('corso 10 ore')).toBe('corso10');
    expect(normalizeFunnel('Telegram-Tk')).toBe('telegram');
    expect(normalizeFunnel('job simulator')).toBe('jobsim');
  });
  it('trim degli spazi', () => {
    expect(normalizeFunnel('  CORSO 10 ORE  ')).toBe('corso10');
    expect(normalizeFunnel(' TELEGRAM ')).toBe('telegram');
  });
  it('sconosciuto/null/undefined/vuoto → other', () => {
    expect(normalizeFunnel('QUALCOS ALTRO')).toBe('other');
    expect(normalizeFunnel(null)).toBe('other');
    expect(normalizeFunnel(undefined)).toBe('other');
    expect(normalizeFunnel('')).toBe('other');
  });
});

describe('variantIndexFor (4 vie sul resto modulo 4)', () => {
  it('resto 1 → variante 1', () => {
    expect(variantIndexFor(1)).toBe(1);
    expect(variantIndexFor(5)).toBe(1);
    expect(variantIndexFor(1001)).toBe(1);
  });
  it('resto 2 → variante 2', () => {
    expect(variantIndexFor(2)).toBe(2);
    expect(variantIndexFor(6)).toBe(2);
    expect(variantIndexFor(1002)).toBe(2);
  });
  it('resto 3 → variante 3', () => {
    expect(variantIndexFor(3)).toBe(3);
    expect(variantIndexFor(7)).toBe(3);
    expect(variantIndexFor(1003)).toBe(3);
  });
  it('multipli di 4 → variante 4, mai 0', () => {
    expect(variantIndexFor(4)).toBe(4);
    expect(variantIndexFor(0)).toBe(4);
    expect(variantIndexFor(1000)).toBe(4);
  });
  it('distribuisce in quattro gruppi uguali su 400 id consecutivi', () => {
    const conta = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<number, number>;
    for (let id = 1; id <= 400; id++) conta[variantIndexFor(id)]++;
    expect(conta).toEqual({ 1: 100, 2: 100, 3: 100, 4: 100 });
  });
  it('nessun id produce un valore fuori da 1..4', () => {
    for (let id = 0; id < 50; id++) expect([1, 2, 3, 4]).toContain(variantIndexFor(id));
  });
});

describe('variantIndexFor a due vie (template dichiarati assenti)', () => {
  it('dispari → 1, pari → 2, come prima delle varianti dichiarate', () => {
    expect(variantIndexFor(1, 2)).toBe(1);
    expect(variantIndexFor(3, 2)).toBe(1);
    expect(variantIndexFor(2, 2)).toBe(2);
    expect(variantIndexFor(4, 2)).toBe(2);
    expect(variantIndexFor(0, 2)).toBe(2);
  });
  it('non assegna mai una variante dichiarata', () => {
    for (let id = 0; id < 200; id++) expect([1, 2]).toContain(variantIndexFor(id, 2));
  });
  it('riproduce esattamente la vecchia regola di parita su 400 id', () => {
    for (let id = 1; id <= 400; id++) {
      expect(variantIndexFor(id, 2)).toBe(id % 2 !== 0 ? 1 : 2);
    }
  });
});

describe('openingWaysFor', () => {
  const tutti = () => true;
  const nessuno = () => false;

  it('quattro vie solo se esistono ENTRAMBI i SID dichiarati del funnel', () => {
    expect(openingWaysFor('corso10', tutti)).toBe(4);
    expect(openingWaysFor('telegram', tutti)).toBe(4);
    expect(openingWaysFor('jobsim', tutti)).toBe(4);
  });
  it('nessun SID dichiarato → due vie, l A/B storico resta intatto', () => {
    expect(openingWaysFor('corso10', nessuno)).toBe(2);
    expect(openingWaysFor('other', nessuno)).toBe(2);
  });
  it('un solo SID dichiarato su due → due vie, niente mezze attivazioni', () => {
    const soloTre = (k: string) => k.endsWith('3');
    const soloQuattro = (k: string) => k.endsWith('4');
    expect(openingWaysFor('corso10', soloTre)).toBe(2);
    expect(openingWaysFor('corso10', soloQuattro)).toBe(2);
  });
  it('guarda i SID del funnel giusto: telegram pronto non attiva corso10', () => {
    const soloTelegram = (k: string) => k.startsWith('OPENING_SID_T');
    expect(openingWaysFor('telegram', soloTelegram)).toBe(4);
    expect(openingWaysFor('corso10', soloTelegram)).toBe(2);
    expect(openingWaysFor('jobsim', soloTelegram)).toBe(2);
  });
  it('funnel sconosciuto usa i SID di CORSO 10 ORE', () => {
    const soloCorso = (k: string) => k.startsWith('OPENING_SID_C');
    expect(openingWaysFor('other', soloCorso)).toBe(4);
  });
  it('con i SID veri di oggi (solo varianti 1 e 2) tutti i funnel stanno a due vie', () => {
    const configuratiOggi = new Set(['C1', 'C2', 'T1', 'T2', 'J1', 'J2'].map((s) => `OPENING_SID_${s}`));
    const hasSid = (k: string) => configuratiOggi.has(k);
    for (const f of ['corso10', 'telegram', 'jobsim', 'other'] as FunnelKey[]) {
      expect(openingWaysFor(f, hasSid)).toBe(2);
    }
  });
});

describe('openingEnvKey', () => {
  it('corso10 → OPENING_SID_C1/C2', () => {
    expect(openingEnvKey('corso10', 1)).toBe('OPENING_SID_C1');
    expect(openingEnvKey('corso10', 2)).toBe('OPENING_SID_C2');
  });
  it('telegram → OPENING_SID_T1/T2', () => {
    expect(openingEnvKey('telegram', 1)).toBe('OPENING_SID_T1');
    expect(openingEnvKey('telegram', 2)).toBe('OPENING_SID_T2');
  });
  it('jobsim → OPENING_SID_J1/J2', () => {
    expect(openingEnvKey('jobsim', 1)).toBe('OPENING_SID_J1');
    expect(openingEnvKey('jobsim', 2)).toBe('OPENING_SID_J2');
  });
  it('other → fallback su C1/C2', () => {
    expect(openingEnvKey('other', 1)).toBe('OPENING_SID_C1');
    expect(openingEnvKey('other', 2)).toBe('OPENING_SID_C2');
  });
  it('varianti dichiarate 3 e 4 per ogni funnel', () => {
    expect(openingEnvKey('corso10', 3)).toBe('OPENING_SID_C3');
    expect(openingEnvKey('corso10', 4)).toBe('OPENING_SID_C4');
    expect(openingEnvKey('telegram', 3)).toBe('OPENING_SID_T3');
    expect(openingEnvKey('telegram', 4)).toBe('OPENING_SID_T4');
    expect(openingEnvKey('jobsim', 3)).toBe('OPENING_SID_J3');
    expect(openingEnvKey('jobsim', 4)).toBe('OPENING_SID_J4');
    expect(openingEnvKey('other', 3)).toBe('OPENING_SID_C3');
    expect(openingEnvKey('other', 4)).toBe('OPENING_SID_C4');
  });
});

describe('openingBody — testi ESATTI della spec', () => {
  it('C1 con nome', () => {
    expect(openingBody('corso10', 1, 'Luca')).toBe(
      'Ciao Luca, sono Marta di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?',
    );
  });
  it('C2 con nome', () => {
    expect(openingBody('corso10', 2, 'Luca')).toBe(
      "Ciao Luca, Marta di Fenice Academy: il corso di 10 ore è gratuito davvero, l'accesso ti arriva via email. Tu che obiettivo hai: un'entrata extra o un nuovo lavoro da remoto?",
    );
  });
  it('T1 con nome', () => {
    expect(openingBody('telegram', 1, 'Luca')).toBe(
      "Ciao Luca, sono Marta di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?",
    );
  });
  it('T2 con nome', () => {
    expect(openingBody('telegram', 2, 'Luca')).toBe(
      "Ciao Luca, Marta di Fenice Academy: l'ingresso nel canale Telegram è in arrivo via email. Curiosità: hai già una professione digitale in mente o vuoi capire quale fa per te?",
    );
  });
  it('J1 con nome', () => {
    expect(openingBody('jobsim', 1, 'Luca')).toBe(
      "Ciao Luca, sono Marta di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?",
    );
  });
  it('J2 con nome', () => {
    expect(openingBody('jobsim', 2, 'Luca')).toBe(
      "Ciao Luca, Marta di Fenice Academy. Prima che il simulatore delle professioni digitali ti dia il verdetto: una professione in mente ce l'hai già o parti da zero?",
    );
  });
  it('other → testi di corso10', () => {
    expect(openingBody('other', 1, 'Luca')).toBe(openingBody('corso10', 1, 'Luca'));
    expect(openingBody('other', 2, 'Luca')).toBe(openingBody('corso10', 2, 'Luca'));
  });
  it('nome mancante o inutilizzabile → vocativo neutro, mai un genere sbagliato', () => {
    expect(openingBody('corso10', 1)).toContain('Ciao a te,');
    expect(openingBody('corso10', 1, null)).toContain('Ciao a te,');
    expect(openingBody('corso10', 1, '')).toContain('Ciao a te,');
    expect(openingBody('corso10', 1, '   ')).toContain('Ciao a te,');
    expect(openingBody('corso10', 1, 'mario.rossi@gmail.com')).toContain('Ciao a te,');
  });

  it('nome e cognome dal CRM → nel messaggio va solo il nome', () => {
    expect(openingBody('corso10', 1, 'Mario Rossi')).toContain('Ciao Mario,');
    expect(openingBody('telegram', 2, 'MARIA GRAZIA DE LUCA')).toContain('Ciao Maria,');
  });
  it('nome con spazi → trim', () => {
    expect(openingBody('telegram', 2, '  Anna  ')).toContain('Ciao Anna,');
  });
  it('nessun placeholder residuo in nessuna variante', () => {
    const funnels: FunnelKey[] = ['corso10', 'telegram', 'jobsim', 'other'];
    for (const f of funnels) {
      for (const v of [1, 2, 3, 4] as const) {
        const body = openingBody(f, v, 'Luca');
        expect(body).not.toMatch(/\{|\}|undefined|null/);
        expect(body.startsWith('Ciao Luca,')).toBe(true);
      }
    }
  });
});

describe('aperture con dichiarazione IA (AI Act art. 50)', () => {
  it('C3 — assistente digitale', () => {
    expect(openingBody('corso10', 3, 'Luca')).toBe(
      "Ciao Luca, sono Marta, l'assistente digitale di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?",
    );
  });
  it('C4 — digital assistant', () => {
    expect(openingBody('corso10', 4, 'Luca')).toBe(
      'Ciao Luca, sono Marta, digital assistant di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?',
    );
  });
  it('T3 — assistente digitale', () => {
    expect(openingBody('telegram', 3, 'Luca')).toBe(
      "Ciao Luca, sono Marta, l'assistente digitale di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?",
    );
  });
  it('T4 — digital assistant', () => {
    expect(openingBody('telegram', 4, 'Luca')).toBe(
      "Ciao Luca, sono Marta, digital assistant di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?",
    );
  });
  it('J3 — assistente digitale', () => {
    expect(openingBody('jobsim', 3, 'Luca')).toBe(
      "Ciao Luca, sono Marta, l'assistente digitale di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?",
    );
  });
  it('J4 — digital assistant', () => {
    expect(openingBody('jobsim', 4, 'Luca')).toBe(
      "Ciao Luca, sono Marta, digital assistant di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?",
    );
  });

  it('3 e 4 differiscono dalla variante 1 SOLO per la presentazione', () => {
    for (const f of ['corso10', 'telegram', 'jobsim'] as FunnelKey[]) {
      const v1 = openingBody(f, 1, 'Luca');
      const coda = v1.slice(v1.indexOf('Academy.'));
      expect(openingBody(f, 3, 'Luca').endsWith(coda)).toBe(true);
      expect(openingBody(f, 4, 'Luca').endsWith(coda)).toBe(true);
    }
  });

  it('la dichiarazione è esplicita e non ammicca a un umano', () => {
    for (const f of ['corso10', 'telegram', 'jobsim'] as FunnelKey[]) {
      expect(openingBody(f, 3, 'Luca')).toContain("l'assistente digitale di Fenice Academy");
      expect(openingBody(f, 4, 'Luca')).toContain('digital assistant di Fenice Academy');
    }
  });

  it('nessuna apertura propone il passaggio a un operatore', () => {
    for (const f of ['corso10', 'telegram', 'jobsim'] as FunnelKey[]) {
      for (const v of [1, 2, 3, 4] as const) {
        expect(openingBody(f, v, 'Luca')).not.toMatch(/operatore|collega in carne/i);
      }
    }
  });
});

describe('OPENING_ENV_KEYS', () => {
  it('elenca tutte e 12 le env delle aperture', () => {
    expect(OPENING_ENV_KEYS).toEqual([
      'OPENING_SID_C1', 'OPENING_SID_C2', 'OPENING_SID_C3', 'OPENING_SID_C4',
      'OPENING_SID_T1', 'OPENING_SID_T2', 'OPENING_SID_T3', 'OPENING_SID_T4',
      'OPENING_SID_J1', 'OPENING_SID_J2', 'OPENING_SID_J3', 'OPENING_SID_J4',
    ]);
  });
  it('coincide con quello che produce openingEnvKey', () => {
    const generate = (['corso10', 'telegram', 'jobsim'] as FunnelKey[]).flatMap((f) =>
      ([1, 2, 3, 4] as const).map((v) => openingEnvKey(f, v)),
    );
    expect([...OPENING_ENV_KEYS].sort()).toEqual([...generate].sort());
  });
});

describe('personaForConversation', () => {
  const MARTA = new Set(['HXm1', 'HXm2']);
  const out = (sid: string | null) => ({ direction: 'out', template_sid: sid });
  const inb = () => ({ direction: 'in', template_sid: null });

  it('primo out templated in martaSids → marta', () => {
    expect(personaForConversation([out('HXm1'), inb(), out(null)], MARTA)).toBe('marta');
  });
  it('primo out templated legacy → mario', () => {
    expect(personaForConversation([out('HXlegacy'), inb(), out('HXm1')], MARTA)).toBe('mario');
  });
  it('nessun out → marta (conversazione nuova, apertura differita)', () => {
    expect(personaForConversation([], MARTA)).toBe('marta');
    expect(personaForConversation([inb()], MARTA)).toBe('marta');
  });
  it('out free-form (senza template) prima del template marta → ignora i non-template → marta', () => {
    expect(personaForConversation([out(null), out('HXm2')], MARTA)).toBe('marta');
  });
  it('out free-form prima del template legacy → mario', () => {
    expect(personaForConversation([out(null), out('HXlegacy')], MARTA)).toBe('mario');
  });
  it('solo out free-form, nessun template → mario', () => {
    expect(personaForConversation([out(null), inb(), out(null)], MARTA)).toBe('mario');
  });
});

describe('PERSONA_NAME', () => {
  it('mappa persona → nome visualizzato', () => {
    expect(PERSONA_NAME).toEqual({ mario: 'Mario', marta: 'Marta' });
  });
});
