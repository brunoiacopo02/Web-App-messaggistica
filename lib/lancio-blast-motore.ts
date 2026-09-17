import type { NextRequest } from 'next/server';
import type { getSupabaseAdmin } from './supabase/admin';
import type { LancioFase } from './lancio-fase';
import { sendTemplate } from './twilio';
import { impostaFaseLancio } from './lancio-db';
import { setLancioSetting } from './lancio-settings';
import { runPool } from './run-pool';
import { decideFreno } from './lancio-zoom-blast';
import { CODICE_FREQUENCY_CAP } from './lancio-aperture';
import { logCronQueryError } from './cron-query-error';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il motore degli invii a lotti del lancio (spec §11), estratto dal cron del blast Zoom
 * (B4, `app/api/cron/lancio-zoom/route.ts`) perche' il follow-up del 6 (B5) faccia le
 * stesse cose nello stesso modo. Quello che sta qui NON sa che cosa manda ne' a chi:
 * riceve un lotto gia' scelto e un worker che gli dice come costruire il messaggio.
 *
 * Le quattro difese, nell'ordine in cui contano:
 *  0. FASE. La fase dopo l'invio si scrive con `impostaFaseLancio(..., { soloDaFasi })`,
 *     un compare-and-set sulla fase di partenza: mai riportare indietro una chat che un
 *     turno concorrente ha gia' portato avanti (commit 746492e).
 *  1. IDEMPOTENZA. Il timbro (`colonna`) e' insieme il filtro dei candidati e il
 *     lucchetto: si scrive PRIMA di chiamare Twilio con un compare-and-set, e si libera
 *     SOLO se a Twilio non e' partito niente (codice Twilio presente). Un errore senza
 *     codice — timeout, connessione caduta — lascia il timbro dov'e': un lead senza
 *     messaggio si recupera a mano, un lead con due template sullo stesso numero a
 *     qualita' LOW e' danno al mittente.
 *  2. FRENO. Ogni `PASSO_FRENO` invii `decideFreno` guarda i TENTATIVI (riusciti +
 *     falliti + cap + incerti): sopra il 10 % di non arrivati, o al primo 63018/63051, il
 *     run si ferma e `frenaLancio` spegne `lancio_attivo`. Il 63049 e' del destinatario:
 *     si conta come `capped`, il timbro si libera, il run continua.
 *  3. TEMPO. `TEMPO_MASSIMO_MS` sotto `maxDuration = 300`: ci si ferma con un minuto di
 *     margine per scrivere il riepilogo, i residui li prende il run dopo.
 */

/** Ogni quanti invii si rivaluta il freno (con lotti da 200 e concorrenza 5: 8 volte). */
export const PASSO_FRENO = 25;
/** `maxDuration` e' 300s: ci si ferma a 240 per avere il tempo del riepilogo. */
export const TEMPO_MASSIMO_MS = 240_000;
/** Paracadute sulla paginazione dei candidati: 20.000 e' gia' un'anomalia da guardare. */
export const MAX_PAGINE = 20;
export const PAGINA = 1000;

export type EsitoInvio = 'sent' | 'riparato' | 'capped' | 'failed' | 'incerto' | 'skip' | 'errore' | 'bloccato';
export type ColonnaTimbro = 'lancio_link_inviato_at' | 'lancio_followup_inviato_at';

/** Lo stato condiviso fra i worker di un run: il fermo e i numeri che il freno legge. */
export type StatoRun = { fermo: string | null; tentati: number; codici: (number | string)[] };
export const nuovoStatoRun = (): StatoRun => ({ fermo: null, tentati: 0, codici: [] });

export function autorizzatoCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export type ParametriCron =
  | { ok: true; now: Date; forza: boolean; solo: number | null; dry: boolean }
  | { ok: false; errore: string };

/**
 * I parametri della prova generale (B6). `forza=1` salta SOLO il filtro della finestra e
 * vale SOLO con `solo=<conversationId>`: senza, un run forzato fuori data manderebbe il
 * template a tutta la coda. `now=<iso>` sposta l'orologio; chi lo vuole confinato alla
 * singola conversazione passa `nowRichiedeSolo: true` (il follow-up), il blast Zoom lo
 * lascia libero perche' i suoi test lo usano cosi' (ruling R3: il cron Zoom non cambia).
 */
