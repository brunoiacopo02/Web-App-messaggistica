/** Composizione del thread: separatori di giorno, blocchi di bolle, righe di sistema, finestra 24h.
 *  Funzioni pure, tutte sul calendario di Roma. */

export type Msg = {
  id: number;
  direction: 'in' | 'out';
  body: string;
  created_at: string;
  is_template: boolean;
  twilio_status: string | null;
  twilio_error_code: number | null;
  sender: string | null;
};

export type Gruppo =
  | { tipo: 'giorno'; etichetta: string }
  | { tipo: 'blocco'; lato: 'lead' | 'bot'; autore: string; messaggi: Msg[] };

/** Riga di `event_log` legata alla conversazione, come la restituisce `/api/console/chat/[id]`. */
export type Evento = { at: string; tipo: string; testo: string; livello: string };

export type Voce = Gruppo | { tipo: 'sistema'; evento: Evento };

/** Risposta di `GET /api/console/chat/[id]`. */
export type DettaglioChat = {
  conv: {
    id: number; aiOwner: string | null; aiStatus: string | null; aiPausedAt: string | null;
    botOutcome: string | null; botScheduledAt: string | null; lancioFase: string | null; lancioSlug: string | null;
    waNumber: string | null; crmLeadId: string | null; aiSummary: string | null; handedOffReason: string | null;
    lastInboundAt: string | null; mondo: 'GDO' | 'MARIO' | 'CAMPAGNA'; unreadCount: number;
    contesto: { testo: string; tono: 'urgente' | 'errore' | 'neutro' | 'onda' } | null;
  };
  lead: { id: number | null; nome: string | null; telefono: string | null };
  crm: { status: string | null; conferme_outcome: string | null; sales_outcome: string | null } | null;
  eventi: Evento[];
  /** `true` se la lettura degli eventi è scaduta o fallita: `eventi` è vuoto ma la chat è completa. */
  eventiParziali: boolean;
};

const FUSO = 'Europe/Rome';
const GIORNO_MS = 24 * 3600_000;

const fmtChiave = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: FUSO, weekday: 'long', day: 'numeric', month: 'long' });
const fmtGiornoAnno = new Intl.DateTimeFormat('it-IT', { timeZone: FUSO, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** `2026-10-05` del giorno di Roma. */
const chiaveGiorno = (d: Date) => fmtChiave.format(d);

/** Giorno di calendario `n` giorni dopo quello di `d` (a Roma), come chiave. */
function chiaveSpostata(d: Date, n: number): string {
  const [a, m, g] = chiaveGiorno(d).split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, g + n));
  return x.toISOString().slice(0, 10);
}

/** `HH:MM` a Roma. */
export function oraRoma(iso: string): string {
  return fmtOra.format(new Date(iso));
}

function etichettaGiorno(d: Date, now: Date): string {
  const k = chiaveGiorno(d);
  if (k === chiaveGiorno(now)) return 'Oggi';
  if (k === chiaveSpostata(now, -1)) return 'Ieri';
  return k.slice(0, 4) === chiaveGiorno(now).slice(0, 4) ? fmtGiorno.format(d) : fmtGiornoAnno.format(d);
}

/**
 * Chi ha scritto un messaggio in uscita, da `messages.sender`. Valori reali (produzione, 26/09/2026):
 * `bot` (Mario), `automazione` (cron, blast del lancio, invii da script), `operatore` (invio a mano
 * da /chat). `human` lo scrive `scripts/rispondi-a-mano.mjs`. `gdo:<n>` e le email non compaiono
 * oggi ma si leggono lo stesso, per non mostrare mai un valore grezzo.
 */
export function autoreDi(sender: string | null): string {
  const s = sender?.trim().toLowerCase() ?? '';
  if (s === '' || s === 'bot' || s === 'mario') return 'Mario';
  if (s === 'automazione') return 'Automazione';
  if (s === 'operatore' || s === 'human') return 'Operatore';
  const gdo = /^gdo\D*(\d+)/.exec(s);
  if (gdo) return `GDO ${gdo[1]}`;
  if (s.includes('@')) return sender!.trim().split('@')[0];
  return sender!.trim();
}

function componi(messaggi: readonly Msg[], eventi: readonly Evento[], now: Date): Voce[] {
  type Pezzo = { at: number; m?: Msg; e?: Evento };
  const pezzi: Pezzo[] = [
    ...messaggi.map((m) => ({ at: Date.parse(m.created_at), m })),
    ...eventi.map((e) => ({ at: Date.parse(e.at), e })),
  ];
  // A parità di istante il messaggio precede l'evento che lo racconta (es. "fermato dopo questa risposta").
  pezzi.sort((a, b) => a.at - b.at || (a.m ? 0 : 1) - (b.m ? 0 : 1));

  const out: Voce[] = [];
  let giorno: string | null = null;
  let blocco: Extract<Gruppo, { tipo: 'blocco' }> | null = null;
  for (const p of pezzi) {
    const d = new Date(p.at);
    const k = chiaveGiorno(d);
    if (k !== giorno) {
      giorno = k;
      blocco = null;
      out.push({ tipo: 'giorno', etichetta: etichettaGiorno(d, now) });
    }
    if (p.e) {
      blocco = null;
      out.push({ tipo: 'sistema', evento: p.e });
      continue;
    }
    const m = p.m!;
    const lato = m.direction === 'in' ? 'lead' : 'bot';
    const autore = lato === 'lead' ? 'Lead' : autoreDi(m.sender);
    if (blocco && blocco.lato === lato && blocco.autore === autore) {
      blocco.messaggi.push(m);
    } else {
      blocco = { tipo: 'blocco', lato, autore, messaggi: [m] };
      out.push(blocco);
    }
  }
  return out;
}

