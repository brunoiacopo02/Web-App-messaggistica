/**
 * Da quale numero nasce una chat NUOVA del bot. Unico punto di decisione dal
 * 26/09/2026 (spec 2026-09-26-parco-numeri-design.md): prima lo sceglieva il CRM
 * fra "bot 1" e "bot 2", e il tetto stava in due repo.
 *
 * Regola: fra i secondari con tetto > 0 (app_settings.tetti_numeri), che oggi non
 * l'hanno ancora raggiunto e da cui TUTTI i template richiesti sono spedibili, si
 * prende quello con meno chat nate oggi. Nessuno = il numero storico.
 *
 * `ignoraTetti` (lancio_sender='secondario') salta il conteggio e il tetto > 0, ma
 * non il riposo: un numero a tetto 0 resta escluso anche li'.
 *
 * Fallisce chiuso: tetti illeggibili, conteggio in errore, credenziali dello slot
 * mancanti, template che non esiste sull'account del numero o che il presidio
 * blocca — ogni dubbio toglie il numero dai candidati. Il costo di sbagliare verso il 3199 e' un'apertura dal numero di
 * sempre; nell'altra direzione e' un lead muto o un numero bruciato.
 *
 * Il conteggio e l'INSERT della chat non sono atomici: due intake concorrenti
 * possono sforare il tetto di qualche unita'. Accettato: il tetto protegge la
 * qualita' del numero, non un contratto.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { numeroPrimario, numeriSecondari } from './mittente';
import { getTettiNumeri, tettoDi } from './tetti-numeri';
import { chatNateOggi, inizioGiornataRoma } from './bot2-tetto';
import { credenzialiPerMittente, eSuAltroAccount } from './twilio-account';
import { spedibileDa } from './spedibilita';
import { OPENING_ENV_KEYS } from './persona';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type Scarto = {
  numero: string;
  motivo:
    | 'tetto_zero' | 'tetto_raggiunto' | 'conteggio_fallito' | 'credenziali_mancanti'
    | 'template_non_tradotto' | 'template_bloccato';
  oggi?: number;
  tetto?: number;
  errore?: string | null;
};

export type SceltaMittente = {
  from: string;
  secondario: boolean;
  scartati: Scarto[];
  motivo: 'scelto' | 'nessun_candidato' | 'tetti_illeggibili' | 'nessun_secondario';
};

async function log(supabase: Supa, type: string, level: 'info' | 'warn', payload: Record<string, unknown>, message: string) {
  await supabase.from('event_log').insert({ type, level, payload: payload as never, message }).then(() => undefined, () => undefined);
}

/**
 * `mittente_tetto` e' una riga per numero per giorno di Roma (spec §4.3), non una
 * per ogni chat che trova il numero pieno: con 150 intake dopo il tetto sarebbero
 * 150 righe uguali. Si scrive solo se oggi non ce n'e' gia' una per quel numero.
 * Conteggio in errore = non si scrive: e' solo un log, meglio perderne una che
 * ripetere il flusso.
 */
async function logTettoUnaVoltaAlGiorno(
  supabase: Supa, payload: { numero: string; oggi: number; tetto: number } & Record<string, unknown>, adesso?: Date,
) {
  try {
    const { count, error } = await supabase
      .from('event_log')
      .select('id', { count: 'exact', head: true })
      .eq('type', 'mittente_tetto')
      .eq('payload->>numero', payload.numero)
      .gte('created_at', inizioGiornataRoma(adesso));
    if (error || count === null || count === undefined || count > 0) return;
  } catch {
    return;
  }
  await log(supabase, 'mittente_tetto', 'info', payload,
    `[numeri] ${payload.numero} ha raggiunto il tetto (${payload.oggi}/${payload.tetto})`);
}

/**
 * I template d'apertura che una chat NUOVA puo' davvero ricevere: devono esserci TUTTI
 * sul numero scelto.
 *
 * Con l'A/B acceso (`NEW_OPENING_ENABLED=1`) `fenice-enroll.ts` sceglie il SID in base a
 * funnel e variante, una delle chiavi in `OPENING_ENV_KEYS` (lib/persona.ts). Se la
 * env di QUELLA variante manca, non salta l'invio: ripiega INTERO sul legacy
 * `FENICE_OPENING_TEMPLATE_SID` (evento `opening_config_error`). Quindi:
 * - se TUTTE le `OPENING_ENV_KEYS` sono valorizzate, nessun lead puo' finire sul
 *   legacy: il suo SID non va verificato (spesso non esiste nemmeno sull'account
 *   nuovo, ed escluderebbe il numero per sempre senza motivo);
 * - se ne manca anche una sola, un lead puo' ricevere il legacy: va verificato anche
 *   lui, se configurato.
 * Con l'A/B spento resta il solo legacy, come prima del 26/09/2026.
 */
export function sidAperturaMario(): string[] {
  if (process.env.NEW_OPENING_ENABLED === '1') {
    const valori = OPENING_ENV_KEYS
      .map((k) => process.env[k])
      .filter((v): v is string => Boolean(v));
    const mancaQualcuna = valori.length < OPENING_ENV_KEYS.length;
    const legacy = process.env.FENICE_OPENING_TEMPLATE_SID;
    return mancaQualcuna && legacy ? [...valori, legacy] : valori;
  }
  const legacy = process.env.FENICE_OPENING_TEMPLATE_SID;
  return legacy ? [legacy] : [];
}