export function leggiParametriCron(req: NextRequest, opts: { nowRichiedeSolo: boolean }): ParametriCron {
  const sp = req.nextUrl.searchParams;
  const forza = sp.get('forza') === '1';
  const soloRaw = parseInt(sp.get('solo') ?? '', 10);
  const solo = Number.isFinite(soloRaw) ? soloRaw : null;
  const nowRaw = sp.get('now');
  if (forza && solo === null) return { ok: false, errore: 'forza=1 richiede solo=<conversationId>' };
  if (opts.nowRichiedeSolo && nowRaw && solo === null) return { ok: false, errore: 'now=<iso> richiede solo=<conversationId>' };
  const t = nowRaw ? Date.parse(nowRaw) : NaN;
  return { ok: true, now: Number.isNaN(t) ? new Date() : new Date(t), forza, solo, dry: sp.get('dry') === '1' };
}

/**
 * Il presidio categoria (`UTILITY_ONLY`, `assertTemplateSendable` dentro `sendTemplate`)
 * ha detto no: nessuna chiamata a Twilio e' partita. Vale identico per ogni
 * conversazione, quindi il run si ferma invece di sbatterci contro duecento volte — e
 * nessuna riga `messages` racconta un invio che non c'e' stato.
 */
export function eRifiutoDiPolicy(e: { message?: string; code?: number }): boolean {
  if (typeof e?.code === 'number') return false;
  const m = e?.message ?? '';
  return m.includes('bloccato: categoria') || m.includes('non verificabile');
}

export async function logEvento(
  supabase: Supa,
  type: string,
  payload: Record<string, unknown>,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  await supabase.from('event_log').insert({ type, payload: payload as never, message, level });
}

/**
 * Legge TUTTA la coda a pagine di `PAGINA`. Una query fallita torna `data: null`, cioe'
 * zero candidati: senza `queryKo` il run risponderebbe `sent: 0` identico a una coda
 * vuota (e' il caso della migrazione non applicata, Postgres 42703).
 */
export async function leggiCoda<T>(
  supabase: Supa,
  tipoErrore: string,
  leggiPagina: (da: number, a: number) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
): Promise<{ righe: T[]; queryKo: boolean }> {
  const righe: T[] = [];
  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    const { data, error } = await leggiPagina(pagina * PAGINA, pagina * PAGINA + PAGINA - 1);
    if (error) {
      await logCronQueryError(supabase, tipoErrore, error);
      return { righe, queryKo: true };
    }
    const lotto = (data ?? []) as T[];
    righe.push(...lotto);
    if (lotto.length < PAGINA) break;
  }
  return { righe, queryKo: false };
}

/** L'oggetto per l'update del timbro, con la SOLA colonna chiesta (i tipi di
 *  `conversations.Update` non accettano una chiave calcolata su un'unione). */
export function timbroUpdate(
  colonna: ColonnaTimbro,
  valore: string | null,
): { lancio_link_inviato_at: string | null } | { lancio_followup_inviato_at: string | null } {
  return colonna === 'lancio_link_inviato_at'
    ? { lancio_link_inviato_at: valore }
    : { lancio_followup_inviato_at: valore };
}

/** Lo stesso oggetto, ma per `impostaFaseLancio` (i suoi `campi` non ammettono null). */
export function timbroCampi(
  colonna: ColonnaTimbro,
  valore: string,
): { lancio_link_inviato_at: string } | { lancio_followup_inviato_at: string } {
  return colonna === 'lancio_link_inviato_at' ? { lancio_link_inviato_at: valore } : { lancio_followup_inviato_at: valore };
}

export type ConvInvio = {
  id: number; crm_lead_id: string | null; phone: string; nome: string | null;
  /**
   * Il numero da cui questa chat parla. Serve al chiamante per riempire `from`
   * dell'invio: una chat nata sul secondo numero deve continuare di li', o il
   * lead la vede come un secondo thread e la finestra 24h si chiude.
   */
  wa_number?: string | null;
};

/** Le variabili del template e il corpo gia' reso: cambiano a ogni destinatario. */
export type MessaggioCostruito = { vars: Record<string, string>; body: string };

