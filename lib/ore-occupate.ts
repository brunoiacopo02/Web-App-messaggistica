// Ore già piene: quando Mario propone lui un orario, sceglie fra le meno piene
// (PO 09/11/2026).
//
// Martedì 10/11 alle 10:00 c'erano 19 appuntamenti su 89, il doppio di qualunque
// altra ora (10 fissati dal bot, 9 dai GDO). Dalle chat: Mario proponeva «dalle 10 in
// poi», «le 10 o le 11?», «ho posto dalle 10 alle 21», e il lead prendeva la prima ora
// che sentiva. Dal 27/10 al 09/11 le ore più piene sono proprio le prime delle fasce che
// il prompt nomina: 10:00 (117) e 15:00 (130, «dal pomeriggio in poi»).
//
// I numeri vengono dal CRM (POST /api/bot/ore-occupate, firma BOT_WEBHOOK_SECRET):
// contano tutti gli appuntamenti vivi, di bot e GDO. Anche la soglia "ora affollata"
// è del CRM (appSettings `ora_affollata_soglia`), così bot e avviso ai GDO usano la
// stessa. Se il CRM non risponde il blocco non c'è e Mario fa come prima.
import { signPayload } from './bot-hmac';
import type { BookingDay } from './booking-slots';

/** Conteggio per ora di Roma ("9"…"21" → numero di call). */
export type ContaOre = Record<string, number>;
export type OreOccupate = { soglia: number; giorni: Record<string, ContaOre> };

const DEFAULT_URL = 'https://crm-sales-fenice.vercel.app/api/bot/ore-occupate';
/** La risposta del bot non deve aspettare il CRM: oltre, si va senza il blocco. */
const TIMEOUT_MS = 2500;
/** Cache per istanza: un drain dopo l'altro non richiede gli stessi numeri. Il CRM ha la sua di 60 s. */
const CACHE_MS = 120_000;

const GIORNO = /^\d{4}-\d{2}-\d{2}$/;

/** Valida la risposta del CRM; null se ha una forma che non conosciamo. */
export function parseOreOccupate(json: unknown): OreOccupate | null {
  if (!json || typeof json !== 'object') return null;
  const raw = json as { soglia?: unknown; giorni?: unknown };
  if (typeof raw.soglia !== 'number' || !Number.isFinite(raw.soglia) || raw.soglia < 1) return null;
  if (!raw.giorni || typeof raw.giorni !== 'object') return null;
  const giorni: Record<string, ContaOre> = {};
  for (const [g, conta] of Object.entries(raw.giorni as Record<string, unknown>)) {
    if (!GIORNO.test(g) || !conta || typeof conta !== 'object') return null;
    const c: ContaOre = {};
    for (const [h, n] of Object.entries(conta as Record<string, unknown>)) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      c[String(Number(h))] = n;
    }
    giorni[g] = c;
  }
  return { soglia: raw.soglia, giorni };
}

const cache = new Map<string, { at: number; dati: OreOccupate }>();

/** Solo per i test. */
export function svuotaCacheOreOccupate(): void {
  cache.clear();
}

/**
 * Le ore occupate dei `giorni` (al massimo 3), dal CRM. null se manca il segreto, se
 * il CRM non risponde in tempo o risponde male: il blocco è un aiuto, non una condizione
 * per rispondere al lead.
 */
export async function leggiOreOccupate(
  giorni: readonly string[],
  opts?: { fetchImpl?: typeof fetch; now?: number },
): Promise<OreOccupate | null> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  const lista = [...new Set(giorni)].filter((g) => GIORNO.test(g)).sort();
  if (!secret || lista.length === 0 || lista.length > 3) return null;
  const chiave = lista.join(',');
  const adesso = opts?.now ?? Date.now();
  const inCache = cache.get(chiave);
  if (inCache && adesso - inCache.at < CACHE_MS) return inCache.dati;

  const rawBody = JSON.stringify({ giorni: lista });
  try {
    const res = await (opts?.fetchImpl ?? fetch)(process.env.CRM_ORE_OCCUPATE_URL || DEFAULT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const dati = parseOreOccupate(await res.json().catch(() => null));
    if (dati) cache.set(chiave, { at: adesso, dati });
    return dati;
  } catch {
    return null;
  }
}

