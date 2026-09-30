import { convIdDi, type Avviso, type EventoMonitor, type Gravita } from '@/lib/lancio-monitor';
import { ID_CRON, type IdAzione, type IdCron } from './azioni-tipi';

export type AreaAvviso = 'lancio' | 'crm' | 'twilio' | 'cron' | 'bot' | 'gdo';
export type AzioneRef = { azione: IdAzione; params: Record<string, unknown>; etichetta: string };
export type AvvisoConsole = Avviso & { area: AreaAvviso; azioni: AzioneRef[]; primoAt: string | null; firma: string };

type TipoSistema = { area: AreaAvviso; gravita: Gravita; titolo: string; significato: string; cosaFare: string };

/** Gli eventi di `event_log` (ultime 24 h) che la Console mostra come avvisi di sistema. */
export const TIPI_SISTEMA: Record<string, TipoSistema> = {
  stale_booked_no_outcome: {
    area: 'crm', gravita: 'critico',
    titolo: 'Appuntamento del bot fermo senza esito',
    significato: "Il bot ha fissato un appuntamento ma l'esito non è mai stato registrato.",
    cosaFare: "Usa \"Rinvia l'esito\" su ogni chat: se l'appuntamento è reale, il CRM lo riceve di nuovo.",
  },
  booked_without_outcome: {
    area: 'crm', gravita: 'critico',
    titolo: 'Appuntamento del bot mai arrivato al CRM',
    significato: "Il bot ha fissato un appuntamento con il lead, ma l'esito non è stato consegnato al CRM.",
    cosaFare: "Usa \"Rinvia l'esito\" su ogni chat. Se resta in errore, apri la chat e controlla la risposta del CRM.",
  },
  bot_outcome_senza_leadid: {
    area: 'crm', gravita: 'attenzione',
    titolo: 'Esito del bot senza lead collegato',
    significato: 'Il bot ha prodotto un esito ma la chat non ha un lead del CRM a cui associarlo.',
    cosaFare: "Apri la chat e verifica il collegamento al lead; senza lead l'esito non può arrivare al CRM.",
  },
  contatto_umano_non_segnalato: {
    area: 'crm', gravita: 'critico',
    titolo: 'Richiesta di un umano non segnalata',
    significato: 'Il lead ha chiesto di parlare con una persona, ma il CRM non ne è stato avvisato.',
    cosaFare: 'Apri la chat, rispondi al lead e controlla la coda delle richieste di contatto umano.',
  },
  handed_off_non_registrato: {
    area: 'crm', gravita: 'attenzione',
    titolo: 'Passaggio a persona non registrato',
    significato: 'La chat è passata a una persona ma il passaggio non risulta registrato nel CRM.',
    cosaFare: 'Apri la chat e controlla a chi risulta assegnata; se serve, riassegnala dal CRM.',
  },
  lead_entrante_push_error: {
    area: 'crm', gravita: 'attenzione',
    titolo: 'Lead entrante non inviato al CRM',
    significato: "Una persona ha scritto per prima, ma l'invio del suo contatto al CRM è fallito.",
    cosaFare: 'Apri la chat: il lead resta qui. Ripeti l\'invio o inseriscilo a mano nel CRM.',
  },
  fenice_ai_error: {
    area: 'bot', gravita: 'critico',
    titolo: 'Mario non è riuscito a rispondere',
    significato: 'Mario ha ricevuto un messaggio ma la generazione della risposta è fallita.',
    cosaFare: 'Apri le chat elencate e rispondi tu. Se succede su molte chat, controlla il servizio AI e le chiavi.',
  },
  fenice_ai_claim_error: {
    area: 'bot', gravita: 'attenzione',
    titolo: 'Mario non ha preso in carico una chat',
    significato: 'Il sistema non è riuscito a riservare la chat a Mario prima di rispondere.',
    cosaFare: 'Di solito si risolve da solo al messaggio successivo. Se la chat resta ferma, rispondi tu.',
  },
  invio_template_fallito: {
    area: 'bot', gravita: 'attenzione',
    titolo: 'Invio del template fallito',
    significato: 'Un messaggio a template non è partito verso il lead.',
    cosaFare: "Apri la chat e leggi il motivo dell'errore: numero non valido, template non approvato o limite raggiunto.",
  },
  sequence_touch_error: {
    area: 'bot', gravita: 'info',
    titolo: 'Errore in un tocco di follow-up',
    significato: 'Un tocco della sequenza di follow-up non è stato eseguito.',
    cosaFare: 'Nessuna azione urgente: i tocchi sono sospesi. Guarda le chat elencate solo se il numero cresce.',
  },
  gdo_agenda_error: {
    area: 'gdo', gravita: 'critico',
    titolo: 'Agenda del GDO non partita',
    significato: "Il lead ha un appuntamento con il GDO, ma il messaggio con l'agenda non è stato inviato.",
    cosaFare: "Apri le chat elencate e scrivi tu al lead con giorno e ora dell'appuntamento.",
  },
  gdo_followup_error: {
    area: 'gdo', gravita: 'attenzione',
    titolo: 'Sollecito del GDO non inviato',
    significato: "Un promemoria legato all'appuntamento del GDO non è partito.",
    cosaFare: "Apri la chat e, se l'appuntamento è vicino, ricorda tu il lead.",
  },
};

