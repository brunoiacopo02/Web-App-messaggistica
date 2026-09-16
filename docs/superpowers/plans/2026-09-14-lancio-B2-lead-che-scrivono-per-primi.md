# Lancio Web Dev AI — Blocco B2: lead che scrivono per primi (Telegram + pulsante webinar) — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accendere in produzione il bot che prende in carico chi scrive per primo sul numero Fenice, distinguendo tre casi che non devono mai confondersi — link del canale Telegram (`TELEGRAM`, flusso Mario standard), pulsante WhatsApp del webinar (`Lancio Web Dev AI`, conversazione in `lancio_fase='post_pitch'`), qualunque altro primo messaggio (`INBOUND`, Mario standard) — e far creare al CRM il lead lancio nel bucket `LANCIO_WEBDEV_2026` quando la provenienza è quella del pulsante.

**Architecture:** Nel repo del bot si integra il branch `feat/lead-scrivono-per-primi` (25 commit: adozione inbound, `funnelDaPrimoMessaggio`, push `lead-entrante`, cron `adotta-mai-risposti`) **con un merge di `main` nel branch** (5 file in conflitto, tutti hunk additivi: si tengono entrambi i lati), poi si aggiunge un modulo puro `lib/primo-messaggio.ts` con i tre esiti, `lib/lancio-fase.ts` con `setLancioFase`, e l'aggancio nel webhook Twilio: il marker del pulsante scatta sull'inbound **corrente** (anche su chat già di Mario), l'adozione classifica il **primo** inbound. Nel CRM `adottaLead` (già condiviso da push e lista) cresce di un ramo: provenienza lancio → lead con funnel/bucket/`lancioIngresso` del lancio, assegnato al bot, evento `LANCIO_INTAKE`, nessun intake verso il bot (già così). Le decisioni stanno in funzioni pure testate; le rotte e le scritture restano sottili.

**Tech Stack:** Bot: Next.js 16 (App Router, `after()` di `next/server`), Supabase (`supabase-js` tipizzato da `lib/supabase/types.ts`), Twilio, Vitest (`bun test`), `bun run typecheck`. CRM: Next.js 16, Drizzle ORM su Supabase Postgres (migrazioni SQL a mano in `drizzle/migrations/`), `node --test` via `npm test` (lista esplicita di file in `package.json`), `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md` (stessa copia in entrambi i repo) — perimetro di questo piano: **§5.6** "Lead che scrivono per primi", **§6.3** pulsante WhatsApp, la riga di **§6.2** su `/api/bot/lead-entrante` con `provenienza='Lancio Web Dev AI'`, il rigo di §9 "B2". Spec del branch (solo sul branch del bot, arriva con il merge): `docs/superpowers/specs/2026-09-04-lead-che-scrivono-per-primi-design.md`. Doc CRM del canale: `docs/2026-09-05-lead-entranti-adozione.md`.

## Global Constraints

- **Vincolo del PO (14/09, testuale):** "i lead di Telegram che scrivono sono roba molto diversa". Tre esiti, mai confusi, test espliciti su tutti e tre:
  - marker Telegram `/sono nel canale telegram e mi hanno indicato/i` sul **primo** inbound → provenienza `TELEGRAM`, flusso Mario standard, push al CRM come già progettato;
  - marker pulsante `/live web developer ai/i` sull'inbound **corrente** (testo precompilato `Ho seguito la live Web Developer AI e voglio saperne di più 🚀`, §6.3) → `lancio_fase='post_pitch'`, anche su conversazione già esistente; push al CRM con `provenienza='Lancio Web Dev AI'` solo se la chat viene adottata adesso;
  - tutto il resto → provenienza `INBOUND`, Mario standard.
