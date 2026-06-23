# Fenice Lead Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere alla sezione `/fenice` una pipeline lead Mario con segmentazione di stato chat (Attive / Mai risposto / Ferme), report Presi-vs-Non presi, e un'analisi AI giornaliera (Claude) che spiega dove si bloccano i lead e le obiezioni principali.

**Architecture:** La segmentazione è calcolata da una funzione pura in JS a partire dalle colonne esistenti di `conversations` (zero costo Claude, sempre live). Le API server usano `getSupabaseAdmin()` (service role) per leggere il traffico Mario (`ai_owner='mario'`). L'analisi AI è a due stadi: estrazione per-conversazione in cache su nuove colonne, poi aggregazione salvata in una nuova tabella; entrambe orchestrate da un cron giornaliero. La UI è una nuova pagina server con tab che riusano i componenti chat esistenti.

**Tech Stack:** Next.js App Router, Supabase (`@supabase/supabase-js` admin client), `@anthropic-ai/sdk` (modello `claude-sonnet-4-6`), Vitest, Vercel Cron.

## Global Constraints

- Popolazione SEMPRE filtrata a `ai_owner = 'mario'`. Non toccare il traffico CRM (`ai_owner IS NULL`).
- "Preso" = `bot_outcome = 'APPUNTAMENTO'`. Nient'altro conta come preso.
- Soglia Attiva/Ferma = ultimo inbound del lead entro **22 ore**.
- Modello Claude: costante `claude-sonnet-4-6`. Client via `process.env.ANTHROPIC_API_KEY`, cache module-level `_client`, estrazione testo con `response.content.find(b => b.type === 'text')`.
- Le route API protette da utente replicano `requireUser()` inline (vedi `app/api/fenice/conversation/route.ts:10-14`). I cron usano `CRON_SECRET` (header `Authorization: Bearer` o `?secret=`).
- Runtime export su ogni route: `export const runtime = 'nodejs';` e `export const dynamic = 'force-dynamic';`. Sui cron aggiungi `export const maxDuration = 300;`.
- Supabase admin: `getSupabaseAdmin()` da `@/lib/supabase/admin`. Server authed: `getSupabaseServer()` da `@/lib/supabase/server`.
- Test runner: `vitest run` (`npm test`). Typecheck: `npm run typecheck` (MAI `npx tsc`). La suite intera deve restare verde.
- Categoria obiezione = set chiuso: `prezzo | tempo | sfiducia | garanzia_lavoro | ci_penso | altro | nessuna`. Valori fuori set → `altro`.
- DB: project Supabase `gosnmagiishkwuvmortj` (eu-west-1). Migration via MCP `apply_migration`; dopo, rigenera `lib/supabase/types.ts` via MCP `generate_typescript_types` e scrivilo su disco (l'MCP non scrive da solo).

---

### Task 1: Migration DB + rigenerazione tipi

**Files:**
- Create (migration via MCP): `add_lead_pipeline_columns`
- Modify: `lib/supabase/types.ts` (rigenerato)

**Interfaces:**
- Produces: colonne `conversations.ai_dropoff_stage text`, `ai_objection_category text`, `ai_objection_note text`, `ai_insight_at timestamptz`; tabella `lead_analysis_reports(id bigint identity pk, generated_at timestamptz default now(), period text default 'all', payload jsonb not null)`.

- [ ] **Step 1: Applicare la migration via MCP Supabase**

Usa lo strumento MCP `apply_migration` sul project `gosnmagiishkwuvmortj` con name `add_lead_pipeline_columns` e questo SQL:

```sql
alter table public.conversations
  add column if not exists ai_dropoff_stage text,
  add column if not exists ai_objection_category text,
  add column if not exists ai_objection_note text,
  add column if not exists ai_insight_at timestamptz;

create table if not exists public.lead_analysis_reports (
  id bigint generated always as identity primary key,
  generated_at timestamptz not null default now(),
  period text not null default 'all',
  payload jsonb not null
);

create index if not exists lead_analysis_reports_generated_at_idx
  on public.lead_analysis_reports (generated_at desc);
```

- [ ] **Step 2: Verificare lo schema**

Usa MCP `list_tables` (o `execute_sql` con `select column_name from information_schema.columns where table_name='conversations' and column_name like 'ai_%';`).
Expected: le 4 nuove colonne presenti + tabella `lead_analysis_reports` esistente.

- [ ] **Step 3: Rigenerare i tipi TypeScript**

Usa MCP `generate_typescript_types` sul project. Copia l'output COMPLETO e sovrascrivi `lib/supabase/types.ts` con lo strumento Write (l'MCP non scrive su disco da solo).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (nessun errore). I nuovi campi compaiono nel Row di `conversations` e c'è il tipo `lead_analysis_reports`.

