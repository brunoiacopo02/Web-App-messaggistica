import { describe, it, expect } from 'vitest';
import {
  BLACK_SUMMER_LINK,
  DEDUP_WINDOW_MS,
  esitoFromTwilioStatus,
  gdoAgendaText,
  gdoVideoText,
  isDedupHit,
  videoLinkForVariant,
  waitForDelivery,
} from './gdo-agenda';
import { KNOWN_LINKS } from './outbound-sanitize';

const V = (lavora: boolean, haFamiglia: boolean, offertaDelMese = false) => ({ lavora, haFamiglia, offertaDelMese });

describe('videoLinkForVariant', () => {
  it('lavora senza famiglia → bx', () => {
    expect(videoLinkForVariant(V(true, false))).toBe('https://corso.feniceacademy.it/conferenza-bx');
  });
  it('non lavora senza famiglia → axmsbn9r50', () => {
    expect(videoLinkForVariant(V(false, false))).toBe('https://corso.feniceacademy.it/conferenza-axmsbn9r50');
  });
  it('lavora con famiglia → dx', () => {
    expect(videoLinkForVariant(V(true, true))).toBe('https://corso.feniceacademy.it/conferenza-dx');
  });
  it('non lavora con famiglia → ex', () => {
    expect(videoLinkForVariant(V(false, true))).toBe('https://corso.feniceacademy.it/conferenza-ex');
  });
  it('offertaDelMese prevale su lavora e famiglia', () => {
    expect(videoLinkForVariant(V(true, true, true))).toBe(BLACK_SUMMER_LINK);
    expect(videoLinkForVariant(V(false, false, true))).toBe(BLACK_SUMMER_LINK);
  });
  it('ogni link è nella whitelist: il bot non deve segnalarlo come inventato', () => {
    for (const variant of [V(true, false), V(false, false), V(true, true), V(false, true), V(true, true, true)]) {
      expect(KNOWN_LINKS as readonly string[]).toContain(videoLinkForVariant(variant));
    }
  });
});

describe('esitoFromTwilioStatus', () => {
  it('delivered e read → consegnato', () => {
    expect(esitoFromTwilioStatus('delivered')).toBe('consegnato');
    expect(esitoFromTwilioStatus('read')).toBe('consegnato');
  });
  it('failed e undelivered → fallito', () => {
    expect(esitoFromTwilioStatus('failed')).toBe('fallito');
    expect(esitoFromTwilioStatus('undelivered')).toBe('fallito');
  });
  it('stati intermedi, sconosciuti o assenti → inviato', () => {
    expect(esitoFromTwilioStatus('queued')).toBe('inviato');
    expect(esitoFromTwilioStatus('sent')).toBe('inviato');
    expect(esitoFromTwilioStatus('accepted')).toBe('inviato');
    expect(esitoFromTwilioStatus('boh')).toBe('inviato');
    expect(esitoFromTwilioStatus(null)).toBe('inviato');
  });
});

