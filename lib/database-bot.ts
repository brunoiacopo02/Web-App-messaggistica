/**
 * Lead di DATABASE dalla coda marketing (PO 10/11/2026).
 *
 * Il marketing manda ogni giorno nella sua coda (CRM, POST /api/webhooks/marketing-leads)
 * una trentina di lead VECCHI con punteggio buono. Il CRM li spinge qui con
 * `database: true` (contratto v1.17) e il bot li lavora da solo:
 * - un'apertura apposta, a rotazione fra le varianti attive (`bf`, `a`, `b`, `c`, `d`);
 * - divisi fra tutti i numeri attivi, dentro i tetti di sempre (`tetti_numeri`), con in
 *   piu' un tetto "database" al giorno e uno per numero;
 * - un solo messaggio a persona: niente touch, niente sollecito, niente nudge;
 * - "Non mi interessa" = congedo breve e chat chiusa (DA_SCARTARE);
 * - nessun ritorno ai GDO (lo blocca il CRM, che parcheggia questi lead).
 *
 * Interruttore: `app_settings.database_bot`, SPENTO se assente. Si cambia senza deploy:
 *   {"attivo": true, "tetto_giorno": 30, "tetto_numero": 6, "varianti": ["bf","a","b","c","d"]}
 * Spegnere una variante = toglierla da `varianti`: le chat gia' aperte con quella variante
 * non cambiano (la variante di una chat si legge dal template che ha ricevuto).
 *
 * Modulo puro: niente DB, niente rete. L'arruolamento sta in lib/database-enroll.ts.
 */

export const SETTING_DATABASE_BOT = 'database_bot' as const;

/**
 * Il segno sulla chat: `conversations.crm_funnel`. Lo scrive il bot all'arruolamento e NON
 * e' il funnel del CRM ("Database" e' anche il funnel di ~34.000 lead ordinari, alcuni gia'
 * sul bot: quelli restano lead come gli altri).
 */
export const FUNNEL_CHAT_DATABASE = 'DATABASE BOT' as const;

export function isChatDatabase(crmFunnel: string | null | undefined): boolean {
  return (crmFunnel ?? '').trim().toUpperCase() === FUNNEL_CHAT_DATABASE;
}

/** In `event_log`, una riga per ogni apertura tentata: `{ conversationId, numero, variante, sid, crmLeadId, inviato }`. */
export const EVENTO_DATABASE_APERTURA = 'database_apertura' as const;
/** In `event_log`: il lead ha premuto "Non mi interessa". `{ conversationId, variante, crmLeadId }`. */
export const EVENTO_DATABASE_NON_INTERESSA = 'database_non_interessa' as const;

export const VARIANTI_DATABASE = ['bf', 'a', 'b', 'c', 'd'] as const;
export type VarianteDatabase = (typeof VARIANTI_DATABASE)[number];

/** Il SID dell'account principale di ogni variante; gli altri account lo ritrovano per nome. */
export const ENV_SID_DATABASE: Record<VarianteDatabase, string> = {
  bf: 'DATABASE_OPENING_SID_BF',
  a: 'DATABASE_OPENING_SID_A',
  b: 'DATABASE_OPENING_SID_B',
  c: 'DATABASE_OPENING_SID_C',
  d: 'DATABASE_OPENING_SID_D',
};
export const ENV_KEYS_DATABASE: readonly string[] = VARIANTI_DATABASE.map((v) => ENV_SID_DATABASE[v]);

export const NOME_TEMPLATE_DATABASE: Record<VarianteDatabase, string> = {
  bf: 'fenice_apertura_database_bf_v1',
  a: 'fenice_apertura_database_a_v1',
  b: 'fenice_apertura_database_b_v1',
  c: 'fenice_apertura_database_c_v1',
  d: 'fenice_apertura_database_d_v1',
};

type Env = Record<string, string | undefined>;

/** Variante → SID configurato (solo quelle con la env valorizzata). */
export function sidDatabaseDaEnv(env: Env = process.env): Partial<Record<VarianteDatabase, string>> {
  const out: Partial<Record<VarianteDatabase, string>> = {};
  for (const v of VARIANTI_DATABASE) {
    const sid = (env[ENV_SID_DATABASE[v]] ?? '').trim();
    if (sid) out[v] = sid;
  }
  return out;
}

