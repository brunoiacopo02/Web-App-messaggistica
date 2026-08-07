import { describe, it, expect } from 'vitest';
import {
  resolveOutcomeAction,
  buildLockedNote,
  checkDataRichiamo,
  buildRichiamoSenzaDataNote,
  buildContattoUmanoNote,
  buildBotRipresoNote,
  paroleDelLead,
  RICHIAMO_ORIZZONTE_MS,
} from './bot-outcome-rules';
import { formatRomeDateTime } from './rome-time';

const DATE = '2026-06-29T17:00:00Z';
const DATE_HUMAN = formatRomeDateTime(DATE); // "lunedì 29 giugno alle 19:00"
const DIFF = '2026-07-01T10:00:00Z';
const DIFF_HUMAN = formatRomeDateTime(DIFF); // "mercoledì 1 luglio alle 12:00"

describe('resolveOutcomeAction', () => {
  it('non-APPUNTAMENTO corrente → normal', () => {
    expect(resolveOutcomeAction(null, { outcome: 'DA_SCARTARE' }, null))
      .toEqual({ kind: 'normal' });
    expect(resolveOutcomeAction('RICHIAMO', { outcome: 'APPUNTAMENTO', date: DATE }, null).kind)
      .toBe('normal');
  });

  it('APPUNTAMENTO corrente + qualsiasi esito → locked con NOTA, data sempre null (la data originale resta nel testo della nota)', () => {
    const a = resolveOutcomeAction('APPUNTAMENTO', { outcome: 'DA_SCARTARE', discardReason: 'la madre non paga' }, DATE);
    expect(a.kind).toBe('locked');
    if (a.kind === 'locked') {
      expect(a.outcome).toBe('NOTA');
      expect(a.date).toBeNull();
      expect(a.note).toContain('annullare');
      expect(a.note).toContain('la madre non paga');
    }
  });

  it('APPUNTAMENTO corrente senza data originale → locked con date null', () => {
    const a = resolveOutcomeAction('APPUNTAMENTO', { outcome: 'INTERROTTO' }, null);
    expect(a).toMatchObject({ kind: 'locked', date: null });
  });
});

describe('buildLockedNote', () => {
  it('SCARTO → motivo annullamento e data dell\'appuntamento originale, leggibile in ora di Roma (unico modo per le Conferme di sapere quale appuntamento è in gioco, ora che la data non è più inviata al CRM)', () => {
    const n = buildLockedNote({ outcome: 'DA_SCARTARE', discardReason: 'no budget' }, DATE);
    expect(n).toContain('no budget');
    expect(n).toContain(DATE_HUMAN);
    expect(n).not.toContain(DATE); // niente ISO grezzo nella nota
  });
  it('INTERROTTO → nota interruzione, appuntamento mantenuto', () => {
    expect(buildLockedNote({ outcome: 'INTERROTTO' }, DATE).toLowerCase())
      .toContain('interrotta');
  });
  it('APPUNTAMENTO stessa data → riconferma', () => {
    expect(buildLockedNote({ outcome: 'APPUNTAMENTO', date: DATE }, DATE).toLowerCase())
      .toContain('riconfermato');
  });
  it('APPUNTAMENTO data diversa → richiesta di spostamento, entrambe le date leggibili in ora di Roma', () => {
    const n = buildLockedNote({ outcome: 'APPUNTAMENTO', date: DIFF }, DATE);
    expect(n).toContain('spostare');
    expect(n).toContain(DIFF_HUMAN);
    expect(n).toContain(DATE_HUMAN);
  });
});

// RICHIAMO ora significa "il lead vuole spostare l'appuntamento già fissato" (non più
// "vuole essere richiamato"): la nota letta dalle Conferme deve dirlo esplicitamente,
// riportare la data indicata dal lead SOLO se ne ha data una davvero, e indicare in
// ogni caso la data che resta in agenda (unico posto dove sopravvive, ora che il campo
// data non viene più inviato al CRM). Tutte le date vanno scritte leggibili in ora di
// Roma, non come ISO grezzo.
describe('buildLockedNote — RICHIAMO (richiesta di spostamento)', () => {
  it('con una data indicata dal lead diversa da quella fissata → dice chiaramente "spostare", riporta la data indicata e quella in agenda, entrambe leggibili', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: DIFF }, DATE);
    expect(n).toContain('spostare');
    expect(n).toContain(DIFF_HUMAN);
    expect(n).toContain(DATE_HUMAN);
    expect(n.toLowerCase()).toContain('mantenuto');
  });

  it('senza data indicata dal lead → dice "spostare" ma non inventa una data, riporta solo quella in agenda', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO' }, DATE);
    expect(n).toContain('spostare');
    expect(n).toContain(DATE_HUMAN);
    // Una sola occorrenza della data: quella in agenda, non una finta "data indicata".
    expect(n.split(DATE_HUMAN).length - 1).toBe(1);
  });

  it('quando il tag riporta la stessa data dell\'appuntamento, stessa stringa ISO (il prompt la usa come fallback quando il lead non ne dà una) → NON la presenta come data indicata dal lead, resta solo la data in agenda una volta sola', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: DATE }, DATE);
    expect(n).toContain('spostare');
    expect(n.split(DATE_HUMAN).length - 1).toBe(1);
  });
});

