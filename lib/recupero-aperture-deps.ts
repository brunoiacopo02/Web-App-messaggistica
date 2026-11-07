/**
 * Le dipendenze vere (Supabase, Twilio, CRM) del recupero delle aperture mai partite.
 * Le regole stanno in lib/recupero-aperture.ts, che si testa con dipendenze finte.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { fetchAllRows } from './supabase/paginate';
import { FILTRO_FUORI_LANCIO } from './lancio-fase';
import { stopDalCrmPerLead } from './stop-crm';
import { sendOutcome } from './bot-outcome';
import { esitoAperturaMaiPartita } from './bot-followups';
import { inviaAperturaMario } from './apertura-mario-invio';
import { eNumeroDelBot } from './mittente';
import { getTettiNumeri, getStatoQualitaNumeri, tettoDi } from './tetti-numeri';
import { apertureMarioOggi, inizioGiornataRoma } from './bot2-tetto';
import { sidAperturaMario } from './scelta-mittente';
import { credenzialiPerMittente, eSuAltroAccount } from './twilio-account';
import { spedibileDa } from './spedibilita';
import {
  ERRORI_DESTINATARIO_DEFINITIVI,
  EVENTO_RECUPERO_INVIATA,
  EVENTO_RECUPERO_SALTATA,
  motivoLavoratoDalCrm,
  type StatoCrmRecupero,
  RECUPERO_CODA_DAL_MS,
  RECUPERO_FINO_AL_MS,
  qualitaAmmessaRecupero,
  type ChatCoda,
  type NumeroRecupero,
  type ConfigRecupero,
  type ConteggioMessaggi,
  type DepsRecupero,
} from './recupero-aperture';

type Supa = ReturnType<typeof getSupabaseAdmin>;

function giornoRomaDi(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function contaEventiOggi(supabase: Supa, type: string, filtri: Record<string, string>, adesso: Date): Promise<number | null> {
  try {
    let q = supabase.from('event_log').select('id', { count: 'exact', head: true }).eq('type', type);
    for (const [k, v] of Object.entries(filtri)) q = q.eq(`payload->>${k}`, v);
    const { count, error } = await q.gte('created_at', inizioGiornataRoma(adesso));
    if (error || count === null || count === undefined) return null;
    return count;
  } catch {
    return null;
  }
}

export function depsRecupero(supabase: Supa, cfg: ConfigRecupero, adesso: Date): DepsRecupero {
  const log: DepsRecupero['log'] = async (type, level, payload, message) => {
    await supabase.from('event_log').insert({ type, level, payload: payload as never, message }).then(() => undefined, () => undefined);
  };
  const configLoggati = new Set<string>();
  const logConfig = (tipo: string) => async (key: string) => {
    if (configLoggati.has(key)) return;
    configLoggati.add(key);
    await log(tipo, 'warn', { missing: [key], dove: 'recupero-aperture' }, `[recupero-aperture] env mancante: ${key}`);
  };

  return {
    contaInviateOggi: () => contaEventiOggi(supabase, EVENTO_RECUPERO_INVIATA, {}, adesso),

    caricaCoda: async () => {
      const righe = await fetchAllRows<Record<string, unknown>>((from, to) =>
        supabase
          .from('conversations')
          .select('id, ai_started_at, crm_lead_id, crm_funnel, wa_number, leads(phone_e164, first_name)')
          .eq('ai_status', 'active')
          .not('crm_lead_id', 'is', null)
          .is('bot_outcome', null)
          .is('gdo_agenda_at', null)
          .is('ai_paused_at', null)
          .or(FILTRO_FUORI_LANCIO)
          .lt('ai_started_at', new Date(RECUPERO_FINO_AL_MS).toISOString())
          .gte('ai_started_at', new Date(RECUPERO_CODA_DAL_MS).toISOString())
          .order('ai_started_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to) as never,
      );
      return righe.map((r): ChatCoda => {
        const lead = (r.leads ?? null) as { phone_e164?: string | null; first_name?: string | null } | null;
        return {
          id: r.id as number,
          ai_started_at: (r.ai_started_at as string | null) ?? null,
          crm_lead_id: (r.crm_lead_id as string | null) ?? null,
          crm_funnel: (r.crm_funnel as string | null) ?? null,
          wa_number: (r.wa_number as string | null) ?? null,
          phone: lead?.phone_e164 ?? null,
          firstName: lead?.first_name ?? null,
        };
      });
    },

    contaMessaggi: async (ids) => {
      const out = new Map<number, ConteggioMessaggi>();
      try {
        for (let i = 0; i < ids.length; i += 100) {
          const blocco = ids.slice(i, i + 100);
          const righe = await fetchAllRows<{ conversation_id: number; direction: string }>((from, to) =>
            supabase
              .from('messages')
              .select('conversation_id, direction')
              .in('conversation_id', blocco)
              .order('id', { ascending: true })
              .range(from, to) as never,
          );
          for (const m of righe) {
            const v = out.get(m.conversation_id) ?? { out: 0, in: 0 };
            if (m.direction === 'out') v.out++;
            else if (m.direction === 'in') v.in++;
            out.set(m.conversation_id, v);
          }
        }
        return out;
      } catch (e) {
        console.error('[recupero-aperture] lettura messaggi fallita', e);
        return null;
      }
    },

    stopCrm: (crmLeadId) => stopDalCrmPerLead(supabase, crmLeadId),

    lavoratoDalCrm: async (crmLeadId) => {
      if (!crmLeadId) return null;
      try {
        const { data, error } = await supabase
          .from('crm_lead_status')
          .select('status, appointment_date, recall_at, conferme_outcome')
          .eq('lead_id', crmLeadId)
          .maybeSingle();
        if (error) return 'crm_illeggibile';
        return motivoLavoratoDalCrm(data as StatoCrmRecupero | null);
      } catch {
        return 'crm_illeggibile';
      }
    },

    numeroNonWhatsapp: async (phone) => {
      try {
        const { data: leads, error: e1 } = await supabase.from('leads').select('id').eq('phone_e164', phone);
        if (e1) return null;
        const leadIds = (leads ?? []).map((l) => (l as { id: number }).id);
        if (leadIds.length === 0) return false;
        const { data: convs, error: e2 } = await supabase.from('conversations').select('id').in('lead_id', leadIds);
        if (e2) return null;
        const convIds = (convs ?? []).map((c) => (c as { id: number }).id);
        if (convIds.length === 0) return false;
        const { data: errati, error: e3 } = await supabase
          .from('messages')
          .select('id')
          .in('conversation_id', convIds)
          .eq('direction', 'out')
          .in('twilio_error_code', ERRORI_DESTINATARIO_DEFINITIVI)
          .limit(1);
        if (e3) return null;
        return (errati ?? []).length > 0;
      } catch {
        return null;
      }
    },

    numeriUtilizzabili: async () => {
      const ok: NumeroRecupero[] = [];
      const scarti: { numero: string; motivo: string }[] = [];
      const tetti = await getTettiNumeri(supabase);
      const stato = await getStatoQualitaNumeri(supabase);
      const oggi = giornoRomaDi(adesso);
      const ieri = giornoRomaDi(new Date(adesso.getTime() - 24 * 3600_000));
      const sids = sidAperturaMario();
      for (const numero of cfg.numeri) {
        if (!eNumeroDelBot(numero)) { scarti.push({ numero, motivo: 'non_del_bot' }); continue; }
        if (tetti === null) { scarti.push({ numero, motivo: 'tetti_illeggibili' }); continue; }
        if (tettoDi(tetti, numero) <= 0) { scarti.push({ numero, motivo: 'tetto_zero' }); continue; }
        const tettoRecupero = cfg.tettiNumero.get(numero);
        if (!qualitaAmmessaRecupero(stato, numero, oggi, ieri, tettoRecupero)) {
          scarti.push({ numero, motivo: 'non_high_o_in_pausa' }); continue;
        }
        if (eSuAltroAccount(numero) && credenzialiPerMittente(numero)?.sid === process.env.TWILIO_ACCOUNT_SID) {
          scarti.push({ numero, motivo: 'credenziali_mancanti' }); continue;
        }
        if (sids.length === 0) { scarti.push({ numero, motivo: 'nessun_template' }); continue; }
        let bloccato: string | null = null;
        for (const sid of sids) {
          const s = await spedibileDa(sid, numero);
          if (!s.ok) { bloccato = s.motivo; break; }
        }
        if (bloccato) { scarti.push({ numero, motivo: bloccato }); continue; }
        const mario = await apertureMarioOggi(supabase as never, numero, adesso);
        const recuperi = await contaEventiOggi(supabase, EVENTO_RECUPERO_INVIATA, { numero }, adesso);
        if (mario === null || recuperi === null) { scarti.push({ numero, motivo: 'conteggio_fallito' }); continue; }
        if (tettoRecupero !== undefined && recuperi >= tettoRecupero) {
          scarti.push({ numero, motivo: 'tetto_recupero_raggiunto' }); continue;
        }
        ok.push({ numero, carico: mario + recuperi, recuperiOggi: recuperi, tettoRecupero });
      }
      return { ok, scarti };
    },

    riassegnaNumero: async (id, numero) => {
      const { error } = await supabase.from('conversations').update({ wa_number: numero }).eq('id', id);
      return !error;
    },

    invia: async (c, numero) => {
      if (!c.phone) return { ok: false, error: 'senza_telefono' };
      const r = await inviaAperturaMario(supabase, {
        conversationId: c.id, phone: c.phone, firstName: c.firstName, funnel: c.crm_funnel, from: numero,
        logConfigError: logConfig('sequence_config_error'),
        logOpeningConfigError: logConfig('opening_config_error'),
      });
      if (!r.tentato) return { ok: false, error: r.error, configMancante: true };
      return { ok: r.ok, capped: r.capped, error: r.error };
    },

    restituisci: (c) => sendOutcome(supabase, c.id, esitoAperturaMaiPartita()),

    saltataOggi: async (id, motivo) => {
      const n = await contaEventiOggi(supabase, EVENTO_RECUPERO_SALTATA, { conversationId: String(id), motivo }, adesso);
      return n !== null && n > 0;
    },

    log,
  };
}
