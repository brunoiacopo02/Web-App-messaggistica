import { describe, it, expect } from 'vitest';
import {
  classificaPrimoMessaggio,
  isMarkerPulsanteWebinar,
  TESTO_PULSANTE_WEBINAR,
  PROVENIENZA_LANCIO_WEBDEV,
  vaRiagganciato,
  isMarkerLinkSviluppatore,
  TESTO_LINK_SVILUPPATORE,
} from './primo-messaggio';

const TELEGRAM = 'Buongiorno, sono nel canale Telegram e mi hanno indicato questo contatto per più informazioni su Fenice Academy';

describe('isMarkerPulsanteWebinar', () => {
  it('riconosce il testo precompilato del pulsante (spec §6.3), anche senza emoji e in altro caso', () => {
    expect(isMarkerPulsanteWebinar(TESTO_PULSANTE_WEBINAR)).toBe(true);
    expect(isMarkerPulsanteWebinar('ho seguito la LIVE WEB DEVELOPER AI e voglio saperne di più')).toBe(true);
    expect(isMarkerPulsanteWebinar(`${TESTO_PULSANTE_WEBINAR}\nMi chiamo Sara`)).toBe(true);
  });
  it('non scatta su chi parla della live senza il marker, ne su null', () => {
    expect(isMarkerPulsanteWebinar('Ho visto la live ieri sera, quanto costa?')).toBe(false);
    expect(isMarkerPulsanteWebinar('Sono un web developer, mi interessa l AI')).toBe(false);
    expect(isMarkerPulsanteWebinar(null)).toBe(false);
    expect(isMarkerPulsanteWebinar('')).toBe(false);
  });
});

describe('classificaPrimoMessaggio — i tre esiti non si confondono (vincolo PO 14/09)', () => {
  it('1. link del canale Telegram sul primo inbound → TELEGRAM', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TELEGRAM, inboundCorrente: TELEGRAM }))
      .toEqual({ tipo: 'telegram', provenienza: 'TELEGRAM' });
    // Chi e' in arretrato e riscrive: la provenienza si legge dal PRIMO messaggio.
    expect(classificaPrimoMessaggio({ primoInbound: TELEGRAM, inboundCorrente: 'Scusa, poi rispondo' }))
      .toEqual({ tipo: 'telegram', provenienza: 'TELEGRAM' });
  });

  it('2. pulsante del webinar sull inbound CORRENTE → Lancio Web Dev AI', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_PULSANTE_WEBINAR, inboundCorrente: TESTO_PULSANTE_WEBINAR }))
      .toEqual({ tipo: 'lancio_pulsante', provenienza: PROVENIENZA_LANCIO_WEBDEV });
    // Chat gia' esistente (lead della lista, o un Telegram di agosto) che preme il
    // pulsante la sera del 5: il marker scatta sull'inbound corrente, non sul primo.
    expect(classificaPrimoMessaggio({ primoInbound: TELEGRAM, inboundCorrente: TESTO_PULSANTE_WEBINAR }).tipo)
      .toBe('lancio_pulsante');
    expect(classificaPrimoMessaggio({ primoInbound: 'Ciao, info?', inboundCorrente: TESTO_PULSANTE_WEBINAR }).tipo)
      .toBe('lancio_pulsante');
  });

  it('3. qualunque altro primo messaggio → INBOUND', () => {
    expect(classificaPrimoMessaggio({ primoInbound: 'Ciao, vorrei informazioni', inboundCorrente: 'Ciao, vorrei informazioni' }))
      .toEqual({ tipo: 'inbound', provenienza: 'INBOUND' });
    expect(classificaPrimoMessaggio({ primoInbound: 'Vorrei entrare nel canale telegram', inboundCorrente: 'Vorrei entrare nel canale telegram' }).tipo)
      .toBe('inbound');
    expect(classificaPrimoMessaggio({ primoInbound: 'Ho visto la live, quanto costa?', inboundCorrente: 'Ho visto la live, quanto costa?' }).tipo)
      .toBe('inbound');
    expect(classificaPrimoMessaggio({ primoInbound: null, inboundCorrente: null }).tipo).toBe('inbound');
  });

  it('il pulsante sul PRIMO inbound e un Telegram adesso non e lancio: conta l inbound corrente', () => {
    // Caso limite documentato: il marker del pulsante vale solo sul messaggio appena
    // arrivato. Se il primo era il pulsante e ora scrive la frase del canale, e' TELEGRAM.
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_PULSANTE_WEBINAR, inboundCorrente: TELEGRAM }).tipo).toBe('telegram');
  });

  it('Telegram al primo messaggio + pulsante del webinar sul corrente → lancio_pulsante (i tre esiti non si confondono, PO 14/09)', () => {
    // Ripete esplicitamente il caso gia' coperto sopra: il marker del pulsante vince
    // sempre su un primo messaggio Telegram, perche' Telegram e lancio sono "roba
    // molto diversa" e non devono mai finire nello stesso esito.
    expect(classificaPrimoMessaggio({ primoInbound: TELEGRAM, inboundCorrente: TESTO_PULSANTE_WEBINAR }))
      .toEqual({ tipo: 'lancio_pulsante', provenienza: PROVENIENZA_LANCIO_WEBDEV });
  });
});

