import { credenzialiPerMittente } from './twilio-account';
import twilio, { validateRequest } from 'twilio';

type SendTemplateInput = {
  to: string;                     // E.164 senza prefix
  contentSid: string;
  variables: Record<string, string>;
  from?: string;
};

type SendFreeTextInput = {
  to: string;
  body: string;
  from?: string;
};

type SendOptions = {
  backoffMs?: (attempt: number) => number;
};

const defaultBackoff = (attempt: number) => (attempt === 1 ? 1000 : 4000);

/**
 * Il client Twilio con cui mandare DA un certo numero.
 *
 * Il mittente decide l'account: dal 16/09/2026 i numeri stanno su due account
 * distinti, e un account non puo' inviare da un numero che non possiede
 * (Twilio risponde 401 e il messaggio non parte). Vedi lib/twilio-account.ts.
 */
function getClient(from?: string | null) {
  const cred = credenzialiPerMittente(from);
  if (!cred) throw new Error('Missing Twilio credentials');
  return twilio(cred.sid, cred.token);
}

function statusCallbackUrl() {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) throw new Error('Missing NEXT_PUBLIC_APP_URL');
  return `${base}/api/webhooks/twilio`;
}

function fromNumber() {
  const n = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!n) throw new Error('Missing TWILIO_WHATSAPP_NUMBER');
  return n;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: SendOptions,
): Promise<T> {
  const backoff = opts.backoffMs ?? defaultBackoff;
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.statusCode;
      const isRetriable = !status || status >= 500;
      if (!isRetriable || attempt === 2) throw err;
      await new Promise(r => setTimeout(r, backoff(attempt + 1)));
    }
  }
  throw lastErr;
}

export async function sendTemplate(
  input: SendTemplateInput,
  opts: SendOptions = {},
) {
  // Il mittente si risolve per PRIMO: serve a scegliere l'account, e da
  // quello dipendono sia il controllo della categoria sia l'invio.
  const mittente = input.from ?? fromNumber();
  await assertTemplateSendable(input.contentSid, mittente);
  const client = getClient(mittente);
  return withRetry(async () => {
    const msg = await client.messages.create({
      from: mittente,
      to: `whatsapp:${input.to}`,
      contentSid: input.contentSid,
      contentVariables: JSON.stringify(input.variables),
      statusCallback: statusCallbackUrl(),
    });
    return { sid: msg.sid, status: msg.status };
  }, opts);
}

export async function sendFreeText(
  input: SendFreeTextInput,
  opts: SendOptions = {},
) {
  const mittente = input.from ?? fromNumber();
  const client = getClient(mittente);
  return withRetry(async () => {
    const msg = await client.messages.create({
      from: mittente,
      to: `whatsapp:${input.to}`,
      body: input.body,
      statusCallback: statusCallbackUrl(),
    });
    return { sid: msg.sid, status: msg.status };
  }, opts);
}

// ── Presidio categoria: nessun template MARKETING parte a insaputa nostra ──────
//
// Il 29/07/2026 il presidio è nato per gli script (scripts/lib/template-guard.mjs), ma
// le route dell'app non lo avevano: aperture, touch e riaggancio sono partiti per giorni
// come MARKETING senza che nulla lo dicesse. La categoria vera la decide Meta, non la
// richiesta che abbiamo fatto noi: qui la si chiede a Twilio e la si applica.
//
// UTILITY_ONLY=1 → si spedisce solo ciò che Meta ha approvato come UTILITY. È
// l'interruttore da alzare quando il numero è in riabilitazione (qualità LOW).
const _templateCategoryCache = new Map<string, string | null>();

/**
 * `from` serve perche' i template vivono DENTRO un account: lo stesso template
 * esiste sui due account con SID diversi, e chiedere la categoria di un SID del
 * secondo account con le credenziali del primo torna 404. Siccome
 * `assertTemplateSendable` fallisce chiuso, quel 404 bloccherebbe l'invio.
 *
 * La cache e' per (account, template): due SID diversi non collidono, ma un
 * giorno lo stesso SID potrebbe rispondere diversamente su account diversi, e
 * una cache per solo SID lo nasconderebbe.
 */