// Bug di revisione: existingDate arriva da bot_scheduled_at, una colonna timestamptz
// che Postgres normalizza in UTC nel round-trip (es. "...T13:00:00+00:00"), mentre
// args.date arriva dal tag del modello nel fuso locale imposto dal prompt (es.
// "...T15:00:00+02:00"): stesso istante, stringhe sempre diverse. Un confronto
// testuale (args.date !== existingDate) non scatta mai in questo caso reale, quindi
// il caso più frequente — spostamento senza nuova data, con la data dell'appuntamento
// usata come fallback dal prompt — ricadrebbe nel difetto che dovevamo eliminare,
// mostrando due date "diverse" che in realtà sono la stessa. Il confronto va fatto
// per istante (Date.parse), non per stringa.
describe('buildLockedNote — confronto date per istante, non per stringa (round-trip Postgres UTC vs tag in fuso locale)', () => {
  const existingUtc = '2026-08-01T13:00:00+00:00'; // come torna da Postgres
  const leadSameInstantLocal = '2026-08-01T15:00:00+02:00'; // stesso istante, fuso locale del tag
  const leadGenuinelyDifferent = '2026-08-05T09:00:00+02:00'; // istante realmente diverso
  const existingHuman = formatRomeDateTime(existingUtc); // "sabato 1 agosto alle 15:00"
  const diffHuman = formatRomeDateTime(leadGenuinelyDifferent);

  it('RICHIAMO: stesso istante scritto con offset diversi (UTC dal DB vs locale dal tag) → NON è una nuova data indicata dal lead', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: leadSameInstantLocal }, existingUtc);
    expect(n).toContain('nessuna nuova data indicata dal lead');
    expect(n).toContain(existingHuman);
    expect(n.split(existingHuman).length - 1).toBe(1);
  });

  it('RICHIAMO: istante realmente diverso (offset diversi) → continua a comparire come data indicata dal lead', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: leadGenuinelyDifferent }, existingUtc);
    expect(n).toContain(`alla data indicata (${diffHuman})`);
    expect(n).toContain(existingHuman);
  });

  it('APPUNTAMENTO: stesso istante scritto con offset diversi → riconferma, non uno spostamento', () => {
    const n = buildLockedNote({ outcome: 'APPUNTAMENTO', date: leadSameInstantLocal }, existingUtc);
    expect(n.toLowerCase()).toContain('riconfermato');
    expect(n).not.toContain('spostare');
  });

  it('APPUNTAMENTO: istante realmente diverso → continua a essere trattato come spostamento', () => {
    const n = buildLockedNote({ outcome: 'APPUNTAMENTO', date: leadGenuinelyDifferent }, existingUtc);
    expect(n).toContain('spostare');
    expect(n).toContain(diffHuman);
    expect(n).toContain(existingHuman);
  });
});