- Funnel CRM `Lancio Web Dev AI`, bucket `LANCIO_WEBDEV_2026`, slug bot `webdev-2026-10`, `lancioIngresso='pulsante_webinar'` (spec §3.1, §3.2, §5.4).
- `/api/bot/lead-entrante` **non manda mai un intake** al bot (già così, deliberato: vedi commento in testa alla rotta). Nessun campo nuovo nel contratto: `provenienza` resta una stringa libera (§6.2).
- Il bot scrive `conversations.crm_lead_id` dalla risposta del push **prima di qualunque scelta lancio** (§5.4): il push parte nel webhook stesso, in `after()`; B4 deve rileggere `crm_lead_id` prima di `book`/`call-now` (vedi "Interfacce fra i blocchi").
- Interruttore di accensione: `INBOUND_ADOPTION_ENABLED=1` in produzione, aggiunto con `vercel env add` dal repo del bot (già linkato). Fino ad allora l'adozione è spenta e nessun lead entrante viene preso in carico.
- Repo bot: la migrazione SQL si applica su Supabase **prima** del deploy (regola del repo). Repo CRM: `drizzle-kit generate` è inutilizzabile, le migrazioni si scrivono a mano e si applicano prima del push.
- Test: bot `bun test` (Vitest, file `*.test.ts` accanto al sorgente, alias `@` = radice); CRM `npm test` (`node --import tsx --test` con la lista dei file in `package.json`: un test nuovo va aggiunto lì o messo in un file già elencato).
- Commit in italiano, prefisso `feat(bot):`/`fix(bot):` nel bot e `feat(crm):`/`feat(lead-entrante):` nel CRM. Ogni commit termina con le due righe di attribuzione della sessione (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` e `Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD`).
- Non si tocca: `ScriptWidget`, la finestra Calendly/Jotform, i canali realtime del CRM, `mario-prompt.ts` (il prompt di fase `post_pitch` è del blocco B4).

---

## 0. Analisi del branch `feat/lead-scrivono-per-primi` e decisione: MERGE (non rebase, non reimplementazione)

Misure prese il 14/09 sul repo del bot (`C:\Users\bruno\Desktop\Software Messaggistica`):

- `git log --oneline main..feat/lead-scrivono-per-primi` → **25 commit** avanti (da `b5d3032 docs: il bot risponde a chi scrive per primo` a `2469e37 fix(bot): il corpo dell'errore nel log si taglia a 300 caratteri`).
- `git log --oneline feat/lead-scrivono-per-primi..main` → **22 commit** indietro al momento della misura (23 con `12f9668 feat(lancio): script di creazione dei 3 template`, arrivato dopo). Merge-base: `0405939`.
- `git diff main...feat/lead-scrivono-per-primi --stat` → 22 file, +3354/−24. File sorgente toccati: `.env.example`, `app/api/bot/intake/route.ts`, `app/api/bot/lead-entranti/route.ts` (+test), `app/api/cron/adotta-mai-risposti/route.ts`, `app/api/cron/riapri-mute/route.ts`, `app/api/webhooks/twilio/route.ts`, `lib/bot-outcome.ts` (+test), `lib/fenice-autoreply.ts` (+test), `lib/fenice-enroll.ts` (+test), `lib/lead-entrante.ts` (+test), `lib/persona.ts` (+test), `lib/primo-contatto-note.ts` (+test), più 3 documenti.
- **Rebase di prova** in worktree temporaneo (`git rebase main`, poi `--abort`, worktree rimosso): si ferma su **2 commit su 25** —
  - `151e10a fix(bot): l'intake non ricopre una chat gia' avviata` → `lib/fenice-enroll.ts`, `lib/fenice-enroll.test.ts`;
  - `43a7260 fix(bot): l'esito senza leadId passa dalle decisioni vere` → `lib/bot-outcome.test.ts`, `lib/fenice-autoreply.test.ts`, `lib/fenice-autoreply.ts`.
- **Merge di prova** (`git merge-tree --write-tree main feat/lead-scrivono-per-primi`): **5 file in conflitto, 8 hunk** in tutto, e sono tutti hunk "additivi" (una riga di firma, righe di import, l'elenco di colonne di una `select`, i fake Supabase dei test, blocchi `describe` indipendenti). Nessun hunk dentro logica di decisione.

**Criterio usato:** si reimplementa sopra `main` solo se i conflitti stanno dentro la logica (stesse funzioni riscritte da entrambi i lati) o superano ~10 file; qui sono 5 file e 8 hunk tutti risolvibili "tieni entrambi". Fra rebase e merge si sceglie il **merge di `main` nel branch**: una sola passata di risoluzione (il rebase fa la stessa risoluzione spezzata in 2 fermate e riscrive 25 commit che raccontano fix veri: `95d8b0e`, `0f2d8f5`, `f5691d5` sono spiegazioni che conviene tenere intatte). Poi il branch, con B2 sopra, si porta su `main` con `git merge --no-ff`.

**Risoluzione attesa, file per file** (dettaglio operativo nel Task 1):

| File | Hunk | Come si risolve |
|---|---|---|
| `lib/fenice-enroll.ts` | 1 (riga ~73, firma di `enrollLeadIntoMario`) | il tipo di ritorno tiene **entrambi** i flag: `duplicato?: boolean; aperturaSaltata?: boolean` |
| `lib/fenice-enroll.test.ts` | 2 (~34-66 fake `select`; ~550-687 `makeSupabaseLeggibile` di main vs `describe('apreSopraChatViva')` del branch) | il fake di `conversations.select().eq()` espone sia `.single()` (branch) sia `.maybeSingle()` (main); quello di `messages` espone sia `.eq().eq().not()` (branch) sia `.eq().eq().gte().limit()` (main); i due blocchi di test si tengono entrambi |
| `lib/fenice-autoreply.ts` | 2 (import; `select` in `drainMarioReplies`) | `import { sendOutcome, inviaNotaAlCrm, registraEsitoSenzaLeadId } from './bot-outcome'`; la select è l'**unione** delle colonne: `id, ai_started_at, crm_lead_id, bot_outcome, bot_scheduled_at, gdo_agenda_at, gdo_video_url, gdo_video_sent_at, gdo_video_watched_at, gdo_video_followups_sent, gdo_noemi_reminded_at, gdo_appuntamento_at, leads(first_name)` |
| `lib/fenice-autoreply.test.ts` | 1 (mock di `./bot-outcome`) | il `vi.mock` dichiara sia `inviaNotaAlCrm` sia `registraEsitoSenzaLeadId`; l'import li prende tutti e tre |
| `lib/bot-outcome.test.ts` | 2 (import; due blocchi `describe` in coda) | import unione: `{ registraEsitoSenzaLeadId, sendOutcome, sendCrmNota, neutralizzaMarcatoreMotivo }` + `romeOffset, formatRomeDateTime` + `computeBookingDays` + `crmDedupKey`; entrambi i blocchi di test restano |

**Conflitto semantico da verificare coi test, non col diff:** `registraEsitoSenzaLeadId` (branch) "prende le stesse decisioni di `sendOutcome`", e `main` ha cambiato quelle decisioni dopo il merge-base (lotto A: `b7e4785` fuori dai due giorni è una nota, `d46332b` finestra dei due giorni col turno, `41408ec`). Se dopo il merge i test di `registraEsitoSenzaLeadId` falliscono, la fonte di verità è `sendOutcome` di `main`: si adegua la funzione del branch, mai i test di `main`. Analogamente `enrollLeadIntoMario` dopo il merge ha **due** guardie che convivono, in quest'ordine: `apreSopraChatViva` (branch: chat già avviata da Mario senza `crm_lead_id` → scrive `crm_lead_id`/`crm_funnel`, salta l'apertura, `aperturaSaltata:true`) e poi `apertutaDaFermare` (main: outbound nelle ultime 12 h o inbound negli ultimi 7 gg → `duplicato:true`). Non si sovrappongono nel testo, ma il test di `main` "senza crmLeadId la guardia non si attiva" e quelli del branch devono passare entrambi.

---

## Struttura dei file

**Repo bot** (`C:\Users\bruno\Desktop\Software Messaggistica`, branch di lavoro `feat/lead-scrivono-per-primi` dopo il merge di `main`):

- Modificati dal merge (Task 1): i 5 file della tabella sopra.
- `supabase/migrations/20260914000002_lancio_conversations.sql` — **crea** (Task 2, solo se B1 non l'ha già fatto): colonne `conversations.lancio_*` di spec §3.2.
- `lib/supabase/types.ts` — **modifica** (Task 2): `lancio_*` in `Row`/`Insert`/`Update` di `conversations`.
- `lib/lancio-fase.ts` + `lib/lancio-fase.test.ts` — **crea** (Task 3): `LancioFase`, `LANCIO_SLUG_WEBDEV`, `setLancioFase`.
- `lib/primo-messaggio.ts` + `lib/primo-messaggio.test.ts` — **crea** (Task 4): marker del pulsante, `classificaPrimoMessaggio` con i tre esiti.
- `lib/fenice-autoreply.ts` + `lib/fenice-autoreply.test.ts` — **modifica** (Task 5): `AdoptGate.lancioPulsante` in `shouldAdoptInbound`.
- `lib/lead-entrante.ts` + `lib/lead-entrante.test.ts` — **modifica** (Task 6): tipo `provenienza` a tre valori, test che il valore lancio viaggia com'è.
- `app/api/webhooks/twilio/route.ts` — **modifica** (Task 7): aggancio marker + adozione a tre esiti.
- `app/api/cron/adotta-mai-risposti/route.ts` — **modifica** (Task 8): stessa classificazione.
- `.env.example`, `docs/crm/2026-09-04-lead-che-scrivono-per-primi.md` — **modifica** (Task 6, Task 10).

**Repo CRM** (`C:\Users\bruno\Desktop\CRM GDO`, lavoro su `main`):

- `drizzle/migrations/0036_lancio_lead_columns.sql` — **crea** (Task 11, solo se B1 non l'ha già fatto): colonne `leads.lancio*` di spec §3.1.
- `src/db/schema.ts` — **modifica** (Task 11): colonne `lancioIngresso`, `lancioScelta`, `lancioSceltaAt`, `lancioCallNowAttempts`, `lancioCallNowNextAt`, `lancioBotInfo` su `leads`.
- `src/lib/lancio/costanti.ts` — **crea** (Task 11, se B1 non l'ha già creato): `LANCIO_WEBDEV_FUNNEL`, `LANCIO_WEBDEV_BUCKET`, `LANCIO_WEBDEV_SLUG`, `LancioIngresso`.
- `src/lib/bot-fissatore/leadEntranti.ts` + `leadEntranti.test.ts` — **modifica** (Task 12): `isProvenienzaLancioWebDev`, `candidatiPerAdozione`, `valoriNuovoLead`, `eventiNuovoLead` (puri, testati).
- `src/lib/eventLogger.ts` — **modifica** (Task 13): `'LANCIO_INTAKE'` nell'unione dei tipi evento.
- `src/lib/bot-fissatore/adozione.ts` — **modifica** (Task 13): ramo lancio usando le funzioni pure.
- `src/components/ContactDrawer.tsx` — **modifica** (Task 13): icona + etichetta di `LANCIO_INTAKE`.
- `docs/2026-09-05-lead-entranti-adozione.md` — **modifica** (Task 13): i tre valori di `provenienza`.

**Ordine di esecuzione:** Task 1-2 (bot: integrazione e migrazione) → Task 11-14 (CRM, va in produzione **prima** del bot: se il bot mandasse `Lancio Web Dev AI` a un CRM che non lo riconosce, nascerebbe un lead con funnel `LANCIO WEB DEV AI` senza bucket) → Task 3-10 (bot: feature, merge su `main`, accensione).

---

## Interfacce fra i blocchi (B1 ↔ B2 ↔ B4)

- **B1 → B2 (bot):** colonne `conversations.lancio_slug`, `lancio_fase`, `lancio_ingresso`, `lancio_link_inviato_at`, `lancio_followup_inviato_at`, `lancio_info` (spec §3.2). Se B1 è già su `main` con una migrazione che le crea, il Task 2 si limita a verificare `types.ts`. Se B1 ha già `lib/lancio-fase.ts`, il Task 3 verifica che esporti `setLancioFase(supabase, conversationId, fase, extra?)` con la firma qui sotto e non lo riscrive.
- **B2 → B4 (bot):** `setLancioFase(supabase, conversationId, fase, extra?)` in `lib/lancio-fase.ts`; `classificaPrimoMessaggio`/`isMarkerPulsanteWebinar` in `lib/primo-messaggio.ts`; evento `event_log.type='lancio_pulsante'` con `payload.conversationId`, `payload.giaDiMario` (boolean). Prima di `book`/`call-now` B4 rilegge `conversations.crm_lead_id`; se è ancora `null` (push perso: è fire-and-forget) richiama `pushLeadEntrante` — è idempotente lato CRM (dedup per numero sotto advisory lock) — e solo poi sceglie.
- **B1 → B2 (CRM):** colonne `leads.lancioIngresso` ecc. (spec §3.1) e costanti in `src/lib/lancio/costanti.ts`. Se B1 le ha già portate su `main`, il Task 11 non ricrea nulla: verifica i nomi e passa oltre.
- **Bot → CRM (contratto v1.6, invariato nei campi):** `POST /api/bot/lead-entrante` con `provenienza` ∈ `'TELEGRAM' | 'INBOUND' | 'Lancio Web Dev AI'` (il CRM normalizza con trim/uppercase: riconosce `lancio web dev ai` a prescindere dal caso); risposta `{ ok:true, leadId, creato, nomeAggiornato }` invariata.

---

## PARTE A — Repo bot: integrazione del branch

### Task 1: Merge di `main` in `feat/lead-scrivono-per-primi` e risoluzione dei 5 file

**Repo:** bot (`C:\Users\bruno\Desktop\Software Messaggistica`).

**Files:**
- Modify: `lib/fenice-enroll.ts` (riga ~73)
- Modify: `lib/fenice-enroll.test.ts` (~34-66, ~550-687)
- Modify: `lib/fenice-autoreply.ts` (import in testa; `select` in `drainMarioReplies`, ~riga 314)
- Modify: `lib/fenice-autoreply.test.ts` (~9-21)
- Modify: `lib/bot-outcome.test.ts` (~2-10, ~1007-1345)

**Interfaces:**
- Consumes: il branch così com'è (`shouldAdoptInbound`, `funnelDaPrimoMessaggio`, `pushLeadEntrante`, `registraEsitoSenzaLeadId`, `apreSopraChatViva`) e `main` (`apertutaDaFermare`, `inviaNotaAlCrm`, `neutralizzaMarcatoreMotivo`, lotto A degli esiti).
- Produces: un branch che contiene tutto `main` e compila; `enrollLeadIntoMario` ritorna `{ ok, conversationId, sid?, error?, deferred?, duplicato?, aperturaSaltata? }`.

- [ ] **Step 1: Verifica lo stato di partenza e avvia il merge**

```bash
cd "/c/Users/bruno/Desktop/Software Messaggistica"
git status --short            # deve essere vuoto
git checkout feat/lead-scrivono-per-primi
git merge main                # si ferma con 5 CONFLICT (content)
git diff --name-only --diff-filter=U
```

Atteso: esattamente `lib/bot-outcome.test.ts lib/fenice-autoreply.test.ts lib/fenice-autoreply.ts lib/fenice-enroll.test.ts lib/fenice-enroll.ts`. Se compare un file in più, `main` è avanzato dopo il 14/09: risolvilo con lo stesso principio (tieni entrambi i lati) e annotalo nel commit.

- [ ] **Step 2: Risolvi `lib/fenice-enroll.ts` (firma)**

Sostituisci l'intero blocco fra i marker con:

```ts
): Promise<{ ok: boolean; conversationId: number; sid?: string; error?: string; deferred?: boolean; duplicato?: boolean; aperturaSaltata?: boolean }> {
```

Poi controlla che nel corpo ci siano, in quest'ordine, la guardia `apreSopraChatViva` (branch, dopo `findOrCreateLeadConversation`, prima di `convUpdate`) e la guardia `apertutaDaFermare` (main, dopo il ramo `deferred`). Entrambe restano.

- [ ] **Step 3: Risolvi `lib/fenice-autoreply.ts` (import + select)**

Hunk 1 (import):

```ts
import { sendOutcome, inviaNotaAlCrm, registraEsitoSenzaLeadId } from './bot-outcome';
```

Hunk 2 (select in `drainMarioReplies`), tieni il commento del branch e l'unione delle colonne:

```ts
    // `bot_outcome` e `bot_scheduled_at` servono al ramo degli esiti senza leadId
    // (`registraEsitoSenzaLeadId`): senza di loro non saprebbe che su questa
    // conversazione c'e' gia' un appuntamento in piedi, e lo declasserebbe.
    .select('id, ai_started_at, crm_lead_id, bot_outcome, bot_scheduled_at, gdo_agenda_at, gdo_video_url, gdo_video_sent_at, gdo_video_watched_at, gdo_video_followups_sent, gdo_noemi_reminded_at, gdo_appuntamento_at, leads(first_name)')
```

- [ ] **Step 4: Risolvi i tre file di test tenendo entrambi i lati**

`lib/fenice-autoreply.test.ts`: dentro il `vi.mock('./bot-outcome', ...)` lascia sia `inviaNotaAlCrm: vi.fn(async () => ({ sent: true }))` sia `registraEsitoSenzaLeadId: vi.fn(async () => ({ decisione: 'registrato', chiudi: true }))`; l'import diventa `import { sendOutcome, inviaNotaAlCrm, registraEsitoSenzaLeadId } from './bot-outcome';`.

`lib/bot-outcome.test.ts`: import unione

```ts
import { registraEsitoSenzaLeadId, sendOutcome, sendCrmNota, neutralizzaMarcatoreMotivo } from './bot-outcome';
import { romeOffset, formatRomeDateTime } from './rome-time';
import { computeBookingDays } from './booking-slots';
import { crmDedupKey } from './note-dedup';
```

e in coda al file restano **entrambi** i blocchi (quello di `main` sulla chiave di dedup della NOTA e quello del branch su `registraEsitoSenzaLeadId`), uno dopo l'altro.

`lib/fenice-enroll.test.ts`, hunk ~34-66: il fake della tabella `conversations` deve avere `select()` che ritorna `{ eq() { return { single: () => Promise.resolve({ data: convRow }), maybeSingle: async () => ({ data: convRow }) }; } }` (il branch chiama `.single()`, `apertutaDaFermare` di main `.maybeSingle()`); il fake di `messages` deve reggere sia `.eq().eq().not()` (branch: conta gli outbound con `twilio_sid`) sia `.eq().eq().gte().limit()` (main: outbound nelle ultime 12 h). Un modo compatto:

```ts
      if (table === 'messages') {
        const fine = { not: () => Promise.resolve({ count: outboundCount }), gte() { return { limit: () => Promise.resolve({ data: outboundRecentiRows }) }; } };
        return { select() { return { eq() { return { eq: () => fine }; } }; } };
      }
```

dove `outboundRecentiRows` è `[]` nei test del branch (nessun outbound recente) e quello che main si aspetta nei suoi. Hunk ~550-687: tieni `makeSupabaseLeggibile` + i test di main **e** `describe('apreSopraChatViva')` del branch.

- [ ] **Step 5: Chiudi il merge e fai girare tutto**

```bash
git add lib/fenice-enroll.ts lib/fenice-enroll.test.ts lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts lib/bot-outcome.test.ts
bun run typecheck
bun test
```

Atteso: `tsc` senza errori; Vitest tutto verde. Se falliscono test di `registraEsitoSenzaLeadId` (lib/bot-outcome.test.ts) o di `enrollLeadIntoMario`, vale la regola di §0: allinea la funzione del branch alle decisioni di `main` (`sendOutcome`, `apertutaDaFermare`), non i test di `main`. Annota nel messaggio di merge cosa hai dovuto allineare.

- [ ] **Step 6: Commit del merge**

```bash
git commit -m "merge main in feat/lead-scrivono-per-primi: 5 file, hunk additivi tenuti da entrambi i lati

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 2: Migrazione `conversations.lancio_*` e tipi Supabase

**Repo:** bot.

**Files:**
- Create: `supabase/migrations/20260914000002_lancio_conversations.sql`
- Modify: `lib/supabase/types.ts` (blocco `conversations`: `Row` ~riga 80-115, `Insert` ~120-160, `Update` ~165-205)

**Interfaces:**
- Consumes: spec §3.2.
- Produces: colonne `lancio_slug text`, `lancio_fase text`, `lancio_ingresso text`, `lancio_link_inviato_at timestamptz`, `lancio_followup_inviato_at timestamptz`, `lancio_info jsonb` su `conversations`; tipi corrispondenti in `Database['public']['Tables']['conversations']`.

- [ ] **Step 1: Controlla se B1 ha già fatto questo lavoro**

```bash
cd "/c/Users/bruno/Desktop/Software Messaggistica"
grep -rn "lancio_fase" supabase/migrations/ lib/supabase/types.ts
```

Se `grep` trova la colonna sia in una migrazione sia in `types.ts`: salta gli Step 2-4 e vai allo Step 5 (solo verifica). Altrimenti prosegui.

- [ ] **Step 2: Scrivi la migrazione (idempotente: `if not exists`, così non collide con B1 se arriva dopo)**

```sql
-- Lancio Web Dev AI (spec docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §3.2).
-- Colonne di stato del lancio sulla conversazione. Tutte nullable: le chat che non
-- sono del lancio non le vedono. `if not exists` perche' B1 e B2 possono arrivare
-- in ordine diverso e la migrazione deve poter girare due volte senza danni.
alter table public.conversations
  add column if not exists lancio_slug                 text,
  add column if not exists lancio_fase                 text,
  add column if not exists lancio_ingresso             text,
  add column if not exists lancio_link_inviato_at      timestamptz,
  add column if not exists lancio_followup_inviato_at  timestamptz,
  add column if not exists lancio_info                 jsonb;

comment on column public.conversations.lancio_slug is 'Lancio a cui appartiene la chat, es. webdev-2026-10. NULL = non e'' un lead lancio.';
comment on column public.conversations.lancio_fase is 'attesa | posto_bloccato | link_inviato | post_pitch | scelta_fatta | followup_inviato | restituito | chiuso';
comment on column public.conversations.lancio_ingresso is 'lista | pulsante_webinar';

-- Il blast del 5/10 e il follow-up del 6 selezionano per slug+fase: indice parziale,
-- pesa solo sulle righe del lancio.
create index if not exists conversations_lancio_idx
  on public.conversations (lancio_slug, lancio_fase)
  where lancio_slug is not null;
```

- [ ] **Step 3: Aggiorna `lib/supabase/types.ts`**

Nel blocco `conversations`, in `Row` aggiungi (in ordine alfabetico, accanto a `last_inbound_at`):

```ts
          lancio_fase: string | null
          lancio_followup_inviato_at: string | null
          lancio_info: Json | null
          lancio_ingresso: string | null
          lancio_link_inviato_at: string | null
          lancio_slug: string | null
```

In `Insert` e `Update` le stesse sei righe con `?:` (`lancio_fase?: string | null` ecc.).

- [ ] **Step 4: Applica la migrazione su Supabase PRIMA del deploy**

Progetto Supabase del bot: quello di `NEXT_PUBLIC_SUPABASE_URL` in `.env.local` (`gosnmagiishkwuvmortj`). Applica il contenuto del file con lo strumento `mcp__supabase__apply_migration` (nome `lancio_conversations`) oppure incollandolo nell'SQL editor del progetto. Verifica:

```sql
select column_name from information_schema.columns where table_name = 'conversations' and column_name like 'lancio_%' order by 1;
```

Atteso: 6 righe.

- [ ] **Step 5: Typecheck e commit**

```bash
bun run typecheck
git add supabase/migrations/20260914000002_lancio_conversations.sql lib/supabase/types.ts
git commit -m "feat(bot): colonne lancio_* su conversations (spec lancio §3.2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

(Se hai saltato gli Step 2-4 perché B1 c'era già: nessun commit, passa al Task 11.)

---

## PARTE B — Repo CRM: `provenienza='Lancio Web Dev AI'` su `/api/bot/lead-entrante`

### Task 11: Migrazione `leads.lancio*`, schema Drizzle, costanti del lancio

**Repo:** CRM (`C:\Users\bruno\Desktop\CRM GDO`).

**Files:**
- Create: `drizzle/migrations/0036_lancio_lead_columns.sql`
- Modify: `src/db/schema.ts` (tabella `leads`, subito dopo `launchBucket: text('launchBucket'),` a riga ~136)
- Create: `src/lib/lancio/costanti.ts`

**Interfaces:**
- Consumes: spec §3.1.
- Produces: `leads.lancioIngresso`, `lancioScelta`, `lancioSceltaAt`, `lancioCallNowAttempts`, `lancioCallNowNextAt`, `lancioBotInfo`; `LANCIO_WEBDEV_FUNNEL = 'Lancio Web Dev AI'`, `LANCIO_WEBDEV_BUCKET = 'LANCIO_WEBDEV_2026'`, `LANCIO_WEBDEV_SLUG = 'webdev-2026-10'`, `type LancioIngresso = 'lista' | 'pulsante_webinar'`.

- [ ] **Step 1: Controlla se B1 ha già fatto questo lavoro**

```bash
cd "/c/Users/bruno/Desktop/CRM GDO"
grep -n "lancioIngresso" src/db/schema.ts; ls drizzle/migrations | tail -3; ls src/lib/lancio 2>/dev/null
```

Se `lancioIngresso` è già nello schema **e** esiste `src/lib/lancio/costanti.ts` che esporta `LANCIO_WEBDEV_FUNNEL`, `LANCIO_WEBDEV_BUCKET`, `LANCIO_WEBDEV_SLUG`, `LancioIngresso`: salta al Task 12. Se esiste lo schema ma non le costanti (o viceversa), fai solo la parte mancante. Se B1 ha chiamato le costanti diversamente, **usa i nomi di B1** e adegua gli import dei Task 12-13: un solo posto per quei valori.

- [ ] **Step 2: Scrivi la migrazione (idempotente)**

```sql
-- 0036: colonne del lancio Web Dev AI sui lead.
-- Spec: docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §3.1
-- Tutte nullable/additive; `if not exists` perche' B1 e B2 possono arrivare in
-- ordine diverso. L'appartenenza al lancio resta su launchBucket='LANCIO_WEBDEV_2026'
-- + funnel='Lancio Web Dev AI': queste colonne dicono COME e' entrato e cosa ha scelto.

alter table public.leads
  add column if not exists "lancioIngresso"        text,
  add column if not exists "lancioScelta"          text,
  add column if not exists "lancioSceltaAt"        timestamptz,
  add column if not exists "lancioCallNowAttempts" integer not null default 0,
  add column if not exists "lancioCallNowNextAt"   timestamptz,
  add column if not exists "lancioBotInfo"         jsonb;

comment on column public.leads."lancioIngresso" is 'lista | pulsante_webinar — come il lead e'' entrato nel lancio.';
comment on column public.leads."lancioScelta" is 'chiamata_subito | app_mattina | app_pomeriggio | app_dopodomani | followup';
comment on column public.leads."lancioBotInfo" is 'Risposte alle due domande di riscaldamento del bot, mostrate al venditore.';
```

- [ ] **Step 3: Aggiungi le colonne in `src/db/schema.ts`** (dopo `launchBucket`)

```ts
    // Lancio Web Dev AI (migr. 0036, spec 2026-09-14 §3.1). L'appartenenza al lancio
    // resta su launchBucket + funnel; queste dicono come e' entrato e cosa ha scelto.
    lancioIngresso: text('lancioIngresso'),            // 'lista' | 'pulsante_webinar'
    lancioScelta: text('lancioScelta'),                // 'chiamata_subito' | 'app_mattina' | 'app_pomeriggio' | 'app_dopodomani' | 'followup'
    lancioSceltaAt: timestamp('lancioSceltaAt', { withTimezone: true, mode: 'date' }),
    lancioCallNowAttempts: integer('lancioCallNowAttempts').default(0).notNull(),
    lancioCallNowNextAt: timestamp('lancioCallNowNextAt', { withTimezone: true, mode: 'date' }),
    lancioBotInfo: jsonb('lancioBotInfo'),
```

- [ ] **Step 4: Crea `src/lib/lancio/costanti.ts`**

```ts
/**
 * Costanti del lancio Web Dev AI (webinar 5/10/2026). Un solo posto: il webhook AC
 * (B1), l'adozione dei lead entranti (B2), le API slots/book/call-now (B3) e il
 * ritorno al pool (B5) leggono da qui. Modulo puro: importabile dai test node --test.
 * Spec: docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §1 (dec. 12), §3.
 */
export const LANCIO_WEBDEV_FUNNEL = 'Lancio Web Dev AI';
export const LANCIO_WEBDEV_BUCKET = 'LANCIO_WEBDEV_2026';
export const LANCIO_WEBDEV_SLUG = 'webdev-2026-10';

export type LancioIngresso = 'lista' | 'pulsante_webinar';
```

- [ ] **Step 5: Applica la migrazione su Supabase (progetto CRM, id in `memory/reference_infra_ids.md`) e verifica**

Con `mcp__supabase__apply_migration` (nome `lancio_lead_columns`) o SQL editor. Poi:

```sql
select column_name from information_schema.columns where table_name = 'leads' and column_name like 'lancio%' order by 1;
```

Atteso: 6 righe.

- [ ] **Step 6: Typecheck e commit**

```bash
npx tsc --noEmit
git add drizzle/migrations/0036_lancio_lead_columns.sql src/db/schema.ts src/lib/lancio/costanti.ts
git commit -m "feat(crm): colonne lancio* su leads e costanti del lancio Web Dev AI (migr. 0036)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 12: Decisioni pure per l'adozione lancio (`leadEntranti.ts`)

**Repo:** CRM.

**Files:**
- Modify: `src/lib/bot-fissatore/leadEntranti.ts` (dopo `normalizzaLeadEntrante`, prima di `LeadEsistente`)
- Test: `src/lib/bot-fissatore/leadEntranti.test.ts` (già nella lista di `npm test`)

**Interfaces:**
- Consumes: `LANCIO_WEBDEV_FUNNEL`, `LANCIO_WEBDEV_BUCKET`, `LancioIngresso` da `@/lib/lancio/costanti`; `LeadEntranteNormalizzato`, `NOME_FALLBACK`, `SOURCE_INBOUND` già nel file.
- Produces:
  - `isProvenienzaLancioWebDev(provenienza: string | null | undefined): boolean`
  - `interface LeadEsistente { ...; launchBucket?: string | null }` (campo nuovo opzionale)
  - `candidatiPerAdozione(fenice: LeadEsistente[], lancio: boolean): LeadEsistente[]`
  - `interface NuovoLeadValori { id; name; phone; email: null; funnel; source; status: 'NEW'; callCount: 0; assignedToId; createdAt; assignedAt; updatedAt; companyId: 'fenice'; launchBucket: string | null; lancioIngresso: LancioIngresso | null }`
  - `valoriNuovoLead(lead: LeadEntranteNormalizzato, botId: string, adesso: Date, id: string): NuovoLeadValori`
  - `type EventoNuovoLead = { eventType: 'IMPORTED' | 'ASSIGNED' | 'LANCIO_INTAKE'; toSection?: 'Prima Chiamata'; metadata: Record<string, unknown> }`
  - `eventiNuovoLead(lead: LeadEntranteNormalizzato, valori: NuovoLeadValori): EventoNuovoLead[]`

- [ ] **Step 1: Scrivi i test che falliscono** (in coda a `leadEntranti.test.ts`)

```ts
import {
    isProvenienzaLancioWebDev,
    candidatiPerAdozione,
    valoriNuovoLead,
    eventiNuovoLead,
    SOURCE_INBOUND,
} from './leadEntranti';
import { LANCIO_WEBDEV_FUNNEL, LANCIO_WEBDEV_BUCKET } from '@/lib/lancio/costanti';

const ADESSO = new Date('2026-10-05T21:40:00+02:00');

function normalizzato(provenienza: string, over: Partial<LeadEntranteRaw> = {}) {
    const res = normalizzaLeadEntrante({ ...RIGA_BASE, provenienza, ...over });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error('unreachable');
    return res.lead;
}

test('isProvenienzaLancioWebDev: riconosce il valore del pulsante in ogni caso/spaziatura, e solo quello', () => {
    assert.equal(isProvenienzaLancioWebDev('Lancio Web Dev AI'), true);
    assert.equal(isProvenienzaLancioWebDev('LANCIO WEB DEV AI'), true);   // come esce da normalizzaLeadEntrante
    assert.equal(isProvenienzaLancioWebDev('  lancio   web dev ai '), true);
    assert.equal(isProvenienzaLancioWebDev('TELEGRAM'), false);
    assert.equal(isProvenienzaLancioWebDev('INBOUND'), false);
    assert.equal(isProvenienzaLancioWebDev('Lancio Web Developer AI'), false); // il nome della lista AC non e' il funnel
    assert.equal(isProvenienzaLancioWebDev(null), false);
});

test('valoriNuovoLead: TELEGRAM resta il lead entrante di oggi (funnel grezzo, nessun bucket)', () => {
    const v = valoriNuovoLead(normalizzato('TELEGRAM'), 'bot-1', ADESSO, 'id-1');
    assert.equal(v.funnel, 'TELEGRAM');
    assert.equal(v.launchBucket, null);
    assert.equal(v.lancioIngresso, null);
    assert.equal(v.assignedToId, 'bot-1');
    assert.equal(v.source, SOURCE_INBOUND);
    assert.equal(v.status, 'NEW');
    assert.equal(v.createdAt.toISOString(), '2026-08-26T19:51:52.000Z'); // scrittoIl
    assert.equal(v.assignedAt, ADESSO);
});

test('valoriNuovoLead: INBOUND identico a TELEGRAM salvo il funnel', () => {
    const v = valoriNuovoLead(normalizzato('INBOUND'), 'bot-1', ADESSO, 'id-2');
    assert.equal(v.funnel, 'INBOUND');
    assert.equal(v.launchBucket, null);
    assert.equal(v.lancioIngresso, null);
});

test('valoriNuovoLead: Lancio Web Dev AI → funnel canonico, bucket, ingresso pulsante, assegnato al bot', () => {
    const v = valoriNuovoLead(normalizzato('Lancio Web Dev AI'), 'bot-1', ADESSO, 'id-3');
    assert.equal(v.funnel, LANCIO_WEBDEV_FUNNEL);          // NON 'LANCIO WEB DEV AI'
    assert.equal(v.launchBucket, LANCIO_WEBDEV_BUCKET);
    assert.equal(v.lancioIngresso, 'pulsante_webinar');
    assert.equal(v.assignedToId, 'bot-1');
    assert.equal(v.source, SOURCE_INBOUND);
    assert.equal(v.assignedAt, ADESSO);
});

test('eventiNuovoLead: i lead entranti normali hanno IMPORTED + ASSIGNED, il lancio ha in piu LANCIO_INTAKE', () => {
    const t = normalizzato('TELEGRAM');
    const eventiT = eventiNuovoLead(t, valoriNuovoLead(t, 'bot-1', ADESSO, 'id-1'));
    assert.deepEqual(eventiT.map((e) => e.eventType), ['IMPORTED', 'ASSIGNED']);
    assert.equal(eventiT[0].metadata.provenienza, 'TELEGRAM');
    assert.equal(eventiT[1].metadata.routing, undefined);

    const l = normalizzato('Lancio Web Dev AI');
    const eventiL = eventiNuovoLead(l, valoriNuovoLead(l, 'bot-1', ADESSO, 'id-3'));
    assert.deepEqual(eventiL.map((e) => e.eventType), ['IMPORTED', 'ASSIGNED', 'LANCIO_INTAKE']);
    assert.equal(eventiL[1].metadata.routing, 'lancio');
    assert.equal(eventiL[2].metadata.ingresso, 'pulsante_webinar');
    assert.equal(eventiL[2].metadata.bucket, LANCIO_WEBDEV_BUCKET);
});

test('candidatiPerAdozione: fuori dal lancio vale il piu recente di qualunque funnel; nel lancio solo chi e gia nel bucket', () => {
    const vecchioGdo = esistente({ id: 'gdo', createdAt: new Date('2026-05-01T00:00:00Z'), launchBucket: null });
    const nelBucket = esistente({ id: 'lancio', createdAt: new Date('2026-09-20T00:00:00Z'), launchBucket: LANCIO_WEBDEV_BUCKET });
    assert.deepEqual(candidatiPerAdozione([vecchioGdo], false).map((c) => c.id), ['gdo']);
    assert.deepEqual(candidatiPerAdozione([vecchioGdo], true), []);            // duplicato cross-funnel voluto
    assert.deepEqual(candidatiPerAdozione([vecchioGdo, nelBucket], true).map((c) => c.id), ['lancio']);
    assert.deepEqual(candidatiPerAdozione([vecchioGdo, nelBucket], false).length, 2);
});
```

Nota: `esistente()` e `RIGA_BASE` sono già definiti in testa al file di test.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
cd "/c/Users/bruno/Desktop/CRM GDO"
node --import tsx --test src/lib/bot-fissatore/leadEntranti.test.ts
```

Atteso: FAIL con `does not provide an export named 'isProvenienzaLancioWebDev'` (o equivalente).

- [ ] **Step 3: Implementa in `leadEntranti.ts`**

In testa al file aggiungi l'import:

```ts
import { LANCIO_WEBDEV_BUCKET, LANCIO_WEBDEV_FUNNEL, type LancioIngresso } from '@/lib/lancio/costanti';
```

Estendi `LeadEsistente`:

```ts
export interface LeadEsistente {
    id: string;
    status: string;
    presentedAt: Date | null;
    createdAt: Date;
    assignedToId: string | null;
    companyId: string;
    /** Bucket di lancio (null per i lead normali). Serve alla dedup del lancio. */
    launchBucket?: string | null;
}
```

Dopo `normalizzaLeadEntrante` aggiungi:

```ts
/**
 * `provenienza` del pulsante WhatsApp del webinar (spec lancio §5.4, §6.3). Il bot la
 * manda com'e' ("Lancio Web Dev AI"); `normalizzaLeadEntrante` la porta in maiuscolo
 * come ogni funnel: il confronto e' quindi case-insensitive e tollera gli spazi.
 * Il nome della LISTA ActiveCampaign ("Lancio Web Developer AI") non e' il funnel
 * e non deve passare: un lead della lista arriva dal webhook AC, non da qui.
 */
export function isProvenienzaLancioWebDev(provenienza: string | null | undefined): boolean {
    return (provenienza ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === LANCIO_WEBDEV_FUNNEL.toLowerCase();
}

/**
 * Su quali lead Fenice gia' esistenti si puo' "collegare" invece di creare.
 * Fuori dal lancio: tutti (poi si prende il piu' recente). Nel lancio: SOLO chi e'
 * gia' nel bucket del lancio — un lead di un altro funnel sullo stesso numero non
 * blocca la creazione, perche' i duplicati cross-funnel del lancio sono voluti
 * (decisione 1 del 14/09: stessa regola del webhook AC per la lista 132).
 */
export function candidatiPerAdozione(fenice: LeadEsistente[], lancio: boolean): LeadEsistente[] {
    if (!lancio) return fenice;
    return fenice.filter((c) => c.launchBucket === LANCIO_WEBDEV_BUCKET);
}

/** Riga da inserire in `leads` per un lead entrante nuovo. Pura: la scrive `adottaLead`. */
export interface NuovoLeadValori {
    id: string;
    name: string;
    phone: string;
    email: null;
    funnel: string;
    source: string;
    status: 'NEW';
    callCount: 0;
    assignedToId: string;
    createdAt: Date;
    assignedAt: Date;
    updatedAt: Date;
    companyId: 'fenice';
    launchBucket: string | null;
    lancioIngresso: LancioIngresso | null;
}

export function valoriNuovoLead(
    lead: LeadEntranteNormalizzato,
    botId: string,
    adesso: Date,
    id: string,
): NuovoLeadValori {
    const lancio = isProvenienzaLancioWebDev(lead.funnel);
    return {
        id,
        name: lead.name,
        phone: lead.phone,
        email: null,
        // Nel lancio il funnel e' quello canonico (con le maiuscole giuste): e' il
        // valore su cui filtrano KPI e /import, non la stringa maiuscola del contratto.
        funnel: lancio ? LANCIO_WEBDEV_FUNNEL : lead.funnel,
        source: SOURCE_INBOUND,
        status: 'NEW',
        callCount: 0,
        // La chat e' gia' del bot: darla a un GDO umano gli toglierebbe una
        // conversazione che sta conducendo lui, e romperebbe la prova di
        // appartenenza che /api/bot/outcome pretende per un appuntamento.
        assignedToId: botId,
        // `createdAt` = quando ha scritto; `assignedAt` = adesso (migr. 0027).
        createdAt: lead.scrittoIl ?? adesso,
        assignedAt: adesso,
        updatedAt: adesso,
        companyId: 'fenice',
        launchBucket: lancio ? LANCIO_WEBDEV_BUCKET : null,
        lancioIngresso: lancio ? 'pulsante_webinar' : null,
    };
}

export type EventoNuovoLead = {
    eventType: 'IMPORTED' | 'ASSIGNED' | 'LANCIO_INTAKE';
    toSection?: 'Prima Chiamata';
    metadata: Record<string, unknown>;
};

/** Gli eventi da scrivere sulla timeline di un lead entrante appena creato, in ordine. */
export function eventiNuovoLead(lead: LeadEntranteNormalizzato, valori: NuovoLeadValori): EventoNuovoLead[] {
    const lancio = valori.launchBucket === LANCIO_WEBDEV_BUCKET;
    const eventi: EventoNuovoLead[] = [
        {
            eventType: 'IMPORTED',
            toSection: 'Prima Chiamata',
            metadata: {
                source: SOURCE_INBOUND,
                provenienza: lead.funnel,
                conversationId: lead.conversationId,
                statoBot: lead.statoBot,
                scrittoIl: lead.scrittoIl?.toISOString() ?? null,
            },
        },
        {
            eventType: 'ASSIGNED',
            metadata: {
                assignedToUser: valori.assignedToId,
                source: SOURCE_INBOUND,
                adozioneChatEntrante: true,
                ...(lancio ? { routing: 'lancio' } : {}),
            },
        },
    ];
    if (lancio) {
        eventi.push({
            eventType: 'LANCIO_INTAKE',
            metadata: { ingresso: valori.lancioIngresso, bucket: valori.launchBucket, funnel: valori.funnel, conversationId: lead.conversationId },
        });
    }
    return eventi;
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
node --import tsx --test src/lib/bot-fissatore/leadEntranti.test.ts
```

Atteso: tutti PASS (i test preesistenti del file inclusi).

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot-fissatore/leadEntranti.ts src/lib/bot-fissatore/leadEntranti.test.ts
git commit -m "feat(lead-entrante): decisioni pure per la provenienza 'Lancio Web Dev AI' (funnel, bucket, eventi, dedup nel lancio)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 13: Ramo lancio in `adottaLead`, evento `LANCIO_INTAKE` e documentazione

**Repo:** CRM.

**Files:**
- Modify: `src/lib/bot-fissatore/adozione.ts` (funzione `adottaLead`, righe ~40-150)
- Modify: `src/lib/eventLogger.ts` (unione `eventType`, riga ~27)
- Modify: `src/components/ContactDrawer.tsx` (`getEventIcon` ~riga 215, `getEventLabel` ~riga 232)
- Modify: `docs/2026-09-05-lead-entranti-adozione.md` (sezione "Scelte fatte, e perché", voce `provenienza`)

**Interfaces:**
- Consumes: `isProvenienzaLancioWebDev`, `candidatiPerAdozione`, `valoriNuovoLead`, `eventiNuovoLead` (Task 12); `leads.launchBucket`, `leads.lancioIngresso` (Task 11); `logLeadEvent`.
- Produces: `adottaLead(lead, botId)` con la stessa firma e lo stesso `EsitoAdozione`; su provenienza lancio crea un lead nel bucket con `LANCIO_INTAKE` e non tocca i lead di altri funnel sullo stesso numero. La rotta `/api/bot/lead-entrante` non cambia (nessun intake, contratto invariato).

- [ ] **Step 1: Aggiungi `'LANCIO_INTAKE'` all'unione in `src/lib/eventLogger.ts`**

```ts
    eventType: 'IMPORTED' | 'ASSIGNED' | 'CALL_LOGGED' | 'SECTION_MOVED' | 'DISCARDED' | 'RECALL_SET' | 'APPOINTMENT_SET' | 'AGENDA_SENT' | 'AGENDA_DELIVERED' | 'AC_UPDATED' | 'BOT_PUSHED' | 'VIDEO_OPENED' | 'RECONCILED' | 'INBOUND_MESSAGE' | 'LANCIO_INTAKE' | 'contact_info_edited'
```

- [ ] **Step 2: Riscrivi la transazione di `adottaLead` in `adozione.ts`**

Import in testa (sostituisce quello attuale da `./leadEntranti`):

```ts
import {
    NOME_FALLBACK,
    SOURCE_INBOUND,
    isProvenienzaLancioWebDev,
    candidatiPerAdozione,
    valoriNuovoLead,
    eventiNuovoLead,
    type LeadEntranteNormalizzato,
} from './leadEntranti';
```

Corpo di `adottaLead` (da `const adesso` fino al `return risultato;` finale):

```ts
    const adesso = new Date();
    const nuovoId = crypto.randomUUID();
    const lancio = isProvenienzaLancioWebDev(lead.funnel);
    const valori = valoriNuovoLead(lead, botId, adesso, nuovoId);

    const risultato = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lead.phone}, 0))`);

        // Volutamente senza filtro azienda: serve a riconoscere anche i contatti
        // di un'altra azienda, che non devono generare un doppione Fenice
        // (stessa guardia cross-tenant del webhook AC).
        const esistenti = await tx.select({
            id: leads.id,
            name: leads.name,
            status: leads.status,
            presentedAt: leads.presentedAt,
            createdAt: leads.createdAt,
            assignedToId: leads.assignedToId,
            companyId: leads.companyId,
            launchBucket: leads.launchBucket,
        }).from(leads)
            .where(sql`right(regexp_replace(${leads.phone}, '\\D', '', 'g'), 10) = ${lead.personKey}`);

        const fenice = esistenti.filter((e) => e.companyId === FENICE);

        if (fenice.length === 0 && esistenti.length > 0) {
            return { esito: 'altra_azienda' as const, companyId: esistenti[0].companyId };
        }

        // Nel lancio si "collega" solo a un lead gia' nel bucket (chi era in lista e ha
        // premuto il pulsante): un lead di un altro funnel sullo stesso numero non
        // ferma la creazione, perche' i duplicati cross-funnel del lancio sono voluti.
        const candidati = candidatiPerAdozione(fenice, lancio);

        if (candidati.length > 0) {
            // Il più recente: è quello su cui la persona sta lavorando adesso.
            const piuRecente = candidati.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));

            // Il nome arriva dopo, e quasi sempre non arriva mai al primo giro:
            // riempiamo il buco se salta fuori, mai una sovrascrittura.
            const nomeAttuale = (piuRecente.name ?? '').trim();
            const daRiempire = nomeAttuale === '' || nomeAttuale === NOME_FALLBACK;
            const nomeAggiornato = daRiempire && lead.name !== NOME_FALLBACK;
            if (nomeAggiornato) {
                await tx.update(leads)
                    .set({ name: lead.name, updatedAt: new Date() })
                    .where(eq(leads.id, piuRecente.id));
            }

            return {
                esito: 'esistente' as const,
                leadId: piuRecente.id,
                bloccato: piuRecente.status === 'APPOINTMENT' || piuRecente.presentedAt !== null,
                nomeAggiornato,
            };
        }

        await tx.insert(leads).values(valori);
        return { esito: 'creato' as const, leadId: nuovoId, bloccato: false as const };
    });

    if (risultato.esito === 'creato') {
        for (const ev of eventiNuovoLead(lead, valori)) {
            await logLeadEvent({
                leadId: risultato.leadId,
                eventType: ev.eventType,
                ...(ev.toSection ? { toSection: ev.toSection } : {}),
                metadata: ev.metadata,
                companyId: FENICE,
            });
        }
    }

    if (risultato.esito === 'esistente' && risultato.nomeAggiornato) {
        await logLeadEvent({
            leadId: risultato.leadId,
            eventType: 'contact_info_edited',
            metadata: { campo: 'name', valore: lead.name, source: SOURCE_INBOUND, daChatEntrante: true },
            companyId: FENICE,
        });
    }

    if (risultato.esito !== 'altra_azienda') {
        await annotaPrimoMessaggio(risultato.leadId, lead);
    }

    return risultato;