- [ ] **Step 5: Commit**

```bash
git add lib/supabase/types.ts
git commit -m "feat(fenice): migration colonne insight lead + tabella lead_analysis_reports"
```

---

### Task 2: Logica di segmentazione (funzione pura, TDD)

**Files:**
- Create: `lib/lead-segments.ts`
- Test: `lib/lead-segments.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type LeadSegment = 'PRESO' | 'MAI_RISPOSTO' | 'ATTIVA' | 'FERMA';
  export interface SegmentInput {
    bot_outcome: string | null;
    last_inbound_at: string | null;
    ai_status: string | null;
  }
  // now: ISO string usato come "adesso" (per testabilità)
  export function segmentOf(c: SegmentInput, now: string): LeadSegment;
  export function fermaReason(c: SegmentInput, now: string): string | null; // 'RICHIAMO'|'DA_SCARTARE'|'NON_RISPOSTO'|'SILENTE'|null
  export const ACTIVE_WINDOW_MS: number; // 22h
  ```
- Regole (prima che matcha vince): `bot_outcome==='APPUNTAMENTO'` → `PRESO`; `last_inbound_at===null` → `MAI_RISPOSTO`; `ai_status` in `['active','replying']` e `last_inbound_at >= now-22h` → `ATTIVA`; altrimenti → `FERMA`.

- [ ] **Step 1: Scrivere i test che falliscono**

Crea `lib/lead-segments.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { segmentOf, fermaReason, ACTIVE_WINDOW_MS } from './lead-segments';

const NOW = '2026-06-22T18:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3600_000).toISOString();

describe('segmentOf', () => {
  it('APPUNTAMENTO vince sempre → PRESO', () => {
    expect(segmentOf({ bot_outcome: 'APPUNTAMENTO', last_inbound_at: null, ai_status: 'closed' }, NOW)).toBe('PRESO');
  });
  it('nessun inbound → MAI_RISPOSTO', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: null, ai_status: 'active' }, NOW)).toBe('MAI_RISPOSTO');
  });
  it('ha risposto da poco e chat viva → ATTIVA', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: hoursAgo(2), ai_status: 'active' }, NOW)).toBe('ATTIVA');
  });
  it('ha risposto oltre 22h → FERMA (silente)', () => {
    expect(segmentOf({ bot_outcome: null, last_inbound_at: hoursAgo(30), ai_status: 'active' }, NOW)).toBe('FERMA');
  });
  it('chat chiusa pur con inbound recente → FERMA', () => {
    expect(segmentOf({ bot_outcome: 'NON_RISPOSTO', last_inbound_at: hoursAgo(1), ai_status: 'closed' }, NOW)).toBe('FERMA');
  });
});

describe('fermaReason', () => {
  it('usa bot_outcome se presente', () => {
    expect(fermaReason({ bot_outcome: 'DA_SCARTARE', last_inbound_at: hoursAgo(1), ai_status: 'closed' }, NOW)).toBe('DA_SCARTARE');
  });
  it('SILENTE se ha risposto ma niente esito e oltre soglia', () => {
    expect(fermaReason({ bot_outcome: null, last_inbound_at: hoursAgo(30), ai_status: 'active' }, NOW)).toBe('SILENTE');
  });
  it('null per segmenti non FERMA', () => {
    expect(fermaReason({ bot_outcome: null, last_inbound_at: hoursAgo(1), ai_status: 'active' }, NOW)).toBeNull();
  });
});

describe('ACTIVE_WINDOW_MS', () => {
  it('è 22 ore', () => {
    expect(ACTIVE_WINDOW_MS).toBe(22 * 3600_000);
  });
});
```

- [ ] **Step 2: Eseguire i test per verificarne il fallimento**

Run: `npx vitest run lib/lead-segments.test.ts`
Expected: FAIL — modulo `./lead-segments` non trovato.

- [ ] **Step 3: Implementare il modulo**

Crea `lib/lead-segments.ts`:

```typescript
export type LeadSegment = 'PRESO' | 'MAI_RISPOSTO' | 'ATTIVA' | 'FERMA';

export interface SegmentInput {
  bot_outcome: string | null;
  last_inbound_at: string | null;
  ai_status: string | null;
}

export const ACTIVE_WINDOW_MS = 22 * 3600_000;

const LIVE_STATUSES = ['active', 'replying'];

export function segmentOf(c: SegmentInput, now: string): LeadSegment {
  if (c.bot_outcome === 'APPUNTAMENTO') return 'PRESO';
  if (!c.last_inbound_at) return 'MAI_RISPOSTO';
  const fresh = Date.parse(now) - Date.parse(c.last_inbound_at) <= ACTIVE_WINDOW_MS;
  if (LIVE_STATUSES.includes(c.ai_status ?? '') && fresh) return 'ATTIVA';
  return 'FERMA';
}

export function fermaReason(c: SegmentInput, now: string): string | null {
  if (segmentOf(c, now) !== 'FERMA') return null;
  if (c.bot_outcome) return c.bot_outcome;
  return 'SILENTE';
}
```

