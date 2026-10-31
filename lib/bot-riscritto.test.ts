import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/bot-outcome', () => ({
  sendCrmNota: vi.fn(async () => ({ sent: true })),
}));

import { sendCrmNota } from '@/lib/bot-outcome';
import { notaRiscrittoSeDovuta, EVENTO_NOTA_RISCRITTO, FINESTRA_NOTA_RISCRITTO_MS } from './bot-riscritto';

type Riga = { id: number; type: string; payload: Record<string, unknown>; created_at: string };

/** event_log in memoria, con solo le catene usate da `notaRiscrittoSeDovuta`. */
function fakeSupabase(righe: Riga[]) {
  let prossimo = righe.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  return {
    from() {
      return {
        insert(v: Omit<Riga, 'id' | 'created_at'>) {
          const riga = { ...v, id: prossimo++, created_at: new Date().toISOString() } as Riga;
          righe.push(riga);
          const res = { data: null, error: null };
          return Object.assign(Promise.resolve(res), {
            select: () => ({ single: async () => ({ data: { id: riga.id }, error: null }) }),
          });
        },
        select() {
          const filtri: Array<(r: Riga) => boolean> = [];
          const q = {
            eq(col: string, val: string) {
              filtri.push(col === 'type' ? (r) => r.type === val : (r) => String(r.payload.conversationId) === val);
              return q;
            },
            gte(_c: string, da: string) { filtri.push((r) => r.created_at >= da); return q; },
            order() { return q; },
            limit() { return q; },
            async maybeSingle() {
              const trovate = righe.filter((r) => filtri.every((f) => f(r))).sort((a, b) => a.id - b.id);
              return { data: trovate[0] ? { id: trovate[0].id } : null, error: null };
            },
          };
          return q;
        },
        delete() {
          return {
            async eq(_c: string, id: number) {
              const i = righe.findIndex((r) => r.id === id);
              if (i >= 0) righe.splice(i, 1);
              return { error: null };
            },
          };
        },
      };
    },
  } as never;
}

const base = { conversationId: 42, crmLeadId: 'lead-1', esitoPrecedente: 'INTERROTTO' };

describe('notaRiscrittoSeDovuta', () => {
  beforeEach(() => {
    vi.mocked(sendCrmNota).mockReset();
    vi.mocked(sendCrmNota).mockResolvedValue({ sent: true });
  });

  it('prima riscrittura: una nota con le parole del lead, senza "non chiamatelo"', async () => {
    const righe: Riga[] = [];
    await notaRiscrittoSeDovuta(fakeSupabase(righe), { ...base, testo: 'Ci sono, mi richiamate?' });
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    const nota = String(vi.mocked(sendCrmNota).mock.calls[0][2]);
    expect(nota).toContain('«Ci sono, mi richiamate?»');
    expect(nota).toContain('Il lead è vostro: richiamatelo.');
    expect(nota.toLowerCase()).not.toContain('non chiamatelo');
    expect(righe.filter((r) => r.type === EVENTO_NOTA_RISCRITTO)).toHaveLength(1);
  });

  it('i saluti dopo, nella stessa finestra di 6 ore: nessuna altra nota', async () => {
    const righe: Riga[] = [];
    const s = fakeSupabase(righe);
    await notaRiscrittoSeDovuta(s, { ...base, testo: 'Ci sono' });
    await notaRiscrittoSeDovuta(s, { ...base, testo: 'grazie' });
    await notaRiscrittoSeDovuta(s, { ...base, testo: 'a presto' });
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(righe.filter((r) => r.type === EVENTO_NOTA_RISCRITTO)).toHaveLength(1);
  });

  it('oltre le 6 ore la nota riparte; un\'altra conversazione non è bloccata', async () => {
    const vecchia = new Date(Date.now() - FINESTRA_NOTA_RISCRITTO_MS - 60_000).toISOString();
    const righe: Riga[] = [{ id: 1, type: EVENTO_NOTA_RISCRITTO, payload: { conversationId: 42 }, created_at: vecchia }];
    const s = fakeSupabase(righe);
    await notaRiscrittoSeDovuta(s, { ...base, testo: 'eccomi' });
    await notaRiscrittoSeDovuta(s, { ...base, conversationId: 43, testo: 'eccomi' });
    expect(sendCrmNota).toHaveBeenCalledTimes(2);
  });

  it('se il CRM non la prende, il lucchetto si toglie e il messaggio dopo riprova', async () => {
    const righe: Riga[] = [];
    const s = fakeSupabase(righe);
    vi.mocked(sendCrmNota).mockResolvedValueOnce({ sent: false, status: 500, error: 'http_500' });
    await notaRiscrittoSeDovuta(s, { ...base, testo: 'ci sono' });
    expect(righe.filter((r) => r.type === EVENTO_NOTA_RISCRITTO)).toHaveLength(0);
    expect(righe.some((r) => r.type === 'bot_nota_riscritto_fallita')).toBe(true);
    await notaRiscrittoSeDovuta(s, { ...base, testo: 'ci sono?' });
    expect(sendCrmNota).toHaveBeenCalledTimes(2);
  });
});
