/**
 * A/B del touch "ti ho scritto ieri" (PO 07/11/2026).
 *
 * Il touch e' il template MARKETING `fenice_seq_touch1_marta_v1` (o la sua versione Mario,
 * `SEQ_TEMPLATE_SID_1`) a chi non ha MAI risposto all'apertura. Spento dal 24/09 per la
 * qualita' dei numeri. L'analisi del 07/11 gli attribuisce ~12-14k € in due mesi, ma il
 * totale settimanale non cala quando lo si spegne: serve un confronto vero.
 *
 * Disegno:
 * - un solo numero (`numero`, HIGH, mai 0047 ne' 3199), conversazioni arruolate da `dal`
 *   (giorno di Roma, incluso) a `fino` (escluso);
 * - braccio per conversazione, stabile, dalla parita' dell'id: `braccio_touch` dice quale
 *   parita' riceve il touch (default 'dispari'); l'altra e' il controllo, che resta
 *   com'e' oggi (NON_RISPOSTO a 24h dall'apertura);
 * - il touch parte con la stessa finestra del sollecito prima del parcheggio
 *   (lib/sollecito-parcheggio.ts): da 20h a 30h dopo l'apertura, solo 08:30-20:30, solo se
 *   l'apertura e' stata consegnata; la chiusura NON_RISPOSTO del braccio touch aspetta
 *   il touch e poi 24h la risposta (`decidiChiusura`);
 * - STOP GLOBALE A SCATTO: appena il numero del test ha una lettura MEDIUM o LOW (o va in
 *   pausa, o a tetto 0), il test si ferma e scrive `fermato` nella riga. Non riparte da
 *   solo: per riaccenderlo una persona deve togliere `fermato` (o rimetterlo a null).
 *   Una lettura mancante (cron giu') sospende gli invii di quel giro ma non scatta lo stop.
 *
 * Interruttore, tutto in `app_settings.touch_ab_test` (niente deploy):
 *   {"attivo": false, "numero": "+393522018718", "dal": "2026-11-14", "fino": "2026-12-05",
 *    "braccio_touch": "dispari", "fermato": null}
 * Riga assente, illeggibile, `attivo` != true, date o numero non validi = spento: tutto
 * come oggi. Il nudge "ci eravamo persi" NON c'entra e resta spento (SEQUENCE_ENABLED).
 *
 * Misura (eventi in event_log, tutti con conversationId e crmLeadId):
 * - `touch_ab_assegnato` una volta per conversazione, ENTRAMBI i bracci, quando la chat
 *   diventa idonea (mai risposto, apertura consegnata, 20h dall'apertura);
 * - `touch_ab_inviato` / `touch_ab_invio_fallito` sul braccio touch;
 * - `touch_ab_fermato` quando scatta lo stop.
 * La popolazione si ricostruisce anche senza eventi (parita' dell'id + wa_number + data di
 * arruolamento + nessun inbound nelle prime 20h): vedi `braccioTouchAb`.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { soloNumero, giornoRoma, type StatoQualita } from './qualita-numeri';
import { numeroHighOggi } from './numero-high';
import { anyDelivered, firstOutboundAtMs, type MsgLite } from './sequence';
import { SOLLECITO_DOPO_H } from './sollecito-parcheggio';
import { traduciTemplate } from './template-account';
import { getTemplateApproval } from './twilio';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const H = 3600_000;

export const KEY_TOUCH_AB = 'touch_ab_test';
/** Mai su questi numeri, qualunque cosa dica la riga (PO 07/11/2026). */
export const NUMERI_ESCLUSI_TOUCH_AB = ['+393522070047', '+393520413199'];

export type BraccioTouch = 'touch' | 'controllo';

export type ConfigTouchAb = {
  numero: string;
  dal: string;
  fino: string;
  braccioTouch: 'pari' | 'dispari';
};

export type Fermato = { giorno: string; at: string; motivo: string; qualita?: string };

const GIORNO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * La riga grezza → config, o null (= spento). Fallisce chiuso. `fermato` valorizzato = spento.
 */
export function parseConfigTouchAb(raw: unknown): { config: ConfigTouchAb | null; fermato: Fermato | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, fermato: null };
  const r = raw as Record<string, unknown>;
  const fermato = r.fermato && typeof r.fermato === 'object' ? (r.fermato as Fermato) : null;
  if (r.attivo !== true || fermato) return { config: null, fermato };
  const numero = soloNumero(String(r.numero ?? ''));
  if (!/^\+\d{8,15}$/.test(numero) || NUMERI_ESCLUSI_TOUCH_AB.includes(numero)) return { config: null, fermato: null };
  const dal = String(r.dal ?? '');
  const fino = String(r.fino ?? '');
  if (!GIORNO.test(dal) || !GIORNO.test(fino) || fino <= dal) return { config: null, fermato: null };
  const braccioTouch = r.braccio_touch === 'pari' ? 'pari' : 'dispari';
  return { config: { numero, dal, fino, braccioTouch }, fermato: null };
}

