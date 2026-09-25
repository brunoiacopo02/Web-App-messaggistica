import { templateName } from './name';
import { isMarkerPulsanteWebinar } from './primo-messaggio';

/**
 * Lancio "Web Developer AI" (webinar 5/10/2026): stato, fasi e decisioni del turno.
 * Modulo PURO: niente env, niente DB, niente rete. Le costanti sono quelle della spec
 * (docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §3.2, §5.2).
 */

export const LANCIO_SLUG = 'webdev-2026-10';

export const LANCIO_FASI = [
  'attesa', 'posto_bloccato', 'link_inviato', 'post_pitch',
  'scelta_fatta', 'followup_inviato', 'restituito', 'chiuso',
] as const;
export type LancioFase = (typeof LANCIO_FASI)[number];

export function isLancioFase(v: unknown): v is LancioFase {
  return typeof v === 'string' && (LANCIO_FASI as readonly string[]).includes(v);
}

/** Con queste fasi il lancio è finito per quella chat: torna a Mario (o al GDO). */
export const LANCIO_FASI_TERMINALI: readonly LancioFase[] = ['chiuso', 'restituito'];

/**
 * Le UNICHE fasi da cui il pulsante del webinar riporta in `post_pitch`. Elenco chiuso:
 * quello che non è qui dentro non si tocca (`''` = chat mai entrata nel lancio).
 */
const FASI_CHE_IL_PULSANTE_RIPORTA: ReadonlySet<string> = new Set<string>([
  '', 'attesa', 'posto_bloccato', 'link_inviato', 'chiuso',
]);

/**
 * Il pulsante del webinar deve (ri)portare questa chat in `post_pitch`?
 *
 * Il marker vince su chi possiede la chat e su quello che il lead aveva detto prima — una
 * chat in `attesa`, col link già inviato, o perfino `chiuso` da un no di settimane fa
 * torna al dopo-pitch, e così una chat che nel lancio non c'è mai entrata (fase nulla).
 * Non vince invece su chi ha già preso in mano quella persona DOPO il pitch:
 *
 *  - `post_pitch` e `scelta_fatta` sono già il dopo-pitch: riscriverli lascerebbe solo un
 *    `lancio_fase_cambiata` in più (e su `scelta_fatta` cancellerebbe l'avanzamento);
 *  - da `followup_inviato` il flusso standard di B5 possiede la chat, e il pulsante
 *    premuto una seconda volta non deve rimetterla in coda al pitch;
 *  - `restituito` vuol dire che quel lead è tornato al GDO: riportarlo nel lancio
 *    glielo toglierebbe di mano.
 *
 * Nei casi in cui torna falso il pulsante si registra lo stesso (evento `lancio_pulsante`
 * con `faseInvariata`): il fatto che l'abbia premuto si vede nei pannelli comunque.
 */
export function pulsanteRiportaInPostPitch(fase: string | null | undefined): boolean {
  return FASI_CHE_IL_PULSANTE_RIPORTA.has(fase ?? '');
}

/**
 * Le UNICHE fasi da cui il pulsante premuto DOPO la notte del webinar (dalle 03:00 del
 * giorno dopo, decisione PO 25/09) passa la chat a Mario standard, cioe' in `chiuso`.
 * Sono le stesse da cui la sera la riporterebbe in `post_pitch`, piu' `post_pitch` stesso
 * (chi aveva premuto la sera e ripreme la mattina: i pulsanti della sera non valgono
 * piu'). Restano fuori, e il pulsante si registra a fase invariata:
 *  - `chiuso`: e' gia' Mario standard (dal follow-up, dal link, o da un congedo — e un
 *    congedato non si riapre, vedi `shouldReopen`);
 *  - `followup_inviato`: al prossimo turno il ramo del follow-up la passa a Mario da se';
 *  - `scelta_fatta`: il lead ha gia' la sua ora sul CRM;
 *  - `restituito`: e' del GDO (ruling C8).
 */