describe('vaRiagganciato — chi NON deve ricevere il riaggancio di Marta', () => {
  it('chi arriva dal pulsante del webinar non si riaggancia: risponde il turno del lancio', () => {
    expect(vaRiagganciato({ tipo: 'lancio_pulsante', provenienza: PROVENIENZA_LANCIO_WEBDEV })).toBe(false);
  });

  it('Telegram e inbound spontaneo si riagganciano come sempre', () => {
    expect(vaRiagganciato({ tipo: 'telegram', provenienza: 'TELEGRAM' })).toBe(true);
    expect(vaRiagganciato({ tipo: 'inbound', provenienza: 'INBOUND' })).toBe(true);
  });

  it('e la stessa decisione che prende il cron, letta dall esito della classificazione', () => {
    expect(vaRiagganciato(classificaPrimoMessaggio({
      primoInbound: TESTO_PULSANTE_WEBINAR, inboundCorrente: TESTO_PULSANTE_WEBINAR,
    }))).toBe(false);
    expect(vaRiagganciato(classificaPrimoMessaggio({
      primoInbound: 'ciao, mi interessa il corso', inboundCorrente: 'ciao, mi interessa il corso',
    }))).toBe(true);
  });
});

describe('classificaPrimoMessaggio — interruttore lancio_pulsante_attivo', () => {
  it('col pulsante spento il marker vale come assente: resta un inbound normale', () => {
    expect(classificaPrimoMessaggio({
      primoInbound: TESTO_PULSANTE_WEBINAR, inboundCorrente: TESTO_PULSANTE_WEBINAR, pulsanteAttivo: false,
    })).toEqual({ tipo: 'inbound', provenienza: 'INBOUND' });
  });

  it('col pulsante spento un Telegram resta Telegram: si torna esattamente a prima del lancio', () => {
    expect(classificaPrimoMessaggio({
      primoInbound: 'Ciao! Vorrei ricevere informazioni sul corso',
      inboundCorrente: TESTO_PULSANTE_WEBINAR,
      pulsanteAttivo: false,
    }).tipo).toBe('inbound');
  });

  it('acceso, o non passato affatto, il marker vince come sempre', () => {
    expect(classificaPrimoMessaggio({
      primoInbound: null, inboundCorrente: TESTO_PULSANTE_WEBINAR, pulsanteAttivo: true,
    }).tipo).toBe('lancio_pulsante');
    expect(classificaPrimoMessaggio({
      primoInbound: null, inboundCorrente: TESTO_PULSANTE_WEBINAR,
    }).tipo).toBe('lancio_pulsante');
  });
});

describe('link "professione dello Sviluppatore AI" (PO 24/09/2026)', () => {
  it('riconosce la frase precompilata, anche ritoccata o in altro caso', () => {
    expect(TESTO_LINK_SVILUPPATORE).toBe('Ciao, ho visto la professione dello Sviluppatore AI e vorrei più informazioni');
    expect(isMarkerLinkSviluppatore(TESTO_LINK_SVILUPPATORE)).toBe(true);
    expect(isMarkerLinkSviluppatore('ho visto la PROFESSIONE DELLO SVILUPPATORE AI')).toBe(true);
    expect(isMarkerLinkSviluppatore(`${TESTO_LINK_SVILUPPATORE}
Sono Luca`)).toBe(true);
  });

  it('non scatta su chi nomina lo sviluppo o l AI senza la frase, ne su null', () => {
    expect(isMarkerLinkSviluppatore('Sono uno sviluppatore, mi interessa l AI')).toBe(false);
    expect(isMarkerLinkSviluppatore(TESTO_PULSANTE_WEBINAR)).toBe(false);
    expect(isMarkerLinkSviluppatore(null)).toBe(false);
    expect(isMarkerLinkSviluppatore('')).toBe(false);
  });

  it('classifica come lancio_link con la provenienza del lancio, sul corrente o sul primo inbound', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_LINK_SVILUPPATORE, inboundCorrente: TESTO_LINK_SVILUPPATORE }))
      .toEqual({ tipo: 'lancio_link', provenienza: PROVENIENZA_LANCIO_WEBDEV });
    // Chi manda "ciao" e poi incolla la frase, o il contrario: la porta resta il link.
    expect(classificaPrimoMessaggio({ primoInbound: 'ciao', inboundCorrente: TESTO_LINK_SVILUPPATORE }).tipo).toBe('lancio_link');
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_LINK_SVILUPPATORE, inboundCorrente: 'quanto costa?' }).tipo).toBe('lancio_link');
  });

  it('non dipende dall interruttore del pulsante: vale sempre', () => {
    expect(classificaPrimoMessaggio({
      primoInbound: TESTO_LINK_SVILUPPATORE, inboundCorrente: TESTO_LINK_SVILUPPATORE, pulsanteAttivo: false,
    }).tipo).toBe('lancio_link');
  });

  it('il pulsante del webinar sul corrente vince sul link', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_LINK_SVILUPPATORE, inboundCorrente: TESTO_PULSANTE_WEBINAR }).tipo)
      .toBe('lancio_pulsante');
  });

  it('il link vince su Telegram: e la porta di adesso', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TELEGRAM, inboundCorrente: TESTO_LINK_SVILUPPATORE }).tipo).toBe('lancio_link');
  });

  it('si riaggancia come un inbound normale: lo gestisce Mario standard', () => {
    expect(vaRiagganciato({ tipo: 'lancio_link', provenienza: PROVENIENZA_LANCIO_WEBDEV })).toBe(true);
  });
});
