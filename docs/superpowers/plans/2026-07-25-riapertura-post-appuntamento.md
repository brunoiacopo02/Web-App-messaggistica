# Riapertura conversazioni dopo il fissaggio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** permettere al bot di riprendere una conversazione dopo che l'appuntamento è stato fissato, senza che questo possa generare nemmeno una scrittura verso il CRM.

**Architecture:** due modifiche indipendenti. (1) La riapertura nel webhook Twilio passa da una condizione scritta inline a una funzione pura testabile, che ammette anche lo stato `booked` e non richiede più `crm_lead_id`. (2) Una guardia nel drain impedisce a una conversazione con `bot_outcome='APPUNTAMENTO'` di chiamare `sendOutcome`, così la riapertura non può alimentare il canale nota-via-appuntamento (che il CRM, non essendo idempotente, tratterebbe come un appuntamento nuovo).

**Tech Stack:** TypeScript, Next.js App Router, Vitest, Supabase.

## Global Constraints

- Le conversazioni `handed_off` NON si riaprono mai: se un umano ha preso in carico la chat, il bot non rientra.
- Nessuna scrittura nuova verso il CRM: dopo queste modifiche il numero di POST verso il CRM può solo diminuire, mai aumentare.
- `bot_outcome='APPUNTAMENTO'` resta terminale: né questo piano né i suoi test possono modificare `bot_outcome` o `bot_scheduled_at` di una conversazione già fissata.
- Il comportamento del cron `bot-followups` non va toccato: la guardia vive nel drain (`lib/fenice-autoreply.ts`), non dentro `sendOutcome`.

---

## File Structure

- `lib/fenice-autoreply.ts` — MODIFY: nuova funzione pura `shouldReopen`, esportata; guardia sul terminale prima di `sendOutcome`; il drain carica anche `bot_outcome`.
- `lib/fenice-autoreply.test.ts` — MODIFY: test delle due logiche.
- `app/api/webhooks/twilio/route.ts:177-180` — MODIFY: sostituire la condizione inline con `shouldReopen`.

---

### Task 1: `shouldReopen` e riapertura nel webhook

**Files:**
- Modify: `lib/fenice-autoreply.ts` (accanto a `shouldAutoReply`, righe 20-27)
- Modify: `app/api/webhooks/twilio/route.ts:177-180`
- Test: `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Produces: `shouldReopen(g: { aiOwner: string | null; aiStatus: string | null }): boolean` — true se `aiOwner === 'mario'` e `aiStatus` è `'closed'` o `'booked'`; false altrimenti.

- [ ] **Step 1: Write the failing test**

In `lib/fenice-autoreply.test.ts` aggiungi:

```typescript
describe('shouldReopen', () => {
  it('riapre una conversazione chiusa dopo l esito', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'closed' })).toBe(true);
  });

  it('riapre anche una conversazione booked: è il caso del post-appuntamento', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'booked' })).toBe(true);
  });

  it('NON riapre una conversazione presa in carico da un umano', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'handed_off' })).toBe(false);
  });

  it('non tocca le conversazioni già vive', () => {
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'active' })).toBe(false);
    expect(shouldReopen({ aiOwner: 'mario', aiStatus: 'replying' })).toBe(false);
  });

  it('non riapre conversazioni non arruolate nel bot', () => {
    expect(shouldReopen({ aiOwner: null, aiStatus: 'closed' })).toBe(false);
    expect(shouldReopen({ aiOwner: 'umano', aiStatus: 'booked' })).toBe(false);
  });
});
```

Aggiungi `shouldReopen` all'import esistente in cima al file di test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: FAIL — `shouldReopen` non esiste (errore di import).

- [ ] **Step 3: Implementa la funzione**

In `lib/fenice-autoreply.ts`, subito dopo `shouldAutoReply`:

```typescript
/**
 * Pure: la conversazione va riaperta all'arrivo di un messaggio del lead?
 * Vero per gli stati in cui il bot ha finito il suo giro ('closed' dopo l'esito,
 * 'booked' dopo il fissaggio): dopo l'appuntamento il lead scrive ancora (conferma
 * di aver visto il video, chiede di spostare) e il bot deve poter rispondere.
 * Falso per 'handed_off': se un umano ha preso in carico la chat, il bot non rientra.
 */