const FASI_CHE_IL_PULSANTE_PASSA_A_MARIO: ReadonlySet<string> = new Set<string>([
  '', 'attesa', 'posto_bloccato', 'link_inviato', 'post_pitch',
]);

export function pulsantePassaAMario(fase: string | null | undefined): boolean {
  return FASI_CHE_IL_PULSANTE_PASSA_A_MARIO.has(fase ?? '');
}

/**
 * Il marcatore su `lancio_info` delle chat passate a Mario standard dopo la notte del
 * webinar: dice al drain QUALE nota di contesto usare (chi ha visto la live e ha premuto
 * il pulsante non e' chi ha risposto al follow-up del giorno dopo) e conserva, accanto,
 * le risposte del riscaldamento gia' date la sera. `da`: 'pulsante' = premuto dal 6 in
 * poi; 'post_pitch' = premuto la sera, la chat ha attraversato le 03:00 a meta' scelta;
 * 'iscritto_dopo_live' = iscritto (o rimasto in coda senza benvenuto) quando la live era
 * gia' finita, vedi `benvenutoLancioChiuso`.
 */
export const CHIAVE_MARIO_DOPO_NOTTE = 'mario_dopo_notte';
export type MarioDopoNotte = { da: 'pulsante' | 'post_pitch' | 'iscritto_dopo_live'; at: string };
const DA_MARIO_DOPO_NOTTE: ReadonlySet<string> = new Set(['pulsante', 'post_pitch', 'iscritto_dopo_live']);

export function conMarioDopoNotte(info: unknown, da: MarioDopoNotte['da'], at: string): Record<string, unknown> {
  const base = info && typeof info === 'object' && !Array.isArray(info) ? (info as Record<string, unknown>) : {};
  return { ...base, [CHIAVE_MARIO_DOPO_NOTTE]: { da, at } };
}

export function marioDopoNotte(info: unknown): MarioDopoNotte | null {
  if (!info || typeof info !== 'object') return null;
  const v = (info as Record<string, unknown>)[CHIAVE_MARIO_DOPO_NOTTE];
  if (!v || typeof v !== 'object') return null;
  const { da, at } = v as { da?: unknown; at?: unknown };
  if (typeof da !== 'string' || !DA_MARIO_DOPO_NOTTE.has(da) || typeof at !== 'string') return null;
  return { da: da as MarioDopoNotte['da'], at };
}