/** Tutti i SID database configurati: entrano nello sblocco MARKETING e nel set "Marta". */
export function tuttiISidDatabase(env: Env = process.env): string[] {
  return Object.values(sidDatabaseDaEnv(env));
}

/** Da quale variante viene questo template (null = non e' un'apertura database). */
export function varianteDaTemplateSid(sid: string | null | undefined, env: Env = process.env): VarianteDatabase | null {
  if (!sid) return null;
  const mappa = sidDatabaseDaEnv(env);
  return VARIANTI_DATABASE.find((v) => mappa[v] === sid) ?? null;
}

/** La variante con cui e' stata aperta la chat: il primo nostro template database in cronologia. */
export function varianteDellaChat(
  rows: readonly { direction: string; template_sid?: string | null }[],
  env: Env = process.env,
): VarianteDatabase | null {
  for (const m of rows) {
    if (m.direction !== 'out') continue;
    const v = varianteDaTemplateSid(m.template_sid, env);
    if (v) return v;
  }
  return null;
}

export const TETTO_GIORNO_DEFAULT = 30;
export const TETTO_NUMERO_DEFAULT = 6;

export type SettingsDatabase = {
  attivo: boolean;
  /** Aperture database al giorno, su tutti i numeri insieme. */
  tettoGiorno: number;
  /** Aperture database al giorno per ogni numero. */
  tettoNumero: number;
  /** Le varianti accese, nell'ordine canonico. */
  varianti: VarianteDatabase[];
  /**
   * `fuori_tetto: true` (PO 11/11/2026, "5 a numero al di la' del tetto"): le aperture
   * database non guardano `tetti_numeri` (ne' il tetto del numero ne' il suo 0): resta
   * solo `tetto_numero`. Assente/falso = dentro i tetti come prima.
   */
  fuoriTetto: boolean;
  /**
   * `numeri`: elenco esplicito dei numeri da usare (cifre, con o senza `whatsapp:`/`+`),
   * fra quelli del giro del bot. Assente = tutti i numeri del giro, come prima.
   */
  numeri: string[] | null;
  /**
   * Riapertura di una chat VECCHIA (proposta PO 11/11/2026, regola a): `giorni_fermo`
   * = da quanti giorni la chat deve essere ferma (nessun messaggio, ne' nostro ne' del lead)
   * perche' l'apertura database possa partire su di lei. Assente = mai: una chat esistente
   * resta un rifiuto definitivo, come prima.
   */
  riprendiChatDopoGiorni: number | null;
  /** `riaperture_max_giorno`: quante di quelle aperture al giorno, dentro `tetto_giorno`. Assente = nessun limite in piu'. */
  riapertureMaxGiorno: number | null;
  /** `varianti_riapertura`: le varianti ammesse sulle chat riaperte (es. solo la piu' neutra). Assente = le stesse. */
  variantiRiapertura: VarianteDatabase[] | null;
  /**
   * `solo_chi_ha_risposto: true`: si riaprono solo le chat in cui il lead ci ha scritto
   * almeno una volta. Riscrivere a freddo a chi non ha MAI risposto e' lo schema che ha
   * portato lo 0047 a LOW (fine ottobre). Assente = tutte.
   */
  soloChiHaRisposto: boolean;
  /**
   * `riapri_tutti: true` (PO 12/11/2026: "dobbiamo scrivere a tutti"): insieme a
   * `giorni_fermo`, una chat esistente si riapre anche se era in pausa, di un GDO, del
   * lancio o scartata dal bot, e se il suo numero oggi non puo' aprire (a riposo, pieno,
   * non HIGH) l'apertura parte da un numero del giro e la chat lo segue. Restano fuori
   * solo: chat viva, opt-out, numero senza WhatsApp, apertura Black Friday gia' ricevuta.
   * Assente = come prima.
   */
  riapriTutti: boolean;
};

export const SETTINGS_DATABASE_SPENTO: SettingsDatabase = {
  attivo: false, tettoGiorno: TETTO_GIORNO_DEFAULT, tettoNumero: TETTO_NUMERO_DEFAULT, varianti: [...VARIANTI_DATABASE],
  fuoriTetto: false, numeri: null, riprendiChatDopoGiorni: null, riapertureMaxGiorno: null, variantiRiapertura: null,
  soloChiHaRisposto: false, riapriTutti: false,
};

