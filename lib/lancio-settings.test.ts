import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseLancioSettings, isAttivo, LANCIO_SETTING_KEYS, LANCIO_SETTINGS_DEFAULT,
  LANCIO_EDITABLE_KEYS, validateLancioSettingInput,
} from './lancio-settings';

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

  it('legge le chiavi della spec', () => {
    const s = parseLancioSettings([
      { key: 'lancio_attivo', value: true },
      { key: 'lancio_pulsante_attivo', value: true },
      { key: 'lancio_zoom_link', value: 'https://us06web.zoom.us/j/89845223337' },
      { key: 'lancio_video_live_link', value: 'https://corso.feniceacademy.it/live-webdev' },
      { key: 'offerta_del_mese_link', value: 'https://corso.feniceacademy.it/offerta-webdev' },
      { key: 'lancio_evento_at', value: '2026-10-05T21:00:00+02:00' },
      { key: 'lancio_blast_perimetro', value: 'risposto' },
      { key: 'lancio_sender', value: 'secondario' },
    ]);
    expect(s).toEqual({
      attivo: true,
      pulsanteAttivo: true,
      zoomLink: 'https://us06web.zoom.us/j/89845223337',
      videoLiveLink: 'https://corso.feniceacademy.it/live-webdev',
      offertaDelMeseLink: 'https://corso.feniceacademy.it/offerta-webdev',
      eventoAt: '2026-10-05T21:00:00+02:00',
      blastPerimetro: 'risposto',
      sender: 'secondario',
    });
  });

  it('perimetro e mittente: nel dubbio si manda a tutti dal numero principale', () => {
    for (const v of [undefined, '', 'TUTTI', 'boh', 42, null]) {
      const s = parseLancioSettings([
        { key: 'lancio_blast_perimetro', value: v },
        { key: 'lancio_sender', value: v },
      ]);
      expect(s.blastPerimetro).toBe('tutti');
      expect(s.sender).toBe('principale');
    }
  });

  it('il perimetro si legge anche sporco di spazi e maiuscole', () => {
    const s = parseLancioSettings([
      { key: 'lancio_blast_perimetro', value: ' Risposto ' },
      { key: 'lancio_sender', value: ' SECONDARIO ' },
    ]);
    expect(s.blastPerimetro).toBe('risposto');
    expect(s.sender).toBe('secondario');
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

  it('le chiavi sono esattamente quelle della spec §3.2 + §11 e del pulsante (B2)', () => {
    expect([...LANCIO_SETTING_KEYS].sort()).toEqual([
      'lancio_attivo', 'lancio_blast_perimetro', 'lancio_evento_at', 'lancio_pulsante_attivo',
      'lancio_sender', 'lancio_video_live_link', 'lancio_zoom_link', 'offerta_del_mese_link',
    ]);
  });

  it('le chiavi nuove sono nella migrazione, o in produzione nascerebbero assenti', () => {
    const sql = readFileSync('supabase/migrations/20260914000001_lancio_webdev.sql', 'utf8');
    expect(sql).toContain("'lancio_blast_perimetro'");
    expect(sql).toContain("'lancio_sender'");
    expect(sql).toContain('on conflict (key) do nothing');
  });

  it('il pulsante e spento se la chiave manca o e scritta storta: si sbaglia verso il silenzio', () => {
    expect(parseLancioSettings([]).pulsanteAttivo).toBe(false);
    expect(parseLancioSettings([{ key: 'lancio_pulsante_attivo', value: 'forse' }]).pulsanteAttivo).toBe(false);
    expect(parseLancioSettings([{ key: 'lancio_pulsante_attivo', value: null }]).pulsanteAttivo).toBe(false);
    expect(parseLancioSettings([{ key: 'lancio_pulsante_attivo', value: true }]).pulsanteAttivo).toBe(true);
    expect(parseLancioSettings([{ key: 'lancio_pulsante_attivo', value: '1' }]).pulsanteAttivo).toBe(true);
  });

  it('il pulsante e indipendente da lancio_attivo: sono due interruttori diversi', () => {
    const s = parseLancioSettings([{ key: 'lancio_pulsante_attivo', value: true }]);
    expect(s.attivo).toBe(false);
    expect(s.pulsanteAttivo).toBe(true);
  });
});

