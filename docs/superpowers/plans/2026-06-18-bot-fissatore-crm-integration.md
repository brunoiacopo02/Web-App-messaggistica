# Bot Fissatore ↔ CRM Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrare il bot Mario col CRM Fenice: ricevere lead via webhook firmato HMAC (Direzione 1) e restituire l'esito + report firmato HMAC (Direzione 2), con 4 esiti, data strutturata da Mario, solleciti e NON_RISPOSTO via cron.

**Architecture:** Funzioni pure isolate e testabili (HMAC, validazione contratto, parsing esiti Mario, decisione follow-up) sotto `lib/`, due route handler (`/api/bot/intake`, `/api/cron/bot-followups`), un sender outcome (`lib/bot-outcome.ts`) innescato dentro `drainMarioReplies`, e un refactor condiviso dell'arruolamento (`lib/fenice-enroll.ts`). Mario emette tag `[ESITO:...]` con data ISO assoluta calcolata iniettando l'ora corrente `Europe/Rome`.

**Tech Stack:** Next.js 16 (App Router, route handlers), Supabase (admin client), Anthropic SDK (`claude-sonnet-4-6`), Node `crypto`, vitest.

## Global Constraints

- Runtime route handlers: `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';`
- Firma HMAC: header `x-bot-signature`, formato `sha256=<hex(HMAC-SHA256(rawBody, BOT_WEBHOOK_SECRET))>`, confronto **timing-safe**, calcolata sul **raw body esatto in byte**.
- `date` per `APPUNTAMENTO`/`RICHIAMO`: ISO 8601 **con offset** (`Z` o `±HH:MM`) — senza offset è invalida.
- `BotOutcome` = `'APPUNTAMENTO' | 'DA_SCARTARE' | 'RICHIAMO' | 'NON_RISPOSTO'`.
- `companyId` dei lead bot è sempre `'fenice'`.
- CRM outcome URL default: `https://crm-sales-fenice.vercel.app/api/bot/outcome` (env `CRM_OUTCOME_URL`).
- Modello Anthropic: `claude-sonnet-4-6`, `thinking: { type: 'disabled' }`.
- Cron protetti da `CRON_SECRET` (header `Authorization: Bearer <CRON_SECRET>` oppure `?secret=`).
- Tutti i log applicativi dell'integrazione usano `type` con prefisso `bot_` e messaggi con tag `[bot-fissatore]`.
- I 65 test esistenti devono restare verdi.

---

### Task 1: Migration + tipi Supabase

**Files:**
- Create: `supabase/migrations/20260618000008_bot_crm.sql`
- Modify: `lib/supabase/types.ts` (sezione `conversations` Row/Insert/Update)

**Interfaces:**
- Produces: colonne `conversations.crm_lead_id`, `crm_funnel`, `bot_outcome`, `bot_outcome_at`, `bot_scheduled_at`, `bot_report`, `bot_followups_sent`; valore `ai_status='closed'`.

- [ ] **Step 1: Scrivere la migration**

```sql
-- Integrazione Bot Fissatore ↔ CRM: routing del callback + stato esito sulla conversazione.

alter table conversations
  add column if not exists crm_lead_id        text,
  add column if not exists crm_funnel         text,
  add column if not exists bot_outcome        text,
  add column if not exists bot_outcome_at     timestamptz,
  add column if not exists bot_scheduled_at   timestamptz,
  add column if not exists bot_report         jsonb,
  add column if not exists bot_followups_sent int not null default 0;

create index if not exists conversations_crm_lead_id_idx on conversations(crm_lead_id);
```

- [ ] **Step 2: Applicare la migration al DB remoto**

Applicare via Supabase MCP `apply_migration` (project_id `gosnmagiishkwuvmortj`, name `bot_crm`) con lo stesso SQL.
Expected: `{"success":true}`.

- [ ] **Step 3: Aggiornare i tipi in `lib/supabase/types.ts`**

