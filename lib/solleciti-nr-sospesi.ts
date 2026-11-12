/**
 * Solleciti dopo i "non risponde" delle Conferme SOSPESI su un numero (PO 12/11/2026).
 *
 * Il caso: il 3199 e' LOW l'11 e il 12/11, e da li' partono i messaggi che il bot manda
 * quando le Conferme chiamano e il lead non risponde (`/api/bot/call-attempt`: i template
 * NR1 "ti abbiamo appena chiamato per la call di…" e NR3 "abbiamo provato a chiamarti tre
 * volte…", o il messaggio libero se la finestra 24h e' aperta). Decisione di Bruno: su
 * quel numero si sospendono, e si riaccendono da soli quando torna HIGH per 7 giorni di
 * fila. Il sollecito NON si sposta su un altro numero: non parte, e resta un evento
 * `recupero_nr_sospeso` per contarli.
 *
 * Solo questi solleciti: agende dei GDO, promemoria della videochiamata, video e risposte
 * in chat non passano di qui e restano come sono.
 *
 * Impostazione: `app_settings.solleciti_nr_sospesi` = mappa numero → sospensione, per es.
 *   {"+393520413199": {"dal": "2026-11-12", "giorni_high": 7}}
 * (il numero con o senza `whatsapp:`). Riga assente, vuota o illeggibile = nessuna
 * sospensione (si manda come prima). A mano: aggiungere la voce per sospendere, toglierla
 * (o `{}`) per riaccendere subito.
 *
 * Riaccensione automatica (`aggiornaSospensioniSollecitiNr`, chiamata dal cron
 * qualita-numeri dopo l'aggiornamento dello storico): la voce si toglie quando lo storico
 * di quel numero (`app_settings.qualita_numeri_stato`, lettura PEGGIORE del giorno) mostra
 * HIGH per `giorni_high` giorni di calendario CHIUSI consecutivi (da ieri all'indietro),
 * tutti successivi al giorno `dal`, e oggi non e' gia' stato letto sotto HIGH. Un giorno
 * senza lettura o UNKNOWN non vale HIGH: la fila riparte. Evento `solleciti_nr_riaccesi`.
 *
 * `parseSospensioni`, `numeroSospeso` e `daRiaccendere` sono puri (solleciti-nr-sospesi.test.ts).
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { giornoRoma, piuGiorni, soloNumero } from './qualita-numeri';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export const KEY_SOLLECITI_NR_SOSPESI = 'solleciti_nr_sospesi';
export const GIORNI_HIGH_PER_RIACCENDERE = 7;
/** Evento scritto a ogni sollecito non partito per la sospensione. */
export const EVENTO_SOLLECITO_NR_SOSPESO = 'recupero_nr_sospeso';
/** Evento scritto quando una sospensione si toglie da sola. */
export const EVENTO_SOLLECITI_NR_RIACCESI = 'solleciti_nr_riaccesi';

export type Sospensione = {
  /** Giorno di Roma (YYYY-MM-DD) in cui e' stata messa; null = non scritto. */
  dal: string | null;
  /** Giorni HIGH di fila che la tolgono. */
  giorniHigh: number;
};

/** numero (senza `whatsapp:`) → sospensione */
export type Sospensioni = Record<string, Sospensione>;

const GIORNO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Legge la mappa tollerando le forme scritte a mano: `true` o `{}` come valore di un
 * numero valgono "sospeso da sempre, 7 giorni"; `false`/`null` = non sospeso.
 */
export function parseSospensioni(raw: unknown): Sospensioni {
  const out: Sospensioni = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const num = soloNumero(k);
    if (!num || v === false || v === null || v === undefined) continue;
    const o = (typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    const dal = typeof o.dal === 'string' && GIORNO.test(o.dal) ? o.dal : null;
    const g = Number(o.giorni_high ?? o.giorniHigh);
    out[num] = { dal, giorniHigh: Number.isInteger(g) && g > 0 ? g : GIORNI_HIGH_PER_RIACCENDERE };
  }
  return out;
}

export function numeroSospeso(sospensioni: Sospensioni, numero: string | null | undefined): Sospensione | null {
  const num = soloNumero(numero ?? '');
  return num ? sospensioni[num] ?? null : null;
}

