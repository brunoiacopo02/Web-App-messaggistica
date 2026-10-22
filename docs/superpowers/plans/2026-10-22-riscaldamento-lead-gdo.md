# Recap, riscaldamento e promemoria per i lead GDO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** il lead fissato dal GDO riceve un recap chiaro (data, Noemi, video), due domande di riscaldamento se risponde, e il promemoria del giorno prima. Tutto dietro interruttori spenti.

**Architecture:** la logica di decisione e i testi stanno in moduli puri in `lib/` (testati). Gli effetti stanno in tre punti già esistenti: il drain `lib/fenice-autoreply.ts` (ramo postino), la route `app/api/appointment-set` (con `after()`) e il cron `precall-reminders`. Il riscaldamento è una nota di contesto, come `NOTA_NOEMI`, e avanza con un tag tecnico `[RISCALDAMENTO:n]`.

**Tech Stack:** Next 16.2 (App Router, `proxy.ts`, `after` da `next/server`), TypeScript, Supabase JS (niente Drizzle), Twilio, Vitest (`bun run test`), bun.

**Spec:** `docs/superpowers/specs/2026-10-22-riscaldamento-lead-gdo-design.md`

## Global Constraints

- Prima di scrivere codice Next: leggere `node_modules/next/dist/docs/` per `after` (regola del repo, AGENTS.md).
- Interruttori: `GDO_RECAP_ENABLED`, `GDO_WARMUP_ENABLED`, `GDO_PRECALL_24H_ENABLED`, `GDO_REMINDER_24H_TEMPLATE_SID`. Spento = qualsiasi valore diverso da `'1'`. Al deploy restano spenti.
- Perimetro: solo chat con `gdo_agenda_at` valorizzato e `bot_outcome` diverso da `'APPUNTAMENTO'`.
- Veti per ogni invio: `ai_paused_at` non null, `cancel_requested_at` non null, call già passata.
- Recap e promemoria sono testi del codice, non del modello. Recap = **una sola bolla** (le righe stanno dentro la stessa stringa con `\n`, mai passate a `splitMarioMessages`).
- Mittente sempre `mittenteDiConversazione(conv)`; ogni invio scrive la riga in `messages` (`direction:'out'`, `sender:'bot'`).
- Il bot non esita mai il lead GDO: per il CRM esiste solo `[NOTA|...]` (canale `inviaNotaAlCrm` già vivo).
- Domanda 2 del riscaldamento: cifra "da 1.000 a 3.000 euro, si può rateizzare", mai cifre di rata.
- Migration **prima** del deploy (`mcp__supabase-bot__apply_migration`), poi `bun run supabase:gen-types`.
- `.test.ts` accanto al modulo. Commenti in italiano, nello stile dei moduli vicini.

## Review Focus

1. Recap partito due volte per la stessa data (turno video e `appointment-set` quasi insieme) → il claim condizionale su `gdo_recap_for_at` deve farne partire uno solo. Test in Task 3 (`claimRecap`).
2. Spostamento a una data identica allo stesso istante in un altro fuso (`+02:00` vs `Z`) → nessun recap. Test in Task 2 (`decideGdoRecap` con `sameInstant`).
3. Call fra meno di 1 ora o già passata quando arriva la data → niente recap e niente promemoria. Test in Task 2 e Task 6.
4. Lead che scrive "voglio disdire" a metà riscaldamento → vincono le regole di disdetta, e il passo non avanza senza tag. Test in Task 5 (`avanzaRiscaldamento` senza tag → stesso passo).
5. Promemoria su una call delle 10 inviato la mattina stessa (cron in ritardo) → `{{3}}` non deve dire "oggi pomeriggio" per una Noemi già passata: se il pomeriggio del giorno prima è passato, il promemoria non parte. Test in Task 6.

---

### Task 1: Migration e tipi

**Files:**
- Create: `supabase/migrations/20261022000001_gdo_recap_riscaldamento.sql`
- Modify: `lib/supabase/types.ts` (rigenerato)

- [ ] **Step 1: Scrivere la migration**

