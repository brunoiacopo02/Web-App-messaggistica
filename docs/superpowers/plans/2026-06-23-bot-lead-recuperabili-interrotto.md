# Lead recuperabili — esito INTERROTTO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere l'esito `INTERROTTO` al bot Mario per rimandare al CRM i lead "recuperabili" (chat avviata ma interrotta senza obiezione ferrea), e restringere `DA_SCARTARE` alla sola obiezione ferrea.

**Architecture:** L'esito `INTERROTTO` viene generato in due punti: (1) live dall'AI Mario via tag `[ESITO:INTERROTTO|<motivo>]` quando il lead si disimpegna esplicitamente senza un no netto; (2) dal cron `bot-followups` che chiude come `INTERROTTO` i lead che hanno risposto almeno una volta e poi sono rimasti silenti 24h. Il flusso "mai risposto → NON_RISPOSTO" resta invariato.

**Tech Stack:** TypeScript, Next.js 16 App Router, Vitest, Supabase, Anthropic SDK (claude-sonnet-4-6).

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-06-23-bot-lead-recuperabili-interrotto-design.md`.
- Contratto CRM v1.1: URL/HMAC/endpoint invariati (`crm-sales-fenice.vercel.app/api/bot/outcome`).
- `INTERROTTO` **non** richiede data nel payload (a differenza di `APPUNTAMENTO`/`RICHIAMO`).
- `DA_SCARTARE` solo per obiezione ferrea reale; `[PASSAGGIO_UMANO]` resta solo per "voglio parlare con una persona" (non toccato).
- Soglia silenzio per `INTERROTTO` da cron = `GIVEUP_H` (24h), riuso costante esistente.
- Typecheck con `npm run typecheck` (NON `npx tsc`). Test con `npm run test`. Build con `npm run build`.
- Branch di lavoro già attivo: `feat/bot-lead-interrotto`.

---

### Task 1: Contratto — accettare INTERROTTO

**Files:**
- Modify: `lib/bot-contract.ts:10`, `lib/bot-contract.ts:30`
- Test: `lib/bot-contract.test.ts`

**Interfaces:**
- Produces: `BotOutcome` union ora include `'INTERROTTO'`; `validateOutcomeBody` accetta `INTERROTTO` senza `date`.

- [ ] **Step 1: Scrivi il test che fallisce**

In `lib/bot-contract.test.ts`, dentro il `describe('validateOutcomeBody', ...)`, aggiungi:

```typescript
  it('INTERROTTO non richiede date', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'INTERROTTO' })).toEqual({ ok: true });
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisce**

Run: `npx vitest run lib/bot-contract.test.ts`
Expected: FAIL — `INTERROTTO` non è in `OUTCOMES`, quindi ritorna `{ ok: false, reason: 'bad_request' }`.

- [ ] **Step 3: Implementa**

In `lib/bot-contract.ts` riga 10:

```typescript
export type BotOutcome = 'APPUNTAMENTO' | 'DA_SCARTARE' | 'RICHIAMO' | 'NON_RISPOSTO' | 'INTERROTTO';
```

In `lib/bot-contract.ts` riga 30:

```typescript
const OUTCOMES: BotOutcome[] = ['APPUNTAMENTO', 'DA_SCARTARE', 'RICHIAMO', 'NON_RISPOSTO', 'INTERROTTO'];
```

(NON modificare `DATE_REQUIRED`: `INTERROTTO` non richiede data.)

- [ ] **Step 4: Esegui il test e verifica che passa**

Run: `npx vitest run lib/bot-contract.test.ts`
Expected: PASS (tutti i test del file verdi).

- [ ] **Step 5: Commit**

```bash
git add lib/bot-contract.ts lib/bot-contract.test.ts
git commit -m "feat(bot): accetta esito INTERROTTO nel contratto (no data richiesta)"
```

---

### Task 2: Parsing live del tag INTERROTTO + propagazione note

**Files:**
- Modify: `lib/mario.ts:9`, `lib/mario.ts:10-17`, `lib/mario.ts:19`, `lib/mario.ts:26-52`
- Modify: `lib/fenice-autoreply.ts:133-138`
- Test: `lib/mario-parse.test.ts`

