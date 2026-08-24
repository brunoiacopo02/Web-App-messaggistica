import Anthropic from '@anthropic-ai/sdk';
import type { MarioTurn } from './mario';

export const ANALYSIS_MODEL = 'claude-sonnet-4-6';

export type ObjectionCategory = 'prezzo' | 'tempo' | 'sfiducia' | 'garanzia_lavoro' | 'ci_penso' | 'altro' | 'nessuna';
const CATEGORIES: ObjectionCategory[] = ['prezzo', 'tempo', 'sfiducia', 'garanzia_lavoro', 'ci_penso', 'altro', 'nessuna'];

/**
 * Gli stadi del funnel, in ordine. Insieme CHIUSO di proposito: finché il campo è stato
 * testo libero, 24 estrazioni riuscite hanno prodotto 18 stadi diversi — "dopo la
 * proposta di videocall", "dopo la proposta della call", "dopo proposta call finale" —
 * e il conteggio per stadio non contava niente.
 */
export const DROPOFF_STAGES = [
  'apertura',        // non è mai entrato nel discorso
  'qualifica',       // durante le domande su lavoro e obiettivi
  'pitch',           // durante la spiegazione del percorso
  'prezzo',          // dopo aver sentito la quota
  'proposta_call',   // dopo la proposta della videocall: è il punto dove se ne perdono di più
  'giorno_e_ora',    // vuole la call ma si blocca sull'incastro
  'noemi_video',     // dopo il blocco preselezione + video
  'dopo_il_link',    // ha il link e non l'ha compilato
  'non_chiaro',
] as const;
export type DropoffStage = (typeof DROPOFF_STAGES)[number];

export function normalizeStage(raw: string): DropoffStage {
  const v = (raw ?? '').trim().toLowerCase();
  return (DROPOFF_STAGES as readonly string[]).includes(v) ? (v as DropoffStage) : 'non_chiaro';
}

export interface LeadInsight { dropoffStage: DropoffStage; objectionCategory: ObjectionCategory; objectionNote: string; }

/**
 * L'estrazione può fallire, e il fallimento NON va confuso con un'analisi.
 * Prima lo era: un JSON non parsabile diventava `non chiaro` + `altro` + nota vuota e
 * finiva a database con `ai_insight_at` valorizzato, quindi non veniva mai più
 * riprovato. In produzione erano 741 casi su 765 — il 97%.
 */
export type ExtractResult = { ok: true; insight: LeadInsight } | { ok: false; motivo: string; raw: string };

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

const EXTRACT_SYSTEM = `Sei un analista vendite per Fenice Academy. Ricevi la trascrizione di una chat WhatsApp tra il consulente Mario e un lead che NON ha fissato l'appuntamento. Rispondi SOLO con un oggetto JSON, nessun testo prima o dopo, nessun blocco di codice, con questa forma esatta:
{"dropoffStage":"<UNO SOLO fra: ${DROPOFF_STAGES.join('|')}>","objectionCategory":"<UNA SOLA fra: ${CATEGORIES.join('|')}>","objectionNote":"<le parole del lead sull'obiezione, max 200 caratteri>"}

Cosa significano gli stadi: apertura = non è mai entrato nel discorso; qualifica = si ferma durante le domande su lavoro e obiettivi; pitch = durante la spiegazione del percorso; prezzo = dopo aver sentito la quota; proposta_call = gli è stata proposta la videocall e non l'ha accettata; giorno_e_ora = vuole la call ma non trovate l'incastro; noemi_video = dopo il blocco preselezione+video; dopo_il_link = ha ricevuto il link e non l'ha compilato.
Scegli lo stadio PIÙ AVANZATO che la conversazione ha raggiunto. Usa non_chiaro solo se davvero non si capisce.`;

/** Il JSON dentro una risposta che può avere fence markdown o un preambolo. */
function estraiJson(raw: string): string | null {
  const senzaFence = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const apre = senzaFence.indexOf('{');
  const chiude = senzaFence.lastIndexOf('}');
  if (apre < 0 || chiude <= apre) return null;
  return senzaFence.slice(apre, chiude + 1);
}

export async function extractLeadInsight(history: MarioTurn[]): Promise<ExtractResult> {
  const transcript = history.map((m) => `${m.role === 'user' ? 'Lead' : 'Mario'}: ${m.content}`).join('\n');
  const response = await getClient().messages.create({
    model: ANALYSIS_MODEL,
    // 300 token bastavano appena: una objectionNote lunga troncava il JSON a metà, e un
    // JSON troncato diventava un'analisi finta. Qui lo spazio non è il costo.
    max_tokens: 1000,
    thinking: { type: 'disabled' },
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: `Conversazione:\n\n${transcript}` }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const raw = readText(response);
  if (!raw) return { ok: false, motivo: 'risposta vuota', raw };
  const json = estraiJson(raw);
  if (!json) return { ok: false, motivo: 'nessun JSON nella risposta', raw };

  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return { ok: false, motivo: 'JSON non parsabile', raw }; }
  if (typeof parsed?.dropoffStage !== 'string') return { ok: false, motivo: 'dropoffStage mancante', raw };

  return {
    ok: true,
    insight: {
      dropoffStage: normalizeStage(parsed.dropoffStage),
      objectionCategory: normalizeCategory(parsed.objectionCategory),
      objectionNote: typeof parsed.objectionNote === 'string' ? parsed.objectionNote.slice(0, 400) : '',
    },
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