```

Aggiorna il commento in testa alla funzione con una riga: "Provenienza `Lancio Web Dev AI` (pulsante del webinar, spec lancio §5.6): il lead nasce nel bucket `LANCIO_WEBDEV_2026` con `lancioIngresso='pulsante_webinar'`, assegnato al bot, con evento `LANCIO_INTAKE`; nessun intake parte da qui (regola della rotta)."

- [ ] **Step 3: Etichetta dell'evento nella `ContactDrawer.tsx`**

In `getEventIcon`, dopo il `case 'INBOUND_MESSAGE'`:

```tsx
            case 'LANCIO_INTAKE': return <CalendarCheck className="h-4 w-4 text-amber-500" />
```

In `getEventLabel`, dopo il `case 'INBOUND_MESSAGE'`:

```tsx
            case 'LANCIO_INTAKE': return '🚀 Ingresso nel lancio Web Dev AI'
```

(`CalendarCheck` è già importato nel file; nessun import nuovo.)

- [ ] **Step 4: Documenta i tre valori di `provenienza`** in `docs/2026-09-05-lead-entranti-adozione.md`, sostituendo il paragrafo che inizia con `**\`provenienza\` resta grezza**`:

```markdown
**`provenienza` resta grezza** (uppercase e basta) per `TELEGRAM`, `INBOUND` o un funnel del CRM di
chi era già stato arruolato in passato: tradurla appiattirebbe una distinzione che sulle statistiche
di funnel deve restare vera. Dal 14/09 (lancio Web Dev AI, spec `2026-09-14-lancio-webdev-ottobre-design.md`
§5.6) esiste un terzo valore, **`Lancio Web Dev AI`**, che il bot manda quando il primo contatto è il
pulsante WhatsApp del webinar: il lead nasce con `funnel='Lancio Web Dev AI'` (canonico, non maiuscolo),
`launchBucket='LANCIO_WEBDEV_2026'`, `lancioIngresso='pulsante_webinar'`, assegnato al bot, con evento
`LANCIO_INTAKE`; sullo stesso numero si collega solo a un lead **già nel bucket** — un lead di un altro
funnel non ferma la creazione (duplicati cross-funnel voluti, decisione 1 del 14/09). Anche da qui
nessun intake: il bot ha già la chat. I lead di Telegram che scrivono per primi sono "roba molto
diversa" (PO, 14/09) e restano `TELEGRAM` con il flusso standard.
```

