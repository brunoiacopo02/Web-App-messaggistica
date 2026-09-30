import type { Tono } from '@/components/console/ui/Tag';

/**
 * Analisi dei lead di Mario: le stesse letture di `LeadPipeline` (`/fenice/lead`), con le stesse
 * rotte e gli stessi parametri. Qui vivono i nomi delle schede nell'URL e la loro traduzione verso
 * i segmenti della rotta, così il componente resta sola presentazione.
 */

export const SCHEDE = ['presi', 'attive', 'mai_risposto', 'ferme', 'report', 'ai'] as const;
export type Scheda = (typeof SCHEDE)[number];

export const PERIODI = ['7', '30', 'all'] as const;
export type Periodo = (typeof PERIODI)[number];

export type Segmento = 'PRESO' | 'ATTIVA' | 'MAI_RISPOSTO' | 'FERMA';

export const SEGMENTO: Partial<Record<Scheda, Segmento>> = {
  presi: 'PRESO',
  attive: 'ATTIVA',
  mai_risposto: 'MAI_RISPOSTO',
  ferme: 'FERMA',
};

export const ETICHETTA_SCHEDA: Record<Scheda, string> = {
  presi: 'Presi',
  attive: 'Attive',
  mai_risposto: 'Mai risposto',
  ferme: 'Ferme',
  report: 'Report',
  ai: 'Analisi AI',
};

export const ETICHETTA_PERIODO: Record<Periodo, string> = {
  '7': 'Ultimi 7 giorni',
  '30': 'Ultimi 30 giorni',
  all: 'Tutto',
};

export interface RigaSegmento {
  id: number;
  phone: string;
  name: string;
  segment: string;
  reason: string | null;
  lastMessageAt: string;
  status: string | null;
  scheduledAt: string | null;
}

export interface Conteggi {
  PRESO: number;
  MAI_RISPOSTO: number;
  ATTIVA: number;
  FERMA: number;
  total: number;
}

export interface Report {
  total: number;
  presi: number;
  nonPresi: number;
  conversionRate: number;
  maiRisposto: number;
  maiRispostoShareOfNonPresi: number;
  byFunnel: Array<{ funnel: string; total: number; presi: number }>;
}

export interface AnalisiAi {
  generatedAt: string | null;
  report: {
    topObjections?: Array<{ category: string; count: number }>;
    dropoffStages?: Array<{ stage: string; count: number }>;
    narrative?: string;
  } | null;
}

/** L'URL della lettura, identico a quello di `LeadPipeline`. */
export function urlLettura(scheda: Scheda, periodo: Periodo): string {
  if (scheda === 'report') return `/api/fenice/report?period=${periodo}`;
  if (scheda === 'ai') return '/api/fenice/analysis';
  return `/api/fenice/segments?segment=${SEGMENTO[scheda]}&period=${periodo}`;
}

/** "Presi" come un'agenda: appuntamento più vicino in cima, senza data in fondo (come `LeadPipeline`). */
export function ordinaPresi(righe: readonly RigaSegmento[]): RigaSegmento[] {
  return [...righe].sort((a, b) => {
    if (!a.scheduledAt) return 1;
    if (!b.scheduledAt) return -1;
    return a.scheduledAt.localeCompare(b.scheduledAt);
  });
}

const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: 'short' });
const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Data dell'appuntamento in stile agenda, a Roma: "Ven 26 giu 08:00". */
export function dataAppuntamento(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const giorno = fmtGiorno.format(d).replace(/,/g, '');
  return `${giorno.charAt(0).toUpperCase()}${giorno.slice(1)} ${fmtOra.format(d)}`;
}

/**
 * Tono del badge di un motivo/esito. Il caldo resta ai problemi (regola 3 dell'anti-slop): verde per
 * l'appuntamento, ambra per chi è da richiamare (attesa), il resto neutro con il testo che spiega.
 */
export function tonoMotivo(reason: string): Tono {
  if (reason === 'APPUNTAMENTO') return 'ok';
  if (reason === 'RICHIAMO') return 'attesa';
  return 'neutro';
}

/** Percentuale con una cifra decimale e la virgola: 0.1234 → "12,3%". */
export function percentuale(x: number, decimali = 1): string {
  return `${(x * 100).toLocaleString('it-IT', { minimumFractionDigits: decimali, maximumFractionDigits: decimali })}%`;
}
