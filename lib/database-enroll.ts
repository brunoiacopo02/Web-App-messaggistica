/**
 * Arruolamento di un lead di DATABASE della coda marketing (PO 10/11/2026, contratto
 * v1.17: `database: true` nel push del CRM). Le regole pure stanno in lib/database-bot.ts.
 *
 * Differenze dall'arruolamento di Mario (`enrollLeadIntoMario`), tutte volute:
 * - PRIMA si decide se l'apertura puo' partire, POI si crea la chat. Se non puo'
 *   (interruttore spento, tetti pieni, nessun template approvato, fuori fascia) non si
 *   scrive niente e si risponde `accettato:false` con `database_non_aperto`: il CRM tiene
 *   il lead in coda e lo ripropone piu' tardi. Niente aperture differite: un lead vecchio
 *   non ha fretta, e una chat muta in attesa e' una chat che nessun cron saprebbe aprire
 *   col template giusto;
 * - l'apertura va SOLO a un numero che non ha gia' una chat col bot: "un solo messaggio a
 *   persona" vale anche rispetto ai giri precedenti. Chat esistente = `accettato:false`
 *   con `database_chat_esistente` (definitivo: il CRM non lo ripropone). Unica eccezione
 *   il ritento dello stesso intake (stesso leadId su una chat database): `duplicato`;
 * - il numero: tutti i numeri del giro (secondari + primario) con tetto > 0 in
 *   `tetti_numeri`, sotto il loro tetto di aperture di oggi (nessun trabocco: se sono
 *   pieni il lead aspetta), sotto il tetto database per numero, e con almeno una variante
 *   approvata e spedibile dal loro account. Vince chi ha meno aperture database oggi, poi
 *   chi ha meno aperture in tutto;
 * - la variante: ripartizione stabile per id della chat fra quelle spedibili da QUEL numero.
 *
 * Fallisce chiuso: ogni lettura che non riesce vale "non si apre". Sbagliare in quella
 * direzione costa un lead che aspetta un'ora; nell'altra un messaggio MARKETING a freddo
 * oltre il tetto di un numero.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { inOpeningWindow } from './sequence';
import { templateName } from './name';
import { numeroPrimario, numeriSecondari } from './mittente';
import { getTettiNumeri, tettoDi } from './tetti-numeri';
import { apertureMarioOggi, inizioGiornataRoma } from './bot2-tetto';
import { credenzialiPerMittente, eSuAltroAccount } from './twilio-account';
import { registraAperturaMario } from './scelta-mittente';
import { templateApprovatoSu } from './black-friday-apertura';
import {
  EVENTO_DATABASE_APERTURA, FUNNEL_CHAT_DATABASE, SETTING_DATABASE_BOT, cifreNumero, isChatDatabase,
  parseSettingsDatabase, scegliVariante, sidDatabaseDaEnv, testoAperturaDatabase, variantiInRotazione,
  type SettingsDatabase, type VarianteDatabase,
} from './database-bot';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** `database_non_aperto` = riprova piu' tardi; `database_chat_esistente` = definitivo. */
export type MotivoRifiutoDatabase = 'database_non_aperto' | 'database_chat_esistente';

export type DettaglioNonAperto =
  | 'spento' | 'fuori_fascia' | 'nessuna_variante' | 'lettura_chat_fallita'
  | 'tetto_giorno' | 'conteggio_fallito' | 'tetti_illeggibili' | 'nessun_numero' | 'segno_non_scritto';

export type EsitoEnrollDatabase =
  | { tipo: 'rifiuto'; motivo: MotivoRifiutoDatabase; dettaglio: string; conversationId?: number }
  | { tipo: 'duplicato'; conversationId: number }
  | { tipo: 'aperto'; ok: boolean; conversationId: number; variante: VarianteDatabase; numero: string; sid?: string; error?: string };

export type ChatDelNumero =
  | { esiste: false }
  | { esiste: true; conversationId: number; crmLeadId: string | null; crmFunnel: string | null };

