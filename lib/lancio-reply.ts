import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, MARIO_MODEL, MEDIA_SENZA_TESTO, type MarioTurn } from './mario';
import { buildLancioSystem, type LancioPromptInput } from './lancio-prompt';
import { parseLancioReply, type LancioReplyParsed } from './lancio-classifica';
import { romeNowContext } from './rome-time';

/**
 * La risposta del modello nel flusso lancio. Stesso modello e stesso client di Mario
 * (retry e timeout inclusi: il 529 lo rigiova il client), prompt tutto suo. Nessun
 * blocco slot, nessun `bookingDays`: qui non si fissa niente. Le due regole sui turni
 * vuoti sono le stesse di `generateMarioReply` (un turno user vuoto rompe la richiesta
 * con 400, un turno assistant vuoto non ha nulla da dire).
 */
export async function generateLancioReply(
  history: MarioTurn[],
  opts: LancioPromptInput & { now?: Date },
): Promise<LancioReplyParsed> {
  const turni = history.flatMap((t) => {
    if (typeof t.content === 'string' && t.content.trim() !== '') return [t];
    if (t.role === 'user') return [{ role: 'user' as const, content: MEDIA_SENZA_TESTO }];
    return [];
  });
  const messages = turni.length > 0 ? turni : [{ role: 'user' as const, content: MEDIA_SENZA_TESTO }];
  const now = opts.now ?? new Date();
  const system = `${buildLancioSystem(opts)}\n\n${romeNowContext(now)}`;

  const response = await getAnthropicClient().messages.create({
    model: MARIO_MODEL,
    max_tokens: 400,
    thinking: { type: 'disabled' },
    system,
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
  return parseLancioReply(raw);
}