Nel blocco `conversations` aggiungere a `Row`:
```ts
          bot_followups_sent: number
          bot_outcome: string | null
          bot_outcome_at: string | null
          bot_report: Json | null
          bot_scheduled_at: string | null
          crm_funnel: string | null
          crm_lead_id: string | null
```
e i corrispondenti opzionali in `Insert` e `Update`:
```ts
          bot_followups_sent?: number
          bot_outcome?: string | null
          bot_outcome_at?: string | null
          bot_report?: Json | null
          bot_scheduled_at?: string | null
          crm_funnel?: string | null
          crm_lead_id?: string | null
```
(In alternativa rigenerare l'intero file via Supabase MCP `generate_typescript_types` e sovrascriverlo.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260618000008_bot_crm.sql lib/supabase/types.ts
git commit -m "feat(bot): migration colonne CRM + esito su conversations"
```

---

### Task 2: `lib/bot-hmac.ts` — firma e verifica HMAC

**Files:**
- Create: `lib/bot-hmac.ts`
- Test: `lib/bot-hmac.test.ts`

**Interfaces:**
- Produces:
  - `signPayload(rawBody: string, secret: string): string`
  - `verifySignature(rawBody: string, signatureHeader: string | null | undefined, secret: string): { valid: true } | { valid: false; reason: string }`

- [ ] **Step 1: Scrivere il test che fallisce**

```ts
import { describe, it, expect } from 'vitest';
import { signPayload, verifySignature } from './bot-hmac';

const SECRET = 'shh-secret';
const BODY = JSON.stringify({ a: 1, b: 'x' });

describe('bot-hmac', () => {
  it('sign produce prefisso sha256= ed è verificabile', () => {
    const sig = signPayload(BODY, SECRET);
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifySignature(BODY, sig, SECRET)).toEqual({ valid: true });
  });

  it('firma mancante → missing_signature', () => {
    expect(verifySignature(BODY, null, SECRET)).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('prefisso errato → bad_prefix', () => {
    expect(verifySignature(BODY, 'md5=abcd', SECRET)).toEqual({ valid: false, reason: 'bad_prefix' });
  });

  it('lunghezza diversa → length_mismatch', () => {
    expect(verifySignature(BODY, 'sha256=dead', SECRET)).toEqual({ valid: false, reason: 'length_mismatch' });
  });

  it('body manomesso → signature_mismatch', () => {
    const sig = signPayload(BODY, SECRET);
    expect(verifySignature(BODY + ' ', sig, SECRET)).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('secret errato → signature_mismatch', () => {
    const sig = signPayload(BODY, SECRET);
    expect(verifySignature(BODY, sig, 'other')).toEqual({ valid: false, reason: 'signature_mismatch' });
  });
});
```

- [ ] **Step 2: Eseguire il test (deve fallire)**

Run: `npx vitest run lib/bot-hmac.test.ts`
Expected: FAIL ("Cannot find module './bot-hmac'").

- [ ] **Step 3: Implementare `lib/bot-hmac.ts`**

```ts
import crypto from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';

/** Genera l'header `x-bot-signature` per `rawBody` (la stringa JSON esatta inviata). */
export function signPayload(rawBody: string, secret: string): string {
  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

/** Verifica timing-safe della firma ricevuta in `x-bot-signature`. */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): { valid: true } | { valid: false; reason: string } {
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return { valid: false, reason: 'bad_prefix' };

  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);

  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(providedHex, 'hex');
  if (a.length !== b.length) return { valid: false, reason: 'length_mismatch' };

  return crypto.timingSafeEqual(a, b)
    ? { valid: true }
    : { valid: false, reason: 'signature_mismatch' };
}
```

- [ ] **Step 4: Eseguire il test (deve passare)**

Run: `npx vitest run lib/bot-hmac.test.ts`
Expected: PASS (6 test).

- [ ] **Step 5: Commit**

```bash
git add lib/bot-hmac.ts lib/bot-hmac.test.ts
git commit -m "feat(bot): firma/verifica HMAC timing-safe"
```

---

### Task 3: `lib/bot-contract.ts` — tipi e validazione

**Files:**
- Create: `lib/bot-contract.ts`
- Test: `lib/bot-contract.test.ts`

**Interfaces:**
- Produces:
  - tipi `BotIntakePayload`, `BotOutcome`, `BotReport`, `BotOutcomeBody`
  - `isoWithOffset(date: string): boolean`
  - `parseIntakePayload(raw: unknown): { ok: true; value: BotIntakePayload } | { ok: false; reason: string }`
  - `validateOutcomeBody(b: BotOutcomeBody): { ok: true } | { ok: false; reason: string }`

- [ ] **Step 1: Scrivere il test che fallisce**

```ts
import { describe, it, expect } from 'vitest';
import { isoWithOffset, parseIntakePayload, validateOutcomeBody } from './bot-contract';

describe('isoWithOffset', () => {
  it('accetta offset esplicito', () => {
    expect(isoWithOffset('2026-06-20T15:00:00+02:00')).toBe(true);
    expect(isoWithOffset('2026-06-20T13:00:00Z')).toBe(true);
  });
  it('rifiuta senza fuso', () => {
    expect(isoWithOffset('2026-06-20T15:00:00')).toBe(false);
  });
  it('rifiuta spazzatura', () => {
    expect(isoWithOffset('domani alle 15')).toBe(false);
  });
});

describe('parseIntakePayload', () => {
  const base = { leadId: 'u1', name: 'Mario', phone: '333 123 4567', email: null, funnel: 'badanti', companyId: 'fenice' };
  it('accetta payload valido', () => {
    const r = parseIntakePayload(base);
    expect(r.ok).toBe(true);
  });
  it('rifiuta companyId errato', () => {
    const r = parseIntakePayload({ ...base, companyId: 'altro' });
    expect(r).toEqual({ ok: false, reason: 'forbidden' });
  });
  it('rifiuta leadId mancante', () => {
    const r = parseIntakePayload({ ...base, leadId: '' });
    expect(r).toEqual({ ok: false, reason: 'bad_request' });
  });
  it('rifiuta phone mancante', () => {
    const r = parseIntakePayload({ ...base, phone: '' });
    expect(r).toEqual({ ok: false, reason: 'bad_request' });
  });
});

describe('validateOutcomeBody', () => {
  it('APPUNTAMENTO richiede date con offset', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO' })).toEqual({ ok: false, reason: 'bad_request' });
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO', date: '2026-06-20T15:00:00' })).toEqual({ ok: false, reason: 'bad_request' });
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'APPUNTAMENTO', date: '2026-06-20T15:00:00+02:00' })).toEqual({ ok: true });
  });
  it('DA_SCARTARE non richiede date', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'DA_SCARTARE' })).toEqual({ ok: true });
  });
  it('outcome non valido → bad_request', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'BOH' as never })).toEqual({ ok: false, reason: 'bad_request' });
  });
});
```

- [ ] **Step 2: Eseguire il test (deve fallire)**

Run: `npx vitest run lib/bot-contract.test.ts`
Expected: FAIL ("Cannot find module './bot-contract'").

- [ ] **Step 3: Implementare `lib/bot-contract.ts`**

```ts
export interface BotIntakePayload {
  leadId: string;
  name: string | null;
  phone: string;
  email: string | null;
  funnel: string | null;
  companyId: string;
}

export type BotOutcome = 'APPUNTAMENTO' | 'DA_SCARTARE' | 'RICHIAMO' | 'NON_RISPOSTO';

export interface BotReport {
  summary?: string;
  painPoints?: string[];
  budgetSignal?: string;
  urgency?: string;
  objections?: string[];
  levaConsigliata?: string;
}

export interface BotOutcomeBody {
  leadId: string;
  outcome: BotOutcome;
  date?: string;
  note?: string;
  discardReason?: string;
  report?: BotReport;
}

const OUTCOMES: BotOutcome[] = ['APPUNTAMENTO', 'DA_SCARTARE', 'RICHIAMO', 'NON_RISPOSTO'];
const DATE_REQUIRED: BotOutcome[] = ['APPUNTAMENTO', 'RICHIAMO'];

/** True solo se ISO 8601 con offset di fuso (`Z` oppure `±HH:MM`). */
export function isoWithOffset(date: string): boolean {
  if (typeof date !== 'string') return false;
  // Deve avere data+ora e terminare con Z oppure ±HH:MM
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(date)) return false;
  return !Number.isNaN(Date.parse(date));
}

