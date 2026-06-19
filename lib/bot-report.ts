import Anthropic from '@anthropic-ai/sdk';
import type { BotReport } from './bot-contract';
import type { MarioTurn } from './mario';

export const REPORT_MODEL = 'claude-sonnet-4-6';

const REPORT_SYSTEM = `Analizza una conversazione WhatsApp tra "Mario" (nostro agente) e un lead.
Rispondi SOLO con un oggetto JSON con queste chiavi (tutte opzionali, ometti quelle senza dati):
{"summary": string, "painPoints": string[], "budgetSignal": string, "urgency": "alta"|"media"|"bassa", "objections": string[], "levaConsigliata": string}
Niente testo fuori dal JSON. Non inventare dati non presenti nella conversazione.`;

/** Estrae il primo oggetto JSON da `text` e lo normalizza in BotReport. Puro. */
export function parseReportJson(text: string): BotReport {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return {};
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return {}; }

  const out: BotReport = {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const arr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;

  if (str(obj.summary)) out.summary = str(obj.summary);
  if (str(obj.budgetSignal)) out.budgetSignal = str(obj.budgetSignal);
  if (str(obj.urgency)) out.urgency = str(obj.urgency);
  if (str(obj.levaConsigliata)) out.levaConsigliata = str(obj.levaConsigliata);
  const pp = arr(obj.painPoints); if (pp && pp.length) out.painPoints = pp;
  const ob = arr(obj.objections); if (ob && ob.length) out.objections = ob;
  return out;
}

/** Genera il report strutturato dalla cronologia. Best-effort: ritorna {} su errore. */
export async function generateBotReport(history: MarioTurn[]): Promise<BotReport> {
  if (history.length === 0) return {};
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return {};

  const transcript = history
    .map((m) => `${m.role === 'user' ? 'LEAD' : 'MARIO'}: ${m.content}`)
    .join('\n');

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: REPORT_MODEL,
      max_tokens: 600,
      thinking: { type: 'disabled' },
      system: REPORT_SYSTEM,
      messages: [{ role: 'user', content: `Conversazione:\n\n${transcript}` }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    const block = response.content.find((b) => b.type === 'text');
    const text = block && 'text' in block ? block.text : '';
    return parseReportJson(text);
  } catch {
    return {};
  }
}