describe('validateLancioSettingInput — le regole della pagina', () => {
  it('tutte e 8 le chiavi sono modificabili; una chiave estranea no', () => {
    expect([...LANCIO_EDITABLE_KEYS].sort()).toEqual([...LANCIO_SETTING_KEYS].sort());
    expect(validateLancioSettingInput('fenice_ai_autoreply', true)).toEqual({ ok: false, reason: 'chiave_non_modificabile' });
  });
  it('interruttori: booleano o 0/1/on/off; vuoto = spento; altro = errore', () => {
    for (const k of ['lancio_attivo', 'lancio_pulsante_attivo']) {
      expect(validateLancioSettingInput(k, true)).toEqual({ ok: true, value: true });
      expect(validateLancioSettingInput(k, '1')).toEqual({ ok: true, value: true });
      expect(validateLancioSettingInput(k, 'off')).toEqual({ ok: true, value: false });
      expect(validateLancioSettingInput(k, '')).toEqual({ ok: true, value: false });
      expect(validateLancioSettingInput(k, 'forse')).toEqual({ ok: false, reason: 'valore_non_valido' });
    }
  });
  it('link: https obbligatorio, spazi tolti, vuoto = azzera (stringa vuota)', () => {
    for (const k of ['offerta_del_mese_link', 'lancio_video_live_link', 'lancio_zoom_link']) {
      expect(validateLancioSettingInput(k, ' https://corso.feniceacademy.it/live-webdev ')).toEqual({ ok: true, value: 'https://corso.feniceacademy.it/live-webdev' });
      expect(validateLancioSettingInput(k, 'http://corso.feniceacademy.it/x')).toEqual({ ok: false, reason: 'link_non_https' });
      expect(validateLancioSettingInput(k, 'ciao')).toEqual({ ok: false, reason: 'link_non_https' });
      expect(validateLancioSettingInput(k, '')).toEqual({ ok: true, value: '' });
      expect(validateLancioSettingInput(k, null)).toEqual({ ok: true, value: '' });
    }
  });
  it('lancio_evento_at: ISO con offset, mai vuoto', () => {
    expect(validateLancioSettingInput('lancio_evento_at', '2026-10-05T21:00:00+02:00')).toEqual({ ok: true, value: '2026-10-05T21:00:00+02:00' });
    expect(validateLancioSettingInput('lancio_evento_at', '2026-10-05 21:00')).toEqual({ ok: false, reason: 'data_non_valida' });
    expect(validateLancioSettingInput('lancio_evento_at', '')).toEqual({ ok: false, reason: 'data_non_valida' });
  });
  it('perimetro e mittente: solo i due valori, vuoto = default', () => {
    expect(validateLancioSettingInput('lancio_blast_perimetro', ' Risposto ')).toEqual({ ok: true, value: 'risposto' });
    expect(validateLancioSettingInput('lancio_blast_perimetro', '')).toEqual({ ok: true, value: 'tutti' });
    expect(validateLancioSettingInput('lancio_blast_perimetro', 'alcuni')).toEqual({ ok: false, reason: 'valore_non_valido' });
    expect(validateLancioSettingInput('lancio_sender', 'secondario')).toEqual({ ok: true, value: 'secondario' });
    expect(validateLancioSettingInput('lancio_sender', null)).toEqual({ ok: true, value: 'principale' });
    expect(validateLancioSettingInput('lancio_sender', 'terzo')).toEqual({ ok: false, reason: 'valore_non_valido' });
  });
  it('un valore che il pannello sa scrivere e uno che parseLancioSettings sa rileggere', () => {
    // Il giro completo: quello che esce dalla validazione torna dentro `app_settings`
    // e deve rileggersi identico, o la pagina salverebbe valori muti.
    const v = validateLancioSettingInput('lancio_zoom_link', ' https://us06web.zoom.us/j/1 ');
    expect(v.ok && parseLancioSettings([{ key: 'lancio_zoom_link', value: v.value }]).zoomLink)
      .toBe('https://us06web.zoom.us/j/1');
    const off = validateLancioSettingInput('lancio_video_live_link', '   ');
    expect(off.ok && parseLancioSettings([{ key: 'lancio_video_live_link', value: off.value }]).videoLiveLink)
      .toBeNull();
  });
});