```sql
alter table conversations
  add column if not exists gdo_recap_for_at timestamptz,
  add column if not exists gdo_recap_sent_at timestamptz,
  add column if not exists gdo_warmup_step smallint,
  add column if not exists gdo_warmup_closed_at timestamptz;
comment on column conversations.gdo_recap_for_at is 'Data della call a cui si riferisce l''ultimo recap mandato al lead GDO';
comment on column conversations.gdo_warmup_step is 'Riscaldamento lead GDO: null mai aperto, 1 fatta domanda 1, 2 fatta domanda 2, 3 chiuso';
```

- [ ] **Step 2: Applicarla al DB del bot** con `mcp__supabase-bot__apply_migration` (nome `gdo_recap_riscaldamento`). Verifica: `select column_name from information_schema.columns where table_name='conversations' and column_name like 'gdo_recap%' or column_name like 'gdo_warmup%'` → 4 righe.
- [ ] **Step 3: Rigenerare i tipi** `bun run supabase:gen-types`. Se lo script non arriva al DB, aggiungere a mano le 4 colonne nei tre blocchi Row/Insert/Update di `conversations`. Verifica: `bun run typecheck` pulito.
- [ ] **Step 4: Commit** `feat(gdo): colonne per recap e riscaldamento dei lead GDO`

### Task 2: Testi e decisione del recap (puro)

**Files:**
- Modify: `lib/rome-time.ts` (aggiungere `giornoRoma`, `oraRoma`)
- Modify: `lib/gdo-context-note.ts` (usare gli helper di `rome-time`, togliere le copie locali `giornoRoma`/`formatOra`)
- Create: `lib/gdo-recap.ts`, `lib/gdo-recap.test.ts`

**Interfaces:**
- Produces:
  - `giornoRoma(d: Date): string` → `"venerdì 23"`; `oraRoma(d: Date): string` → `"10:00"`
  - `quandoNoemi(call: Date): string`: call con ora di Roma < 15 → `"<giornoRoma(call−24h)> nel pomeriggio"`; altrimenti → `"<giornoRoma(call)>, qualche ora prima"`
  - `gdoRecapText(i: { nome: string | null; call: Date; videoLink: string | null }): string`
  - `gdoSpostamentoText(i: { nome: string | null; call: Date }): string`
  - `type RecapTipo = 'completo' | 'senza-video' | 'spostamento'`
  - `type RecapOccasione = 'turno-video' | 'registrato' | 'spostato'`
  - `decideGdoRecap(i: RecapInput): RecapTipo | null`, con `RecapInput = { enabled: boolean; occasione: RecapOccasione; gdoAgendaAt: string | null; botOutcome: string | null; appuntamentoAt: string | null; recapForAt: string | null; videoSentAt: string | null; lastInboundAtMs: number | null; aiPausedAt: string | null; cancelRequestedAt: string | null; nowMs: number }`

- [ ] **Step 1: Test che falliscono** in `lib/gdo-recap.test.ts`:

```ts
const call = new Date('2026-10-23T10:00:00+02:00'); // venerdì
it('quandoNoemi: call di mattina → pomeriggio del giorno prima', () =>
  expect(quandoNoemi(call)).toBe('giovedì 22 nel pomeriggio'));
it('quandoNoemi: call dalle 15 → stesso giorno', () =>
  expect(quandoNoemi(new Date('2026-10-23T18:00:00+02:00'))).toBe('venerdì 23, qualche ora prima'));
it('recap completo: una bolla con data, Noemi, video e FATTO', () => {
  const t = gdoRecapText({ nome: 'Luca Rossi', call, videoLink: 'https://corso.feniceacademy.it/conferenza-bx' });
  expect(t).toContain('Ciao Luca');
  expect(t).toContain('*venerdì 23 alle 10:00*');
  expect(t).toContain('*Ti chiama Noemi, una nostra collega, giovedì 22 nel pomeriggio*');
  expect(t).toContain('se non rispondi la videochiamata non è confermata');
  expect(t).toContain('👉 https://corso.feniceacademy.it/conferenza-bx');
  expect(t).toContain('scrivimi FATTO');
});
it('recap senza video: rimanda al video qui sopra, nessun link', () => {
  const t = gdoRecapText({ nome: null, call, videoLink: null });
  expect(t).toContain('qui sopra');
  expect(t).not.toContain('https://');
});
it('spostamento: data nuova, niente Noemi, niente video', () => {
  const t = gdoSpostamentoText({ nome: 'Ada', call });
  expect(t).toContain('*venerdì 23 alle 10:00*');
  expect(t).not.toMatch(/Noemi|https:/);
});
```

