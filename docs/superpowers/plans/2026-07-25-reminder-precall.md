# Reminder pre-call — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mandare due promemoria (T−24h e T−3h) ai lead con appuntamento fissato, ciascuno con una richiesta di conferma esplicita, per alzare la quota di appuntamenti che arrivano davvero alla call.

**Architecture:** logica pura in `lib/precall-reminders.ts` (calcolo degli istanti target con clamp sulla fascia oraria, scelta del promemoria dovuto, etichetta leggibile dello slot), consumata da un cron orario `app/api/cron/precall-reminders/route.ts`. Invio **sempre via template UTILITY** — funziona fuori dalla finestra 24h, non consuma il budget MARKETING, e rende l'idempotenza derivabile dai `messages` senza nuove colonne DB.

**Tech Stack:** TypeScript, Next.js App Router (route handler + Vercel cron), Vitest, Supabase, Twilio Content API.

## Global Constraints

- Zero migrazioni DB: lo stato "promemoria già inviato" si deriva dalla presenza di un `messages.template_sid` uguale al SID del promemoria sulla stessa conversazione.
- Fascia oraria: nessun invio prima delle 08:30 né dopo le 20:30 Europe/Rome (stessa finestra della sequenza, `inSendWindow` in `lib/sequence.ts`).
- Kill-switch env `PRECALL_REMINDERS_ENABLED` (`'1'` = attivo). Se assente o diverso da `'1'`, il cron esce subito senza inviare.
- Il nome nella variabile `{{1}}` passa SEMPRE da `templateName()` di `lib/name.ts` (mai nome+cognome).
- APPUNTAMENTO è terminale: questo cron non deve MAI scrivere `bot_outcome`, `bot_scheduled_at` o `ai_status`. Solo invii e `event_log`.
- Mittente: lo stesso numero Fenice usato dai follow-up della sequenza (leggi `app/api/cron/sequence-touches/route.ts` e riusa la stessa env, non introdurne una nuova).

---

## File Structure

- `lib/precall-reminders.ts` — CREATE: logica pura, nessun accesso a env/DB.
- `lib/precall-reminders.test.ts` — CREATE: test della logica pura.
- `scripts/create-reminder-templates.mjs` — CREATE: crea i 2 template UTILITY via Content API e ne richiede l'approvazione.
- `app/api/cron/precall-reminders/route.ts` — CREATE: il cron.
- `vercel.json` — MODIFY: nuova voce cron oraria.
- `scripts/check-sequence-templates.mjs` — MODIFY: includere anche `fenice_reminder_*` nel check.

---

### Task 1: Logica pura dei promemoria

**Files:**
- Create: `lib/precall-reminders.ts`
- Test: `lib/precall-reminders.test.ts`