export type InvioTimbrato = {
  conv: ConvInvio;
  colonna: ColonnaTimbro;
  /** La fase scritta con `impostaFaseLancio` a invio riuscito (e nella riparazione). */
  faseDopo: LancioFase;
  sid: string;
  from: string;
  /**
   * Le variabili e il corpo del messaggio per QUESTO destinatario. E' una callback e non
   * due campi gia' pronti perche' il motore la chiama DENTRO il suo try/catch totale: se
   * il nome del lead o il render del body facessero saltare una riga, un'eccezione nel
   * chiamante rifiuterebbe il `Promise.all` di `runPool` e porterebbe via l'intero blocco
   * di 25 — compresi gli invii gia' partiti su WhatsApp, che nessuno registrerebbe piu'.
   * Qui invece un errore e' di un destinatario solo (`skip`, timbro mai preso, si riprova
   * al run dopo) e gli altri 24 partono lo stesso.
   */
  costruisci: (conv: ConvInvio) => MessaggioCostruito;
  /** Una riga `messages` col SID (non failed) esiste gia': si ripara la fase, non si rimanda. */
  giaSpedito: boolean;
  /**
   * Le fasi DA CUI la fase puo' avanzare a `faseDopo`: compare-and-set di
   * `impostaFaseLancio` (`soloDaFasi`). Un cron scrive in parallelo a un turno che puo'
   * aver portato la chat avanti (pulsante → `post_pitch`, attesa → `posto_bloccato`):
   * senza guardia la fase tornerebbe indietro col template ormai partito. Il timbro
   * resta comunque (e' del claim di sopra): la chat esce da sola dai candidati.
   */
  soloDaFasi: readonly LancioFase[];
  /** Prefisso dei tipi di evento: `lancio_zoom` | `lancio_followup`. */
  prefisso: string;
  /** Come si chiama il messaggio nei log: 'link Zoom' | 'follow-up'. */
  etichetta: string;
  /** Se presente, scritto a invio riuscito (es. `lancio_followup_inviato`, spec §3.2). */
  eventoInvio?: string;
};

/**
 * Un invio, con timbro e tutte le sue uscite. Il worker non lascia MAI passare
 * un'eccezione: `runPool` le mette in un `Promise.all`, e una sola farebbe cadere tutto
 * il blocco di invii in corso — compresi quelli gia' partiti su WhatsApp.
 */