/** Il braccio di una conversazione: solo la parita' dell'id. Puro, stabile. */
export function braccioTouchAb(conversationId: number, braccioTouch: 'pari' | 'dispari' = 'dispari'): BraccioTouch {
  const dispari = Math.abs(conversationId) % 2 === 1;
  return (braccioTouch === 'dispari') === dispari ? 'touch' : 'controllo';
}

/** La conversazione e' del test? (numero del test, arruolata dentro [dal, fino) di Roma.) */
export function nelTestTouchAb(
  config: ConfigTouchAb,
  conv: { wa_number?: string | null; ai_started_at?: string | null },
): boolean {
  if (!conv.wa_number || soloNumero(conv.wa_number) !== config.numero) return false;
  if (!conv.ai_started_at) return false;
  const giorno = giornoRoma(new Date(conv.ai_started_at));
  return giorno >= config.dal && giorno < config.fino;
}

/**
 * Idonea all'assegnazione: mai risposto, apertura consegnata, almeno 20h dall'apertura.
 * Uguale per i due bracci (il controllo non riceve niente ma si conta lo stesso).
 */
export function idoneaTouchAb(msgs: MsgLite[], nowMs: number): boolean {
  if (msgs.some((m) => m.direction === 'in')) return false;
  const t0 = firstOutboundAtMs(msgs);
  if (t0 === null || !anyDelivered(msgs)) return false;
  return nowMs - t0 >= SOLLECITO_DOPO_H * H;
}

/**
 * Lo stop a scatto: il numero del test oggi e' sotto HIGH, in pausa o a tetto 0? Puro.
 * `non_letto` (nessuna lettura oggi) NON e' uno stop: sospende solo gli invii.
 */
export function decidiStopTouchAb(input: {
  config: ConfigTouchAb;
  stato: StatoQualita | null;
  tetti: Record<string, unknown> | null;
  oggi: string;
}): { stop: true; motivo: string; qualita?: string } | { stop: false; puoInviare: boolean } {
  const q = numeroHighOggi({ numero: input.config.numero, stato: input.stato, tetti: input.tetti, oggi: input.oggi });
  if (q.ok) return { stop: false, puoInviare: true };
  if (q.motivo === 'sotto_high' || q.motivo === 'in_pausa' || q.motivo === 'tetto_zero') {
    return { stop: true, motivo: q.motivo, ...(q.qualita ? { qualita: q.qualita } : {}) };
  }
  return { stop: false, puoInviare: false };
}

export type ContestoTouchAb = {
  config: ConfigTouchAb;
  /** Numero HIGH oggi (e test gia' iniziato): il touch puo' partire adesso. */
  puoInviare: boolean;
  /** Il template (SID dell'account storico) e' approvato sull'account del numero? Memo per run. */
  templateOk: (sid: string) => Promise<boolean>;
  braccio: (conversationId: number) => BraccioTouch;
  nelTest: (conv: { wa_number?: string | null; ai_started_at?: string | null }) => boolean;
  /** Conversazioni con `touch_ab_assegnato` gia' scritto (letto una volta per run). */
  assegnate: Set<number>;
  /** Scrive `touch_ab_assegnato` una volta per conversazione (dentro il run e fra i run). */
  segnaAssegnata: (c: { id: number; crm_lead_id?: string | null }, dove: string) => Promise<void>;
};

/**
 * Carica il test per questo run. null = spento (o appena fermato): chi chiama fa come oggi.
 * Se il numero e' sceso sotto HIGH scrive lo stop nella riga e l'evento `touch_ab_fermato`.
 * Mai lancia: ogni errore = spento per questo run.
 */