describe('checkDataRichiamo', () => {
  const now = Date.parse('2026-08-06T12:00:00+02:00');

  it('data futura entro l\'orizzonte → ok', () => {
    expect(checkDataRichiamo('2026-08-20T10:00:00+02:00', now)).toEqual({ ok: true });
    expect(checkDataRichiamo('2026-09-01T10:00:00+02:00', now)).toEqual({ ok: true });
  });

  it('data assente → assente', () => {
    expect(checkDataRichiamo(undefined, now)).toEqual({ ok: false, motivo: 'assente' });
    expect(checkDataRichiamo('', now)).toEqual({ ok: false, motivo: 'assente' });
  });

  it('data illeggibile → illeggibile', () => {
    expect(checkDataRichiamo('a settembre', now)).toEqual({ ok: false, motivo: 'illeggibile' });
    expect(checkDataRichiamo('2026-13-45T99:00:00+02:00', now)).toEqual({ ok: false, motivo: 'illeggibile' });
  });

  it('data nel passato → passato (caso reale conv 3369: 27/01/2026)', () => {
    expect(checkDataRichiamo('2026-01-27T09:00:00+01:00', now)).toEqual({ ok: false, motivo: 'passato' });
    expect(checkDataRichiamo('2026-08-06T11:59:00+02:00', now)).toEqual({ ok: false, motivo: 'passato' });
  });

  it('oltre ~6 mesi → oltre_orizzonte', () => {
    expect(checkDataRichiamo('2028-08-06T10:00:00+02:00', now)).toEqual({ ok: false, motivo: 'oltre_orizzonte' });
    expect(checkDataRichiamo('2027-08-06T10:00:00+02:00', now)).toEqual({ ok: false, motivo: 'oltre_orizzonte' });
  });

  it('il confine dell\'orizzonte è incluso', () => {
    const limite = new Date(now + RICHIAMO_ORIZZONTE_MS).toISOString();
    expect(checkDataRichiamo(limite, now)).toEqual({ ok: true });
    const oltre = new Date(now + RICHIAMO_ORIZZONTE_MS + 60_000).toISOString();
    expect(checkDataRichiamo(oltre, now)).toEqual({ ok: false, motivo: 'oltre_orizzonte' });
  });
});

describe('buildRichiamoSenzaDataNote', () => {
  it('riporta le parole letterali del lead', () => {
    const n = buildRichiamoSenzaDataNote({ motivo: 'illeggibile', leadWords: 'ci risentiamo a settembre' });
    expect(n).toContain('"ci risentiamo a settembre"');
    expect(n).toContain('da concordare');
  });

  it('senza parole del lead resta una nota sensata', () => {
    const n = buildRichiamoSenzaDataNote({ motivo: 'assente' });
    expect(n).toContain('non ha indicato quando');
    expect(n).not.toContain('""');
  });

  it('distingue la data nel passato da quella assente', () => {
    expect(buildRichiamoSenzaDataNote({ motivo: 'passato' })).toContain('nel passato');
    expect(buildRichiamoSenzaDataNote({ motivo: 'oltre_orizzonte' })).toContain('troppo lontana');
  });

  it('non contiene mai una data: è proprio quella che non ci fidiamo a mandare', () => {
    for (const motivo of ['assente', 'illeggibile', 'passato', 'oltre_orizzonte'] as const) {
      expect(buildRichiamoSenzaDataNote({ motivo, leadWords: 'boh' })).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});

// Il CRM ha ricevuto 296 note su 142 lead dal 26/07: il canale funziona, il contenuto
// no. Le leggono le Conferme pochi minuti prima di chiamare il cliente, quindi serve il
// fatto in testa e i dati che lo rendono azionabile — se disdice QUANDO, se sposta A
// QUANDO — piu' le parole vere del lead, non la parafrasi del modello.
describe('buildLockedNote — formato fattuale per le Conferme', () => {
  it('ogni nota si apre con l\'etichetta del fatto, in maiuscolo', () => {
    const atteso: [Parameters<typeof buildLockedNote>[0], string][] = [
      [{ outcome: 'DA_SCARTARE', discardReason: 'no budget' }, 'DISDETTA —'],
      [{ outcome: 'RICHIAMO', date: DIFF }, 'SPOSTAMENTO CHIESTO —'],
      [{ outcome: 'APPUNTAMENTO', date: DIFF }, 'SPOSTAMENTO CHIESTO —'],
      [{ outcome: 'APPUNTAMENTO', date: DATE }, 'RICONFERMA —'],
      [{ outcome: 'INTERROTTO' }, 'CHAT INTERROTTA —'],
      [{ outcome: 'NON_RISPOSTO' }, 'NESSUNA RISPOSTA —'],
    ];
    for (const [args, etichetta] of atteso) {
      expect(buildLockedNote(args, DATE).startsWith(etichetta)).toBe(true);
    }
  });

  it('la disdetta dice QUANDO era l\'appuntamento', () => {
    const n = buildLockedNote({ outcome: 'DA_SCARTARE', discardReason: 'no budget' }, DATE);
    expect(n).toContain(DATE_HUMAN);
  });

  it('quando la data non ce l\'abbiamo lo dichiara, invece di tacere', () => {
    // Caso reale dei lead dei GDO: l'appuntamento l'ha preso il commerciale al
    // telefono e bot_scheduled_at resta nullo. Fino al 07/08 la nota diceva solo
    // "Il lead vuole annullare l'appuntamento", senza far capire quale.
    const n = buildLockedNote({ outcome: 'DA_SCARTARE', discardReason: 'no budget' }, null);
    expect(n).toContain('data non nota da noi');
  });

  it('lo spostamento dice che tocca a loro, non solo che l\'appuntamento e mantenuto', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: DIFF }, DATE);
    expect(n).toContain('spostate voi');
  });

  it('le parole del lead compaiono tra virgolette, accanto alla sintesi del modello', () => {
    const n = buildLockedNote(
      { outcome: 'DA_SCARTARE', discardReason: 'motivo economico', leadWords: 'non me la sento di spendere adesso' },
      DATE,
    );
    expect(n).toContain('motivo economico');
    expect(n).toContain('"non me la sento di spendere adesso"');
  });

  it('senza le parole del lead la nota resta pulita, senza virgolette vuote', () => {
    const n = buildLockedNote({ outcome: 'DA_SCARTARE', discardReason: 'no budget' }, DATE);
    expect(n).not.toContain('""');
    expect(n).not.toContain('Parole del lead');
  });

  it('resta leggibile al volo: mai piu di due righe', () => {
    for (const o of ['DA_SCARTARE', 'RICHIAMO', 'INTERROTTO', 'NON_RISPOSTO', 'APPUNTAMENTO'] as const) {
      const n = buildLockedNote({ outcome: o, date: DIFF, discardReason: 'x'.repeat(60), leadWords: 'y'.repeat(600) }, DATE);
      expect(n.length).toBeLessThan(800);
      expect(n).not.toContain('\n');
    }
  });
});