/** Tutto cio' che tocca DB, Twilio e orologio: i test lo sostituiscono. */
export type DepsDatabase = {
  nowMs: () => number;
  leggiSettings: () => Promise<SettingsDatabase>;
  /** null = lettura fallita. */
  chatDelNumero: (phone: string) => Promise<ChatDelNumero | null>;
  /** Aperture database di oggi (giorno di Roma), su tutti i numeri o su uno. null = conteggio fallito. */
  contaDatabaseOggi: (numero?: string) => Promise<number | null>;
  /** I numeri del giro, in ordine: secondari e poi il primario. */
  numeri: () => string[];
  /** null = illeggibili. */
  tetti: () => Promise<Map<string, number> | null>;
  /** Aperture di Mario di oggi sul numero (il conteggio di `tetti_numeri`). null = fallito. */
  apertureOggi: (numero: string) => Promise<number | null>;
  credenzialiOk: (numero: string) => boolean;
  /** Il template e' approvato sull'account del numero e il presidio lo lascia partire. */
  approvato: (sid: string, numero: string) => Promise<boolean>;
  creaChat: (a: { phone: string; firstName?: string | null; email?: string | null; mittente: string }) =>
    Promise<{ conversationId: number; waNumber: string | null }>;
  registraApertura: (a: { numero: string; conversationId: number; crmLeadId: string | null }) => Promise<void>;
  invia: (a: { conversationId: number; phone: string; sid: string; etichetta: string; from: string; nome: string; testo: string }) =>
    Promise<{ ok: boolean; sid?: string; error?: string }>;
  /** false = l'update non e' andato: si scrive PRIMA dell'invio, quindi niente invio. */
  aggiornaChat: (conversationId: number, patch: Record<string, unknown>) => Promise<boolean>;
  log: (type: string, level: 'info' | 'warn' | 'error', payload: Record<string, unknown>, message: string) => Promise<void>;
};

export type ArgsEnrollDatabase = {
  phone: string; // gia' E.164
  firstName?: string | null;
  email?: string | null;
  crmLeadId: string;
  /** Il funnel come lo scrive il CRM ("Database"): resta solo nel log. */
  crmFunnel?: string | null;
};