E la tabella di `decideGdoRecap`, partendo da un input base valido (`enabled:true`, agenda valorizzata, `botOutcome:null`, call fra 30h, `lastInboundAtMs` = 1h fa, video non mandato, nessun recap):
- `turno-video` → `'completo'`
- `registrato` con video mandato → `'senza-video'`; senza video → `null` (il recap esce col video)
- `spostato` con `recapForAt` valorizzato → `'spostamento'`; senza recap ma col video → `'senza-video'`
- `null` se: `enabled:false`; `gdoAgendaAt:null`; `botOutcome:'APPUNTAMENTO'`; `appuntamentoAt:null`; call fra 59 minuti; call passata; `aiPausedAt` valorizzato; `cancelRequestedAt` valorizzato; `lastInboundAtMs` null o di 25h fa (finestra chiusa)
- `null` se `recapForAt` è lo stesso istante di `appuntamentoAt` scritto in un altro fuso (`'2026-10-23T08:00:00Z'` contro `'2026-10-23T10:00:00+02:00'`)

- [ ] **Step 2: Lanciare** `bun run test lib/gdo-recap.test.ts`. Atteso: FAIL (modulo inesistente).
- [ ] **Step 3: Implementare.** Il nome lo dà `firstNameOf` di `lib/name.ts`. Il confronto fra istanti lo fa `sameInstant` di `lib/rome-time.ts`. Testo esatto del recap (copy fissata dalla spec, righe unite con `\n`):

```
Ciao {nome}, ti riassumo tutto 👇            (senza nome: "Ciao, ti riassumo tutto 👇")
La tua videochiamata è *{giornoRoma} alle {oraRoma}*. A quell'ora devi essere libero.
*Ti chiama Noemi, una nostra collega, {quandoNoemi}* da un numero di cellulare. Sono 5-10 minuti: rispondi, perché se non rispondi la videochiamata non è confermata.
*Prima della videochiamata guarda questo video*, dura 20 minuti 👉 {link}
Quando l'hai visto scrivimi FATTO qui
```
Senza video, le ultime due righe diventano: `Il video te l'ho mandato qui sopra: guardalo prima della videochiamata e poi scrivimi FATTO qui`.
Spostamento: `Ciao {nome}, la tua videochiamata ora è *{giornoRoma} alle {oraRoma}*. A quell'ora devi essere libero.`

In `gdo-context-note.ts`, `quandoChiamaNoemi` passa a usare `giornoRoma`/`oraRoma` di `rome-time`; le frasi già testate non cambiano.
- [ ] **Step 4:** `bun run test lib/gdo-recap.test.ts lib/gdo-context-note.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(gdo): testi e regole del recap per i lead GDO`

### Task 3: Recap nel turno del video (drain)

**Files:**
- Create: `lib/gdo-recap-send.ts`, `lib/gdo-recap-send.test.ts`
- Modify: `lib/fenice-autoreply.ts` (select riga ~412, `inviaVideoGdo` ~785, ramo `videoInsiemeAllaRisposta` ~999, nota di contesto ~896/969)
- Modify: `lib/gdo-context-note.ts` (nuovo campo `recapInUscita?: boolean` in `GdoNoteInput`)

