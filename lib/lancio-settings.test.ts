import { describe, it, expect } from 'vitest';
import { parseLancioSettings, isAttivo, LANCIO_SETTING_KEYS, LANCIO_SETTINGS_DEFAULT } from './lancio-settings';

describe('isAttivo — la chiave lancio_attivo si legge come 0/1 o booleano', () => {
  it('accende su true, 1, "1", "true", "on"', () => {
    for (const v of [true, 1, '1', 'true', 'on', ' TRUE ']) expect(isAttivo(v)).toBe(true);
  });
  it('spegne su tutto il resto, compresi null e stringa vuota', () => {
    for (const v of [false, 0, '0', 'false', 'off', '', null, undefined, {}]) expect(isAttivo(v)).toBe(false);
  });
});

describe('parseLancioSettings', () => {
  it('senza righe torna i default: spento e link vuoti', () => {
    expect(parseLancioSettings([])).toEqual(LANCIO_SETTINGS_DEFAULT);
  });

  it('legge le cinque chiavi', () => {
    const s = parseLancioSettings([
      { key: 'lancio_attivo', value: true },
      { key: 'lancio_zoom_link', value: 'https://us06web.zoom.us/j/89845223337' },
      { key: 'lancio_video_live_link', value: 'https://corso.feniceacademy.it/live-webdev' },
      { key: 'offerta_del_mese_link', value: 'https://corso.feniceacademy.it/offerta-webdev' },
      { key: 'lancio_evento_at', value: '2026-10-05T21:00:00+02:00' },
    ]);
    expect(s).toEqual({
      attivo: true,
      zoomLink: 'https://us06web.zoom.us/j/89845223337',
      videoLiveLink: 'https://corso.feniceacademy.it/live-webdev',
      offertaDelMeseLink: 'https://corso.feniceacademy.it/offerta-webdev',
      eventoAt: '2026-10-05T21:00:00+02:00',
    });
  });

  it('una stringa vuota o non stringa vale null: mai un link vuoto in un messaggio', () => {
    const s = parseLancioSettings([
      { key: 'lancio_video_live_link', value: '' },
      { key: 'offerta_del_mese_link', value: 42 },
      { key: 'lancio_evento_at', value: '  ' },
    ]);
    expect(s.videoLiveLink).toBeNull();
    expect(s.offertaDelMeseLink).toBeNull();
    expect(s.eventoAt).toBeNull();
  });

  it('chiavi estranee vengono ignorate', () => {
    expect(parseLancioSettings([{ key: 'fenice_ai_autoreply', value: true }]).attivo).toBe(false);
  });

  it('le chiavi sono esattamente quelle della spec §3.2', () => {
    expect([...LANCIO_SETTING_KEYS].sort()).toEqual([
      'lancio_attivo', 'lancio_evento_at', 'lancio_video_live_link', 'lancio_zoom_link', 'offerta_del_mese_link',
    ]);
  });
});
