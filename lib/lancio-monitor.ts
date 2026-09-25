import { LANCIO_FASI, haCongedo } from './lancio-fase';
import { tapPulsanteScelta, PULSANTE_CHIAMA_ORA, PULSANTE_FISSIAMO_DOMANI, PULSANTE_OGGI_POMERIGGIO, PULSANTE_DOMANI_MATTINA } from './lancio-pulsanti';
import { idoneoAlBlast, inFinestraBlast, finestraBlastChiusa } from './lancio-zoom-blast';
import type { LancioSettings } from './lancio-settings';
import { romeHour, romeMinute } from './rome-time';

/**
 * Monitor del lancio "Web Developer AI" (decisione PO 3 del 25/09/2026): la pagina
 * `/fenice/lancio` in sola lettura. Qui c'e' solo il calcolo — contatori, avvisi,
 * filtri della lista — su righe gia' lette: niente rete, niente DB, niente env.
 * La lettura sta in `lancio-monitor-db.ts`, e la stessa funzione che il test prova e'
 * quella che la rotta chiama.
 */

/** Da quando si leggono eventi e messaggi del lancio: il giorno della spec. Prima di
 *  qui una chat riusata ha solo storia di Mario, che al monitor non interessa. */
export const LANCIO_MONITOR_DA = '2026-09-14T00:00:00+02:00';

/** Una chat come la vede il monitor. `inizioAt === undefined` = la colonna
 *  `lancio_inizio_inviato_at` non esiste ancora nel DB (migration non applicata). */
export type ChatLancio = {
  id: number;
  nome: string | null;
  telefono: string | null;
  slug: string | null;
  fase: string | null;
  ingresso: string | null;
  benvenutoAt: string | null;
  linkAt: string | null;
  followupAt: string | null;
  inizioAt?: string | null;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  congedoAt: string | null;
  aiStatus: string | null;
};

export type EventoMonitor = {
  id: number;
  type: string;
  created_at: string;
  level: string;
  message: string | null;
  payload: Record<string, unknown> | null;
};

/** Un messaggio in uscita come serve alle consegne: niente testo. */
export type MessaggioConsegna = {
  conversation_id: number;
  created_at: string;
  template_sid: string | null;
  is_template: boolean;
  twilio_status: string | null;
  twilio_error_code: number | null;
};

// ─────────────────────────── utilita' ───────────────────────────

const ms = (iso: string | null | undefined): number => {
  if (!iso) return NaN;
  return Date.parse(iso);
};