**Interfaces:**
- Consumes: `BotOutcome` con `INTERROTTO` (Task 1).
- Produces: `MarioOutcome` include `'INTERROTTO'`; `MarioResult` ha nuovo campo `note?: string`; `parseMarioReply` su `[ESITO:INTERROTTO|<motivo>]` ritorna `outcome='INTERROTTO'` e `note=<motivo>`. `sendOutcome` riceve `note`.

- [ ] **Step 1: Scrivi il test che fallisce**

In `lib/mario-parse.test.ts`, dentro il `describe('parseMarioReply — esiti CRM', ...)`, aggiungi:

```typescript
  it('INTERROTTO con motivo → outcome+note, testo pulito', () => {
    const r = parseMarioReply('va bene, fammi sapere [ESITO:INTERROTTO|tentenna, dice ti faccio sapere]');
    expect(r.outcome).toBe('INTERROTTO');
    expect(r.note).toBe('tentenna, dice ti faccio sapere');
    expect(r.discardReason).toBeUndefined();
    expect(r.visibleReply).toBe('va bene, fammi sapere');
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisce**

Run: `npx vitest run lib/mario-parse.test.ts`
Expected: FAIL — il tag `INTERROTTO` non è riconosciuto dalla regex; `outcome` è `undefined`.

- [ ] **Step 3: Implementa il parsing**

In `lib/mario.ts` riga 9:

```typescript
export type MarioOutcome = 'APPUNTAMENTO' | 'RICHIAMO' | 'DA_SCARTARE' | 'INTERROTTO';
```

In `lib/mario.ts` aggiungi `note?: string;` al tipo `MarioResult` (dopo `discardReason?: string;`):

```typescript
export type MarioResult = {
  visibleReply: string;
  appointmentFixed: boolean;
  passToHuman: boolean;
  outcome?: MarioOutcome;
  scheduledAt?: string;
  discardReason?: string;
  note?: string;
};
```

In `lib/mario.ts` riga 19, estendi la regex:

```typescript
const ESITO_RE = /\[ESITO:(APPUNTAMENTO|RICHIAMO|SCARTO|INTERROTTO)\|([^\]]*)\]/i;
```

In `lib/mario.ts`, nella funzione `parseMarioReply`, aggiungi `let note: string | undefined;` accanto alle altre dichiarazioni e aggiungi il ramo INTERROTTO al blocco `if (m) { ... }`:

```typescript
  let outcome: MarioOutcome | undefined;
  let scheduledAt: string | undefined;
  let discardReason: string | undefined;
  let note: string | undefined;

  const m = raw.match(ESITO_RE);
  if (m) {
    const kind = m[1].toUpperCase();
    const arg = (m[2] ?? '').trim();
    if (kind === 'APPUNTAMENTO') { outcome = 'APPUNTAMENTO'; scheduledAt = arg || undefined; }
    else if (kind === 'RICHIAMO') { outcome = 'RICHIAMO'; scheduledAt = arg || undefined; }
    else if (kind === 'SCARTO') { outcome = 'DA_SCARTARE'; discardReason = arg || undefined; }
    else if (kind === 'INTERROTTO') { outcome = 'INTERROTTO'; note = arg || undefined; }
  }
```

E includi `note` nell'oggetto ritornato:

```typescript
  return {
    visibleReply,
    appointmentFixed: legacyAppointment || outcome === 'APPUNTAMENTO',
    passToHuman,
    outcome,
    scheduledAt,
    discardReason,
    note,
  };
```

- [ ] **Step 4: Propaga `note` a `sendOutcome`**

In `lib/fenice-autoreply.ts` (chiamata a `sendOutcome`, righe ~133-138), aggiungi `note`:

```typescript
        const sent = await sendOutcome(supabase, conversationId, {
          outcome: result.outcome,
          date: result.scheduledAt,
          discardReason: result.discardReason,
          note: result.note,
          report,
        });
