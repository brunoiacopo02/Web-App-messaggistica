import { formatRomeDateTime } from './rome-time';
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

/** Il pezzo fisso dell'URL della VSL dell'offerta (`offerta_del_mese_link`): riconosce il
 *  video gia' uscito in chat nei promemoria e nella conferma dello spostamento. */
export const VSL_OFFERTA_PATH = 'lp.feniceacademy.it/vsl-offerta' as const;

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

/**
 * Apertura Black Friday (PO 07/11/2026): template proprio, `fenice_apertura_black_friday_v1`,
 * creato su tutti e tre gli account (scripts/crea-template-apertura-black-friday.ts). Il SID
 * dell'account principale sta in `BF_OPENING_TEMPLATE_SID`; gli altri account lo ritrovano
 * per nome. Testo: solo la richiesta del lead, nessuna cifra, nessun posto, nessun regalo,
 * e nessun "e' attiva" (vale anche prima del 9/11). {{1}} = nome proprio.
 */
export const NOME_TEMPLATE_APERTURA_BF = 'fenice_apertura_black_friday_v1';
/** Pezzo fisso del testo: riconosce in cronologia un'apertura BF gia' partita. */
export const MARKER_TESTO_APERTURA_BF = "richiesta di informazioni sull'offerta Black Friday";
export function aperturaBlackFridayText(nome: string): string {
  // Nessun nome di persona: arriva anche su chat aperte da Marta (Cristina, conv 26723).
  return `Ciao ${nome}, ti scrivo da Fenice Academy per la tua richiesta di informazioni sull'offerta Black Friday sui nostri percorsi. Prima di raccontarti come funziona, una domanda per capire cosa fa per te: oggi lavori o stai cercando lavoro?`;
}

/**
 * Stand-by delle aperture BF (PO 07/11/2026): nessuna apertura, nemmeno la neutra, finche'
 * il template BF non e' approvato da Meta sull'account del numero; poi parte da solo.
 * Interruttore manuale `app_settings.bf_apertura_modo`:
 *  - assente / 'auto': si aspetta l'approvazione;
 *  - 'neutra': si apre subito col neutro `aperturabotchat` (se il template non arriva).
 */
/** In `event_log`: la richiesta di mandare l'apertura BF a una chat con APPUNTAMENTO del
 *  bot (PO 09/11/2026). La scrive l'arruolamento, la legge `bf-aperture` (che manda), fa
 *  da guardia ai ritenti dell'intake e dice a Mario che la call c'era gia'. */
export const EVENTO_BF_SU_APPUNTAMENTO = 'bf_apertura_su_appuntamento' as const;
export const SETTING_MODO_APERTURA = 'bf_apertura_modo' as const;

export type SceltaAperturaBf = 'template_bf' | 'attesa' | 'neutra';

/** Puro: template BF approvato = quello; altrimenti stand-by, salvo interruttore 'neutra'. */
export function sceltaAperturaBf(i: { approvato: boolean; modo: string | null }): SceltaAperturaBf {
  if (i.approvato) return 'template_bf';
  return (i.modo ?? '').trim().toLowerCase() === 'neutra' ? 'neutra' : 'attesa';
}

/** La chat e' arrivata dal CRM come BLACK FRIDAY (lead delle inserzioni, PO 07/11/2026). */
export function isCrmFunnelBlackFriday(f: string | null | undefined): boolean {
  return (f ?? '').trim().toUpperCase() === PROVENIENZA_BLACK_FRIDAY;
}

/**
 * Un nostro template in questa chat ha parlato d'altro (aperture per funnel: 10 ore,
 * Telegram, simulatore; o il lancio): per un lead Black Friday e' stato un errore nostro
 * (Cristina, conv 26723, 07/11/2026) e alla prima risposta Mario si scusa.
 */