describe('buildBotRipresoNote', () => {
  it('dice cosa era stato restituito, quando il lead ha riscritto, e di non chiamare', () => {
    const n = buildBotRipresoNote({ esitoPrecedente: 'INTERROTTO', quandoIso: DATE });
    expect(n.startsWith('IL BOT HA RIPRESO LA CHAT —')).toBe(true);
    expect(n).toContain('INTERROTTO');
    expect(n).toContain(DATE_HUMAN);
    expect(n.toLowerCase()).toContain('non chiamatelo');
  });

  it('vale per qualunque esito precedente', () => {
    for (const o of ['NON_RISPOSTO', 'DA_SCARTARE', 'RICHIAMO']) {
      expect(buildBotRipresoNote({ esitoPrecedente: o, quandoIso: DATE })).toContain(o);
    }
  });
});

describe('paroleDelLead', () => {
  it('normalizza a-capo e spazi doppi: la nota deve restare leggibile di sguardo', () => {
    expect(paroleDelLead('voglio\nparlare\ncon   qualcuno')).toBe('voglio parlare con qualcuno');
  });

  it('vuoto o soli spazi non è una citazione', () => {
    expect(paroleDelLead('   ')).toBeNull();
    expect(paroleDelLead(undefined)).toBeNull();
  });

  it('taglia i messaggi fiume su un confine di parola e segnala il taglio', () => {
    const lungo = 'ho bisogno di parlare con qualcuno perche '.repeat(30);
    const r = paroleDelLead(lungo);
    expect(r).not.toBeNull();
    expect(r!.length).toBeLessThanOrEqual(401);
    expect(r!.endsWith('…')).toBe(true);
    expect(r!.endsWith(' …')).toBe(false);
  });

  it('sotto la soglia non tocca niente', () => {
    expect(paroleDelLead('passatemi un responsabile')).toBe('passatemi un responsabile');
  });
});

describe('buildContattoUmanoNote', () => {
  it('il fatto in testa, poi le parole del lead', () => {
    const n = buildContattoUmanoNote({ leadWords: 'posso parlare con un vostro operatore?' });
    expect(n.startsWith('RICHIESTA DI PARLARE CON UNA PERSONA')).toBe(true);
    expect(n).toContain('"posso parlare con un vostro operatore?"');
  });

  it('senza le parole del lead non inventa il contenuto della richiesta', () => {
    const n = buildContattoUmanoNote({});
    expect(n.startsWith('RICHIESTA DI PARLARE CON UNA PERSONA')).toBe(true);
    expect(n).not.toContain('""');
    expect(n.trim().length).toBeGreaterThan(0);
  });

  it('il contesto va in coda e non sostituisce le parole del lead', () => {
    const n = buildContattoUmanoNote({ leadWords: 'voglio disdire', motivo: 'insiste da due turni' });
    expect(n).toContain('"voglio disdire"');
    expect(n).toContain('insiste da due turni');
  });

  it('resta corta: le Conferme la leggono col telefono in mano', () => {
    const n = buildContattoUmanoNote({ leadWords: 'ciao '.repeat(500) });
    expect(n.length).toBeLessThan(600);
  });
});