export async function enrollDatabaseLead(
  supabase: Supa,
  args: ArgsEnrollDatabase,
  deps: DepsDatabase = depsDatabase(supabase),
): Promise<EsitoEnrollDatabase> {
  const base = { phone: args.phone, crmLeadId: args.crmLeadId };
  const nonAperto = async (dettaglio: DettaglioNonAperto, extra: Record<string, unknown> = {}): Promise<EsitoEnrollDatabase> => {
    await deps.log('database_intake_rifiutato', dettaglio === 'spento' ? 'info' : 'warn',
      { ...base, motivo: 'database_non_aperto', dettaglio, ...extra },
      `[database] lead ${args.crmLeadId} non aperto (${dettaglio}): resta in coda al CRM`);
    return { tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio };
  };

  const settings = await deps.leggiSettings();
  if (!settings.attivo) return nonAperto('spento');

  const nowMs = deps.nowMs();
  if (!inOpeningWindow(nowMs)) return nonAperto('fuori_fascia');

  const sidPerVariante = sidDatabaseDaEnv();
  const inRotazione = variantiInRotazione({ settings, nowMs });
  if (inRotazione.length === 0) return nonAperto('nessuna_variante');

  // Una sola apertura a persona: chi ha gia' una chat col bot non ne riceve un'altra.
  const chat = await deps.chatDelNumero(args.phone);
  if (chat === null) return nonAperto('lettura_chat_fallita');
  if (chat.esiste) {
    if (chat.crmLeadId === args.crmLeadId && isChatDatabase(chat.crmFunnel)) {
      await deps.log('database_intake_duplicato', 'info', { ...base, conversationId: chat.conversationId },
        `[database] intake ripetuto per il lead ${args.crmLeadId}: apertura gia' partita, nessun reinvio`);
      return { tipo: 'duplicato', conversationId: chat.conversationId };
    }
    await deps.log('database_intake_rifiutato', 'info',
      { ...base, motivo: 'database_chat_esistente', conversationId: chat.conversationId, leadIdChat: chat.crmLeadId, funnelChat: chat.crmFunnel },
      `[database] lead ${args.crmLeadId}: il numero ha gia' la chat ${chat.conversationId}, nessuna apertura`);
    return { tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio: 'chat_esistente', conversationId: chat.conversationId };
  }

  const oggi = await deps.contaDatabaseOggi();
  if (oggi === null) return nonAperto('conteggio_fallito');
  if (oggi >= settings.tettoGiorno) return nonAperto('tetto_giorno', { oggi, tetto: settings.tettoGiorno });

  const tetti = await deps.tetti();
  if (tetti === null) return nonAperto('tetti_illeggibili');

  // I numeri sotto tutti e tre i tetti, dal meno carico.
  type Candidato = { numero: string; databaseOggi: number; apertureOggi: number; ordine: number };
  const candidati: Candidato[] = [];
  const scartati: { numero: string; motivo: string }[] = [];
  // `numeri` nelle impostazioni restringe il giro; `fuori_tetto` salta `tetti_numeri`
  // (PO 11/11/2026: "5 a numero, al di la' del tetto"). Resta sempre `tetto_numero`.
  const giro = settings.numeri
    ? deps.numeri().filter((n) => settings.numeri!.includes(cifreNumero(n)))
    : deps.numeri();
  for (const [ordine, numero] of giro.entries()) {
    const tettoNumero = tettoDi(tetti, numero);
    if (!settings.fuoriTetto && tettoNumero <= 0) { scartati.push({ numero, motivo: 'tetto_zero' }); continue; }
    if (!deps.credenzialiOk(numero)) { scartati.push({ numero, motivo: 'credenziali_mancanti' }); continue; }
    const aperture = await deps.apertureOggi(numero);
    if (aperture === null) { scartati.push({ numero, motivo: 'conteggio_fallito' }); continue; }
    if (!settings.fuoriTetto && aperture >= tettoNumero) { scartati.push({ numero, motivo: 'tetto_raggiunto' }); continue; }
    const db = await deps.contaDatabaseOggi(numero);
    if (db === null) { scartati.push({ numero, motivo: 'conteggio_fallito' }); continue; }
    if (db >= settings.tettoNumero) { scartati.push({ numero, motivo: 'tetto_database_numero' }); continue; }
    candidati.push({ numero, databaseOggi: db, apertureOggi: aperture, ordine });
  }
  candidati.sort((a, b) => (a.databaseOggi - b.databaseOggi) || (a.apertureOggi - b.apertureOggi) || (a.ordine - b.ordine));

  // Il primo numero da cui almeno una variante in rotazione e' approvata e spedibile.
  let scelto: { numero: string; spedibili: VarianteDatabase[] } | null = null;
  for (const c of candidati) {
    const esiti = await Promise.all(inRotazione.map(async (v) =>
      (await deps.approvato(sidPerVariante[v] as string, c.numero).catch(() => false)) ? v : null));
    const spedibili = esiti.filter((v): v is VarianteDatabase => v !== null);
    if (spedibili.length > 0) { scelto = { numero: c.numero, spedibili }; break; }
    scartati.push({ numero: c.numero, motivo: 'nessun_template_approvato' });
  }
  if (!scelto) return nonAperto('nessun_numero', { scartati });

  const { conversationId, waNumber } = await deps.creaChat({
    phone: args.phone, firstName: args.firstName ?? null, email: args.email ?? null, mittente: scelto.numero,
  });
  // La chat e' nata fra il controllo e adesso (due intake insieme) su un altro numero:
  // non e' piu' una chat nuova, e da un altro numero la variante potrebbe non partire.
  if (waNumber !== scelto.numero) {
    await deps.log('database_intake_rifiutato', 'warn',
      { ...base, motivo: 'database_chat_esistente', conversationId, numeroChat: waNumber, numeroScelto: scelto.numero },
      `[database] lead ${args.crmLeadId}: la chat ${conversationId} esisteva gia' su ${waNumber}, nessuna apertura`);
    return { tipo: 'rifiuto', motivo: 'database_chat_esistente', dettaglio: 'chat_nata_nel_frattempo', conversationId };
  }

  const variante = scegliVariante(conversationId, scelto.spedibili) as VarianteDatabase;
  const sid = sidPerVariante[variante] as string;
  const nome = templateName(args.firstName);
  // Prima dell'invio: cosi' l'apertura cade DENTRO la cronologia che Marta rilegge.
  const arruolatoAt = new Date(deps.nowMs()).toISOString();

  // Il segno sulla chat PRIMA dell'invio (revisione 11/11/2026): una chat con l'apertura
  // partita ma senza segno verrebbe adottata dal webhook come lead entrante (flusso
  // ordinario, touch, GDO), e un ritento del CRM la leggerebbe come "chat di un altro".
  // Le strade che mandano messaggi saltano gia' le chat database, quindi firmarla prima
  // non fa partire niente. Se l'update non va, non si manda niente.
  const firmata = await deps.aggiornaChat(conversationId, {
    ai_owner: 'mario',
    ai_status: 'active',
    ai_started_at: arruolatoAt,
    crm_lead_id: args.crmLeadId,
    crm_funnel: FUNNEL_CHAT_DATABASE,
  });
  if (!firmata) {
    await deps.log('database_intake_rifiutato', 'error', { ...base, motivo: 'database_non_aperto', dettaglio: 'segno_non_scritto', conversationId },
      `[database] lead ${args.crmLeadId}: segno sulla chat ${conversationId} non scritto, nessun invio`);
    return { tipo: 'rifiuto', motivo: 'database_non_aperto', dettaglio: 'segno_non_scritto', conversationId };
  }

  // Conta nel tetto del numero come ogni altra apertura (`tetti_numeri`).
  await deps.registraApertura({ numero: scelto.numero, conversationId, crmLeadId: args.crmLeadId });
  const res = await deps.invia({
    conversationId, phone: args.phone, sid, etichetta: `Apertura database ${variante}`,
    from: scelto.numero, nome, testo: testoAperturaDatabase(variante, nome),
  });
  // Una riga per apertura tentata: e' il conteggio dei due tetti database e la base delle
  // statistiche per variante. Conta anche l'invio fallito (il tetto sbaglia per eccesso).
  await deps.log(EVENTO_DATABASE_APERTURA, res.ok ? 'info' : 'error',
    { conversationId, numero: scelto.numero, variante, sid, crmLeadId: args.crmLeadId, funnelCrm: args.crmFunnel ?? null, inviato: res.ok, ...(res.ok ? {} : { error: res.error ?? null }) },
    res.ok
      ? `[database] conv ${conversationId}: apertura ${variante} da ${scelto.numero}`
      : `[database] conv ${conversationId}: apertura ${variante} da ${scelto.numero} NON partita (${res.error ?? 'errore'})`);

  return { tipo: 'aperto', ok: res.ok, conversationId, variante, numero: scelto.numero, sid: res.sid, error: res.error };
}