const APERTURA_SBAGLIATA = /\b10 ore\b|canale telegram|simulatore|web developer ai/i;
export function haAperturaSbagliata(rows: readonly { direction: string; body: string | null; template_sid?: string | null }[]): boolean {
  return rows.some((m) => m.direction === 'out' && !!m.template_sid && APERTURA_SBAGLIATA.test(m.body ?? ''));
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
  /**
   * Lead delle inserzioni Black Friday (crm_funnel BLACK FRIDAY, PO 07/11/2026): arrivano
   * gia' dal 7/11, prima dell'offerta. Per loro il funnel vale da subito (la nota dice che
   * l'offerta parte lunedi' 9) fino alla scadenza.
   */
  anticipato?: boolean;
}): boolean {
  const v = (i.env ?? '').trim().toLowerCase();
  if (['0', 'false', 'off'].includes(v)) return false;
  if (['1', 'true', 'on'].includes(v)) return true;
  const fine = i.scadenzaAtMs ?? FINE_BLACK_FRIDAY_DEFAULT_MS;
  return (i.anticipato || i.nowMs >= INIZIO_BLACK_FRIDAY_MS) && i.nowMs <= fine;
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
 * I fatti dell'offerta Black Friday (PO 06/11/2026), gli stessi in ogni contesto: il funnel
 * BF e, dal 10/11, il pitch dei lead evergreen (lib/offerta-bf-evergreen.ts). Posti e
 * scadenza solo se ci sono (scadenza gia' filtrata: null = passata o assente).
 */
export function righeFattiOffertaBlackFriday(i: { posti: number | null; scadenza: ScadenzaBlackFriday | null }): string[] {
  const fatti = [
    "I FATTI DELL'OFFERTA sono SOLO questi. Non aggiungerne altri, non inventare condizioni, eccezioni, numeri o date:",
    "- PREZZO: con il Black Friday i percorsi, che normalmente costano dai 2.000 ai 4.000 euro, costano dai 1.000 ai 3.000 euro a seconda del percorso, e si possono rateizzare. Mai cifre di rata ne' numero di rate (per questo funnel non vale la cifra indicativa dei 100 euro al mese del manuale, e niente esempi tipo caffe' e cornetto), mai percentuali di sconto, mai il prezzo di un singolo percorso: quello lo vede col consulente in call.",
    "- GARANZIA \"COLLOCATO O RIMBORSATO\": e' scritta nero su bianco nel contratto: se non trova lavoro grazie al nostro corso, lo rimborsiamo. Se ti chiede condizioni, tempi, requisiti o dettagli, resta sul generico: le condizioni precise gliele spiega il consulente in call. Non inventare durate, requisiti o percentuali.",
    "- REGALO PER TUTTI GLI ISCRITTI: un corso sull'intelligenza artificiale che insegna a usare l'IA nella professione che sceglie, per dominare il mercato.",
    "- PERCORSO EXCLUSIVE: chi lo sceglie riceve un regalo in piu', e se ne parla in call. Al massimo puoi dire che e' un regalo tech, fisico, che gli arriva direttamente a casa. Non dire mai che oggetto e', non descriverlo e non dare indizi; se prova a indovinare non confermare e non smentire: \"e' una sorpresa, te la svela il consulente in call\".",
    "- PERCHE' ADESSO: questo e' il momento migliore per formarsi, perche' il primo trimestre del 2027 e' decisivo per le assunzioni: con la ripartenza di inizio anno le aziende assumono di piu', e chi si forma adesso arriva pronto. Puoi usarlo come leva per non rimandare. Non aggiungere numeri, percentuali, nomi di aziende o studi a sostegno.",
  ];
  if (i.posti) {
    fatti.push(`- POSTI: i posti con le condizioni del Black Friday sono solo ${i.posti}, perche' vogliamo essere sicuri di poter garantire il lavoro a tutti quelli che entrano. Puoi dirlo, sempre con questa motivazione. Non dire mai quanti posti sono rimasti o quanti sono gia' stati presi: non lo sai.`);
  }
  if (i.scadenza) {
    fatti.push(`- SCADENZA: l'offerta vale fino a ${i.scadenza.etichetta} compreso. Non citare altre date di fine.`);
  } else {
    fatti.push("- SCADENZA: non ne abbiamo una da dire. Non citare date di fine offerta e non dire che scade a breve.");
  }
  return fatti;
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
  /** 'inserzione' = lead delle inserzioni Black Friday: il primo messaggio l'abbiamo mandato noi. */
  ingresso?: 'link' | 'inserzione';
  /** Un nostro template in chat ha parlato d'altro (10 ore, Telegram...): Mario si scusa. */
  aperturaSbagliata?: boolean;
  /** La chat ha gia' un APPUNTAMENTO del bot (PO 09/11/2026): data della call (ISO, null =
   *  non nota). Mario parla del BF senza fissarne un'altra ne' disdire quella. */
  callGiaFissata?: { atIso: string | null } | null;
}): string {
  const scadenza = i.scadenza && i.scadenza.atMs > i.nowMs ? i.scadenza : null;
  const vsl = i.vslLink?.trim() || null;
  const daInserzione = i.ingresso === 'inserzione';
  const primaDellInizio = i.nowMs < INIZIO_BLACK_FRIDAY_MS;
  const righe = [
    daInserzione
      ? "CONTESTO FUNNEL BLACK FRIDAY: questo lead ha lasciato i suoi contatti da una nostra inserzione del Black Friday (non dal link dell'email): il primo messaggio gliel'abbiamo mandato noi. E' interessato all'offerta Black Friday sui nostri percorsi."
      : "CONTESTO FUNNEL BLACK FRIDAY: questo lead ci ha scritto per primo dal link dell'email del Black Friday e vuole sapere com'e' l'offerta.",
    ...righeFattiOffertaBlackFriday({ posti: i.posti, scadenza }),
  ];
  const call = i.callGiaFissata ?? null;
  if (i.posti || scadenza) {
    if (call) righe.push(`URGENZA VERA: per questo lead ${[i.posti ? 'i posti limitati' : null, scadenza ? 'la scadenza' : null].filter(Boolean).join(' e ')} sono fatti veri: puoi usarli per dirgli che conviene non saltare la call che ha gia' fissato, perche' e' li' che blocca il posto con le condizioni del Black Friday. Restano vietati il senso di colpa e qualunque fatto che non sia scritto qui.`);
    else righe.push(`URGENZA VERA: per questo lead ${[i.posti ? 'i posti limitati' : null, scadenza ? 'la scadenza' : null].filter(Boolean).join(' e ')} sono fatti veri e li puoi usare come leva per fissare la call adesso e non fra qualche settimana, in deroga alla regola generale su fretta e scarsita'. Restano vietati il senso di colpa e qualunque fatto che non sia scritto qui.`);
  }
  if (primaDellInizio && !call) {
    righe.push(
      "QUANDO PARTE: l'offerta Black Friday parte lunedi' 9 novembre. Oggi non e' ancora attiva: puoi raccontarla (sono i fatti qui sopra) dicendo che parte lunedi' 9.",
      "CALL DA LUNEDI' 9: la videocall col consulente si fissa SOLO da lunedi' 9 novembre in poi, perche' e' da lunedi' che si puo' bloccare il posto con le condizioni del Black Friday. Non proporre ne' accettare giorni prima di lunedi' 9 (niente oggi, niente domenica 8): se chiede prima, spiegagli che l'offerta parte lunedi' e proponi lunedi' 9 o i giorni subito dopo.",
    );
  }
  if (i.aperturaSbagliata && !call) {
    righe.push(
      "MESSAGGIO SBAGLIATO: il nostro primo messaggio in questa chat parlava d'altro (10 ore gratuite, canale Telegram, simulatore o live) ed era un errore nostro. Alla sua prima risposta scusati in una riga, senza drammi (es. \"Scusami, il messaggio di prima era sbagliato: ti sei registrato per l'offerta Black Friday\"), poi prosegui col flusso qui sotto. Non promettere accessi, corsi gratuiti o canali di cui parlava quel messaggio.",
    );
  }
  if (call) {
    const atMs = call.atIso ? Date.parse(call.atIso) : NaN;
    const quando = Number.isNaN(atMs) ? null : formatRomeDateTime(call.atIso as string);
    const passata = !Number.isNaN(atMs) && atMs <= i.nowMs;
    righe.push(
      quando
        ? (passata
          ? `CALL GIA' FISSATA: questo lead aveva gia' una videocall col consulente fissata per ${quando} (gia' passata). Ha lasciato i contatti anche per il Black Friday e gli abbiamo scritto noi per questo.`
          : `CALL GIA' FISSATA: questo lead ha gia' una videocall col consulente fissata per ${quando}. Ha lasciato i contatti anche per il Black Friday e gli abbiamo scritto noi per questo.`)
        : "CALL GIA' FISSATA: questo lead ha gia' una videocall col consulente fissata (la data la trovi nella cronologia). Ha lasciato i contatti anche per il Black Friday e gli abbiamo scritto noi per questo.",
      "ALLA SUA PRIMA RISPOSTA: rispondi a quello che chiede, digli in poche righe cosa comprende l'offerta Black Friday (prezzo ridotto, garanzia scritta nel contratto, corso IA in regalo) e ricordagli la sua call" + (quando ? ` (${quando})` : '') + ": e' li' che il consulente gli spiega l'offerta e blocca il posto con le condizioni del Black Friday.",
      "REGOLE SULLA CALL: NON fissare un'altra videocall, NON proporre giorni o orari, NON mandare il link del form, NON disdire e NON spostare la call di tua iniziativa. Niente qualifica completa: la call c'e' gia'. Se e' lui a chiedere di spostarla o disdirla, segui il manuale come sempre per una call gia' fissata.",
      ...(passata
        ? ["SE LA CALL E' GIA' PASSATA: non fissarne un'altra tu. Digli che segnali al consulente che vuole risentirlo per l'offerta Black Friday, e scrivilo nella nota."]
        : []),
    );
    if (vsl) {
      righe.push(
        `VIDEO: se non gliel'hai gia' mandato, puoi mandargli UNA volta il video dell'offerta Black Friday da guardare prima della call: ${vsl}`,
        "Invito e link sulla stessa riga: \"*Prima della videochiamata guarda questo video* 👉 <link>\". Non dire quanto dura.",
      );
    }
    return righe.join('\n');
  }
  righe.push(
    daInserzione
      ? "ALLA SUA PRIMA RISPOSTA: digli in poche righe che ti ha lasciato i contatti per l'offerta Black Friday e cosa comprende (prezzo ridotto, garanzia scritta nel contratto, corso IA in regalo), poi UNA domanda sulla sua situazione per capire quale percorso fa per lui (es. \"Per capire quale percorso fa per te: oggi lavori o stai cercando?\"). Se ti chiede chi sei o perche' gli scrivi, rispondi a quello prima. Il regalo dell'Exclusive lo nomini solo piu' avanti o se ti chiede dei regali."
      : "QUANDO TI CHIEDE DELL'OFFERTA (di solito nel suo primo messaggio, con la frase del link): rispondi subito a quello che ha chiesto, senza aspettare il pitch. In poche righe gli dici che il Black Friday e' attivo e cosa comprende (prezzo ridotto, garanzia scritta nel contratto, corso IA in regalo), poi UNA domanda sulla sua situazione per capire quale percorso fa per lui (es. \"Per capire quale percorso fa per te: oggi lavori o stai cercando?\"). Il regalo dell'Exclusive lo nomini solo piu' avanti o se ti chiede dei regali.",
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