/** Le tre fasce che il lead può indicare. Le 9 non ci sono: il bot non le propone mai. */
export const FASCE: readonly { nome: string; ore: readonly number[] }[] = [
  { nome: 'la mattina', ore: [10, 11, 12, 13] },
  { nome: 'il pomeriggio', ore: [14, 15, 16, 17] },
  { nome: 'la sera', ore: [18, 19, 20, 21] },
];

const n = (conta: ContaOre, h: number) => conta[String(h)] ?? 0;

/** Ore dalle 10 alle 21 con almeno `soglia` call. */
export function oreAffollate(conta: ContaOre, soglia: number): number[] {
  return FASCE.flatMap((f) => f.ore).filter((h) => n(conta, h) >= soglia);
}

/**
 * Le due ore da proporre in una fascia: le meno piene. A parità vince l'ora più vicina
 * al centro della fascia, così con l'agenda vuota non si torna sulla prima (le 10, le 14,
 * le 18). Se la fascia è tutta affollata restano le due meno piene: il lead che può solo
 * la mattina la mattina deve poterla fare.
 */
export function oreDaProporre(conta: ContaOre, ore: readonly number[]): number[] {
  const centro = (ore[0] + ore[ore.length - 1]) / 2;
  return [...ore]
    .sort((a, b) => n(conta, a) - n(conta, b) || Math.abs(a - centro) - Math.abs(b - centro) || a - b)
    .slice(0, 2)
    .sort((a, b) => a - b);
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** La riga di un giorno: due ore per fascia, poi le ore già piene. */
export function rigaGiorno(day: BookingDay, conta: ContaOre, soglia: number): string {
  const fasce = FASCE.map((f) => {
    const [a, b] = oreDaProporre(conta, f.ore);
    return `${f.nome} ${hh(a)} o ${hh(b)}`;
  }).join(', ');
  const piene = oreAffollate(conta, soglia);
  return `- ${day.label}: ${fasce}.${piene.length > 0 ? ` Già piene: ${piene.map(hh).join(', ')}.` : ''}`;
}

/**
 * Il blocco del prompt, o null se dal CRM non è arrivato nessuno dei due giorni.
 * Cambia solo COME Mario propone l'ora: giorni, fasce, le 9, le ore piene del form e
 * l'ora scelta dal lead restano com'erano.
 */
export function bloccoOreDistribuite(days: readonly BookingDay[], dati: OreOccupate | null | undefined): string | null {
  if (!dati) return null;
  const righe = days.filter((d) => dati.giorni[d.date]).map((d) => rigaGiorno(d, dati.giorni[d.date], dati.soglia));
  if (righe.length === 0) return null;
  return [
    'ORE DA PROPORRE (per non ammassare le call nella stessa ora: contano tutte le call già fissate, anche quelle dei colleghi):',
    ...righe,
    'QUANDO SEI TU A PROPORRE L\'ORA: proponi due ore precise fra queste, nella fascia che ti ha indicato il lead (la mattina, il pomeriggio o la sera; "dopo il lavoro" di solito è la sera). Se non ti ha indicato niente, un\'ora della mattina e una del pomeriggio o della sera. Non dire "dalle 10", "dalle 10 in poi", "dal pomeriggio in poi" né "dalle 10 alle 21": il lead prende la prima ora che sente e così si riempie sempre la stessa. Le ore già piene non le proponi tu.',
    'SE È IL LEAD A DIRTI UN\'ORA, o a dirti che può solo a quell\'ora, va bene quella anche se è fra le già piene: confermala com\'è, senza dirgli che è piena e senza provare a spostarla.',
  ].join('\n');
}
