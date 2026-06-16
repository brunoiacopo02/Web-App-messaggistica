import Anthropic from '@anthropic-ai/sdk';
import { MARIO_SYSTEM_PROMPT } from './mario-prompt';

export const MARIO_MODEL = 'claude-sonnet-4-6';

export type MarioTurn = { role: 'user' | 'assistant'; content: string };
export type MarioResult = {
  visibleReply: string;
  appointmentFixed: boolean;
  passToHuman: boolean;
};

/** Rileva i tag speciali, li rimuove dal testo visibile e ritorna i flag. */
export function parseMarioReply(raw: string): MarioResult {
  const appointmentFixed = raw.includes('[APPUNTAMENTO_FISSATO]');
  const passToHuman = raw.includes('[PASSAGGIO_UMANO]');
  const visibleReply = raw
    .replace(/\[APPUNTAMENTO_FISSATO\]/g, '')
    .replace(/\[PASSAGGIO_UMANO\]/g, '')
    .trim();
  return { visibleReply, appointmentFixed, passToHuman };
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Genera la prossima risposta di Mario data la cronologia (user/assistant). */
export async function generateMarioReply(history: MarioTurn[]): Promise<MarioResult> {
  const messages =
    history.length > 0
      ? history
      : [{ role: 'user' as const, content: 'Inizia la conversazione presentandoti.' }];

  const response = await getClient().messages.create({
    model: MARIO_MODEL,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system: MARIO_SYSTEM_PROMPT,
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
  return parseMarioReply(raw);
}