```

- [ ] **Step 5: Esegui i test e verifica che passano**

Run: `npx vitest run lib/mario-parse.test.ts`
Expected: PASS (incluso il nuovo test e quelli legacy SCARTO/APPUNTAMENTO/RICHIAMO).

- [ ] **Step 6: Commit**

```bash
git add lib/mario.ts lib/fenice-autoreply.ts lib/mario-parse.test.ts
git commit -m "feat(bot): parsing tag INTERROTTO live + propaga note a sendOutcome"
```

---

### Task 3: Prompt Mario — INTERROTTO live e scarto solo per no netto

**Files:**
- Modify: `lib/mario-prompt.ts` (sezione GESTIONE OBIEZIONI ~242, REGOLE ASSOLUTE ~255, blocco tag esito ~260-264)

**Interfaces:**
- Consumes: regex `ESITO_RE` che ora riconosce `INTERROTTO` (Task 2).
- Produces: nessuna interfaccia di codice; cambia solo il testo del system prompt.

Questo task è solo testo del prompt: non ha test automatici. La verifica è la rilettura + typecheck (il prompt è una template string).

- [ ] **Step 1: Restringi lo SCARTO e aggiungi INTERROTTO nel blocco tag esito**

In `lib/mario-prompt.ts`, sostituisci il blocco finale dei tag esito (le righe che elencano APPUNTAMENTO/RICHIAMO/SCARTO) con:

```
QUANDO LA CONVERSAZIONE ARRIVA A UN ESITO, chiudi il messaggio con UNO di questi tag tecnici (l'utente non li vede):
- Appuntamento concordato: [ESITO:APPUNTAMENTO|<data ISO 8601 con fuso, es. 2026-06-20T15:00:00+02:00>]
- Vuole essere richiamato in un momento preciso: [ESITO:RICHIAMO|<data ISO 8601 con fuso>]
- Obiezione ferrea / no netto reale (es. "non ho soldi", "non mi interessa per niente", chiaramente fuori target): [ESITO:SCARTO|<motivo breve>]
- Si disimpegna SENZA un no netto (es. "adesso non posso", "ti faccio sapere io", "lascia stare per ora", tentenna e molla): [ESITO:INTERROTTO|<motivo breve>]
```

Mantieni invariata la riga "Regole sui tag" che segue.

- [ ] **Step 2: Aggiungi la regola di disambiguazione INTERROTTO vs SCARTO**

In `lib/mario-prompt.ts`, subito dopo la riga "Regole sui tag: ...", aggiungi:

```
DIFFERENZA IMPORTANTE tra SCARTO e INTERROTTO: usa SCARTO solo per un no netto e definitivo (obiezione ferrea reale, fuori target chiaro). Usa INTERROTTO quando il lead si raffredda o rimanda senza dire un vero no. Nel dubbio NON chiudere: continua a gestire l'obiezione e tieni viva la chat, al silenzio prolungato ci pensa il sistema. Non usare INTERROTTO per una semplice obiezione che stai ancora gestendo.
```

- [ ] **Step 3: Correggi l'incoerenza "non interessato → PASSAGGIO_UMANO"**

In `lib/mario-prompt.ts`, nella sezione REGOLE ASSOLUTE, sostituisci la riga:

```
Se il lead dice che non è interessato, rispetta la sua decisione e usa [PASSAGGIO_UMANO]
```

con:

```
Se il lead dice un no netto e definitivo (non gli interessa per niente), rispetta la decisione e chiudi con [ESITO:SCARTO|<motivo>]. [PASSAGGIO_UMANO] va usato SOLO quando chiede esplicitamente di parlare con una persona.
```

(NON toccare la riga di GESTIONE OBIEZIONI "Voglio parlare con una persona → [PASSAGGIO_UMANO]".)

- [ ] **Step 4: Verifica typecheck**

Run: `npm run typecheck`
Expected: nessun errore (il prompt è una template string, deve restare sintatticamente valido).

- [ ] **Step 5: Commit**

```bash
git add lib/mario-prompt.ts
git commit -m "feat(bot): prompt Mario emette INTERROTTO e restringe SCARTO al no netto"
```

---

### Task 4: Cron bot-followups — chiude come INTERROTTO i lead silenti dopo risposta

**Files:**
- Modify: `lib/bot-followups.ts:13`, `lib/bot-followups.ts:16-29`
- Modify: `app/api/cron/bot-followups/route.ts:40-51`
- Test: `lib/bot-followups.test.ts` (Create)

**Interfaces:**
- Consumes: `sendOutcome` con `outcome: 'INTERROTTO'` (Task 1).
- Produces: `FollowupAction` include `'interrotto'`; `decideFollowupAction` richiede nuovo input `lastInboundAtMs: number | null` e ritorna `'interrotto'` per lead che hanno risposto e poi sono silenti ≥24h.

- [ ] **Step 1: Scrivi i test che falliscono**

Crea `lib/bot-followups.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { decideFollowupAction, FOLLOWUP_1_H, GIVEUP_H } from './bot-followups';

const H = 3600_000;
const NOW = Date.parse('2026-06-23T12:00:00Z');
const hAgo = (h: number) => NOW - h * H;

describe('decideFollowupAction — mai risposto (invariato)', () => {
  it('niente da fare prima del primo sollecito', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(2), nowMs: NOW, followupsSent: 0, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('none');
  });
  it('primo sollecito dopo 12h', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(FOLLOWUP_1_H), nowMs: NOW, followupsSent: 0, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('sollecito_1');
  });
  it('NON_RISPOSTO dopo 24h', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(GIVEUP_H), nowMs: NOW, followupsSent: 2, hasInbound: false, lastInboundAtMs: null });
    expect(a).toBe('non_risposto');
  });
});