/** Le risposte del riscaldamento salvate in `lancio_info.risposte` (solo stringhe). */
export function risposteRiscaldamento(info: unknown): string[] {
  if (!info || typeof info !== 'object') return [];
  const r = (info as Record<string, unknown>).risposte;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/**
 * Il pulsante deve riportare ad 'active' una chat chiusa?
 *
 * Solo se la fase si e' mossa davvero (`cambiaFase`, cioe' `pulsanteRiportaInPostPitch`).
 * Prima bastava "di Mario e chiusa", e su una chat gia' `restituito` questo bastava a
 * riaccenderla: la fase restava `restituito` — giusto, il lead e' del GDO — ma la riga
 * tornava 'active' con un inbound senza risposta, e il cron `bot-followups` fa re-drive
 * proprio su quella forma. Mario avrebbe risposto a una persona che un GDO sta chiamando,
 * cioe' il danno che il ruling C8 esiste per evitare. Vale allo stesso modo per le altre
 * fasi che il pulsante non muove (`followup_inviato`, `post_pitch`, `scelta_fatta`): se la
 * fase resta dov'e', lo stato non si tocca.
 */
export function pulsanteRiapreChat(g: {
  cambiaFase: boolean;
  aiOwner: string | null;
  aiStatus: string | null;
}): boolean {
  return g.cambiaFase && g.aiOwner === 'mario' && g.aiStatus === 'closed';
}

/** Perché il pulsante non ha potuto scrivere: chi ha in mano quella chat, o cosa è spento. */
export type MotivoPulsanteOrfano =
  | 'pulsante_spento' | 'bot_spento' | 'adozione_spenta' | 'in_pausa' | 'passata_umano' | 'altro_owner';

export type DecisionePulsante =
  | { scrive: true }
  | { scrive: false; motivo: MotivoPulsanteOrfano };

/**
 * Il pulsante del webinar può scrivere lo stato del lancio su questa chat?
 *
 * Il rischio che chiude è la **finestra orfana**: scrivere `lancio_slug` e `post_pitch`
 * su una chat che nessuno guida. Con lo slug addosso quella riga sparisce da
 * `adotta-mai-risposti` (che esclude `lancio_slug` non nullo) e dalle altre reti di
 * recupero, ma nessuno le risponde — a bot spento, ad adozione spenta, in pausa, o se la
 * chat è in mano a una persona. Sarebbe il silenzio che l'adozione esiste per chiudere,
 * con in più l'illusione che qualcuno se ne stia occupando.
 *
 * Si scrive quindi in due soli casi:
 *  (a) la chat è di Mario ed è libera (nessun fermo manuale, nessun passaggio a umano);
 *  (b) la sta adottando QUESTA richiesta (`shouldAdoptInbound` con `lancioPulsante`).
 *
 * Negli altri casi l'evento `lancio_pulsante` si scrive lo stesso, con `orfano` e il
 * `motivo`: la chat resta visibile alle reti di recupero, e `adotta-mai-risposti`
 * riclassifica quel pulsante e la porta in `post_pitch` quando l'adozione si accende.
 */
export function pulsanteScriveFase(i: {
  /** `lancio_pulsante_attivo` da `app_settings`: spento, il marker non vale niente. */
  pulsanteAttivo: boolean;
  aiOwner: string | null;
  aiPausedAt?: string | null;
  handedOffAt?: string | null;
  /** L'adozione di questa richiesta prende in carico la chat (`shouldAdoptInbound`). */
  adottaOra: boolean;
  /** L'interruttore generale dell'auto-risposta, dal pannello. */
  autoReplyOn: boolean;
  /** `INBOUND_ADOPTION_ENABLED === '1'`. */
  adozioneAttiva: boolean;
}): DecisionePulsante {
  // L'interruttore viene prima di tutto: spento, il marker e' solo del testo, e chi lo
  // scrive e' un inbound come un altro. Il pulsante premuto si registra lo stesso —
  // vedere le pressioni PRIMA di accendere e' metà del motivo per cui esiste la traccia.
  if (!i.pulsanteAttivo) return { scrive: false, motivo: 'pulsante_spento' };
  if (i.aiOwner === 'mario' && !i.aiPausedAt && !i.handedOffAt) return { scrive: true };
  if (i.adottaOra) return { scrive: true };
  // L'ordine dice CHI ha in mano la chat prima di dire cosa è spento: un passaggio a
  // umano o un fermo manuale restano la spiegazione giusta anche a bot spento.
  if (i.handedOffAt) return { scrive: false, motivo: 'passata_umano' };
  if (i.aiPausedAt) return { scrive: false, motivo: 'in_pausa' };
  if (i.aiOwner !== null) return { scrive: false, motivo: 'altro_owner' };
  if (!i.autoReplyOn) return { scrive: false, motivo: 'bot_spento' };
  // Resta: nessun padrone, tutto acceso, e l'adozione non scatta. Dal webhook vuol dire
  // `adozioneAttiva` falso (col pulsante il gate non guarda altro), e con l'adozione
  // accesa è un caso che non si produce: `adozione_spenta` è la lettura giusta in
  // entrambi i sensi — nessuno ha preso in carico questa chat.
  return { scrive: false, motivo: 'adozione_spenta' };
}

/**
 * Il link "professione dello Sviluppatore AI" (PO 24/09/2026) porta questa chat nel lancio?
 *
 * Chi entra dal link non passa dal pitch ne' dalla lista: va dritto a Mario standard col
 * video della live, cioe' nella stessa condizione di chi ha risposto al follow-up del
 * giorno dopo (fase `chiuso`, vedi `lancioStandardDrain`). Si scrive solo:
 *  - su una chat di Mario libera (appena adottata dal webhook, o gia' sua): una chat senza
 *    padrone, in pausa o passata a una persona resta com'e', come per il pulsante;
 *  - su una chat MAI entrata nel lancio: chi e' gia' dentro lo sta gestendo il lancio, e
 *    un `restituito` e' del GDO (ruling C8). Riscriverle vorrebbe dire togliere la chat a
 *    chi ce l'ha.
 */
export function linkSviluppatoreEntraNelLancio(c: {
  lancioSlug: string | null;
  aiOwner: string | null;
  aiPausedAt?: string | null;
  handedOffAt?: string | null;
}): boolean {
  if (c.lancioSlug) return false;
  return c.aiOwner === 'mario' && !c.aiPausedAt && !c.handedOffAt;
}

/** Le fasi che questo blocco (B1) sa gestire nel turno. Le altre arrivano con B4/B5. */
export const LANCIO_FASI_B1: readonly LancioFase[] = ['attesa', 'posto_bloccato'];
export const FASI_GESTITE_B1: ReadonlySet<string> = new Set<string>(LANCIO_FASI_B1);

/** Unica sorgente di verita' su "questa fase la sa gestire B1": la usano sia la
 *  decisione del turno sia chi deve capire se vale la pena interpellare il modello. */
export function faseGestitaB1(fase: string | null): boolean {
  return FASI_GESTITE_B1.has(fase ?? '');
}

/**
 * Ri-arruolamento nello STESSO lancio: questa fase riparte da zero o si preserva?
 *
 * Iscriversi al lancio e' un atto NUOVO di interesse: la persona e' tornata sulla pagina
 * e ha lasciato di nuovo il numero. Quel gesto vale piu' del "no" che aveva detto prima,
 * e trattarlo come se non fosse successo vorrebbe dire ignorare un lead caldo che si e'
 * rifatto vivo da solo (decisione del PO, 19/09/2026). Quindi:
 *
 *  - fase NON terminale (`attesa` → `followup_inviato`) = gente a meta' percorso: si
 *    preserva tutto. Riscriverle la fase e' il bug del 19/09 — uno che la sera della live
 *    aveva bloccato il posto tornava ad 'attesa' e il 7 ottobre finiva fra i restituiti
 *    come "non ha mai risposto";
 *  - fase TERMINALE (`chiuso`, `restituito`) = la storia precedente e' chiusa: si
 *    reinizializza come un ingresso nuovo, fase ad 'attesa', esito azzerato e benvenuto
 *    che puo' ripartire.
 *
 * Mappa ESAUSTIVA e non un elenco: aggiungere una fase a `LANCIO_FASI` senza deciderne
 * qui la voce non compila. La prossima persona e' costretta a scegliere da che parte
 * sta, invece di ereditare un comportamento per caso.
 */
export const LANCIO_FASE_RIPARTE_AL_RIARRUOLAMENTO: Readonly<Record<LancioFase, boolean>> = {
  attesa: false,
  posto_bloccato: false,
  link_inviato: false,
  post_pitch: false,
  scelta_fatta: false,
  followup_inviato: false,
  restituito: true,
  chiuso: true,
};

/**
 * Il ri-arruolamento di una chat gia' in questo lancio deve farla ripartire da capo?
 *
 * Una fase nulla o sconosciuta riparte: non c'e' nessun avanzamento da proteggere, e
 * lasciarla com'e' significherebbe una riga con lo slug scritto e la fase illeggibile,
 * cioe' fuori da tutti i cron — del lancio e di Mario insieme.
 */
export function lancioRipartePerRiarruolamento(fase: string | null | undefined): boolean {
  return !isLancioFase(fase) || LANCIO_FASE_RIPARTE_AL_RIARRUOLAMENTO[fase];
}

/** La chat è del lancio e il lancio non è finito: Mario e i suoi cron stanno fuori. */
export function lancioInCorso(c: { lancio_slug?: string | null; lancio_fase?: string | null }): boolean {
  if (!c.lancio_slug) return false;
  return !(LANCIO_FASI_TERMINALI as readonly string[]).includes(c.lancio_fase ?? '');
}

/**
 * Questa chat e' stata restituita al pool: il lead e' del GDO, il bot non le scrive piu'.
 *
 * Difesa in profondita' sul re-drive di `app/api/cron/bot-followups`. Quel cron ridrive
 * ogni riga `active`/`replying` con un inbound senza risposta, e il blocco che tiene il
 * lancio fuori da Mario (`lancioInCorso`) viene DOPO — ed e' gia' falso su `restituito`,
 * che e' una fase terminale. Le porte che dovrebbero impedire a una chat restituita di
 * restare `active` ci sono tutte (`pulsanteRiapreChat`, il veto di `shouldReopen`), ma
 * basta che una sola non tenga — un 200 `returnedToPool:false` dopo la chiusura locale,
 * una riapertura scritta da una strada nuova — perche' Mario risponda a una persona che
 * un GDO sta chiamando. E' il danno esatto che il ruling C8 esiste per evitare, quindi
 * la fase vale da sola, senza guardare `ai_status`.
 */
export function lancioRestituito(c: { lancio_fase?: string | null }): boolean {
  return (c.lancio_fase ?? '') === 'restituito';
}

/**
 * Lo stesso criterio di `lancioInCorso`, al contrario e in sintassi PostgREST, per le
 * query dei cron: `query.or(FILTRO_FUORI_LANCIO)`. Più `.or()` sulla stessa query si
 * sommano in AND, quindi si può aggiungere a query che ne hanno già uno.
 */
export const FILTRO_FUORI_LANCIO = 'lancio_slug.is.null,lancio_fase.in.(chiuso,restituito)';

// Testi fissi (spec §5.2). Il primo è verbatim dalla spec; gli altri seguono le stesse
// regole: niente link, niente prezzi, niente inviti a una call.
export const TESTO_POSTO_BLOCCATO =
  'Perfetto, il tuo posto è bloccato. Ti scrivo qui il 5 ottobre con il link per collegarti.';
export const TESTO_CONGEDO =
  'Va bene, grazie per avermelo detto: non ti scrivo più per questo evento. Buona giornata!';
export const TESTO_CHIUSURA_DOMANDE = 'Ci sentiamo il 5!';
/** Uscito fino al 25/09/2026, quando il lancio passava la chat a una persona. Non si
 *  manda piu' (vedi `TESTO_NIENTE_PASSAGGIO`), ma resta fra i testi fissi: sulle chat
 *  di prima non deve contare come una risposta a una domanda. */
export const TESTO_PASSAGGIO_UMANO = 'Certo, ti faccio contattare da una persona del team.';
/**
 * Il lancio non passa MAI la chat a una persona (PO 25/09/2026): il passaggio finiva nella
 * coda delle richieste di contatto e da li' a un GDO, fuori dal percorso del lancio. Se il
 * modello scrive [PASSAGGIO_UMANO] lo stesso, la sua riga ("ti faccio contattare")
 * prometterebbe un contatto che non arriva: esce questa al suo posto.
 */
export const TESTO_NIENTE_PASSAGGIO =
  'Prima della live non posso metterti in contatto con nessuno: ne parliamo dopo la live, e alla fine potrai parlare con un nostro consulente.';

/** Dopo tre scambi di domande il bot chiude e tace fino al link (spec §5.2). */
export const MAX_SCAMBI_DOMANDE = 3;

export type ClasseLancio = 'si' | 'no' | 'domanda' | 'incerto';

/** Una riga `messages` come la leggono i moduli del lancio. */
export type RigaLancio = {
  direction: string;
  body: string | null;
  template_sid: string | null;
  created_at?: string | null;
};

export type LancioAzione =
  | { kind: 'posto_bloccato'; testo: string }
  | { kind: 'congedo'; testo: string }
  | { kind: 'domanda'; chiudi: boolean }
  | { kind: 'silenzio'; motivo: 'gia_bloccato' | 'domande_esaurite' | 'fase_non_gestita' | 'classe_incerta' | 'inbound_fuori_lancio' };

/**
 * Cosa fare in questo turno, data la fase e la classe del messaggio del lead.
 * `scambiDomande` = risposte a domande già uscite in questa chat (vedi
 * `contaScambiDomande`): alla terza si chiude, dalla quarta si tace.
 */
export function decideLancioTurno(i: {
  fase: string | null;
  classe: ClasseLancio;
  scambiDomande: number;
}): LancioAzione {
  if (!faseGestitaB1(i.fase)) return { kind: 'silenzio', motivo: 'fase_non_gestita' };
  if (i.classe === 'no') return { kind: 'congedo', testo: TESTO_CONGEDO };
  if (i.classe === 'si') {
    return i.fase === 'posto_bloccato'
      ? { kind: 'silenzio', motivo: 'gia_bloccato' }
      : { kind: 'posto_bloccato', testo: TESTO_POSTO_BLOCCATO };
  }
  if (i.classe === 'domanda') {
    if (i.scambiDomande >= MAX_SCAMBI_DOMANDE) return { kind: 'silenzio', motivo: 'domande_esaurite' };
    return { kind: 'domanda', chiudi: i.scambiDomande === MAX_SCAMBI_DOMANDE - 1 };
  }
  return { kind: 'silenzio', motivo: 'classe_incerta' };
}

const TESTI_FISSI = new Set([TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_PASSAGGIO_UMANO]);

/**
 * Le risposte a domande già uscite: gli outbound liberi (senza template) che non sono
 * uno dei testi fissi. Si legge dalle righe `messages` invece che da un contatore:
 * nessuna colonna in più, e il conto resta giusto anche se un turno muore a metà.
 * Per questo le risposte lancio partono come UNA bolla (mai `splitMarioMessages`).
 */
export function contaScambiDomande(rows: RigaLancio[]): number {
  return rows.filter((m) =>
    m.direction === 'out' && m.template_sid == null && !!m.body && !TESTI_FISSI.has(m.body.trim()),
  ).length;
}

const eIlCongedo = (m: RigaLancio): boolean =>
  m.direction === 'out' && m.template_sid == null && (m.body ?? '').trim() === TESTO_CONGEDO;

/**
 * Il congedo e' gia' uscito su questa chat. Serve quando la fase NON e' stata portata a
 * `chiuso` perche' il CRM ha rifiutato il `DA_SCARTARE`: il turno dopo deve ritentare
 * l'esito senza mandare una seconda volta la stessa frase — e senza riclassificare, o un
 * "ok, va bene" scritto dopo il congedo gli bloccherebbe il posto a cui ha detto no.
 */
export function congedoGiaInviato(rows: RigaLancio[]): boolean {
  return rows.some(eIlCongedo);
}

/**
 * Il "lotto" di questo turno: TUTTO quello che il lead ha scritto dopo l'ultima bolla
 * nostra. Il drain passa un inbound solo (il primo rimasto senza risposta) e per un
 * periodo il turno classificava quello: bastava uno sticker, una foto o un "ok" prima
 * del messaggio vero perche' tutto il resto finisse nell'ombra — turno muto, con la
 * traccia `fenice_ai_reply` che impedisce anche il re-drive, e un "toglimi dalla lista"
 * che non arrivava mai al CRM.
 */
export function inboundDelLotto(rows: RigaLancio[]): RigaLancio[] {
  let ultimoOut = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i].direction === 'out') ultimoOut = i;
  return rows.slice(ultimoOut + 1).filter((m) => m.direction === 'in');
}

