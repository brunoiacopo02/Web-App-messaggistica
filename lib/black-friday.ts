import type { getSupabaseAdmin } from './supabase/admin';
import { liberaDaLancioEAgenda } from './professioni-nota';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Funnel Black Friday (PO 28/10 e 06/11/2026). Le email del marketing portano dal 9/11 a
 * un link wa.me sul 3199 con la frase "Ciao, sono interessato a saperne di più
 * sull'offerta Black Friday": il lead scrive per primo, Mario gli racconta l'offerta, fissa
 * la call col consulente e dopo l'appuntamento manda la VSL dell'offerta
 * (`app_settings.offerta_del_mese_link`, lo stesso URL della pagina dell'offerta del mese).
 * Sul CRM il lead nasce nel funnel "BLACK FRIDAY". Modello: il funnel Professioni
 * (lib/professioni.ts + lib/professioni-nota.ts).
 *
 * Nessuna colonna nuova: la chat e' del funnel se e' stata adottata con quella
 * provenienza (`crm_funnel`) oppure se nella cronologia c'e' un messaggio del lead con la
 * frase del link (chat gia' aperta di un altro funnel, che vince come per Professioni).
 *
 * I fatti dell'offerta sono SOLO quelli dati dal PO il 06/11/2026: prezzo, garanzia nel
 * contratto, corso IA in regalo, regalo dell'Exclusive senza dire cos'e'. Scadenza e
 * numero dei posti vivono in `app_settings` (`black_friday_scadenza`, `black_friday_posti`)
 * e si cambiano senza deploy: chiave assente = il bot non ne parla.
 */
export const PROVENIENZA_BLACK_FRIDAY = 'BLACK FRIDAY' as const;

/** Testo precompilato del link wa.me consegnato al marketing il 28/10/2026. */
export const TESTO_LINK_BLACK_FRIDAY = "Ciao, sono interessato a saperne di più sull'offerta Black Friday";

/**
 * Marker sulle due parole che la persona non tocca, non sull'intera frase: chi la accorcia,
 * la riscrive, scrive "black-friday", "blackfriday" o "BLACK FRIDAY" resta riconosciuto.
 */
const MARKER = /\bbla(?:c)?k\s*-?\s*fr[iy]day\b/i;

export function isMarkerBlackFriday(t: string | null | undefined): boolean {
  return MARKER.test(t ?? '');
}

export const SETTING_SCADENZA = 'black_friday_scadenza' as const;
export const SETTING_POSTI = 'black_friday_posti' as const;

/** 9/11/2026 00:00 ora di Roma (CET, UTC+1): da qui arrivano le email. */
export const INIZIO_BLACK_FRIDAY_MS = Date.parse('2026-11-09T00:00:00+01:00');
/** Fine di riserva se la scadenza in app_settings manca: fine del 30/11/2026, ora di Roma. */
export const FINE_BLACK_FRIDAY_DEFAULT_MS = Date.parse('2026-11-30T23:59:59+01:00');

export type ScadenzaBlackFriday = { atMs: number; etichetta: string };

/** "lunedì 30 novembre" in ora di Roma. */
function etichettaGiorno(ms: number): string {
  return new Date(ms).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Rome' });
}

/**
 * La scadenza scritta in `app_settings`: ISO con fuso ("2026-11-30T23:59:59+01:00") o solo
 * la data ("2026-11-30" = fine giornata a Roma; novembre e' sempre CET). Illeggibile o
 * assente = null: il bot non cita nessuna scadenza.
 */
export function parseScadenza(raw: unknown): ScadenzaBlackFriday | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim();
  const soloData = /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!soloData && !/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) return null;
  const ms = Date.parse(soloData ? `${v}T23:59:59+01:00` : v);
  if (Number.isNaN(ms)) return null;
  return { atMs: ms, etichetta: etichettaGiorno(ms) };
}

/** Il numero dei posti: intero positivo, altrimenti null (il bot non parla di posti). */
export function parsePosti(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim() || NaN) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export type SettingsBlackFriday = { scadenza: ScadenzaBlackFriday | null; posti: number | null };