export function shouldReopen(g: { aiOwner: string | null; aiStatus: string | null }): boolean {
  if (g.aiOwner !== 'mario') return false;
  return g.aiStatus === 'closed' || g.aiStatus === 'booked';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: PASS.

- [ ] **Step 5: Collega il webhook**

In `app/api/webhooks/twilio/route.ts`, sostituisci:

```typescript
      if (conv?.crm_lead_id && conv.ai_status === 'closed') {
```

con:

```typescript
      if (shouldReopen({ aiOwner: conv?.ai_owner ?? null, aiStatus: conv?.ai_status ?? null })) {
```

Aggiungi `shouldReopen` all'import esistente da `@/lib/fenice-autoreply`. Il corpo del blocco (update a `'active'` e riallineamento di `conv.ai_status`) resta identico.

Nota: `crm_lead_id` resta nella `select` perché usato altrove nella route; non rimuoverlo dalla query senza verificare gli altri usi.

- [ ] **Step 6: Verifica typecheck e suite**

Run: `./node_modules/.bin/tsc --noEmit` — Expected: nessun output
Run: `npx vitest run` — Expected: tutti verdi

- [ ] **Step 7: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts app/api/webhooks/twilio/route.ts
git commit -m "feat(riapertura): il bot riprende anche le conversazioni booked, mai quelle passate a un umano"
```

---

### Task 2: guardia — una conversazione già fissata non scrive mai al CRM

**Files:**
- Modify: `lib/fenice-autoreply.ts` (`select` a riga 115, e il ramo `if (crmLeadId && result.outcome)` a riga 177)
- Test: `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Consumes: `shouldReopen` dal Task 1.
- Produces: `canSendOutcome(g: { crmLeadId: string | null; botOutcome: string | null }): boolean` — false se `crmLeadId` è null oppure se `botOutcome === 'APPUNTAMENTO'`; true altrimenti.

**Perché:** `sendOutcome` traduce ogni esito successivo a un appuntamento in una nota, ma la spedisce come POST con `outcome: 'APPUNTAMENTO'`. Il CRM non è idempotente e la registra come appuntamento nuovo (incidente del 20/07). Ora che le conversazioni fissate si riaprono, il bot potrebbe emettere esiti su di esse: la guardia chiude quel canale alla fonte.

- [ ] **Step 1: Write the failing test**

In `lib/fenice-autoreply.test.ts` aggiungi:

```typescript
describe('canSendOutcome', () => {
  it('consente l esito su una conversazione CRM non ancora esitata', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', botOutcome: null })).toBe(true);
  });

  it('consente l esito se l esito corrente non è un appuntamento', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', botOutcome: 'RICHIAMO' })).toBe(true);
  });

  it('BLOCCA qualunque esito su un appuntamento già fissato', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', botOutcome: 'APPUNTAMENTO' })).toBe(false);
  });

  it('non invia nulla senza lead CRM', () => {
    expect(canSendOutcome({ crmLeadId: null, botOutcome: null })).toBe(false);
  });
});
```

Aggiungi `canSendOutcome` all'import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: FAIL — `canSendOutcome` non esiste.

- [ ] **Step 3: Implementa la funzione**

In `lib/fenice-autoreply.ts`, accanto a `shouldReopen`:

```typescript
/**
 * Pure: possiamo mandare un esito al CRM per questa conversazione?
 * No su un appuntamento già fissato: `sendOutcome` lo tradurrebbe in una nota
 * spedita come POST `APPUNTAMENTO`, e il CRM (non idempotente) la registrerebbe
 * come un appuntamento nuovo, gonfiando il conteggio. Le disdette passano da un
 * umano finché il CRM non accetta un canale di sola nota.
 */
export function canSendOutcome(g: { crmLeadId: string | null; botOutcome: string | null }): boolean {
  if (!g.crmLeadId) return false;
  return g.botOutcome !== 'APPUNTAMENTO';
}
```

- [ ] **Step 4: Carica `bot_outcome` nel drain**

A riga 115 la `select` del lock CAS è `.select('id, ai_started_at, crm_lead_id')`: aggiungi `bot_outcome`. Poi, accanto a `const crmLeadId = ...` (riga 119), estrai anche:

```typescript
  const botOutcome = (claimed as { bot_outcome: string | null }).bot_outcome;
```

Adegua il cast del tipo di `claimed` includendo il nuovo campo.

- [ ] **Step 5: Applica la guardia**

Sostituisci la condizione `if (crmLeadId && result.outcome) {` con:

```typescript
      if (result.outcome && canSendOutcome({ crmLeadId, botOutcome })) {
```

Poi, subito PRIMA di quel blocco, aggiungi il ramo che rende visibile ciò che non parte:

```typescript
      if (result.outcome && crmLeadId && !canSendOutcome({ crmLeadId, botOutcome })) {
        await supabase.from('event_log').insert({
          type: 'bot_outcome_suppressed',
          payload: { conversationId, crmLeadId, attemptedOutcome: result.outcome } as never,
          message: `[bot-fissatore] conv ${conversationId}: esito ${result.outcome} NON inviato, appuntamento già fissato`,
          level: 'info',
        });
      }
```

Vincolo: questo ramo non deve contenere `break` e non deve toccare `finalStatus`.

- [ ] **Step 6: Verifica typecheck e suite**

Run: `./node_modules/.bin/tsc --noEmit` — Expected: nessun output
Run: `npx vitest run` — Expected: tutti verdi

- [ ] **Step 7: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(crm): nessun esito al CRM su un appuntamento già fissato"
```