/** Ultime 10 cifre del numero (la chiave persona del CRM); null se ne ha meno di 9. */
export function chiaveTelefono(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '').slice(-10);
  return d.length >= 9 ? d : null;
}

export async function leggiSettingsDatabase(supabase: Supa): Promise<SettingsDatabase> {
  try {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', SETTING_DATABASE_BOT).maybeSingle();
    if (error) return parseSettingsDatabase(null);
    return parseSettingsDatabase((data as { value?: unknown } | null)?.value);
  } catch {
    return parseSettingsDatabase(null);
  }
}

export function depsDatabase(supabase: Supa): DepsDatabase {
  return {
    nowMs: () => Date.now(),
    leggiSettings: () => leggiSettingsDatabase(supabase),
    chatDelNumero: async (phone) => {
      try {
        // Lo stesso numero scritto in un altro modo (PO 11/11/2026: `+39 333...` contro
        // `333...`): si cercano tutte le schede con le stesse ultime 10 cifre, e basta una
        // chat su una qualunque di loro. Le schede del bot sono in E.164, quindi il
        // suffisso basta. Il ritento dello stesso intake resta riconoscibile (stesso leadId).
        const chiave = chiaveTelefono(phone);
        const q = supabase.from('leads').select('id');
        const { data: righe, error } = chiave ? await q.like('phone_e164', `%${chiave}`).limit(20) : await q.eq('phone_e164', phone).limit(20);
        if (error) return null;
        const ids = ((righe ?? []) as { id: number }[]).map((r) => r.id);
        if (ids.length === 0) return { esiste: false };
        const { data: convs, error: e2 } = await supabase
          .from('conversations').select('id, crm_lead_id, crm_funnel').in('lead_id', ids).order('id', { ascending: true }).limit(20);
        if (e2) return null;
        const lista = (convs ?? []) as { id: number; crm_lead_id?: string | null; crm_funnel?: string | null }[];
        if (lista.length === 0) return { esiste: false };
        // Prima la chat del giro database (e' quella che rende riconoscibile il ritento).
        const c = lista.find((x) => isChatDatabase(x.crm_funnel)) ?? lista[0];
        return { esiste: true, conversationId: c.id, crmLeadId: c.crm_lead_id ?? null, crmFunnel: c.crm_funnel ?? null };
      } catch {
        return null;
      }
    },
    contaDatabaseOggi: async (numero) => {
      try {
        let q = supabase.from('event_log').select('id', { count: 'exact', head: true }).eq('type', EVENTO_DATABASE_APERTURA);
        if (numero) q = q.eq('payload->>numero', numero);
        const { count, error } = await q.gte('created_at', inizioGiornataRoma(new Date()));
        if (error || count === null || count === undefined) return null;
        return count;
      } catch {
        return null;
      }
    },
    numeri: () => {
      const primario = numeroPrimario();
      return [...numeriSecondari(), ...(primario ? [primario] : [])];
    },
    tetti: () => getTettiNumeri(supabase),
    apertureOggi: (numero) => apertureMarioOggi(supabase as never, numero),
    // Numero dichiarato su un altro account ma senza le sue credenziali: Twilio
    // risponderebbe 401 a ogni invio (stessa guardia di `scegliMittenteNuovo`).
    credenzialiOk: (numero) => !(eSuAltroAccount(numero) && credenzialiPerMittente(numero)?.sid === process.env.TWILIO_ACCOUNT_SID),
    approvato: (sid, numero) => templateApprovatoSu(sid, numero),
    creaChat: async (a) => {
      const r = await findOrCreateLeadConversation(supabase, {
        phone: a.phone, firstName: a.firstName ?? undefined, email: a.email ?? undefined,
      }, { mittente: a.mittente });
      return { conversationId: r.conversationId, waNumber: r.waNumber };
    },
    registraApertura: (a) => registraAperturaMario(supabase, a),
    invia: (a) => sendTemplateAndLog(supabase, a.conversationId, a.phone, a.sid, a.etichetta, a.from, { '1': a.nome }, a.testo),
    aggiornaChat: async (conversationId, patch) => {
      try {
        const { error } = await supabase.from('conversations').update(patch as never).eq('id', conversationId);
        return !error;
      } catch {
        return false;
      }
    },
    log: async (type, level, payload, message) => {
      await supabase.from('event_log').insert({ type, level, payload: payload as never, message }).then(() => undefined, () => undefined);
    },
  };
}
