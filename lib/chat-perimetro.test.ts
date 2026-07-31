import { describe, it, expect } from 'vitest';
import { soloMondoFenice, isConversazioneChat, mondoDi, mondoLabel } from './chat-perimetro';

/** Finto query builder che registra le chiamate invece di parlare col DB. */
function fakeQuery() {
  const calls: { method: string; args: unknown[] }[] = [];
  const q: Record<string, unknown> = {};
  for (const m of ['or', 'eq', 'in']) {
    q[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return q; };
  }
  return { q, calls };
}

/** Finto client Supabase che restituisce una riga conversations fissa. */
function fakeClient(row: unknown) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row }) }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('soloMondoFenice', () => {
  it('con campagne fenice: un solo OR con mario, il video GDO e le campagne', () => {
    const { q, calls } = fakeQuery();
    soloMondoFenice(q, [7, 9]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('or');
    expect(calls[0].args[0]).toBe('ai_owner.eq.mario,gdo_video_sent_at.not.is.null,campaign_id.in.(7,9)');
  });

  it('senza campagne fenice: un solo OR con mario e il video GDO, mai un IN vuoto', () => {
    const { q, calls } = fakeQuery();
    soloMondoFenice(q, []);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('or');
    expect(calls[0].args[0]).toBe('ai_owner.eq.mario,gdo_video_sent_at.not.is.null');
    // `IN ()` è SQL invalido: non deve comparire in nessuna forma.
    expect(JSON.stringify(calls)).not.toContain('in.()');
  });
});

describe('isConversazioneChat', () => {
  it('dentro: lead di Mario', async () => {
    const c = fakeClient({ ai_owner: 'mario', campaign_id: null, campaign: null });
    expect(await isConversazioneChat(c, 1)).toBe(true);
  });

  it('dentro: lead GDO postino (è comunque ai_owner mario)', async () => {
    const c = fakeClient({ ai_owner: 'mario', campaign_id: 3, campaign: { owner: 'serenamente' } });
    expect(await isConversazioneChat(c, 1)).toBe(true);
  });

  it('dentro: conversazione di campagna fenice', async () => {
    const c = fakeClient({ ai_owner: null, campaign_id: 7, campaign: { owner: 'fenice' } });
    expect(await isConversazioneChat(c, 1)).toBe(true);
  });

  it('dentro: lead GDO video-only (script invio-video-agenda-gdo, senza ai_owner né campaign_id)', async () => {
    const c = fakeClient({ ai_owner: null, campaign_id: null, gdo_video_sent_at: '2026-07-31T10:00:00Z', campaign: null });
    expect(await isConversazioneChat(c, 1)).toBe(true);
  });

  it('fuori: Serenamente senza campagna', async () => {
    const c = fakeClient({ ai_owner: null, campaign_id: null, campaign: null });
    expect(await isConversazioneChat(c, 1)).toBe(false);
  });

  it('fuori: campagna non fenice', async () => {
    const c = fakeClient({ ai_owner: null, campaign_id: 3, campaign: { owner: 'serenamente' } });
    expect(await isConversazioneChat(c, 1)).toBe(false);
  });

  it('fuori: conversazione inesistente', async () => {
    const c = fakeClient(null);
    expect(await isConversazioneChat(c, 999)).toBe(false);
  });
});

describe('mondoDi', () => {
  it('GDO vince su tutto', () => {
    expect(mondoDi({ gdo_agenda_at: '2026-07-31T10:00:00Z', ai_owner: 'mario' })).toBe('GDO');
  });
  it('Mario quando non è postino', () => {
    expect(mondoDi({ gdo_agenda_at: null, ai_owner: 'mario' })).toBe('MARIO');
  });
  it('Campagna quando il bot non la governa', () => {
    expect(mondoDi({ gdo_agenda_at: null, ai_owner: null })).toBe('CAMPAGNA');
  });
  it('GDO anche solo col video (script video-only, senza agenda né ai_owner)', () => {
    expect(mondoDi({ gdo_agenda_at: null, ai_owner: null, gdo_video_sent_at: '2026-07-31T10:00:00Z' })).toBe('GDO');
  });
});

describe('mondoLabel', () => {
  it('forma compatta (default): GDO, Mario, Campagna', () => {
    expect(mondoLabel('GDO')).toBe('GDO');
    expect(mondoLabel('MARIO')).toBe('Mario');
    expect(mondoLabel('CAMPAGNA')).toBe('Campagna');
  });
  it('forma estesa: solo GDO cambia', () => {
    expect(mondoLabel('GDO', 'estesa')).toBe('GDO · postino');
    expect(mondoLabel('MARIO', 'estesa')).toBe('Mario');
    expect(mondoLabel('CAMPAGNA', 'estesa')).toBe('Campagna');
  });
});