/** Solo le cifre del numero: `whatsapp:+39 352...` e `39352...` sono lo stesso numero. */
export function cifreNumero(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

function acceso(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  return ['on', '1', 'true', 'acceso', 'si', 'sì'].includes(raw.trim().toLowerCase());
}

function tetto(raw: unknown, ripiego: number): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : ripiego;
}

/**
 * `app_settings.database_bot`. Fallisce verso lo spento: riga assente, valore che non e' un
 * oggetto, `attivo` che non e' un si' esplicito = spento. Un tetto illeggibile vale il
 * default (mai "senza tetto"). `varianti` assente = tutte e cinque; presente = solo quelle
 * scritte e riconosciute (lista vuota = nessuna apertura).
 */
export function parseSettingsDatabase(raw: unknown): SettingsDatabase {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...SETTINGS_DATABASE_SPENTO };
  const o = raw as Record<string, unknown>;
  const scritte = Array.isArray(o.varianti)
    ? o.varianti.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
    : null;
  return {
    attivo: acceso(o.attivo),
    tettoGiorno: tetto(o.tetto_giorno, TETTO_GIORNO_DEFAULT),
    tettoNumero: tetto(o.tetto_numero, TETTO_NUMERO_DEFAULT),
    varianti: scritte ? VARIANTI_DATABASE.filter((v) => scritte.includes(v)) : [...VARIANTI_DATABASE],
    fuoriTetto: o.fuori_tetto === true,
    // Lista presente ma vuota o tutta sporca = nessun numero (mai "tutti" per sbaglio).
    numeri: Array.isArray(o.numeri)
      ? o.numeri.map((n) => (typeof n === 'string' ? cifreNumero(n) : '')).filter((n) => n.length >= 8)
      : null,
    riprendiChatDopoGiorni: interoOpzionale(o.giorni_fermo, 1, 365),
    riapertureMaxGiorno: interoOpzionale(o.riaperture_max_giorno, 0, 1000),
    variantiRiapertura: Array.isArray(o.varianti_riapertura)
      ? VARIANTI_DATABASE.filter((v) => (o.varianti_riapertura as unknown[]).some((x) => typeof x === 'string' && x.trim().toLowerCase() === v))
      : null,
    soloChiHaRisposto: o.solo_chi_ha_risposto === true,
    riapriTutti: o.riapri_tutti === true,
  };
}

/** Un intero nell'intervallo, altrimenti null (= opzione assente: si resta come prima). */
function interoOpzionale(raw: unknown, min: number, max: number): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** Lo stato di una chat esistente che serve a decidere se si puo' riaprire. */
export type StatoChatEsistente = {
  waNumber: string | null;
  /** Ultimo messaggio della chat, nostro o del lead (ms). null = nessuno. */
  ultimoMessaggioMs: number | null;
  pausata: boolean;
  /** La chat e' di un GDO (agenda/postino): non e' nostra. */
  chatGdo: boolean;
  /** Fase del lancio non terminale. */
  lancioInCorso: boolean;
  botOutcome: string | null;
  botOutcomeMs: number | null;
  /** Il lead ha chiesto di non essere contattato (STOP, "non mi interessa", "non scrivetemi"...). */
  optOut: boolean;
  /** Un invio della chat e' morto con 63024 (numero senza WhatsApp). */
  senzaWhatsapp: boolean;
  /** Il lead ci ha scritto almeno una volta in questa chat. */
  haRisposto: boolean;
  /** La chat ha gia' ricevuto un nostro template che nomina il Black Friday (PO 12/11/2026: mai due volte). */
  giaAperturaBf?: boolean;
};

/** `chat_attiva` si puo' riprovare piu' avanti; tutti gli altri sono definitivi. */
export type MotivoNonRiapribile =
  | 'chat_attiva' | 'pausa_manuale' | 'opt_out' | 'senza_whatsapp' | 'lancio_in_corso' | 'chat_gdo' | 'scartata_dal_bot'
  | 'mai_risposto' | 'gia_apertura_bf';

/**
 * La chat esistente si puo' riaprire con l'apertura database? (regola a, PO 11/11/2026)
 * Ferma da almeno `giorni` (nessun messaggio, ne' nostro ne' del lead), nessun fermo
 * manuale, nessuna richiesta di non essere contattato, numero con WhatsApp, non di un
 * GDO, non nel lancio, non scartata dal bot. Un APPUNTAMENTO del bot recente rientra in
 * "chat attiva" (esito datato meno di `giorni` fa).
 */