**Interfaces:**
- Consumes: Task 2.
- Produces:
  - `claimRecap(supabase, conversationId: number, appuntamentoAt: string, conNoemi: boolean): Promise<boolean>`: update condizionale `gdo_recap_for_at = appuntamentoAt, gdo_recap_sent_at = now` (con `conNoemi` anche `gdo_noemi_reminded_at = now` se null) **solo se** `gdo_recap_for_at` è null o diverso; torna `true` se ha aggiornato una riga (`.select('id')`). Il filtro per istante si fa con `.or('gdo_recap_for_at.is.null,gdo_recap_for_at.neq.<appuntamentoAt in ISO UTC>')`, normalizzando prima con `new Date(x).toISOString()`.
  - `GdoNoteInput.recapInUscita`: se vero, `serveNoemi` torna `false` (Noemi la porta il recap).

- [ ] **Step 1: Test che falliscono.**
  - `gdo-recap-send.test.ts`, con un finto supabase (sul modello dei finti esistenti, es. `lib/call-attempt.test.ts`): `claimRecap` torna `true` alla prima chiamata e `false` alla seconda con la stessa data espressa in un altro fuso.
  - `gdo-context-note.test.ts`: con `recapInUscita: true` e `videoAppenaConfermato: true`, la nota non contiene `PROMEMORIA NOEMI`.
- [ ] **Step 2:** `bun run test lib/gdo-recap-send.test.ts lib/gdo-context-note.test.ts` → FAIL.
- [ ] **Step 3: Implementare** `claimRecap` e `recapInUscita`.
- [ ] **Step 4: Agganciare al drain.**
  - Aggiungere al select `ai_paused_at, cancel_requested_at, gdo_recap_for_at, gdo_warmup_step` (+ tipo locale `gdo`).
  - Calcolare `recapTipo = decideGdoRecap({ enabled: process.env.GDO_RECAP_ENABLED === '1', occasione: 'turno-video', … })` **prima** di `videoDaSolo`. Come `lastInboundAtMs` usare l'ora del messaggio del lead di questo turno.
  - In `inviaVideoGdo` e nel ramo `videoInsiemeAllaRisposta`: se `recapTipo === 'completo'` e `await claimRecap(..., true)`, la bolla è `gdoRecapText({ nome, call: new Date(gdoAppuntamentoAt), videoLink: gdoVideoUrl })` al posto di `gdoVideoText(...)`, e `gdoNoemiRemindedAt` si aggiorna in memoria. Altrimenti si manda il `gdoVideoText` di oggi. Evento `gdo_recap_sent` (`payload: { conversationId, tipo, occasione: 'turno-video' }`).
  - Passare `recapInUscita: recapTipo === 'completo'` alle due chiamate di `gdoContextNote`.
- [ ] **Step 5: Test del drain** in `lib/fenice-autoreply.test.ts` (estendere i casi postino esistenti; cercare `videoInsiemeAllaRisposta`/`gdo_video_sent`):
  - con `GDO_RECAP_ENABLED='1'` e `gdo_appuntamento_at` valorizzato, la bolla del video contiene `ti riassumo tutto` e `*Ti chiama Noemi`;
  - con l'interruttore spento, la bolla è quella di `gdoVideoText`;
  - senza data, la bolla è quella di `gdoVideoText`.
- [ ] **Step 6:** `bun run test` intero + `bun run typecheck` → verdi.
- [ ] **Step 7: Commit** `feat(gdo): il recap prende il posto della bolla del video quando la data è nota`

### Task 4: Recap quando la data arriva dopo il video

**Files:**
- Modify: `lib/gdo-recap-send.ts` (+ test)
- Modify: `app/api/appointment-set/route.ts` (+ `route.test.ts`)

**Interfaces:**
- Consumes: Task 2, `claimRecap` (Task 3), `AppointmentSetResult` (`esito`, `conversationId`).
- Produces: `inviaRecapDopoData(supabase, conversationId: number, occasione: 'registrato' | 'spostato', nowMs?: number): Promise<RecapTipo | null>`. Carica la chat (campi gdo, `bot_outcome`, `ai_paused_at`, `cancel_requested_at`, `wa_number`, `leads(phone_e164, first_name)`) e l'ultimo inbound, poi decide con `decideGdoRecap`. Se c'è un tipo e `claimRecap` riesce, manda con `sendFreeText({ to, body, from: mittenteDiConversazione(conv) })`, scrive in `messages` e registra l'evento `gdo_recap_sent`. Per `'spostamento'`: testo `gdoSpostamentoText`, `claimRecap(..., false)`. Per `'senza-video'`: `gdoRecapText` con `videoLink: null`, `claimRecap(..., true)`. Non lancia mai: gli errori vanno in `event_log` con tipo `gdo_recap_errore`.