/** Orologio finto: `sleep` fa avanzare il tempo invece di aspettarlo davvero. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

describe('waitForDelivery', () => {
  it('già consegnato → esito consegnato senza aspettare', async () => {
    const clock = fakeClock();
    let letture = 0;
    const esito = await waitForDelivery({
      readStatus: async () => { letture++; return 'delivered'; },
      now: clock.now, sleep: clock.sleep,
    });
    expect(esito).toBe('consegnato');
    expect(letture).toBe(1);
    expect(clock.now()).toBe(0);
  });

  it('fallimento vero → esito fallito subito, senza consumare gli 8 secondi', async () => {
    const clock = fakeClock();
    const esito = await waitForDelivery({
      readStatus: async () => 'failed',
      now: clock.now, sleep: clock.sleep,
    });
    expect(esito).toBe('fallito');
    expect(clock.now()).toBe(0);
  });

  it('consegna che arriva mentre aspettiamo → consegnato', async () => {
    const clock = fakeClock();
    const stati = ['queued', 'sent', 'delivered'];
    let i = 0;
    const esito = await waitForDelivery({
      readStatus: async () => stati[Math.min(i++, stati.length - 1)],
      now: clock.now, sleep: clock.sleep,
    });
    expect(esito).toBe('consegnato');
    expect(clock.now()).toBeGreaterThan(0);
  });

  it('telefono spento: nessun delivered entro 8s → inviato (mai fallito)', async () => {
    const clock = fakeClock();
    const esito = await waitForDelivery({
      readStatus: async () => 'sent',
      now: clock.now, sleep: clock.sleep,
    });
    expect(esito).toBe('inviato');
    // Il CRM va in timeout a ~10s: non possiamo sforare gli 8.
    expect(clock.now()).toBeLessThanOrEqual(8_000);
    expect(clock.now()).toBeGreaterThanOrEqual(8_000 - 500);
  });

  it('riga non ancora leggibile (status null) → continua a controllare, poi inviato', async () => {
    const clock = fakeClock();
    let letture = 0;
    const esito = await waitForDelivery({
      readStatus: async () => { letture++; return null; },
      now: clock.now, sleep: clock.sleep,
    });
    expect(esito).toBe('inviato');
    expect(letture).toBeGreaterThan(1);
  });

  it('una lettura che esplode non fa fallire l\'invio: si continua a controllare', async () => {
    const clock = fakeClock();
    let letture = 0;
    const esito = await waitForDelivery({
      readStatus: async () => {
        letture++;
        if (letture === 1) throw new Error('supabase down');
        return 'delivered';
      },
      now: clock.now, sleep: clock.sleep,
    });
    expect(esito).toBe('consegnato');
  });
});

describe('isDedupHit', () => {
  const NOW = 1_000_000_000;
  it('nessun invio precedente → si manda', () => {
    expect(isDedupHit({ lastAgendaAtMs: null, lastEsito: null, nowMs: NOW })).toBe(false);
  });
  it('stesso lead entro 15 minuti dopo una consegna → non si rimanda', () => {
    expect(isDedupHit({ lastAgendaAtMs: NOW - 60_000, lastEsito: 'consegnato', nowMs: NOW })).toBe(true);
  });
  it('entro 15 minuti dopo un "inviato" → non si rimanda (il telefono può tornare online)', () => {
    expect(isDedupHit({ lastAgendaAtMs: NOW - 60_000, lastEsito: 'inviato', nowMs: NOW })).toBe(true);
  });
  it('entro 15 minuti dopo un fallimento vero → si può ritentare', () => {
    expect(isDedupHit({ lastAgendaAtMs: NOW - 60_000, lastEsito: 'fallito', nowMs: NOW })).toBe(false);
  });
  it('oltre la finestra di 15 minuti → si rimanda', () => {
    expect(isDedupHit({ lastAgendaAtMs: NOW - DEDUP_WINDOW_MS, lastEsito: 'consegnato', nowMs: NOW })).toBe(false);
  });
  it('esito precedente sconosciuto entro la finestra → prudenza, non si rimanda', () => {
    expect(isDedupHit({ lastAgendaAtMs: NOW - 60_000, lastEsito: null, nowMs: NOW })).toBe(true);
  });
});

describe('gdoVideoText', () => {
  const LINK = 'https://corso.feniceacademy.it/conferenza-bx';
  it('usa solo il nome proprio e contiene il link della variante', () => {
    const t = gdoVideoText('MARIO ROSSI', LINK);
    expect(t).toContain('Ciao Mario,');
    expect(t).not.toContain('ROSSI');
    expect(t).toContain(LINK);
  });
  it('senza nome usabile saluta comunque, senza vocativo posticcio', () => {
    const t = gdoVideoText(null, LINK);
    expect(t.startsWith('Ciao, ')).toBe(true);
    expect(t).not.toContain('a te');
  });
  it('chiede il FATTO come il resto del flusso e ricorda che il video precede la call', () => {
    const t = gdoVideoText('Anna', LINK);
    expect(t).toContain('FATTO');
    expect(t).toContain('20 minuti');
  });
});

describe('gdoAgendaText', () => {
  it('ricalca il template approvato: nessun nome di collega, link di prenotazione, invito a rispondere', () => {
    const t = gdoAgendaText('MARIO ROSSI');
    expect(t).toContain('Ciao Mario,');
    expect(t).toContain('il mio collega');
    expect(t).toContain('https://form.jotform.com/240755654585063');
    expect(t.toLowerCase()).toContain('rispondimi');
  });
  it('senza nome usabile usa il vocativo neutro dei template', () => {
    expect(gdoAgendaText(null)).toContain('Ciao a te,');
  });
});
// Guardia di drift: il body replicato in codice deve restare identico al template
// approvato `fenice_agenda_gdo_v3` (letto dalla Content API il 29/07/2026), altrimenti
// l'inbox e il contesto di Mario mostrerebbero un messaggio diverso da quello ricevuto.
const TEMPLATE_V3 =
  "Ciao {{1}}, sono Marta di Fenice Academy 🙂 come ti ha detto il mio collega ti mando qui il link per scegliere giorno e ora della videocall 👉 https://form.jotform.com/240755654585063\nRispondimi qui con un ok quando l'hai aperto, così ti mando il video da vedere prima della call";

describe('gdoAgendaText — nessun drift dal template approvato', () => {
  it('coincide col body di fenice_agenda_gdo_v3, variabile {{1}} risolta', () => {
    expect(gdoAgendaText('Anna')).toBe(TEMPLATE_V3.replace('{{1}}', 'Anna'));
  });
});