/**
 * Su cosa si classifica il lotto: l'ultimo messaggio del lead che abbia davvero del
 * testo. E' la sua posizione piu' recente — chi ha scritto "ok" e poi "no grazie" ha
 * detto no — e quelli prima restano comunque nella storia che legge il modello.
 * Vuoto = il lead non ha scritto niente di leggibile (solo media): il turno tace.
 */
export function ultimoTestoDelLotto(lotto: RigaLancio[]): string {
  for (let i = lotto.length - 1; i >= 0; i--) {
    const testo = (lotto[i].body ?? '').trim();
    if (testo !== '') return testo;
  }
  return '';
}

/**
 * Il congedo e' uscito su questa chat, letto dal marcatore durevole
 * `conversations.lancio_info.congedo_at` invece che dalla cronologia. Serve a chi la
 * cronologia non ce l'ha davanti: la riapertura del webhook (un lead congedato che
 * riscrive non torna a Mario) e i cron di B4/B5, che devono escludere queste righe dal
 * blast del link e dal follow-up.
 */
export function haCongedo(lancioInfo: unknown): boolean {
  if (!lancioInfo || typeof lancioInfo !== 'object' || Array.isArray(lancioInfo)) return false;
  const v = (lancioInfo as Record<string, unknown>).congedo_at;
  return typeof v === 'string' && v.trim() !== '';
}

