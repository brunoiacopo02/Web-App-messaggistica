import { describe, it, expect } from 'vitest';
import { buildLancioSystem, DOMANDA_SCELTA_NOTTE, DOMANDA_SCELTA_GIORNO } from './lancio-prompt';

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
  it('la data della live sta in un posto solo: se cambia, nel prompt non resta un 5 ottobre', () => {
    const altra = buildLancioSystem({ ...base, eventoAt: '2026-11-12T20:30:00+01:00' });
    expect(altra).toContain('giovedì 12 novembre alle 20:30');
    expect(altra).not.toContain('5 ottobre');
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

describe('buildLancioSystem — fase link_inviato (assistenza al collegamento)', () => {
  const s = buildLancioSystem({ ...base, fase: 'link_inviato', zoomLink: 'https://us06web.zoom.us/j/89845223337', meetingId: '898 4522 3337' });

  it('dà l ID riunione così com è (i numeri del link) e dice che non serve nessun passcode', () => {
    expect(s).toContain('898 4522 3337');
    expect(s).toContain('https://us06web.zoom.us/j/89845223337');
    expect(s).toMatch(/NON serve nessun passcode/);
  });
  it('sa le tre mosse: ricliccare il link, app Zoom con l ID, browser', () => {
    expect(s).toMatch(/riclicc/i);
    expect(s).toMatch(/app Zoom/);
    expect(s).toMatch(/browser/);
  });
  it('zero pitch: niente call, prezzi, video, form, durata inventata', () => {
    expect(s).toMatch(/Non proporre MAI una chiamata, una call, un video, un modulo/);
    expect(s).toMatch(/prezzi non li dici MAI/);
    expect(s).not.toMatch(/jotform|noemi|un'ora e mezza/i);
  });
  it('tag: DOMANDA, NO e PASSAGGIO_UMANO; mai SI, CHIAMA_ORA, PRENOTA', () => {
    for (const t of ['[LANCIO:DOMANDA]', '[LANCIO:NO]', '[PASSAGGIO_UMANO]']) expect(s).toContain(t);
    for (const t of ['[LANCIO:SI]', '[LANCIO:CHIAMA_ORA]', '[LANCIO:PRENOTA']) expect(s).not.toContain(t);
  });
  it('senza meetingId non inventa un codice: rimanda ai numeri del link', () => {
    const s2 = buildLancioSystem({ ...base, fase: 'link_inviato', zoomLink: 'https://zoom.us/', meetingId: null });
    expect(s2).not.toContain('898 4522 3337');
    expect(s2).toMatch(/numeri che vede nel link/);
  });
});

describe('buildLancioSystem — fase post_pitch (riscaldamento e scelta)', () => {
  const BLOCCO = 'ORE PRENOTABILI (prova):\n- 2026-10-06T09:00:00+02:00 → martedì 6 ottobre alle 9:00 (domattina)';
  const pp = (over: Partial<Parameters<typeof buildLancioSystem>[0]>) =>
    buildLancioSystem({ ...base, fase: 'post_pitch', modo: 'notte', risposteRaccolte: 0, bloccoSlot: null, ...over });

  it('con 0 o 1 risposte fa UNA sola domanda di riscaldamento e non propone ancora la scelta', () => {
    const s = pp({ risposteRaccolte: 0 });
    expect(s).toContain('Risposte di riscaldamento già raccolte: 0 su 2');
    expect(s).toMatch(/Fai UNA sola domanda/);
    expect(s).toMatch(/cosa fa oggi/);
    expect(s).toMatch(/cosa l'ha colpita della live/);
    expect(s).not.toContain('Adesso è il momento della scelta');
    expect(pp({ risposteRaccolte: 1 })).toContain('1 su 2');
  });
  it('con 2 risposte pone la domanda della scelta, verbatim dalla spec §5.4', () => {
    const s = pp({ risposteRaccolte: 2 });
    expect(s).toContain('Adesso è il momento della scelta');
    expect(s).toContain(DOMANDA_SCELTA_NOTTE);
    expect(DOMANDA_SCELTA_NOTTE).toBe('Preferisci che ti chiami un nostro consulente adesso, anche se è tardi, oppure fissiamo una call domani?');
  });
  it('di notte esiste [LANCIO:CHIAMA_ORA]; di giorno no, e la domanda è quella diurna', () => {
    expect(pp({ risposteRaccolte: 2 })).toContain('[LANCIO:CHIAMA_ORA]');
    const g = pp({ risposteRaccolte: 2, modo: 'giorno' });
    expect(g).not.toContain('[LANCIO:CHIAMA_ORA]');
    expect(g).not.toContain('anche se è tardi');
    expect(g).toContain(DOMANDA_SCELTA_GIORNO);
    expect(g).toMatch(/Non offrire MAI "adesso"/);
  });
  it('il blocco degli slot entra così com è; senza blocco: [LANCIO:SLOTS] e mai un ora scritta', () => {
    expect(pp({ bloccoSlot: BLOCCO })).toContain(BLOCCO);
    const s = pp({ bloccoSlot: null });
    expect(s).toMatch(/Non hai ancora le ore/);
    expect(s).toContain('[LANCIO:SLOTS]');
    expect(s).not.toContain('ORE PRENOTABILI');
  });
  it('i tag della scelta + NO + DOMANDA + PASSAGGIO_UMANO; niente SI', () => {
    const s = pp({ risposteRaccolte: 2, bloccoSlot: BLOCCO });
    for (const t of ['[LANCIO:CHIAMA_ORA]', '[LANCIO:PRENOTA|', '[LANCIO:SLOTS]', '[LANCIO:NO]', '[LANCIO:DOMANDA]', '[PASSAGGIO_UMANO]']) expect(s).toContain(t);
    expect(s).not.toContain('[LANCIO:SI]');
  });
  it('il modello non scrive mai un ora né un nome: la conferma è del codice', () => {
    expect(pp({ risposteRaccolte: 2 })).toMatch(/non scrivere MAI tu un'ora, un giorno o il nome di chi chiama/);
  });
  it('prezzi mai, anche qui', () => {
    expect(pp({})).toMatch(/prezzi non li dici MAI/);
  });
  it('regressione B1: la fase attesa è quella di prima', () => {
    expect(buildLancioSystem(base)).toContain('[LANCIO:SI]');
    expect(buildLancioSystem(base)).not.toContain('[LANCIO:CHIAMA_ORA]');
    expect(buildLancioSystem(base)).not.toContain('ORE PRENOTABILI');
  });
});
