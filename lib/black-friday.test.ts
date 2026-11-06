import { describe, it, expect } from 'vitest';
import {
  blackFridayContextNote, blackFridayVince, FINE_BLACK_FRIDAY_DEFAULT_MS, funnelBlackFridayAttivo,
  INIZIO_BLACK_FRIDAY_MS, isMarkerBlackFriday, parsePosti, parseScadenza, TESTO_LINK_BLACK_FRIDAY,
} from './black-friday';
import { classificaPrimoMessaggio } from './primo-messaggio';

describe('isMarkerBlackFriday', () => {
  it.each([
    TESTO_LINK_BLACK_FRIDAY,
    "Ciao, sono interessato a saperne di piu sull'offerta Black Friday",
    'ciao vorrei info sul black friday',
    'BLACK FRIDAY??',
    'offerta black-friday',
    'Offerta blackfriday',
    'info blak friday',
    "Ciao, sono interessato a saperne di più sull'offerta Black Friday\nSono Luca",
  ])('riconosce "%s"', (t) => {
    expect(isMarkerBlackFriday(t)).toBe(true);
  });
  it.each([null, '', 'ciao vorrei info', 'venerdi nero', 'blackfridayzzz'])('non riconosce %s', (t) => {
    expect(isMarkerBlackFriday(t)).toBe(false);
  });
});

describe('classificaPrimoMessaggio col Black Friday', () => {
  it('funnel acceso: BLACK FRIDAY', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_LINK_BLACK_FRIDAY, inboundCorrente: TESTO_LINK_BLACK_FRIDAY, blackFridayAttivo: true }))
      .toEqual({ tipo: 'black_friday', provenienza: 'BLACK FRIDAY' });
  });
  it('funnel spento o non passato: inbound normale', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_LINK_BLACK_FRIDAY, inboundCorrente: TESTO_LINK_BLACK_FRIDAY, blackFridayAttivo: false }).tipo).toBe('inbound');
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_LINK_BLACK_FRIDAY, inboundCorrente: TESTO_LINK_BLACK_FRIDAY }).tipo).toBe('inbound');
  });
  it('"ciao" e poi la frase: BLACK FRIDAY', () => {
    expect(classificaPrimoMessaggio({ primoInbound: 'ciao', inboundCorrente: TESTO_LINK_BLACK_FRIDAY, blackFridayAttivo: true }).tipo).toBe('black_friday');
  });
  it('vince su Professioni', () => {
    expect(classificaPrimoMessaggio({
      primoInbound: 'Ciao, sono interessato alla professione di Copywriter e vorrei ricevere la scheda del corso',
      inboundCorrente: TESTO_LINK_BLACK_FRIDAY, blackFridayAttivo: true,
    }).tipo).toBe('black_friday');
  });
  it('il pulsante del webinar resta in testa', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_LINK_BLACK_FRIDAY, inboundCorrente: 'Ho seguito la live Web Developer AI', blackFridayAttivo: true }).tipo).toBe('lancio_pulsante');
  });
});

describe('funnelBlackFridayAttivo', () => {
  const lun9 = Date.parse('2026-11-09T00:00:00+01:00');
  it('env assente: spento prima del 9/11 00:00 Roma, acceso dal 9/11', () => {
    expect(INIZIO_BLACK_FRIDAY_MS).toBe(lun9);
    expect(funnelBlackFridayAttivo({ nowMs: lun9 - 1 })).toBe(false);
    expect(funnelBlackFridayAttivo({ nowMs: lun9 })).toBe(true);
  });
  it('si chiude da solo dopo il 30/11 (fine giornata Roma) se manca la scadenza', () => {
    expect(funnelBlackFridayAttivo({ nowMs: Date.parse('2026-11-30T23:30:00+01:00') })).toBe(true);
    expect(funnelBlackFridayAttivo({ nowMs: FINE_BLACK_FRIDAY_DEFAULT_MS + 1000 })).toBe(false);
  });
  it('la scadenza di app_settings sposta la fine', () => {
    const fine = Date.parse('2026-12-07T23:59:59+01:00');
    expect(funnelBlackFridayAttivo({ nowMs: Date.parse('2026-12-03T12:00:00Z'), scadenzaAtMs: fine })).toBe(true);
    expect(funnelBlackFridayAttivo({ nowMs: fine + 1000, scadenzaAtMs: fine })).toBe(false);
  });
  it('env 0 spegne sempre, env 1 accende sempre', () => {
    expect(funnelBlackFridayAttivo({ env: '0', nowMs: lun9 + 3600_000 })).toBe(false);
    expect(funnelBlackFridayAttivo({ env: 'off', nowMs: lun9 + 3600_000 })).toBe(false);
    expect(funnelBlackFridayAttivo({ env: '1', nowMs: lun9 - 86400_000 })).toBe(true);
  });
});

describe('parseScadenza / parsePosti', () => {
  it('solo data = fine giornata a Roma', () => {
    const s = parseScadenza('2026-11-30');
    expect(s?.atMs).toBe(Date.parse('2026-11-30T23:59:59+01:00'));
    expect(s?.etichetta).toBe('lunedì 30 novembre');
  });
  it('ISO col fuso', () => {
    expect(parseScadenza('2026-11-30T23:59:59+01:00')?.etichetta).toBe('lunedì 30 novembre');
  });
  it('assente, vuota, senza fuso o illeggibile = null', () => {
    for (const v of [undefined, null, '', '   ', '2026-11-30T23:59:59', 'fine novembre', 30]) expect(parseScadenza(v)).toBeNull();
  });
  it('posti: intero positivo o null', () => {
    expect(parsePosti(30)).toBe(30);
    expect(parsePosti('30')).toBe(30);
    for (const v of [undefined, null, '', 0, -3, 2.5, 'tanti']) expect(parsePosti(v)).toBeNull();
  });
});

