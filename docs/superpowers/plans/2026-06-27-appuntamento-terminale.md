# Appuntamento Terminale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una volta che una conversazione è `bot_outcome='APPUNTAMENTO'`, l'esito diventa terminale (mai declassato); disdette/cambi diventano note CRM; il follow-up agenda salta i lead con esito terminale.

**Architecture:** Logica decisionale pura in un nuovo modulo `lib/bot-outcome-rules.ts` (testabile senza I/O), agganciata al choke-point I/O `sendOutcome` in `lib/bot-outcome.ts`. Lo stesso pattern "decide puro + wrapper I/O" già usato da `agenda-followup.ts`. Il guard nel choke-point protegge tutti i chiamanti (inbound autoreply + cron bot-followups).

**Tech Stack:** TypeScript, Next.js 16, Vitest 4, Supabase (admin client passato come argomento), CRM callback via `fetch` + HMAC.

## Global Constraints

- Test runner: `npx vitest run <file>` (singolo) o `npm test` (tutto = `vitest run`).
- Typecheck: `npm run typecheck` (= `tsc --noEmit`), deve restare pulito.
- `BotOutcome = 'APPUNTAMENTO' | 'DA_SCARTARE' | 'RICHIAMO' | 'NON_RISPOSTO' | 'INTERROTTO'` (da `lib/bot-contract.ts`).
- `sendOutcome` riceve `supabase` come **argomento** (non importa il client) → testabile con un fake.
- Non declassare MAI un APPUNTAMENTO: in ogni ramo dubbio, la riga resta APPUNTAMENTO.
- Commit frequenti, uno per task.

---

### Task 1: Logica pura `resolveOutcomeAction` + `buildLockedNote`

**Files:**
- Create: `lib/bot-outcome-rules.ts`
- Test: `lib/bot-outcome-rules.test.ts`

**Interfaces:**
- Consumes: `BotOutcome` da `lib/bot-contract.ts`.
- Produces:
  - `type OutcomeArgs = { outcome: BotOutcome; date?: string; note?: string; discardReason?: string }`
  - `type OutcomeAction = { kind: 'normal' } | { kind: 'locked'; note: string; date: string | null }`
  - `buildLockedNote(args: OutcomeArgs, existingDate: string | null): string`
  - `resolveOutcomeAction(current: BotOutcome | null, args: OutcomeArgs, existingDate: string | null): OutcomeAction`

- [ ] **Step 1: Write the failing test**

```ts
// lib/bot-outcome-rules.test.ts
import { describe, it, expect } from 'vitest';
import { resolveOutcomeAction, buildLockedNote } from './bot-outcome-rules';

const DATE = '2026-06-29T17:00:00Z';

describe('resolveOutcomeAction', () => {
  it('non-APPUNTAMENTO corrente → normal', () => {
    expect(resolveOutcomeAction(null, { outcome: 'DA_SCARTARE' }, null))
      .toEqual({ kind: 'normal' });
    expect(resolveOutcomeAction('RICHIAMO', { outcome: 'APPUNTAMENTO', date: DATE }, null).kind)
      .toBe('normal');
  });

  it('APPUNTAMENTO corrente + qualsiasi esito → locked con data originale', () => {
    const a = resolveOutcomeAction('APPUNTAMENTO', { outcome: 'DA_SCARTARE', discardReason: 'la madre non paga' }, DATE);
    expect(a.kind).toBe('locked');
    if (a.kind === 'locked') {
      expect(a.date).toBe(DATE);
      expect(a.note).toContain('annullare');
      expect(a.note).toContain('la madre non paga');
    }
  });

  it('APPUNTAMENTO corrente senza data originale → locked con date null', () => {
    const a = resolveOutcomeAction('APPUNTAMENTO', { outcome: 'INTERROTTO' }, null);
    expect(a).toMatchObject({ kind: 'locked', date: null });
  });
});

describe('buildLockedNote', () => {
  it('SCARTO → motivo annullamento', () => {
    expect(buildLockedNote({ outcome: 'DA_SCARTARE', discardReason: 'no budget' }, DATE))
      .toContain('no budget');
  });
  it('INTERROTTO → nota interruzione, appuntamento mantenuto', () => {
    expect(buildLockedNote({ outcome: 'INTERROTTO' }, DATE).toLowerCase())
      .toContain('interrotta');
  });
  it('RICHIAMO → appuntamento mantenuto', () => {
    expect(buildLockedNote({ outcome: 'RICHIAMO', date: DATE }, DATE).toLowerCase())
      .toContain('mantenuto');
  });
  it('APPUNTAMENTO stessa data → riconferma', () => {
    expect(buildLockedNote({ outcome: 'APPUNTAMENTO', date: DATE }, DATE).toLowerCase())
      .toContain('riconfermato');
  });
  it('APPUNTAMENTO data diversa → richiesta di spostamento, originale mantenuto', () => {
    const n = buildLockedNote({ outcome: 'APPUNTAMENTO', date: '2026-07-01T10:00:00Z' }, DATE);
    expect(n).toContain('spostare');
    expect(n).toContain(DATE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/bot-outcome-rules.test.ts`