- [ ] **Step 1: Test che falliscono** (finto supabase + `sendFreeText` mockato con `vi.mock('./twilio')`):
  - `registrato` con video già mandato e finestra aperta → un invio, testo con `qui sopra`, torna `'senza-video'`
  - `spostato` con recap precedente → testo di spostamento, `gdo_noemi_reminded_at` non toccato
  - interruttore spento → nessun invio, `null`
  - `sendFreeText` che lancia → nessuna eccezione, riga `gdo_recap_errore`
  - In `route.test.ts`: dopo una risposta `registrato` viene chiamata la funzione differita (mock di `after` da `next/server` che esegue subito la callback), e la risposta al CRM resta quella di `runAppointmentSet`.
- [ ] **Step 2:** i test indicati → FAIL.
- [ ] **Step 3: Implementare.** Nella route: `const res = await runAppointmentSet(...)`. Se `res.conversationId` è valorizzato e `res.esito` è `'registrato'` o `'spostato'`, chiamare `after(() => inviaRecapDopoData(supabase, res.conversationId!, res.esito))`. Poi `return NextResponse.json(res)`.
- [ ] **Step 4:** `bun run test` + `bun run typecheck` → verdi.
- [ ] **Step 5: Commit** `feat(gdo): recap al lead quando il CRM manda la data della call`

### Task 5: Riscaldamento

**Files:**
- Create: `lib/gdo-warmup.ts`, `lib/gdo-warmup.test.ts`
- Modify: `lib/mario.ts` (tag `[RISCALDAMENTO:n]`) + `lib/mario-parse.test.ts`
- Modify: `lib/gdo-context-note.ts` (campo `notaRiscaldamento?: string | null`, accodato alle altre parti)
- Modify: `lib/fenice-autoreply.ts` (calcolo della nota, avanzamento del passo dopo la risposta)

**Interfaces:**
- Produces:
  - `MarioResult.riscaldamento?: 0 | 1 | 2 | 3`: regex globale `/\[RISCALDAMENTO:([0-3])\]/gi`, si prende l'ultimo valore e si toglie dal testo visibile.
  - `notaRiscaldamento(i: { enabled: boolean; step: number | null; recapForAt: string | null; recapInQuestoTurno: boolean; appuntamentoAt: string | null; serveNoemi: boolean; nowMs: number }): string | null`. Torna null se: spento; `step` ≥ 3; nessun recap mandato (`recapForAt` null); recap partito in questo turno; `serveNoemi`; call non valida o fra meno di 3h. Altrimenti torna il testo del passo (`step` null → passo 1, 1 → passo 2, 2 → chiusura).
  - `avanzaRiscaldamento(step: number | null, tag: 0 | 1 | 2 | 3 | undefined): { step: number | null; chiuso: boolean }`. Il tag atteso è `(step ?? 0) + 1`, e solo quello fa avanzare. `0` chiude senza nota (`step: 3, chiuso: true`). Un tag assente o diverso lascia il passo dov'è.
