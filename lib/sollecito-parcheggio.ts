/**
 * Il sollecito prima del parcheggio (PO 29/10/2026).
 *
 * Oggi il bot manda UN messaggio di apertura; chi non risponde chiude NON_RISPOSTO a
 * 24h e il CRM lo parcheggia. Il 69% di quei parcheggiati aveva letto l'apertura.
 * Decisione di Bruno: prima di darlo per perso, il bot manda un solo secondo
 * messaggio (template), dallo stesso numero dell'apertura.
 *
 * Tempi:
 * - il sollecito parte da `SOLLECITO_DOPO_H` (20h) dopo l'apertura, solo in fascia
 *   08:30-20:30 (`inSendWindow`). L'apertura parte fra le 07 e le 23, quindi il
 *   sollecito cade fra 20h e 25h30 dopo (chi apre fra le 07 e le 12:30 lo riceve alle
 *   08:30 del giorno dopo);
 * - ultimo momento utile `SOLLECITO_ULTIMO_H` (30h): oltre non si manda piu', il lead
 *   si chiude come oggi (copre la coda delle 08:30 quando i run sono pieni);
 * - dopo il sollecito il NON_RISPOSTO aspetta `SOLLECITO_RESA_H` (24h): chi risponde
 *   a un template a freddo lo fa quasi sempre in giornata, e 24h e' la stessa resa che
 *   il bot da' a chi smette di rispondere (TRACKB_GIVEUP_H). Totale: il parcheggio
 *   arriva a ~44-50h dall'apertura invece di 24h, solo per chi riceve il sollecito.
 *
 * Qualita' dei numeri (fondamentale):
 * - mai dal 3199 (primario), mai da un numero a tetto 0 in `tetti_numeri`, in pausa
 *   per il cron qualita-numeri, o che oggi non e' stato letto HIGH;
 * - tetto giornaliero di solleciti per numero (`app_settings.sollecito_parcheggio`);
 * - il template dev'essere approvato su Meta per l'account di quel numero.
 * Se il numero non puo', il lead si chiude come oggi, senza sollecito e senza attese.
 *
 * Interruttore: `app_settings.sollecito_parcheggio` = {"attivo": bool,
 * "tetto_giorno_numero": int}. Riga assente, illeggibile o attivo != true = spento:
 * tutto torna esattamente com'era (nessun invio, NON_RISPOSTO a 24h). Il template sta
 * in `SOLLECITO_PARCHEGGIO_SID` (SID dell'account storico, tradotto per nome sugli
 * altri; piu' SID separati da virgola = varianti, scelte per id della conversazione).
 *
 * Misura: eventi `sollecito_inviato` (con numero e se l'apertura era stata letta) e
 * `risposta_dopo_sollecito` (la prima risposta del lead dopo il sollecito).
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { inSendWindow, anyDelivered, firstOutboundAtMs, toRomeIso, type MsgLite } from './sequence';
import { numeroPrimario } from './mittente';
import { getTettiNumeri, tettoDi } from './tetti-numeri';
import { giornoRoma, soloNumero, type StatoQualita } from './qualita-numeri';
import { traduciTemplate } from './template-account';
import { getTemplateApproval } from './twilio';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const H = 3600_000;

export const SOLLECITO_DOPO_H = 20;
export const SOLLECITO_ULTIMO_H = 30;
export const SOLLECITO_RESA_H = 24;

export const KEY_IMPOSTAZIONI = 'sollecito_parcheggio';

export type Impostazioni = { attivo: boolean; tettoGiornoNumero: number };

/** Fallisce chiuso: qualunque cosa diversa da `attivo: true` e tetto intero > 0 = spento. */
export function parseImpostazioni(raw: unknown): Impostazioni {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { attivo: false, tettoGiornoNumero: 0 };
  const r = raw as Record<string, unknown>;
  const t = typeof r.tetto_giorno_numero === 'number' ? r.tetto_giorno_numero : Number(r.tetto_giorno_numero);
  const tetto = Number.isInteger(t) && t > 0 ? t : 0;
  return { attivo: r.attivo === true && tetto > 0, tettoGiornoNumero: tetto };
}