- [ ] **Step 4: Eseguire i test (verde)**

Run: `npx vitest run lib/lead-segments.test.ts`
Expected: PASS (tutti).

- [ ] **Step 5: Commit**

```bash
git add lib/lead-segments.ts lib/lead-segments.test.ts
git commit -m "feat(fenice): logica pura di segmentazione lead (PRESO/MAI_RISPOSTO/ATTIVA/FERMA)"
```

---

### Task 3: API segmenti — `GET /api/fenice/segments`

**Files:**
- Create: `app/api/fenice/segments/route.ts`

**Interfaces:**
- Consumes: `segmentOf`, `fermaReason` (Task 2); `getSupabaseAdmin`, `getSupabaseServer`.
- Produces: risposta JSON
  ```typescript
  // GET /api/fenice/segments?segment=ATTIVA|MAI_RISPOSTO|FERMA|PRESO&period=7|30|all&q=<text>
  {
    ok: true,
    counts: { PRESO: number, MAI_RISPOSTO: number, ATTIVA: number, FERMA: number, total: number },
    rows: Array<{ id: number; phone: string; name: string; segment: LeadSegment; reason: string | null; lastMessageAt: string; lastInboundAt: string | null; status: string | null }>
  }
  ```
- `counts` è sempre calcolato sull'intera popolazione del periodo; `rows` è filtrata per `segment` (se passato) e `q`.

- [ ] **Step 1: Implementare la route**

Crea `app/api/fenice/segments/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { segmentOf, fermaReason, type LeadSegment } from '@/lib/lead-segments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

function periodStartIso(period: string): string | null {
  if (period === '7') return new Date(Date.now() - 7 * 86400_000).toISOString();
  if (period === '30') return new Date(Date.now() - 30 * 86400_000).toISOString();
  return null;
}

export async function GET(req: NextRequest) {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });

  const sp = req.nextUrl.searchParams;
  const segment = sp.get('segment') as LeadSegment | null;
  const period = sp.get('period') ?? 'all';
  const q = (sp.get('q') ?? '').trim().toLowerCase();
  const now = new Date().toISOString();

  const admin = getSupabaseAdmin();
  let query = admin
    .from('conversations')
    .select('id, ai_status, bot_outcome, last_message_at, last_inbound_at, created_at, leads(phone_e164, first_name, last_name)')
    .eq('ai_owner', 'mario')
    .order('last_message_at', { ascending: false })
    .limit(1000);

  const since = periodStartIso(period);
  if (since) query = query.gte('created_at', since);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const counts = { PRESO: 0, MAI_RISPOSTO: 0, ATTIVA: 0, FERMA: 0, total: 0 };
  const rows: Array<{ id: number; phone: string; name: string; segment: LeadSegment; reason: string | null; lastMessageAt: string; lastInboundAt: string | null; status: string | null }> = [];

  for (const c of (data ?? []) as any[]) {
    const input = { bot_outcome: c.bot_outcome ?? null, last_inbound_at: c.last_inbound_at ?? null, ai_status: c.ai_status ?? null };
    const seg = segmentOf(input, now);
    counts[seg]++;
    counts.total++;

    const phone = c.leads?.phone_e164 ?? '';
    const name = [c.leads?.first_name, c.leads?.last_name].filter(Boolean).join(' ');
    if (segment && seg !== segment) continue;
    if (q && !(`${phone} ${name}`.toLowerCase().includes(q))) continue;

    rows.push({
      id: c.id, phone, name, segment: seg,
      reason: fermaReason(input, now),
      lastMessageAt: c.last_message_at, lastInboundAt: c.last_inbound_at ?? null,
      status: c.ai_status ?? null,
    });
  }

  return NextResponse.json({ ok: true, counts, rows });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke test manuale (dev server)**

Run: `npm run dev` poi in un altro terminale (autenticato via browser, oppure verifica solo lo status 401 senza cookie):
`curl -s "http://localhost:3000/api/fenice/segments?period=all" -i | head -n 1`
Expected: `HTTP/1.1 401` senza sessione (conferma che la guardia auth funziona). Con sessione valida dal browser: JSON con `counts`.

- [ ] **Step 4: Commit**

```bash
git add app/api/fenice/segments/route.ts
git commit -m "feat(fenice): API segments con conteggi e liste per segmento"
```

---

### Task 4: API report — `GET /api/fenice/report`

**Files:**
- Create: `app/api/fenice/report/route.ts`

**Interfaces:**
- Consumes: `segmentOf` (Task 2); `getSupabaseAdmin`, `getSupabaseServer`.
- Produces:
  ```typescript
  // GET /api/fenice/report?period=7|30|all
  {
    ok: true,
    period: string,
    total: number,
    presi: number,            // PRESO
    nonPresi: number,         // total - presi
    conversionRate: number,   // presi/total (0..1), 0 se total=0
    maiRisposto: number,
    maiRispostoShareOfNonPresi: number, // maiRisposto/nonPresi (0..1), 0 se nonPresi=0
    bySegment: { PRESO: number; MAI_RISPOSTO: number; ATTIVA: number; FERMA: number },
    byFunnel: Array<{ funnel: string; total: number; presi: number }>
  }
  ```

- [ ] **Step 1: Implementare la route**

Crea `app/api/fenice/report/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { segmentOf, type LeadSegment } from '@/lib/lead-segments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