- Testi delle note (copy della spec):
  - **Passo 1**: `RISCALDAMENTO, PASSO 1: prima rispondi a quello che il lead ha scritto. Poi, una volta sola, digli "per preparare bene la tua videochiamata di {giornoRoma(call)} ti faccio 2 domande veloci" e fagli la prima: cosa vuole ottenere, e perché proprio adesso. Una domanda sola, frasi semplici. Se nella chat ti ha già detto cosa vuole e perché, salta questa domanda e fai direttamente la seconda (vedi passo 2) mettendo [RISCALDAMENTO:2] invece di [RISCALDAMENTO:1]. In coda al messaggio metti [RISCALDAMENTO:1]. Se il lead sta disdicendo, spostando o chiede altro, segui le regole della chat e NON fare la domanda né mettere il tag.`
  - **Passo 2**: `RISCALDAMENTO, PASSO 2: il lead ha risposto alla prima domanda. Ringrazia in tre parole e fai la seconda: "nel video vedi che il percorso va da 1.000 a 3.000 euro, si può rateizzare. Alla videochiamata ci sei tu da solo o decidi insieme a qualcuno?". Mai cifre di rata. In coda metti [RISCALDAMENTO:2]. Se il messaggio del lead non c'entra niente per la seconda volta di fila, lascia perdere e metti [RISCALDAMENTO:0].`
  - **Chiusura**: `RISCALDAMENTO, CHIUSURA: il lead ha risposto anche alla seconda domanda. Ringrazia in una riga e ricordagli in una riga la videochiamata di {giornoRoma(call)} alle {oraRoma(call)}. In coda metti [NOTA|Riscaldamento prima della call: obiettivo "<sue parole>"; prezzo e chi decide "<sue parole>"] e [RISCALDAMENTO:3]. Se ti ha detto che non ha soldi, che non ricorda di aver fissato o che non gli interessa, la nota comincia con "⚠️ Da verificare: ". Non dargli nessun esito e non scartarlo.`

- [ ] **Step 1: Test che falliscono.**
  - `parseMarioReply('ok ci sentiamo [RISCALDAMENTO:2]')` → `riscaldamento: 2`, il testo visibile non contiene `RISCALDAMENTO`.
  - `notaRiscaldamento`, la tabella dei null: spento, `step` 3, senza recap, recap partito in questo turno, `serveNoemi`, call fra 2h. E i tre passi: `step` null contiene `PASSO 1` e il giorno della call, 1 → `PASSO 2` e `1.000 a 3.000`, 2 → `CHIUSURA` e `⚠️ Da verificare`.
  - `avanzaRiscaldamento(null, 1)` → `{step:1, chiuso:false}`; `(null, 2)` → `{step:2, chiuso:false}` (domanda 1 saltata); `(1, undefined)` → `{step:1, chiuso:false}`; `(1, 0)` → `{step:3, chiuso:true}`; `(2, 3)` → `{step:3, chiuso:true}`; `(1, 3)` → `{step:1, chiuso:false}`.
  - Nota: `(null, 2)` è il salto ammesso dalla nota del passo 1, quindi da `null` sono validi sia 1 che 2.
- [ ] **Step 2:** i test indicati → FAIL.
- [ ] **Step 3: Implementare** i moduli.
- [ ] **Step 4: Agganciare al drain** (solo `postino`):
  - calcolare `notaRiscaldamento({ enabled: process.env.GDO_WARMUP_ENABLED === '1', step: gdo.gdo_warmup_step, recapForAt, recapInQuestoTurno: recapTipo === 'completo', appuntamentoAt: gdoAppuntamentoAt, serveNoemi: serveNoemi(noteInput), nowMs })` e passarla come `notaRiscaldamento` a `gdoContextNote`;
  - dopo l'invio, se la nota era presente, calcolare `avanzaRiscaldamento(step, result.riscaldamento)`. Se il passo cambia, aggiornare `gdo_warmup_step` (e `gdo_warmup_closed_at` se chiuso) e registrare l'evento `gdo_warmup_step` (`{ conversationId, da, a }`);
  - la NOTA esce già dal canale `result.notaCrm` → `inviaNotaAlCrm` esistente: niente codice nuovo per il CRM.
- [ ] **Step 5: Test del drain**: con l'interruttore acceso, `gdo_recap_for_at` valorizzato e `step` null, la nota passata al modello contiene `RISCALDAMENTO, PASSO 1`; una risposta finta con `[RISCALDAMENTO:1]` porta il passo a 1; con l'interruttore spento la nota non c'è.
- [ ] **Step 6:** `bun run test` + `bun run typecheck` → verdi.
- [ ] **Step 7: Commit** `feat(gdo): due domande di riscaldamento prima della call, risposte in nota al CRM`

