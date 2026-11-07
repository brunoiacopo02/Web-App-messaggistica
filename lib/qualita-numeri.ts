/**
 * Controllo automatico della qualita' dei numeri del bot (PO 29/10/2026).
 *
 * Regole decise da Bruno:
 * - Un numero delle aperture a freddo (i secondari) che scende sotto HIGH (MEDIUM o
 *   LOW) si ferma per 3 giorni: tetto 0 in `tetti_numeri`. Le sue aperture vanno
 *   sugli altri numeri del giro (vedi lib/scelta-mittente.ts), non sul 3199 e non
 *   ai GDO. Dopo 3 giorni riparte col tetto di prima se e' HIGH, altrimenti la pausa
 *   si allunga di altri 3 giorni.
 * - Mai fermare l'ultimo numero del giro: se resterebbero zero numeri aperti, si
 *   scrive un warn e il numero resta acceso (lo decide una persona).
 * - Il 3199 (primario) rientra dopo 4 giorni HIGH di fila con tetto 15 aperture di
 *   Mario al giorno (PO 06/11/2026: il 3199 resta basso apposta, e' uno dei due numeri
 *   del trabocco). Non sale piu' da solo: il gradino a 100000 del 29/10 e' tolto. Se
 *   scende sotto HIGH in qualunque momento esce subito e si riparte da capo.
 * - Promozioni una tantum (PO 07/11/2026, `PROMOZIONI_TETTI`): 2245 e 2508 da 30 a 50
 *   dopo 3 giorni HIGH di fila, il 3199 da 15 a 30 dopo 7. Mai verso il basso, mai
 *   due volte, mai su altri numeri; evento `tetto_promosso` col totale da mettere a mano
 *   in BOT_TETTO_GIORNALIERO del CRM.
 *
 * Stato in `app_settings.qualita_numeri_stato` (storico per giorno = la lettura
 * peggiore del giorno, pause in corso). I numeri a tetto 0 messi a mano (non in
 * pausa qui) non si toccano mai.
 *
 * Interruttore: `QUALITA_NUMERI_AUTO=off` legge e scrive lo storico ma non cambia
 * nessun tetto (le decisioni restano solo nell'event_log).
 *
 * `decidi` e' puro e testato in qualita-numeri.test.ts; `eseguiControlloQualita`
 * fa la rete e il DB.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { numeroPrimario, numeriSecondari } from './mittente';
import { credenzialiPerMittente } from './twilio-account';
import { getTettiNumeri } from './tetti-numeri';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type Qualita = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export type StatoQualita = {
  /** numero (senza `whatsapp:`) → giorno (YYYY-MM-DD, Roma) → lettura peggiore del giorno */
  storico: Record<string, Record<string, Qualita>>;
  /** numero → pausa in corso */
  pause: Record<string, { fino: string; tettoPrima: number; dal: string }>;
  /** Il 3199 in rientro: a 30 dal giorno `dal`, in attesa dei 4 giorni HIGH per tornare a regime. */
  primario?: { fase: 'trenta'; dal: string } | null;
  /** Promozioni una tantum gia' fatte (numero senza `whatsapp:`): non si rifanno mai. */
  promozioni?: Record<string, { giorno: string; da: number; a: number }>;
};

/**
 * Promozioni automatiche una tantum dei tetti (PO 07/11/2026): quando il numero e' HIGH
 * da `giorniHigh` giorni di fila (oggi compreso), il suo tetto sale ad `a`. Una volta
 * sola per numero (segnata in `stato.promozioni`), mai verso il basso, mai su un numero
 * in pausa o a tetto 0 (fermo per mano di una persona o uscito), nessun altro numero.
 * Il CRM ha un suo tetto somma (BOT_TETTO_GIORNALIERO) che va alzato a mano: per questo
 * ogni promozione scrive un evento `tetto_promosso` col nuovo totale suggerito.
 */
export const PROMOZIONI_TETTI: { numero: string; a: number; giorniHigh: number }[] = [
  { numero: '+393522622245', a: 50, giorniHigh: 3 },
  { numero: '+393522782508', a: 50, giorniHigh: 3 },
  { numero: '+393520413199', a: 30, giorniHigh: 7 },
];

/** Somma di tutti i tetti di `tetti_numeri`: e' il numero da mettere in BOT_TETTO_GIORNALIERO (07/11: 190). */
export function sommaTetti(tetti: Record<string, number>): number {
  return Object.values(tetti).reduce((s, v) => s + (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0), 0);
}