/** Separatori di giorno e blocchi di messaggi consecutivi dello stesso lato e dello stesso autore. */
export function raggruppa(messaggi: readonly Msg[], now: Date = new Date()): Gruppo[] {
  return componi(messaggi, [], now) as Gruppo[];
}

/** Rimette nel thread le righe di sistema al loro orario: un evento spezza il blocco in cui cade. */
export function intercala(gruppi: readonly Gruppo[], eventi: readonly Evento[], now: Date = new Date()): Voce[] {
  const messaggi = gruppi.flatMap((g) => (g.tipo === 'blocco' ? g.messaggi : []));
  return componi(messaggi, eventi, now);
}

/**
 * Finestra di servizio WhatsApp: 24 ore dall'ultimo messaggio del lead. Fuori finestra si scrive
 * solo con un template. `chiudeAlle`: `oggi HH:MM` o `domani HH:MM`, a Roma.
 */
export function finestra24h(lastInboundAt: string | null, now: Date): { aperta: boolean; chiudeAlle: string | null } {
  if (!lastInboundAt) return { aperta: false, chiudeAlle: null };
  const t = Date.parse(lastInboundAt);
  if (Number.isNaN(t)) return { aperta: false, chiudeAlle: null };
  const chiude = new Date(t + GIORNO_MS);
  if (chiude.getTime() <= now.getTime()) return { aperta: false, chiudeAlle: null };
  const k = chiaveGiorno(chiude);
  const quando = k === chiaveGiorno(now) ? 'oggi' : k === chiaveSpostata(now, 1) ? 'domani' : fmtGiorno.format(chiude);
  return { aperta: true, chiudeAlle: `${quando} ${fmtOra.format(chiude)}` };
}

/**
 * I tipi di `event_log` che diventano righe di sistema nel thread. Lista chiusa per forza: il filtro
 * `payload->>conversationId` non ha indice (salvo `fenice_ai_reply`) e su 30 giorni di event_log
 * (~700.000 righe) va in statement timeout; ristretto a questi tipi usa `event_log_type_idx` e sta
 * sotto il secondo (misurato il 26/09/2026). Fuori: `fenice_ai_reply` (una per risposta di Mario, è
 * già la bolla) e `bot_intake_persona_ricorrente` (ripete l'intake).
 */
export const TIPI_EVENTI_THREAD = [
  'bot_intake', 'lancio_intake', 'fenice_enroll', 'bot_outcome_sent', 'bot_outcome_locked', 'bot_outcome_rejected',
  'bot_note_sent', 'bot_fermo_stato_crm', 'bot_contatto_umano_inviato', 'bot_appuntamento_rifissato',
  'bot_paused', 'bot_resumed', 'stale_handed_off', 'cancel_requested', 'inbound_su_altro_numero',
  'lancio_fase_cambiata', 'lancio_posto_bloccato', 'lancio_domanda', 'lancio_apertura_inviata', 'lancio_silenzio',
  'lancio_congedo', 'lancio_ripresa_manuale', 'gdo_video_sent', 'gdo_video_followup_sent', 'video_watched',
  'gdo_agenda_sent', 'gdo_agenda_esito', 'recupero_nr_inviato', 'richiamo_restituito', 'appuntamento_registrato',
  'appuntamento_spostato', 'console_azione',
] as const;

/**
 * La frase italiana di una riga di sistema. Il `message` di `event_log` è un testo da log (prefissi
 * tra parentesi, inglese, id): non si mostra mai grezzo, se ne estrae solo il dato utile.
 * Tipo sconosciuto: `Evento di sistema`.
 */