- [ ] **Step 5: Test completi, typecheck, commit**

```bash
npm test
npx tsc --noEmit
git add src/lib/bot-fissatore/adozione.ts src/lib/eventLogger.ts src/components/ContactDrawer.tsx docs/2026-09-05-lead-entranti-adozione.md
git commit -m "feat(lead-entrante): provenienza 'Lancio Web Dev AI' crea il lead nel bucket del lancio con LANCIO_INTAKE

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 14: Messa in produzione del CRM e verifica

**Repo:** CRM.

**Files:** nessuno nuovo (push e verifica).

**Interfaces:**
- Produces: `/api/bot/lead-entrante` in produzione che riconosce `provenienza='Lancio Web Dev AI'`.

- [ ] **Step 1: Push su `main`** (la produzione si aggiorna al push; la migrazione 0036 è già applicata dal Task 11)

```bash
cd "/c/Users/bruno/Desktop/CRM GDO"
git push origin main
```

- [ ] **Step 2: Verifica il deploy**

`vercel ls crm-sales-fenice --prod` dalla cartella del CRM (o `mcp__vercel__list_deployments`): l'ultimo deploy deve essere `READY` sul commit del Task 13.

- [ ] **Step 3: Verifica dal browser, sessione ADMIN** — `GET https://crm-sales-fenice.vercel.app/api/admin/lead-entranti?limit=50`: risponde 200 con il riepilogo (la rotta usa lo stesso `adottaLead`; nessuna scrittura). Serve solo a confermare che la build è viva e il modulo si carica.

