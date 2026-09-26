/**
 * Barra di regia: scaletta della serata, luce "in onda" e consegne ora per ora.
 * Modulo PURO: niente env, niente DB. Le ore sono sempre quelle di Roma, anche a cavallo
 * del cambio d'ora.
 */

export type VoceScaletta = { voce: 'link' | 'inizio' | 'pitch' | 'chiusura'; etichetta: string; at: string };

const MIN = 60_000;
/** Minuti dall'inizio del webinar: link 5 min prima, pitch a +40, chiusura a +70. */
const OFFSET: [VoceScaletta['voce'], string, number][] = [
  ['link', 'Link', -5],
  ['inizio', 'Inizio', 0],
  ['pitch', 'Pitch', 40],
  ['chiusura', 'Chiusura', 70],
];
const FINE_MIN = 70;

const valida = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : null);

/** Le voci della serata a partire da `lancio_evento_at`; [] se manca o non è una data. */
export function scalettaDa(eventoAt: string | null): VoceScaletta[] {
  const t = valida(eventoAt);
  if (t === null) return [];
  return OFFSET.map(([voce, etichetta, m]) => ({ voce, etichetta, at: new Date(t + m * MIN).toISOString() }));
}

export type StatoOnda = { stato: 'nessuno' | 'prima' | 'in_onda' | 'dopo'; secondi: number };

/** `prima` = secondi che mancano; `in_onda` = secondi trascorsi dall'inizio (fino alla chiusura);
 *  `dopo` = secondi oltre la chiusura. */
export function statoOnda(now: Date, eventoAt: string | null): StatoOnda {
  const t = valida(eventoAt);
  if (t === null) return { stato: 'nessuno', secondi: 0 };
  const n = now.getTime();
  if (n < t) return { stato: 'prima', secondi: Math.round((t - n) / 1000) };
  if (n <= t + FINE_MIN * MIN) return { stato: 'in_onda', secondi: Math.round((n - t) / 1000) };
  return { stato: 'dopo', secondi: Math.round((n - t - FINE_MIN * MIN) / 1000) };
}

const FMT_ORA = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' });
const FMT_GIORNO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Ora (0-23) di `d` a Roma. */
export function oraRoma(d: Date): number {
  return Number(FMT_ORA.format(d));
}

/** Mezzanotte di Roma del giorno di `now`, come istante UTC. */
export function inizioGiornoRoma(now: Date): Date {
  const giorno = FMT_GIORNO.format(now);
  for (const off of ['+02:00', '+01:00']) {
    const d = new Date(`${giorno}T00:00:00${off}`);
    if (oraRoma(d) === 0) return d;
  }
  return new Date(`${giorno}T00:00:00+01:00`);
}

export type ConsegneOra = { ora: number; inviati: number; consegnati: number; falliti: number };

const CONSEGNATO = new Set(['delivered', 'read']);
const FALLITO = new Set(['failed', 'undelivered']);

/** 24 voci (0-23, ora di Roma) con inviati, consegnati (delivered/read) e falliti (failed/undelivered). */
export function consegnePerOra(msg: { created_at: string; twilio_status: string | null }[]): ConsegneOra[] {
  const out = Array.from({ length: 24 }, (_, ora) => ({ ora, inviati: 0, consegnati: 0, falliti: 0 }));
  for (const m of msg) {
    const t = Date.parse(m.created_at);
    if (Number.isNaN(t)) continue;
    const o = out[oraRoma(new Date(t))];
    o.inviati++;
    if (CONSEGNATO.has(m.twilio_status ?? '')) o.consegnati++;
    else if (FALLITO.has(m.twilio_status ?? '')) o.falliti++;
  }
  return out;
}

export type Regia = {
  attivo: boolean;
  /** `lancio_evento_at` così com'è nelle impostazioni (null = non impostato). */
  eventoAt: string | null;
  stato: StatoOnda;
  scaletta: VoceScaletta[];
  numeri: { iscritti: number; postoBloccato: number; linkInviati: number; consegnatiOggi: number; fallitiOggi: number };
  perFase: Record<string, number>;
  perOra: ConsegneOra[];
  generatoAt: string;
};