/** Ogni quanto si riavvisa il CRM che un lead restituito sta scrivendo (ruling C8). */
export const NOTA_RESTITUZIONE_OGNI_MS = 60 * 60 * 1000;

/**
 * Va mandata al CRM la nota per questo inbound di un lead gia' restituito al pool?
 *
 * Una nota per ogni messaggio vorrebbe dire cinque campanelle per chi manda cinque
 * messaggi, e il testo cambia sempre (orario + parole del lead) quindi la divergenza
 * anti-collisione di `inviaNotaAlCrm` non le fonde. La finestra e' un'ora per chat, letta
 * dal marcatore durevole `conversations.lancio_info.restituito_nota_at` — l'evento
 * `lancio_inbound_dopo_restituzione` invece si scrive sempre, cosi' nei pannelli resta
 * tutto. Marcatore assente o illeggibile: si avvisa. Meglio una campanella in piu' che un
 * GDO che chiama a vuoto.
 */
export function serveNotaRestituzione(lancioInfo: unknown, nowMs: number): boolean {
  if (!lancioInfo || typeof lancioInfo !== 'object' || Array.isArray(lancioInfo)) return true;
  const v = (lancioInfo as Record<string, unknown>).restituito_nota_at;
  if (typeof v !== 'string') return true;
  const quando = Date.parse(v);
  if (Number.isNaN(quando)) return true;
  return nowMs - quando >= NOTA_RESTITUZIONE_OGNI_MS;
}