export const CRON_SISTEMA: { cron: IdCron; tipoEvento: string; periodoMin: number; attivo: (now: Date) => boolean }[] = [
  // Unico cron di sistema con un evento di giro oltre a quelli del lancio (coperti da `run_fermo_*`).
  // `sequence_run` escluso: i tocchi sono sospesi.
  { cron: 'bot-followups', tipoEvento: 'bot_followups_run', periodoMin: 60, attivo: () => true },
];

const ORDINE: Record<Gravita, number> = { critico: 0, attenzione: 1, info: 2 };
const MAX_CHAT_AZIONI = 20;

// Niente conteggio: e' calcolato su una finestra mobile di 24 ore e scende da solo,
// e riaprirebbe avvisi risolti senza eventi nuovi. Cambia solo se arriva un evento nuovo.
export function firmaAvviso(a: Pick<Avviso, 'id' | 'ultimoAt'>): string {
  return `${a.id}:${a.ultimoAt}`;
}

export function areaDi(a: Avviso): AreaAvviso {
  if (a.id.startsWith('twilio_')) return 'twilio';
  if (a.id === 'crm') return 'crm';
  if (a.id.startsWith('run_fermo_') || a.id === 'zoom_cron_fermo') return 'cron';
  return 'lancio';
}

function rilancia(cron: string): AzioneRef[] {
  // Un cron fuori da ID_CRON non e' rilanciabile: niente bottone invece di un bottone che fallisce.
  if (!(ID_CRON as readonly string[]).includes(cron)) return [];
  return [{ azione: 'rilancia_cron', params: { cron }, etichetta: 'Rilancia ora' }];
}

export function azioniPer(a: Avviso): AzioneRef[] {
  if (a.id.startsWith('run_fermo_')) return rilancia(`lancio-${a.id.slice('run_fermo_'.length)}`);
  if (a.id === 'zoom_cron_fermo' || a.id === 'zoom_residui') return rilancia('lancio-zoom');
  if (a.id === 'lancio_spento') {
    return [{ azione: 'interruttore', params: { chiave: 'lancio_attivo', valore: true }, etichetta: 'Riaccendi il lancio' }];
  }
  if (a.id === 'pulsante_spento') {
    return [{ azione: 'interruttore', params: { chiave: 'lancio_pulsante_attivo', valore: true }, etichetta: 'Riaccendi il pulsante' }];
  }
  if (a.id === 'crm') return [{ azione: 'rinvia_esiti_403', params: {}, etichetta: 'Rinvia gli esiti rifiutati' }];
  if (a.id === 'stale_booked_no_outcome' || a.id === 'booked_without_outcome') {
    return a.chat.slice(0, MAX_CHAT_AZIONI).map((conversationId) => ({
      azione: 'rinvia_esito' as const,
      params: { conversationId },
      etichetta: `Rinvia l'esito della chat ${conversationId}`,
    }));
  }
  return [];
}