/** Il `conversationId` di un evento, se c'e' ed e' un intero. */
export function convIdDi(e: Pick<EventoMonitor, 'payload'>): number | null {
  const v = e.payload?.conversationId;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Solo cifre: "+39 333-1234567" e "3331234567" si confrontano. */
export function soloCifre(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

export function eConsegnato(stato: string | null | undefined): boolean {
  return stato === 'delivered' || stato === 'read';
}

export function eFallito(stato: string | null | undefined): boolean {
  return stato === 'failed' || stato === 'undelivered';
}

/** Lo stato Twilio in parole: e' quello che si legge accanto all'ora. */
export function statoConsegnaLeggibile(stato: string | null | undefined): string {
  switch (stato) {
    case 'queued': case 'accepted': case 'scheduled': return 'in coda';
    case 'sending': return 'in invio';
    case 'sent': return 'inviato';
    case 'delivered': return 'consegnato';
    case 'read': return 'letto';
    case 'failed': return 'fallito';
    case 'undelivered': return 'non consegnato';
    case 'received': return 'ricevuto';
    case null: case undefined: case '': return 'senza stato';
    default: return stato;
  }
}

// ─────────────────────────── template ───────────────────────────

export type TipoTemplateLancio = 'benvenuto' | 'zoom' | 'inizio' | 'followup' | 'scelta';

/** I SID noti dalle env, per tipo. Sull'account del secondo numero i SID sono diversi:
 *  per questo c'e' anche il riconoscimento per orario (vedi `classificaTemplate`). */
export type SidLancio = Partial<Record<TipoTemplateLancio, readonly string[]>>;

/** Quanto un template puo' distare dal timbro della sua colonna ed esserne l'invio.
 *  I timbri si scrivono subito prima (o subito dopo) la chiamata a Twilio. */
const TOLLERANZA_TIMBRO_MS = 10 * 60 * 1000;

/**
 * Che messaggio del lancio e' questo template in uscita? Prima il SID (quando e' uno di
 * quelli delle env), poi la vicinanza al timbro della colonna corrispondente: e' cio' che
 * fa funzionare il conto anche sui template tradotti per il secondo account.
 */
export function classificaTemplate(
  m: Pick<MessaggioConsegna, 'created_at' | 'template_sid' | 'is_template'>,
  chat: Pick<ChatLancio, 'benvenutoAt' | 'linkAt' | 'followupAt' | 'inizioAt'> | undefined,
  sids: SidLancio,
): TipoTemplateLancio | null {
  if (!m.is_template && !m.template_sid) return null;
  if (m.template_sid) {
    for (const [tipo, lista] of Object.entries(sids) as [TipoTemplateLancio, readonly string[]][]) {
      if (lista?.includes(m.template_sid)) return tipo;
    }
  }
  if (!chat) return null;
  const t = ms(m.created_at);
  if (Number.isNaN(t)) return null;
  const vicini: [TipoTemplateLancio, string | null | undefined][] = [
    ['benvenuto', chat.benvenutoAt], ['zoom', chat.linkAt], ['inizio', chat.inizioAt], ['followup', chat.followupAt],
  ];
  let migliore: TipoTemplateLancio | null = null;
  let distanza = Infinity;
  for (const [tipo, iso] of vicini) {
    const d = Math.abs(t - ms(iso));
    if (d <= TOLLERANZA_TIMBRO_MS && d < distanza) { migliore = tipo; distanza = d; }
  }
  return migliore;
}

export type EsitoConsegne = { consegnati: number; falliti: number };

export type Consegne = {
  perTipo: Record<TipoTemplateLancio, EsitoConsegne>;
  /** Chat con almeno un messaggio del bot fallito o non consegnato dal 14/09. */
  problemi: Set<number>;
};

/**
 * Consegne per tipo di template: una chat conta UNA volta. Consegnata se almeno un
 * invio di quel tipo e' arrivato; fallita se ne e' fallito almeno uno e nessuno e'
 * arrivato (un benvenuto fallito e poi ripartito e' un benvenuto consegnato).
 */
export function calcolaConsegne(
  messaggi: readonly MessaggioConsegna[],
  chatPerId: ReadonlyMap<number, ChatLancio>,
  sids: SidLancio,
): Consegne {
  const tipi: TipoTemplateLancio[] = ['benvenuto', 'zoom', 'inizio', 'followup', 'scelta'];
  const ok = new Map<TipoTemplateLancio, Set<number>>(tipi.map((t) => [t, new Set()]));
  const ko = new Map<TipoTemplateLancio, Set<number>>(tipi.map((t) => [t, new Set()]));
  const problemi = new Set<number>();
  for (const m of messaggi) {
    if (eFallito(m.twilio_status)) problemi.add(m.conversation_id);
    const tipo = classificaTemplate(m, chatPerId.get(m.conversation_id), sids);
    if (!tipo) continue;
    if (eConsegnato(m.twilio_status)) ok.get(tipo)!.add(m.conversation_id);
    else if (eFallito(m.twilio_status)) ko.get(tipo)!.add(m.conversation_id);
  }
  const perTipo = {} as Record<TipoTemplateLancio, EsitoConsegne>;
  for (const t of tipi) {
    const consegnati = ok.get(t)!;
    let falliti = 0;
    for (const id of ko.get(t)!) if (!consegnati.has(id)) falliti++;
    perTipo[t] = { consegnati: consegnati.size, falliti };
  }
  return { perTipo, problemi };
}

// ─────────────────────────── contatori ───────────────────────────

export const SCELTE_PULSANTE = [
  PULSANTE_CHIAMA_ORA, PULSANTE_FISSIAMO_DOMANI, PULSANTE_OGGI_POMERIGGIO, PULSANTE_DOMANI_MATTINA,
] as const;

export type Contatori = {
  iscritti: number;
  perIngresso: Record<string, number>;
  perFase: Record<string, number>;
  benvenutiInviati: number;
  benvenutiConsegnati: number | null;
  /** Chat col benvenuto che hanno scritto almeno una volta DOPO il benvenuto. */
  risposte: number;
  postoBloccato: number;
  linkZoomInviati: number;
  linkZoomConsegnati: number | null;
  /** null = la colonna `lancio_inizio_inviato_at` non c'e' ancora. */
  messaggio21Inviati: number | null;
  messaggio21Consegnati: number | null;
  pulsantePremuto: number;
  /** Pulsante premuto su una chat che nessuno guidava (evento con `orfano`). */
  pulsanteOrfani: number;
  /** Tocchi sui pulsanti della scelta, una chat per titolo. */
  tocchi: Record<(typeof SCELTE_PULSANTE)[number], number>;
  scelteFatte: { totale: number; chiamaOra: number; prenota: number; giaPrenotato: number };
  congedi: number;
  restituiti: number;
};

/** Il titolo canonico di un tocco (fra i quattro), o null. */
function titoloTocco(raw: unknown): (typeof SCELTE_PULSANTE)[number] | null {
  if (typeof raw !== 'string' || !tapPulsanteScelta(raw)) return null;
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const t = norm(raw);
  return SCELTE_PULSANTE.find((p) => norm(p) === t) ?? null;
}

/**
 * I numeri della testata. `eventi` = gli eventi di conteggio dal 14/09
 * (`lancio_pulsante`, `lancio_posto_bloccato`, `lancio_scelta_pulsante_tap`,
 * `lancio_scelta`); `consegne` null = non ancora lette (si mostra "n/d", non zero).
 */
export function calcolaContatori(
  chats: readonly ChatLancio[],
  eventi: readonly EventoMonitor[],
  consegne: Consegne | null,
  colonnaInizio: boolean,
): Contatori {
  const delLancio = chats.filter((c) => c.slug);
  const perIngresso: Record<string, number> = {};
  const perFase: Record<string, number> = Object.fromEntries(LANCIO_FASI.map((f) => [f, 0]));
  let benvenutiInviati = 0, risposte = 0, linkZoomInviati = 0, inizio = 0, congedi = 0, restituiti = 0;
  const postoBloccato = new Set<number>();
  for (const c of delLancio) {
    const ing = c.ingresso ?? 'non indicato';
    perIngresso[ing] = (perIngresso[ing] ?? 0) + 1;
    const fase = c.fase ?? 'senza fase';
    perFase[fase] = (perFase[fase] ?? 0) + 1;
    if (c.benvenutoAt) {
      benvenutiInviati++;
      if (ms(c.lastInboundAt) > ms(c.benvenutoAt)) risposte++;
    }
    if (c.linkAt) linkZoomInviati++;
    if (c.inizioAt) inizio++;
    if (c.congedoAt) congedi++;
    if (c.fase === 'restituito') restituiti++;
    if (c.fase === 'posto_bloccato') postoBloccato.add(c.id);
  }

  const pulsante = new Set<number>();
  const orfani = new Set<number>();
  const tocchi = new Map<string, Set<number>>(SCELTE_PULSANTE.map((p) => [p, new Set<number>()]));
  const scelte = { chiama_ora: new Set<number>(), prenota: new Set<number>(), gia_prenotato: new Set<number>() };
  for (const e of eventi) {
    const id = convIdDi(e);
    if (id === null) continue;
    switch (e.type) {
      case 'lancio_pulsante':
        pulsante.add(id);
        if (e.payload?.orfano === true) orfani.add(id);
        break;
      case 'lancio_posto_bloccato':
        postoBloccato.add(id);
        break;
      case 'lancio_scelta_pulsante_tap': {
        const t = titoloTocco(e.payload?.titolo);
        if (t) tocchi.get(t)!.add(id);
        break;
      }
      case 'lancio_scelta': {
        const tipo = e.payload?.tipo;
        if (tipo === 'chiama_ora' || tipo === 'prenota' || tipo === 'gia_prenotato') scelte[tipo].add(id);
        break;
      }
    }
  }
  // Un orfano che poi e' stato preso in carico non e' piu' un orfano: conta chi e' oggi
  // fuori dal lancio.
  const nelLancio = new Set(delLancio.map((c) => c.id));
  let pulsanteOrfani = 0;
  for (const id of orfani) if (!nelLancio.has(id)) pulsanteOrfani++;

  const tutteLeScelte = new Set<number>([...scelte.chiama_ora, ...scelte.prenota, ...scelte.gia_prenotato]);
  return {
    iscritti: delLancio.length,
    perIngresso,
    perFase,
    benvenutiInviati,
    benvenutiConsegnati: consegne ? consegne.perTipo.benvenuto.consegnati : null,
    risposte,
    postoBloccato: postoBloccato.size,
    linkZoomInviati,
    linkZoomConsegnati: consegne ? consegne.perTipo.zoom.consegnati : null,
    messaggio21Inviati: colonnaInizio ? inizio : null,
    messaggio21Consegnati: colonnaInizio && consegne ? consegne.perTipo.inizio.consegnati : null,
    pulsantePremuto: pulsante.size,
    pulsanteOrfani,
    tocchi: Object.fromEntries([...tocchi].map(([k, v]) => [k, v.size])) as Contatori['tocchi'],
    scelteFatte: {
      totale: tutteLeScelte.size,
      chiamaOra: scelte.chiama_ora.size,
      prenota: scelte.prenota.size,
      giaPrenotato: scelte.gia_prenotato.size,
    },
    congedi,
    restituiti,
  };
}

// ─────────────────────────── avvisi ───────────────────────────

export type Gravita = 'critico' | 'attenzione' | 'info';

export type Avviso = {
  id: string;
  gravita: Gravita;
  titolo: string;
  significato: string;
  cosaFare: string;
  conteggio: number;
  /** Le chat coinvolte (le prime 50), per il link alla lista. */
  chat: number[];
  ultimoAt: string | null;
  /** Il link a /fenice/impostazioni quando la cura passa da li'. */
  impostazioni?: boolean;
};

export const CRON_LANCIO = ['aperture', 'zoom', 'inizio', 'followup', 'restituzioni'] as const;
export type CronLancio = (typeof CRON_LANCIO)[number];

export type InputAvvisi = {
  now: Date;
  settings: LancioSettings;
  chats: readonly ChatLancio[];
  /** Eventi di allarme delle ultime 24 ore (vedi `TIPI_EVENTI_AVVISO`). */
  eventi: readonly EventoMonitor[];
  /** `twilio_status` a livello warn (failed/undelivered) dell'ultima ora. */
  statiTwilio: readonly EventoMonitor[];
  /** L'ultimo `lancio_<cron>_run` di ogni cron, se c'e'. */
  ultimiRun: Partial<Record<CronLancio, EventoMonitor | null>>;
  colonnaInizio: boolean;
  /** Dopo quanti minuti un lead in `post_pitch` senza risposta diventa un avviso. */
  minutiSenzaRisposta?: number;
};

/** Gli eventi che il monitor legge per gli avvisi (ultime 24 ore). */
export const TIPI_EVENTI_AVVISO = [
  'lancio_zoom_freno', 'lancio_followup_freno', 'lancio_inizio_freno',
  'lancio_zoom_freno_non_applicato', 'lancio_followup_freno_non_applicato', 'lancio_inizio_freno_non_applicato',
  'lancio_zoom_config_error', 'lancio_aperture_config_error', 'lancio_followup_config_error',
  'lancio_restituzioni_config_error', 'lancio_inizio_config_error',
  'lancio_zoom_esito_incerto', 'lancio_followup_esito_incerto', 'lancio_inizio_esito_incerto',
  'lancio_scelta_pulsanti', 'lancio_pulsante',
  'bot_outcome_error', 'bot_outcome_rejected',
  'lancio_crm_errore', 'lancio_lead_senza_crm', 'lancio_restituzione_error', 'lancio_restituzione_rifiutata',
  'lancio_slots_vuoti', 'lancio_slots_non_letti',
  'lancio_evento_at_nel_passato', 'lancio_video_live_link_missing',
  'send_error',
] as const;

/** Gli eventi di conteggio della testata, dal 14/09. */
export const TIPI_EVENTI_CONTATORI = [
  'lancio_pulsante', 'lancio_posto_bloccato', 'lancio_scelta_pulsante_tap', 'lancio_scelta',
] as const;

const ORA = 60 * 60 * 1000;
const MINUTO = 60 * 1000;

const ETICHETTA_CRON: Record<string, string> = {
  zoom: 'blast del link Zoom',
  followup: 'follow-up del 6 ottobre',
  inizio: 'messaggio delle 21',
  aperture: 'benvenuto',
  restituzioni: 'restituzioni al CRM',
};

/** Il cron da un tipo `lancio_<cron>_...`. */
function cronDi(type: string): string {
  const m = /^lancio_([a-z]+)_/.exec(type);
  return m ? m[1] : type;
}

/** Il significato di un codice di errore Twilio/WhatsApp, e cosa farne. */
export function erroreTwilio(code: number | string): { gravita: Gravita; nome: string; significato: string; cosaFare: string } {
  const n = Number(code);
  switch (n) {
    case 63018:
      return {
        gravita: 'critico', nome: 'limite di invio del numero superato',
        significato: 'Il numero WhatsApp ha finito i messaggi che Meta gli concede. Da qui in avanti gli invii falliscono tutti, per tutti.',
        cosaFare: 'Il freno del blast dovrebbe essere già scattato. Non riaccendere il lancio finché il limite non si azzera; valutare il mittente secondario.',
      };
    case 63051:
      return {
        gravita: 'critico', nome: 'numero WhatsApp sospeso o bloccato',
        significato: 'Meta sta bloccando il numero mittente. Nessun messaggio parte.',
        cosaFare: 'Tenere il lancio spento, aprire la console Twilio/Meta e verificare lo stato del numero prima di qualunque altro invio.',
      };
    case 63016:
      return {
        gravita: 'attenzione', nome: 'messaggio libero fuori dalla finestra di 24 ore',
        significato: 'Il bot ha provato a scrivere testo libero a chi non gli scrive da più di 24 ore. Meta lo rifiuta: serve un template.',
        cosaFare: 'Aprire le chat coinvolte: se sono lead del lancio, il messaggio va rimandato con un template (o aspettare che il lead riscriva).',
      };
    case 63049:
      return {
        gravita: 'attenzione', nome: 'Meta ha trattenuto il template',
        significato: 'Meta non ha consegnato il template a quel destinatario (tetto di messaggi per persona). Non dice niente sulla salute del numero.',
        cosaFare: 'Niente da fare subito: il blast ritenta al run dopo. Se il numero cresce molto, restringere il perimetro a chi ha risposto.',
      };
    case 63024:
      return {
        gravita: 'info', nome: 'destinatario senza WhatsApp',
        significato: 'Il numero del lead non ha WhatsApp (o non è valido).',
        cosaFare: 'Nessuna azione sul bot: questi lead vanno ai GDO da chiamare, mai scartati come numero inesistente.',
      };
    default:
      return {
        gravita: 'attenzione', nome: `errore ${code}`,
        significato: 'Twilio ha rifiutato o non consegnato il messaggio con questo codice.',
        cosaFare: 'Cercare il codice nella documentazione Twilio e aprire le chat coinvolte per capire se riguarda un solo lead o il numero.',
      };
  }
}

const RANGO: Record<Gravita, number> = { critico: 0, attenzione: 1, info: 2 };

function ultimo(eventi: readonly EventoMonitor[]): string | null {
  let best: string | null = null;
  for (const e of eventi) if (!best || e.created_at > best) best = e.created_at;
  return best;
}

function chatDi(eventi: readonly EventoMonitor[], filtro?: (id: number) => boolean): number[] {
  const out = new Set<number>();
  for (const e of eventi) {
    const id = convIdDi(e);
    if (id !== null && (!filtro || filtro(id))) out.add(id);
  }
  return [...out].slice(0, 50);
}

/** Fra le 03:00 e le 08:30 il bot del post-pitch tace apposta (re-drive delle 08:30). */
export function silenzioNotturnoPostPitch(now: Date): boolean {
  const m = romeHour(now) * 60 + romeMinute(now);
  return m >= 3 * 60 && m < 8 * 60 + 30;
}

/**
 * Gli avvisi del lancio, dal piu' grave. Ognuno dice cosa e' successo, cosa vuol dire e
 * cosa fare. Solo calcolo: gli eventi arrivano gia' filtrati per finestra temporale dal
 * chiamante, qui si stringe ancora dove un avviso ha senso solo se recente.
 */
export function calcolaAvvisi(i: InputAvvisi): Avviso[] {
  const out: Avviso[] = [];
  const now = i.now.getTime();
  const recenti = (tipo: (t: string) => boolean, finestraMs: number) =>
    i.eventi.filter((e) => tipo(e.type) && now - ms(e.created_at) <= finestraMs);
  const nelLancio = new Set(i.chats.filter((c) => c.slug).map((c) => c.id));
  const eventoMs = ms(i.settings.eventoAt);
  const evento = Number.isNaN(eventoMs) ? null : new Date(eventoMs);

  // ── configurazione di base ──
  if (!evento) {
    out.push({
      id: 'evento_mancante', gravita: 'critico', conteggio: 1, chat: [], ultimoAt: null, impostazioni: true,
      titolo: 'Data dell’evento non impostata',
      significato: '`lancio_evento_at` è vuota o illeggibile: blast Zoom, messaggio delle 21 e follow-up non sanno quando partire e saltano.',
      cosaFare: 'Impostare data e ora del webinar in Impostazioni.',
    });
  }
  const nelPassato = recenti((t) => t === 'lancio_evento_at_nel_passato', 2 * ORA);
  if (nelPassato.length > 0) {
    out.push({
      id: 'evento_nel_passato', gravita: 'critico', conteggio: nelPassato.length, chat: [], ultimoAt: ultimo(nelPassato), impostazioni: true,
      titolo: 'La data dell’evento è rimasta indietro',
      significato: 'Un cron del lancio ha trovato `lancio_evento_at` nel passato rispetto alla sua finestra: esce "fuori finestra" senza mandare niente.',
      cosaFare: 'Controllare la data dell’evento in Impostazioni.',
    });
  }

  // ── freno ──
  const freni = recenti((t) => /^lancio_[a-z]+_freno$/.test(t), 24 * ORA);
  for (const [cron, lista] of raggruppa(freni, (e) => cronDi(e.type))) {
    const codici = [...new Set(lista.flatMap((e) => (Array.isArray(e.payload?.codici) ? (e.payload!.codici as unknown[]) : [])))];
    out.push({
      id: `freno_${cron}`, gravita: i.settings.attivo ? 'attenzione' : 'critico', conteggio: lista.length, chat: [], ultimoAt: ultimo(lista), impostazioni: true,
      titolo: `Freno automatico scattato sul ${ETICHETTA_CRON[cron] ?? cron}`,
      significato: `Troppi invii falliti (oltre il 10% su almeno 20) o un codice grave${codici.length ? ` (codici: ${codici.join(', ')})` : ''}: il run si è fermato e \`lancio_attivo\` è stato spento.${i.settings.attivo ? ' Il lancio risulta riacceso.' : ''}`,
      cosaFare: i.settings.attivo
        ? 'Verificare che la causa sia stata capita prima della riaccensione (vedi gli errori Twilio qui sotto).'
        : 'Capire la causa dagli errori Twilio (63018 = limite del numero, 63051 = numero sospeso), poi riaccendere a mano da Impostazioni.',
    });
  }
  const nonApplicati = recenti((t) => /_freno_non_applicato$/.test(t), 24 * ORA);
  if (nonApplicati.length > 0) {
    out.push({
      id: 'freno_non_applicato', gravita: 'critico', conteggio: nonApplicati.length, chat: [], ultimoAt: ultimo(nonApplicati), impostazioni: true,
      titolo: 'Il freno non è riuscito a spegnere il lancio',
      significato: 'Il freno è scattato ma la scrittura di `lancio_attivo = false` è fallita: i run successivi ripartono come se niente fosse.',
      cosaFare: 'Spegnere il lancio a mano da Impostazioni, subito.',
    });
  }
  if (!i.settings.attivo && freni.length === 0 && (!evento || now <= eventoMs + 48 * ORA)) {
    out.push({
      id: 'lancio_spento', gravita: 'critico', conteggio: 1, chat: [], ultimoAt: null, impostazioni: true,
      titolo: 'Il lancio è spento',
      significato: '`lancio_attivo` è falso: niente benvenuti, niente blast Zoom, niente messaggio delle 21. Gli iscritti entrano ma nessuno scrive loro.',
      cosaFare: 'Se non è voluto, riaccendere da Impostazioni.',
    });
  }

  // ── configurazione dei cron e run fermi ──
  const config = recenti((t) => /^lancio_[a-z]+_config_error$/.test(t), 2 * ORA);
  for (const [cron, lista] of raggruppa(config, (e) => cronDi(e.type))) {
    const mancanti = [...new Set(lista.flatMap((e) => (Array.isArray(e.payload?.missing) ? (e.payload!.missing as unknown[]).map(String) : [])))];
    const template = lista.some((e) => typeof e.payload?.templateSid === 'string');
    out.push({
      id: `config_${cron}`, gravita: 'critico', conteggio: lista.length, chat: chatDi(lista), ultimoAt: ultimo(lista), impostazioni: mancanti.some((m) => m.startsWith('lancio_')),
      titolo: template
        ? `Template bloccato sul ${ETICHETTA_CRON[cron] ?? cron}`
        : `Configurazione mancante per il ${ETICHETTA_CRON[cron] ?? cron}`,
      significato: template
        ? 'Twilio o Meta hanno rifiutato il template (categoria bloccata o non verificabile): il run si è fermato.'
        : `Il run è saltato perché manca: ${mancanti.join(', ') || 'un parametro'}.`,
      cosaFare: template
        ? 'Controllare lo stato del template nella console Twilio (approvazione e categoria) prima del prossimo run.'
        : 'Le chiavi `lancio_*` si impostano da Impostazioni; le variabili `*_SID` e i numeri stanno nelle env di Vercel.',
    });
  }
  for (const cron of CRON_LANCIO) {
    const run = i.ultimiRun[cron];
    if (!run || now - ms(run.created_at) > 2 * ORA) continue;
    const fermo = run.payload?.fermo;
    if (fermo === 'template_bloccato' || fermo === 'benvenuto_non_componibile' || fermo === 'tetto_non_leggibile') {
      out.push({
        id: `run_fermo_${cron}`, gravita: fermo === 'tetto_non_leggibile' ? 'attenzione' : 'critico', conteggio: 1, chat: [], ultimoAt: run.created_at,
        titolo: `Il ${ETICHETTA_CRON[cron]} si è fermato: ${String(fermo).replace(/_/g, ' ')}`,
        significato: fermo === 'template_bloccato'
          ? 'Il template è stato rifiutato come non spedibile: nessun altro invio in quel run.'
          : fermo === 'tetto_non_leggibile'
            ? 'Il cron non ha potuto contare gli invii dell’ultima ora e per prudenza non ha mandato niente.'
            : 'Il testo del benvenuto non si è potuto comporre: nessun benvenuto parte.',
        cosaFare: 'Leggere il messaggio dell’ultimo run in event_log e correggere prima del prossimo giro (ogni 15 minuti).',
      });
    }
  }

  // ── blast Zoom ──
  if (evento) {
    const runZoom = i.ultimiRun.zoom;
    if (inFinestraBlast(i.now, evento) && (!runZoom || now - ms(runZoom.created_at) > 11 * MINUTO)) {
      out.push({
        id: 'zoom_cron_fermo', gravita: 'critico', conteggio: 1, chat: [], ultimoAt: runZoom?.created_at ?? null,
        titolo: 'Il blast del link Zoom non sta girando',
        significato: 'Siamo nella finestra del blast ma l’ultimo run è di oltre 10 minuti fa (dovrebbe girare ogni 5).',
        cosaFare: 'Controllare i cron su Vercel (lancio-zoom) e i log della funzione.',
      });
    }
    if (finestraBlastChiusa(i.now, evento) || (now > eventoMs && now - eventoMs < 24 * ORA)) {
      const residui = i.chats.filter((c) => c.slug && !c.linkAt && idoneoAlBlast(
        { lancio_fase: c.fase, lancio_info: c.congedoAt ? { congedo_at: c.congedoAt } : null, last_inbound_at: c.lastInboundAt },
        i.settings.blastPerimetro,
      ));
      if (residui.length > 0) {
        out.push({
          id: 'zoom_residui', gravita: 'critico', conteggio: residui.length, chat: residui.slice(0, 50).map((c) => c.id), ultimoAt: runZoom?.created_at ?? null,
          titolo: 'Iscritti rimasti senza link Zoom',
          significato: 'La finestra del blast è chiusa e questi iscritti (in attesa o col posto bloccato, non congedati) non hanno il link.',
          cosaFare: 'Guardare l’ultimo run del blast (fermo? freno? tempo?) e decidere se mandare il link a mano dalle chat.',
        });
      }
      const incerti = Number(runZoom?.payload?.incerti ?? 0);
      if (incerti > 0) {
        out.push({
          id: 'zoom_incerti', gravita: 'attenzione', conteggio: incerti, chat: [], ultimoAt: runZoom?.created_at ?? null,
          titolo: 'Link Zoom dall’esito incerto',
          significato: 'Per questi invii il timbro c’è ma Twilio non ha risposto in modo chiaro: il link potrebbe non essere arrivato.',
          cosaFare: 'Controllare a mano le chat con fase ancora "attesa" o "posto bloccato" e link timbrato.',
        });
      }
    }
  }
  const incertiEv = recenti((t) => /_esito_incerto$/.test(t), 24 * ORA);
  if (incertiEv.length > 0) {
    out.push({
      id: 'esito_incerto', gravita: 'attenzione', conteggio: incertiEv.length, chat: chatDi(incertiEv), ultimoAt: ultimo(incertiEv),
      titolo: 'Invii dall’esito incerto',
      significato: 'Twilio ha dato un errore dopo l’invio: non si sa se il messaggio sia partito. Il timbro resta per non mandarlo due volte.',
      cosaFare: 'Aprire le chat e verificare lo stato del messaggio.',
    });
  }

  // ── messaggio delle 21 ──
  if (!i.colonnaInizio && evento && eventoMs - now < 3 * 24 * ORA && now < eventoMs + 2 * ORA) {
    out.push({
      id: 'inizio_colonna', gravita: 'attenzione', conteggio: 1, chat: [], ultimoAt: null,
      titolo: 'Messaggio delle 21 non ancora installato',
      significato: 'La colonna `lancio_inizio_inviato_at` non esiste nel DB: la migration del messaggio "si inizia" non è stata applicata, e il monitor non può contarlo.',
      cosaFare: 'Applicare la migration 20260925000001 prima del deploy del cron lancio-inizio.',
    });
  }
  const runInizio = i.ultimiRun.inizio;
  if (evento && runInizio && now > eventoMs + 30 * MINUTO && now < eventoMs + 6 * ORA) {
    const rimanenti = Number(runInizio.payload?.rimanenti ?? 0);
    if (rimanenti > 0) {
      out.push({
        id: 'inizio_rimanenti', gravita: 'attenzione', conteggio: rimanenti, chat: [], ultimoAt: runInizio.created_at,
        titolo: 'Messaggio delle 21 non arrivato a tutti',
        significato: 'Alla chiusura della finestra (21:30) restavano destinatari non serviti.',
        cosaFare: 'Guardare l’ultimo run (fermo? freno?): a live iniziata il messaggio non ha più senso, non va recuperato.',
      });
    }
  }

  // ── pulsante e post-pitch ──
  if (evento && now >= eventoMs + 10 * MINUTO && now < eventoMs + 6 * ORA && !i.settings.pulsanteAttivo) {
    out.push({
      id: 'pulsante_spento', gravita: 'critico', conteggio: 1, chat: [], ultimoAt: null, impostazioni: true,
      titolo: 'Il pulsante del webinar è ancora spento',
      significato: 'Sono passate le 21:10 e `lancio_pulsante_attivo` è falso: chi preme il pulsante durante la live viene trattato come un messaggio qualunque, senza pitch né scelta.',
      cosaFare: 'Accendere il pulsante da Impostazioni.',
    });
  }
  const orfani = recenti((t) => t === 'lancio_pulsante', 24 * ORA).filter((e) => e.payload?.orfano === true);
  const orfaniVeri = orfani.filter((e) => { const id = convIdDi(e); return id === null || !nelLancio.has(id); });
  if (orfaniVeri.length > 0) {
    const motivi = contaPer(orfaniVeri, (e) => String(e.payload?.motivo ?? 'sconosciuto'));
    out.push({
      id: 'pulsante_orfano', gravita: 'attenzione', conteggio: orfaniVeri.length, chat: chatDi(orfaniVeri), ultimoAt: ultimo(orfaniVeri),
      titolo: 'Pulsante premuto su chat che nessuno guida',
      significato: `Il lead ha premuto il pulsante ma la chat non era governata dal bot (${[...motivi].map(([m, n]) => `${m.replace(/_/g, ' ')}: ${n}`).join(', ')}): nessun pitch parte.`,
      cosaFare: 'Se il motivo è "pulsante spento" o "bot spento", accendere; se la chat è in mano a una persona, rispondere da lì.',
    });
  }
  const testo = recenti((t) => t === 'lancio_scelta_pulsanti', 24 * ORA).filter((e) => e.payload?.inviato === false);
  if (testo.length > 0) {
    const motivi = [...contaPer(testo, (e) => String(e.payload?.motivo ?? 'sconosciuto'))].map(([m, n]) => `${m} (${n})`).join(', ');
    out.push({
      id: 'pulsanti_testo', gravita: 'attenzione', conteggio: testo.length, chat: chatDi(testo), ultimoAt: ultimo(testo),
      titolo: 'La scelta è partita come testo, senza pulsanti',
      significato: `Il template a pulsanti non è partito e la domanda è uscita come messaggio scritto. Il lead deve rispondere a parole. Motivo: ${motivi}.`,
      cosaFare: 'Se succede a tutti, controllare i SID `LANCIO_SCELTA_NOTTE/GIORNO_TEMPLATE_SID` e l’approvazione dei template.',
    });
  }
  const soglia = (i.minutiSenzaRisposta ?? 5) * MINUTO;
  if (!silenzioNotturnoPostPitch(i.now)) {
    const muti = i.chats.filter((c) => {
      if (c.fase !== 'post_pitch') return false;
      const inbound = ms(c.lastInboundAt);
      if (Number.isNaN(inbound)) return false;
      const ultimoMsg = ms(c.lastMessageAt);
      // L'ultimo messaggio della chat e' del lead (tolleranza di 1s sull'orologio del DB).
      const ultimoEDelLead = Number.isNaN(ultimoMsg) || inbound >= ultimoMsg - 1000;
      return ultimoEDelLead && now - inbound > soglia;
    });
    if (muti.length > 0) {
      out.push({
        id: 'post_pitch_muti', gravita: muti.length >= 10 ? 'critico' : 'attenzione', conteggio: muti.length,
        chat: muti.slice(0, 50).map((c) => c.id), ultimoAt: null,
        titolo: `Lead dopo il pitch senza risposta da oltre ${i.minutiSenzaRisposta ?? 5} minuti`,
        significato: 'In queste chat l’ultimo messaggio è del lead e il bot non ha ancora risposto. Stasera è il momento in cui la risposta vale di più.',
        cosaFare: 'Aprire le chat: se sono tante insieme, controllare che l’auto-risposta sia accesa e i log di fenice_ai_error.',
      });
    }
  }

  // ── Twilio, ultima ora ──
  const perCodice = new Map<string, { eventi: EventoMonitor[]; chat: Set<number> }>();
  const chatPerTelefono = new Map<string, number>();
  for (const c of i.chats) { const d = soloCifre(c.telefono); if (d) chatPerTelefono.set(d, c.id); }
  const aggiungi = (code: unknown, e: EventoMonitor, id: number | null) => {
    if (code === undefined || code === null || code === '') return;
    const k = String(code);
    const g = perCodice.get(k) ?? { eventi: [], chat: new Set<number>() };
    g.eventi.push(e);
    if (id !== null) g.chat.add(id);
    perCodice.set(k, g);
  };
  for (const e of i.statiTwilio) {
    if (now - ms(e.created_at) > ORA) continue;
    const id = chatPerTelefono.get(soloCifre(String(e.payload?.To ?? ''))) ?? null;
    aggiungi(e.payload?.ErrorCode, e, id);
  }
  for (const e of recenti((t) => t === 'send_error', ORA)) aggiungi(e.payload?.code, e, convIdDi(e));
  for (const [code, g] of perCodice) {
    const info = erroreTwilio(code);
    out.push({
      id: `twilio_${code}`, gravita: info.gravita, conteggio: g.eventi.length, chat: [...g.chat].slice(0, 50), ultimoAt: ultimo(g.eventi),
      titolo: `Twilio ${code}: ${info.nome} (${g.eventi.length} nell’ultima ora)`,
      significato: info.significato, cosaFare: info.cosaFare,
    });
  }

  // ── CRM ──
  const crm = recenti((t) => ['bot_outcome_error', 'bot_outcome_rejected', 'lancio_crm_errore', 'lancio_lead_senza_crm',
    'lancio_restituzione_error', 'lancio_restituzione_rifiutata'].includes(t), 24 * ORA)
    .filter((e) => e.type.startsWith('lancio_') || (convIdDi(e) !== null && nelLancio.has(convIdDi(e)!)));
  if (crm.length > 0) {
    const tipi = [...contaPer(crm, (e) => e.type)].map(([t, n]) => `${t} ${n}`).join(', ');
    out.push({
      id: 'crm', gravita: 'attenzione', conteggio: crm.length, chat: chatDi(crm), ultimoAt: ultimo(crm),
      titolo: 'Errori verso il CRM su chat del lancio',
      significato: `Il bot non è riuscito a passare al CRM un esito, una prenotazione o una restituzione (${tipi}). Il lead può restare senza venditore o senza GDO.`,
      cosaFare: 'Aprire le chat e controllare nel CRM che il lead abbia l’appuntamento o sia tornato in pool; se gli errori sono tanti, verificare che il CRM risponda.',
    });
  }

  // ── turni venditori ──
  const vuoti = recenti((t) => t === 'lancio_slots_vuoti', 2 * ORA);
  if (vuoti.length > 0) {
    out.push({
      id: 'slot_vuoti', gravita: 'attenzione', conteggio: vuoti.length, chat: chatDi(vuoti), ultimoAt: ultimo(vuoti),
      titolo: 'Nessuna ora libera da proporre: turni venditori mancanti?',
      significato: 'Il CRM non ha restituito ore libere nei due giorni proposti: al lead non si può fissare niente e parte solo una nota al CRM.',
      cosaFare: 'Controllare nel CRM il calendario dei venditori per domani e dopodomani.',
    });
  }
  const nonLetti = recenti((t) => t === 'lancio_slots_non_letti', 2 * ORA);
  if (nonLetti.length > 0) {
    out.push({
      id: 'slot_non_letti', gravita: 'attenzione', conteggio: nonLetti.length, chat: chatDi(nonLetti), ultimoAt: ultimo(nonLetti),
      titolo: 'Il CRM non risponde sulle ore libere',
      significato: 'La lettura delle ore dal CRM è fallita: il bot propone fasce generiche (pomeriggio, dopodomani) invece delle ore vere.',
      cosaFare: 'Verificare che il CRM sia raggiungibile e che l’endpoint degli slot risponda.',
    });
  }

  // ── dopo la live ──
  const videoMancante = recenti((t) => t === 'lancio_video_live_link_missing', 24 * ORA);
  if (!i.settings.videoLiveLink && ((evento && now > eventoMs + 2 * ORA) || videoMancante.length > 0)) {
    out.push({
      id: 'video_live', gravita: 'attenzione', conteggio: Math.max(1, videoMancante.length), chat: chatDi(videoMancante), ultimoAt: ultimo(videoMancante),
      impostazioni: true,
      titolo: 'Link del video della live vuoto',
      significato: 'La live è finita ma `lancio_video_live_link` non è impostato: chi arriva dopo (link "Sviluppatore AI", follow-up) riceve risposte senza il video.',
      cosaFare: 'Incollare il link della registrazione in Impostazioni appena è pronto.',
    });
  }

  return out.sort((a, b) => RANGO[a.gravita] - RANGO[b.gravita] || b.conteggio - a.conteggio);
}

function raggruppa<T>(xs: readonly T[], chiave: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = chiave(x); const l = m.get(k); if (l) l.push(x); else m.set(k, [x]); }
  return m;
}

function contaPer<T>(xs: readonly T[], chiave: (x: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) { const k = chiave(x); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

// ─────────────────────────── lista ───────────────────────────

export type FiltriChat = {
  /** Una fase di `LANCIO_FASI`, 'congedo', 'fuori_lancio' o null (tutte). */
  fase: string | null;
  pulsante: boolean;
  problemi: boolean;
  q: string;
  /** Chat da mostrare comunque (i link degli avvisi), in aggiunta ai filtri: se
   *  valorizzato la lista e' SOLO queste. */
  ids?: readonly number[] | null;
  pagina: number;
};

export const PER_PAGINA = 50;

export function leggiFiltri(sp: URLSearchParams): FiltriChat {
  const pagina = Math.max(1, Math.floor(Number(sp.get('pagina') ?? '1')) || 1);
  const ids = (sp.get('ids') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
  const fase = sp.get('fase');
  return {
    fase: fase && fase !== 'tutte' ? fase : null,
    pulsante: sp.get('pulsante') === '1',
    problemi: sp.get('problemi') === '1',
    q: (sp.get('q') ?? '').trim().slice(0, 80),
    ids: ids.length ? ids : null,
    pagina,
  };
}

/** La lista filtrata e ordinata (ultimo messaggio in cima), gia' tagliata alla pagina. */
export function filtraChat(
  chats: readonly ChatLancio[],
  f: FiltriChat,
  segnali: { pulsante: ReadonlySet<number>; problemi: ReadonlySet<number> },
): { righe: ChatLancio[]; totale: number } {
  const q = f.q.toLowerCase();
  const cifre = soloCifre(f.q);
  const ids = f.ids ? new Set(f.ids) : null;
  const filtrate = chats.filter((c) => {
    if (ids) return ids.has(c.id);
    if (f.fase === 'fuori_lancio') { if (c.slug) return false; }
    else if (f.fase === 'congedo') { if (!c.congedoAt) return false; }
    else if (f.fase && c.fase !== f.fase) return false;
    if (f.pulsante && !segnali.pulsante.has(c.id)) return false;
    if (f.problemi && !segnali.problemi.has(c.id)) return false;
    if (q) {
      const perNome = (c.nome ?? '').toLowerCase().includes(q);
      const perTelefono = cifre.length >= 3 && soloCifre(c.telefono).includes(cifre);
      const perId = /^\d+$/.test(q) && String(c.id) === q;
      if (!perNome && !perTelefono && !perId) return false;
    }
    return true;
  });
  filtrate.sort((a, b) => (ms(b.lastMessageAt) || 0) - (ms(a.lastMessageAt) || 0) || b.id - a.id);
  const da = (f.pagina - 1) * PER_PAGINA;
  return { righe: filtrate.slice(da, da + PER_PAGINA), totale: filtrate.length };
}

/** La chat e' congedata? Legge sia la colonna estratta sia `lancio_info` intero. */
export function congedoDi(raw: { congedo_at?: unknown; lancio_info?: unknown }): string | null {
  if (typeof raw.congedo_at === 'string' && raw.congedo_at.trim() !== '') return raw.congedo_at;
  if (haCongedo(raw.lancio_info)) return String((raw.lancio_info as Record<string, unknown>).congedo_at);
  return null;
}