export const GIORNI_PAUSA = 3;
/** Giorni HIGH di fila per ogni gradino del rientro del 3199 (PO 29/10/2026 sera). */
export const GIORNI_HIGH_PER_RIENTRO = 4;
/** PO 06/11/2026: 15 aperture di Mario al giorno (era 30, poi 100000 a regime). */
export const TETTO_RIENTRO_PRIMARIO = 15;
const GIORNI_STORICO = 21;
const KEY_STATO = 'qualita_numeri_stato';
const KEY_TETTI = 'tetti_numeri';

const RANGO: Record<Qualita, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

export function soloNumero(n: string): string {
  return n.trim().replace(/^whatsapp:/i, '');
}

export function normalizzaQualita(v: unknown): Qualita {
  const s = String(v ?? '').toUpperCase();
  return s === 'HIGH' || s === 'MEDIUM' || s === 'LOW' ? s : 'UNKNOWN';
}

/** Giorno civile di Roma, YYYY-MM-DD. */
export function giornoRoma(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export function piuGiorni(giorno: string, n: number): string {
  const d = new Date(`${giorno}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** La lettura peggiore vince: UNKNOWN (API giu') non cancella un MEDIUM gia' visto. */
function peggiore(a: Qualita | undefined, b: Qualita): Qualita {
  if (!a || a === 'UNKNOWN') return b;
  if (b === 'UNKNOWN') return a;
  return RANGO[a] <= RANGO[b] ? a : b;
}

export type Azione =
  | { tipo: 'pausa'; numero: string; qualita: Qualita; fino: string; tettoPrima: number }
  | { tipo: 'pausa_negata_ultimo'; numero: string; qualita: Qualita }
  | { tipo: 'pausa_allungata'; numero: string; qualita: Qualita; fino: string }
  | { tipo: 'ripresa'; numero: string; tetto: number }
  | { tipo: 'rientro_primario'; numero: string; tetto: number }
  | { tipo: 'regime_primario'; numero: string; tetto: number }
  | { tipo: 'uscita_primario'; numero: string; qualita: Qualita }
  | { tipo: 'tetto_promosso'; numero: string; da: number; a: number; giorniHigh: number };

/**
 * Le decisioni di oggi. Puro: prende le letture, lo stato e i tetti; ritorna il
 * nuovo stato, i nuovi tetti e le azioni (per il log).
 */
export function decidi(args: {
  oggi: string;
  letture: Record<string, Qualita>;
  stato: StatoQualita;
  tetti: Record<string, number>;
  primario: string;
  secondari: string[];
}): { stato: StatoQualita; tetti: Record<string, number>; azioni: Azione[] } {
  const { oggi } = args;
  const primario = soloNumero(args.primario);
  const secondari = args.secondari.map(soloNumero);
  const stato: StatoQualita = {
    storico: structuredClone(args.stato.storico ?? {}),
    pause: structuredClone(args.stato.pause ?? {}),
    primario: args.stato.primario ? { ...args.stato.primario } : null,
    promozioni: structuredClone(args.stato.promozioni ?? {}),
  };
  // I tetti si scrivono con le chiavi come le trovo (con o senza `whatsapp:`).
  const tetti: Record<string, number> = { ...args.tetti };
  const chiaveDi = (n: string) =>
    Object.keys(tetti).find((k) => soloNumero(k) === n) ?? `whatsapp:${n}`;
  const tettoDi = (n: string) => {
    const v = tetti[chiaveDi(n)];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
  };
  const azioni: Azione[] = [];

  // 1. Storico: la lettura peggiore del giorno, e via i giorni vecchi.
  for (const [n, q] of Object.entries(args.letture)) {
    const num = soloNumero(n);
    const giorni = (stato.storico[num] ??= {});
    giorni[oggi] = peggiore(giorni[oggi], q);
    for (const g of Object.keys(giorni)) if (g < piuGiorni(oggi, -GIORNI_STORICO)) delete giorni[g];
  }
  const qOggi = (n: string): Qualita => args.letture[n] ?? args.letture[`whatsapp:${n}`] ?? 'UNKNOWN';

  // 2. Pause scadute: ripresa se HIGH, altrimenti si allunga.
  for (const [num, p] of Object.entries(stato.pause)) {
    if (oggi < p.fino) continue;
    const q = qOggi(num);
    if (q === 'HIGH') {
      tetti[chiaveDi(num)] = p.tettoPrima;
      delete stato.pause[num];
      azioni.push({ tipo: 'ripresa', numero: num, tetto: p.tettoPrima });
    } else {
      p.fino = piuGiorni(oggi, GIORNI_PAUSA);
      azioni.push({ tipo: 'pausa_allungata', numero: num, qualita: q, fino: p.fino });
    }
  }

  // 3. Secondari aperti sotto HIGH: pausa, ma mai l'ultimo aperto.
  for (const num of secondari) {
    if (stato.pause[num]) continue;
    const tetto = tettoDi(num);
    if (tetto <= 0) continue; // a riposo per mano di una persona: non e' affar nostro
    const q = qOggi(num);
    if (q !== 'MEDIUM' && q !== 'LOW') continue;
    const altriAperti = secondari.filter((s) => s !== num && !stato.pause[s] && tettoDi(s) > 0);
    if (altriAperti.length === 0) {
      azioni.push({ tipo: 'pausa_negata_ultimo', numero: num, qualita: q });
      continue;
    }
    const fino = piuGiorni(oggi, GIORNI_PAUSA);
    stato.pause[num] = { fino, tettoPrima: tetto, dal: oggi };
    tetti[chiaveDi(num)] = 0;
    azioni.push({ tipo: 'pausa', numero: num, qualita: q, fino, tettoPrima: tetto });
  }

  // 4. Il 3199: esce se scende; rientra a 15 dopo 4 giorni HIGH di fila e li' resta
  //    (PO 06/11/2026: nessun secondo gradino).
  const qP = qOggi(primario);
  const tettoP = tettoDi(primario);
  const giorniP = stato.storico[primario] ?? {};
  const tuttiHigh = (ultimo: string, n: number) => {
    for (let k = 0; k < n; k++) if (giorniP[piuGiorni(ultimo, -k)] !== 'HIGH') return false;
    return true;
  };
  // `primario.fase` ('trenta') non si scrive piu': quella rimasta da prima si azzera.
  stato.primario = null;
  if (tettoP > 0 && (qP === 'MEDIUM' || qP === 'LOW')) {
    delete tetti[chiaveDi(primario)];
    azioni.push({ tipo: 'uscita_primario', numero: primario, qualita: qP });
  } else if (tettoP === 0 && tuttiHigh(oggi, GIORNI_HIGH_PER_RIENTRO)) {
    tetti[chiaveDi(primario)] = TETTO_RIENTRO_PRIMARIO;
    azioni.push({ tipo: 'rientro_primario', numero: primario, tetto: TETTO_RIENTRO_PRIMARIO });
  }

  // 5. Promozioni una tantum (PO 07/11/2026), dopo pause e uscite di oggi.
  const promozioni = (stato.promozioni ??= {});
  for (const p of PROMOZIONI_TETTI) {
    const num = soloNumero(p.numero);
    if (promozioni[num]) continue; // gia' fatta: mai piu'
    if (stato.pause[num]) continue;
    const tetto = tettoDi(num);
    if (tetto <= 0 || tetto >= p.a) continue; // fermo, uscito, o gia' a quel tetto: non si tocca
    const giorni = stato.storico[num] ?? {};
    let tuttiHighN = true;
    for (let k = 0; k < p.giorniHigh; k++) if (giorni[piuGiorni(oggi, -k)] !== 'HIGH') { tuttiHighN = false; break; }
    if (!tuttiHighN) continue;
    tetti[chiaveDi(num)] = p.a;
    promozioni[num] = { giorno: oggi, da: tetto, a: p.a };
    azioni.push({ tipo: 'tetto_promosso', numero: num, da: tetto, a: p.a, giorniHigh: p.giorniHigh });
  }

  return { stato, tetti, azioni };
}

/** Qualita' Meta di ogni numero del bot, letta dalla Senders API dei suoi account. */
export async function leggiQualita(numeri: string[], fetcher: typeof fetch = fetch): Promise<Record<string, Qualita>> {
  const perAccount = new Map<string, { token: string; numeri: string[] }>();
  for (const n of numeri) {
    const c = credenzialiPerMittente(n);
    if (!c) continue;
    const a = perAccount.get(c.sid) ?? { token: c.token, numeri: [] };
    a.numeri.push(soloNumero(n));
    perAccount.set(c.sid, a);
  }
  const out: Record<string, Qualita> = {};
  for (const n of numeri) out[soloNumero(n)] = 'UNKNOWN';
  for (const [sid, a] of perAccount) {
    try {
      const r = await fetcher('https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50', {
        headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${a.token}`).toString('base64') },
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { senders?: { sender_id?: string; properties?: { quality_rating?: string } }[] };
      for (const s of j.senders ?? []) {
        const num = soloNumero(String(s.sender_id ?? ''));
        if (a.numeri.includes(num)) out[num] = normalizzaQualita(s.properties?.quality_rating);
      }
    } catch {
      // resta UNKNOWN: nessuna decisione si prende su una lettura mancata
    }
  }
  return out;
}