function periodStartIso(period: string): string | null {
  if (period === '7') return new Date(Date.now() - 7 * 86400_000).toISOString();
  if (period === '30') return new Date(Date.now() - 30 * 86400_000).toISOString();
  return null;
}

export async function GET(req: NextRequest) {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });

  const period = req.nextUrl.searchParams.get('period') ?? 'all';
  const now = new Date().toISOString();
  const admin = getSupabaseAdmin();

  let query = admin
    .from('conversations')
    .select('ai_status, bot_outcome, last_inbound_at, crm_funnel, created_at')
    .eq('ai_owner', 'mario')
    .limit(5000);
  const since = periodStartIso(period);
  if (since) query = query.gte('created_at', since);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const bySegment = { PRESO: 0, MAI_RISPOSTO: 0, ATTIVA: 0, FERMA: 0 } as Record<LeadSegment, number>;
  const funnelMap = new Map<string, { total: number; presi: number }>();

  for (const c of (data ?? []) as any[]) {
    const seg = segmentOf({ bot_outcome: c.bot_outcome ?? null, last_inbound_at: c.last_inbound_at ?? null, ai_status: c.ai_status ?? null }, now);
    bySegment[seg]++;
    const funnel = (c.crm_funnel ?? '—') as string;
    const f = funnelMap.get(funnel) ?? { total: 0, presi: 0 };
    f.total++;
    if (seg === 'PRESO') f.presi++;
    funnelMap.set(funnel, f);
  }

  const total = bySegment.PRESO + bySegment.MAI_RISPOSTO + bySegment.ATTIVA + bySegment.FERMA;
  const presi = bySegment.PRESO;
  const nonPresi = total - presi;
  const byFunnel = [...funnelMap.entries()].map(([funnel, v]) => ({ funnel, total: v.total, presi: v.presi }))
    .sort((a, b) => b.total - a.total);

  return NextResponse.json({
    ok: true, period, total, presi, nonPresi,
    conversionRate: total ? presi / total : 0,
    maiRisposto: bySegment.MAI_RISPOSTO,
    maiRispostoShareOfNonPresi: nonPresi ? bySegment.MAI_RISPOSTO / nonPresi : 0,
    bySegment, byFunnel,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/fenice/report/route.ts
git commit -m "feat(fenice): API report presi/non presi con breakdown segmenti e funnel"
```

---

### Task 5: Libreria analisi AI (Claude, TDD)

**Files:**
- Create: `lib/lead-analysis.ts`
- Test: `lib/lead-analysis.test.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/sdk`, `MarioTurn` da `@/lib/mario`.
- Produces:
  ```typescript
  export const ANALYSIS_MODEL = 'claude-sonnet-4-6';
  export type ObjectionCategory = 'prezzo' | 'tempo' | 'sfiducia' | 'garanzia_lavoro' | 'ci_penso' | 'altro' | 'nessuna';
  export interface LeadInsight { dropoffStage: string; objectionCategory: ObjectionCategory; objectionNote: string; }
  export function normalizeCategory(raw: string): ObjectionCategory; // forza nel set chiuso
  export function extractLeadInsight(history: MarioTurn[]): Promise<LeadInsight>; // Stadio 1
  export interface AggregateInput { insights: LeadInsight[]; maiRisposto: number; respondedNotTaken: number; }
  export interface AggregateReport {
    topObjections: Array<{ category: ObjectionCategory; count: number }>;
    dropoffStages: Array<{ stage: string; count: number }>;
    maiRisposto: number;
    respondedNotTaken: number;
    narrative: string;           // insight + suggerimenti per lo script di Mario
  }
  export function aggregateInsights(input: AggregateInput): Promise<AggregateReport>; // Stadio 2
  ```

- [ ] **Step 1: Scrivere i test che falliscono**

Crea `lib/lead-analysis.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import { normalizeCategory, extractLeadInsight, aggregateInsights, ANALYSIS_MODEL } from './lead-analysis';

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

describe('normalizeCategory', () => {
  it('riconosce le categorie valide', () => {
    expect(normalizeCategory('prezzo')).toBe('prezzo');
    expect(normalizeCategory('GARANZIA_LAVORO')).toBe('garanzia_lavoro');
  });
  it('valori fuori set → altro', () => {
    expect(normalizeCategory('boh qualcosa')).toBe('altro');
    expect(normalizeCategory('')).toBe('altro');
  });
});

describe('extractLeadInsight', () => {
  it('parsa il JSON di Claude e normalizza la categoria', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"dropoffStage":"dopo il prezzo","objectionCategory":"prezzo","objectionNote":"costa troppo"}' }],
    });
    const out = await extractLeadInsight([{ role: 'user', content: 'quanto costa?' }]);
    expect(out).toEqual({ dropoffStage: 'dopo il prezzo', objectionCategory: 'prezzo', objectionNote: 'costa troppo' });
    expect(messagesCreate.mock.calls[0][0].model).toBe(ANALYSIS_MODEL);
  });
  it('categoria sconosciuta → altro', async () => {
    messagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"dropoffStage":"x","objectionCategory":"strana","objectionNote":"y"}' }],
    });
    const out = await extractLeadInsight([{ role: 'user', content: 'ciao' }]);
    expect(out.objectionCategory).toBe('altro');
  });
});