function conFirma(a: Avviso, extra: { area: AreaAvviso; azioni: AzioneRef[]; primoAt: string | null }): AvvisoConsole {
  return { ...a, ...extra, firma: firmaAvviso(a) };
}

export function avvisiSistema(
  eventi: readonly EventoMonitor[],
  ultimiRun: Record<string, string | null>,
  now: Date,
): AvvisoConsole[] {
  const gruppi = new Map<string, EventoMonitor[]>();
  for (const e of eventi) {
    if (!TIPI_SISTEMA[e.type]) continue;
    const g = gruppi.get(e.type);
    if (g) g.push(e);
    else gruppi.set(e.type, [e]);
  }

  const out: AvvisoConsole[] = [];
  for (const [tipo, evs] of gruppi) {
    const d = TIPI_SISTEMA[tipo];
    // Chat distinte, dalla piu' recente: i tagli a 50 e a 20 tengono le ultime.
    const ultimaPerChat = new Map<number, number>();
    for (const e of evs) {
      const c = convIdDi(e);
      if (c === null) continue;
      const t = Date.parse(e.created_at);
      if (!ultimaPerChat.has(c) || t > ultimaPerChat.get(c)!) ultimaPerChat.set(c, t);
    }
    const chat = [...ultimaPerChat.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0]).map(([c]) => c);
    let primoAt: string | null = null;
    let ultimoAt: string | null = null;
    for (const e of evs) {
      if (primoAt === null || Date.parse(e.created_at) < Date.parse(primoAt)) primoAt = e.created_at;
      if (ultimoAt === null || Date.parse(e.created_at) > Date.parse(ultimoAt)) ultimoAt = e.created_at;
    }
    const base: Avviso = {
      id: tipo,
      gravita: d.gravita,
      titolo: d.titolo,
      significato: d.significato,
      cosaFare: d.cosaFare,
      // Chat distinte; se gli eventi non portano la chat, il numero di eventi.
      conteggio: chat.length || evs.length,
      chat: chat.slice(0, 50),
      ultimoAt,
    };
    out.push(conFirma(base, { area: d.area, azioni: azioniPer(base), primoAt }));
  }

  for (const c of CRON_SISTEMA) {
    // Chiave assente = giro non letto (niente avviso); `null` = letto e mai avvenuto.
    if (!c.attivo(now) || !(c.cron in ultimiRun)) continue;
    const ultimo = ultimiRun[c.cron] ?? null;
    const fermo = !ultimo || now.getTime() - Date.parse(ultimo) > 2 * c.periodoMin * 60_000;
    if (!fermo) continue;
    const base: Avviso = {
      id: `cron_${c.cron}`,
      gravita: 'critico',
      titolo: `Il cron ${c.cron} è fermo`,
      significato: ultimo
        ? `L'ultimo giro risale a ${ultimo}: da più del doppio del suo periodo (${c.periodoMin} minuti).`
        : 'Non risulta nessun giro recente di questo cron.',
      cosaFare: 'Usa "Rilancia ora". Se si ferma di nuovo, controlla i log della funzione su Vercel.',
      conteggio: 1,
      chat: [],
      ultimoAt: ultimo,
    };
    out.push(conFirma(base, { area: 'cron', azioni: rilancia(c.cron), primoAt: null }));
  }
  return out;
}

export function componiAvvisi(
  lancio: Avviso[],
  sistema: AvvisoConsole[],
  risolti: ReadonlyMap<string, string>,
): AvvisoConsole[] {
  const dal = lancio.map((a) => conFirma(a, { area: areaDi(a), azioni: azioniPer(a), primoAt: null }));
  return [...dal, ...sistema]
    .filter((a) => risolti.get(a.id) !== a.firma)
    .sort((a, b) => ORDINE[a.gravita] - ORDINE[b.gravita] || b.conteggio - a.conteggio);
}
