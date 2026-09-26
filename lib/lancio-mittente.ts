/**
 * Da quale numero parte il BENVENUTO DEL LANCIO.
 *
 * `lib/mittente.ts` risponde alla stessa domanda per il bot di tutti i giorni, e la sua
 * regola resta intatta: il riscaldamento ordinario (`FENICE_NUMERO2_QUOTA`, il tetto
 * `BOT2_DAILY_CAP`, la scelta esplicita del CRM con `numeroBot`) non passa di qui.
 * Questo modulo aggiunge UNA regola in piu', e soltanto per il lancio:
 *
 *   ogni ~10 benvenuti che partono dal numero storico, 1 parte da quello nuovo.
 *
 * Serve a scaldare il numero nuovo senza esporlo: finche' non e' accertata la sua
 * capacita' non si sposta il lancio di peso, si fa passare un rivolo. La manopola e'
 * `lancio_quota_secondario` in `app_settings` — 0-100, default 0 — cosi' si spegne in un
 * attimo senza deploy, come tutte le altre manopole del lancio.
 *
 * ── Deterministico, non casuale ────────────────────────────────────────────────────
 * Chi va dove si decide da un dato STABILE del lead (il telefono E.164), non da un
 * sorteggio. Rilanciare un lotto non sposta nessuno, un lead che rientra nel lancio
 * ritrova il suo numero, e i test sono riproducibili. Il telefono e non l'id della
 * conversazione perche' al momento della scelta la conversazione non esiste ancora: il
 * numero si scrive in `conversations.wa_number` nell'INSERT che la crea.
 *
 * ── Non si perdono messaggi in silenzio ────────────────────────────────────────────
 * I Content template vivono DENTRO un account Twilio: lo stesso messaggio esiste sui due
 * account con SID diversi, e la categoria che Meta gli ha dato puo' essere diversa. Un
 * benvenuto mandato dal numero nuovo con un template che di la' non esiste (404) o che
 * `UTILITY_ONLY=1` blocca e' un lead che non riceve niente e nessuno che se ne accorge:
 * e' esattamente l'incidente del 24-28 agosto, 75 righe `failed` senza SID.
 * Quindi prima di scegliere il numero nuovo si VERIFICA che il template sia spedibile di
 * la'; se non lo e', si ripiega sul numero storico e si scrive `lancio_mittente_ripiego`
 * in `event_log`. Meglio un messaggio dal numero sbagliato che un lead muto.
 *
 * ── Una chat che esiste gia' non cambia numero ─────────────────────────────────────
 * La quota si applica SOLO alla prima apertura. Da li' in poi comanda
 * `mittenteDiConversazione`: cambiare numero a chat aperta la spezza in due thread e
 * chiude la finestra delle 24 ore.
 */

import type { getSupabaseAdmin } from './supabase/admin';
import { numeroSecondo } from './mittente';
import { puoAprireSuBot2 } from './bot2-tetto';
import type { LancioSettings } from './lancio-settings';
import { spedibileDa } from './spedibilita';

// `spedibileDa` e' nata qui ma vive in `lib/spedibilita.ts`: la userà anche
// `scelta-mittente.ts`, e questo file importera' a sua volta `scelta-mittente.ts`
// (task 6) — tenerla qui avrebbe creato un ciclo di import. Il re-export mantiene
// invariati i chiamanti esistenti e questo stesso file di test.
export { spedibileDa, type EsitoSpedibilita } from './spedibilita';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il posto del lead nella ruota da 100, da una chiave stabile. FNV-1a a 32 bit: due
 * telefoni consecutivi finiscono in posti lontani, e lo stesso telefono nello stesso
 * posto per sempre, su qualunque macchina e in qualunque processo.
 */
