import { it, expect } from 'vitest';
import { avvisiSistema, azioniPer, componiAvvisi, firmaAvviso, TIPI_SISTEMA } from './avvisi';
const now = new Date('2026-10-05T19:00:00Z');
const ev = (type: string, conv: number, at = '2026-10-05T18:30:00Z') => ({ id: Math.random(), type, created_at: at, level: 'error', message: '', payload: { conversationId: conv } });

it('raggruppa per tipo, conta le chat distinte, primo e ultimo', () => {
  const a = avvisiSistema([ev('gdo_agenda_error', 1, '2026-10-05T18:00:00Z'), ev('gdo_agenda_error', 1), ev('gdo_agenda_error', 2, '2026-10-05T18:40:00Z')], {}, now);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ area: 'gdo', conteggio: 2, primoAt: '2026-10-05T18:00:00Z', ultimoAt: '2026-10-05T18:40:00Z' });
  expect(a[0].chat).toEqual([2, 1]); // dalla piu' recente
});
it('tipi sconosciuti ignorati', () => {
  expect(avvisiSistema([ev('qualcosa_di_nuovo', 1)], {}, now)).toEqual([]);
});
it('cron fermo quando l\'ultimo giro e\' piu\' vecchio del doppio del periodo', () => {
  const a = avvisiSistema([], { 'bot-followups': '2026-10-05T16:00:00Z' }, now);
  expect(a.find((x) => x.id === 'cron_bot-followups')?.azioni[0]).toMatchObject({ azione: 'rilancia_cron', params: { cron: 'bot-followups' } });
  expect(avvisiSistema([], { 'bot-followups': '2026-10-05T18:10:00Z' }, now).find((x) => x.id === 'cron_bot-followups')).toBeUndefined();
});
it('azioni per gli avvisi del lancio', () => {
  const base = { gravita: 'critico' as const, titolo: '', significato: '', cosaFare: '', conteggio: 1, chat: [], ultimoAt: null };
  expect(azioniPer({ ...base, id: 'run_fermo_aperture' })[0]).toMatchObject({ azione: 'rilancia_cron', params: { cron: 'lancio-aperture' } });
  expect(azioniPer({ ...base, id: 'zoom_cron_fermo' })[0]).toMatchObject({ azione: 'rilancia_cron', params: { cron: 'lancio-zoom' } });
  expect(azioniPer({ ...base, id: 'lancio_spento' })[0]).toMatchObject({ azione: 'interruttore', params: { chiave: 'lancio_attivo', valore: true } });
  expect(azioniPer({ ...base, id: 'pulsante_spento' })[0]).toMatchObject({ azione: 'interruttore', params: { chiave: 'lancio_pulsante_attivo', valore: true } });
  expect(azioniPer({ ...base, id: 'crm' })[0]).toMatchObject({ azione: 'rinvia_esiti_403' });
  expect(azioniPer({ ...base, id: 'twilio_63016' })).toEqual([]);
});
it('i risolti restano nascosti finche\' la firma non cambia', () => {
  const s = avvisiSistema([ev('fenice_ai_error', 1)], {}, now);
  const f = firmaAvviso(s[0]);
  expect(componiAvvisi([], s, new Map([[s[0].id, f]]))).toEqual([]);
  expect(componiAvvisi([], s, new Map([[s[0].id, 'vecchia']]))).toHaveLength(1);
});
it('ogni tipo di sistema ha testi completi', () => {
  for (const [t, d] of Object.entries(TIPI_SISTEMA)) expect(d.titolo && d.significato && d.cosaFare, t).toBeTruthy();
});

it('un risolto resta nascosto anche se il conteggio scende e ultimoAt non cambia', () => {
  const s = avvisiSistema([ev('gdo_agenda_error', 1), ev('gdo_agenda_error', 2)], {}, now);
  const f = firmaAvviso(s[0]);
  const meno = avvisiSistema([ev('gdo_agenda_error', 1)], {}, now);
  expect(meno[0].conteggio).toBeLessThan(s[0].conteggio);
  expect(firmaAvviso(meno[0])).toBe(f);
  expect(componiAvvisi([], meno, new Map([[meno[0].id, f]]))).toEqual([]);
});
it("i tagli tengono le chat piu' recenti", () => {
  const evs = Array.from({ length: 60 }, (_, i) => ev('booked_without_outcome', i + 1, new Date(Date.UTC(2026, 9, 5, 10, i)).toISOString()));
  const [a] = avvisiSistema(evs, {}, now);
  expect(a.chat).toHaveLength(50);
  expect(a.chat[0]).toBe(60);
  expect(a.chat).not.toContain(1);
  expect(a.azioni).toHaveLength(20);
  expect(a.azioni[0].params).toEqual({ conversationId: 60 });
});
it('cron null = fermo, chiave assente = nessun avviso', () => {
  expect(avvisiSistema([], { 'bot-followups': null }, now).map((x) => x.id)).toEqual(['cron_bot-followups']);
  expect(avvisiSistema([], {}, now)).toEqual([]);
});
it('run_fermo_inizio non ha azioni', () => {
  const base = { gravita: 'critico' as const, titolo: '', significato: '', cosaFare: '', conteggio: 1, chat: [], ultimoAt: null };
  expect(azioniPer({ ...base, id: 'run_fermo_inizio' })).toEqual([]);
});