export async function eseguiControlloQualita(supabase: Supa, adesso: Date = new Date()) {
  const primario = numeroPrimario();
  if (!primario) return { ok: false as const, errore: 'primario non configurato' };
  const secondari = numeriSecondari();
  const auto = (process.env.QUALITA_NUMERI_AUTO ?? '').trim().toLowerCase() !== 'off';
  const oggi = giornoRoma(adesso);

  const letture = await leggiQualita([primario, ...secondari]);

  // Tetti: si rilegge la riga grezza (per riscriverla con le stesse chiavi) e si
  // verifica che sia leggibile; se no, nessuna decisione.
  const tettiParsed = await getTettiNumeri(supabase);
  const { data: rigaTetti, error: errTetti } = await supabase.from('app_settings').select('value').eq('key', KEY_TETTI).maybeSingle();
  if (tettiParsed === null || errTetti) return { ok: false as const, errore: 'tetti illeggibili', letture };
  const tetti = { ...((rigaTetti as { value?: Record<string, number> } | null)?.value ?? {}) };

  const { data: rigaStato } = await supabase.from('app_settings').select('value').eq('key', KEY_STATO).maybeSingle();
  const statoPrima = ((rigaStato as { value?: StatoQualita } | null)?.value ?? { storico: {}, pause: {} }) as StatoQualita;

  const r = decidi({ oggi, letture, stato: statoPrima, tetti, primario, secondari });

  // In modalita' "off" lo storico si aggiorna (serve per il conto dei 7 giorni), le
  // pause e i tetti no.
  const statoDaScrivere: StatoQualita = auto
    ? r.stato
    : { storico: r.stato.storico, pause: statoPrima.pause ?? {}, primario: statoPrima.primario ?? null, promozioni: statoPrima.promozioni ?? {} };
  await supabase.from('app_settings').upsert({ key: KEY_STATO, value: statoDaScrivere as never, updated_at: adesso.toISOString() });
  const cambiaTetti = auto && JSON.stringify(r.tetti) !== JSON.stringify(tetti);
  if (cambiaTetti) {
    await supabase.from('app_settings').update({ value: r.tetti as never, updated_at: adesso.toISOString() }).eq('key', KEY_TETTI);
  }

  await supabase.from('event_log').insert({
    type: 'qualita_numeri_lettura', level: 'info',
    payload: { oggi, letture, auto, tettiPrima: tetti, tettiDopo: cambiaTetti ? r.tetti : tetti } as never,
    message: `[qualita-numeri] ${Object.entries(letture).map(([n, q]) => `${n.slice(-4)}=${q}`).join(' ')}`,
  });
  for (const a of r.azioni) {
    if (a.tipo === 'tetto_promosso' && auto) {
      // Evento a parte, col totale da riportare a mano nel CRM (BOT_TETTO_GIORNALIERO).
      const totaleSuggerito = sommaTetti(r.tetti);
      await supabase.from('event_log').insert({
        type: 'tetto_promosso', level: 'info',
        payload: {
          ...a, totalePrima: sommaTetti(tetti), totaleSuggerito, tettiDopo: r.tetti,
          azione_crm: `BOT_TETTO_GIORNALIERO = ${totaleSuggerito}`,
        } as never,
        message: `[qualita-numeri] tetto ${a.numero} da ${a.da} a ${a.a} (HIGH da ${a.giorniHigh} giorni di fila): alzare BOT_TETTO_GIORNALIERO nel CRM a ${totaleSuggerito}`,
      });
      continue;
    }
    await supabase.from('event_log').insert({
      type: `qualita_numeri_${a.tipo}`,
      level: a.tipo === 'pausa' || a.tipo === 'pausa_negata_ultimo' || a.tipo === 'uscita_primario' || a.tipo === 'pausa_allungata' ? 'warn' : 'info',
      payload: { ...a, auto } as never,
      message: `[qualita-numeri] ${a.tipo} ${a.numero}${auto ? '' : ' (solo simulato: QUALITA_NUMERI_AUTO=off)'}`,
    });
  }
  return { ok: true as const, oggi, auto, letture, azioni: r.azioni, tetti: cambiaTetti ? r.tetti : tetti };
}