export function motivoChatNonRiapribile(
  s: StatoChatEsistente, i: { nowMs: number; giorni: number; soloChiHaRisposto?: boolean; tutti?: boolean },
): MotivoNonRiapribile | null {
  // `tutti` (`riapri_tutti`, PO 12/11/2026): pausa, chat di un GDO, lancio e scarto del bot
  // non fermano piu' la riapertura. Opt-out, numero morto, doppia apertura BF e chat viva si'.
  if (s.pausata && !i.tutti) return 'pausa_manuale';
  if (s.optOut) return 'opt_out';
  if (s.senzaWhatsapp) return 'senza_whatsapp';
  if (s.giaAperturaBf) return 'gia_apertura_bf';
  if (s.chatGdo && !i.tutti) return 'chat_gdo';
  if (s.lancioInCorso && !i.tutti) return 'lancio_in_corso';
  if (s.botOutcome === 'DA_SCARTARE' && !i.tutti) return 'scartata_dal_bot';
  if (i.soloChiHaRisposto && !s.haRisposto) return 'mai_risposto';
  const soglia = i.nowMs - i.giorni * 24 * 3600_000;
  if (s.ultimoMessaggioMs !== null && s.ultimoMessaggioMs > soglia) return 'chat_attiva';
  if (s.botOutcomeMs !== null && s.botOutcomeMs > soglia) return 'chat_attiva';
  return null;
}

/**
 * Fine della variante `bf`: il suo testo dice "Fino al 30 novembre", quindi dal 1/12/2026
 * (ora di Roma) esce dalla rotazione da sola, anche se resta scritta in `varianti` e anche
 * se la scadenza dell'offerta in `app_settings` venisse spostata.
 */
export const FINE_VARIANTE_BF_MS = Date.parse('2026-11-30T23:59:59+01:00');

/**
 * Le varianti che ADESSO possono girare: accese nelle impostazioni, col SID in env, e la
 * `bf` solo fino al 30/11/2026 compreso. L'approvazione di Meta sul singolo numero si
 * guarda dopo (lib/database-enroll.ts).
 */
export function variantiInRotazione(i: { settings: SettingsDatabase; nowMs: number; env?: Env }): VarianteDatabase[] {
  const sid = sidDatabaseDaEnv(i.env ?? process.env);
  return i.settings.varianti.filter((v) => !!sid[v] && (v !== 'bf' || i.nowMs <= FINE_VARIANTE_BF_MS));
}

/**
 * Ripartizione stabile per id della chat: la stessa chat cade sempre sulla stessa variante,
 * e le chat si dividono in parti uguali fra quelle disponibili. Lista vuota = null.
 */
export function scegliVariante(conversationId: number, disponibili: readonly VarianteDatabase[]): VarianteDatabase | null {
  const ordinate = VARIANTI_DATABASE.filter((v) => disponibili.includes(v));
  if (ordinate.length === 0) return null;
  const n = ordinate.length;
  return ordinate[((Math.trunc(conversationId) % n) + n) % n];
}

const INTRO = (nome: string) =>
  `Ciao ${nome}, sono Marta di Fenice Academy. Tempo fa ci avevi chiesto informazioni sulle professioni digitali`;

/** I testi ESATTI dei cinque template (creati il 10/11/2026 sui tre account). {{1}} = nome. */
const TESTI: Record<VarianteDatabase, (nome: string) => string> = {
  bf: (n) => `${INTRO(n)}. Fino al 30 novembre i nostri percorsi sono in offerta Black Friday. Prima di spiegarti come funziona: oggi lavori o stai cercando lavoro?`,
  a: (n) => `${INTRO(n)}. Una domanda veloce per capire cosa fa per te oggi: punti a un'entrata extra o a cambiare lavoro?`,
  b: (n) => `${INTRO(n)} e poi non siamo più riusciti a sentirci. Posso chiederti com'è andata? Hai iniziato qualcosa o è rimasto un progetto?`,
  c: (n) => `${INTRO(n)}. Da allora nei nostri percorsi è entrata l'intelligenza artificiale e il modo di lavorare è cambiato. Ti va di capire se oggi fa per te?`,
  d: (n) => `${INTRO(n)}. Ti fisso una chiamata gratuita con un nostro consulente per vedere il percorso adatto a te: ti va meglio domani o dopodomani?`,
};