La prova end-to-end con il pulsante si fa nel Task 10 del bot, quando entrambi i lati sono in produzione.

---

## PARTE C — Repo bot: i tre esiti e l'aggancio nel webhook

### Task 3: `lib/lancio-fase.ts` — `setLancioFase`

**Repo:** bot.

**Files:**
- Create: `lib/lancio-fase.ts`
- Test: `lib/lancio-fase.test.ts`

**Interfaces:**
- Consumes: `Database` tipizzato (Task 2), `getSupabaseAdmin` per il tipo `Supa`.
- Produces:
  - `type LancioFase = 'attesa' | 'posto_bloccato' | 'link_inviato' | 'post_pitch' | 'scelta_fatta' | 'followup_inviato' | 'restituito' | 'chiuso'`
  - `type LancioIngresso = 'lista' | 'pulsante_webinar'`
  - `const LANCIO_SLUG_WEBDEV = 'webdev-2026-10'`
  - `type LancioFaseExtra = { colonne?: { lancio_slug?: string; lancio_ingresso?: LancioIngresso; lancio_info?: Record<string, unknown>; lancio_link_inviato_at?: string; lancio_followup_inviato_at?: string; ai_status?: 'active' | 'closed' }; evento?: string; payload?: Record<string, unknown> }`
  - `setLancioFase(supabase: Supa, conversationId: number, fase: LancioFase, extra?: LancioFaseExtra): Promise<{ ok: true } | { ok: false; error: string }>`

- [ ] **Step 1: Controlla se B1 l'ha già creato**

```bash
cd "/c/Users/bruno/Desktop/Software Messaggistica"
ls lib/lancio-fase.ts 2>/dev/null && grep -n "export async function setLancioFase\|export type LancioFase\|LANCIO_SLUG_WEBDEV" lib/lancio-fase.ts
```

Se esiste con quei tre export e la firma `(supabase, conversationId, fase, extra?)`: salta al Task 4 (usa i suoi tipi). Se esiste con firma diversa, adegua **questo piano** ai suoi nomi nei Task 7-8 e non riscriverlo.

