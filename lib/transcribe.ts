// Trascrizione note vocali: scarica l'audio da Twilio e lo trascrive in testo
// (italiano) via Groq (Whisper large-v3, API compatibile OpenAI, piano gratuito).
// Best-effort: ritorna null se non configurato o in errore.

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_TRANSCRIBE_MODEL = 'whisper-large-v3';

export type InboundParams = Record<string, string>;

/** True se l'inbound è una nota vocale (media audio). */
export function isAudioInbound(params: InboundParams): boolean {
  const n = parseInt(params.NumMedia ?? '0', 10);
  const ct = params.MediaContentType0 ?? '';
  return n > 0 && ct.startsWith('audio/');
}

function extForContentType(ct: string): string {
  if (ct.includes('ogg') || ct.includes('opus')) return 'ogg';
  if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3';
  if (ct.includes('wav')) return 'wav';
  if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac')) return 'm4a';
  if (ct.includes('amr')) return 'amr';
  return 'ogg';
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Scarica l'audio dalla MediaUrl di Twilio e ritorna la trascrizione (it), o null. */
export async function transcribeTwilioAudio(mediaUrl: string, contentType: string): Promise<string | null> {
  const groqKey = process.env.GROQ_API_KEY;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!groqKey || !sid || !tok || !mediaUrl) return null;

  try {
    // 1) scarica l'audio da Twilio (basic auth)
    const auth = 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64');
    const audioRes = await fetchWithTimeout(mediaUrl, { headers: { Authorization: auth } }, 12_000);
    if (!audioRes.ok) return null;
    const buf = Buffer.from(await audioRes.arrayBuffer());

    // 2) trascrivi con OpenAI
    const ext = extForContentType(contentType);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: contentType || 'audio/ogg' }), `audio.${ext}`);
    form.append('model', GROQ_TRANSCRIBE_MODEL);
    form.append('language', 'it');
    const sttRes = await fetchWithTimeout(
      GROQ_TRANSCRIBE_URL,
      { method: 'POST', headers: { Authorization: `Bearer ${groqKey}` }, body: form },
      30_000,
    );
    if (!sttRes.ok) return null;
    const data = (await sttRes.json()) as { text?: string };
    const text = (data.text ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}
