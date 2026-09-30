/**
 * Questo template puo' davvero partire da questo numero?
 *
 * Due domande in una, perche' due sono i modi di perdere il messaggio:
 * 1. il template non esiste sull'account che possiede il numero (`traduciTemplate` lo
 *    dice con `tradotto: false`; `sendTemplate` non lo guarda e manderebbe il SID
 *    dell'altro account, cioe' un 404);
 * 2. il presidio categoria lo rifiuta (`UTILITY_ONLY=1` e copia MARKETING).
 *
 * Fallisce chiuso: qualunque cosa vada storta qui vale "non spedibile", e il chiamante
 * ripiega sul numero storico. Le due letture sono in cache per processo
 * (`template-account.ts`, `getTemplateCategory`), quindi costano una volta sola.
 *
 * Vive in un file proprio (e non in `lancio-mittente.ts`, dove e' nato) perche'
 * `scelta-mittente.ts` la usa anche lei, e `lancio-mittente.ts` importera' a sua
 * volta `scelta-mittente.ts`: tenerla li' avrebbe creato un ciclo di import.
 */
import { assertTemplateSendable } from './twilio';
import { traduciTemplate } from './template-account';

export type EsitoSpedibilita =
  | { ok: true; sidTradotto: string }
  | { ok: false; motivo: 'template_non_tradotto' | 'template_bloccato'; sidTradotto: string; errore: string | null };

export async function spedibileDa(templateSid: string, numero: string): Promise<EsitoSpedibilita> {
  let sidTradotto = templateSid;
  try {
    const traduzione = await traduciTemplate(templateSid, numero);
    sidTradotto = traduzione.sid;
    if (!traduzione.tradotto) {
      return {
        ok: false,
        motivo: 'template_non_tradotto',
        sidTradotto,
        errore: `il template ${templateSid} non esiste sull'account di ${numero}`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      motivo: 'template_non_tradotto',
      sidTradotto,
      errore: (e as { message?: string } | null)?.message ?? 'traduzione fallita',
    };
  }
  try {
    await assertTemplateSendable(sidTradotto, numero, templateSid);
  } catch (e) {
    return {
      ok: false,
      motivo: 'template_bloccato',
      sidTradotto,
      errore: (e as { message?: string } | null)?.message ?? 'template non spedibile',
    };
  }
  return { ok: true, sidTradotto };
}
