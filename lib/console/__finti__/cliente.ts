// Client Supabase finto per i test del registro azioni: `event_log` e' una tabella in
// memoria con id crescenti (serve al monouso per nonce), le altre tabelle rispondono con
// i dati passati. Solo per i test.

export type Riga = Record<string, unknown>;
export type Scrittura = { tabella: string; op: 'insert' | 'upsert' | 'update'; riga: Riga; filtri: Riga };

export function clienteFinto(dati: {
  conv?: Riga | null;
  settings?: Record<string, unknown>;
  eventi?: Riga[];
  adesso?: string;
  erroreUpdate?: string;
  /** Un messaggio d'errore per gli insert da far fallire, `null` per lasciarli passare. */
  falliscoInsert?: (riga: Riga) => string | null;
} = {}) {
  const eventi: Riga[] = (dati.eventi ?? []).map((r, i) => ({ id: i + 1, ...r }));
  let prossimo = eventi.length + 1;
  const scritture: Scrittura[] = [];
  const adesso = () => dati.adesso ?? new Date().toISOString();

  const from = (tabella: string) => {
    const filtri: ((r: Riga) => boolean)[] = [];
    const filtriEq: Riga = {};
    let update: Riga | null = null;
    let ordine: { col: string; asc: boolean } | null = null;
    let limite: number | null = null;
    const val = (r: Riga, k: string) => (k.startsWith('payload->>') ? (r.payload as Riga | null)?.[k.slice(10)] : r[k]);

    const singola = () => {
      if (tabella === 'conversations') return dati.conv ?? null;
      if (tabella === 'app_settings') {
        const k = String(filtriEq.key);
        return dati.settings && k in dati.settings ? { value: dati.settings[k] } : null;
      }
      return null;
    };
    const righe = () => {
      if (tabella !== 'event_log') return [];
      let x = eventi.filter((r) => filtri.every((f) => f(r)));
      if (ordine) {
        const { col, asc } = ordine;
        x = [...x].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
        if (col === 'id') x.sort((a, b) => ((a.id as number) - (b.id as number)) * (asc ? 1 : -1));
      }
      return limite === null ? x : x.slice(0, limite);
    };

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => { filtriEq[k] = v; filtri.push((r) => String(val(r, k)) === String(v)); return b; },
      gte: (k: string, v: unknown) => { filtri.push((r) => String(val(r, k)) >= String(v)); return b; },
      lt: (k: string, v: unknown) => { filtri.push((r) => String(val(r, k)) < String(v)); return b; },
      abortSignal: () => b,
      in: (k: string, vs: unknown[]) => { filtri.push((r) => vs.map(String).includes(String(val(r, k)))); return b; },
      order: (col: string, o?: { ascending?: boolean }) => { ordine = { col, asc: o?.ascending !== false }; return b; },
      limit: (n: number) => { limite = n; return b; },
      maybeSingle: async () => ({ data: singola(), error: null }),
      insert: (riga: Riga) => {
        const errore = dati.falliscoInsert?.(riga) ?? null;
        let id: number | null = null;
        if (!errore) {
          id = prossimo++;
          if (tabella === 'event_log') eventi.push({ id, created_at: adesso(), ...riga });
          scritture.push({ tabella, op: 'insert', riga, filtri: filtriEq });
        }
        const res = { data: id === null ? null : { id }, error: errore ? { message: errore } : null };
        return Object.assign(Promise.resolve({ error: res.error }), { select: () => ({ single: async () => res }) });
      },
      upsert: async (riga: Riga) => {
        scritture.push({ tabella, op: 'upsert', riga, filtri: filtriEq });
        if (dati.settings) dati.settings[String(riga.key)] = riga.value;
        return { error: null };
      },
      update: (riga: Riga) => { update = riga; return b; },
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => {
        if (update) {
          scritture.push({ tabella, op: 'update', riga: update, filtri: filtriEq });
          return Promise.resolve({ error: dati.erroreUpdate ? { message: dati.erroreUpdate } : null }).then(ok, ko);
        }
        return Promise.resolve({ data: righe(), error: null }).then(ok, ko);
      },
    };
    return b;
  };
  return { s: { from } as never, scritture, eventi };
}
