import Anthropic from '@anthropic-ai/sdk';
import type { MarioTurn } from './mario';

export const SUMMARY_MODEL = 'claude-sonnet-4-6';

const SUMMARY_SYSTEM = `Sei un assistente che riassume per un venditore una conversazione WhatsApp tra "Mario" (il nostro agente) e un lead.
Scrivi in italiano, conciso e concreto, SENZA inventare nulla che non sia nella conversazione.
Rispondi ESATTAMENTE con questo formato, una riga per voce:

Interesse: <alto | medio | basso | non chiaro> — <max 12 parole sul perché>
Situazione: <1-2 frasi su cosa cerca/qual è il contesto del lead>
Obiezioni: <le obiezioni o i dubbi emersi, oppure "nessuna">
Esito: <appuntamento fissato | passato a operatore | in corso | nessuna risposta>
Prossimo passo: <azione concreta consigliata per il venditore, max 15 parole>

Niente markdown, niente trattini lunghi, niente testo extra prima o dopo.`;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Genera un riassunto del lead a partire dalla cronologia della conversazione. */
export async function generateLeadSummary(history: MarioTurn[]): Promise<string> {
  if (history.length === 0) return 'Nessun messaggio da riassumere.';

  const transcript = history
    .map((m) => `${m.role === 'user' ? 'LEAD' : 'MARIO'}: ${m.content}`)
    .join('\n');

  const response = await getClient().messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 512,
    thinking: { type: 'disabled' },
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: `Conversazione:\n\n${transcript}` }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock && 'text' in textBlock ? textBlock.text.trim() : '';
  return text || 'Riassunto non disponibile.';
}
