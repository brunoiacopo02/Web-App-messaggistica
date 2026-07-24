import Anthropic from '@anthropic-ai/sdk';
import type { MarioTurn } from './mario';

export const INTERRUPTED_MODEL = 'claude-sonnet-4-6';

const INTERRUPTED_SYSTEM = `Sei un analista che classifica una conversazione WhatsApp interrotta tra "Mario" (il nostro agente di prequalifica) e un lead.
Il lead ha smesso di rispondere. Devi decidere se il lead va scartato o restituito al venditore, e a che punto dello script si è fermata la chat.

Rispondi SOLO con un oggetto JSON, senza testo prima o dopo, in questo formato esatto:
{"discard":bool,"discardReason":string|null,"stage":string,"lastLeadQuote":string}

Regole:
- "discard" deve essere true SOLO se il lead ha espresso un'obiezione ferrea ESPLICITA: ha dichiarato di non essere interessato, ha chiesto di non essere più ricontattato, oppure ha detto di aver già scelto un altro percorso/altra soluzione. In ogni altro caso, incluso il dubbio, "discard" è false.
- Se "discard" è true, "discardReason" è una breve motivazione in italiano; altrimenti null.
- "stage" è il punto dello script raggiunto quando la chat si è interrotta (es. "dopo la domanda sul lavoro", "dopo il prezzo", "dopo il pitch iniziale").
- "lastLeadQuote" è l'ultima frase scritta dal lead, citata testualmente.
Non inventare nulla che non sia nella conversazione.`;

export type InterruptedVerdict = { discard: boolean; discardReason?: string; note: string };

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey, maxRetries: 5, timeout: 60_000 });
  return _client;
}

function fallbackVerdict(lastLeadMsg: string): InterruptedVerdict {
  return {
    discard: false,
    note: `Chat interrotta. Ultimo messaggio del lead: "${lastLeadMsg}"`,
  };
}

/** Estrae il primo blocco JSON parsabile dal testo (scansione dal primo '{'). */
function extractFirstJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // continua con la scansione
  }
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  for (let end = start + 1; end <= trimmed.length; end++) {
    if (trimmed[end - 1] !== '}') continue;
    try {
      return JSON.parse(trimmed.slice(start, end));
    } catch {
      // prova la prossima '}' (gestisce '}' dentro le stringhe)
    }
  }
  return null;
}

/**
 * Interpreta la risposta del modello. Non lancia MAI: su qualsiasi problema
 * ritorna il fallback costruito con l'ultimo messaggio del lead.
 */
export function parseInterruptedVerdict(
  raw: string,
  fallback: { lastLeadMsg: string }
): InterruptedVerdict {
  const parsed = extractFirstJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fallbackVerdict(fallback.lastLeadMsg);
  }
  const obj = parsed as Record<string, unknown>;
  const stage = obj.stage;
  const lastLeadQuote = obj.lastLeadQuote;
  if (typeof stage !== 'string' || typeof lastLeadQuote !== 'string') {
    return fallbackVerdict(fallback.lastLeadMsg);
  }
  const note = `Interrotta ${stage}. Ultima frase del lead: "${lastLeadQuote}"`;
  const reason = typeof obj.discardReason === 'string' ? obj.discardReason.trim() : '';
  // discard=true solo se esplicitamente booleano E motivato: altrimenti si restituisce.
  if (obj.discard === true && reason) {
    return { discard: true, discardReason: reason, note };
  }
  return { discard: false, note };
}

/**
 * Classifica una conversazione interrotta via LLM. Su errore API ritorna il
 * fallback (ultimo messaggio user della history), mai throw.
 */
export async function classifyInterrupted(history: MarioTurn[]): Promise<InterruptedVerdict> {
  const lastLeadMsg = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (history.length === 0) return fallbackVerdict(lastLeadMsg);

  try {
    const transcript = history
      .map((m) => `${m.role === 'user' ? 'LEAD' : 'MARIO'}: ${m.content}`)
      .join('\n');

    const response = await getClient().messages.create({
      model: INTERRUPTED_MODEL,
      max_tokens: 512,
      thinking: { type: 'disabled' },
      system: INTERRUPTED_SYSTEM,
      messages: [{ role: 'user', content: `Conversazione:\n\n${transcript}` }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    const textBlock = response.content.find((b) => b.type === 'text');
    const text = textBlock && 'text' in textBlock ? textBlock.text.trim() : '';
    return parseInterruptedVerdict(text, { lastLeadMsg });
  } catch {
    return fallbackVerdict(lastLeadMsg);
  }
}