Expected: FAIL — `Cannot find module './bot-outcome-rules'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/bot-outcome-rules.ts
import type { BotOutcome } from './bot-contract';

export type OutcomeArgs = {
  outcome: BotOutcome;
  date?: string;
  note?: string;
  discardReason?: string;
};

export type OutcomeAction =
  | { kind: 'normal' }
  | { kind: 'locked'; note: string; date: string | null };

/**
 * Costruisce la nota da inviare al CRM quando un lead GIÀ fissato genera un esito
 * successivo. L'esito non declassa: viene tradotto in una nota informativa.
 */
export function buildLockedNote(args: OutcomeArgs, existingDate: string | null): string {
  const extra = args.note && args.note.trim() ? ` ${args.note.trim()}` : '';
  let base: string;
  switch (args.outcome) {
    case 'DA_SCARTARE':
      base = `Il lead vuole annullare l'appuntamento. Motivo: ${args.discardReason?.trim() || 'non specificato'}.`;
      break;
    case 'INTERROTTO':
      base = `Conversazione interrotta dopo l'appuntamento. Appuntamento mantenuto.`;
      break;
    case 'RICHIAMO':
      base = `Il lead ha chiesto di essere ricontattato${args.date ? ` (${args.date})` : ''}. Appuntamento mantenuto.`;
      break;
    case 'NON_RISPOSTO':
      base = `Nessuna risposta successiva. Appuntamento mantenuto.`;
      break;
    case 'APPUNTAMENTO':
      if (args.date && existingDate && args.date !== existingDate) {
        base = `Il lead ha chiesto di spostare a ${args.date}. Appuntamento originale mantenuto: ${existingDate}.`;
      } else {
        base = `Il lead ha riconfermato l'appuntamento.`;
      }
      break;
  }
  return `${base}${extra}`.trim();
}

/**
 * Decide cosa fare con un esito in arrivo dato l'esito corrente della conversazione.
 * Se la conversazione è già APPUNTAMENTO l'esito è terminale: 'locked' (nota, niente
 * declassamento). Altrimenti 'normal' (comportamento standard).
 */
