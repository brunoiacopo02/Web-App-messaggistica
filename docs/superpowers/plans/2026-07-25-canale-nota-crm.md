# Canale NOTA verso il CRM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** usare il nuovo esito `NOTA` del CRM per comunicare disdette e richieste di spostamento senza mai toccare lo stato del lead, eliminando il canale attuale che duplica gli appuntamenti.

**Architecture:** il CRM (contratto v1.2, live dal 25/07) accetta `outcome: 'NOTA'` su `/api/bot/outcome` con `note` obbligatoria e nessuna data. Non modifica lo stato del lead e, se il lead è appuntato, notifica subito il team Conferme. Tre modifiche: il tipo e la validazione nel contratto, il ramo `locked` di `sendOutcome` che passa da `APPUNTAMENTO`+nota a `NOTA`, e la guardia `canSendOutcome` che può tornare a lasciar passare gli esiti su appuntamento fissato — perché ora produrre una nota è innocuo.

**Tech Stack:** TypeScript, Vitest, HMAC verso il CRM (invariato).

## Global Constraints

- `NOTA` non richiede mai una data e richiede SEMPRE una `note` non vuota: un POST `NOTA` senza nota è un errore di validazione da bloccare prima dell'invio.
- Nessun POST `APPUNTAMENTO` deve più partire dal ramo `locked`: è il canale che il CRM registra come appuntamento nuovo (incidente 20/07).
- `bot_outcome` e `bot_scheduled_at` locali di una conversazione già `APPUNTAMENTO` restano intoccabili: `NOTA` non li modifica mai.
- La guardia su `aiStatus === 'booked'` in `canSendOutcome` NON va rimossa: serve a un problema diverso (`ai_status` fa anche da lucchetto del drain).
- Il 403 del CRM su lead non più assegnati è già gestito (`bot_outcome_rejected`): non cambiarlo.

---

## File Structure

- `lib/bot-contract.ts` — MODIFY: `BotOutcome` accoglie `'NOTA'`, validazione con nota obbligatoria e data vietata.
- `lib/bot-contract.test.ts` — MODIFY: test della validazione.
- `lib/bot-outcome-rules.ts` — MODIFY: `OutcomeAction` di tipo `locked` porta con sé l'esito da inviare.
- `lib/bot-outcome-rules.test.ts` — MODIFY.
- `lib/bot-outcome.ts` — MODIFY: il body del ramo `locked` usa `NOTA`.
- `lib/bot-outcome.test.ts` — MODIFY.
- `lib/fenice-autoreply.ts` — MODIFY (Task 2): `canSendOutcome` non blocca più su `botOutcome === 'APPUNTAMENTO'`.
- `lib/fenice-autoreply.test.ts` — MODIFY (Task 2).

---

### Task 1: `NOTA` nel contratto e nel ramo locked

**Files:**
- Modify: `lib/bot-contract.ts`, `lib/bot-outcome-rules.ts`, `lib/bot-outcome.ts`
- Test: `lib/bot-contract.test.ts`, `lib/bot-outcome-rules.test.ts`, `lib/bot-outcome.test.ts`

**Interfaces:**
- Produces: `BotOutcome` include `'NOTA'`; `OutcomeAction` diventa `{ kind: 'locked'; outcome: 'NOTA'; note: string; date: null }`.

- [ ] **Step 1: Write the failing tests**

In `lib/bot-contract.test.ts`:

```typescript
describe('esito NOTA', () => {
  it('accetta NOTA con una nota e senza data', () => {
    const r = validateOutcomeBody({ leadId: 'x', outcome: 'NOTA', note: 'il lead ha disdetto' });
    expect(r.ok).toBe(true);
  });

  it('rifiuta NOTA senza nota', () => {
    expect(validateOutcomeBody({ leadId: 'x', outcome: 'NOTA' }).ok).toBe(false);
    expect(validateOutcomeBody({ leadId: 'x', outcome: 'NOTA', note: '   ' }).ok).toBe(false);
  });

  it('NOTA non richiede la data', () => {
    const r = validateOutcomeBody({ leadId: 'x', outcome: 'NOTA', note: 'ok' });
    expect(r.ok).toBe(true);
  });
});
```

Nota per l'implementatore: la funzione di validazione in `lib/bot-contract.ts` potrebbe avere un nome diverso da `validateOutcomeBody` — leggi il file e usa quella reale, adattando i test.