export async function leggiSettingsBlackFriday(supabase: Supa): Promise<SettingsBlackFriday> {
  const { data } = await supabase.from('app_settings').select('key, value').in('key', [SETTING_SCADENZA, SETTING_POSTI]);
  const byKey = new Map(((data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
  return { scadenza: parseScadenza(byKey.get(SETTING_SCADENZA)), posti: parsePosti(byKey.get(SETTING_POSTI)) };
}

/**
 * Il funnel e' acceso? Env `BLACK_FRIDAY_FUNNEL`:
 * - `0`/`false`/`off`: spento (interruttore d'emergenza: chi scrive la frase e' un inbound normale);
 * - `1`/`true`/`on`: acceso a prescindere dalle date (per le prove);
 * - assente o altro: acceso dal 9/11/2026 00:00 Roma alla scadenza di `app_settings`
 *   (o, se manca, alla fine del 30/11/2026). Nessuno deve ricordarsi di accenderlo il lunedi'
 *   mattina, e dopo la fine si spegne da solo.
 */
export function funnelBlackFridayAttivo(i: {
  env?: string | null;
  nowMs: number;
  scadenzaAtMs?: number | null;
}): boolean {
  const v = (i.env ?? '').trim().toLowerCase();
  if (['0', 'false', 'off'].includes(v)) return false;
  if (['1', 'true', 'on'].includes(v)) return true;
  const fine = i.scadenzaAtMs ?? FINE_BLACK_FRIDAY_DEFAULT_MS;
  return i.nowMs >= INIZIO_BLACK_FRIDAY_MS && i.nowMs <= fine;
}

/**
 * Per la classificazione all'adozione (webhook e cron): il funnel vale ADESSO per questi
 * testi? Senza la frase non si legge niente dal DB (il caso normale non paga la query).
 */
export async function blackFridayAttivoPer(supabase: Supa, testi: readonly (string | null | undefined)[], nowMs = Date.now()): Promise<boolean> {
  if (!testi.some((t) => isMarkerBlackFriday(t))) return false;
  const { scadenza } = await leggiSettingsBlackFriday(supabase);
  return funnelBlackFridayAttivo({ env: process.env.BLACK_FRIDAY_FUNNEL, nowMs, scadenzaAtMs: scadenza?.atMs ?? null });
}

/**
 * La chat e' del funnel Black Friday in questo turno? Si' quando il funnel e' acceso, la
 * chat e' entrata come BLACK FRIDAY o il lead ha scritto la frase, E nessun lancio in corso
 * ne' call GDO ancora da fare la tengono (stesse regole di `professioniVince`). Vince anche
 * su Professioni: la frase del Black Friday e' la richiesta piu' recente.
 */
export function blackFridayVince(i: {
  attivo: boolean;
  crmFunnel: string | null;
  testiInbound: readonly (string | null)[];
  lancioSlug: string | null | undefined;
  lancioFase: string | null | undefined;
  gdoAgendaAt: string | null;
  botScheduledAt: string | null;
  gdoAppuntamentoAt: string | null;
  now: number;
}): boolean {
  if (!i.attivo) return false;
  const delFunnel = (i.crmFunnel ?? '').trim().toUpperCase() === PROVENIENZA_BLACK_FRIDAY
    || i.testiInbound.some((t) => isMarkerBlackFriday(t));
  if (!delFunnel) return false;
  return liberaDaLancioEAgenda(i);
}

/**
 * Nota di contesto del funnel (parte variabile del prompt: manuale e cache intatti).
 * Mai il nome dell'oggetto regalato con l'Exclusive: il modello non lo sa, cosi' non lo
 * puo' dire.
 */
export function blackFridayContextNote(i: {
  vslLink: string | null;
  scadenza: ScadenzaBlackFriday | null;
  posti: number | null;
  nowMs: number;
}): string {
  const scadenza = i.scadenza && i.scadenza.atMs > i.nowMs ? i.scadenza : null;
  const vsl = i.vslLink?.trim() || null;
  const righe = [
    "CONTESTO FUNNEL BLACK FRIDAY: questo lead ci ha scritto per primo dal link dell'email del Black Friday e vuole sapere com'e' l'offerta.",
    "I FATTI DELL'OFFERTA sono SOLO questi. Non aggiungerne altri, non inventare condizioni, eccezioni, numeri o date:",
    "- PREZZO: con il Black Friday i percorsi, che normalmente costano dai 2.000 ai 4.000 euro, costano dai 1.000 ai 3.000 euro a seconda del percorso, e si possono rateizzare. Mai cifre di rata ne' numero di rate, mai percentuali di sconto, mai il prezzo di un singolo percorso: quello lo vede col consulente in call.",
    "- GARANZIA \"COLLOCATO O RIMBORSATO\": e' scritta nero su bianco nel contratto: se non trova lavoro grazie al nostro corso, lo rimborsiamo. Se ti chiede condizioni, tempi, requisiti o dettagli, resta sul generico: le condizioni precise gliele spiega il consulente in call. Non inventare durate, requisiti o percentuali.",
    "- REGALO PER TUTTI GLI ISCRITTI: un corso sull'intelligenza artificiale che insegna a usare l'IA nella professione che sceglie, per dominare il mercato.",
    "- PERCORSO EXCLUSIVE: chi lo sceglie riceve un regalo in piu', e se ne parla in call. Al massimo puoi dire che e' un regalo tech, fisico, che gli arriva direttamente a casa. Non dire mai che oggetto e', non descriverlo e non dare indizi; se prova a indovinare non confermare e non smentire: \"e' una sorpresa, te la svela il consulente in call\".",
    "- PERCHE' ADESSO: questo e' il momento migliore per formarsi, perche' il primo trimestre del 2027 e' decisivo per le assunzioni: con la ripartenza di inizio anno le aziende assumono di piu', e chi si forma adesso arriva pronto. Puoi usarlo come leva per non rimandare. Non aggiungere numeri, percentuali, nomi di aziende o studi a sostegno.",
  ];
  if (i.posti) {
    righe.push(`- POSTI: i posti con le condizioni del Black Friday sono solo ${i.posti}, perche' vogliamo essere sicuri di poter garantire il lavoro a tutti quelli che entrano. Puoi dirlo, sempre con questa motivazione. Non dire mai quanti posti sono rimasti o quanti sono gia' stati presi: non lo sai.`);
  }
  if (scadenza) {
    righe.push(`- SCADENZA: l'offerta vale fino a ${scadenza.etichetta} compreso. Non citare altre date di fine.`);
  } else {
    righe.push("- SCADENZA: non ne abbiamo una da dire. Non citare date di fine offerta e non dire che scade a breve.");
  }
  if (i.posti || scadenza) {
    righe.push(`URGENZA VERA: per questo lead ${[i.posti ? 'i posti limitati' : null, scadenza ? 'la scadenza' : null].filter(Boolean).join(' e ')} sono fatti veri e li puoi usare come leva per fissare la call adesso e non fra qualche settimana, in deroga alla regola generale su fretta e scarsita'. Restano vietati il senso di colpa e qualunque fatto che non sia scritto qui.`);
  }
  righe.push(
    "QUANDO TI CHIEDE DELL'OFFERTA (di solito nel suo primo messaggio, con la frase del link): rispondi subito a quello che ha chiesto, senza aspettare il pitch. In poche righe gli dici che il Black Friday e' attivo e cosa comprende (prezzo ridotto, garanzia scritta nel contratto, corso IA in regalo), poi UNA domanda sulla sua situazione per capire quale percorso fa per lui (es. \"Per capire quale percorso fa per te: oggi lavori o stai cercando?\"). Il regalo dell'Exclusive lo nomini solo piu' avanti o se ti chiede dei regali.",
    "FLUSSO: dopo aver risposto sull'offerta fai la qualifica COMPLETA come con tutti gli altri lead (stesse domande del manuale, non saltarne), poi proponi la videocall col consulente. Presentala come il momento in cui scegliete il percorso, vedete le condizioni della garanzia e fa l'iscrizione per bloccare il posto con il prezzo del Black Friday. Mai \"se ti convince\", \"se ti interessa\", \"eventualmente\": la chiusura si da' per scontata. Per giorni, orari, Noemi, form e tag segui il manuale come sempre.",
  );
  if (vsl) {
    righe.push(
      `VIDEO: il video da mandare dopo che ha fissato e' UNO SOLO, quello dell'offerta Black Friday: ${vsl}`,
      "Usa questo link al posto dei quattro link conferenza-* del blocco sul video, in ogni punto in cui manderesti il video, e non chiedere se lavora o ha famiglia per sceglierlo. Non dire quanto dura. Invito e link sulla stessa riga: \"*Prima della videochiamata guarda questo video* 👉 <link>\", poi: \"Dentro c'e' l'offerta del Black Friday spiegata per bene, cosi' in call partiamo dal tuo caso. Quando riesci a vederlo, stasera o domani?\"",
      "ORDINE: prima fissate la call, POI il video, come nel flusso standard. Se te lo chiede prima, digli che glielo mandi appena fissate la call e porta il discorso su giorno e ora.",
    );
  }
  return righe.join('\n');
}