export function testoEvento(type: string, message: string | null): string {
  const m = message ?? '';
  const iso = m.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g)?.at(-1) ?? null;
  const quando = dataOraBreve(iso ? (iso.endsWith('Z') ? iso : `${iso}Z`) : null);
  switch (type) {
    case 'bot_intake': return 'Lead preso in carico dal bot';
    case 'lancio_intake': return 'Lead entrato nel lancio';
    case 'fenice_enroll': return 'Lead arruolato da Mario';
    case 'bot_outcome_sent': {
      if (/RICHIAMO interim/i.test(m)) return 'Richiamo provvisorio inviato al CRM';
      const esito = leggibile(/esito ([A-Z_]+)/.exec(m)?.[1] ?? null);
      return esito ? `Esito ${esito} inviato al CRM` : 'Esito inviato al CRM';
    }
    case 'bot_outcome_locked': return 'Esito intercettato: il lead era già in appuntamento, nota al CRM';
    case 'bot_outcome_rejected': return "Il CRM ha rifiutato l'esito: chat chiusa in locale";
    case 'bot_note_sent': return 'Nota inviata al CRM';
    case 'bot_fermo_stato_crm': {
      const stato = leggibile(/il CRM dice ([A-Za-z_]+)/.exec(m)?.[1] ?? null);
      return stato ? `Bot fermo: il CRM dice ${stato}` : 'Bot fermo per lo stato del CRM';
    }
    case 'bot_contatto_umano_inviato': return 'Richiesta di contatto umano inviata';
    case 'bot_appuntamento_rifissato': return 'Appuntamento rifissato dal bot';
    case 'bot_paused': case 'bot_resumed': {
      const chi = /\sda (\S+)\s*$/.exec(m)?.[1];
      const base = type === 'bot_paused' ? 'Bot fermato' : 'Bot riattivato';
      return chi ? `${base} da ${chi}` : base;
    }
    case 'stale_handed_off': return 'Chat passata a persona da oltre 48 ore senza esito: serve chiusura manuale';
    case 'cancel_requested': return 'Il lead ha chiesto di annullare o spostare: automatismi spenti';
    case 'inbound_su_altro_numero': return 'Il lead ha risposto a un altro numero: la chat non si sposta';
    case 'lancio_fase_cambiata': {
      const fase = leggibile(/fase → (\S+)/.exec(m)?.[1] ?? null);
      return fase ? `Fase del lancio: ${fase.toLowerCase()}` : 'Fase del lancio aggiornata';
    }
    case 'lancio_posto_bloccato': return 'Posto bloccato per il lead';
    case 'lancio_domanda': {
      const d = /domanda (\d+)\/(\d+)/.exec(m);
      return d ? `Risposta a domanda ${d[1]} di ${d[2]}` : 'Risposta a una domanda del lead';
    }
    case 'lancio_apertura_inviata': return 'Messaggio di apertura inviato';
    case 'lancio_silenzio': return 'Il lead non ha risposto';
    case 'lancio_congedo': return 'Congedo inviato al lead';
    case 'lancio_ripresa_manuale': return 'Chat ripresa a mano';
    case 'gdo_video_sent': return 'Video inviato al lead';
    case 'gdo_video_followup_sent': return 'Sollecito sul video inviato';
    case 'video_watched': return 'Il lead conferma di aver visto il video';
    case 'gdo_agenda_sent': return 'Agenda del GDO inviata al lead';
    case 'gdo_agenda_esito': {
      const esito = /:\s*([a-z_]+)\s*$/.exec(m)?.[1]?.replace(/_/g, ' ');
      return esito ? `Esito invio agenda GDO: ${esito}` : 'Esito invio agenda GDO';
    }
    case 'recupero_nr_inviato': return 'Recupero per mancata risposta inviato';
    case 'richiamo_restituito': return 'Richiamo restituito ai GDO';
    case 'appuntamento_registrato': return quando ? `Appuntamento registrato per il ${quando}` : 'Appuntamento registrato';
    case 'appuntamento_spostato': return quando ? `Appuntamento spostato al ${quando}` : 'Appuntamento spostato';
    case 'console_azione': return 'Azione eseguita dalla console';
    default: return 'Evento di sistema';
  }
}

/** Il numero WhatsApp che parla col lead, per le ultime 4 cifre (`0047`, `3199`). */
export function numeroWa(waNumber: string | null): string | null {
  const cifre = (waNumber ?? '').replace(/\D/g, '');
  return cifre.length >= 4 ? cifre.slice(-4) : null;
}

/** `APPUNTAMENTO` → `Appuntamento`, `CONTATTO_UMANO` → `Contatto umano`. */
export function leggibile(codice: string | null): string | null {
  const t = (codice ?? '').trim().replace(/_/g, ' ').toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : null;
}

const fmtDataOra = new Intl.DateTimeFormat('it-IT', { timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** `24/09 17:00` a Roma; `null` se manca o non è una data. */
export function dataOraBreve(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : fmtDataOra.format(d).replace(',', '');
}

/** Fonde i messaggi riletti con quelli già in pagina: per id vince il più recente (lo stato di
 *  consegna cambia dopo l'invio), l'ordine resta per `created_at` e poi per id. */
export function fondiMessaggi(vecchi: readonly Msg[], nuovi: readonly Msg[]): Msg[] {
  if (nuovi.length === 0) return vecchi as Msg[];
  const perId = new Map(vecchi.map((m) => [m.id, m]));
  for (const m of nuovi) perId.set(m.id, m);
  return [...perId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
}

/** Quanti degli ultimi messaggi il polling rilegge comunque, per vederne cambiare lo stato di
 *  consegna (inviato → consegnato → letto, o fallito). */
export const RILETTI_IN_CODA = 20;

/** Il `dopo` del polling: l'id subito prima degli ultimi `RILETTI_IN_CODA` messaggi (0 = tutti). */
export function cursoreDopo(messaggi: readonly Msg[]): number {
  const i = messaggi.length - RILETTI_IN_CODA - 1;
  return i >= 0 ? messaggi[i].id : 0;
}