/** Il corpo dell'apertura come lo legge il lead (va in cronologia: Mario lo rilegge). */
export function testoAperturaDatabase(variante: VarianteDatabase, nome: string): string {
  return TESTI[variante](nome);
}

/** Il titolo del pulsante a risposta rapida presente su tutte e cinque le varianti. */
export const PULSANTE_NON_INTERESSA = 'Non mi interessa';

/**
 * Il lead ha premuto "Non mi interessa"? Twilio consegna il titolo del pulsante come testo
 * del messaggio. Vale solo il titolo (maiuscole, spazi e punteggiatura finale a parte):
 * una frase piu' lunga la legge Marta come ogni altra risposta.
 */
export function eNonMiInteressa(body: string | null | undefined): boolean {
  const t = (body ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!…]+$/u, '').trim();
  return t === PULSANTE_NON_INTERESSA.toLowerCase();
}

/** Il congedo: una riga sola, nessuna domanda, nessun rilancio. */
export const TESTO_CONGEDO_DATABASE = 'Va bene, grazie per la risposta: non ti scrivo più. Buona giornata!';

/** La nota del DA_SCARTARE al CRM. */
export function notaNonInteressaDatabase(variante: VarianteDatabase | null): string {
  return `Lead di database ricontattato dal bot: ha premuto "Non mi interessa" sul messaggio di apertura${variante ? ` (variante ${variante})` : ''}.`;
}

/**
 * Nota di contesto per Marta (parte variabile del prompt: manuale e cache intatti).
 * Dice solo cio' che e' vero per tutti questi lead: sono vecchi, li abbiamo ricontattati
 * noi. Con la variante `bf` aggiunge che l'apertura ha gia' nominato l'offerta: i FATTI
 * dell'offerta arrivano dalla nota del Black Friday evergreen, che per queste chat si
 * accende da sola (vedi lib/fenice-autoreply.ts).
 */
export function databaseContextNote(i: { variante: VarianteDatabase | null; offertaBfNelPrompt: boolean }): string {
  const righe = [
    "LEAD DI DATABASE RICONTATTATO: questa persona ci aveva chiesto informazioni tempo fa (mesi, a volte anni) e poi non ci siamo piu' sentiti. Adesso le abbiamo scritto NOI, col messaggio che vedi in cima alla cronologia. Non e' un lead appena iscritto: non dire che si e' appena registrata, non promettere accessi, email in arrivo, corsi gratuiti o materiali.",
    "SE NON SI RICORDA DI NOI o chiede perche' le scriviamo: dille con semplicita' che tempo fa aveva lasciato i suoi contatti per avere informazioni sulle professioni digitali, e che se oggi non le interessa basta dirlo. Non inventare quando, dove o per quale corso: non lo sai.",
    "LA SUA PRIMA RISPOSTA puo' essere solo il testo di un pulsante (per esempio \"Lavoro\", \"Cerco lavoro\", \"Entrata extra\", \"Sì, spiegami\", \"Domani\"): e' la risposta alla domanda del nostro primo messaggio. Parti da li' e prosegui col flusso del manuale, senza rifare la stessa domanda.",
    "SE DICE CHE NON LE INTERESSA: salutala in una riga e chiudi, senza insistere e senza rilanciare.",
  ];
  if (i.variante === 'bf') {
    righe.push(i.offertaBfNelPrompt
      ? "OFFERTA GIA' NOMINATA: il nostro primo messaggio le ha gia' detto che fino al 30 novembre i percorsi sono in offerta Black Friday e le ha promesso di spiegarle come funziona. Dopo la sua risposta dille in poche righe cosa comprende l'offerta (i fatti sono nel blocco OFFERTA BLACK FRIDAY qui sotto), poi prosegui con la qualifica del manuale. Se chiede dell'offerta rispondi subito, senza aspettare il pitch."
      : "OFFERTA NOMINATA NEL PRIMO MESSAGGIO: il nostro primo messaggio parlava di un'offerta Black Friday fino al 30 novembre. Qui non hai i dettagli dell'offerta: non inventarli. Se te li chiede, dille che glieli spiega il consulente in videocall, e prosegui col flusso del manuale.");
  }
  return righe.join('\n');
}
