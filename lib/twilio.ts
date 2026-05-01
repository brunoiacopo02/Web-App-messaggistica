import twilio, { validateRequest } from 'twilio';

type SendTemplateInput = {
  to: string;                     // E.164 senza prefix
  contentSid: string;
  variables: Record<string, string>;
};

type SendFreeTextInput = {
  to: string;
  body: string;
};

type SendOptions = {
  backoffMs?: (attempt: number) => number;
};

const defaultBackoff = (attempt: number) => (attempt === 1 ? 1000 : 4000);

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error('Missing Twilio credentials');
  return twilio(sid, tok);
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
  const client = getClient();
  return withRetry(async () => {
    const msg = await client.messages.create({
      from: fromNumber(),
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
  const client = getClient();
  return withRetry(async () => {
    const msg = await client.messages.create({
      from: fromNumber(),
      to: `whatsapp:${input.to}`,
      body: input.body,
      statusCallback: statusCallbackUrl(),
    });
    return { sid: msg.sid, status: msg.status };
  }, opts);
}

export type ValidateSigInput = {
  url: string;
  signature: string;
  params: Record<string, string>;
};

export async function validateTwilioSignature(input: ValidateSigInput): Promise<boolean> {
  if (process.env.TWILIO_VALIDATE_SIGNATURE === 'false') return true;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!tok) return false;
  return validateRequest(tok, input.signature, input.url, input.params);
}
