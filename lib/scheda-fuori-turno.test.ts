import { describe, it, expect } from 'vitest';
import { notaSchedaFuoriTurno, schedaFuoriTurno } from './scheda-fuori-turno';

const LINK = 'Ciao, sono interessato alla professione di Video Editor e vorrei ricevere la scheda del corso';
const base = { aiOwner: 'mario', aiStatus: 'handed_off', aiPausedAt: null, professione: null as string | null, testo: LINK };

describe('schedaFuoriTurno (PO 10/11/2026, caso Naomi)', () => {
  it('chat handed_off con la frase del link: parte la scheda del corso della frase', () => {
    expect(schedaFuoriTurno(base)).toEqual({ slug: 'video_editor' });
  });
  it('booked e fermo manuale valgono come handed_off', () => {
    expect(schedaFuoriTurno({ ...base, aiStatus: 'booked' })).toEqual({ slug: 'video_editor' });
    expect(schedaFuoriTurno({ ...base, aiStatus: 'active', aiPausedAt: '2026-11-10T10:00:00Z' })).toEqual({ slug: 'video_editor' });
  });
  it('richiesta esplicita: vale il corso segnato sulla chat', () => {
    expect(schedaFuoriTurno({ ...base, testo: 'mi mandi il pdf?', professione: 'copywriter' })).toEqual({ slug: 'copywriter' });
  });
  it('richiesta senza corso noto: nessuno slug (solo la nota)', () => {
    expect(schedaFuoriTurno({ ...base, testo: 'mi mandi la brochure?' })).toEqual({ slug: null });
  });
  it('chat dove Mario risponde (active, closed) o non di Mario: niente, ci pensa il drain', () => {
    expect(schedaFuoriTurno({ ...base, aiStatus: 'active' })).toBeNull();
    expect(schedaFuoriTurno({ ...base, aiStatus: 'closed' })).toBeNull();
    expect(schedaFuoriTurno({ ...base, aiOwner: null })).toBeNull();
  });
  it('la regex non si allarga: "siete spariti" o "ho in programma" non sono richieste', () => {
    expect(schedaFuoriTurno({ ...base, testo: 'siete spariti' })).toBeNull();
    expect(schedaFuoriTurno({ ...base, testo: 'ho in programma di iniziare' })).toBeNull();
  });
});

describe('notaSchedaFuoriTurno', () => {
  it('cita il lead, dice cosa e partito e che il bot non ha risposto', () => {
    const n = notaSchedaFuoriTurno('inviata', 'video_editor', LINK);
    expect(n).toContain('Video Editor');
    expect(n).toContain('PDF');
    expect(n).toContain('Il bot non gli ha risposto');
    expect(notaSchedaFuoriTurno('senza_corso', null, 'pdf?')).toContain('chiediglielo');
    expect(notaSchedaFuoriTurno('gia_inviata', 'copywriter', 'pdf?')).toContain('sopra in chat');
  });
});
