import Anthropic from '@anthropic-ai/sdk';
import type { MarioTurn } from './mario';

export const ANALYSIS_MODEL = 'claude-sonnet-4-6';

export type ObjectionCategory = 'prezzo' | 'tempo' | 'sfiducia' | 'garanzia_lavoro' | 'ci_penso' | 'altro' | 'nessuna';
const CATEGORIES: ObjectionCategory[] = ['prezzo', 'tempo', 'sfiducia', 'garanzia_lavoro', 'ci_penso', 'altro', 'nessuna'];

export interface LeadInsight { dropoffStage: string; objectionCategory: ObjectionCategory; objectionNote: string; }

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey });
  return _client;
}

function readText(response: any): string {
  const block = response.content.find((b: any) => b.type === 'text');
  return block && 'text' in block ? block.text.trim() : '';
}

export function normalizeCategory(raw: string): ObjectionCategory {
  const v = (raw ?? '').trim().toLowerCase();
  return (CATEGORIES as string[]).includes(v) ? (v as ObjectionCategory) : 'altro';
}

const EXTRACT_SYSTEM = `Sei un analista vendite per Fenice Academy. Ricevi la trascrizione di una chat WhatsApp tra il consulente Mario e un lead che NON ha fissato l'appuntamento. Rispondi SOLO con un oggetto JSON, nessun testo extra, con questa forma:
{"dropoffStage":"<dove si è bloccato il lead, breve, es. 'dopo il prezzo'>","objectionCategory":"<una tra: prezzo|tempo|sfiducia|garanzia_lavoro|ci_penso|altro|nessuna>","objectionNote":"<citazione o sintesi breve dell'obiezione>"}`;

export async function extractLeadInsight(history: MarioTurn[]): Promise<LeadInsight> {
  const transcript = history.map((m) => `${m.role === 'user' ? 'Lead' : 'Mario'}: ${m.content}`).join('\n');
  const response = await getClient().messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: 300,
    thinking: { type: 'disabled' },
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: `Conversazione:\n\n${transcript}` }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const raw = readText(response);
  let parsed: any = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  return {
    dropoffStage: typeof parsed.dropoffStage === 'string' ? parsed.dropoffStage : 'non chiaro',
    objectionCategory: normalizeCategory(parsed.objectionCategory),
    objectionNote: typeof parsed.objectionNote === 'string' ? parsed.objectionNote : '',
  };
}

export interface AggregateInput { insights: LeadInsight[]; maiRisposto: number; respondedNotTaken: number; }
export interface AggregateReport {
  topObjections: Array<{ category: ObjectionCategory; count: number }>;
  dropoffStages: Array<{ stage: string; count: number }>;
  maiRisposto: number;
  respondedNotTaken: number;
  narrative: string;
}

const AGG_SYSTEM = `Sei un consulente vendite senior di Fenice Academy. Ricevi statistiche aggregate su dove i lead WhatsApp si bloccano e le loro obiezioni. Scrivi in italiano un'analisi di massimo 180 parole: 1) i 2-3 pattern principali, 2) 3-5 suggerimenti CONCRETI per migliorare lo script del bot Mario. Niente elenchi puntati lunghi, niente fronzoli.`;

export async function aggregateInsights(input: AggregateInput): Promise<AggregateReport> {
  const objCount = new Map<ObjectionCategory, number>();
  const stageCount = new Map<string, number>();
  for (const i of input.insights) {
    objCount.set(i.objectionCategory, (objCount.get(i.objectionCategory) ?? 0) + 1);
    const stage = i.dropoffStage.trim().toLowerCase();
    stageCount.set(stage, (stageCount.get(stage) ?? 0) + 1);
  }
  const topObjections = [...objCount.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
  const dropoffStages = [...stageCount.entries()].map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count);

  if (input.insights.length === 0) {
    return { topObjections, dropoffStages, maiRisposto: input.maiRisposto, respondedNotTaken: input.respondedNotTaken, narrative: "Dati insufficienti: nessun lead che ha risposto senza prendere l'appuntamento nel periodo." };
  }

  const statsText = [
    `Lead che hanno risposto ma non hanno preso l'appuntamento: ${input.respondedNotTaken}`,
    `Lead che non hanno mai risposto: ${input.maiRisposto}`,
    `Obiezioni: ${topObjections.map((o) => `${o.category}=${o.count}`).join(', ')}`,
    `Punti di blocco: ${dropoffStages.map((s) => `${s.stage}=${s.count}`).join(', ')}`,
  ].join('\n');

  const response = await getClient().messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: 500,
    thinking: { type: 'disabled' },
    system: AGG_SYSTEM,
    messages: [{ role: 'user', content: statsText }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  return { topObjections, dropoffStages, maiRisposto: input.maiRisposto, respondedNotTaken: input.respondedNotTaken, narrative: readText(response) };
}