/**
 * Le parole con cui il lead si e' tirato indietro: l'ultimo messaggio suo PRIMA del
 * congedo. Su un esito ritentato sono quelle che devono arrivare al CRM — l'inbound del
 * turno corrente e' arrivato dopo il no e racconterebbe un'altra storia.
 */
export function paroleDelCongedo(rows: RigaLancio[]): string | null {
  const iCongedo = rows.findIndex(eIlCongedo);
  if (iCongedo < 0) return null;
  for (let i = iCongedo - 1; i >= 0; i--) {
    const testo = (rows[i].body ?? '').trim();
    if (rows[i].direction === 'in' && testo !== '') return testo;
  }
  return null;
}

/**
 * Le righe che appartengono a QUESTO lancio. Su una chat riusata (guardia anti-doppione
 * dell'intake) `ai_started_at` non viene azzerato di proposito, quindi il drain carica
 * anche il giro precedente di Mario: senza questo taglio la prima domanda del lead
 * risulterebbe la quarta (silenzio) e il modello del lancio si leggerebbe un fissaggio
 * del GDO come contesto. Si taglia dal benvenuto del lancio se c'e' (nessuna query), se
 * no dal pulsante del webinar, se no dall'istante dell'evento `lancio_intake`.
 *
 * Il pulsante (B2, spec §6.3) e' l'ancora di chi entra la sera della live senza essere
 * mai stato in lista: li' il benvenuto non c'e'. Sull'evento non ci si puo' appoggiare —
 * il webhook salva PRIMA il messaggio e POI arruola, quindi `lancio_intake.created_at` e'
 * successivo alla riga del pulsante e il taglio la butterebbe via: il lotto resterebbe
 * vuoto e il turno post-pitch spenderebbe una bolla senza cronologia. Si taglia
 * dall'ULTIMA pressione (INCLUSA): chi ripreme dopo giorni sta ricominciando da li'.
 */