In `lib/bot-outcome-rules.test.ts`:

```typescript
describe('resolveOutcomeAction su appuntamento fissato', () => {
  it('produce una NOTA, mai un APPUNTAMENTO', () => {
    const a = resolveOutcomeAction('APPUNTAMENTO', { outcome: 'DA_SCARTARE', discardReason: 'ha disdetto' }, '2026-08-01T15:00:00+02:00');
    expect(a.kind).toBe('locked');
    if (a.kind === 'locked') {
      expect(a.outcome).toBe('NOTA');
      expect(a.date).toBeNull();
      expect(a.note).toContain('annullare');
    }
  });
});
```

In `lib/bot-outcome.test.ts`, adegua i test esistenti sul ramo locked: il body inviato al CRM deve ora avere `outcome: 'NOTA'`, nessuna `date`, e la `note` valorizzata. Aggiungi un'asserzione esplicita che nel body NON compaia `outcome: 'APPUNTAMENTO'`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/bot-contract.test.ts lib/bot-outcome-rules.test.ts lib/bot-outcome.test.ts`
Expected: FAIL — `'NOTA'` non è un `BotOutcome` valido e il ramo locked invia ancora `APPUNTAMENTO`.

- [ ] **Step 3: Estendi il contratto**

In `lib/bot-contract.ts`: aggiungi `'NOTA'` al tipo `BotOutcome` e all'array `OUTCOMES`. `NOTA` NON va in `DATE_REQUIRED`. Aggiungi la regola: se l'esito è `NOTA` e la nota è assente o solo spazi, la validazione fallisce con una ragione esplicita.

- [ ] **Step 4: Il ramo locked produce una NOTA**

In `lib/bot-outcome-rules.ts`: il tipo `OutcomeAction` diventa

```typescript
export type OutcomeAction =
  | { kind: 'normal' }
  | { kind: 'locked'; outcome: 'NOTA'; note: string; date: null };
```

e `resolveOutcomeAction` ritorna `{ kind: 'locked', outcome: 'NOTA', note: buildLockedNote(args, existingDate), date: null }`.

`buildLockedNote` resta invariata nei testi: sono già scritti come note informative e contengono la data originale dove serve.

- [ ] **Step 5: Il body inviato usa NOTA**

In `lib/bot-outcome.ts`, nel punto in cui si costruisce il `body` per il ramo `locked`: `outcome: 'NOTA'`, `note: action.note`, **nessun campo `date`**. Rimuovi la guardia che oggi salta l'invio quando manca la data originale (`action.kind === 'locked' && !action.date`): con `NOTA` la data non serve più, quindi quel caso non deve più bloccare l'invio. Verifica leggendo il file che togliendola non resti codice orfano.

L'evento loggato resta `bot_outcome_locked`, ma aggiungi `sentAs: 'NOTA'` nel payload.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run` — Expected: tutti verdi
Run: `./node_modules/.bin/tsc --noEmit` — Expected: nessun output

- [ ] **Step 7: Commit**

```bash
git add lib/bot-contract.ts lib/bot-contract.test.ts lib/bot-outcome-rules.ts lib/bot-outcome-rules.test.ts lib/bot-outcome.ts lib/bot-outcome.test.ts
git commit -m "feat(crm): il canale locked invia NOTA invece di un APPUNTAMENTO duplicato"
```

---

### Task 2: riaprire la guardia sugli esiti a appuntamento fissato

**Files:**
- Modify: `lib/fenice-autoreply.ts` (`canSendOutcome`)
- Test: `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Consumes: il ramo locked del Task 1, che ora produce `NOTA`.
- Produces: `canSendOutcome(g: { crmLeadId: string | null; botOutcome: string | null; aiStatus: string | null }): boolean` — false solo se manca `crmLeadId` o se `aiStatus === 'booked'`.

**Perché:** la guardia su `botOutcome === 'APPUNTAMENTO'` era stata aggiunta perché il ramo locked spediva un `APPUNTAMENTO` che il CRM duplicava. Ora quel ramo produce una `NOTA`, che per contratto non tocca lo stato del lead e anzi notifica le Conferme: bloccarla significherebbe rinunciare all'unico modo automatico di segnalare una disdetta.

- [ ] **Step 1: Write the failing test**

In `lib/fenice-autoreply.test.ts`, aggiorna la describe di `canSendOutcome`:

```typescript
  it('consente l esito su un appuntamento fissato: diventerà una NOTA, non un duplicato', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', botOutcome: 'APPUNTAMENTO', aiStatus: 'active' })).toBe(true);
  });

  it('continua a bloccare su booked, che è un problema diverso', () => {
    expect(canSendOutcome({ crmLeadId: 'crm1', botOutcome: null, aiStatus: 'booked' })).toBe(false);
  });