export async function getTemplateCategory(contentSid: string, from?: string | null): Promise<string | null> {
  const cred = credenzialiPerMittente(from);
  if (!cred) return null;
  const chiave = `${cred.sid}:${contentSid}`;
  if (_templateCategoryCache.has(chiave)) return _templateCategoryCache.get(chiave)!;
  const { sid, token: tok } = cred;
  const res = await fetch(`https://content.twilio.com/v1/Content/${contentSid}/ApprovalRequests`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
  });
  if (!res.ok) throw new Error(`categoria del template ${contentSid} non verificabile (HTTP ${res.status})`);
  const data = (await res.json()) as { whatsapp?: { category?: string } };
  const cat = data?.whatsapp?.category ?? null;
  _templateCategoryCache.set(chiave, cat);
  return cat;
}

/** Lancia se il template non è spedibile con la policy corrente. Fail-closed: se la
 * categoria non è verificabile non si spedisce, perché è esattamente la condizione in
 * cui l'incidente si ripete. */
export async function assertTemplateSendable(contentSid: string, from?: string | null): Promise<void> {
  if (process.env.UTILITY_ONLY !== '1') return;
  if ((process.env.UTILITY_ONLY_ALLOW ?? '').split(',').map((s) => s.trim()).includes(contentSid)) return;
  const cat = await getTemplateCategory(contentSid, from);
  if (cat !== 'UTILITY') {
    throw new Error(
      `template ${contentSid} bloccato: categoria ${cat ?? 'sconosciuta'} con UTILITY_ONLY attivo. ` +
      'Sostituirlo con una versione utility, oppure sbloccarlo per SID esteso in UTILITY_ONLY_ALLOW.',
    );
  }
}

// Cache del testo dei template (per mostrare il messaggio reale invece di "[template] X").
const _templateBodyCache = new Map<string, string>();

export async function getTemplateBody(contentSid: string, from?: string | null): Promise<string | null> {
  const cred = credenzialiPerMittente(from);
  if (!cred) return null;
  const chiave = `${cred.sid}:${contentSid}`;
  if (_templateBodyCache.has(chiave)) return _templateBodyCache.get(chiave)!;
  const { sid, token: tok } = cred;
  try {
    const res = await fetch(`https://content.twilio.com/v1/Content/${contentSid}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { types?: Record<string, { body?: string }> };
    const text = data?.types?.['twilio/text']?.body ?? null;
    if (text) _templateBodyCache.set(chiave, text);
    return text;
  } catch {
    return null;
  }
}

export type ValidateSigInput = {
  url: string;
  signature: string;
  params: Record<string, string>;
};

/**
 * I token con cui puo' essere firmato un webhook in arrivo.
 *
 * Dal 16/09/2026 i numeri WhatsApp stanno su DUE account Twilio distinti: il
 * principale e "Account fenice 2" (+393522070047). Twilio firma con il token
 * dell'account che possiede il numero, quindi validare con un token solo
 * bocciava con 403 tutti i messaggi in arrivo sul secondo numero — e li'
 * finisce anche il flusso dopo l'agenda: video, solleciti e risposte del lead
 * passano tutti da qui. Sarebbero spariti in silenzio.
 */
function tokenAmmessi(): string[] {
  return [process.env.TWILIO_AUTH_TOKEN, process.env.TWILIO_AUTH_TOKEN_2]
    .map((t) => (t ?? '').trim())
    .filter(Boolean);
}

export async function validateTwilioSignature(input: ValidateSigInput): Promise<boolean> {
  if (process.env.TWILIO_VALIDATE_SIGNATURE === 'false') return true;
  const tokens = tokenAmmessi();
  if (tokens.length === 0) return false;
  // Basta che UNO dei token validi la firma: e' lo stesso messaggio, cambia
  // solo quale account Twilio lo possiede.
  return tokens.some((tok) => validateRequest(tok, input.signature, input.url, input.params));
}