### Task 6: Promemoria del giorno prima per i lead GDO

**Files:**
- Modify: `lib/precall-reminders.ts` (+ test)
- Modify: `app/api/cron/precall-reminders/route.ts` (+ test, se esiste)
- Modify: `lib/gdo-video-followup.ts` (+ test) e `app/api/cron/gdo-video-followups/route.ts`

**Interfaces:**
- Consumes: `reminderTargets`, `quandoNoemi`/`giornoRoma`/`oraRoma` (Task 2).
- Produces:
  - `decideGdoReminder24(i: { enabled: boolean; gdoAgendaAt: string | null; botOutcome: string | null; appuntamentoAt: string | null; videoSentAt: string | null; recapSentAt: string | null; lastInboundAtMs: number | null; aiPausedAt: string | null; cancelRequestedAt: string | null; giaInviato: boolean; nowMs: number }): 'template' | 'testo' | null`
  - `gdoReminderVars(i: { nome: string | null; call: Date; nowMs: number }): { '1': string; '2': string; '3': string }`, con `'1'` = `templateName(nome)`, `'2'` = `"venerdì 23 ottobre alle 10:00"` (giorno, numero, mese, ora di Roma), `'3'` = `noemiRelativo`
  - `gdoReminderText(vars): string`: stesso testo del template con le variabili sostituite
  - `GdoFollowupInput.promemoriaGdoAttivo: boolean`

- [ ] **Step 1: Test che falliscono.**

`decideGdoReminder24`, sulla base di: call fra 20h, agenda 30h fa, video mandato, niente recap, ultimo inbound 3 giorni fa, interruttore acceso.
- base → `'template'`; ultimo inbound 10h fa → `'testo'`; ultimo inbound 2h fa → `null`
- `null` se: spento; `botOutcome:'APPUNTAMENTO'`; video non mandato; agenda 8h fa; recap 5h fa; `giaInviato`; `aiPausedAt`; `cancelRequestedAt`; call fra 10 minuti; ancora prima di `r24At` (call fra 40h)
- call alle 10:00 e adesso alle 08:40 dello stesso giorno (pomeriggio di Noemi già passato) → `null`

`gdoReminderVars` con call venerdì 23/10 alle 10:00:
- adesso giovedì 22 alle 10:00 → `'3'` = `'oggi pomeriggio'`, `'2'` = `'venerdì 23 ottobre alle 10:00'`
- call venerdì alle 18:00, adesso giovedì 18:00 → `'3'` = `'domani, qualche ora prima'`

`decideGdoVideoFollowup` con `slot:'mattina'`, `promemoriaGdoAttivo:true` e data valida → `'none'`; con `promemoriaGdoAttivo:false` → comportamento di oggi (i test esistenti passano `false`).

- [ ] **Step 2:** i test indicati → FAIL.
- [ ] **Step 3: Implementare.**
  - `noemiRelativo`: il giorno di Noemi (giorno prima se la call è prima delle 15, altrimenti lo stesso giorno) confrontato con oggi a Roma (`romeDayKey`):
    - stesso giorno → `"oggi pomeriggio"` oppure `"oggi, qualche ora prima"`;
    - giorno dopo → `"domani pomeriggio"` oppure `"domani, qualche ora prima"`;
    - altrimenti `"<giornoRoma> pomeriggio"`.
  - La regola "pomeriggio di Noemi già passato": call prima delle 15 e giorno di Noemi < oggi → `null`.
  - Testo del template e del testo libero (`gdoReminderText`): `Ciao {{1}}, ti ricordo la tua videochiamata con Fenice Academy: {{2}}. Prima ti chiama Noemi, una collega, {{3}} da un numero di cellulare: rispondi, serve a confermare la videochiamata. Se non l'hai ancora fatto, guarda il video che ti ho mandato qui.`