export function parseIntakePayload(
  raw: unknown,
): { ok: true; value: BotIntakePayload } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'bad_request' };
  const o = raw as Record<string, unknown>;
  const leadId = typeof o.leadId === 'string' ? o.leadId.trim() : '';
  const phone = typeof o.phone === 'string' ? o.phone.trim() : '';
  const companyId = typeof o.companyId === 'string' ? o.companyId : '';
  if (companyId !== 'fenice') return { ok: false, reason: 'forbidden' };
  if (!leadId || !phone) return { ok: false, reason: 'bad_request' };
  return {
    ok: true,
    value: {
      leadId,
      phone,
      companyId,
      name: typeof o.name === 'string' ? o.name : null,
      email: typeof o.email === 'string' ? o.email : null,
      funnel: typeof o.funnel === 'string' ? o.funnel : null,
    },
  };
}

export function validateOutcomeBody(
  b: BotOutcomeBody,
): { ok: true } | { ok: false; reason: string } {
  if (!b || typeof b.leadId !== 'string' || !b.leadId.trim()) return { ok: false, reason: 'bad_request' };
  if (!OUTCOMES.includes(b.outcome)) return { ok: false, reason: 'bad_request' };
  if (DATE_REQUIRED.includes(b.outcome)) {
    if (!b.date || !isoWithOffset(b.date)) return { ok: false, reason: 'bad_request' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Eseguire il test (deve passare)**

Run: `npx vitest run lib/bot-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bot-contract.ts lib/bot-contract.test.ts
git commit -m "feat(bot): tipi contratto + validazione ISO/payload"
```

---

### Task 4: `lib/fenice-enroll.ts` — refactor arruolamento condiviso

**Files:**
- Create: `lib/fenice-enroll.ts`
- Modify: `app/api/fenice/enroll/route.ts` (riscrittura per usare l'helper)

**Interfaces:**
- Consumes: `findOrCreateLeadConversation`, `sendTemplateAndLog` (da `lib/messaging`), `feniceOpening` (da `lib/fenice-opening`).
- Produces: `enrollLeadIntoMario(supabase, args): Promise<{ ok: boolean; conversationId: number; sid?: string; error?: string }>` con `args: { phone: string; firstName?: string | null; lastName?: string | null; email?: string | null; crmLeadId?: string | null; crmFunnel?: string | null }`. `phone` deve essere già E.164.

- [ ] **Step 1: Implementare `lib/fenice-enroll.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import { findOrCreateLeadConversation, sendTemplateAndLog } from './messaging';
import { feniceOpening } from './fenice-opening';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type EnrollArgs = {
  phone: string; // già E.164
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  crmLeadId?: string | null;
  crmFunnel?: string | null;
};

/**
 * Arruola un lead nel flusso di Mario: crea/aggiorna lead+conversazione, invia il
 * template di apertura, e marca la conversazione come gestita da Mario (active).
 * Se `crmLeadId` è presente, tagga la conversazione per il callback al CRM.
 */
export async function enrollLeadIntoMario(
  supabase: Supa,
  args: EnrollArgs,
): Promise<{ ok: boolean; conversationId: number; sid?: string; error?: string }> {
  const templateSid = process.env.FENICE_OPENING_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    throw new Error('FENICE_OPENING_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati');
  }

  const firstName = args.firstName ?? undefined;
  const { conversationId } = await findOrCreateLeadConversation(supabase, {
    phone: args.phone,
    firstName,
    lastName: args.lastName ?? undefined,
    email: args.email ?? undefined,
  });

  const variables: Record<string, string> = firstName ? { '3': firstName } : {};
  const res = await sendTemplateAndLog(
    supabase, conversationId, args.phone, templateSid, 'Fenice apertura', from, variables, feniceOpening(firstName),
  );

  await supabase.from('conversations')
    .update({
      ai_owner: 'mario',
      ai_status: 'active',
      ai_started_at: new Date().toISOString(),
      crm_lead_id: args.crmLeadId ?? null,
      crm_funnel: args.crmFunnel ?? null,
    })
    .eq('id', conversationId);

  await supabase.from('event_log').insert({
    type: res.ok ? 'fenice_enroll' : 'send_error',
    payload: { phone: args.phone, conversationId, sid: res.sid, error: res.error, crmLeadId: args.crmLeadId ?? null } as never,
    message: res.ok ? `Lead arruolato (Mario): ${args.phone}` : `Arruolamento fallito ${args.phone}: ${res.error}`,
    level: res.ok ? 'info' : 'error',
  });

  return { ok: res.ok, conversationId, sid: res.sid, error: res.error };
}
```

> **Nota:** verificare la firma reale di `findOrCreateLeadConversation` in `lib/messaging.ts`. Se non accetta `lastName`/`email`, passare solo i campi supportati (mantenere `phone` + `firstName`) e ignorare gli altri.

- [ ] **Step 2: Riscrivere `app/api/fenice/enroll/route.ts` per usare l'helper**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';
import { enrollLeadIntoMario } from '@/lib/fenice-enroll';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const phone = toE164((body.phone ?? null) as string | null);
  if (!phone) return NextResponse.json({ ok: false, error: 'telefono non valido' }, { status: 400 });

  const firstName = (body.firstName ?? body.first_name) as string | undefined;

  try {
    const res = await enrollLeadIntoMario(getSupabaseAdmin(), { phone, firstName });
    return NextResponse.json({ ok: res.ok, conversationId: res.conversationId, sid: res.sid, error: res.error });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'errore' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Typecheck + test esistenti**

Run: `npm run typecheck && npx vitest run`
Expected: nessun errore TS; 65 test ancora verdi.

- [ ] **Step 4: Commit**

```bash
git add lib/fenice-enroll.ts app/api/fenice/enroll/route.ts
git commit -m "refactor(fenice): arruolamento condiviso enrollLeadIntoMario"
```

---

### Task 5: Direzione 1 — `app/api/bot/intake/route.ts`

**Files:**
- Create: `app/api/bot/intake/route.ts`

**Interfaces:**
- Consumes: `verifySignature` (Task 2), `parseIntakePayload` (Task 3), `enrollLeadIntoMario` (Task 4), `toE164`, `checkRateLimit`.

- [ ] **Step 1: Implementare la route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseIntakePayload } from '@/lib/bot-contract';
import { enrollLeadIntoMario } from '@/lib/fenice-enroll';
import { toE164 } from '@/lib/phone';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`botintake:${ip}`, 60, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let json: unknown;
  try { json = JSON.parse(rawBody); } catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const parsed = parseIntakePayload(json);
  if (!parsed.ok) {
    const status = parsed.reason === 'forbidden' ? 403 : 400;
    return NextResponse.json({ ok: false, error: parsed.reason }, { status });
  }
  const p = parsed.value;

  const supabase = getSupabaseAdmin();
  const phone = toE164(p.phone);
  if (!phone) {
    await supabase.from('event_log').insert({
      type: 'bot_intake_skipped',
      payload: { crmLeadId: p.leadId, phone: p.phone } as never,
      message: `[bot-fissatore] phone non normalizzabile per lead ${p.leadId}: ${p.phone}`,
      level: 'warn',
    });
    return NextResponse.json({ ok: true, skipped: 'invalid_phone' });
  }

  try {
    const res = await enrollLeadIntoMario(supabase, {
      phone,
      firstName: p.name,
      email: p.email,
      crmLeadId: p.leadId,
      crmFunnel: p.funnel,
    });
    await supabase.from('event_log').insert({
      type: 'bot_intake',
      payload: { crmLeadId: p.leadId, conversationId: res.conversationId, ok: res.ok } as never,
      message: `[bot-fissatore] intake lead ${p.leadId} → conv ${res.conversationId}`,
      level: 'info',
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'bot_intake_error',
      payload: { crmLeadId: p.leadId, error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] intake fallito lead ${p.leadId}`,
      level: 'error',
    });
    // Best-effort: il CRM non ritenta. Rispondiamo 200 per non far figurare l'endpoint down.
    return NextResponse.json({ ok: true, error: 'enroll_failed' });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 3: Smoke test locale della firma (manuale, opzionale)**

Avviare `npm run dev`, poi con `BOT_WEBHOOK_SECRET` impostato calcolare la firma di un body di test e fare POST a `http://localhost:3000/api/bot/intake`. Expected: `200 {ok:true}` con firma valida; `401 invalid_signature` con firma errata.

- [ ] **Step 4: Commit**

```bash
git add app/api/bot/intake/route.ts
git commit -m "feat(bot): webhook intake Direzione 1 (HMAC + arruolamento)"
```

---

### Task 6: Mario — cattura esito + data ISO assoluta

**Files:**
- Modify: `lib/mario.ts` (tipo `MarioResult`, `parseMarioReply`, `generateMarioReply`)
- Create: `lib/rome-time.ts` (helper offset Europe/Rome)
- Modify: `lib/mario-prompt.ts` (istruzioni di chiusura con tag `[ESITO:...]`)
- Test: `lib/mario.test.ts` (estensione o nuovo file `lib/mario-parse.test.ts`)
- Create: `lib/rome-time.test.ts`

**Interfaces:**
- Produces:
  - `MarioResult` esteso: `{ visibleReply: string; appointmentFixed: boolean; passToHuman: boolean; outcome?: 'APPUNTAMENTO' | 'RICHIAMO' | 'DA_SCARTARE'; scheduledAt?: string; discardReason?: string }`
  - `romeOffset(date: Date): string` (es. `'+02:00'`)
  - `romeNowContext(date: Date): string` (riga da iniettare nel prompt)
  - `generateMarioReply(history, opts?: { now?: Date }): Promise<MarioResult>`

- [ ] **Step 1: Scrivere `lib/rome-time.test.ts` (test che fallisce)**

```ts
import { describe, it, expect } from 'vitest';
import { romeOffset } from './rome-time';

describe('romeOffset', () => {
  it('estate (DST) → +02:00', () => {
    expect(romeOffset(new Date('2026-06-20T12:00:00Z'))).toBe('+02:00');
  });
  it('inverno → +01:00', () => {
    expect(romeOffset(new Date('2026-01-20T12:00:00Z'))).toBe('+01:00');
  });
});
```

- [ ] **Step 2: Eseguire (fallisce)**

Run: `npx vitest run lib/rome-time.test.ts`
Expected: FAIL ("Cannot find module './rome-time'").

- [ ] **Step 3: Implementare `lib/rome-time.ts`**

```ts
/** Offset corrente di Europe/Rome per `date`, es. "+02:00" (DST) o "+01:00". */
export function romeOffset(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const off = raw.replace('GMT', '').trim();
  return off === '' ? '+00:00' : off;
}

/** Riga di contesto da iniettare nel prompt così Mario risolve date relative. */
export function romeNowContext(date: Date): string {
  const f = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
  return `Adesso in Italia è ${f} (fuso ${romeOffset(date)}). Usa questo per calcolare date assolute.`;
}
```

- [ ] **Step 4: Eseguire (passa)**

Run: `npx vitest run lib/rome-time.test.ts`
Expected: PASS.

- [ ] **Step 5: Scrivere il test del parser esteso `lib/mario-parse.test.ts` (fallisce)**

```ts
import { describe, it, expect } from 'vitest';
import { parseMarioReply } from './mario';

describe('parseMarioReply — esiti CRM', () => {
  it('APPUNTAMENTO con data → outcome+scheduledAt, testo pulito, flag legacy', () => {
    const r = parseMarioReply('Perfetto ci vediamo [ESITO:APPUNTAMENTO|2026-06-20T15:00:00+02:00]');
    expect(r.outcome).toBe('APPUNTAMENTO');
    expect(r.scheduledAt).toBe('2026-06-20T15:00:00+02:00');
    expect(r.appointmentFixed).toBe(true);
    expect(r.visibleReply).toBe('Perfetto ci vediamo');
  });
  it('RICHIAMO con data', () => {
    const r = parseMarioReply('Ti richiamo io [ESITO:RICHIAMO|2026-06-21T10:00:00+02:00]');
    expect(r.outcome).toBe('RICHIAMO');
    expect(r.scheduledAt).toBe('2026-06-21T10:00:00+02:00');
    expect(r.visibleReply).toBe('Ti richiamo io');
  });
  it('SCARTO con motivo', () => {
    const r = parseMarioReply('Va bene, buona giornata [ESITO:SCARTO|gia ha un consulente]');
    expect(r.outcome).toBe('DA_SCARTARE');
    expect(r.discardReason).toBe('gia ha un consulente');
    expect(r.visibleReply).toBe('Va bene, buona giornata');
  });
  it('legacy [APPUNTAMENTO_FISSATO] resta valido', () => {
    const r = parseMarioReply('ok [APPUNTAMENTO_FISSATO]');
    expect(r.appointmentFixed).toBe(true);
    expect(r.visibleReply).toBe('ok');
  });
  it('nessun tag → outcome undefined', () => {
    const r = parseMarioReply('ciao come va');
    expect(r.outcome).toBeUndefined();
    expect(r.appointmentFixed).toBe(false);
  });
});
```

- [ ] **Step 6: Eseguire (fallisce)**

Run: `npx vitest run lib/mario-parse.test.ts`
Expected: FAIL (outcome undefined / proprietà mancanti).

- [ ] **Step 7: Estendere `lib/mario.ts`**

Sostituire il tipo `MarioResult` e `parseMarioReply`, e aggiungere l'iniezione data in `generateMarioReply`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { MARIO_SYSTEM_PROMPT } from './mario-prompt';
import { romeNowContext } from './rome-time';

export const MARIO_MODEL = 'claude-sonnet-4-6';

export type MarioTurn = { role: 'user' | 'assistant'; content: string };
export type MarioOutcome = 'APPUNTAMENTO' | 'RICHIAMO' | 'DA_SCARTARE';
export type MarioResult = {
  visibleReply: string;
  appointmentFixed: boolean;
  passToHuman: boolean;
  outcome?: MarioOutcome;
  scheduledAt?: string;
  discardReason?: string;
};

const ESITO_RE = /\[ESITO:(APPUNTAMENTO|RICHIAMO|SCARTO)\|([^\]]*)\]/i;

/** Rileva tag speciali, li rimuove dal testo visibile e ritorna flag + esito strutturato. */
export function parseMarioReply(raw: string): MarioResult {
  const legacyAppointment = raw.includes('[APPUNTAMENTO_FISSATO]');
  const passToHuman = raw.includes('[PASSAGGIO_UMANO]');

  let outcome: MarioOutcome | undefined;
  let scheduledAt: string | undefined;
  let discardReason: string | undefined;

  const m = raw.match(ESITO_RE);
  if (m) {
    const kind = m[1].toUpperCase();
    const arg = (m[2] ?? '').trim();
    if (kind === 'APPUNTAMENTO') { outcome = 'APPUNTAMENTO'; scheduledAt = arg || undefined; }
    else if (kind === 'RICHIAMO') { outcome = 'RICHIAMO'; scheduledAt = arg || undefined; }
    else if (kind === 'SCARTO') { outcome = 'DA_SCARTARE'; discardReason = arg || undefined; }
  }

  const visibleReply = raw
    .replace(ESITO_RE, '')
    .replace(/\[APPUNTAMENTO_FISSATO\]/g, '')
    .replace(/\[PASSAGGIO_UMANO\]/g, '')
    .trim();

  return {
    visibleReply,
    appointmentFixed: legacyAppointment || outcome === 'APPUNTAMENTO',
    passToHuman,
    outcome,
    scheduledAt,
    discardReason,
  };
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Genera la prossima risposta di Mario data la cronologia. Inietta l'ora di Roma. */
export async function generateMarioReply(
  history: MarioTurn[],
  opts?: { now?: Date },
): Promise<MarioResult> {
  const messages =
    history.length > 0
      ? history
      : [{ role: 'user' as const, content: 'Inizia la conversazione presentandoti.' }];

  const now = opts?.now ?? new Date();
  const system = `${MARIO_SYSTEM_PROMPT}\n\n${romeNowContext(now)}`;

  const response = await getClient().messages.create({
    model: MARIO_MODEL,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system,
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
  return parseMarioReply(raw);
}
```

- [ ] **Step 8: Aggiornare `lib/mario-prompt.ts` con le istruzioni di chiusura**

Aggiungere in coda a `MARIO_SYSTEM_PROMPT` (prima dell'eventuale chiusura della stringa) un blocco:

```
QUANDO LA CONVERSAZIONE ARRIVA A UN ESITO, chiudi il messaggio con UNO di questi tag tecnici (l'utente non li vede):
- Appuntamento concordato: [ESITO:APPUNTAMENTO|<data ISO 8601 con fuso, es. 2026-06-20T15:00:00+02:00>]
- Vuole essere richiamato in un momento preciso: [ESITO:RICHIAMO|<data ISO 8601 con fuso>]
- Fuori target o non interessato: [ESITO:SCARTO|<motivo breve>]
Regole sui tag: usa SEMPRE la data assoluta con fuso orario (mai "domani"); calcola la data dall'ora attuale che ti viene fornita; un solo tag per messaggio; il tag va alla fine, dopo il testo normale.
```

> Mantenere intatte le regole di stile esistenti (no markdown, ≤25 parole, niente trattini, ecc.). Il tag è testo tecnico finale, non conta nello stile del messaggio visibile.

- [ ] **Step 9: Eseguire i test del parser + tutti i test**

Run: `npx vitest run lib/mario-parse.test.ts lib/rome-time.test.ts && npx vitest run`
Expected: nuovi test PASS; suite completa verde.

- [ ] **Step 10: Commit**

```bash
git add lib/mario.ts lib/mario-prompt.ts lib/rome-time.ts lib/rome-time.test.ts lib/mario-parse.test.ts
git commit -m "feat(bot): Mario emette esito + data ISO assoluta (Europe/Rome)"
```

---

### Task 7: `lib/bot-report.ts` — report strutturato via AI

**Files:**
- Create: `lib/bot-report.ts`
- Test: `lib/bot-report.test.ts` (solo il parser puro `parseReportJson`)

**Interfaces:**
- Consumes: `BotReport` (Task 3), `MarioTurn` (Task 6), Anthropic SDK.
- Produces:
  - `parseReportJson(text: string): BotReport` (puro, testabile)
  - `generateBotReport(history: MarioTurn[]): Promise<BotReport>`

- [ ] **Step 1: Scrivere `lib/bot-report.test.ts` (fallisce)**

```ts
import { describe, it, expect } from 'vitest';
import { parseReportJson } from './bot-report';

describe('parseReportJson', () => {
  it('estrae JSON anche con testo attorno', () => {
    const r = parseReportJson('Ecco: {"summary":"interessato","painPoints":["solitudine"],"urgency":"alta"} fine');
    expect(r.summary).toBe('interessato');
    expect(r.painPoints).toEqual(['solitudine']);
    expect(r.urgency).toBe('alta');
  });
  it('JSON non valido → oggetto vuoto', () => {
    expect(parseReportJson('niente json')).toEqual({});
  });
  it('campi non-array vengono scartati per painPoints/objections', () => {
    const r = parseReportJson('{"painPoints":"x","objections":["y"]}');
    expect(r.painPoints).toBeUndefined();
    expect(r.objections).toEqual(['y']);
  });
});
```

- [ ] **Step 2: Eseguire (fallisce)**

Run: `npx vitest run lib/bot-report.test.ts`
Expected: FAIL ("Cannot find module './bot-report'").

- [ ] **Step 3: Implementare `lib/bot-report.ts`**

```ts
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
```

- [ ] **Step 4: Eseguire (passa)**

Run: `npx vitest run lib/bot-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bot-report.ts lib/bot-report.test.ts
git commit -m "feat(bot): report strutturato via AI (parser puro testato)"
```

---

### Task 8: `lib/bot-outcome.ts` — callback + innesco in drain + riapertura

**Files:**
- Create: `lib/bot-outcome.ts`
- Modify: `lib/fenice-autoreply.ts` (`drainMarioReplies`: carica `crm_lead_id`, invia esito)
- Modify: `app/api/webhooks/twilio/route.ts` (riapertura `closed→active` per lead CRM)

**Interfaces:**
- Consumes: `signPayload` (Task 2), `BotOutcome`/`BotReport`/`BotOutcomeBody`/`validateOutcomeBody` (Task 3), `generateBotReport` (Task 7).
- Produces: `sendOutcome(supabase, conversationId, args): Promise<{ sent: boolean; status?: number; error?: string }>` con `args: { outcome: BotOutcome; date?: string; note?: string; discardReason?: string; report?: BotReport }`.

- [ ] **Step 1: Implementare `lib/bot-outcome.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import { signPayload } from './bot-hmac';
import { validateOutcomeBody, type BotOutcome, type BotOutcomeBody, type BotReport } from './bot-contract';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const DEFAULT_CRM_URL = 'https://crm-sales-fenice.vercel.app/api/bot/outcome';

export type SendOutcomeArgs = {
  outcome: BotOutcome;
  date?: string;
  note?: string;
  discardReason?: string;
  report?: BotReport;
};

/**
 * Invia l'esito al CRM per una conversazione CRM-linked. No-op per lead non-CRM.
 * Su 2xx persiste bot_outcome/at/scheduled/report e chiude la conversazione.
 */
export async function sendOutcome(
  supabase: Supa,
  conversationId: number,
  args: SendOutcomeArgs,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { sent: false, error: 'not_configured' };

  const { data: conv } = await supabase
    .from('conversations')
    .select('crm_lead_id')
    .eq('id', conversationId)
    .maybeSingle();
  const crmLeadId = (conv as { crm_lead_id: string | null } | null)?.crm_lead_id ?? null;
  if (!crmLeadId) return { sent: false, error: 'not_crm_lead' };

  const body: BotOutcomeBody = {
    leadId: crmLeadId,
    outcome: args.outcome,
    ...(args.date ? { date: args.date } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(args.discardReason ? { discardReason: args.discardReason } : {}),
    ...(args.report ? { report: args.report } : {}),
  };

  const valid = validateOutcomeBody(body);
  if (!valid.ok) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, reason: valid.reason } as never,
      message: `[bot-fissatore] outcome non valido per lead ${crmLeadId}: ${valid.reason}`,
      level: 'error',
    });
    return { sent: false, error: valid.reason };
  }

  const rawBody = JSON.stringify(body);
  const url = process.env.CRM_OUTCOME_URL ?? DEFAULT_CRM_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
    });
    if (res.ok) {
      await supabase.from('conversations').update({
        bot_outcome: args.outcome,
        bot_outcome_at: new Date().toISOString(),
        bot_scheduled_at: args.date ?? null,
        bot_report: (args.report ?? null) as never,
        ai_status: 'closed',
      }).eq('id', conversationId);
      await supabase.from('event_log').insert({
        type: 'bot_outcome_sent',
        payload: { conversationId, crmLeadId, outcome: args.outcome } as never,
        message: `[bot-fissatore] esito ${args.outcome} inviato per lead ${crmLeadId}`,
        level: 'info',
      });
      return { sent: true, status: res.status };
    }
    const text = await res.text().catch(() => '');
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, status: res.status, body: text } as never,
      message: `[bot-fissatore] callback CRM ha risposto ${res.status} per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, status: res.status, error: text || `http_${res.status}` };
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] callback CRM fallito (rete) per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, error: e instanceof Error ? e.message : 'errore' };
  }
}
```

- [ ] **Step 2: Innescare l'esito in `lib/fenice-autoreply.ts`**

In `drainMarioReplies`: (a) aggiungere `crm_lead_id` al `select` del lock CAS; (b) dopo l'invio delle parti, se `result.outcome` e c'è `crmLeadId`, generare report e inviare esito. Modifiche puntuali:

Nel claim (sostituire il `.select('id, ai_started_at')`):
```ts
    .select('id, ai_started_at, crm_lead_id')
    .single();
  if (!claimed) return;
  const startedAt = (claimed as { ai_started_at: string | null }).ai_started_at;
  const crmLeadId = (claimed as { crm_lead_id: string | null }).crm_lead_id;
```

Aggiungere gli import in testa al file:
```ts
import { generateBotReport } from './bot-report';
import { sendOutcome } from './bot-outcome';
import type { BotOutcome } from './bot-contract';
```

Dopo il blocco che invia le parti e logga `fenice_ai_reply`, prima dei controlli `passToHuman`/`appointmentFixed`, inserire la gestione esito CRM:
```ts
      if (crmLeadId && result.outcome) {
        const report = await generateBotReport(history);
        const map: Record<string, BotOutcome> = {
          APPUNTAMENTO: 'APPUNTAMENTO', RICHIAMO: 'RICHIAMO', DA_SCARTARE: 'DA_SCARTARE',
        };
        await sendOutcome(supabase, conversationId, {
          outcome: map[result.outcome],
          date: result.scheduledAt,
          discardReason: result.discardReason,
          report,
        });
        finalStatus = 'closed';
        break;
      }
```

> `history` è già la lista `MarioTurn[]` costruita nel round corrente. Il `finally` esistente scriverà `ai_status='closed'` (coerente con `sendOutcome`). I rami legacy `passToHuman`/`appointmentFixed` restano invariati sotto, per i lead non-CRM.

- [ ] **Step 3: Riapertura in `app/api/webhooks/twilio/route.ts`**

Dove la route carica la conversazione per l'auto-reply (il `select('ai_owner, ai_status')`), aggiungere `crm_lead_id` e, prima di `shouldAutoReply`, riaprire i lead CRM chiusi:
```ts
      const { data: conv } = await supabase
        .from('conversations')
        .select('ai_owner, ai_status, crm_lead_id')
        .eq('id', conversationId)
        .single();

      if (conv?.crm_lead_id && conv.ai_status === 'closed') {
        await supabase.from('conversations').update({ ai_status: 'active' }).eq('id', conversationId);
        conv.ai_status = 'active';
      }
```
(Il resto del blocco `getAutoReply` + `shouldAutoReply` resta invariato.)

- [ ] **Step 4: Typecheck + suite completa**

Run: `npm run typecheck && npx vitest run`
Expected: nessun errore TS; tutti i test verdi.

- [ ] **Step 5: Commit**

```bash
git add lib/bot-outcome.ts lib/fenice-autoreply.ts app/api/webhooks/twilio/route.ts
git commit -m "feat(bot): callback esito Direzione 2 + innesco in drain + riapertura"
```

---

### Task 9: Solleciti + NON_RISPOSTO — cron

**Files:**
- Create: `lib/bot-followups.ts` (funzione pura `decideFollowupAction` + testi solleciti)
- Test: `lib/bot-followups.test.ts`
- Create: `app/api/cron/bot-followups/route.ts`
- Modify: `vercel.json` (aggiungere il cron)

**Interfaces:**
- Consumes: `sendOutcome` (Task 8), `sendFreeText` (da `lib/twilio`).
- Produces:
  - `decideFollowupAction(input: { startedAtMs: number; nowMs: number; followupsSent: number; hasInbound: boolean }): 'sollecito_1' | 'sollecito_2' | 'non_risposto' | 'none'`
  - `FOLLOWUP_TEXTS: [string, string]`

- [ ] **Step 1: Scrivere `lib/bot-followups.test.ts` (fallisce)**

```ts
import { describe, it, expect } from 'vitest';
import { decideFollowupAction } from './bot-followups';

const H = 3600_000;
const start = 0;

describe('decideFollowupAction', () => {
  it('lead che ha risposto → none', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 50 * H, followupsSent: 0, hasInbound: true })).toBe('none');
  });
  it('prima di 18h → none', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 10 * H, followupsSent: 0, hasInbound: false })).toBe('none');
  });
  it('>=18h e nessun sollecito → sollecito_1', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 20 * H, followupsSent: 0, hasInbound: false })).toBe('sollecito_1');
  });
  it('>=36h e 1 sollecito → sollecito_2', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 37 * H, followupsSent: 1, hasInbound: false })).toBe('sollecito_2');
  });
  it('>=48h e 2 solleciti → non_risposto', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 49 * H, followupsSent: 2, hasInbound: false })).toBe('non_risposto');
  });
  it('48h ma solo 1 sollecito → sollecito_2 (recupero)', () => {
    expect(decideFollowupAction({ startedAtMs: start, nowMs: 49 * H, followupsSent: 1, hasInbound: false })).toBe('sollecito_2');
  });
});
```

- [ ] **Step 2: Eseguire (fallisce)**

Run: `npx vitest run lib/bot-followups.test.ts`
Expected: FAIL ("Cannot find module './bot-followups'").

- [ ] **Step 3: Implementare `lib/bot-followups.ts`**

```ts
const H = 3600_000;
export const FOLLOWUP_1_H = 18;
export const FOLLOWUP_2_H = 36;
export const GIVEUP_H = 48;

export const FOLLOWUP_TEXTS: [string, string] = [
  'Ciao, sono ancora Mario di Fenice, sei riuscito a leggere il mio messaggio?',
  'Ti scrivo un ultima volta, se ti va ne parliamo due minuti quando hai tempo',
];

export type FollowupAction = 'sollecito_1' | 'sollecito_2' | 'non_risposto' | 'none';

/** Decide l'azione per un lead CRM che non ha ancora risposto. Puro. */
export function decideFollowupAction(input: {
  startedAtMs: number;
  nowMs: number;
  followupsSent: number;
  hasInbound: boolean;
}): FollowupAction {
  if (input.hasInbound) return 'none';
  const elapsedH = (input.nowMs - input.startedAtMs) / H;
  if (input.followupsSent < 1 && elapsedH >= FOLLOWUP_1_H) return 'sollecito_1';
  if (input.followupsSent < 2 && elapsedH >= FOLLOWUP_2_H) return 'sollecito_2';
  if (input.followupsSent >= 2 && elapsedH >= GIVEUP_H) return 'non_risposto';
  return 'none';
}
```

- [ ] **Step 4: Eseguire (passa)**

Run: `npx vitest run lib/bot-followups.test.ts`
Expected: PASS (6 test).

- [ ] **Step 5: Implementare `app/api/cron/bot-followups/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendFreeText } from '@/lib/twilio';
import { sendOutcome } from '@/lib/bot-outcome';
import { decideFollowupAction, FOLLOWUP_TEXTS } from '@/lib/bot-followups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const now = Date.now();

  // Conversazioni CRM-linked, attive, non chiuse.
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, ai_status, ai_started_at, last_inbound_at, bot_followups_sent, crm_lead_id, leads(phone_e164)')
    .not('crm_lead_id', 'is', null)
    .in('ai_status', ['active', 'replying'])
    .limit(500);

  const report: Record<string, unknown>[] = [];

  for (const c of (convs ?? []) as any[]) {
    const startedAt = c.ai_started_at ? Date.parse(c.ai_started_at) : null;
    if (!startedAt) continue;
    const hasInbound = !!c.last_inbound_at && Date.parse(c.last_inbound_at) >= startedAt;
    const action = decideFollowupAction({
      startedAtMs: startedAt, nowMs: now, followupsSent: c.bot_followups_sent ?? 0, hasInbound,
    });
    if (action === 'none') continue;

    const phone = c.leads?.phone_e164 as string | undefined;

    if (action === 'non_risposto') {
      await sendOutcome(supabase, c.id, { outcome: 'NON_RISPOSTO', note: 'Nessuna risposta dopo i solleciti.' });
      report.push({ id: c.id, action });
      continue;
    }

    // sollecito_1 | sollecito_2: invia il nudge e incrementa il contatore.
    const idx = action === 'sollecito_1' ? 0 : 1;
    if (phone && from) {
      try {
        const sent = await sendFreeText({ to: phone, body: FOLLOWUP_TEXTS[idx], from });
        await supabase.from('messages').insert({
          conversation_id: c.id, direction: 'out', body: FOLLOWUP_TEXTS[idx],
          twilio_sid: sent.sid, twilio_status: sent.status,
        });
        await supabase.from('conversations')
          .update({ bot_followups_sent: idx + 1, last_message_at: new Date().toISOString() })
          .eq('id', c.id);
        report.push({ id: c.id, action, sent: true });
      } catch (e) {
        await supabase.from('event_log').insert({
          type: 'bot_followup_error',
          payload: { conversationId: c.id, error: e instanceof Error ? e.message : 'errore' } as never,
          message: `[bot-fissatore] sollecito fallito conv ${c.id}`,
          level: 'error',
        });
        report.push({ id: c.id, action, sent: false });
      }
    } else {
      // Numero non configurato: avanza comunque il contatore per non bloccare la pipeline.
      await supabase.from('conversations').update({ bot_followups_sent: idx + 1 }).eq('id', c.id);
      report.push({ id: c.id, action, sent: false, reason: 'no_from' });
    }
  }

  await supabase.from('event_log').insert({
    type: 'bot_followups_run',
    payload: { count: report.length } as never,
    message: `[bot-fissatore] cron solleciti: ${report.length} azioni`,
    level: 'info',
  });

  return NextResponse.json({ ok: true, actions: report });
}
```

- [ ] **Step 6: Aggiungere il cron in `vercel.json`**

Nell'array `crons` aggiungere:
```json
    {
      "path": "/api/cron/bot-followups",
      "schedule": "0 * * * *"
    }
```

- [ ] **Step 7: Typecheck + suite completa**

Run: `npm run typecheck && npx vitest run`
Expected: nessun errore TS; tutti i test verdi.

- [ ] **Step 8: Commit**

```bash
git add lib/bot-followups.ts lib/bot-followups.test.ts app/api/cron/bot-followups/route.ts vercel.json
git commit -m "feat(bot): cron solleciti + NON_RISPOSTO"
```

---

### Task 10: Build di verifica finale

**Files:** nessuno (verifica).

- [ ] **Step 1: Build di produzione**

Run: `npm run build`
Expected: build OK; nella lista route compaiono `/api/bot/intake` e `/api/cron/bot-followups`.

- [ ] **Step 2: Suite completa**

Run: `npx vitest run`
Expected: tutti i test verdi (65 esistenti + nuovi).

- [ ] **Step 3: Commit eventuale (se build ha prodotto cambi)**

```bash
git add -A
git commit -m "chore(bot): verifica build integrazione CRM" || echo "niente da committare"
```

---

## Self-Review

**Spec coverage:**
- §2 Mapping esiti → Task 6 (tag Mario), Task 8 (invio), Task 9 (NON_RISPOSTO). PASSAGGIO_UMANO per CRM: non emesso (prompt Task 6); se compare, nessun esito inviato (drain ignora outcome assente). ✓
- §3 Env → Task 5 (`BOT_WEBHOOK_SECRET`), Task 8 (`CRM_OUTCOME_URL`). ✓
- §4 Modello dati → Task 1. ✓
- §5.1 HMAC → Task 2. ✓
- §5.2 Contratto → Task 3. ✓
- §5.3 Refactor enroll → Task 4. ✓
- §5.4 Intake → Task 5. ✓
- §5.5 Mario esito+data → Task 6. ✓
- §5.6 Outcome+riapertura → Task 8. ✓
- §5.7 Report → Task 7. ✓
- §5.8 Cron solleciti → Task 9. ✓
- §6 Sicurezza → Task 2 (timing-safe), Task 5 (rate-limit, raw body). ✓
- §7 Testing → ogni Task ha test sulle parti pure. ✓

**Placeholder scan:** nessun TBD/TODO; tutti gli step hanno codice o comando concreto. ✓

**Type consistency:** `MarioResult.outcome` (`'APPUNTAMENTO'|'RICHIAMO'|'DA_SCARTARE'`) mappato a `BotOutcome` in Task 8; `sendOutcome`/`decideFollowupAction`/`signPayload`/`verifySignature`/`parseIntakePayload`/`validateOutcomeBody`/`generateBotReport`/`enrollLeadIntoMario` usati con le firme dichiarate nei rispettivi "Produces". ✓

**Nota di runtime:** il numero WhatsApp è bloccato (Meta); apertura e solleciti reali non partono finché non si sblocca, ma intake, callback e test sono indipendenti.