export async function scegliMittenteNuovo(
  supabase: Supa,
  i: { templateSids: string[]; chiave: string; crmLeadId?: string | null; ignoraTetti?: boolean; adesso?: Date },
): Promise<SceltaMittente> {
  const primario = numeroPrimario();
  if (!primario) throw new Error('TWILIO_WHATSAPP_NUMBER_FENICE non configurato');
  const base = { chiave: i.chiave, crmLeadId: i.crmLeadId ?? null };
  const alPrimario = (motivo: SceltaMittente['motivo'], scartati: Scarto[] = []): SceltaMittente =>
    ({ from: primario, secondario: false, scartati, motivo });

  const secondari = numeriSecondari();
  if (secondari.length === 0) return alPrimario('nessun_secondario');
  if (i.templateSids.length === 0) {
    await log(supabase, 'mittente_ripiego', 'warn', { ...base, motivo: 'nessun_template' },
      `[numeri] nessun template da verificare: ${i.chiave} nasce sul numero storico`);
    return alPrimario('nessun_candidato');
  }

  // I tetti si leggono anche con `ignoraTetti`: il lancio in modalita' 'secondario'
  // scavalca i tetti GIORNALIERI, non il riposo. Un numero a tetto 0 (o assente
  // dalla mappa) e' fermo apposta — per esempio il 0047 — e non deve riaprirsi
  // perche' il pannello del lancio dice "secondario".
  const tetti = await getTettiNumeri(supabase);
  if (tetti === null) {
    await log(supabase, 'mittente_ripiego', 'warn', { ...base, motivo: 'tetti_illeggibili' },
      `[numeri] tetti illeggibili: ${i.chiave} nasce sul numero storico`);
    return alPrimario('tetti_illeggibili');
  }

  const scartati: Scarto[] = [];
  const candidati: { numero: string; oggi: number }[] = [];
  for (const numero of secondari) {
    let oggi = 0;
    const tetto = tettoDi(tetti, numero);
    if (tetto <= 0) { scartati.push({ numero, motivo: 'tetto_zero' }); continue; }
    if (!i.ignoraTetti) {
      // `chatNateOggi` ha un tipo `Supa` minimale (solo la catena che usa); il client
      // vero non vi si assegna strutturalmente, da qui il cast.
      const n = await chatNateOggi(supabase as never, numero, i.adesso);
      if (n === null) {
        scartati.push({ numero, motivo: 'conteggio_fallito' });
        await log(supabase, 'mittente_ripiego', 'warn', { ...base, numero, motivo: 'conteggio_fallito' },
          `[numeri] conteggio di oggi per ${numero} fallito: escluso`);
        continue;
      }
      if (n >= tetto) {
        scartati.push({ numero, motivo: 'tetto_raggiunto', oggi: n, tetto });
        await logTettoUnaVoltaAlGiorno(supabase, { ...base, numero, oggi: n, tetto }, i.adesso);
        continue;
      }
      oggi = n;
    }
    // Numero dichiarato su un altro account (TWILIO_WHATSAPP_NUMBERS_N) ma senza
    // SID/TOKEN di quello slot: `credenzialiPerMittente` ripiega sul principale,
    // che non possiede il numero — Twilio risponderebbe 401 a ogni invio. Si
    // scarta qui, prima di chiedere i template a un account che non e' il suo.
    if (eSuAltroAccount(numero) && credenzialiPerMittente(numero)?.sid === process.env.TWILIO_ACCOUNT_SID) {
      scartati.push({ numero, motivo: 'credenziali_mancanti' });
      await log(supabase, 'mittente_ripiego', 'warn', { ...base, numero, motivo: 'credenziali_mancanti' },
        `[numeri] ${numero} e' su un altro account ma le sue credenziali mancano: escluso`);
      continue;
    }
    let bloccato: Scarto | null = null;
    for (const sid of i.templateSids) {
      const sped = await spedibileDa(sid, numero);
      if (!sped.ok) { bloccato = { numero, motivo: sped.motivo, errore: sped.errore }; break; }
    }
    if (bloccato) {
      scartati.push(bloccato);
      await log(supabase, 'mittente_ripiego', 'warn', { ...base, ...bloccato },
        `[numeri] ${numero} escluso: ${bloccato.motivo} (${bloccato.errore ?? 'senza dettaglio'})`);
      continue;
    }
    candidati.push({ numero, oggi });
  }

  if (candidati.length === 0) return alPrimario('nessun_candidato', scartati);
  // Meno chat oggi vince; a parita' resta l'ordine della lista (sort stabile). Con
  // `ignoraTetti` ogni `oggi` resta 0 per tutti (il conteggio non si fa): vince il
  // primo secondario non a riposo e spedibile nell'ordine della lista, senza
  // bilanciamento.
  candidati.sort((a, b) => a.oggi - b.oggi);
  return { from: candidati[0].numero, secondario: true, scartati, motivo: 'scelto' };
}