export async function inviaTemplateTimbrato(supabase: Supa, stato: StatoRun, p: InvioTimbrato): Promise<EsitoInvio> {
  const { id, phone, crm_lead_id: crmLeadId } = p.conv;
  try {
    if (stato.fermo) return 'skip';

    if (p.giaSpedito) {
      // Riparazione: il messaggio era gia' a DB e manca solo la fase. Stessa guardia
      // dell'invio — fra la select e adesso la chat puo' essere andata avanti da sola.
      await impostaFaseLancio(supabase, id, p.faseDopo, timbroCampi(p.colonna, new Date().toISOString()), { soloDaFasi: p.soloDaFasi });
      return 'riparato';
    }

    // Il messaggio si costruisce PRIMA del timbro, e dentro il try/catch totale: cosi' una
    // riga che non si riesce a rendere non lascia dietro un timbro da liberare, e
    // soprattutto non fa cadere il blocco di invii in corso.
    let messaggio: MessaggioCostruito;
    try {
      messaggio = p.costruisci(p.conv);
    } catch (err) {
      await logEvento(supabase, `${p.prefisso}_messaggio_non_costruito`,
        { conversationId: id, crmLeadId, error: err instanceof Error ? err.message : 'errore' },
        `[lancio] conv ${id}: ${p.etichetta} non costruito, nessun invio — ${err instanceof Error ? err.message : 'errore'}`,
        'error');
      return 'skip';
    }
    const { vars, body } = messaggio;

    // Il timbro PRIMA dell'invio: se due run si accavallano, il secondo trova la riga gia'
    // presa e passa oltre. `is(colonna, null)` rende l'update un compare-and-set.
    const timbro = new Date().toISOString();
    const { data: preso, error: erroreClaim } = await supabase
      .from('conversations')
      .update(timbroUpdate(p.colonna, timbro))
      .eq('id', id)
      .is(p.colonna, null)
      .select('id');
    // Un claim fallito e uno perso in volata danno lo stesso `data` vuoto, e in entrambi i
    // casi si passa oltre — ma il primo e' il DB in affanno mentre stiamo mandando 3.000
    // messaggi, e deve lasciare traccia invece di sparire fra i saltati.
    if (erroreClaim) {
      await logEvento(supabase, `${p.prefisso}_claim_error`, { conversationId: id, error: erroreClaim.message },
        `[lancio] conv ${id}: timbro non scritto, ${p.etichetta} non spedito — ${erroreClaim.message}`, 'error');
      return 'skip';
    }
    if (((preso ?? []) as unknown[]).length === 0) return 'skip';

    // Si libera SOLO il timbro che ha messo questo giro: se nel frattempo un altro run ne
    // ha scritto uno suo, quel timbro protegge un invio che non e' nostro.
    const liberaTimbro = () =>
      supabase.from('conversations').update(timbroUpdate(p.colonna, null)).eq('id', id).eq(p.colonna, timbro);

    stato.tentati++;
    let spedito = false;
    try {
      const res = await sendTemplate({ to: phone, contentSid: p.sid, variables: vars, from: p.from });
      // Il messaggio e' su WhatsApp: da qui in poi il timbro non si tocca piu'. Liberarlo
      // rimetterebbe la chat fra i candidati, e al run dopo il lead lo riceverebbe due volte.
      spedito = true;
      await supabase.from('messages').insert({
        conversation_id: id,
        direction: 'out',
        body,
        twilio_sid: res.sid,
        twilio_status: res.status,
        template_sid: p.sid,
        template_vars: vars as never,
        is_template: true,
        sender: 'automazione',
      });
      await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', id);
      // Compare-and-set sulla fase, non un update alla cieca: mentre il template partiva,
      // il turno puo' aver portato la chat avanti. Se la guardia scatta non si scrive
      // NIENTE, timbro compreso: a proteggere dal doppio invio e' il claim di sopra.
      await impostaFaseLancio(supabase, id, p.faseDopo, timbroCampi(p.colonna, timbro), { soloDaFasi: p.soloDaFasi });
      if (p.eventoInvio) {
        await logEvento(supabase, p.eventoInvio, { conversationId: id, crmLeadId, phone, sid: res.sid },
          `[lancio] ${p.etichetta} inviato a ${phone}`);
      }
      return 'sent';
    } catch (err) {
      const e = err as { message?: string; code?: number };
      if (spedito) {
        // L'invio era andato: il guasto e' nostro, dopo Twilio. Si conta come errore e si
        // passa oltre SENZA liberare il timbro.
        await logEvento(supabase, `${p.prefisso}_meta_incompleta`, { conversationId: id, crmLeadId, error: e?.message ?? 'errore' },
          `[lancio] ${p.etichetta} inviato a ${phone} ma la registrazione e' fallita: ${e?.message ?? 'errore'}`, 'error');
        return 'errore';
      }
      if (eRifiutoDiPolicy(e)) {
        // Nessuna riga, nessun tentativo consumato (l'unico caso in cui `tentati` torna
        // indietro), timbro restituito, e il run finisce qui.
        await liberaTimbro();
        stato.tentati--;
        stato.fermo = 'template_bloccato';
        await logEvento(supabase, `${p.prefisso}_config_error`, { conversationId: id, templateSid: p.sid, error: e?.message ?? 'template non spedibile' },
          `[lancio] ${p.etichetta} bloccato dal presidio template: run fermato — ${e?.message ?? 'template non spedibile'}`, 'error');
        return 'bloccato';
      }
      if (typeof e?.code !== 'number') {
        // Twilio non ha risposto (timeout, connessione caduta): il messaggio PUO' essere
        // partito lo stesso e da qui non c'e' modo di saperlo. Il timbro RESTA.
        await logEvento(supabase, `${p.prefisso}_esito_incerto`, { conversationId: id, crmLeadId, error: e?.message ?? 'errore' },
          `[lancio] conv ${id}: Twilio non ha risposto, esito dell'invio incerto — timbro tenuto, nessun ritentativo`, 'warn');
        return 'incerto';
      }
      // Twilio ha risposto con un codice: l'invio non e' partito. Solo qui il timbro va
      // tolto, o la chat non sarebbe piu' candidata e il lead resterebbe senza per sempre.
      await liberaTimbro();
      if (e.code === CODICE_FREQUENCY_CAP) {
        // Frequency cap Meta: e' del DESTINATARIO (quella persona ha gia' ricevuto troppi
        // template in 24h), non del mittente. Quindi non entra nei codici del freno e non
        // fa riga `messages`: si riprova al run dopo.
        await logEvento(supabase, `${p.prefisso}_freq_capped`, { conversationId: id, templateSid: p.sid },
          `[lancio] frequency cap Meta su conv ${id}: ${p.etichetta} non spedito, ritento al prossimo run`);
        return 'capped';
      }
      stato.codici.push(e.code);
      await logEvento(supabase, 'send_error', { conversationId: id, crmLeadId, code: e.code, error: e?.message ?? 'errore' },
        `[lancio] ${p.etichetta} fallito per ${phone}: ${e?.message ?? 'errore'}`, 'error');
      // La riga failed si vede nel pannello e NON conta nell'idempotenza: si riprova.
      await supabase.from('messages').insert({
        conversation_id: id,
        direction: 'out',
        body,
        twilio_status: 'failed',
        twilio_error_code: e.code,
        template_sid: p.sid,
        template_vars: vars as never,
        is_template: true,
        sender: 'automazione',
      });
      return 'failed';
    }
  } catch (err) {
    await logEvento(supabase, `${p.prefisso}_error`, { conversationId: id, error: err instanceof Error ? err.message : 'errore' },
      `[lancio] errore su conv ${id}: ${err instanceof Error ? err.message : 'errore'}`, 'error');
    return 'errore';
  }
}