describe('aggregateInsights', () => {
  it('conta obiezioni e stadi, e include la narrativa di Claude', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Il prezzo è il blocco principale. Suggerimento: anticipare il valore.' }] });
    const out = await aggregateInsights({
      insights: [
        { dropoffStage: 'dopo il prezzo', objectionCategory: 'prezzo', objectionNote: 'a' },
        { dropoffStage: 'dopo il prezzo', objectionCategory: 'prezzo', objectionNote: 'b' },
        { dropoffStage: 'apertura', objectionCategory: 'sfiducia', objectionNote: 'c' },
      ],
      maiRisposto: 10,
      respondedNotTaken: 3,
    });
    expect(out.topObjections[0]).toEqual({ category: 'prezzo', count: 2 });
    expect(out.dropoffStages.find(s => s.stage === 'dopo il prezzo')?.count).toBe(2);
    expect(out.maiRisposto).toBe(10);
    expect(out.narrative).toContain('prezzo');
  });
  it('senza insight non chiama Claude e dà narrativa di fallback', async () => {
    const out = await aggregateInsights({ insights: [], maiRisposto: 5, respondedNotTaken: 0 });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(out.topObjections).toEqual([]);
    expect(out.narrative).toMatch(/dati insufficienti/i);
  });
});
```

- [ ] **Step 2: Eseguire i test per verificarne il fallimento**

Run: `npx vitest run lib/lead-analysis.test.ts`
Expected: FAIL — modulo `./lead-analysis` non trovato.

- [ ] **Step 3: Implementare il modulo**

Crea `lib/lead-analysis.ts`:

```typescript
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
    return { topObjections, dropoffStages, maiRisposto: input.maiRisposto, respondedNotTaken: input.respondedNotTaken, narrative: 'Dati insufficienti: nessun lead che ha risposto senza prendere l’appuntamento nel periodo.' };
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
```

- [ ] **Step 4: Eseguire i test (verde)**

Run: `npx vitest run lib/lead-analysis.test.ts`
Expected: PASS (tutti).

- [ ] **Step 5: Commit**

```bash
git add lib/lead-analysis.ts lib/lead-analysis.test.ts
git commit -m "feat(fenice): libreria analisi AI lead (estrazione per-chat + aggregazione Claude)"
```

---

### Task 6: Cron analisi giornaliera — `GET /api/cron/lead-analysis`

**Files:**
- Create: `app/api/cron/lead-analysis/route.ts`
- Modify: `vercel.json` (aggiungi entry cron)

**Interfaces:**
- Consumes: `extractLeadInsight`, `aggregateInsights` (Task 5); `segmentOf` (Task 2); `getSupabaseAdmin`.
- Comportamento: (1) seleziona le conversazioni Mario che hanno risposto e non sono PRESO; (2) per quelle senza insight o con `last_message_at > ai_insight_at` (cap `MAX_PER_RUN = 40`) carica i messaggi dopo `ai_started_at`, chiama `extractLeadInsight`, salva le 4 colonne insight; (3) raccoglie tutti gli insight in cache, conta `maiRisposto`, chiama `aggregateInsights`, inserisce una riga in `lead_analysis_reports`; (4) logga su `event_log` (`type='lead_analysis'`).

- [ ] **Step 1: Implementare la route cron**

Crea `app/api/cron/lead-analysis/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { segmentOf } from '@/lib/lead-segments';
import { extractLeadInsight, aggregateInsights, type LeadInsight, type ObjectionCategory } from '@/lib/lead-analysis';
import type { MarioTurn } from '@/lib/mario';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_PER_RUN = 40;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const admin = getSupabaseAdmin();
  const now = new Date().toISOString();

  // Tutte le conversazioni Mario per conteggi + selezione estrazioni
  const { data: convs, error } = await admin
    .from('conversations')
    .select('id, ai_status, bot_outcome, last_inbound_at, last_message_at, ai_started_at, ai_insight_at, ai_dropoff_stage, ai_objection_category, ai_objection_note')
    .eq('ai_owner', 'mario')
    .limit(5000);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const respondedNotTaken = (convs ?? []).filter((c: any) =>
    c.last_inbound_at && c.bot_outcome !== 'APPUNTAMENTO');
  const maiRisposto = (convs ?? []).filter((c: any) =>
    segmentOf({ bot_outcome: c.bot_outcome ?? null, last_inbound_at: c.last_inbound_at ?? null, ai_status: c.ai_status ?? null }, now) === 'MAI_RISPOSTO').length;

  // Selezione da (ri)analizzare
  const stale = respondedNotTaken.filter((c: any) =>
    !c.ai_insight_at || (c.last_message_at && c.last_message_at > c.ai_insight_at)).slice(0, MAX_PER_RUN);

  let extracted = 0;
  for (const c of stale as any[]) {
    const { data: msgs } = await admin
      .from('messages')
      .select('direction, body, created_at')
      .eq('conversation_id', c.id)
      .gte('created_at', c.ai_started_at ?? '1970-01-01')
      .order('created_at', { ascending: true })
      .limit(200);
    const history: MarioTurn[] = (msgs ?? []).map((m: any) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));
    if (history.length === 0) continue;
    try {
      const insight = await extractLeadInsight(history);
      await admin.from('conversations').update({
        ai_dropoff_stage: insight.dropoffStage,
        ai_objection_category: insight.objectionCategory,
        ai_objection_note: insight.objectionNote,
        ai_insight_at: new Date().toISOString(),
      }).eq('id', c.id);
      extracted++;
    } catch { /* salta questa conversazione, riprova al prossimo run */ }
  }

  // Rileggi gli insight in cache (dopo gli update) per l'aggregato
  const { data: cached } = await admin
    .from('conversations')
    .select('ai_dropoff_stage, ai_objection_category, ai_objection_note, last_inbound_at, bot_outcome')
    .eq('ai_owner', 'mario')
    .not('ai_insight_at', 'is', null);

  const insights: LeadInsight[] = (cached ?? [])
    .filter((c: any) => c.last_inbound_at && c.bot_outcome !== 'APPUNTAMENTO' && c.ai_objection_category)
    .map((c: any) => ({
      dropoffStage: c.ai_dropoff_stage ?? 'non chiaro',
      objectionCategory: (c.ai_objection_category ?? 'altro') as ObjectionCategory,
      objectionNote: c.ai_objection_note ?? '',
    }));

  const report = await aggregateInsights({ insights, maiRisposto, respondedNotTaken: respondedNotTaken.length });

  await admin.from('lead_analysis_reports').insert({ period: 'all', payload: report as any });
  await admin.from('event_log').insert({
    type: 'lead_analysis', level: 'info',
    message: `analisi lead: ${extracted} estratti, ${insights.length} in aggregato`,
    payload: { extracted, insights: insights.length, capped: stale.length === MAX_PER_RUN },
  });

  return NextResponse.json({ ok: true, extracted, aggregated: insights.length, capped: stale.length === MAX_PER_RUN });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Aggiungere il cron a `vercel.json`**