export function tagliaRigheDalLancio(
  rows: RigaLancio[],
  welcomeSid: string | null | undefined,
  ingressoAt: string | null,
): RigaLancio[] {
  if (welcomeSid) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].template_sid === welcomeSid) return rows.slice(i);
    }
  }
  const pulsante = indiceUltimaPressionePulsante(rows);
  if (pulsante >= 0) return rows.slice(pulsante);
  if (ingressoAt) return rows.filter((m) => !m.created_at || nonPrimaDi(m.created_at, ingressoAt));
  return rows;
}

/**
 * L'indice dell'ULTIMA pressione del pulsante del webinar in queste righe, o -1.
 *
 * Una riga sola, ma e' la regola su cui si appoggiano due cose che devono dire la stessa
 * identica frase: il taglio della cronologia qui sopra e l'ancora del lancio
 * (`ancoraLancio`, lib/lancio-followup.ts) per le chat che nel lancio ci sono entrate
 * proprio col pulsante — dove il benvenuto non c'e' e l'evento `lancio_intake` e' scritto
 * DOPO la riga del pulsante (il webhook salva il messaggio e poi arruola). Tenerle
 * separate voleva dire che il taglio partiva dalla pressione e l'ancora no: quella
 * pressione non contava come interazione, e un lead che aveva alzato la mano risultava
 * "non ha mai scritto". L'ultima e non la prima: chi ripreme dopo giorni ricomincia da li'.
 */
