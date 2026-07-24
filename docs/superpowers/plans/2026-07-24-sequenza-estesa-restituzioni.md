# Sequenza Estesa Anti-Restituzioni — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ridurre i lead restituiti al CRM da 79,6% a ≤50% con: scarto automatico numeri morti (criterio CONSEGNA), sequenza 5-touch/12gg per i mai-risposto, nudge di riaggancio per le interrotte, watchdog sui lead incastrati, capacità 50 lead/giorno.

**Architecture:** Zero migrazioni DB: lo stato Track A si deriva dai `messages` (template SID sequenza + `twilio_status`); il contatore nudge Track B riusa `conversations.bot_followups_sent` (esistente, oggi inutilizzato). Nuovo cron `sequence-touches` (invii, ogni 30' in fascia diurna) + rework del cron `bot-followups` (classificazioni finali + watchdog, orario). Logica pura in `lib/sequence.ts` (TDD).

**Tech Stack:** Next.js App Router, Supabase (service role), Twilio Content API, Vitest.

## Global Constraints

- Contratto CRM INVARIATO: esiti APPUNTAMENTO | DA_SCARTARE | RICHIAMO | NON_RISPOSTO | INTERROTTO; HMAC `x-bot-signature`; `date` ISO con offset obbligatoria per APPUNTAMENTO/RICHIAMO. Non toccare `lib/bot-contract.ts` né `lib/bot-hmac.ts`.
- Fuori dalla finestra 24h dall'ultimo inbound del lead: SOLO template approvati (mai `sendFreeText`).
- Criterio "numero morto" = CONSEGNA (`twilio_status` in `delivered`/`read`), MAI la lettura da sola.
- Kill-switch: ogni invio della sequenza è dietro `process.env.SEQUENCE_ENABLED === '1'`.
- Cap per run: `SEQUENCE_MAX_PER_RUN` (default 25).
- Errore Twilio 63049 (frequency cap Meta per-utente): il touch NON è consumato, si ritenta al run successivo.
- Sender sequenza: `process.env.TWILIO_WHATSAPP_NUMBER_FOLLOWUP ?? process.env.TWILIO_WHATSAPP_NUMBER_FENICE`.
- NON toccare il flusso dei lead che rispondono e fissano (webhook Twilio → Mario): funziona.
- Tutti gli orari lato utente in Europe/Rome; fascia invii 08:30–20:30.
- Test: `npx vitest run <file>`; typecheck `npx tsc --noEmit`. Commit frequenti su branch `feat/sequenza-estesa`.

---

### Task 1: `lib/sequence.ts` — logica pura della sequenza (TDD)

**Files:**
- Create: `lib/sequence.ts`
- Test: `lib/sequence.test.ts`

**Interfaces (Produces):**
```ts
export const TOUCH_OFFSETS_DAYS: number[]; // [1, 3, 7, 12] — offset follow-up dal PRIMO outbound
export const SEQUENCE_END_DAYS = 14;       // classificazione finale Track A
export const NUDGE1_MIN_H = 18; export const NUDGE1_MAX_H = 24;
export const NUDGE2_H = 48; export const NUDGE3_H = 96;
export const TRACKB_GIVEUP_H = 120;

export type MsgLite = { direction: string; twilio_status: string | null; template_sid: string | null; created_at: string; is_template?: boolean };

export function inSendWindow(nowMs: number): boolean; // 08:30–20:30 Europe/Rome (usare Intl con timeZone)
export function anyDelivered(msgs: MsgLite[]): boolean; // qualche out con status delivered|read
export function allOutboundDeadNoDelivery(msgs: MsgLite[]): boolean; // >=1 out, nessuno delivered/read, tutti undelivered|failed
export function countSequenceTouches(msgs: MsgLite[], seqSids: string[]): number; // out con template_sid in seqSids
export function firstOutboundAtMs(msgs: MsgLite[]): number | null;
export function lastOutboundAtMs(msgs: MsgLite[]): number | null;

export type TrackAAction =
  | { kind: 'send_opening' }                       // conv CRM senza alcun outbound (apertura differita)
  | { kind: 'send_touch'; touchIndex: number }     // 1..4 → template variante touchIndex
  | { kind: 'discard_dead' }                       // fine (o fast-fail): mai consegnato nulla
  | { kind: 'non_risposto' }                       // giorno 14, consegnato ma muto
  | { kind: 'wait' };

export function decideTrackA(input: {
  nowMs: number;
  msgs: MsgLite[];        // messaggi della conv dall'arruolamento
  seqSids: string[];      // SID dei 4 template follow-up
  sequenceEnabled: boolean;
}): TrackAAction;

export type TrackBAction =
  | { kind: 'nudge_free' }      // 18–24h di silenzio, in-window 24h, nudgesSent=0
  | { kind: 'nudge_template'; nudgeIndex: 1 | 2 } // 48h / 96h, template re-engagement
  | { kind: 'classify' }        // ≥120h di silenzio → INTERROTTO o DA_SCARTARE (Task 4)
  | { kind: 'wait' };

export function decideTrackB(input: {
  nowMs: number;
  lastInboundAtMs: number;
  nudgesSent: number;           // conversations.bot_followups_sent
  sequenceEnabled: boolean;
}): TrackBAction;

export function pickNudgeText(conversationId: number, firstName: string | null): string; // 3 varianti a rotazione (id % 3)
```

**Regole di decisione (da codificare esattamente):**
- `decideTrackA`: se nessun outbound → `send_opening` solo se `inSendWindow && sequenceEnabled`, altrimenti `wait`. Con outbound: `t0 = firstOutboundAtMs`. Fast-fail: `touches>=1 && allOutboundDeadNoDelivery && now-t0>=48h` → `discard_dead`. Fine: `now-t0 >= 14g` → `anyDelivered ? non_risposto : discard_dead` (questa via NON dipende da sequenceEnabled: la classificazione finale scatta comunque). Touch: se `touches < TOUCH_OFFSETS_DAYS.length` e `now-t0 >= TOUCH_OFFSETS_DAYS[touches]` giorni e `inSendWindow` e `sequenceEnabled` e `now - lastOutboundAtMs >= 20h` (anti-doppione) → `send_touch(touches+1)`. Altrimenti `wait`.
- `decideTrackB`: `silH = (now-lastInbound)/h`. `>=120` → `classify`. `nudgesSent==0 && silH in [18,24) && inSendWindow` → `nudge_free`. `nudgesSent==1 && silH>=48 && inSendWindow` → `nudge_template(1)`. `nudgesSent==2 && silH>=96 && inSendWindow` → `nudge_template(2)`. Altrimenti `wait`. I nudge richiedono `sequenceEnabled`; `classify` no.

**Steps:**
- [ ] **Step 1:** Scrivi `lib/sequence.test.ts` con casi: inSendWindow (07:00 Rome no, 09:00 sì, 21:00 no — costruire date UTC di luglio, Rome=UTC+2); anyDelivered/allOutboundDeadNoDelivery (delivered, read, undelivered+failed, out mancanti); decideTrackA: apertura differita in/fuori finestra, fast-fail 63024 a 48h, touch 1 dovuto a +1g, anti-doppione (<20h dall'ultimo out), non_risposto a 14g con delivered, discard_dead a 14g senza consegne, kill-switch (sequenceEnabled=false → wait sui touch ma classificazioni attive); decideTrackB: 12h wait, 20h nudge_free, 20h fuori fascia wait, 50h con nudgesSent=1 → nudge_template(1), 120h → classify.
- [ ] **Step 2:** `npx vitest run lib/sequence.test.ts` → FAIL (modulo mancante).
- [ ] **Step 3:** Implementa `lib/sequence.ts` (pura, zero I/O; `inSendWindow` via `Intl.DateTimeFormat('it-IT',{timeZone:'Europe/Rome',hour:'numeric',minute:'numeric',hour12:false})`).
- [ ] **Step 4:** `npx vitest run lib/sequence.test.ts` → PASS; `npx tsc --noEmit` → clean.
- [ ] **Step 5:** `git add lib/sequence.ts lib/sequence.test.ts && git commit -m "feat(sequence): logica pura sequenza estesa Track A/B"`.

---

### Task 2: `lib/interrotto-note.ts` — classificazione finale Track B con nota ricca (R5)

**Files:**
- Create: `lib/interrotto-note.ts`
- Test: `lib/interrotto-note.test.ts` (solo parte pura: parsing + fallback)

**Interfaces:**
- Consumes: `MarioTurn` da `lib/mario.ts` (`{ role: 'user'|'assistant'; content: string }`).
- Produces:
```ts
export type InterruptedVerdict = { discard: boolean; discardReason?: string; note: string };
export function parseInterruptedVerdict(raw: string, fallback: { lastLeadMsg: string }): InterruptedVerdict;
export async function classifyInterrupted(history: MarioTurn[]): Promise<InterruptedVerdict>;
```
- `classifyInterrupted`: chiama Anthropic (stesso pattern/client di `lib/mario-summary.ts` → `generateLeadSummary`, modello `claude-sonnet-4-6`, retry già gestito dal client esistente) con prompt: rispondi SOLO JSON `{"discard":bool,"discardReason":string|null,"stage":string,"lastLeadQuote":string}`. `stage` = punto dello script raggiunto (es. "dopo la domanda sul lavoro", "dopo il prezzo"). `discard=true` SOLO per obiezione ferrea esplicita (non interessato dichiarato, "smettila di scrivermi", altro percorso già scelto). `note` risultante: `Interrotta ${stage}. Ultima frase del lead: "${lastLeadQuote}"`.
- `parseInterruptedVerdict`: estrae il primo blocco JSON dal testo; su parse-fail ritorna `{discard:false, note: 'Chat interrotta. Ultimo messaggio del lead: "<lastLeadMsg>"'}` (mai throw).

**Steps:**
- [ ] **Step 1:** Test per `parseInterruptedVerdict`: JSON pulito, JSON in mezzo a testo, JSON malformato → fallback, discard senza discardReason → forzare `discard:false`.
- [ ] **Step 2:** `npx vitest run lib/interrotto-note.test.ts` → FAIL.
- [ ] **Step 3:** Implementa (guarda `lib/mario-summary.ts` per il client/pattern Anthropic).
- [ ] **Step 4:** Test PASS + typecheck clean.
- [ ] **Step 5:** Commit `feat(interrotto): classificazione LLM con nota ricca per riassegnazione`.

---

### Task 3: cron `sequence-touches` — invii Track A/B

**Files:**
- Create: `app/api/cron/sequence-touches/route.ts`
- Modify: `vercel.json` (aggiungi `{ "path": "/api/cron/sequence-touches", "schedule": "*/30 6-18 * * *" }` nell'array crons)

**Interfaces:**
- Consumes: `decideTrackA`, `decideTrackB`, `pickNudgeText`, `countSequenceTouches` (Task 1); `sendTemplateAndLog(supabase, conversationId, phone, templateSid, label, from?, variables?, bodyOverride?)` da `lib/messaging.ts`; `sendFreeText({to, body, from})` da `lib/twilio.ts`; `getSupabaseAdmin` da `lib/supabase/admin.ts`.
- Env: `SEQ_TEMPLATE_SID_1..4`, `REENGAGE_TEMPLATE_SID`, `FENICE_OPENING_TEMPLATE_SID`, `SEQUENCE_ENABLED`, `SEQUENCE_MAX_PER_RUN`, `TWILIO_WHATSAPP_NUMBER_FOLLOWUP`, `TWILIO_WHATSAPP_NUMBER_FENICE`, `CRON_SECRET`.

**Comportamento (route GET, auth identica a bot-followups):**
1. Se `SEQUENCE_ENABLED !== '1'` → `{ok:true, disabled:true}`.
2. Carica TUTTE le conv CRM `ai_status in ('active')` con paginazione `.range(from, from+999)` in loop (vedi Task 4 per lo stesso pattern) + `leads(phone_e164, first_name)`.
3. Per ogni conv carica i messaggi (`direction, twilio_status, template_sid, created_at`, da `ai_started_at` in poi) — stesso pattern del cron bot-followups.
4. Split: `hasInbound` → Track B, altrimenti Track A.
5. Track A: `decideTrackA` → `send_opening`: `sendTemplateAndLog(..., FENICE_OPENING_TEMPLATE_SID, 'Fenice apertura', from, {'3': firstName}, feniceOpening(firstName))` (import `feniceOpening` da `lib/fenice-opening.ts` — vedi uso identico in `lib/fenice-enroll.ts:39-42`); `send_touch(i)`: `sendTemplateAndLog(..., SEQ_TEMPLATE_SID_i, 'Sequenza touch '+i, from, {'1': firstName ?? 'ciao'})`. NON gestire qui discard/non_risposto (li fa bot-followups).
6. Track B: `nudge_free` → controlla di nuovo che `now - lastInbound < 24h` (finestra!), poi `sendFreeText({to: phone, body: pickNudgeText(conv.id, firstName), from})` + inserisci il messaggio out in `messages` (body, direction 'out', twilio_sid/status dal risultato) + `update conversations set bot_followups_sent = bot_followups_sent + 1`; `nudge_template(i)` → `sendTemplateAndLog(..., REENGAGE_TEMPLATE_SID, 'Riaggancio '+i, ...)` + incrementa `bot_followups_sent`.
7. Cap: max `SEQUENCE_MAX_PER_RUN` (default 25) INVII per run; conta ogni send; oltre → break.
8. Errori per-conv in try/catch → `event_log` tipo `sequence_touch_error` (pattern identico a `bot_followup_error` in `app/api/cron/bot-followups/route.ts:113-119`). Se l'errore Twilio ha code 63049, logga `sequence_freq_capped` level info (il touch non risulta nei messages come delivered → verrà ritentato).
9. Fine run: `event_log` tipo `sequence_run` con `{sent, skipped, trackA, trackB}`.

**Steps:**
- [ ] **Step 1:** Implementa la route completa (nessun test unit della route: la logica decisionale è già testata in Task 1; il pattern route del repo non ha test — vedi `bot-followups.test.ts` che testa solo la funzione pura).
- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3:** Aggiungi il cron a `vercel.json`.
- [ ] **Step 4:** Commit `feat(sequence): cron sequence-touches per invii Track A/B`.

---

### Task 4: rework `bot-followups` — classificazioni finali + watchdog + paginazione

**Files:**
- Modify: `lib/bot-followups.ts` (riscrivi `decideFollowupAction`)
- Modify: `lib/bot-followups.test.ts`
- Modify: `app/api/cron/bot-followups/route.ts`

**Interfaces:**
- Consumes: `decideTrackA`, `decideTrackB`, `anyDelivered`, `countSequenceTouches` (Task 1); `classifyInterrupted` (Task 2); `sendOutcome(supabase, conversationId, {outcome, date?, note?, discardReason?})` da `lib/bot-outcome.ts`.
- Produces: nuova firma
```ts
export function decideFollowupAction(input: {
  nowMs: number;
  msgs: MsgLite[];
  seqSids: string[];
  hasInbound: boolean;
  lastInboundAtMs: number | null;
  botOutcome?: string | null;
}): 'non_risposto' | 'discard_dead' | 'interrotto_classify' | 'none';
```
implementata DELEGANDO a `decideTrackA`/`decideTrackB`: APPUNTAMENTO → 'none'; Track A `discard_dead`→'discard_dead', `non_risposto`→'non_risposto'; Track B `classify`→'interrotto_classify'; ogni altro kind → 'none'.

**Route — modifiche puntuali:**
1. **Paginazione**: sostituisci `.limit(500)` (`route.ts:32`) con loop `.range(from, from+999)` finché `data.length === 1000`. Estendi `.in('ai_status', ['active','replying'])` a `['active','replying','handed_off','booked']`.
2. **Watchdog nuovi stati** (dopo il blocco terminale APPUNTAMENTO, `route.ts:79-89`): `handed_off` da >48h senza `bot_outcome` → `event_log` tipo `stale_handed_off` level warning (una volta sola: salta se esiste già un evento con stesso conversationId — query `event_log` per type+payload->conversationId) e `continue`. `booked` senza `bot_outcome` da >24h → `event_log` tipo `stale_booked_no_outcome` level error e `continue` (la data appuntamento non è ricostruibile qui: serve intervento, l'alert è il fix).
3. **Fallthrough redrive** (fix conv 1251/1462): nel ramo `lastIsUnansweredInbound` (`route.ts:52-74`), PRIMA del redrive: se `now - lastInboundAtMs > 5 giorni` NON fare redrive, lascia proseguire verso la classificazione (il lead è già perso: va restituito, non ri-risposto).
4. **Classificazione**: sostituisci il blocco attuale (`route.ts:91-112`) con: `action = decideFollowupAction(...)`; `'discard_dead'` → `sendOutcome(supabase, c.id, {outcome:'DA_SCARTARE', discardReason:'numero inesistente', note:'Nessun messaggio consegnato in 14 giorni (verifica Twilio delivery). Numero morto.'})`; `'non_risposto'` → `sendOutcome(..., {outcome:'NON_RISPOSTO', note:'Sequenza completa: '+nTouches+' messaggi consegnati in 12 giorni, mai una risposta. Da provare a voce.'})`; `'interrotto_classify'` → costruisci `history: MarioTurn[]` dai messaggi (in→user, out→assistant), `v = await classifyInterrupted(history)`; se `v.discard` → `sendOutcome(..., {outcome:'DA_SCARTARE', discardReason: v.discardReason, note: v.note})` altrimenti `sendOutcome(..., {outcome:'INTERROTTO', note: v.note})`.
5. La query messaggi della route deve includere `twilio_status, template_sid, is_template` (oggi prende solo `direction, body, created_at`, `route.ts:43`).

**Steps:**
- [ ] **Step 1:** Riscrivi i test di `lib/bot-followups.test.ts` per la nuova firma: APPUNTAMENTO→none; Track A a 25h con 1 out delivered → none (niente più NON_RISPOSTO a 24h!); 14g delivered→non_risposto; 14g mai consegnato→discard_dead; Track B 24h silenzio→none (niente più INTERROTTO a 24h), 120h→interrotto_classify.
- [ ] **Step 2:** `npx vitest run lib/bot-followups.test.ts` → FAIL.
- [ ] **Step 3:** Implementa lib + route.
- [ ] **Step 4:** `npx vitest run` (tutta la suite) → PASS; typecheck clean.
- [ ] **Step 5:** Commit `feat(followups): classificazione a fine sequenza, watchdog stati orfani, paginazione 50/g`.

---

### Task 5: apertura differita in fascia diurna

**Files:**
- Modify: `lib/fenice-enroll.ts`
- Test: `lib/fenice-enroll.test.ts` (create se assente)

**Interfaces:**
- Consumes: `inSendWindow` (Task 1).
- Comportamento: in `enrollLeadIntoMario`, PRIMA di `sendTemplateAndLog` (`fenice-enroll.ts:40`): se `!inSendWindow(Date.now())` → salta l'invio, esegui comunque l'update conversazione (ai_owner/ai_status/ai_started_at/crm_lead_id) e logga `event_log` tipo `fenice_enroll_deferred` level info, ritorna `{ok:true, conversationId, deferred:true}`. Il cron `sequence-touches` (Task 3) invierà l'apertura al primo run in fascia (`send_opening` scatta perché la conv non ha outbound). Aggiungi `deferred?: boolean` al return type.

**Steps:**
- [ ] **Step 1:** Test: mock supabase/sendTemplateAndLog (pattern mock di `lib/bot-outcome.test.ts`); alle 23:00 Rome → nessun invio, update fatto, `deferred:true`; alle 10:00 → invio normale.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementa. **Step 4:** PASS + typecheck. **Step 5:** Commit `feat(enroll): apertura differita in fascia 08:30-20:30 (notturni -10pt risposta)`.

---

### Task 6: docs + design doc aggiornato

**Files:**
- Modify: `docs/superpowers/specs/2026-07-24-sequenza-estesa-restituzioni-design.md` (sezione Stato: spunta implementazione)
- Modify: `README.md` (sezione cron: aggiungi sequence-touches e le env nuove)

- [ ] **Step 1:** Aggiorna entrambi. **Step 2:** Commit `docs: sequenza estesa — stato implementazione`.

---

### Task 7 (MAIN SESSION, non subagent): template Meta, env, secondo numero, deploy

- [ ] **Step 1:** Script `scripts/create-sequence-templates.mjs`: crea via Twilio Content API 5 template it (4 follow-up + 1 riaggancio), var `{{1}}` = nome, opt-out esplicito nel testo, categoria MARKETING; sottometti approvazione WhatsApp; stampa i SID.
- [ ] **Step 2:** Verifica secondo numero WhatsApp sender via Twilio API; se non onboardato su WABA → segnala a Bruno i passi manuali (Meta review non automatizzabile).
- [ ] **Step 3:** `npx vercel env add` per: `SEQ_TEMPLATE_SID_1..4`, `REENGAGE_TEMPLATE_SID`, `SEQUENCE_ENABLED=0` (si accende a template approvati), `SEQUENCE_MAX_PER_RUN=25`, eventuale `TWILIO_WHATSAPP_NUMBER_FOLLOWUP`.
- [ ] **Step 4:** Merge branch → main → push → verifica deploy (gh api status) → smoke test cron con secret → quando i template risultano `approved`: `SEQUENCE_ENABLED=1` + redeploy → conferma go-live al CRM.

## Self-Review

- Spec coverage: R1→Task 1/4 (discard_dead, criterio consegna); R2→Task 1/3 (5 touch/12gg, orari variati, cap Meta 63049); R3→Task 4 (NON_RISPOSTO a fine sequenza); R4→Task 1/3 (nudge 20h/48h/96h) + Task 2/4 (scarto obiezione chiara); R5→Task 2 (nota ricca); R6→già live (1409b2a), verificato zero duplicati; cap 50/g→Task 4 paginazione + Task 3; lead incastrati→Task 4 watchdog; apertura diurna→Task 5. ✓
- Nessun placeholder; firme coerenti (`MsgLite`, `decideTrackA/B`, `classifyInterrupted`) tra i task. ✓
- RICHIAMO interim: NON incluso (in attesa di conferma semantica dal CRM — non blocca il resto).
