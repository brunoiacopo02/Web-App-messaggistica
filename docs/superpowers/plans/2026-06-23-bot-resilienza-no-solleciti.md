# Piano: resilienza auto-risposta Mario + rimozione solleciti

**Data:** 2026-06-23
**Origine:** lead "Arnisa Grabocka" (conv 1200) non ricevuto risposta. Causa radice: l'API Claude
ha risposto `529 overloaded_error` durante `generateMarioReply`; il `catch` in
`lib/fenice-autoreply.ts` rimette `ai_status='active'` ma **nessuno ritenta** (il drain parte solo
dal webhook inbound). Anche Elettra Casazza (conv 1188) è bloccata allo stesso modo.

## Decisioni prese (utente)
- Follow-up: rimuovere **solo** i messaggi di sollecito; **mantenere** la classificazione CRM
  `NON_RISPOSTO` / `INTERROTTO` (sono callback CRM, nessun messaggio WhatsApp → nessun rischio ban).
- Recupero immediato di **entrambi** i lead bloccati (1200 Arnisa, 1188 Elettra).

## Obiettivo
1. Le risposte di Mario non vengono più perse per errori transitori dell'API.
2. Esiste una rete di sicurezza che ri-prova a rispondere ai lead in attesa.
3. Il bot non invia più messaggi di sollecito a chi non ha mai risposto (anti-ban).
4. Arnisa ed Elettra ricevono la risposta ora.

---

## Task 1 — Resilienza client Anthropic
**File:** `lib/mario.ts`, `lib/bot-report.ts`

- In `getClient()` (mario.ts:64) e nel `new Anthropic(...)` di bot-report.ts:45, passare
  `{ apiKey, maxRetries: 5, timeout: 60_000 }`.
- L'SDK ritenta in automatico 408/409/429/≥500 (incluso 529) con backoff esponenziale e rispetto di
  `retry-after`. Portando i retry da 2 a 5 si assorbono i picchi di sovraccarico transitori.
- Nessun test unitario (comportamento dell'SDK, non logica nostra).

**Verifica:** `npm run typecheck` verde.

## Task 2 — Helper puro: la conversazione attende una risposta del bot?
**File:** `lib/fenice-autoreply.ts` (+ test)

- Esportare un helper puro `lastIsUnansweredInbound(rows: MsgRow[]): boolean` =
  `nextUnansweredInboundIndex(rows) !== -1 && ultimo messaggio è 'in'`. (In pratica: l'ultimo
  messaggio della conversazione è un inbound del lead.)
- Test in `lib/fenice-autoreply.test.ts` (o file esistente): casi inbound-finale, outbound-finale, vuoto.

**Verifica:** test verdi.

## Task 3 — Rimozione solleciti
**File:** `lib/bot-followups.ts`, `lib/bot-followups.test.ts`

- `FollowupAction`: rimuovere `'sollecito_1' | 'sollecito_2'`.
- `decideFollowupAction`: ramo mai-risposto diventa: `elapsedH >= GIVEUP_H ? 'non_risposto' : 'none'`.
  Rimuovere i rami sollecito. Ramo risposto-poi-silente invariato (`none` → `interrotto` a 24h).
- Rimuovere `FOLLOWUP_1_H`, `FOLLOWUP_2_H`, `FOLLOWUP_TEXTS`. Tenere `GIVEUP_H`.
- Aggiornare i test: eliminare i casi sollecito, tenere `non_risposto` / `interrotto` / `none`.

**Verifica:** test verdi.

## Task 4 — Cron: backstop re-drive + classificazione (no solleciti)
**File:** `app/api/cron/bot-followups/route.ts`

- Una query unica sulle conversazioni Mario attive (`ai_owner='mario'`, `ai_status in ('active','replying')`,
  `bot_outcome is null`) che includa la **direzione dell'ultimo messaggio** (distinct-on come da query
  diagnostica) e i campi necessari (`crm_lead_id`, `ai_started_at`, `last_inbound_at`, telefono).
- Per ogni conversazione:
  - **ultimo messaggio = inbound** → `await drainMarioReplies(supabase, id, phone, () => 0)`
    (re-drive immediato, niente finestra di attesa). NON classificare.
  - **altrimenti** → `decideFollowupAction(...)`; se `non_risposto`/`interrotto` → `sendOutcome(...)`.
- Rimuovere il blocco di invio `sollecito_*` (vecchie righe 60-86) e l'import di `FOLLOWUP_TEXTS`.
- Mantenere auth, `event_log` di riepilogo, e il report di ritorno (aggiungere conteggio re-drive).

**Verifica:** `npm run typecheck` + `npm run build` verdi.

## Task 5 — Verifica finale + deploy
- `npm run typecheck`, `npm test`, `npm run build` tutti verdi.
- Branch dedicato, commit, push → deploy Vercel.

## Task 6 — Recupero Arnisa + Elettra
- A deploy completato, invocare una volta `GET /api/cron/bot-followups` con `CRON_SECRET`
  (header `Authorization: Bearer <secret>` o `?secret=<secret>`) sulla URL di produzione
  (`NEXT_PUBLIC_APP_URL`). Recuperare il secret dall'env Vercel/locale.
- Verificare con SQL che le conversazioni 1200 e 1188 abbiano un nuovo messaggio `direction='out'`
  e che non risultino più "ultimo messaggio inbound non risposto".

## Note / non-obiettivi
- La colonna `bot_followups_sent` resta nello schema (dati storici), semplicemente non più usata.
- Nessuna modifica al template di apertura né alla logica di consegna Twilio.
