import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { deveSegnalare, segnalaRispostaDopoTerzoNr } from './risposta-post-nr';
import { buildRispostaPostNrNote } from './bot-outcome-rules';

const NR = '2026-08-29T10:00:00.000Z';

describe('deveSegnalare', () => {
  it('segnala quando il lead scrive dopo il messaggio del terzo tentativo', () => {
    expect(deveSegnalare({
      terzoNrInviatoAt: NR,
      ultimoInboundAt: '2026-08-29T10:04:00.000Z',
      giaSegnalato: false,
    })).toBe(true);
  });

  it('non segnala se il lead non ha mai scritto dopo', () => {
    expect(deveSegnalare({
      terzoNrInviatoAt: NR,
      ultimoInboundAt: '2026-08-29T09:12:00.000Z',
      giaSegnalato: false,
    })).toBe(false);
  });

  it('non segnala due volte: due messaggi di fila del lead sono una notifica sola', () => {
    expect(deveSegnalare({
      terzoNrInviatoAt: NR,
      ultimoInboundAt: '2026-08-29T10:04:00.000Z',
      giaSegnalato: true,
    })).toBe(false);
  });

  it('non segnala se il terzo tentativo non e\' mai partito', () => {
    expect(deveSegnalare({
      terzoNrInviatoAt: null,
      ultimoInboundAt: '2026-08-29T10:04:00.000Z',
      giaSegnalato: false,
    })).toBe(false);
  });

  it('non segnala se il lead non ha mai scritto', () => {
    expect(deveSegnalare({ terzoNrInviatoAt: NR, ultimoInboundAt: null, giaSegnalato: false })).toBe(false);
  });

  it('una data illeggibile non fa partire niente', () => {
    expect(deveSegnalare({ terzoNrInviatoAt: 'boh', ultimoInboundAt: 'mai', giaSegnalato: false })).toBe(false);
  });
});

describe('buildRispostaPostNrNote', () => {
  it('dice il fatto e riporta le parole del lead', () => {
    const n = buildRispostaPostNrNote({ leadWords: 'Si scusate ero al lavoro', quandoNrIso: NR });
    expect(n).toContain('HA RISPOSTO DOPO IL TERZO TENTATIVO');
    expect(n).toContain('"Si scusate ero al lavoro"');
  });

  it('regge anche senza parole: il fatto resta quello', () => {
    const n = buildRispostaPostNrNote({ quandoNrIso: NR });
    expect(n).toContain('HA RISPOSTO DOPO IL TERZO TENTATIVO');
    expect(n).not.toContain('""');
  });

  it('dice quando gli avevamo scritto, in ora italiana e per esteso', () => {
    // Le legge una persona pochi minuti prima di telefonare: "sabato 29 agosto alle
    // 12:00" si capisce a colpo d'occhio, una data ISO no.
    expect(buildRispostaPostNrNote({ quandoNrIso: NR })).toContain('29 agosto alle 12:00');
  });
});

describe('segnalaRispostaDopoTerzoNr — chat 32198: chi chiede di non essere più contattato non è «recuperabile»', () => {
  // Finto minimo: l'evento del terzo tentativo, nessuna segnalazione precedente, l'ultimo
  // messaggio del lead. Registra gli insert su event_log.
  function finto(ultimoInbound: string) {
    const eventi: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const supabase = {
      from(tabella: string) {
        const filtri: Record<string, unknown> = {};
        const q: Record<string, unknown> = {
          select() { return q; },
          eq(col: string, val: unknown) { filtri[col] = val; return q; },
          order() { return q; },
          limit() { return q; },
          maybeSingle() {
            if (tabella === 'messages') return Promise.resolve({ data: { body: ultimoInbound, created_at: '2026-11-12T15:47:40.000Z' } });
            if (tabella === 'conversations') return Promise.resolve({ data: { crm_lead_id: 'lead-32198', bot_outcome: 'INTERROTTO', bot_scheduled_at: null, gdo_appuntamento_at: '2026-11-12T16:00:00+00:00', wa_number: null } });
            if (filtri.type === 'recupero_nr_inviato') return Promise.resolve({ data: { created_at: '2026-11-12T15:46:59.000Z' } });
            const gia = eventi.find((e) => e.type === filtri.type);
            return Promise.resolve({ data: gia ? { id: 1 } : null });
          },
          insert(riga: { type: string; payload: Record<string, unknown> }) { eventi.push(riga); return Promise.resolve({ error: null }); },
        };
        return q;
      },
    };
    return { supabase: supabase as never, eventi };
  }

  beforeEach(() => {
    vi.stubEnv('BOT_WEBHOOK_SECRET', 'segreto');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('«non voglio più essere contatta»: nessuna segnalazione al CRM, lucchetto scritto', async () => {
    const { supabase, eventi } = finto('Allora oggi non posso dato che insistete non voglio più essere contatta');
    const r = await segnalaRispostaDopoTerzoNr(supabase, 32198, 'lead-32198');
    expect(r).toEqual({ segnalato: false, motivo: 'stop_contatti' });
    expect(fetch).not.toHaveBeenCalled();
    expect(eventi).toHaveLength(1);
    expect(eventi[0]).toMatchObject({ type: 'risposta_post_nr_segnalata', payload: { stopContatti: true, segnalato: false } });
    // Il «grazie» che segue trova il lucchetto e non parte come «recuperabile».
    const dopo = await segnalaRispostaDopoTerzoNr(supabase, 32198, 'lead-32198');
    expect(dopo).toEqual({ segnalato: false, motivo: 'niente_da_segnalare' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('una risposta normale («ero al lavoro») si segnala come prima', async () => {
    const { supabase, eventi } = finto('Si scusate ero al lavoro');
    const r = await segnalaRispostaDopoTerzoNr(supabase, 32198, 'lead-32198');
    expect(r).toEqual({ segnalato: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const corpo = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as { body: string }).body);
    expect(corpo).toMatchObject({ outcome: 'CONTATTO_UMANO', motivo: 'risposta_dopo_terzo_nr' });
    expect(corpo.note).toContain('ancora recuperabile');
    expect(eventi.some((e) => e.type === 'risposta_post_nr_segnalata' && !e.payload.stopContatti)).toBe(true);
  });
});