Aggiungi questa entry all'array `crons` (dopo `bot-followups`), girata ogni giorno alle 04:00 UTC:

```json
    {
      "path": "/api/cron/lead-analysis",
      "schedule": "0 4 * * *"
    }
```

- [ ] **Step 4: Smoke test locale**

Run (dev server attivo, con `CRON_SECRET` in `.env.local`):
`curl -s "http://localhost:3000/api/cron/lead-analysis?secret=$CRON_SECRET"`
Expected: JSON `{ ok: true, extracted: <n>, aggregated: <n>, capped: <bool> }`. Verifica che una riga sia comparsa in `lead_analysis_reports` (MCP `execute_sql`: `select id, generated_at from lead_analysis_reports order by id desc limit 1;`).

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/lead-analysis/route.ts vercel.json
git commit -m "feat(fenice): cron giornaliero analisi AI lead + entry vercel.json"
```

---

### Task 7: API ultimo report — `GET /api/fenice/analysis`

**Files:**
- Create: `app/api/fenice/analysis/route.ts`

**Interfaces:**
- Consumes: `getSupabaseAdmin`, `getSupabaseServer`.
- Produces:
  ```typescript
  // GET /api/fenice/analysis
  { ok: true, generatedAt: string | null, report: AggregateReport | null }
  ```

- [ ] **Step 1: Implementare la route**

Crea `app/api/fenice/analysis/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