- [ ] **Step 4: Cron.** In `precall-reminders/route.ts`, dopo il ramo del bot, aggiungere un secondo ramo sotto `process.env.GDO_PRECALL_24H_ENABLED === '1'`:
  - selezione: `gdo_agenda_at` non null, `bot_outcome` diverso da `APPUNTAMENTO` o null, `gdo_appuntamento_at` nella stessa finestra `[now−1h, now+30h]`, `ai_paused_at` null, `cancel_requested_at` null, `FILTRO_FUORI_LANCIO`;
  - già inviato = esiste un evento `gdo_reminder24_sent` con `payload->>conversationId` uguale e `payload->>appuntamentoAt` uguale alla data corrente normalizzata ISO UTC (uno spostamento riapre il promemoria);
  - ultimo inbound: una query `messages` `direction='in'` per conversazione;
  - `'template'` → `sendTemplateAndLog(supabase, id, phone, sidGdo, 'Promemoria T-24h GDO', mittenteDiConversazione(c), gdoReminderVars(...))`. Senza SID: evento `precall_reminders_config_error` e ramo saltato;
  - `'testo'` → `sendFreeText` + riga in `messages`;
  - in entrambi i casi, evento `gdo_reminder24_sent` (`{ conversationId, appuntamentoAt, canale }`) solo se l'invio è riuscito.
- [ ] **Step 5: Slot mattina.** In `gdo-video-followups/route.ts` passare `promemoriaGdoAttivo: process.env.GDO_PRECALL_24H_ENABLED === '1' && !!process.env.GDO_REMINDER_24H_TEMPLATE_SID`. In `decideGdoVideoFollowup`, subito dopo il controllo "call già passata": `if (i.slot === 'mattina' && i.promemoriaGdoAttivo && hasValidAppointment) return 'none';`.
- [ ] **Step 6:** `bun run test` + `bun run typecheck` + `bun run build` → verdi.
- [ ] **Step 7: Commit** `feat(gdo): promemoria del giorno prima con Noemi anche ai lead GDO`

### Task 7: Template su Twilio, rilascio spento, istruzioni d'accensione

**Files:**
- Create: `scripts/crea-template-reminder-gdo.ts`
- Modify: `docs/superpowers/specs/2026-10-22-riscaldamento-lead-gdo-design.md` (sezione finale "Stato")

- [ ] **Step 1: Script.** Usa le credenziali Twilio di `.env.local` per ogni account che manda agende GDO (gli account e i numeri stanno in `lib/mittente.ts`/`lib/template-account.ts`). Crea `fenice_reminder_24h_gdo_v1` (Content API, `twilio/text`, lingua `it`, variabili d'esempio `{'1':'Luca','2':'venerdì 23 ottobre alle 10:00','3':'oggi pomeriggio'}`). Poi chiede l'approvazione WhatsApp in categoria `UTILITY` (`POST /v1/Content/{sid}/ApprovalRequests/whatsapp` con `{ name, category: 'UTILITY' }`). Stampa i SID e lo stato. È idempotente: se il nome esiste già, non lo ricrea.
- [ ] **Step 2: Lanciarlo** (`bun scripts/crea-template-reminder-gdo.ts`). Verifica: `GET /v1/Content/{sid}/ApprovalRequests` → `status` `received` o `pending`.
- [ ] **Step 3: Rilascio.** `git fetch origin && git rebase origin/main`, `bun run test`, `bun run build`, `git push origin HEAD:main`. Poi `git rev-list --count origin/main..HEAD` → `0`, e controllo dello stato Vercel dal commit su GitHub → `success`. Gli interruttori restano spenti: nessuna env viene toccata.
- [ ] **Step 4: Stato nella spec.** Aggiungere la sezione "Stato al rilascio": commit, SID del template per account, stato dell'approvazione Meta, i comandi esatti per accendere (variabili da mettere su Vercel production + redeploy), e che il riscaldamento si accende solo col recap acceso.
- [ ] **Step 5: Commit** `docs(gdo): stato del rilascio e come accendere recap, riscaldamento e promemoria`
