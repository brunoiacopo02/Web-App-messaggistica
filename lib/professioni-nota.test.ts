import { describe, it, expect } from 'vitest';
import { brochureContextNote, chiedeLaScheda, FINESTRA_RICHIESTA_SCHEDA, professioniContextNote, professioniVince, richiestaSchedaFuoriFunnel, schedaDaInviare, schedaSubito } from './professioni-nota';

describe('professioniContextNote', () => {
  it('scheda non ancora partita: nomina il corso, il tag e il ripiego col video', () => {
    const n = professioniContextNote('video_editor');
    expect(n).toContain('Video Editor');
    expect(n).toContain('[SCHEDA:video_editor]');
    expect(n).toContain("NON E' ANCORA PARTITA");
    expect(n).toContain('insieme al video');
  });
  it('senza corso chiede quale e mostra gli slug', () => {
    expect(professioniContextNote(null)).toContain('social_media_manager');
  });
});

describe('schedaDaInviare', () => {
  const base = { professione: 'copywriter', schedaInviataAt: null, appuntamentoConVideoOra: false };
  it('tag del modello → pre_appuntamento', () => {
    expect(schedaDaInviare({ ...base, schedaRichiesta: 'copywriter' })).toEqual({ slug: 'copywriter', momento: 'pre_appuntamento' });
  });
  it('video dell\'appuntamento uscito ora → post_appuntamento', () => {
    expect(schedaDaInviare({ ...base, appuntamentoConVideoOra: true })).toEqual({ slug: 'copywriter', momento: 'post_appuntamento' });
  });
  it('gia\' inviata → null', () => {
    expect(schedaDaInviare({ ...base, schedaInviataAt: '2026-10-14T10:00:00Z', appuntamentoConVideoOra: true })).toBeNull();
  });
  it('lead normale senza professione → null anche con appuntamento', () => {
    expect(schedaDaInviare({ ...base, professione: null, appuntamentoConVideoOra: true })).toBeNull();
  });
  it('professione salvata non valida → null', () => {
    expect(schedaDaInviare({ ...base, professione: 'boh', appuntamentoConVideoOra: true })).toBeNull();
  });
});

describe('professioniVince (PO 15/10/2026, conv 3292)', () => {
  const NOW = Date.parse('2026-10-15T12:00:00Z');
  const base = {
    professione: 'copywriter' as string | null, crmFunnel: null as string | null,
    lancioSlug: null as string | null, lancioFase: null as string | null,
    gdoAgendaAt: null as string | null, botScheduledAt: null as string | null, gdoAppuntamentoAt: null as string | null,
    now: NOW,
  };
  it('niente lancio e niente agenda: vince', () => {
    expect(professioniVince(base)).toBe(true);
  });
  it('funnel PROFESSIONI senza corso: vince', () => {
    expect(professioniVince({ ...base, professione: null, crmFunnel: 'PROFESSIONI' })).toBe(true);
  });
  it('lancio chiuso + agenda GDO vecchia senza ora della call (forma della conv 3292): vince', () => {
    expect(professioniVince({
      ...base, lancioSlug: 'webdev-2026-10', lancioFase: 'chiuso', gdoAgendaAt: '2026-09-17T12:37:38Z', crmFunnel: 'Lancio Web Dev AI',
    })).toBe(true);
  });
  it('lancio restituito (fase terminale): vince', () => {
    expect(professioniVince({ ...base, lancioSlug: 'webdev-2026-10', lancioFase: 'restituito' })).toBe(true);
  });
  it('agenda con la call GDO gia passata: vince', () => {
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-10T09:00:00Z', gdoAppuntamentoAt: '2026-10-12T15:00:00Z' })).toBe(true);
  });
  it('fase del lancio attiva: perde', () => {
    for (const fase of ['attesa', 'posto_bloccato', 'post_pitch', null]) {
      expect(professioniVince({ ...base, lancioSlug: 'webdev-2026-10', lancioFase: fase })).toBe(false);
    }
  });
  it('agenda con la call GDO ancora da fare: perde', () => {
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-14T09:00:00Z', gdoAppuntamentoAt: '2026-10-16T15:00:00Z' })).toBe(false);
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-14T09:00:00Z', botScheduledAt: '2026-10-16T15:00:00Z' })).toBe(false);
  });
  it('vince la piu recente fra le due colonne della call', () => {
    expect(professioniVince({
      ...base, gdoAgendaAt: '2026-10-01T09:00:00Z', gdoAppuntamentoAt: '2026-10-03T15:00:00Z', botScheduledAt: '2026-10-17T15:00:00Z',
    })).toBe(false);
  });
  it('agenda recente senza ora della call: la call puo essere ancora da fare, perde', () => {
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-13T09:00:00Z' })).toBe(false);
  });
  it('agenda senza ora della call oltre la finestra di 7 giorni: vince', () => {
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-08T11:59:00Z' })).toBe(true);
  });
  it("ora della call precedente all'agenda: si ignora e vale la finestra dall'agenda", () => {
    // Call di un giro precedente (12/10) rimasta sulla riga, agenda nuova del 14/10: la
    // call nuova puo' essere ancora da fare.
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-14T09:00:00Z', gdoAppuntamentoAt: '2026-10-12T15:00:00Z' })).toBe(false);
    expect(professioniVince({ ...base, gdoAgendaAt: '2026-10-01T09:00:00Z', botScheduledAt: '2026-09-20T15:00:00Z' })).toBe(true);
  });
  it('niente corso e funnel non PROFESSIONI: perde', () => {
    expect(professioniVince({ ...base, professione: null, crmFunnel: 'Lancio Web Dev AI' })).toBe(false);
    expect(professioniVince({ ...base, professione: null })).toBe(false);
  });
});