describe('blackFridayVince', () => {
  const NOW = Date.parse('2026-11-10T12:00:00+01:00');
  const base = {
    attivo: true, crmFunnel: null as string | null, testiInbound: [TESTO_LINK_BLACK_FRIDAY] as (string | null)[],
    lancioSlug: null as string | null, lancioFase: null as string | null,
    gdoAgendaAt: null as string | null, botScheduledAt: null as string | null, gdoAppuntamentoAt: null as string | null,
    now: NOW,
  };
  it('chat nuova con la frase: vince', () => {
    expect(blackFridayVince(base)).toBe(true);
  });
  it('chat adottata come BLACK FRIDAY anche senza frase in cronologia: vince', () => {
    expect(blackFridayVince({ ...base, testiInbound: ['ciao'], crmFunnel: 'BLACK FRIDAY' })).toBe(true);
  });
  it('chat esistente di un altro funnel (lancio chiuso + agenda GDO vecchia, forma conv 3292): vince', () => {
    expect(blackFridayVince({
      ...base, crmFunnel: 'Lancio Web Dev AI', lancioSlug: 'webdev-2026-10', lancioFase: 'chiuso',
      gdoAgendaAt: '2026-09-17T12:37:38Z', testiInbound: ['ho seguito la live', 'ok grazie', TESTO_LINK_BLACK_FRIDAY],
    })).toBe(true);
  });
  it('chat PROFESSIONI che scrive la frase: vince', () => {
    expect(blackFridayVince({ ...base, crmFunnel: 'PROFESSIONI', testiInbound: ['scheda del corso di Copywriter', TESTO_LINK_BLACK_FRIDAY] })).toBe(true);
  });
  it('call GDO ancora da fare: vince il GDO', () => {
    expect(blackFridayVince({ ...base, gdoAgendaAt: '2026-11-09T10:00:00Z', gdoAppuntamentoAt: '2026-11-11T15:00:00Z' })).toBe(false);
  });
  it('lancio in corso: vince il lancio', () => {
    expect(blackFridayVince({ ...base, lancioSlug: 'webdev-2026-10', lancioFase: 'post_pitch' })).toBe(false);
  });
  it('funnel spento o chat senza segno: no', () => {
    expect(blackFridayVince({ ...base, attivo: false })).toBe(false);
    expect(blackFridayVince({ ...base, testiInbound: ['ciao'] })).toBe(false);
  });
});

describe('blackFridayContextNote', () => {
  const NOW = Date.parse('2026-11-10T12:00:00+01:00');
  const VSL = 'https://lp.feniceacademy.it/vsl-offerta';
  const scad = parseScadenza('2026-11-30');
  const tutte = [
    blackFridayContextNote({ vslLink: VSL, scadenza: scad, posti: 30, nowMs: NOW }),
    blackFridayContextNote({ vslLink: null, scadenza: null, posti: null, nowMs: NOW }),
    blackFridayContextNote({ vslLink: VSL, scadenza: null, posti: 30, nowMs: NOW }),
  ];
  it('il regalo dell\'Exclusive non e\' mai nominato: niente "tablet"', () => {
    for (const n of tutte) {
      expect(n).not.toMatch(/tablet|ipad/i);
      expect(n).toContain('regalo tech');
      expect(n).toContain('se ne parla in call');
    }
  });
  it('i fatti del PO: prezzo, garanzia nel contratto, corso IA, niente rate', () => {
    const n = tutte[0];
    expect(n).toContain('dai 2.000 ai 4.000 euro');
    expect(n).toContain('dai 1.000 ai 3.000 euro');
    expect(n).toContain('nel contratto');
    expect(n).toContain('consulente in call');
    expect(n).toContain("corso sull'intelligenza artificiale");
    expect(n).toContain('Mai cifre di rata');
  });
  it('senza scadenza non cita date di fine', () => {
    const n = tutte[1];
    expect(n).toContain('Non citare date di fine offerta');
    expect(n).not.toMatch(/novembre|dicembre|fino a /i);
    expect(n).not.toContain('URGENZA VERA');
  });
  it('con la scadenza la usa per l\'urgenza', () => {
    expect(tutte[0]).toContain('fino a lunedì 30 novembre compreso');
    expect(tutte[0]).toContain('URGENZA VERA');
  });
  it('scadenza gia\' passata: non la cita', () => {
    const n = blackFridayContextNote({ vslLink: VSL, scadenza: scad, posti: null, nowMs: Date.parse('2026-12-02T10:00:00Z') });
    expect(n).not.toContain('30 novembre');
    expect(n).toContain('Non citare date di fine offerta');
  });
  it('posti: il numero e il perche\', mai quanti ne restano', () => {
    expect(tutte[0]).toContain('sono solo 30');
    expect(tutte[0]).toContain('garantire il lavoro a tutti');
    expect(tutte[0]).toContain('Non dire mai quanti posti sono rimasti');
    expect(tutte[1]).not.toContain('POSTI');
  });
  it('VSL al posto dei video classici solo se c\'e\' il link', () => {
    expect(tutte[0]).toContain(VSL);
    expect(tutte[0]).toContain('al posto dei quattro link conferenza-*');
    expect(tutte[1]).not.toContain('conferenza-*');
  });
  it('chiusura presunta: nessun condizionale sulla chiusura nelle istruzioni positive', () => {
    expect(tutte[0]).toContain("fa l'iscrizione per bloccare il posto");
    expect(tutte[0]).toContain('Mai "se ti convince"');
  });
});