export function posizioneQuota(chiave: string): number {
  const s = (chiave ?? '').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

/**
 * Questo lead tocca al numero nuovo?
 *
 * `quota` e' una percentuale 0-100: 9 vuol dire "9 su 100", cioe' il rapporto 1 a 10
 * chiesto dal PO (uno dal nuovo ogni dieci dal vecchio). Quota 0 = nessuno, sempre.
 */
export function toccaAlSecondario(chiave: string, quota: number): boolean {
  if (!Number.isFinite(quota) || quota <= 0) return false;
  return posizioneQuota(chiave) < quota;
}

/** Perche' non si e' usato il numero nuovo, quando si sarebbe dovuto. */
export type MotivoRipiego =
  | 'numero_assente'
  | 'template_non_tradotto'
  | 'template_bloccato'
  | 'tetto_bot2';

/** Il numero scelto, e perche'. `ripiego` valorizzato = si voleva il nuovo e non si e' potuto. */
export type EsitoMittenteLancio = {
  from: string;
  secondario: boolean;
  /** `quota` o `sender` quando si e' scelto il nuovo; `principale` quando non toccava. */
  scelta: 'principale' | 'quota' | 'sender';
  ripiego: MotivoRipiego | null;
};

export async function logRipiego(
  supabase: Supa,
  payload: Record<string, unknown>,
  message: string,
): Promise<void> {
  await supabase
    .from('event_log')
    .insert({ type: 'lancio_mittente_ripiego', payload: payload as never, message, level: 'warn' })
    .then(() => undefined, () => undefined);
}

/**
 * Il mittente del benvenuto di un lead del lancio che sta entrando ADESSO.
 *
 * Ordine delle regole, come da delibera PO:
 * 1. `lancio_sender = 'secondario'` VINCE: e' una scelta umana dal pannello, va tutto li'
 *    (e non passa dal tetto giornaliero del riscaldamento: se il PO sposta il lancio sul
 *    numero nuovo, il tetto del riscaldamento non deve rimangiarsi la decisione a meta'
 *    giornata, in silenzio).
 * 2. altrimenti si applica la quota, e il tetto giornaliero del numero nuovo
 *    (`BOT2_DAILY_CAP`) resta in piedi: la quota e' un rivolo automatico, e un rivolo non
 *    puo' sfondare il tetto che protegge il numero.
 * 3. in tutti i casi, prima di dire "numero nuovo" si verifica che il benvenuto sia
 *    spedibile di la'. Se non lo e', numero storico + evento `lancio_mittente_ripiego`.
 */
export async function mittenteBenvenutoLancio(
  supabase: Supa,
  i: {
    settings: Pick<LancioSettings, 'sender' | 'quotaSecondario'>;
    /** L'identita' stabile del lead: il telefono E.164. */
    chiave: string;
    templateSid: string;
    primario: string;
    /** Iniettabile per i test; di default `TWILIO_WHATSAPP_NUMBER_FENICE_2`. */
    secondo?: string | undefined;
    crmLeadId?: string | null;
  },
): Promise<EsitoMittenteLancio> {
  const secondo = i.secondo ?? numeroSecondo();
  const perSender = i.settings.sender === 'secondario';
  const perQuota = !perSender && toccaAlSecondario(i.chiave, i.settings.quotaSecondario);
  if (!perSender && !perQuota) {
    return { from: i.primario, secondario: false, scelta: 'principale', ripiego: null };
  }

  const scelta: 'quota' | 'sender' = perSender ? 'sender' : 'quota';
  const base = { chiave: i.chiave, crmLeadId: i.crmLeadId ?? null, scelta, templateSid: i.templateSid };
  const indietro = (ripiego: MotivoRipiego): EsitoMittenteLancio => ({
    from: i.primario, secondario: false, scelta, ripiego,
  });

  if (!secondo) {
    await logRipiego(
      supabase,
      { ...base, motivo: 'numero_assente' },
      `[lancio] benvenuto da mandare dal numero nuovo (${scelta}) ma TWILIO_WHATSAPP_NUMBER_FENICE_2 non e' configurato: parte dal numero storico`,
    );
    return indietro('numero_assente');
  }

  // Il tetto giornaliero del numero nuovo, solo sul rivolo automatico. Fallisce chiuso
  // per conto suo (vedi lib/bot2-tetto.ts): nel dubbio, numero storico.
  if (scelta === 'quota') {
    const tetto = await puoAprireSuBot2(supabase as never, secondo);
    if (!tetto.consentito) {
      await logRipiego(
        supabase,
        // `motivo` resta il nostro; quello del tetto viaggia accanto, o l'uno
        // sovrascriverebbe l'altro e il ripiego non si distinguerebbe piu'.
        { ...base, motivo: 'tetto_bot2', tettoMotivo: tetto.motivo, oggi: tetto.oggi, tetto: tetto.tetto },
        `[lancio] benvenuto in quota sul numero nuovo ma non si puo' (${tetto.motivo}, ${tetto.oggi}/${tetto.tetto}): parte dal numero storico`,
      );
      return indietro('tetto_bot2');
    }
  }

  const spedibile = await spedibileDa(i.templateSid, secondo);
  if (!spedibile.ok) {
    await logRipiego(
      supabase,
      {
        ...base,
        motivo: spedibile.motivo,
        numero: secondo,
        sidTradotto: spedibile.sidTradotto,
        errore: spedibile.errore,
      },
      `[lancio] benvenuto non spedibile dal numero nuovo (${spedibile.motivo}, sid ${spedibile.sidTradotto}): parte dal numero storico — ${spedibile.errore ?? 'senza dettaglio'}`,
    );
    return indietro(spedibile.motivo);
  }

  return { from: secondo, secondario: true, scelta, ripiego: null };
}