// Conv 3292 (15/10/2026, seconda prova): "me lo mandi ora?" + "il pdf intendo" e Mario
// rispondeva "non abbiamo un pdf". La richiesta dopo la frase del link vale come insistenza.
describe('chiedeLaScheda', () => {
  it('pdf, brochure (anche scritta male), scheda, programma: si', () => {
    expect(chiedeLaScheda(['me lo mandi ora?', 'il pdf intendo'])).toBe(true);
    expect(chiedeLaScheda(['mandami la brouchure è un test'])).toBe(true);
    expect(chiedeLaScheda(['mi mandi la brochure?'])).toBe(true);
    expect(chiedeLaScheda(['e la scheda?'])).toBe(true);
    expect(chiedeLaScheda(['mi giri il programma del corso?'])).toBe(true);
  });
  it("la frase del link da sola non conta: e' la prima richiesta, non l'insistenza", () => {
    expect(chiedeLaScheda(['Ciao, sono interessato alla professione di Copywriter e vorrei ricevere la scheda del corso'])).toBe(false);
  });
  it('messaggi qualsiasi: no', () => {
    expect(chiedeLaScheda(['lavoro in un negozio', 'si domani va bene'])).toBe(false);
    expect(chiedeLaScheda([])).toBe(false);
  });
});

// PO 28/10/2026: nelle adv promettiamo la brochure subito. La scheda parte prima della
// risposta di Mario; la nota gli dice che e' gia' sopra e di non ripeterla.
describe('professioniContextNote con la scheda gia in chat', () => {
  it('appena partita: non annunciarla, dagli un\'occhiata e prima domanda, niente "prima capisco meglio"', () => {
    const n = professioniContextNote('copywriter', { schedaInviata: true, appenaInviata: true });
    expect(n).toContain("APPENA ARRIVATA");
    expect(n).toContain('Ecco la scheda del corso di Copywriter');
    expect(n).toContain('prima domanda');
    expect(n).not.toContain('prima vuoi capire');
    expect(n).not.toContain('[SCHEDA:copywriter]');
  });
  it('partita in un turno precedente: se la richiede e\' sopra in chat, non si rimanda', () => {
    const n = professioniContextNote('copywriter', { schedaInviata: true });
    expect(n).toContain("L'HA GIA' RICEVUTA");
    expect(n).toContain('sopra in chat');
    expect(n).toContain('Non rimandarla');
    expect(n).not.toContain('[SCHEDA:copywriter]');
  });
  it("la regola 'la scheda esiste' c'e' sempre", () => {
    for (const opts of [undefined, { schedaInviata: true }, { schedaInviata: true, appenaInviata: true }]) {
      expect(professioniContextNote('copywriter', opts)).toMatch(/non dire mai che non (c'e'|abbiamo)/i);
    }
    expect(professioniContextNote(null)).toMatch(/non dire mai che non (c'e'|abbiamo)/i);
  });
  it('senza corso: appena lo dice, la scheda col tag', () => {
    const n = professioniContextNote(null);
    expect(n).toContain('APPENA TI DICE IL CORSO');
    expect(n).toContain('[SCHEDA:<slug>]');
  });
});