export async function GET() {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });

  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('lead_analysis_reports')
    .select('generated_at, payload')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    generatedAt: data?.generated_at ?? null,
    report: (data?.payload as any) ?? null,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/fenice/analysis/route.ts
git commit -m "feat(fenice): API ultimo report analisi AI"
```

---

### Task 8: UI pagina Lead con tab + voce sidebar

**Files:**
- Create: `app/(fenice)/fenice/lead/page.tsx` (server component, guscio)
- Create: `app/(fenice)/fenice/lead/_components/LeadPipeline.tsx` (client component, tab + fetch)
- Modify: `components/FeniceSidebar.tsx:9-13` (aggiungi voce "Lead")

**Interfaces:**
- Consumes: API `/api/fenice/segments`, `/api/fenice/report`, `/api/fenice/analysis` (Task 3,4,7).
- La pagina è un server component minimale (solo auth implicita dal layout) che monta `<LeadPipeline />` (client) il quale fa fetch dei dati e gestisce i tab.

- [ ] **Step 1: Aggiungere la voce di navigazione**

In `components/FeniceSidebar.tsx`, importa un'icona (es. `Users` da `lucide-react`, già usato per le altre icone) e aggiungi all'array `NAV` (righe 9-13):

```typescript
  { href: '/fenice/lead', label: 'Lead', icon: Users },
```

(assicurati che `Users` sia nell'import da `lucide-react` in cima al file).

- [ ] **Step 2: Creare il guscio server della pagina**

Crea `app/(fenice)/fenice/lead/page.tsx`:

```typescript
import { LeadPipeline } from './_components/LeadPipeline';

export const dynamic = 'force-dynamic';

export default function FeniceLeadPage() {
  return (
    <div className="h-full overflow-auto">
      <LeadPipeline />
    </div>
  );
}
```

- [ ] **Step 3: Creare il client component con i tab**

Crea `app/(fenice)/fenice/lead/_components/LeadPipeline.tsx`:

```typescript
'use client';

import { useEffect, useState } from 'react';

type Tab = 'ATTIVA' | 'MAI_RISPOSTO' | 'FERMA' | 'REPORT' | 'ANALISI';

const SEGMENT_TABS: { key: Tab; label: string }[] = [
  { key: 'ATTIVA', label: 'Attive' },
  { key: 'MAI_RISPOSTO', label: 'Mai risposto' },
  { key: 'FERMA', label: 'Ferme' },
  { key: 'REPORT', label: 'Report' },
  { key: 'ANALISI', label: 'Analisi AI' },
];

interface SegRow { id: number; phone: string; name: string; segment: string; reason: string | null; lastMessageAt: string; status: string | null; }
interface Counts { PRESO: number; MAI_RISPOSTO: number; ATTIVA: number; FERMA: number; total: number; }