export function indiceUltimaPressionePulsante(rows: RigaLancio[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].direction === 'in' && isMarkerPulsanteWebinar(rows[i].body)) return i;
  }
  return -1;
}

/**
 * `a` non viene prima di `b`, confrontati come ISTANTI e non come stringhe. Le righe
 * arrivano da `messages.created_at` e l'ancora da un'altra colonna (l'evento
 * `lancio_intake`): Postgres e i client le serializzano in modi che l'ordine alfabetico
 * sbaglia — `...Z` contro `...+00:00`, microsecondi contro millisecondi — e un taglio
 * sbagliato butta via la cronologia del lancio o si tira dietro il giro precedente di
 * Mario. Se una delle due non e' leggibile si torna al confronto lessicografico di prima:
 * meglio il comportamento storico che una riga persa. Il confine resta INCLUSIVO.
 */
function nonPrimaDi(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? a >= b : ta >= tb;
}

const FASE_LABEL: Record<LancioFase, string> = {
  attesa: 'In attesa',
  posto_bloccato: 'Posto bloccato',
  link_inviato: 'Link inviato',
  post_pitch: 'Dopo il pitch',
  scelta_fatta: 'Scelta fatta',
  followup_inviato: 'Follow-up inviato',
  restituito: 'Restituito',
  chiuso: 'Chiuso',
};

/** Etichetta per i badge dei pannelli. */
export function lancioFaseLabel(fase: string | null): string {
  return isLancioFase(fase) ? FASE_LABEL[fase] : 'Lancio';
}

/** Corpo del template 1 (spec §7, testo approvato da Bruno il 14/09) con {{1}} risolto:
 *  è quello che finisce nella riga `messages` per i pannelli. */
export function lancioBenvenutoText(name?: string | null): string {
  return (
    `Ciao ${templateName(name)}, sono l'assistente virtuale di Fenice Academy. Complimenti per esserti iscritto ` +
    "alla lista d'attesa dell'evento del 5 ottobre: ti invieremo il link per collegarti alla live " +
    'direttamente qui su WhatsApp il giorno stesso. Rispondi a questo messaggio se sei realmente ' +
    'interessato, per bloccare il posto.'
  );
}
