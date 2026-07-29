import Anthropic from '@anthropic-ai/sdk';
import { buildMarioSystem } from './mario-prompt';
import { romeNowContext } from './rome-time';
import { bookingSlotsContext } from './booking-slots';
import { sanitizeOutbound } from './outbound-sanitize';

export const MARIO_MODEL = 'claude-sonnet-4-6';

export type MarioTurn = { role: 'user' | 'assistant'; content: string };
export type MarioOutcome = 'APPUNTAMENTO' | 'RICHIAMO' | 'DA_SCARTARE' | 'INTERROTTO';
export type MarioResult = {
  visibleReply: string;
  appointmentFixed: boolean;
  passToHuman: boolean;
  videoWatched: boolean;
  outcome?: MarioOutcome;
  scheduledAt?: string;
  discardReason?: string;
  note?: string;
};

const ESITO_RE = /\[ESITO:(APPUNTAMENTO|RICHIAMO|SCARTO|INTERROTTO)\|([^\]]*)\]/i;

/** Rileva tag speciali, li rimuove dal testo visibile e ritorna flag + esito strutturato. */
export function parseMarioReply(raw: string): MarioResult {
  const legacyAppointment = raw.includes('[APPUNTAMENTO_FISSATO]');
  const passToHuman = raw.includes('[PASSAGGIO_UMANO]');
  const videoWatched = raw.includes('[VIDEO_VISTO]');

  let outcome: MarioOutcome | undefined;
  let scheduledAt: string | undefined;
  let discardReason: string | undefined;
  let note: string | undefined;

  const m = raw.match(ESITO_RE);
  if (m) {
    const kind = m[1].toUpperCase();
    const arg = (m[2] ?? '').trim();
    if (kind === 'APPUNTAMENTO') { outcome = 'APPUNTAMENTO'; scheduledAt = arg || undefined; }
    else if (kind === 'RICHIAMO') { outcome = 'RICHIAMO'; scheduledAt = arg || undefined; }
    else if (kind === 'SCARTO') { outcome = 'DA_SCARTARE'; discardReason = arg || undefined; }
    else if (kind === 'INTERROTTO') { outcome = 'INTERROTTO'; note = arg || undefined; }
  }

  const visibleReply = sanitizeOutbound(
    raw
      .replace(ESITO_RE, '')
      .replace(/\[APPUNTAMENTO_FISSATO\]/g, '')
      .replace(/\[PASSAGGIO_UMANO\]/g, '')
      .replace(/\[VIDEO_VISTO\]/g, '')
      .trim(),
  );

  return {
    visibleReply,
    appointmentFixed: legacyAppointment || outcome === 'APPUNTAMENTO',
    passToHuman,
    videoWatched,
    outcome,
    scheduledAt,
    discardReason,
    note,
  };
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey, maxRetries: 5, timeout: 60_000 });
  return _client;
}

/** Genera la prossima risposta del bot data la cronologia. Inietta l'ora di Roma.
 *  `personaName` (default 'Mario') parametrizza SOLO il nome nel system prompt. */
export async function generateMarioReply(
  history: MarioTurn[],
  opts?: { now?: Date; personaName?: string },
): Promise<MarioResult> {
  const messages =
    history.length > 0
      ? history
      : [{ role: 'user' as const, content: 'Inizia la conversazione presentandoti.' }];

  const now = opts?.now ?? new Date();
  const system = `${buildMarioSystem(opts?.personaName ?? 'Mario')}\n\n${romeNowContext(now)}\n\n${bookingSlotsContext(now)}`;

  const response = await getClient().messages.create({
    model: MARIO_MODEL,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system,
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
  return parseMarioReply(raw);
}