**Interfaces:**
- Consumes: le utility di fuso già presenti in `lib/rome-time.ts` e la finestra di invio di `lib/sequence.ts` (leggi `inSendWindow` prima di implementare il clamp e riusane l'approccio).
- Produces:
  - `type ReminderKind = 'r24' | 'r3'`
  - `reminderTargets(scheduledAtMs: number): { r24At: number; r3At: number }`
  - `dueReminder(scheduledAtMs: number, nowMs: number, sent: ReminderKind[]): ReminderKind | null`
  - `slotLabel(scheduledAtMs: number, nowMs: number): string`

- [ ] **Step 1: Write the failing test**

Crea `lib/precall-reminders.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { reminderTargets, dueReminder, slotLabel } from './precall-reminders';

const at = (iso: string) => new Date(iso).getTime();

describe('reminderTargets', () => {
  it('mette R24 a 24h prima e R3 a 3h prima quando cadono in fascia', () => {
    const appt = at('2026-08-03T15:00:00+02:00');
    const t = reminderTargets(appt);
    expect(t.r24At).toBe(at('2026-08-02T15:00:00+02:00'));
    expect(t.r3At).toBe(at('2026-08-03T12:00:00+02:00'));
  });

  it('clampa R3 alle 08:30 quando 3h prima sarebbe notte', () => {
    const appt = at('2026-08-03T09:00:00+02:00');
    const t = reminderTargets(appt);
    expect(t.r3At).toBe(at('2026-08-03T08:30:00+02:00'));
  });

  it('clampa anche R24 dentro la fascia', () => {
    const appt = at('2026-08-03T21:00:00+02:00');
    const t = reminderTargets(appt);
    expect(t.r24At).toBe(at('2026-08-02T20:30:00+02:00'));
  });
});

describe('dueReminder', () => {
  const appt = at('2026-08-03T15:00:00+02:00');

  it('prima dell istante di R24 non manda niente', () => {
    expect(dueReminder(appt, at('2026-08-02T14:00:00+02:00'), [])).toBeNull();
  });

  it('dopo l istante di R24 manda R24', () => {
    expect(dueReminder(appt, at('2026-08-02T15:30:00+02:00'), [])).toBe('r24');
  });

  it('non rimanda R24 se già inviato', () => {
    expect(dueReminder(appt, at('2026-08-02T16:00:00+02:00'), ['r24'])).toBeNull();
  });

  it('dopo l istante di R3 manda R3', () => {
    expect(dueReminder(appt, at('2026-08-03T12:30:00+02:00'), ['r24'])).toBe('r3');
  });

  it('se si arriva tardi salta R24 e manda solo R3', () => {
    expect(dueReminder(appt, at('2026-08-03T12:30:00+02:00'), [])).toBe('r3');
  });

  it('non manda niente negli ultimi 15 minuti né dopo l appuntamento', () => {
    expect(dueReminder(appt, at('2026-08-03T14:50:00+02:00'), ['r24'])).toBeNull();
    expect(dueReminder(appt, at('2026-08-03T16:00:00+02:00'), [])).toBeNull();
  });

  it('non manda niente se entrambi già inviati', () => {
    expect(dueReminder(appt, at('2026-08-03T13:00:00+02:00'), ['r24', 'r3'])).toBeNull();
  });
});

describe('slotLabel', () => {
  it('usa "oggi" quando l appuntamento è nello stesso giorno Rome', () => {
    expect(slotLabel(at('2026-08-03T15:00:00+02:00'), at('2026-08-03T09:00:00+02:00')))
      .toBe('oggi alle 15:00');
  });

  it('usa "domani" quando è il giorno dopo', () => {
    expect(slotLabel(at('2026-08-03T15:00:00+02:00'), at('2026-08-02T15:00:00+02:00')))
      .toBe('domani alle 15:00');
  });

  it('altrimenti usa il giorno della settimana', () => {
    expect(slotLabel(at('2026-08-03T15:00:00+02:00'), at('2026-08-01T09:00:00+02:00')))
      .toBe('lunedì alle 15:00');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/precall-reminders.test.ts`
Expected: FAIL con "Cannot find module './precall-reminders'".

- [ ] **Step 3: Implementa il modulo**

Crea `lib/precall-reminders.ts`. Prima leggi `lib/sequence.ts` (funzione `inSendWindow`) e `lib/rome-time.ts` per riusare lo stesso modo di ragionare sul fuso, poi implementa il minimo che fa passare i test:

- `reminderTargets`: `scheduledAt - 24h` e `scheduledAt - 3h`, ciascuno passato per un clamp interno che riporta l'istante alle 08:30 dello stesso giorno Rome se cade prima, e alle 20:30 se cade dopo.
- `dueReminder`: se `nowMs >= scheduledAtMs - 15min` → `null`; altrimenti restituisce `'r3'` se `now >= r3At` e `'r3'` non è in `sent`, altrimenti `'r24'` se `now >= r24At` e `'r24'` non è in `sent`, altrimenti `null`. L'ordine conta: R3 ha la precedenza, così un cron che parte tardi non manda un "ti ricordo domani" a due ore dalla call.
- `slotLabel`: confronta la data-giorno in Europe/Rome di `scheduledAtMs` e `nowMs`; 0 giorni → `oggi alle HH:MM`, 1 giorno → `domani alle HH:MM`, altrimenti nome del giorno in italiano minuscolo + ` alle HH:MM`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/precall-reminders.test.ts`
Expected: PASS (13 test).

- [ ] **Step 5: Commit**

```bash
git add lib/precall-reminders.ts lib/precall-reminders.test.ts
git commit -m "feat(reminder): logica pura promemoria pre-call con clamp in fascia"
```

---

### Task 2: Template UTILITY su Meta

**Files:**
- Create: `scripts/create-reminder-templates.mjs`
- Modify: `scripts/check-sequence-templates.mjs`

**Interfaces:**
- Consumes: le stesse env Twilio già usate da `scripts/create-marta-templates.mjs` (leggilo e copiane la struttura: creazione contenuto + richiesta approvazione).
- Produces: due Content SID da mettere in env come `REMINDER_24H_TEMPLATE_SID` e `REMINDER_3H_TEMPLATE_SID`.

- [ ] **Step 1: Scrivi lo script**

Copia la struttura di `scripts/create-marta-templates.mjs` cambiando solo l'elenco dei template e la **categoria, che qui deve essere `UTILITY` e non `MARKETING`**:

```javascript
const TEMPLATES = [
  {
    name: 'fenice_reminder_24h_v1',
    body: 'Ciao {{1}}, ti ricordo la videocall di {{2}}. Hai già visto il video che ti ho mandato? Fammi sapere qui, così arriviamo pronti.',
  },
  {
    name: 'fenice_reminder_3h_v1',
    body: 'Ciao {{1}}, ci sentiamo tra poco, {{2}}. Confermi che ci sei?',
  },
];
```

- [ ] **Step 2: Crea i template e richiedi l'approvazione**

Run: `node scripts/create-reminder-templates.mjs`
Expected: stampa due Content SID (`HX...`) e conferma dell'invio in approvazione.

- [ ] **Step 3: Estendi il check dei template**

In `scripts/check-sequence-templates.mjs`, aggiungi `fenice_reminder_` all'elenco dei prefissi controllati (accanto a `fenice_open_`).

Run: `node scripts/check-sequence-templates.mjs`
Expected: i due nuovi template compaiono nel report, inizialmente in stato pending.

- [ ] **Step 4: Commit**

```bash
git add scripts/create-reminder-templates.mjs scripts/check-sequence-templates.mjs
git commit -m "feat(reminder): template UTILITY 24h e 3h + check esteso"
```

---

### Task 3: Cron di invio

**Files:**
- Create: `app/api/cron/precall-reminders/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `dueReminder`, `reminderTargets`, `slotLabel` da `lib/precall-reminders.ts`; `templateName` da `lib/name.ts`; `sendTemplateAndLog` da `lib/messaging.ts`.
- Produces: endpoint `GET /api/cron/precall-reminders` autenticato con `CRON_SECRET`, che risponde `{ ok, sent, skipped }`.

- [ ] **Step 1: Scrivi la route**

Prima leggi `app/api/cron/send-video/route.ts` (autenticazione e stile) e `app/api/cron/sequence-touches/route.ts` (recupero conversazioni, invio, event_log). Poi implementa nell'ordine:

1. `authorized(req)` con `CRON_SECRET`, identico a `send-video`.
2. Se `process.env.PRECALL_REMINDERS_ENABLED !== '1'` → `return NextResponse.json({ ok: true, skipped: 'disabled' })`.
3. Se manca `REMINDER_24H_TEMPLATE_SID` o `REMINDER_3H_TEMPLATE_SID` → event_log `level: 'error'` e uscita.
4. Query: `conversations` con `bot_outcome = 'APPUNTAMENTO'`, `bot_scheduled_at` tra `now - 1h` e `now + 30h`, join `leads(phone_e164, first_name)`.
5. Per le conversazioni trovate, una sola query su `messages` con `template_sid in (sid24, sid3)` e `conversation_id in (...)` per costruire la mappa dei promemoria già inviati.
6. Per ciascuna: `dueReminder(scheduledAt, now, sent)`; se `null` → `skipped++` e continua.
7. Invio con `sendTemplateAndLog(supabase, conv.id, phone, sid, label, from, { '1': templateName(firstName), '2': slotLabel(scheduledAt, now) })`.
8. Un solo `event_log` di riepilogo a fine run (`type: 'precall_reminders'`), come fa `send-video`.

Vincolo: nessuna `update` su `conversations`.

- [ ] **Step 2: Verifica il typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: nessun output.

- [ ] **Step 3: Aggiungi il cron a vercel.json**

In `vercel.json`, dentro `crons`, aggiungi:

```json
    {
      "path": "/api/cron/precall-reminders",
      "schedule": "30 6-19 * * *"
    }
```

(orari UTC: copre 08:30–21:30 Rome d'estate, una passata all'ora.)

- [ ] **Step 4: Prova a secco in locale**

Run: `npx next dev` in un terminale, poi in un altro:
`curl -s "http://localhost:3000/api/cron/precall-reminders?secret=$CRON_SECRET"`
Expected: `{"ok":true,"skipped":"disabled"}` finché `PRECALL_REMINDERS_ENABLED` non è `'1'`.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: tutti verdi.

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/precall-reminders/route.ts vercel.json
git commit -m "feat(reminder): cron promemoria pre-call T-24h e T-3h"
```

---

### Task 4: Attivazione

**Files:**
- Nessuna modifica al codice.

- [ ] **Step 1: Verifica l'approvazione Meta**

Run: `node scripts/check-sequence-templates.mjs`
Expected: `fenice_reminder_24h_v1` e `fenice_reminder_3h_v1` in stato approvato. Se ancora pending, fermati qui e riprendi più tardi.

- [ ] **Step 2: Configura le env di produzione**

Imposta su Vercel (production): `REMINDER_24H_TEMPLATE_SID`, `REMINDER_3H_TEMPLATE_SID`, `PRECALL_REMINDERS_ENABLED=0`. Poi redeploy.

- [ ] **Step 3: Verifica a flag spento**

Attendi un giro di cron e controlla che l'endpoint risponda `skipped: 'disabled'` e che non risultino invii.

- [ ] **Step 4: Accendi e sorveglia il primo giro**

Porta `PRECALL_REMINDERS_ENABLED=1` e redeploy. Dopo il primo appuntamento in finestra, verifica in `event_log` il record `precall_reminders` e in `messages` che sia partito un solo promemoria per tipo e per conversazione.

- [ ] **Step 5: Rollback disponibile**

Se qualcosa non va: `PRECALL_REMINDERS_ENABLED=0` + redeploy (30 secondi). Nessuno stato da ripulire, perché il cron non scrive su `conversations`.