/** Le sospensioni in corso. Lettura fallita = nessuna: i solleciti partono come prima. */
export async function leggiSospensioniSollecitiNr(supabase: Supa): Promise<Sospensioni> {
  try {
    const { data, error } = await supabase
      .from('app_settings').select('value').eq('key', KEY_SOLLECITI_NR_SOSPESI).maybeSingle();
    if (error) return {};
    return parseSospensioni((data as { value?: unknown } | null)?.value);
  } catch {
    return {};
  }
}

/**
 * I numeri la cui sospensione va tolta oggi. Puro.
 *
 * Conta i giorni CHIUSI (da ieri all'indietro): lo storico tiene la lettura peggiore del
 * giorno, e quella di oggi puo' ancora scendere fino all'ultimo giro del cron.
 */
export function daRiaccendere(args: {
  sospensioni: Sospensioni;
  storico: Record<string, Record<string, string>>;
  oggi: string;
}): string[] {
  const fuori: string[] = [];
  for (const [num, s] of Object.entries(args.sospensioni)) {
    const giorni = args.storico[num] ?? {};
    const qOggi = giorni[args.oggi];
    if (qOggi === 'MEDIUM' || qOggi === 'LOW') continue;
    let tutti = true;
    for (let k = 1; k <= s.giorniHigh; k++) {
      const g = piuGiorni(args.oggi, -k);
      if (giorni[g] !== 'HIGH' || (s.dal !== null && g <= s.dal)) { tutti = false; break; }
    }
    if (tutti) fuori.push(num);
  }
  return fuori;
}

/**
 * Toglie le sospensioni arrivate ai giorni HIGH richiesti. La chiama il cron
 * qualita-numeri dopo aver scritto lo storico di oggi. Non lancia mai: un errore qui non
 * deve far fallire il controllo della qualita'.
 */
export async function aggiornaSospensioniSollecitiNr(
  supabase: Supa, adesso: Date = new Date(),
): Promise<{ riaccesi: string[] }> {
  try {
    const { data: riga, error } = await supabase
      .from('app_settings').select('value').eq('key', KEY_SOLLECITI_NR_SOSPESI).maybeSingle();
    if (error) return { riaccesi: [] };
    const grezzo = (riga as { value?: unknown } | null)?.value;
    const sospensioni = parseSospensioni(grezzo);
    if (Object.keys(sospensioni).length === 0) return { riaccesi: [] };

    const { data: rigaStato, error: erroreStato } = await supabase
      .from('app_settings').select('value').eq('key', 'qualita_numeri_stato').maybeSingle();
    if (erroreStato) return { riaccesi: [] };
    const storico = ((rigaStato as { value?: { storico?: Record<string, Record<string, string>> } } | null)?.value?.storico) ?? {};

    const oggi = giornoRoma(adesso);
    const riaccesi = daRiaccendere({ sospensioni, storico, oggi });
    if (riaccesi.length === 0) return { riaccesi: [] };

    // Si riscrive la riga com'era, senza le voci tolte (le chiavi restano come scritte).
    const nuovo: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((grezzo ?? {}) as Record<string, unknown>)) {
      if (!riaccesi.includes(soloNumero(k))) nuovo[k] = v;
    }
    const { error: erroreScrittura } = await supabase
      .from('app_settings')
      .update({ value: nuovo as never, updated_at: adesso.toISOString() })
      .eq('key', KEY_SOLLECITI_NR_SOSPESI);
    if (erroreScrittura) return { riaccesi: [] };

    for (const num of riaccesi) {
      const s = sospensioni[num];
      await supabase.from('event_log').insert({
        type: EVENTO_SOLLECITI_NR_RIACCESI, level: 'info',
        payload: { numero: num, dal: s.dal, giorniHigh: s.giorniHigh, oggi } as never,
        message: `[solleciti-nr] ${num}: HIGH da ${s.giorniHigh} giorni di fila, i solleciti dopo i "non risponde" delle Conferme ripartono`,
      });
    }
    return { riaccesi };
  } catch {
    return { riaccesi: [] };
  }
}
