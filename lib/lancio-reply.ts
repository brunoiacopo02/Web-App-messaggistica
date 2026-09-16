import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, MARIO_MODEL, MEDIA_SENZA_TESTO, type MarioTurn } from './mario';
import { buildLancioSystem, type LancioPromptInput } from './lancio-prompt';
import { parseLancioReply, type LancioReplyParsed } from './lancio-classifica';
import { parseLancioTag, stripLancioTags, type LancioTag } from './lancio-scelta';
import { romeNowContext } from './rome-time';

/** Il risultato del B1 piu' il tag della scelta (B4). `lancioTag` e' null fuori dal
 *  post-pitch o quando il modello non ha scelto: chi chiama manda il testo e basta. */
export type LancioReply = LancioReplyParsed & { lancioTag: LancioTag | null };

/**
 * La risposta del modello nel flusso lancio. Stesso modello e stesso client di Mario
 * (retry e timeout inclusi: il 529 lo rigiova il client), prompt tutto suo per fase
 * (`buildLancioSystem`): le ore prenotabili, quando ci sono, arrivano gia' formattate in
 * `opts.bloccoSlot` e il modello puo' solo ricopiarle. Le due regole sui turni vuoti
 * sono le stesse di `generateMarioReply` (un turno user vuoto rompe la richiesta con
 * 400, un turno assistant vuoto non ha nulla da dire).
 */
export async function generateLancioReply(
  history: MarioTurn[],
  opts: LancioPromptInput & { now?: Date },
): Promise<LancioReply> {
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
  // Il tag della scelta si legge dal testo GREZZO, prima che `parseLancioReply` tolga i
  // tag: li' [LANCIO:PRENOTA|...] sparisce insieme al suo argomento. `stripLancioTags`
  // in coda e' la cintura di sicurezza sul testo gia' ripulito.
  const parsed = parseLancioReply(raw);
  return { ...parsed, visibleReply: stripLancioTags(parsed.visibleReply), lancioTag: parseLancioTag(raw) };
}