```

Aggiorna anche il test dal vivo su `drainMarioReplies` che oggi asserisce che `sendOutcome` NON venga chiamata su una conversazione con appuntamento fissato: ora deve essere chiamata, e l'evento `bot_outcome_suppressed` non deve più comparire in quello scenario.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: FAIL — la guardia blocca ancora su `botOutcome === 'APPUNTAMENTO'`.

- [ ] **Step 3: Rimuovi il blocco su APPUNTAMENTO**

In `lib/fenice-autoreply.ts`, `canSendOutcome` diventa:

```typescript
export function canSendOutcome(g: { crmLeadId: string | null; botOutcome: string | null; aiStatus: string | null }): boolean {
  if (!g.crmLeadId) return false;
  // 'booked' non è un veto sul CRM ma sul lucchetto: ai_status fa anche da lock del
  // drain, quindi una conv booked non viene mai claimata e qui non arriva. Resta per
  // sicurezza. Gli esiti su un appuntamento già fissato invece passano: sendOutcome li
  // traduce in NOTA, che il CRM registra senza toccare lo stato del lead.
  return g.aiStatus !== 'booked';
}
```

Il parametro `botOutcome` non serve più alla decisione: rimuovilo dalla firma e da tutti i call-site, oppure lascialo solo se serve al logging — decidi tu, ma non lasciare un parametro inutilizzato.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run` — Expected: tutti verdi
Run: `./node_modules/.bin/tsc --noEmit` — Expected: nessun output

- [ ] **Step 5: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(crm): gli esiti su appuntamento fissato tornano a passare, come NOTA"
```

---

### Task 3: il prompt sa che le disdette vanno comunicate

**Files:**
- Modify: `lib/mario-prompt.ts` (sezione "SE L'APPUNTAMENTO È GIÀ FISSATO")
- Test: `lib/mario-prompt.test.ts`

**Decisione presa con Bruno:** niente doppio passaggio. Il bot comunica la disdetta al CRM (che notifica subito le Conferme) e risponde al lead che una collega lo ricontatta. NON usa `[PASSAGGIO_UMANO]`, che lascerebbe la chat in un limbo oggi non presidiato.

- [ ] **Step 1: Write the failing test**

In `lib/mario-prompt.test.ts`:

```typescript
describe('disdette a appuntamento fissato', () => {
  const p = buildMarioSystem('Marta');

  it('chiede di registrare il motivo con le parole del lead invece di passare a un umano', () => {
    expect(p).toContain('con le parole del lead');
    expect(p).not.toContain('Se vuole spostare o disdire non gestirlo da solo');
  });

  it('rassicura il lead che qualcuno lo ricontatta', () => {
    expect(p).toContain('ti ricontatta una collega');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/mario-prompt.test.ts`
Expected: FAIL — il testo attuale dice ancora di usare `[PASSAGGIO_UMANO]`.

- [ ] **Step 3: Riscrivi la riga**

Nella sezione `SE L'APPUNTAMENTO È GIÀ FISSATO`, sostituisci la frase che oggi dice di passare a un collega con:

```
Se vuole spostare o disdire, non discutere e non riproporre orari: digli che ti dispiace, che ti segni tutto e che ti ricontatta una collega per sistemare, poi chiudi il messaggio con [ESITO:SCARTO|<motivo con le parole del lead>] se rinuncia, oppure [ESITO:RICHIAMO|<data ISO se te l'ha data, altrimenti la data dell'appuntamento>] se vuole solo spostare. L'appuntamento resta comunque fissato: il tuo esito diventa solo una nota per i colleghi.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run` — Expected: tutti verdi (attenzione ai test di parametricità persona e di lunghezza delle bolle)
Run: `./node_modules/.bin/tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "feat(conferme): le disdette diventano una nota al CRM, niente limbo"
```