describe('schedaSubito (PO 28/10/2026)', () => {
  const LINK = 'Ciao, sono interessato alla professione di Copywriter e vorrei ricevere la scheda del corso';
  const base = { vinceProfessioni: true, professione: 'copywriter' as string | null, schedaInviataAt: null as string | null, testiTurno: [LINK] };
  it('frase del link sul funnel col corso: parte subito', () => {
    expect(schedaSubito(base)).toBe('copywriter');
  });
  it('richiesta esplicita senza la frase: parte subito', () => {
    expect(schedaSubito({ ...base, testiTurno: ['mi mandi il pdf?'] })).toBe('copywriter');
  });
  it('gia in chat: non riparte', () => {
    expect(schedaSubito({ ...base, schedaInviataAt: '2026-10-28T10:00:00Z' })).toBeNull();
  });
  it('turno che non e del funnel (postino, lancio in corso): mai', () => {
    expect(schedaSubito({ ...base, vinceProfessioni: false })).toBeNull();
  });
  it('corso sconosciuto o non valido: no (Mario chiede il corso e usa il tag)', () => {
    expect(schedaSubito({ ...base, professione: null })).toBeNull();
    expect(schedaSubito({ ...base, professione: 'boh' })).toBeNull();
  });
  it('messaggio qualsiasi a meta discorso: no', () => {
    expect(schedaSubito({ ...base, testiTurno: ['lavoro in un negozio'] })).toBeNull();
  });
});

describe('richiestaSchedaFuoriFunnel (brochure su richiesta, PO 28/10/2026)', () => {
  const base = {
    vinceProfessioni: false, postino: false, lancioSlug: null, schedaInviataAt: null,
    testiTurno: ['mi mandi la brochure?'], testiPrima: [] as string[],
  };
  it('richiesta esplicita nel turno → da_mandare', () => {
    expect(richiestaSchedaFuoriFunnel(base)).toBe('da_mandare');
  });
  it('senza richiesta → null', () => {
    expect(richiestaSchedaFuoriFunnel({ ...base, testiTurno: ['quanto costa il corso?'] })).toBeNull();
  });
  it('corso detto al turno dopo: la richiesta resta pendente', () => {
    expect(richiestaSchedaFuoriFunnel({ ...base, testiTurno: ['web developer'], testiPrima: ['ciao', 'avete un pdf del corso?'] })).toBe('da_mandare');
  });
  it('richiesta troppo indietro nella chat → null', () => {
    const prima = ['avete un pdf?', ...Array.from({ length: FINESTRA_RICHIESTA_SCHEDA }, (_, k) => `messaggio ${k}`)];
    expect(richiestaSchedaFuoriFunnel({ ...base, testiTurno: ['ok'], testiPrima: prima })).toBeNull();
  });
  it('gia\' inviata: gia_inviata solo se la richiede ora, mai da_mandare', () => {
    expect(richiestaSchedaFuoriFunnel({ ...base, schedaInviataAt: 'x' })).toBe('gia_inviata');
    expect(richiestaSchedaFuoriFunnel({ ...base, schedaInviataAt: 'x', testiTurno: ['web developer'], testiPrima: ['il pdf?'] })).toBeNull();
  });
  it('funnel Professioni, postino e lancio (in corso o chiuso) → null', () => {
    expect(richiestaSchedaFuoriFunnel({ ...base, vinceProfessioni: true })).toBeNull();
    expect(richiestaSchedaFuoriFunnel({ ...base, postino: true })).toBeNull();
    expect(richiestaSchedaFuoriFunnel({ ...base, lancioSlug: 'webdev-2026-10' })).toBeNull();
  });
  it('la frase del link Professioni non conta come richiesta', () => {
    expect(richiestaSchedaFuoriFunnel({ ...base, testiTurno: ['Ciao, vorrei ricevere la scheda del corso'] })).toBeNull();
  });
});

describe('brochureContextNote', () => {
  it('da mandare: esiste sempre, i sei corsi con slug, tag, call e PRIMA GUARDO IL CORSO', () => {
    const n = brochureContextNote('da_mandare');
    expect(n).toContain('LA SCHEDA ESISTE SEMPRE');
    expect(n).toContain('Sviluppatore Web AI = sviluppatore_web_ai');
    expect(n).toContain('Social Media Manager = social_media_manager');
    expect(n).toContain('[SCHEDA:<slug>]');
    expect(n).toContain('non sostituisce la call');
    expect(n).toContain('PRIMA GUARDO IL CORSO');
    expect(n).not.toContain('FUNNEL PROFESSIONI');
  });
  it('gia inviata: e\' sopra in chat, niente tag da usare', () => {
    const n = brochureContextNote('gia_inviata');
    expect(n).toContain('sopra in chat');
    expect(n).toContain('Non rimandarla');
    expect(n).not.toContain('<slug>');
  });
});