- [ ] **Step 2: Scrivi il test che fallisce** (`lib/lancio-fase.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { setLancioFase, LANCIO_SLUG_WEBDEV } from './lancio-fase';

/** Fake Supabase: traccia update su `conversations` e insert su `event_log`. */
function makeSupabase(updateError: { message: string } | null = null) {
  const calls = { updates: [] as any[], ids: [] as number[], events: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(payload: any) {
            calls.updates.push(payload);
            return { eq(_c: string, id: number) { calls.ids.push(id); return Promise.resolve({ error: updateError }); } };
          },
        };
      }
      return { insert(payload: any) { calls.events.push(payload); return Promise.resolve({}); } };
    },
  };
  return { supabase, calls };
}

describe('setLancioFase', () => {
  it('scrive la fase e le colonne extra in un solo update, e logga lancio_fase', async () => {
    const { supabase, calls } = makeSupabase();
    const res = await setLancioFase(supabase, 42, 'post_pitch', {
      colonne: { lancio_slug: LANCIO_SLUG_WEBDEV, lancio_ingresso: 'pulsante_webinar' },
    });
    expect(res).toEqual({ ok: true });
    expect(calls.updates).toEqual([{ lancio_fase: 'post_pitch', lancio_slug: 'webdev-2026-10', lancio_ingresso: 'pulsante_webinar' }]);
    expect(calls.ids).toEqual([42]);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]).toMatchObject({ type: 'lancio_fase', level: 'info' });
    expect(calls.events[0].payload).toMatchObject({ conversationId: 42, fase: 'post_pitch' });
  });

  it('usa il tipo di evento e il payload passati (es. lancio_pulsante)', async () => {
    const { supabase, calls } = makeSupabase();
    await setLancioFase(supabase, 7, 'post_pitch', { evento: 'lancio_pulsante', payload: { giaDiMario: true } });
    expect(calls.events[0]).toMatchObject({ type: 'lancio_pulsante' });
    expect(calls.events[0].payload).toMatchObject({ conversationId: 7, fase: 'post_pitch', giaDiMario: true });
  });

  it('se l update fallisce ritorna ok:false e logga a livello error, senza lanciare', async () => {
    const { supabase, calls } = makeSupabase({ message: 'boom' });
    const res = await setLancioFase(supabase, 9, 'chiuso');
    expect(res).toEqual({ ok: false, error: 'boom' });
    expect(calls.events[0]).toMatchObject({ type: 'lancio_fase', level: 'error' });
    expect(calls.events[0].payload).toMatchObject({ error: 'boom' });
  });
});
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

```bash
bun test lib/lancio-fase.test.ts
```

Atteso: FAIL (`Cannot find module './lancio-fase'`).

- [ ] **Step 4: Implementa `lib/lancio-fase.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** Slug del lancio Web Dev AI (webinar 5/10/2026). Spec §3.2. */
export const LANCIO_SLUG_WEBDEV = 'webdev-2026-10';

export type LancioFase =
  | 'attesa' | 'posto_bloccato' | 'link_inviato' | 'post_pitch'
  | 'scelta_fatta' | 'followup_inviato' | 'restituito' | 'chiuso';

export type LancioIngresso = 'lista' | 'pulsante_webinar';

export type LancioFaseExtra = {
  /** Altre colonne di `conversations` da scrivere nello STESSO update della fase. */
  colonne?: {
    lancio_slug?: string;
    lancio_ingresso?: LancioIngresso;
    lancio_info?: Record<string, unknown>;
    lancio_link_inviato_at?: string;
    lancio_followup_inviato_at?: string;
    ai_status?: 'active' | 'closed';
  };
  /** Tipo di riga in `event_log` (default `lancio_fase`). Spec §3.2: lancio_pulsante, lancio_scelta, ... */
  evento?: string;
  payload?: Record<string, unknown>;
};

/**
 * Unico punto che cambia `lancio_fase`. Un update solo (fase + colonne extra) e una riga
 * in `event_log`: chi legge il log ricostruisce la storia di una chat del lancio senza
 * guardare la tabella. Non lancia mai: chi chiama (webhook Twilio, cron) decide cosa
 * fare di un `ok:false`, e di solito e' "logga e vai avanti".
 */
export async function setLancioFase(
  supabase: Supa,
  conversationId: number,
  fase: LancioFase,
  extra: LancioFaseExtra = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('conversations')
    .update({ lancio_fase: fase, ...(extra.colonne ?? {}) })
    .eq('id', conversationId);

  await supabase.from('event_log').insert({
    type: extra.evento ?? 'lancio_fase',
    payload: {
      conversationId,
      fase,
      ...(extra.colonne ?? {}),
      ...(extra.payload ?? {}),
      error: error?.message ?? null,
    } as never,
    message: error
      ? `[lancio] conv ${conversationId}: fase ${fase} NON scritta — ${error.message}`
      : `[lancio] conv ${conversationId} → ${fase}`,
    level: error ? 'error' : 'info',
  });

  return error ? { ok: false, error: error.message } : { ok: true };
}
```

- [ ] **Step 5: Esegui il test e verifica che passi; commit**

```bash
bun test lib/lancio-fase.test.ts
bun run typecheck
git add lib/lancio-fase.ts lib/lancio-fase.test.ts
git commit -m "feat(bot): setLancioFase, l'unico punto che cambia la fase di una chat del lancio

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 4: `lib/primo-messaggio.ts` — i tre esiti, puri

**Repo:** bot.

**Files:**
- Create: `lib/primo-messaggio.ts`
- Test: `lib/primo-messaggio.test.ts`

**Interfaces:**
- Consumes: `funnelDaPrimoMessaggio`, `ProvenienzaInbound` da `lib/persona.ts` (branch, invariati).
- Produces:
  - `const PROVENIENZA_LANCIO_WEBDEV = 'Lancio Web Dev AI'`
  - `const TESTO_PULSANTE_WEBINAR = 'Ho seguito la live Web Developer AI e voglio saperne di più 🚀'`
  - `const MARKER_PULSANTE_WEBINAR = /live web developer ai/i`
  - `type ProvenienzaLeadEntrante = 'TELEGRAM' | 'INBOUND' | 'Lancio Web Dev AI'`
  - `type EsitoPrimoMessaggio = { tipo: 'telegram'; provenienza: 'TELEGRAM' } | { tipo: 'inbound'; provenienza: 'INBOUND' } | { tipo: 'lancio_pulsante'; provenienza: 'Lancio Web Dev AI' }`
  - `isMarkerPulsanteWebinar(body: string | null | undefined): boolean`
  - `classificaPrimoMessaggio(input: { primoInbound: string | null | undefined; inboundCorrente: string | null | undefined }): EsitoPrimoMessaggio`

- [ ] **Step 1: Scrivi i test che falliscono** (`lib/primo-messaggio.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  classificaPrimoMessaggio,
  isMarkerPulsanteWebinar,
  TESTO_PULSANTE_WEBINAR,
  PROVENIENZA_LANCIO_WEBDEV,
} from './primo-messaggio';

const TELEGRAM = 'Buongiorno, sono nel canale Telegram e mi hanno indicato questo contatto per più informazioni su Fenice Academy';

describe('isMarkerPulsanteWebinar', () => {
  it('riconosce il testo precompilato del pulsante (spec §6.3), anche senza emoji e in altro caso', () => {
    expect(isMarkerPulsanteWebinar(TESTO_PULSANTE_WEBINAR)).toBe(true);
    expect(isMarkerPulsanteWebinar('ho seguito la LIVE WEB DEVELOPER AI e voglio saperne di più')).toBe(true);
    expect(isMarkerPulsanteWebinar(`${TESTO_PULSANTE_WEBINAR}\nMi chiamo Sara`)).toBe(true);
  });
  it('non scatta su chi parla della live senza il marker, ne su null', () => {
    expect(isMarkerPulsanteWebinar('Ho visto la live ieri sera, quanto costa?')).toBe(false);
    expect(isMarkerPulsanteWebinar('Sono un web developer, mi interessa l AI')).toBe(false);
    expect(isMarkerPulsanteWebinar(null)).toBe(false);
    expect(isMarkerPulsanteWebinar('')).toBe(false);
  });
});

describe('classificaPrimoMessaggio — i tre esiti non si confondono (vincolo PO 14/09)', () => {
  it('1. link del canale Telegram sul primo inbound → TELEGRAM', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TELEGRAM, inboundCorrente: TELEGRAM }))
      .toEqual({ tipo: 'telegram', provenienza: 'TELEGRAM' });
    // Chi e' in arretrato e riscrive: la provenienza si legge dal PRIMO messaggio.
    expect(classificaPrimoMessaggio({ primoInbound: TELEGRAM, inboundCorrente: 'Scusa, poi rispondo' }))
      .toEqual({ tipo: 'telegram', provenienza: 'TELEGRAM' });
  });

  it('2. pulsante del webinar sull inbound CORRENTE → Lancio Web Dev AI', () => {
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_PULSANTE_WEBINAR, inboundCorrente: TESTO_PULSANTE_WEBINAR }))
      .toEqual({ tipo: 'lancio_pulsante', provenienza: PROVENIENZA_LANCIO_WEBDEV });
    // Chat gia' esistente (lead della lista, o un Telegram di agosto) che preme il
    // pulsante la sera del 5: il marker scatta sull'inbound corrente, non sul primo.
    expect(classificaPrimoMessaggio({ primoInbound: TELEGRAM, inboundCorrente: TESTO_PULSANTE_WEBINAR }).tipo)
      .toBe('lancio_pulsante');
    expect(classificaPrimoMessaggio({ primoInbound: 'Ciao, info?', inboundCorrente: TESTO_PULSANTE_WEBINAR }).tipo)
      .toBe('lancio_pulsante');
  });

  it('3. qualunque altro primo messaggio → INBOUND', () => {
    expect(classificaPrimoMessaggio({ primoInbound: 'Ciao, vorrei informazioni', inboundCorrente: 'Ciao, vorrei informazioni' }))
      .toEqual({ tipo: 'inbound', provenienza: 'INBOUND' });
    expect(classificaPrimoMessaggio({ primoInbound: 'Vorrei entrare nel canale telegram', inboundCorrente: 'Vorrei entrare nel canale telegram' }).tipo)
      .toBe('inbound');
    expect(classificaPrimoMessaggio({ primoInbound: 'Ho visto la live, quanto costa?', inboundCorrente: 'Ho visto la live, quanto costa?' }).tipo)
      .toBe('inbound');
    expect(classificaPrimoMessaggio({ primoInbound: null, inboundCorrente: null }).tipo).toBe('inbound');
  });

  it('il pulsante sul PRIMO inbound e un Telegram adesso non e lancio: conta l inbound corrente', () => {
    // Caso limite documentato: il marker del pulsante vale solo sul messaggio appena
    // arrivato. Se il primo era il pulsante e ora scrive la frase del canale, e' TELEGRAM.
    expect(classificaPrimoMessaggio({ primoInbound: TESTO_PULSANTE_WEBINAR, inboundCorrente: TELEGRAM }).tipo).toBe('telegram');
  });
});
```

Nota sull'ultimo test: il primo inbound con il marker e il corrente con la frase Telegram è un caso di laboratorio (in pratica un pulsante premuto in passato ha già portato la chat in `post_pitch` al momento giusto). Il test fissa la regola "scatta sull'inbound corrente" così nessuno la cambia per sbaglio.

- [ ] **Step 2: Esegui e verifica il fallimento**

```bash
bun test lib/primo-messaggio.test.ts
```

Atteso: FAIL (`Cannot find module './primo-messaggio'`).

- [ ] **Step 3: Implementa `lib/primo-messaggio.ts`**

```ts
import { funnelDaPrimoMessaggio } from './persona';

/**
 * Chi ci scrive per primo sul numero Fenice arriva da tre porte, e le tre non devono
 * mai confondersi (vincolo del PO, 14/09: "i lead di Telegram che scrivono sono roba
 * molto diversa"):
 *
 *  - il link del canale Telegram, che consegna una frase precompilata → TELEGRAM,
 *    flusso Mario standard, lead entrante normale sul CRM;
 *  - il pulsante WhatsApp mostrato la sera del webinar (spec lancio §6.3) → la chat
 *    entra nel lancio in fase `post_pitch`; se nasce adesso, il CRM la crea nel bucket
 *    del lancio;
 *  - tutto il resto → INBOUND, Mario standard.
 *
 * La provenienza Telegram/INBOUND si legge dal PRIMO inbound della conversazione (chi
 * riscrive dopo giorni non cambia porta). Il pulsante invece scatta sull'inbound
 * CORRENTE: il lead della lista d'attesa ha la chat aperta da settimane, e la preme la
 * sera del 5 — e' quel messaggio che conta, non il primo.
 */

export const PROVENIENZA_LANCIO_WEBDEV = 'Lancio Web Dev AI' as const;

/** Testo precompilato del link wa.me del pulsante (spec §6.3). Cambiarlo qui = cambiarlo nella pagina. */
export const TESTO_PULSANTE_WEBINAR = 'Ho seguito la live Web Developer AI e voglio saperne di più 🚀';

/** Marker del pulsante (spec §6.3). Sul nome della live, non sull'intera frase: un
 *  lead che aggiunge una riga o perde l'emoji resta riconosciuto. */
export const MARKER_PULSANTE_WEBINAR = /live web developer ai/i;

export type ProvenienzaLeadEntrante = 'TELEGRAM' | 'INBOUND' | typeof PROVENIENZA_LANCIO_WEBDEV;

export type EsitoPrimoMessaggio =
  | { tipo: 'telegram'; provenienza: 'TELEGRAM' }
  | { tipo: 'inbound'; provenienza: 'INBOUND' }
  | { tipo: 'lancio_pulsante'; provenienza: typeof PROVENIENZA_LANCIO_WEBDEV };

export function isMarkerPulsanteWebinar(body: string | null | undefined): boolean {
  return MARKER_PULSANTE_WEBINAR.test(body ?? '');
}

export function classificaPrimoMessaggio(input: {
  primoInbound: string | null | undefined;
  inboundCorrente: string | null | undefined;
}): EsitoPrimoMessaggio {
  if (isMarkerPulsanteWebinar(input.inboundCorrente)) {
    return { tipo: 'lancio_pulsante', provenienza: PROVENIENZA_LANCIO_WEBDEV };
  }
  return funnelDaPrimoMessaggio(input.primoInbound) === 'TELEGRAM'
    ? { tipo: 'telegram', provenienza: 'TELEGRAM' }
    : { tipo: 'inbound', provenienza: 'INBOUND' };
}
```

- [ ] **Step 4: Esegui i test (anche quelli di `persona.test.ts`, che non devono cambiare) e commit**

```bash
bun test lib/primo-messaggio.test.ts lib/persona.test.ts
git add lib/primo-messaggio.ts lib/primo-messaggio.test.ts
git commit -m "feat(bot): tre porte per chi scrive per primo — Telegram, pulsante del webinar, altro

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 5: `shouldAdoptInbound` — il pulsante adotta anche una chat con storia

**Repo:** bot.

**Files:**
- Modify: `lib/fenice-autoreply.ts` (`AdoptGate` e `shouldAdoptInbound`, ~righe 95-115 dopo il merge)
- Test: `lib/fenice-autoreply.test.ts` (blocco `describe('shouldAdoptInbound')` del branch)

**Interfaces:**
- Consumes: `AdoptGate` del branch (`toMatchesFenice, adoptionOn, autoReplyOn, aiOwner, aiPausedAt, handedOffAt, hasOutbound`).
- Produces: `AdoptGate.lancioPulsante?: boolean`; con `true` la sola condizione `hasOutbound` non blocca più (le altre restano).

Perché: chi preme il pulsante da un numero che anni fa ha ricevuto un'agenda da un GDO ha una chat con outbound e `ai_owner` nullo. Con la regola attuale non verrebbe adottato e nessuno gli risponderebbe la sera del webinar. Il pulsante è una richiesta esplicita fatta adesso: pesa più della storia della chat. I veti che restano (bot spento, pausa manuale, passata a una persona, chat già di Mario) sono veti di sicurezza e non si toccano.

- [ ] **Step 1: Aggiungi i test** dentro il `describe('shouldAdoptInbound', ...)` esistente

```ts
  it('con il pulsante del webinar una chat con outbound in passato si adotta lo stesso', () => {
    expect(shouldAdoptInbound({ ...base, hasOutbound: true, lancioPulsante: true })).toBe(true);
  });
  it('il pulsante non scavalca gli altri veti: bot spento, pausa, passata a una persona, chat di Mario', () => {
    expect(shouldAdoptInbound({ ...base, lancioPulsante: true, autoReplyOn: false })).toBe(false);
    expect(shouldAdoptInbound({ ...base, lancioPulsante: true, adoptionOn: false })).toBe(false);
    expect(shouldAdoptInbound({ ...base, lancioPulsante: true, aiPausedAt: '2026-10-05T20:00:00Z' })).toBe(false);
    expect(shouldAdoptInbound({ ...base, lancioPulsante: true, handedOffAt: '2026-10-05T20:00:00Z' })).toBe(false);
    expect(shouldAdoptInbound({ ...base, lancioPulsante: true, aiOwner: 'mario' })).toBe(false);
  });
```

dove `base` è l'oggetto "tutto ok" già usato dai test del branch in quel blocco (`toMatchesFenice: true, adoptionOn: true, autoReplyOn: true, aiOwner: null, aiPausedAt: null, handedOffAt: null, hasOutbound: false`). Se il blocco non ha un `base`, definiscilo in testa al `describe` con quei valori.

- [ ] **Step 2: Esegui e verifica il fallimento**

```bash
bun test lib/fenice-autoreply.test.ts -t shouldAdoptInbound
```

Atteso: il primo test nuovo FAIL (`expected false to be true`); `tsc` segnalerebbe anche la proprietà sconosciuta.

- [ ] **Step 3: Implementa**

In `AdoptGate` aggiungi:

```ts
  /** L'inbound corrente e' il pulsante del webinar (lib/primo-messaggio.ts): la storia
   *  della chat non conta, la richiesta e' esplicita e fatta adesso. */
  lancioPulsante?: boolean;
```

e in `shouldAdoptInbound` l'ultima riga diventa:

```ts
  if (g.lancioPulsante) return true;
  return !g.hasOutbound;
```

- [ ] **Step 4: Test verdi e commit**

```bash
bun test lib/fenice-autoreply.test.ts
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(bot): il pulsante del webinar adotta anche una chat con una storia alle spalle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 6: `pushLeadEntrante` con la provenienza a tre valori

**Repo:** bot.

**Files:**
- Modify: `lib/lead-entrante.ts` (tipo `PushLeadEntranteArgs.provenienza`, riga ~17)
- Test: `lib/lead-entrante.test.ts`
- Modify: `.env.example` (commento su `INBOUND_ADOPTION_ENABLED`)

**Interfaces:**
- Consumes: `ProvenienzaLeadEntrante` (Task 4).
- Produces: `PushLeadEntranteArgs.provenienza: ProvenienzaLeadEntrante`; il corpo del push porta `"provenienza": "Lancio Web Dev AI"` verbatim (il CRM lo normalizza lui).

- [ ] **Step 1: Test che fallisce** (in coda al `describe('pushLeadEntrante')`)

```ts
  it('provenienza "Lancio Web Dev AI" viaggia com e, senza maiuscole: la normalizza il CRM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ ok: true, leadId: 'uuid-l', creato: true }),
    })));
    const { supabase, calls } = makeSupabase();
    const res = await pushLeadEntrante(supabase, { ...ARGS, provenienza: 'Lancio Web Dev AI', primoMessaggio: 'Ho seguito la live Web Developer AI e voglio saperne di più 🚀' });
    expect(res).toEqual({ ok: true, leadId: 'uuid-l' });
    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(JSON.parse(init.body).provenienza).toBe('Lancio Web Dev AI');
    expect(calls.updates).toEqual([{ crm_lead_id: 'uuid-l' }]);
    expect(calls.events.find((e) => e.type === 'lead_entrante_push').payload.provenienza).toBe('Lancio Web Dev AI');
  });
```

- [ ] **Step 2: Esegui: deve passare già a runtime ma fallire al typecheck** (la proprietà è `string` oggi: il test passa; `tsc` non si lamenta). Il valore del passo è fissare il contratto; prosegui.

- [ ] **Step 3: Stringi il tipo in `lib/lead-entrante.ts`**

```ts
import type { ProvenienzaLeadEntrante } from './primo-messaggio';
...
  /** 'TELEGRAM' | 'INBOUND' | 'Lancio Web Dev AI' (lib/primo-messaggio.ts). Il CRM la
   *  normalizza (trim/uppercase) e riconosce il lancio a prescindere dal caso. */
  provenienza: ProvenienzaLeadEntrante;
```

`app/api/cron/adotta-mai-risposti/route.ts` e il webhook (Task 7-8) passano già un valore compatibile dopo i loro task; se `tsc` si lamenta qui prima di quei task, è atteso: chiudi Task 7 e 8 e rilancia.

- [ ] **Step 4: `.env.example`** — sostituisci il commento sopra `INBOUND_ADOPTION_ENABLED`:

```
# Il bot prende in carico chi scrive per primo sul numero Fenice, senza passare dal CRM.
# '1' per accendere. Tre porte (lib/primo-messaggio.ts): link Telegram → TELEGRAM, pulsante
# del webinar → lancio post_pitch + 'Lancio Web Dev AI', altro → INBOUND. Il push al CRM
# (/api/bot/lead-entrante) parte in ogni caso; il CRM riconosce le tre provenienze.
INBOUND_ADOPTION_ENABLED=0
```

- [ ] **Step 5: Test e commit**

```bash
bun test lib/lead-entrante.test.ts
git add lib/lead-entrante.ts lib/lead-entrante.test.ts .env.example
git commit -m "feat(bot): il push al CRM porta la provenienza a tre valori, lancio compreso

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 7: Aggancio nel webhook Twilio

**Repo:** bot.

**Files:**
- Modify: `app/api/webhooks/twilio/route.ts` (import in testa; blocco `if (toMatchesFenice) { ... }`, ~righe 180-300 dopo il merge)

**Interfaces:**
- Consumes: `isMarkerPulsanteWebinar`, `classificaPrimoMessaggio` (Task 4); `setLancioFase`, `LANCIO_SLUG_WEBDEV` (Task 3); `shouldAdoptInbound` con `lancioPulsante` (Task 5); `pushLeadEntrante` (Task 6); variabili locali già presenti: `supabase`, `conversationId`, `phone`, `messageBody`, `now`, `toMatchesFenice`.
- Produces: su ogni inbound al numero Fenice con il marker del pulsante → `lancio_fase='post_pitch'` (+ `lancio_slug`, `lancio_ingresso` se mancava, riapertura se `closed`), evento `lancio_pulsante` con `payload.giaDiMario`; adozione a tre esiti con push al CRM in `after()`.

Il webhook non ha un test di route (non ne esiste uno su `main` né sul branch: Twilio firma la richiesta e la rotta è un'orchestrazione). La copertura sta nelle tre funzioni pure (Task 3-5) e nella verifica dal vivo del Task 10. Qui si cambia il minimo e si rilegge il diff con cura.

- [ ] **Step 1: Import**

Sostituisci `import { funnelDaPrimoMessaggio } from '@/lib/persona';` con:

```ts
import { classificaPrimoMessaggio, isMarkerPulsanteWebinar } from '@/lib/primo-messaggio';
import { setLancioFase, LANCIO_SLUG_WEBDEV } from '@/lib/lancio-fase';
```

- [ ] **Step 2: Allarga la `select` della conversazione**

```ts
        .select('ai_owner, ai_status, ai_paused_at, handed_off_at, crm_lead_id, bot_outcome, lancio_slug, lancio_fase, lancio_ingresso')
```

- [ ] **Step 3: Marker del pulsante, PRIMA dell'adozione e a prescindere da chi possiede la chat**

Subito dopo `const autoReplyOn = await getAutoReply(supabase);` (riga del branch) inserisci:

```ts
      // Pulsante del webinar (spec lancio §5.4, §6.3): scatta sull'inbound CORRENTE e
      // anche su una chat gia' di Mario — il lead della lista ha la chat aperta da
      // settimane e preme il pulsante la sera del 5. Non e' gatato da
      // INBOUND_ADOPTION_ENABLED: il testo del pulsante non esiste in pubblico prima
      // del 5/10, e la fase serve a B4 in ogni caso. Se la chat era 'chiuso' (un no
      // di settimane fa) si riapre: sta scrivendo adesso.
      const lancioPulsante = isMarkerPulsanteWebinar(messageBody);
      if (conv && lancioPulsante) {
        const riapri = conv.ai_owner === 'mario' && conv.ai_status === 'closed';
        await setLancioFase(supabase, conversationId, 'post_pitch', {
          colonne: {
            lancio_slug: conv.lancio_slug ?? LANCIO_SLUG_WEBDEV,
            ...(conv.lancio_ingresso ? {} : { lancio_ingresso: 'pulsante_webinar' }),
            ...(riapri ? { ai_status: 'active' } : {}),
          },
          evento: 'lancio_pulsante',
          payload: { phone, giaDiMario: conv.ai_owner === 'mario', faseprecedente: conv.lancio_fase ?? null },
        });
        if (riapri) conv.ai_status = 'active';
      }
```

- [ ] **Step 4: Adozione a tre esiti**

Nel blocco `if (adozioneAttiva && autoReplyOn && conv && conv.ai_owner === null) { ... }` del branch:

1. nella chiamata a `shouldAdoptInbound({...})` aggiungi `lancioPulsante,` dopo `hasOutbound,`;
2. sostituisci `const provenienza = funnelDaPrimoMessaggio(primoMessaggioTesto);` con:

```ts
          const esito = classificaPrimoMessaggio({ primoInbound: primoMessaggioTesto, inboundCorrente: messageBody });
          const provenienza = esito.provenienza;
```

3. nell'`event_log` di `inbound_adottato` il `payload` diventa `{ conversationId, phone, provenienza, tipo: esito.tipo } as never` e il `message` `` `[bot-fissatore] adottato ${phone}: ha scritto per primo (${provenienza})` `` resta;
4. `after(pushLeadEntrante(supabase, { ..., provenienza, ... }))` resta com'è: `provenienza` ora è già del tipo a tre valori.

Il commento del branch "La provenienza si legge dal PRIMO messaggio…" resta vero per Telegram/INBOUND; aggiungi sotto una riga: `// Il pulsante del webinar fa eccezione e si legge dal messaggio corrente: vedi lib/primo-messaggio.ts.`

- [ ] **Step 5: Typecheck, tutti i test, rilettura del diff**

```bash
bun run typecheck
bun test
git diff app/api/webhooks/twilio/route.ts
```

Controlla nel diff: (a) `setLancioFase` è `await`ata prima della risposta a Twilio (un update, costo trascurabile) e il push resta in `after()`; (b) il ramo del marker sta **fuori** dal ramo dell'adozione; (c) `conv.ai_status='active'` in memoria dopo la riapertura, così `shouldAutoReply` più sotto lascia rispondere Mario.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/twilio/route.ts
git commit -m "feat(bot): il pulsante del webinar porta la chat in post_pitch e l'adozione distingue le tre porte

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 8: Cron `adotta-mai-risposti` con la stessa classificazione

**Repo:** bot.

**Files:**
- Modify: `app/api/cron/adotta-mai-risposti/route.ts` (import riga 5; blocco `provenienza` ~riga 137; dopo l'adozione riuscita ~riga 158)

**Interfaces:**
- Consumes: `classificaPrimoMessaggio` (Task 4), `setLancioFase`, `LANCIO_SLUG_WEBDEV` (Task 3).
- Produces: il recupero dei "mai risposti" classifica come il webhook; se il primo (e unico) inbound era il pulsante, la chat entra in `post_pitch` prima del riaggancio.

- [ ] **Step 1: Import**

Sostituisci `import { funnelDaPrimoMessaggio } from '@/lib/persona';` con:

```ts
import { classificaPrimoMessaggio } from '@/lib/primo-messaggio';
import { setLancioFase, LANCIO_SLUG_WEBDEV } from '@/lib/lancio-fase';
```

- [ ] **Step 2: Classificazione**

Sostituisci `const provenienza = funnelDaPrimoMessaggio(primoRiga?.body);` con:

```ts
      // Qui il primo inbound e' anche l'ultimo: la chat ha un solo messaggio, il suo.
      const esito = classificaPrimoMessaggio({ primoInbound: primoRiga?.body, inboundCorrente: primoRiga?.body });
      const provenienza = esito.provenienza;
```

- [ ] **Step 3: Fase lancio dopo l'adozione riuscita**

Subito dopo `if (!adottate || adottate.length === 0) { giaPrese++; continue; }` aggiungi:

```ts
      if (esito.tipo === 'lancio_pulsante') {
        await setLancioFase(admin, c.id, 'post_pitch', {
          colonne: { lancio_slug: LANCIO_SLUG_WEBDEV, lancio_ingresso: 'pulsante_webinar' },
          evento: 'lancio_pulsante',
          payload: { phone: l.phone, giaDiMario: false, daCron: 'adotta-mai-risposti' },
        });
      }
```

- [ ] **Step 4: Typecheck, test, commit**

```bash
bun run typecheck
bun test
git add app/api/cron/adotta-mai-risposti/route.ts
git commit -m "feat(bot): il recupero dei mai risposti classifica come il webhook, pulsante compreso

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 9: Merge su `main` e deploy (adozione ancora spenta)

**Repo:** bot.

**Files:** nessuno nuovo.

**Interfaces:**
- Produces: `main` del bot contiene il branch integrato + B2; produzione aggiornata con `INBOUND_ADOPTION_ENABLED` assente (= spento).

- [ ] **Step 1: Ultima verifica sul branch**

```bash
cd "/c/Users/bruno/Desktop/Software Messaggistica"
git status --short          # pulito
bun run typecheck && bun test && bun run lint
```

- [ ] **Step 2: Merge su `main` e push**

```bash
git checkout main
git pull --ff-only
git merge --no-ff feat/lead-scrivono-per-primi -m "merge feat/lead-scrivono-per-primi: adozione di chi scrive per primo + tre porte (Telegram, pulsante webinar, altro) — B2 del lancio Web Dev AI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
git push origin main
```

Se `git pull` porta commit nuovi che confliggono col branch, risolvi sul branch (`git checkout feat/... && git merge main`) con la regola di §0 e rifai lo Step 2.

- [ ] **Step 3: Verifica il deploy**

`vercel ls --prod` dalla cartella del bot (o `mcp__vercel__list_deployments` sul progetto `web-app-messaggistica`): ultimo deploy `READY` sul merge commit. Poi `mcp__vercel__get_runtime_logs` (o `vercel logs`) per i primi minuti: nessun errore di modulo (`lancio-fase`, `primo-messaggio`).

- [ ] **Step 4: Controllo che l'adozione sia davvero spenta** — nella tabella `event_log` del bot:

```sql
select type, count(*) from event_log where created_at > now() - interval '30 minutes' and type in ('inbound_adottato','inbound_adozione_fallita','lancio_pulsante') group by 1;
```

Atteso: nessuna riga `inbound_adottato` (flag assente).

---

### Task 10: Accensione `INBOUND_ADOPTION_ENABLED=1` e verifica dal vivo dei tre casi

**Repo:** bot (env Vercel) + verifica sul CRM.

**Files:**
- Modify: `docs/crm/2026-09-04-lead-che-scrivono-per-primi.md` (riga ~118, elenco dei valori di `provenienza`)

**Interfaces:**
- Produces: B2 acceso in produzione; documento del contratto aggiornato.

**Prerequisiti:** Task 14 (CRM in produzione) e Task 9 completati. Un numero WhatsApp di test **non** presente nel CRM come lead Fenice (verifica con la ricerca della Topbar; se c'è, usa un altro numero).

- [ ] **Step 1: Aggiungi la env e ridistribuisci**

```bash
cd "/c/Users/bruno/Desktop/Software Messaggistica"
printf '1' | vercel env add INBOUND_ADOPTION_ENABLED production
vercel env ls | grep INBOUND_ADOPTION_ENABLED     # deve comparire per production
git commit --allow-empty -m "chore(bot): accensione INBOUND_ADOPTION_ENABLED=1 (B2 lancio)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
git push origin main
```

(Le env si applicano solo a un deploy nuovo: il commit vuoto lo fa partire.) Attendi `READY`.

- [ ] **Step 2: Caso 2 — pulsante del webinar, numero sconosciuto**

Dal numero di test manda al numero Fenice esattamente `Ho seguito la live Web Developer AI e voglio saperne di più 🚀`. Entro un minuto:

```sql
-- bot
select id, ai_owner, ai_status, crm_funnel, crm_lead_id, lancio_slug, lancio_fase, lancio_ingresso
from conversations where id = (select conversation_id from messages where direction='in' order by created_at desc limit 1);
select type, level, payload from event_log where created_at > now() - interval '5 minutes' and type in ('lancio_pulsante','inbound_adottato','lead_entrante_push','lead_entrante_push_error') order by created_at;
```

Atteso: `ai_owner='mario'`, `crm_funnel='Lancio Web Dev AI'`, `crm_lead_id` valorizzato, `lancio_slug='webdev-2026-10'`, `lancio_fase='post_pitch'`, `lancio_ingresso='pulsante_webinar'`; eventi `lancio_pulsante` (`giaDiMario:false`), `inbound_adottato` (`tipo:'lancio_pulsante'`), `lead_entrante_push` (`creato:true`). Nel CRM (ContactDrawer, ricerca per numero): lead con funnel `Lancio Web Dev AI`, assegnato a GDO 201, timeline `Lead Importato` → `Assegnato a GDO` → `🚀 Ingresso nel lancio Web Dev AI` → `💬 Ha scritto lui su WhatsApp`; in DB `launchBucket='LANCIO_WEBDEV_2026'`, `lancioIngresso='pulsante_webinar'`, `source='whatsapp-inbound'`. Mario risponde (prompt standard: quello di `post_pitch` è B4).

- [ ] **Step 3: Caso 2-bis — pulsante su chat già esistente**

Dallo stesso numero rimanda il testo del pulsante. Atteso: nessuna nuova adozione, nessun push, un nuovo evento `lancio_pulsante` con `giaDiMario:true`; `lancio_ingresso` invariato.

- [ ] **Step 4: Caso 1 — link Telegram, secondo numero di test sconosciuto**

Manda `Buongiorno, sono nel canale Telegram e mi hanno indicato questo contatto per più informazioni su Fenice Academy`. Atteso: `crm_funnel='TELEGRAM'`, `lancio_*` tutti `NULL`, nessun `lancio_pulsante`; nel CRM lead con funnel `TELEGRAM`, senza bucket, eventi `IMPORTED`+`ASSIGNED`+`INBOUND_MESSAGE` e nessun `LANCIO_INTAKE`.

- [ ] **Step 5: Caso 3 — altro primo messaggio, terzo numero di test** (o riusa il secondo dopo aver chiuso a mano la chat e cancellato il lead di prova)

Manda `Ciao, vorrei informazioni`. Atteso: `crm_funnel='INBOUND'`, `lancio_*` `NULL`; nel CRM funnel `INBOUND`, senza bucket.

- [ ] **Step 6: Pulizia dei lead di prova nel CRM** — dalla ContactDrawer scarta i lead di test (`DA_SCARTARE`, motivo "test") o cancellali via SQL se è la prassi del PO; nel bot lascia le conversazioni (sono la prova del collaudo) ma chiudile (`ai_status='closed'`) così nessun cron le tocca.

- [ ] **Step 7: Documento del contratto**

In `docs/crm/2026-09-04-lead-che-scrivono-per-primi.md`, riga dell'elenco `**\`provenienza\`**`, aggiungi il terzo valore:

```markdown
- **`provenienza`** — `"TELEGRAM"` per chi apre con la frase del canale, `"INBOUND"` per
  qualunque altro primo messaggio, `"Lancio Web Dev AI"` per chi arriva dal pulsante WhatsApp
  del webinar (marker `/live web developer ai/i`, testo in `lib/primo-messaggio.ts`): in quel
  caso la chat entra in `lancio_fase='post_pitch'` e il CRM crea il lead nel bucket del lancio.
```

```bash
git add docs/crm/2026-09-04-lead-che-scrivono-per-primi.md
git commit -m "docs(crm): il terzo valore di provenienza, Lancio Web Dev AI

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
git push origin main
```

- [ ] **Step 8: Segnala** nel report finale dell'esecuzione: numeri di test usati, `conversationId` e `leadId` dei tre casi, e se il caso 2 ha avuto `crm_lead_id` scritto **prima** della prima risposta di Mario (guarda `created_at` di `lead_entrante_push` contro il primo outbound): è la garanzia che B4 si aspetta.

---

## Rischi e note per chi esegue

- **B1 non ancora su `main`** (il piano B1 è previsto per il 18/09, B2 per il 22/09): i Task 2, 3 e 11 hanno un passo "controlla se B1 l'ha già fatto" con SQL idempotente. Se B1 arriva **dopo** B2, chi esegue B1 deve riusare `lib/lancio-fase.ts` e `src/lib/lancio/costanti.ts` di qui.
- **Prompt di `post_pitch`** non è in questo blocco (B4): fra l'accensione di B2 e B4 un pulsante premuto porta la chat in `post_pitch` ma Mario risponde col prompt standard. Il testo del pulsante non è pubblico prima del 5/10, quindi il caso è solo di collaudo.
- **`registraEsitoSenzaLeadId` vs lotto A**: il rischio vero del merge non è il diff ma i test (§0). Budget: se l'allineamento supera un'ora di lavoro, fermati e riporta cosa diverge — è una decisione da prendere con il PO, non da risolvere a intuito.
- **Numero a qualità LOW**: B2 non manda template nuovi (l'adozione risponde a testo libero dentro la finestra 24 h; il riaggancio del cron usa un template già in allow-list). Nessun rischio nuovo sul numero.
- **Un push `network_error` è già arrivato** (memoria del 09/09): vale anche per `lead-entrante`; il CRM è idempotente per numero, un doppio push non crea due lead.

## Self-review (fatta al momento della stesura)

- **Copertura spec §5.6:** rebase/merge → Task 1; accensione → Task 10; `funnelDaPrimoMessaggio` esteso (modulo nuovo `primo-messaggio.ts`, tre esiti, marker sull'inbound corrente anche su chat esistente) → Task 4, 7; CRM `lead-entrante` con provenienza lancio → Task 11-13. §6.3 (testo e marker del pulsante) → Task 4. §6.2 riga `lead-entrante` → Task 13. §9 interruttore → Task 10. Fuori perimetro e non trattati di proposito: badge/filtro "Lancio" nei pannelli `/fenice` e `/chat` (ultima riga di §5.6: appartiene a B1 "badge pannelli" per la tabella di §9).
- **Placeholder:** nessun "TBD/TODO"; ogni passo "controlla se B1" ha un `grep` e un criterio esplicito.
- **Coerenza dei nomi:** `setLancioFase(supabase, conversationId, fase, extra?)` con `extra.colonne/evento/payload` uguale in Task 3, 7, 8; `classificaPrimoMessaggio({ primoInbound, inboundCorrente })` uguale in Task 4, 7, 8; `AdoptGate.lancioPulsante` uguale in Task 5 e 7; `isProvenienzaLancioWebDev`, `candidatiPerAdozione`, `valoriNuovoLead(lead, botId, adesso, id)`, `eventiNuovoLead(lead, valori)` uguali in Task 12 e 13; costanti `LANCIO_WEBDEV_FUNNEL/BUCKET/SLUG` uguali in Task 11-13 e `LANCIO_SLUG_WEBDEV` lato bot con lo stesso valore `webdev-2026-10`.