export type ContiLotti = {
  inviati: number; riparati: number; capped: number; falliti: number;
  incerti: number; saltati: number; errori: number; report: EsitoInvio[];
};

/**
 * Il ciclo a blocchi da `PASSO_FRENO` con `runPool`: ogni blocco aggiorna i conti, poi
 * la sveglia dei 240s e il freno. `suFreno` e' del chiamante (scrive l'evento col suo
 * prefisso e spegne il lancio: vedi `frenaLancio`).
 */
export async function eseguiLotti<T>(
  lotto: readonly T[],
  stato: StatoRun,
  p: {
    concorrenza: number;
    t0: number;
    inviaUno: (c: T) => Promise<EsitoInvio>;
    suFreno: (stato: StatoRun, conti: ContiLotti) => Promise<void> | void;
  },
): Promise<ContiLotti> {
  const conti: ContiLotti = { inviati: 0, riparati: 0, capped: 0, falliti: 0, incerti: 0, saltati: 0, errori: 0, report: [] };
  for (let i = 0; i < lotto.length && !stato.fermo; i += PASSO_FRENO) {
    // Sveglia prima del taglio di Vercel (`maxDuration = 300`): una funzione uccisa a
    // meta' non scrive il riepilogo, cioe' proprio la riga che dice dove ripartire.
    if (Date.now() - p.t0 > TEMPO_MASSIMO_MS) {
      stato.fermo = 'tempo';
      break;
    }
    const esiti = await runPool(lotto.slice(i, i + PASSO_FRENO), p.concorrenza, p.inviaUno);
    conti.report.push(...esiti);
    for (const e of esiti) {
      if (e === 'sent') conti.inviati++;
      else if (e === 'riparato') conti.riparati++;
      else if (e === 'capped') conti.capped++;
      else if (e === 'failed') conti.falliti++;
      else if (e === 'incerto') conti.incerti++;
      else if (e === 'errore') conti.errori++;
      else conti.saltati++;
    }
    if (stato.fermo) break;
    if (decideFreno({ tentati: stato.tentati, falliti: conti.falliti + conti.incerti, codici: stato.codici }) === 'ferma') {
      stato.fermo = 'freno';
      await p.suFreno(stato, conti);
    }
  }
  return conti;
}

/** Il freno: evento `<prefisso>_freno` (error) e `lancio_attivo` spento, cosi' i run
 *  dopo restano fermi finche' un admin non riaccende dal pannello (runbook B6). */
export async function frenaLancio(
  supabase: Supa,
  stato: StatoRun,
  conti: ContiLotti,
  p: { prefisso: string; etichetta: string; candidati: number; lotto: number },
): Promise<void> {
  await logEvento(
    supabase,
    `${p.prefisso}_freno`,
    {
      tentati: stato.tentati, inviati: conti.inviati, falliti: conti.falliti, incerti: conti.incerti,
      capped: conti.capped, codici: stato.codici, candidati: p.candidati, lotto: p.lotto,
    },
    `[lancio] FRENO sul ${p.etichetta}: ${conti.falliti + conti.incerti} non arrivati su ${stato.tentati} tentativi (${conti.falliti} falliti, ${conti.incerti} incerti; codici: ${stato.codici.join(', ') || 'nessuno'}). Lancio spento, riaccendere a mano dal pannello.`,
    'error',
  );
  // Il freno vale solo se `lancio_attivo` diventa davvero falso: se il DB rifiuta la
  // scrittura il run successivo riparte come se niente fosse, e l'unico evento in giro
  // direbbe "Lancio spento". Meglio urlarlo qui, che e' dove qualcuno sta guardando.
  const spento = await setLancioSetting(supabase, 'lancio_attivo', false);
  if (!spento.ok) {
    await logEvento(
      supabase,
      `${p.prefisso}_freno_non_applicato`,
      { errore: spento.error },
      `[lancio] FRENO NON APPLICATO sul ${p.etichetta}: lancio_attivo NON e' stato spento (${spento.error}). Spegnerlo a mano dal pannello, subito.`,
      'error',
    );
  }
}