export function LeadPipeline() {
  const [tab, setTab] = useState<Tab>('ATTIVA');
  const [period, setPeriod] = useState('all');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [rows, setRows] = useState<SegRow[]>([]);
  const [report, setReport] = useState<any>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      if (tab === 'REPORT') {
        const r = await fetch(`/api/fenice/report?period=${period}`).then((x) => x.json());
        if (active) setReport(r);
      } else if (tab === 'ANALISI') {
        const r = await fetch('/api/fenice/analysis').then((x) => x.json());
        if (active) setAnalysis(r);
      } else {
        const r = await fetch(`/api/fenice/segments?segment=${tab}&period=${period}`).then((x) => x.json());
        if (active) { setCounts(r.counts); setRows(r.rows ?? []); }
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [tab, period]);

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {SEGMENT_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 rounded-md text-sm ${tab === t.key ? 'bg-black text-white' : 'bg-gray-100 text-gray-700'}`}>
            {t.label}
            {counts && t.key in counts ? ` (${(counts as any)[t.key]})` : ''}
          </button>
        ))}
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="ml-auto border rounded-md px-2 py-1 text-sm">
          <option value="7">Ultimi 7 giorni</option>
          <option value="30">Ultimi 30 giorni</option>
          <option value="all">Tutto</option>
        </select>
      </div>

      {loading && <p className="text-sm text-gray-500">Caricamento…</p>}

      {!loading && tab === 'REPORT' && report?.ok && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Totale lead" value={report.total} />
            <Stat label="Presi" value={report.presi} />
            <Stat label="Non presi" value={report.nonPresi} />
            <Stat label="Conversione" value={`${(report.conversionRate * 100).toFixed(1)}%`} />
          </div>
          <p className="text-sm text-gray-600">
            Mai risposto: <b>{report.maiRisposto}</b> — pari al <b>{(report.maiRispostoShareOfNonPresi * 100).toFixed(0)}%</b> dei non presi.
          </p>
          <div className="border rounded-md divide-y">
            {report.byFunnel.map((f: any) => (
              <div key={f.funnel} className="flex justify-between px-3 py-2 text-sm">
                <span>{f.funnel}</span><span>{f.presi}/{f.total} presi</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!loading && tab === 'ANALISI' && analysis?.ok && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            {analysis.generatedAt ? `Aggiornato il ${new Date(analysis.generatedAt).toLocaleString('it-IT')}` : 'Nessuna analisi ancora generata'}
          </p>
          {analysis.report && (
            <>
              <div className="border rounded-md p-3">
                <h3 className="text-sm font-semibold mb-2">Obiezioni principali</h3>
                {analysis.report.topObjections.map((o: any) => (
                  <div key={o.category} className="flex justify-between text-sm py-0.5">
                    <span>{o.category}</span><span>{o.count}</span>
                  </div>
                ))}
              </div>
              <div className="border rounded-md p-3">
                <h3 className="text-sm font-semibold mb-2">Dove si bloccano</h3>
                {analysis.report.dropoffStages.map((s: any) => (
                  <div key={s.stage} className="flex justify-between text-sm py-0.5">
                    <span>{s.stage}</span><span>{s.count}</span>
                  </div>
                ))}
              </div>
              <div className="border rounded-md p-3 whitespace-pre-wrap text-sm">{analysis.report.narrative}</div>
            </>
          )}
        </div>
      )}

      {!loading && (tab === 'ATTIVA' || tab === 'MAI_RISPOSTO' || tab === 'FERMA') && (
        <div className="border rounded-md divide-y">
          {rows.length === 0 && <p className="px-3 py-4 text-sm text-gray-500">Nessun lead in questo segmento.</p>}
          {rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <div>
                <div className="font-medium">{r.name || r.phone}</div>
                <div className="text-gray-500 text-xs">{r.phone}{r.reason ? ` · ${r.reason}` : ''}</div>
              </div>
              <a href={`/fenice/conversazioni?id=${r.id}`} className="text-blue-600 text-xs">Apri</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border rounded-md p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Verifica visiva (browser)**

Run: `npm run dev`, apri `http://localhost:3000/fenice/lead` (loggato). Verifica: i tab cambiano, i contatori compaiono accanto alle etichette, Report mostra le card, Analisi AI mostra "Nessuna analisi ancora generata" finché il cron non gira (o dopo lo smoke test del Task 6).

- [ ] **Step 6: Commit**

```bash
git add app/(fenice)/fenice/lead/page.tsx app/(fenice)/fenice/lead/_components/LeadPipeline.tsx components/FeniceSidebar.tsx
git commit -m "feat(fenice): pagina Lead con tab segmenti/report/analisi + voce sidebar"
```

---

### Task 9: Verifica finale e deploy

**Files:** nessuno nuovo (verifica integrata).

- [ ] **Step 1: Suite intera verde**

Run: `npm test`
Expected: tutti i test PASS (inclusi i nuovi `lead-segments` e `lead-analysis`).

- [ ] **Step 2: Typecheck finale**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Push del branch**

```bash
git push -u origin feat/fenice-lead-pipeline
```

- [ ] **Step 4: Deploy**

Deploy su Vercel production via MCP `deploy_to_vercel` (o merge su `main` se è il flusso preferito). Dopo il deploy, imposta/verifica che `CRON_SECRET` e `ANTHROPIC_API_KEY` siano presenti in produzione e che il nuovo cron compaia nel dashboard Vercel.

- [ ] **Step 5: Trigger manuale prima esecuzione analisi**

In produzione, chiama una volta `GET /api/cron/lead-analysis` con il secret per popolare il primo report, così la tab Analisi AI non è vuota.

---

## Note di self-review

- **Copertura spec:** segmentazione (Task 2/3), report presi/non presi + quota mai-risposto (Task 4), analisi AI due stadi + cron giornaliero (Task 5/6), API ultimo report (Task 7), UI tab + sidebar (Task 8), migration + tipi (Task 1). Tutte le sezioni della spec hanno un task.
- **Coerenza tipi:** `LeadSegment`, `SegmentInput`, `ObjectionCategory`, `LeadInsight`, `AggregateReport` usati in modo identico tra lib, route e cron.
- **Cap di sicurezza** `MAX_PER_RUN=40` sul cron, loggato come `capped`, coerente con la spec.
- **Soglia 22h** centralizzata in `ACTIVE_WINDOW_MS` (Task 2), riusata ovunque via `segmentOf`.