export function resolveOutcomeAction(
  current: BotOutcome | null,
  args: OutcomeArgs,
  existingDate: string | null,
): OutcomeAction {
  if (current === 'APPUNTAMENTO') {
    return { kind: 'locked', note: buildLockedNote(args, existingDate), date: existingDate };
  }
  return { kind: 'normal' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/bot-outcome-rules.test.ts`
Expected: PASS (tutti i casi).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add lib/bot-outcome-rules.ts lib/bot-outcome-rules.test.ts
git commit -m "feat(bot): logica pura esito terminale (resolveOutcomeAction + buildLockedNote)"
```

---

### Task 2: Aggancio del guard in `sendOutcome`

**Files:**
- Modify: `lib/bot-outcome.ts`
- Test: `lib/bot-outcome.test.ts` (create)

**Interfaces:**
- Consumes: `resolveOutcomeAction` da Task 1; `validateOutcomeBody`, `BotOutcomeBody`, `BotOutcome` da `lib/bot-contract.ts`; `signPayload` da `lib/bot-hmac.ts`.
- Produces: `sendOutcome` invariata nella firma — `(supabase, conversationId, args) => Promise<{ sent: boolean; status?: number; error?: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/bot-outcome.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendOutcome } from './bot-outcome';

const DATE = '2026-06-29T17:00:00Z';

/** Fake del client Supabase: traccia update ed event_log, restituisce una riga fissa. */
function makeSupabase(convRow: any) {
  const calls = { updates: [] as any[], events: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: convRow }); },
          update(payload: any) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; },
        };
      }
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'test-secret');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('sendOutcome — guard APPUNTAMENTO terminale', () => {
  it('lead già APPUNTAMENTO + SCARTO → invia APPUNTAMENTO+note, riga NON toccata, log locked', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE });
    const res = await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'la madre non paga' });

    expect(res.sent).toBe(true);
    const fetchMock = (globalThis.fetch as any);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.outcome).toBe('APPUNTAMENTO');
    expect(body.date).toBe(DATE);
    expect(body.note).toContain('annullare');
    expect(calls.updates).toHaveLength(0);              // riga congelata
    expect(calls.events.some((e) => e.type === 'bot_outcome_locked')).toBe(true);
  });

  it('lead non ancora deciso + APPUNTAMENTO → comportamento normale (persiste e chiude)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'APPUNTAMENTO', date: DATE });

    expect(res.sent).toBe(true);
    expect(calls.updates[0]).toMatchObject({ bot_outcome: 'APPUNTAMENTO', ai_status: 'closed' });
    expect(calls.events.some((e) => e.type === 'bot_outcome_sent')).toBe(true);
  });

  it('lead APPUNTAMENTO senza data originale → non invia, non declassa, warning', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'INTERROTTO' });

    expect(res.sent).toBe(true);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);  // nessun POST
    expect(calls.updates).toHaveLength(0);
    expect(calls.events.some((e) => e.type === 'bot_outcome_locked' && e.level === 'warning')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/bot-outcome.test.ts`
Expected: FAIL (il guard non esiste ancora: `calls.updates` non vuoto nel primo caso, o nessun evento `bot_outcome_locked`).

- [ ] **Step 3: Rewrite `sendOutcome` con il guard**

Sostituisci l'intero corpo di `sendOutcome` (da `lib/bot-outcome.ts`) con questa versione (resto del file invariato; aggiungi l'import in cima):

```ts
import { resolveOutcomeAction } from './bot-outcome-rules';
import type { BotOutcome } from './bot-contract';
```

```ts
export async function sendOutcome(
  supabase: Supa,
  conversationId: number,
  args: SendOutcomeArgs,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { sent: false, error: 'not_configured' };

  const { data: conv } = await supabase
    .from('conversations')
    .select('crm_lead_id, bot_outcome, bot_scheduled_at')
    .eq('id', conversationId)
    .maybeSingle();
  const row = conv as { crm_lead_id: string | null; bot_outcome: string | null; bot_scheduled_at: string | null } | null;
  const crmLeadId = row?.crm_lead_id ?? null;
  if (!crmLeadId) return { sent: false, error: 'not_crm_lead' };

  const action = resolveOutcomeAction(
    (row?.bot_outcome ?? null) as BotOutcome | null,
    args,
    row?.bot_scheduled_at ?? null,
  );

  // Lead già fissato ma senza data originale: non possiamo re-inviare APPUNTAMENTO
  // (la data è obbligatoria). Non declassiamo: logghiamo un warning ed usciamo.
  if (action.kind === 'locked' && !action.date) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_locked',
      level: 'warning',
      payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, keptOutcome: 'APPUNTAMENTO' } as never,
      message: `[bot-fissatore] esito ${args.outcome} ignorato: lead ${crmLeadId} già APPUNTAMENTO senza data`,
    });
    return { sent: true };
  }

  const body: BotOutcomeBody = action.kind === 'locked'
    ? {
        leadId: crmLeadId,
        outcome: 'APPUNTAMENTO',
        date: action.date as string,
        note: action.note,
        ...(args.report ? { report: args.report } : {}),
      }
    : {
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
      if (action.kind === 'normal') {
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
      } else {
        // Lead terminale: NON tocchiamo la riga. Logghiamo l'intercettazione.
        await supabase.from('event_log').insert({
          type: 'bot_outcome_locked',
          payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, keptOutcome: 'APPUNTAMENTO', note: action.note } as never,
          message: `[bot-fissatore] esito ${args.outcome} intercettato (lead ${crmLeadId} già APPUNTAMENTO) → nota CRM`,
          level: 'info',
        });
      }
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/bot-outcome.test.ts`
Expected: PASS (3 casi).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add lib/bot-outcome.ts lib/bot-outcome.test.ts
git commit -m "feat(bot): APPUNTAMENTO terminale in sendOutcome — disdette come nota CRM, niente declassamento"
```

---

### Task 3: Skip follow-up sui lead terminali

**Files:**
- Modify: `lib/agenda-followup.ts` (interfaccia `AgendaFollowupInput`, `decideAgendaFollowup`, `runAgendaFollowups`)
- Test: `lib/agenda-followup.test.ts`

**Interfaces:**
- Produces: `AgendaFollowupInput` con campo `terminal: boolean` (sostituisce `booked`). `decideAgendaFollowup` ritorna `'none'` se `terminal`.

- [ ] **Step 1: Aggiorna i test (failing)**

In `lib/agenda-followup.test.ts`: nell'oggetto `base` sostituisci `booked: false,` con `terminal: false,`. Sostituisci il test "niente se ha già preso l'appuntamento" con:

```ts
  it('niente se la conversazione ha un esito terminale (preso/scartato/interrotto)', () => {
    expect(decideAgendaFollowup({ ...base, terminal: true })).toBe('none');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agenda-followup.test.ts`
Expected: FAIL — `terminal` non esiste sul tipo / `base` ha ancora `booked`.

- [ ] **Step 3: Aggiorna `lib/agenda-followup.ts`**

In `AgendaFollowupInput` sostituisci `booked: boolean;` con `terminal: boolean;`.

In `decideAgendaFollowup` sostituisci `if (input.booked) return 'none';` con `if (input.terminal) return 'none';`.

In `runAgendaFollowups`, dentro il `for`, sostituisci il blocco `decideAgendaFollowup({ ... booked: ... })` così:

```ts
    const decision = decideAgendaFollowup({
      agendaSentAtMs,
      nowMs,
      terminal: c.bot_outcome != null
        || c.ai_status === 'closed'
        || c.ai_status === 'booked'
        || c.ai_status === 'handed_off',
      followupAlreadySent: (c.bot_followups_sent ?? 0) >= 1,
      lastInboundAtMs,
      lastMessageIsInbound,
      romeHour: hour,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agenda-followup.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + suite completa**

Run: `npm run typecheck && npm test`
Expected: typecheck pulito, tutti i test verdi.

- [ ] **Step 6: Commit**

```bash
git add lib/agenda-followup.ts lib/agenda-followup.test.ts
git commit -m "fix(bot): il follow-up agenda salta i lead con esito terminale (non solo APPUNTAMENTO)"
```

---

### Task 4: Backfill conversazioni storiche (eseguito dalla primary session via Supabase MCP)

> Questo task NON è codice applicativo: è un'operazione dati una-tantum, eseguita dalla
> sessione primaria con verifica manuale caso per caso. Non delegare a subagent.

**Conversazioni:** 1263 (lead 4903), 1246 (lead 4886), 1268 (lead 4908).

- [ ] **Step 1: Verifica realtà del fissaggio e recupero data originale**

Per ciascuna conversazione, ispeziona i messaggi attorno all'evento APPUNTAMENTO:

```sql
select direction, body, created_at from messages
where conversation_id in (1263, 1246, 1268)
order by conversation_id, created_at;
```

Conferma per ognuna: (a) Mario ha effettivamente proposto e fissato un orario;
(b) estrai la data/ora concordata e convertila in ISO con offset (Rome → UTC).
Per 1263 è già nota: `2026-06-29T17:00:00Z` (lun 29/06 ore 19:00).

- [ ] **Step 2: Ripristino `bot_outcome` (solo per le conversazioni confermate reali)**

```sql
update conversations
set bot_outcome = 'APPUNTAMENTO', bot_scheduled_at = '<DATA_ISO>', ai_status = 'closed'
where id = <CONV_ID> and bot_outcome <> 'APPUNTAMENTO';
```

- [ ] **Step 3: Verifica conteggio Presi**

```sql
select count(*) from conversations where bot_outcome = 'APPUNTAMENTO';
```

Atteso: il conteggio aumenta di quante conversazioni sono state ripristinate.

- [ ] **Step 4: Re-notifica CRM (DOPO conferma del team CRM — vedi spec Blocco 4)**

Bloccato finché il team CRM non conferma che un re-invio `APPUNTAMENTO`+`note` registra
la nota senza duplicare l'appuntamento. A conferma ottenuta, per ogni conversazione
ripristinata inviare al CRM `outcome: APPUNTAMENTO`, `date` originale, `note` di
ripristino (es. *"Ripristino: appuntamento erroneamente declassato dal bot; stato
successivo (<esito precedente>) registrato come nota."*). Loggare l'esito.

---

## Self-Review

**Spec coverage:**
- Blocco 1 (guard terminale) → Task 1 (pura) + Task 2 (wiring). ✓
- Regole costruzione nota → Task 1 `buildLockedNote`, tutti gli outcome coperti. ✓
- Evento `bot_outcome_locked` (info + warning edge) → Task 2. ✓
- Blocco 2 (skip follow-up terminali) → Task 3. ✓
- Blocco 3 (backfill 3 conversazioni) → Task 4. ✓
- Blocco 4 (dipendenza CRM) → Task 4 Step 4 (bloccato su conferma). ✓
- Testing (bot-outcome + agenda-followup) → Task 1/2/3. ✓
- Fuori scope (badge UI, prompt nudge) → non presenti nel piano. ✓

**Placeholder scan:** `<DATA_ISO>`/`<CONV_ID>`/`<esito precedente>` in Task 4 sono parametri di un'operazione dati con verifica per-riga, non placeholder di codice. Nessun TODO/TBD nei task di codice.

**Type consistency:** `resolveOutcomeAction`/`buildLockedNote`/`OutcomeAction`/`OutcomeArgs` usati identici tra Task 1 e Task 2. Campo `terminal` coerente tra interfaccia, `decideAgendaFollowup` e `runAgendaFollowups` in Task 3.