/** I SID del sollecito (account storico), da `SOLLECITO_PARCHEGGIO_SID`, separati da virgola. */
export function sollecitoSids(env: Record<string, string | undefined> = process.env): string[] {
  return (env.SOLLECITO_PARCHEGGIO_SID ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Quale variante tocca a questa conversazione (stabile: sempre la stessa per la stessa chat). */
export function sidPerConversazione(sids: string[], conversationId: number): string | null {
  if (!sids.length) return null;
  return sids[Math.abs(conversationId) % sids.length];
}

const out = (msgs: MsgLite[]) => msgs.filter((m) => m.direction === 'out');

/** L'ultimo sollecito nella cronologia (qualunque stato), o null. */
export function sollecitoInCronologia(msgs: MsgLite[], sids: string[]): MsgLite | null {
  const s = out(msgs).filter((m) => m.template_sid != null && sids.includes(m.template_sid));
  return s.length ? s[s.length - 1] : null;
}

const fallito = (m: MsgLite) => m.twilio_status === 'failed' || m.twilio_status === 'undelivered';

export type DecisioneInvio =
  | { invia: true }
  | { invia: false; motivo: 'risposto' | 'gia_inviato' | 'mai_consegnato' | 'presto' | 'tardi' | 'fuori_fascia' | 'nessuna_apertura' };

/**
 * Il sollecito tocca a questo lead adesso? Puro. Il numero e il tetto si guardano a
 * parte (`ContestoSollecito`).
 */
export function decidiInvio(input: { nowMs: number; msgs: MsgLite[]; sids: string[] }): DecisioneInvio {
  const { nowMs, msgs, sids } = input;
  if (msgs.some((m) => m.direction === 'in')) return { invia: false, motivo: 'risposto' };
  if (sollecitoInCronologia(msgs, sids)) return { invia: false, motivo: 'gia_inviato' };
  const t0 = firstOutboundAtMs(msgs);
  if (t0 === null) return { invia: false, motivo: 'nessuna_apertura' };
  // Un'apertura mai arrivata (quasi sempre numero senza WhatsApp): un secondo template
  // farebbe la stessa fine. Quel lead torna ai GDO da chiamare a voce, come oggi.
  if (!anyDelivered(msgs)) return { invia: false, motivo: 'mai_consegnato' };
  const ore = (nowMs - t0) / H;
  if (ore < SOLLECITO_DOPO_H) return { invia: false, motivo: 'presto' };
  if (ore >= SOLLECITO_ULTIMO_H) return { invia: false, motivo: 'tardi' };
  if (!inSendWindow(nowMs)) return { invia: false, motivo: 'fuori_fascia' };
  return { invia: true };
}

/**
 * Il NON_RISPOSTO puo' partire adesso, o il lead aspetta il sollecito (o la risposta
 * al sollecito)? Puro. `puoRicevere` = interruttore acceso e numero idoneo oggi.
 */
export function decidiChiusura(input: {
  nowMs: number;
  msgs: MsgLite[];
  sids: string[];
  puoRicevere: boolean;
}): 'chiudi' | 'aspetta' {
  const { nowMs, msgs, sids, puoRicevere } = input;
  const s = sollecitoInCronologia(msgs, sids);
  if (s) {
    // Sollecito partito: 24h per rispondere. Se non e' arrivato, non c'e' niente da aspettare.
    if (fallito(s)) return 'chiudi';
    return nowMs - Date.parse(s.created_at) < SOLLECITO_RESA_H * H ? 'aspetta' : 'chiudi';
  }
  if (!puoRicevere || !sids.length) return 'chiudi';
  const t0 = firstOutboundAtMs(msgs);
  if (t0 === null || !anyDelivered(msgs)) return 'chiudi';
  return nowMs - t0 < SOLLECITO_ULTIMO_H * H ? 'aspetta' : 'chiudi';
}

export type MotivoNumero =
  | 'primario' | 'senza_numero' | 'tetto_numeri_zero' | 'in_pausa_qualita' | 'non_high_oggi' | 'tetto_solleciti';

/** Il numero puo' mandare un sollecito oggi? Puro (tutto quello che serve e' gia' letto). */
export function numeroIdoneo(input: {
  numero: string | null | undefined;
  primario: string | null | undefined;
  tetti: Map<string, number> | null;
  stato: StatoQualita | null;
  oggi: string;
  inviatiOggi: number;
  tettoGiorno: number;
}): { ok: true } | { ok: false; motivo: MotivoNumero } {
  const num = soloNumero(input.numero ?? '');
  if (!num) return { ok: false, motivo: 'senza_numero' };
  if (input.primario && soloNumero(input.primario) === num) return { ok: false, motivo: 'primario' };
  if (!input.tetti || tettoDi(input.tetti, num) <= 0) return { ok: false, motivo: 'tetto_numeri_zero' };
  if (input.stato?.pause?.[num]) return { ok: false, motivo: 'in_pausa_qualita' };
  // La lettura peggiore di oggi (cron qualita-numeri, dalle 06:10). Nessuna lettura
  // oggi = non si sa = niente sollecito.
  if (input.stato?.storico?.[num]?.[input.oggi] !== 'HIGH') return { ok: false, motivo: 'non_high_oggi' };
  if (input.inviatiOggi >= input.tettoGiorno) return { ok: false, motivo: 'tetto_solleciti' };
  return { ok: true };
}

/** Mezzanotte di Roma di oggi, ISO con offset. */
export function inizioGiornoRomaIso(nowMs: number): string {
  const offset = toRomeIso(nowMs).slice(-6);
  return `${giornoRoma(new Date(nowMs))}T00:00:00${offset}`;
}

/**
 * Tutto quello che serve per decidere sul numero, letto una volta per run. Spento
 * (null) se l'interruttore e' spento o manca il SID: chi chiama si comporta come prima.
 */
export type ContestoSollecito = {
  sids: string[];
  tettoGiorno: number;
  /** Il numero puo' mandare ADESSO (tetto incluso, template approvato su quell'account)? */
  idoneo: (numero: string | null | undefined) => Promise<{ ok: true } | { ok: false; motivo: MotivoNumero | 'template_non_approvato' }>;
  /** Da chiamare dopo un invio riuscito: tiene il conto del tetto dentro il run. */
  contaInvio: (numero: string) => void;
};

export async function caricaContesto(supabase: Supa, nowMs: number = Date.now()): Promise<ContestoSollecito | null> {
  const sids = sollecitoSids();
  if (!sids.length) return null;
  const { data: riga, error } = await supabase.from('app_settings').select('value').eq('key', KEY_IMPOSTAZIONI).maybeSingle();
  if (error) return null;
  const imp = parseImpostazioni((riga as { value?: unknown } | null)?.value);
  if (!imp.attivo) return null;

  const tetti = await getTettiNumeri(supabase);
  const { data: rigaStato } = await supabase.from('app_settings').select('value').eq('key', 'qualita_numeri_stato').maybeSingle();
  const stato = ((rigaStato as { value?: StatoQualita } | null)?.value ?? null) as StatoQualita | null;
  const oggi = giornoRoma(new Date(nowMs));

  // Solleciti gia' partiti oggi, per numero (indice event_log_type_idx).
  const inviati = new Map<string, number>();
  const { data: ev, error: errEv } = await supabase
    .from('event_log')
    .select('payload')
    .eq('type', 'sollecito_inviato')
    .gte('created_at', inizioGiornoRomaIso(nowMs))
    .limit(1000);
  // Senza il conto il tetto non si puo' rispettare: spento per questo run.
  if (errEv) return null;
  for (const e of (ev ?? []) as { payload?: { numero?: string } }[]) {
    const n = soloNumero(e.payload?.numero ?? '');
    if (n) inviati.set(n, (inviati.get(n) ?? 0) + 1);
  }

  const approvato = new Map<string, Promise<boolean>>();
  const templateApprovato = (numero: string): Promise<boolean> => {
    const k = soloNumero(numero);
    let p = approvato.get(k);
    if (!p) {
      p = (async () => {
        const from = `whatsapp:${k}`;
        for (const sid of sids) {
          try {
            const t = await traduciTemplate(sid, from);
            if (!t.tradotto) return false;
            const a = await getTemplateApproval(t.sid, from);
            if (a.status !== 'approved') return false;
          } catch {
            return false;
          }
        }
        return true;
      })();
      approvato.set(k, p);
    }
    return p;
  };

  const primario = numeroPrimario();
  return {
    sids,
    tettoGiorno: imp.tettoGiornoNumero,
    idoneo: async (numero) => {
      const r = numeroIdoneo({
        numero, primario, tetti, stato, oggi,
        inviatiOggi: inviati.get(soloNumero(numero ?? '')) ?? 0,
        tettoGiorno: imp.tettoGiornoNumero,
      });
      if (!r.ok) return r;
      return (await templateApprovato(numero as string)) ? { ok: true } : { ok: false, motivo: 'template_non_approvato' };
    },
    contaInvio: (numero) => {
      const k = soloNumero(numero);
      inviati.set(k, (inviati.get(k) ?? 0) + 1);
    },
  };
}

/**
 * Prima risposta del lead dopo un sollecito: un evento `risposta_dopo_sollecito`.
 * Si chiama dal webhook dopo aver registrato l'inbound. Mai bloccante: un errore qui
 * non deve fermare la risposta al lead.
 */
export async function segnaRispostaDopoSollecito(supabase: Supa, conversationId: number): Promise<void> {
  const sids = sollecitoSids();
  if (!sids.length) return;
  try {
    const { data: s } = await supabase
      .from('messages')
      .select('created_at, template_sid')
      .eq('conversation_id', conversationId)
      .eq('direction', 'out')
      .in('template_sid', sids)
      .order('created_at', { ascending: false })
      .limit(1);
    const sollecito = (s ?? [])[0] as { created_at: string; template_sid: string } | undefined;
    if (!sollecito) return;
    const { data: ins } = await supabase
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('direction', 'in')
      .gt('created_at', sollecito.created_at)
      .limit(2);
    // Solo la PRIMA risposta (quella appena registrata).
    if ((ins ?? []).length !== 1) return;
    const { data: conv } = await supabase
      .from('conversations')
      .select('wa_number, crm_lead_id, bot_outcome')
      .eq('id', conversationId)
      .maybeSingle();
    const c = conv as { wa_number?: string | null; crm_lead_id?: string | null; bot_outcome?: string | null } | null;
    const ore = Math.round(((Date.now() - Date.parse(sollecito.created_at)) / H) * 10) / 10;
    await supabase.from('event_log').insert({
      type: 'risposta_dopo_sollecito',
      level: 'info',
      payload: {
        conversationId,
        crmLeadId: c?.crm_lead_id ?? null,
        numero: c?.wa_number ?? null,
        sid: sollecito.template_sid,
        oreDopoSollecito: ore,
        // Gia' parcheggiato quando risponde (oltre le 24h di attesa)?
        esitoGiaDato: c?.bot_outcome ?? null,
      } as never,
      message: `[sollecito] conv ${conversationId}: il lead ha risposto ${ore}h dopo il sollecito`,
    });
  } catch {
    // misura persa, risposta al lead salva
  }
}