describe('decideFollowupAction — ha risposto poi silente', () => {
  it('silente < 24h → none (nessun sollecito, ancora dentro finestra)', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(48), nowMs: NOW, followupsSent: 0, hasInbound: true, lastInboundAtMs: hAgo(10) });
    expect(a).toBe('none');
  });
  it('silente ≥ 24h dall ultimo inbound → INTERROTTO', () => {
    const a = decideFollowupAction({ startedAtMs: hAgo(60), nowMs: NOW, followupsSent: 0, hasInbound: true, lastInboundAtMs: hAgo(GIVEUP_H) });
    expect(a).toBe('interrotto');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscono**

Run: `npx vitest run lib/bot-followups.test.ts`
Expected: FAIL — `'interrotto'` non esiste ancora e `decideFollowupAction` non accetta `lastInboundAtMs` (i casi hasInbound ritornano `'none'` per via dell'early-return attuale).

- [ ] **Step 3: Implementa la logica unificata**

In `lib/bot-followups.ts` riga 13, estendi il tipo:

```typescript
export type FollowupAction = 'sollecito_1' | 'sollecito_2' | 'non_risposto' | 'interrotto' | 'none';
```

In `lib/bot-followups.ts`, sostituisci l'intera funzione `decideFollowupAction`:

```typescript
/** Decide l'azione per un lead CRM. Puro. */
export function decideFollowupAction(input: {
  startedAtMs: number;
  nowMs: number;
  followupsSent: number;
  hasInbound: boolean;
  lastInboundAtMs: number | null;
}): FollowupAction {
  if (input.hasInbound) {
    // Ha risposto almeno una volta poi è rimasto silente: nessun sollecito,
    // chiudi come INTERROTTO dopo 24h di silenzio (= chiusura finestra free-text).
    const ref = input.lastInboundAtMs ?? input.startedAtMs;
    const silentH = (input.nowMs - ref) / H;
    return silentH >= GIVEUP_H ? 'interrotto' : 'none';
  }
  // Mai risposto: solleciti poi NON_RISPOSTO (invariato).
  const elapsedH = (input.nowMs - input.startedAtMs) / H;
  if (elapsedH >= GIVEUP_H) return 'non_risposto';
  if (input.followupsSent < 1 && elapsedH >= FOLLOWUP_1_H) return 'sollecito_1';
  if (input.followupsSent < 2 && elapsedH >= FOLLOWUP_2_H) return 'sollecito_2';
  return 'none';
}
```

- [ ] **Step 4: Esegui i test e verifica che passano**

Run: `npx vitest run lib/bot-followups.test.ts`
Expected: PASS.

- [ ] **Step 5: Aggiorna il route per passare lastInboundAtMs e gestire 'interrotto'**

In `app/api/cron/bot-followups/route.ts`, nel loop `for (const c of ...)`, dopo il calcolo di `hasInbound` (riga ~39), calcola `lastInboundMs` e passalo a `decideFollowupAction`:

```typescript
    const hasInbound = !!c.last_inbound_at && Date.parse(c.last_inbound_at) >= startedAt;
    const lastInboundMs = c.last_inbound_at ? Date.parse(c.last_inbound_at) : null;
    const action = decideFollowupAction({
      startedAtMs: startedAt, nowMs: now, followupsSent: c.bot_followups_sent ?? 0, hasInbound, lastInboundAtMs: lastInboundMs,
    });
    if (action === 'none') continue;
```

Poi, subito dopo il blocco `if (action === 'non_risposto') { ... continue; }`, aggiungi il blocco gemello per `interrotto`:

```typescript
    if (action === 'interrotto') {
      await sendOutcome(supabase, c.id, { outcome: 'INTERROTTO', note: 'Chat interrotta senza obiezione, riassegnare a operatore.' });
      report.push({ id: c.id, action });
      continue;
    }
```

(`c.last_inbound_at` è già nella `select` del cron, nessuna modifica alla query.)

- [ ] **Step 6: Verifica typecheck**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add lib/bot-followups.ts lib/bot-followups.test.ts app/api/cron/bot-followups/route.ts
git commit -m "feat(bot): cron chiude come INTERROTTO i lead silenti dopo aver risposto"
```

---

### Task 5: Dashboard Fenice — tipo fermaReason

**Files:**
- Modify: `lib/lead-segments.ts:21-25`
- Test: `lib/lead-segments.test.ts`

**Interfaces:**
- Consumes: nessuna.
- Produces: `fermaReason` ritorna anche `'INTERROTTO'`. Nessuna modifica UI: `/fenice/lead` mostra già `reason` come stringa grezza (`LeadPipeline.tsx:127`).

- [ ] **Step 1: Scrivi il test che fallisce**

In `lib/lead-segments.test.ts`, dentro il `describe('fermaReason', ...)`, aggiungi:

```typescript
  it('INTERROTTO come motivo di FERMA', () => {
    expect(fermaReason({ bot_outcome: 'INTERROTTO', last_inbound_at: hoursAgo(1), ai_status: 'closed' }, NOW)).toBe('INTERROTTO');
  });
```

(`hoursAgo` e `NOW` sono già definiti in cima al file di test.)

- [ ] **Step 2: Esegui il test e verifica che fallisce**

Run: `npx vitest run lib/lead-segments.test.ts`
Expected: il test runtime passa già (il cast restituisce la stringa), ma `npm run typecheck` fallisce perché `'INTERROTTO'` non è nel tipo di ritorno. Procedi comunque a stringere il tipo. Se preferisci vedere il fallimento, esegui prima Step 4 (typecheck) — deve dare errore di tipo sul nuovo test.

- [ ] **Step 3: Allarga il tipo di ritorno**

In `lib/lead-segments.ts`, sostituisci la firma e il cast di `fermaReason`:

```typescript
export function fermaReason(c: SegmentInput, now: string): 'RICHIAMO' | 'DA_SCARTARE' | 'NON_RISPOSTO' | 'INTERROTTO' | 'SILENTE' | null {
  if (segmentOf(c, now) !== 'FERMA') return null;
  if (c.bot_outcome) return c.bot_outcome as 'RICHIAMO' | 'DA_SCARTARE' | 'NON_RISPOSTO' | 'INTERROTTO';
  return 'SILENTE';
}
```

- [ ] **Step 4: Esegui test + typecheck**

Run: `npx vitest run lib/lead-segments.test.ts && npm run typecheck`
Expected: test PASS, typecheck senza errori.

- [ ] **Step 5: Commit**

```bash
git add lib/lead-segments.ts lib/lead-segments.test.ts
git commit -m "feat(fenice): fermaReason include INTERROTTO"
```

---

### Task 6: Verifica finale

**Files:** nessuno (solo verifica).

- [ ] **Step 1: Suite completa di test**

Run: `npm run test`
Expected: tutti i test verdi.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build completata senza errori.

- [ ] **Step 4: Commit finale (se restano modifiche non committate)**

```bash
git add -A
git commit -m "chore(bot): verifica finale esito INTERROTTO" || echo "niente da committare"
```

---

## Self-Review (eseguita)

- **Copertura spec:** §1 contratto → Task 1; §2 mario.ts/note → Task 2; §3 prompt → Task 3; §4 cron → Task 4; §5 dashboard → Task 5; test → ogni task + Task 6. Fuori scope (`PASSAGGIO_UMANO`) lasciato invariato come da spec.
- **Placeholder:** nessuno; ogni step ha codice/comando concreto.
- **Coerenza tipi:** `MarioOutcome`/`BotOutcome` includono `INTERROTTO` (Task 1-2); `note` definito in `MarioResult` (Task 2) e consumato in `fenice-autoreply` (Task 2) e cron (Task 4); `FollowupAction` con `'interrotto'` e firma `decideFollowupAction` con `lastInboundAtMs` coerenti tra Task 4 lib e route; `fermaReason` widened (Task 5).
