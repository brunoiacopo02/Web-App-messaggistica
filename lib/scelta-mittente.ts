/**
 * Da quale numero nasce una chat NUOVA del bot. Unico punto di decisione dal
 * 26/09/2026 (spec 2026-09-26-parco-numeri-design.md): prima lo sceglieva il CRM
 * fra "bot 1" e "bot 2", e il tetto stava in due repo.
 *
 * Regola: fra i secondari con tetto > 0 (app_settings.tetti_numeri), che oggi non
 * l'hanno ancora raggiunto e da cui TUTTI i template richiesti sono spedibili, si
 * prende quello con meno chat nate oggi. Nessuno = il numero storico.
 *
 * Fallisce chiuso: tetti illeggibili, conteggio in errore, template che non esiste
 * sull'account del numero o che il presidio blocca — ogni dubbio toglie il numero
 * dai candidati. Il costo di sbagliare verso il 3199 e' un'apertura dal numero di
 * sempre; nell'altra direzione e' un lead muto o un numero bruciato.
 *
 * Il conteggio e l'INSERT della chat non sono atomici: due intake concorrenti
 * possono sforare il tetto di qualche unita'. Accettato: il tetto protegge la
 * qualita' del numero, non un contratto.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { numeroPrimario, numeriSecondari } from './mittente';
import { getTettiNumeri, tettoDi } from './tetti-numeri';
import { chatNateOggi } from './bot2-tetto';
import { spedibileDa } from './spedibilita';
import { OPENING_ENV_KEYS } from './persona';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type Scarto = {
  numero: string;
  motivo: 'tetto_zero' | 'tetto_raggiunto' | 'conteggio_fallito' | 'template_non_tradotto' | 'template_bloccato';
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

  const tetti = i.ignoraTetti ? null : await getTettiNumeri(supabase);
  if (!i.ignoraTetti && tetti === null) {
    await log(supabase, 'mittente_ripiego', 'warn', { ...base, motivo: 'tetti_illeggibili' },
      `[numeri] tetti illeggibili: ${i.chiave} nasce sul numero storico`);
    return alPrimario('tetti_illeggibili');
  }

  const scartati: Scarto[] = [];
  const candidati: { numero: string; oggi: number }[] = [];
  for (const numero of secondari) {
    let oggi = 0;
    if (!i.ignoraTetti) {
      const tetto = tettoDi(tetti!, numero);
      if (tetto <= 0) { scartati.push({ numero, motivo: 'tetto_zero' }); continue; }
      // `chatNateOggi` ha un tipo `Supa` minimale (solo la catena che usa); il client
      // vero non vi si assegna strutturalmente. Stesso cast di `puoAprireSuBot2` nelle
      // altre chiamate del repo (lancio-mittente.ts, fenice-enroll.ts).
      const n = await chatNateOggi(supabase as never, numero, i.adesso);
      if (n === null) {
        scartati.push({ numero, motivo: 'conteggio_fallito' });
        await log(supabase, 'mittente_ripiego', 'warn', { ...base, numero, motivo: 'conteggio_fallito' },
          `[numeri] conteggio di oggi per ${numero} fallito: escluso`);
        continue;
      }
      if (n >= tetto) {
        scartati.push({ numero, motivo: 'tetto_raggiunto', oggi: n, tetto });
        await log(supabase, 'mittente_tetto', 'info', { ...base, numero, oggi: n, tetto },
          `[numeri] ${numero} ha raggiunto il tetto (${n}/${tetto})`);
        continue;
      }
      oggi = n;
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
  // primo secondario spedibile nell'ordine della lista, senza bilanciamento.
  candidati.sort((a, b) => a.oggi - b.oggi);
  return { from: candidati[0].numero, secondario: true, scartati, motivo: 'scelto' };
}