export async function caricaTouchAb(
  supabase: Supa,
  nowMs: number = Date.now(),
): Promise<ContestoTouchAb | null> {
  try {
    const { data: riga, error } = await supabase.from('app_settings').select('value').eq('key', KEY_TOUCH_AB).maybeSingle();
    if (error || !riga) return null;
    const grezzo = (riga as { value?: unknown }).value;
    const { config } = parseConfigTouchAb(grezzo);
    if (!config) return null;
    const oggi = giornoRoma(new Date(nowMs));
    if (oggi >= config.fino) return null;

    const { data: rigaStato } = await supabase.from('app_settings').select('value').eq('key', 'qualita_numeri_stato').maybeSingle();
    const stato = ((rigaStato as { value?: StatoQualita } | null)?.value ?? null) as StatoQualita | null;
    const { data: rigaTetti } = await supabase.from('app_settings').select('value').eq('key', 'tetti_numeri').maybeSingle();
    const tetti = ((rigaTetti as { value?: Record<string, unknown> } | null)?.value ?? null);

    const d = decidiStopTouchAb({ config, stato, tetti, oggi });
    if (d.stop) {
      await fermaTouchAb(supabase, grezzo as Record<string, unknown>, { giorno: oggi, at: new Date(nowMs).toISOString(), motivo: d.motivo, qualita: d.qualita });
      return null;
    }

    const puoInviare = d.puoInviare && oggi >= config.dal;
    const memo = new Map<string, Promise<boolean>>();
    const templateOk = (sid: string): Promise<boolean> => {
      let p = memo.get(sid);
      if (!p) {
        p = (async () => {
          const ok = await templateApprovato(sid, config.numero);
          if (!ok) {
            await supabase.from('event_log').insert({
              type: 'touch_ab_template_non_approvato', level: 'warn',
              payload: { numero: config.numero, sid } as never,
              message: `[touch-ab] template ${sid} non approvato sull'account di ${config.numero}: nessun invio`,
            });
          }
          return ok;
        })();
        memo.set(sid, p);
      }
      return p;
    };

    const assegnate = new Set<number>();
    const { data: ev } = await supabase
      .from('event_log')
      .select('payload')
      .eq('type', 'touch_ab_assegnato')
      .gte('created_at', new Date(nowMs - 7 * 24 * H).toISOString())
      .limit(5000);
    for (const e of (ev ?? []) as { payload?: { conversationId?: number } }[]) {
      if (typeof e.payload?.conversationId === 'number') assegnate.add(e.payload.conversationId);
    }

    return {
      config,
      puoInviare,
      templateOk,
      braccio: (id) => braccioTouchAb(id, config.braccioTouch),
      nelTest: (conv) => nelTestTouchAb(config, conv),
      assegnate,
      segnaAssegnata: async (c, dove) => {
        if (assegnate.has(c.id)) return;
        assegnate.add(c.id);
        const braccio = braccioTouchAb(c.id, config.braccioTouch);
        await supabase.from('event_log').insert({
          type: 'touch_ab_assegnato', level: 'info',
          payload: { conversationId: c.id, crmLeadId: c.crm_lead_id ?? null, braccio, numero: config.numero, dove } as never,
          message: `[touch-ab] conv ${c.id}: braccio ${braccio}`,
        });
      },
    };
  } catch {
    return null;
  }
}

async function templateApprovato(sid: string, numero: string): Promise<boolean> {
  const from = `whatsapp:${numero}`;
  try {
    const t = await traduciTemplate(sid, from);
    if (!t.tradotto) return false;
    const a = await getTemplateApproval(t.sid, from);
    return a.status === 'approved';
  } catch {
    return false;
  }
}

/** Scrive lo stop nella riga (attivo resta com'era: serve una persona per toglierlo). */
async function fermaTouchAb(supabase: Supa, grezzo: Record<string, unknown>, fermato: Fermato): Promise<void> {
  await supabase.from('app_settings')
    .update({ value: { ...grezzo, fermato } as never, updated_at: fermato.at })
    .eq('key', KEY_TOUCH_AB);
  await supabase.from('event_log').insert({
    type: 'touch_ab_fermato', level: 'warn',
    payload: { ...fermato, numero: grezzo.numero ?? null } as never,
    message: `[touch-ab] test FERMATO: numero ${String(grezzo.numero ?? '')} ${fermato.motivo}${fermato.qualita ? ` (${fermato.qualita})` : ''}. Non riparte da solo: togliere "fermato" in app_settings.touch_ab_test`,
  });
}

/** Dal cron qualita-numeri, subito dopo la lettura: lo stop scatta alla lettura, non al primo invio. */
export async function controllaStopTouchAb(supabase: Supa, nowMs: number = Date.now()): Promise<void> {
  await caricaTouchAb(supabase, nowMs);
}

/** I SID del touch 1 (account storico), per persona. */
export function sidTouchPerPersona(persona: string, env: Record<string, string | undefined> = process.env): string | undefined {
  return persona === 'marta' ? env.MARTA_SEQ_TEMPLATE_SID_1 : env.SEQ_TEMPLATE_SID_1;
}
