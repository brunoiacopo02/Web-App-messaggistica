/**
 * Da quale numero parte il BENVENUTO DEL LANCIO.
 *
 * Dal 26/09/2026 la scelta ordinaria di un secondario e' una sola, `scegliMittenteNuovo`
 * (lib/scelta-mittente.ts): tetti in `app_settings.tetti_numeri`, meno chat nate oggi
 * vince, verifica di spedibilita' del template. Questo modulo aggiunge UNA regola in
 * piu', e soltanto per il lancio:
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
 * Questo file non verifica piu' da solo: la verifica di spedibilita' e i tetti sono
 * dentro `scegliMittenteNuovo`, che sceglie un secondario SOLO se e' spedibile davvero
 * (e logga lui i numeri scartati). Un secondario scelto da `scegliMittenteNuovo` e' gia'
 * passato da tutti quei controlli; se non lo sceglie qui si ripiega sul numero storico
 * col motivo che lui restituisce, e SOLO sul lancio si scrive anche
 * `lancio_mittente_ripiego`: il lancio VOLEVA un secondario (sender o quota), a
 * differenza di Mario dove "nessun secondario" e' lo stato ordinario e non e' una
 * notizia.
 *
 * ── Una chat che esiste gia' non cambia numero ─────────────────────────────────────
 * La quota si applica SOLO alla prima apertura. Da li' in poi comanda
 * `mittenteDiConversazione`: cambiare numero a chat aperta la spezza in due thread e
 * chiude la finestra delle 24 ore.
 */

import type { getSupabaseAdmin } from './supabase/admin';
import type { LancioSettings } from './lancio-settings';
import { scegliMittenteNuovo, type SceltaMittente } from './scelta-mittente';
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

/** Perche' `scegliMittenteNuovo` non ha scelto un secondario, quando si sarebbe voluto. */
export type MotivoRipiego = 'nessun_candidato' | 'tetti_illeggibili' | 'nessun_secondario';

/**
 * Il motivo di `scegliMittenteNuovo` su un esito non secondario. `'scelto'` non puo'
 * arrivare qui (se ha scelto, `secondario` e' `true`): resta per tipo, e nel dubbio si
 * ripiega sul motivo piu' generico invece di rompere con un cast non sicuro.
 */
function motivoRipiego(motivo: SceltaMittente['motivo']): MotivoRipiego {
  switch (motivo) {
    case 'nessun_candidato': return 'nessun_candidato';
    case 'tetti_illeggibili': return 'tetti_illeggibili';
    case 'nessun_secondario': return 'nessun_secondario';
    case 'scelto': return 'nessun_candidato';
  }
}

/** Il numero scelto, e perche'. `ripiego` valorizzato = si voleva il nuovo e non si e' potuto. */
export type EsitoMittenteLancio = {
  from: string;
  secondario: boolean;
  /** `quota` o `sender` quando si e' scelto il nuovo; `principale` quando non toccava. */
  scelta: 'principale' | 'quota' | 'sender';
  ripiego: MotivoRipiego | null;
};

/**
 * Il mittente del benvenuto di un lead del lancio che sta entrando ADESSO.
 *
 * Ordine delle regole, come da delibera PO:
 * 1. `lancio_sender = 'secondario'` VINCE: e' una scelta umana dal pannello, va tutto li'
 *    (e ignora i tetti: se il PO sposta il lancio sul numero nuovo, un tetto automatico
 *    non deve rimangiarsi la decisione a meta' giornata, in silenzio).
 * 2. altrimenti si applica la quota, e sotto c'e' la scelta unica di tutto il bot
 *    (`scegliMittenteNuovo`, lib/scelta-mittente.ts), che rispetta i tetti di
 *    `app_settings.tetti_numeri` e verifica che il template sia spedibile: la quota e'
 *    un rivolo automatico, e un rivolo non puo' sfondare il tetto che protegge il numero.
 */
export async function mittenteBenvenutoLancio(
  supabase: Supa,
  i: {
    settings: Pick<LancioSettings, 'sender' | 'quotaSecondario'>;
    /** L'identita' stabile del lead: il telefono E.164. */
    chiave: string;
    templateSid: string;
    primario: string;
    crmLeadId?: string | null;
  },
): Promise<EsitoMittenteLancio> {
  const perSender = i.settings.sender === 'secondario';
  const perQuota = !perSender && toccaAlSecondario(i.chiave, i.settings.quotaSecondario);
  if (!perSender && !perQuota) {
    return { from: i.primario, secondario: false, scelta: 'principale', ripiego: null };
  }
  const scelta: 'quota' | 'sender' = perSender ? 'sender' : 'quota';
  // La scelta del numero e' quella di tutto il bot (lib/scelta-mittente.ts): verifica
  // che il benvenuto sia spedibile, e logga lei i numeri scartati. `sender` e' una
  // decisione umana dal pannello e scavalca i tetti; la quota automatica li rispetta.
  const r = await scegliMittenteNuovo(supabase, {
    templateSids: [i.templateSid],
    chiave: i.chiave,
    crmLeadId: i.crmLeadId ?? null,
    ignoraTetti: perSender,
  });
  if (!r.secondario) {
    const ripiego = motivoRipiego(r.motivo);
    // Il lancio VOLEVA un secondario (sender o quota, non e' il caso ordinario di
    // `scegliMittenteNuovo` su Mario dove "nessun secondario" e' lo stato normale): un
    // ripiego silenzioso qui e' un benvenuto che si sposta di numero senza che nessuno
    // se ne accorga. Best-effort come il resto del repo: un insert fallito non deve
    // impedire l'invio dal numero storico.
    await supabase
      .from('event_log')
      .insert({
        type: 'lancio_mittente_ripiego',
        level: 'warn',
        payload: { chiave: i.chiave, crmLeadId: i.crmLeadId ?? null, scelta, motivo: ripiego, scartati: r.scartati } as never,
        message: `[lancio] benvenuto da mandare dal numero secondario (${scelta}) ma resta sul numero storico: ${ripiego}`,
      })
      .then(() => undefined, () => undefined);
    return { from: i.primario, secondario: false, scelta, ripiego };
  }
  return { from: r.from, secondario: true, scelta, ripiego: null };
}
