# Integrazione Bot Fissatore ↔ CRM Fenice — Design

> **Data:** 2026-06-18
> **Repo:** `web-app-messaggistica` (il "bot fissatore" del contratto è Mario, qui dentro).
> **Contratto di riferimento:** "Bot Fissatore — Contratto di Integrazione" v1.0 (team CRM esterno).

## 1. Contesto e scope

Il CRM esterno (`crm-sales-fenice.vercel.app`) assegna lead a un account bot dedicato
(`GDO 201`) e si aspetta che il nostro bot WhatsApp (Mario) li lavori e restituisca un esito.
Noi implementiamo **entrambe le direzioni** del contratto:

- **Direzione 1 (CRM → Bot):** webhook pubblico che riceve i lead assegnati, firmato HMAC.
- **Direzione 2 (Bot → CRM):** callback con l'esito + report strutturato, firmato HMAC.

Decisioni di scope approvate:
- Implementiamo **tutti e 4 gli esiti** (`APPUNTAMENTO`, `RICHIAMO`, `DA_SCARTARE`, `NON_RISPOSTO`).
- **Mario struttura la data** di appuntamento/richiamo (niente estrazione separata).
- `NON_RISPOSTO`: 2 solleciti, poi resa a ~48h, via cron.
- **Riapertura** consentita: se un lead chiuso riscrive, il drain riapre e può inviare un nuovo esito (last-wins).

Fuori scope: il soft cap di 20 assegnazioni/giorno è applicato **lato CRM**; noi accettiamo tutto.

## 2. Mapping degli esiti

| Segnale Mario / sistema | `outcome` CRM | `date` | Campi extra |
|---|---|---|---|
| Appuntamento fissato | `APPUNTAMENTO` | sì (Mario) | `report` |
| Lead vuole essere ricontattato | `RICHIAMO` | sì (Mario) | `report` |
| Fuori target / non interessato | `DA_SCARTARE` | no | `discardReason`, `report` |
| Silenzio dopo 2 solleciti + ~48h | `NON_RISPOSTO` | no | `note` |

`[PASSAGGIO_UMANO]` (tag esistente, usato dal live non-CRM → `handed_off`) **non viene usato per i
lead CRM**: il prompt istruisce Mario a chiudere sempre con un tag `[ESITO:...]`. Se per qualunque
motivo una conversazione CRM termina con `[PASSAGGIO_UMANO]` senza un esito valido, **non** inviamo
nulla al CRM in automatico (un `RICHIAMO` senza data verrebbe comunque rifiutato con 400): logghiamo
`[bot-fissatore]` a livello `warn` per intervento manuale di un operatore.

## 3. Variabili d'ambiente

Nuove (impostate su Vercel lato bot):
- `BOT_WEBHOOK_SECRET` — segreto condiviso HMAC-SHA256; usato sia per **verificare** i push in
  ingresso sia per **firmare** i callback in uscita. Se assente, l'intake risponde 401/`not_configured`.
- `CRM_OUTCOME_URL` — default `https://crm-sales-fenice.vercel.app/api/bot/outcome`.

Riusate: `ANTHROPIC_API_KEY`, `CRON_SECRET`, `TWILIO_WHATSAPP_NUMBER_FENICE`,
`FENICE_OPENING_TEMPLATE_SID`, `NEXT_PUBLIC_APP_URL`.

URL del nostro webhook da comunicare al team CRM (loro `BOT_INTAKE_URL`):
`https://web-app-messaggistica.vercel.app/api/bot/intake`.

## 4. Modello dati — migration su `conversations`

```sql
alter table conversations
  add column if not exists crm_lead_id        text,           -- UUID lead nel CRM (null = lead non-CRM)
  add column if not exists crm_funnel          text,          -- funnel/prodotto di interesse
  add column if not exists bot_outcome         text,          -- ultimo outcome inviato (null = non inviato)
  add column if not exists bot_outcome_at      timestamptz,   -- quando il callback è andato a buon fine
  add column if not exists bot_scheduled_at    timestamptz,   -- data APPUNTAMENTO/RICHIAMO strutturata
  add column if not exists bot_report          jsonb,         -- report inviato al CRM
  add column if not exists bot_followups_sent  int not null default 0;

create index if not exists conversations_crm_lead_id_idx on conversations(crm_lead_id);
```

`ai_status` resta il ciclo di vita interno di Mario; aggiungiamo il valore terminale
`'closed'` (esito inviato con successo). Valori: `null | active | replying | booked | handed_off | closed`.

## 5. Componenti

### 5.1 `lib/bot-hmac.ts` (puro)
- `signPayload(rawBody: string, secret: string): string` → `sha256=<hex>`.
- `verifySignature(rawBody, header, secret): { valid: boolean; reason?: string }` con
  confronto **timing-safe** (`crypto.timingSafeEqual`), come da snippet del contratto.

### 5.2 `lib/bot-contract.ts` (puro)
- Tipi: `BotIntakePayload`, `BotOutcome`, `BotOutcomeBody`, `BotReport`.
- `isoWithOffset(date: string): boolean` — true solo se ISO 8601 **con offset** (`Z` o `±HH:MM`).
- `parseIntakePayload(raw: unknown): { ok: true; value } | { ok: false; reason }`.
- `validateOutcomeBody(body): ...` — `leadId`/`outcome` presenti; `date` obbligatoria e con offset
  per `APPUNTAMENTO`/`RICHIAMO`.

### 5.3 `lib/fenice-enroll.ts` (refactor condiviso)
Estrae il cuore dell'arruolamento oggi in `app/api/fenice/enroll/route.ts`:
`enrollLeadIntoMario(supabase, { phone, firstName, lastName, email, crmLeadId, crmFunnel })`
→ crea/aggiorna lead+conversazione, invia il template di apertura, setta
`ai_owner='mario'`, `ai_status='active'`, `ai_started_at=now`, e (se presenti) `crm_lead_id`/`crm_funnel`.
La route `/api/fenice/enroll` esistente viene riscritta per usarlo (comportamento invariato).

### 5.4 Direzione 1 — `app/api/bot/intake/route.ts`
1. Rate-limit (riuso `checkRateLimit`).
2. Legge il **raw body**; se `BOT_WEBHOOK_SECRET` assente → 503 `not_configured`.
3. `verifySignature` → 401 `invalid_signature`.
4. `parseIntakePayload`; `companyId !== 'fenice'` → 403 `forbidden`.
5. `toE164(phone)`; se invalido → log `[bot-fissatore]` + **200** (best-effort, niente retry lato CRM).
6. `enrollLeadIntoMario(...)` con `crmLeadId`, `crmFunnel`, nome/email.
7. 200 `{ ok: true }`.

### 5.5 Mario — cattura esito + data (`lib/mario.ts`, `lib/mario-prompt.ts`)
- Nuovi tag strutturati emessi da Mario:
  - `[ESITO:APPUNTAMENTO|<ISO con offset>]`
  - `[ESITO:RICHIAMO|<ISO con offset>]`
  - `[ESITO:SCARTO|<motivo>]`
- `generateMarioReply` riceve la **data/ora corrente in `Europe/Rome`** iniettata nel contesto
  (system o messaggio di servizio) così Mario risolve "domani alle 15" → ISO assoluto con offset.
- `parseMarioReply` estende `MarioResult` con `outcome?: 'APPUNTAMENTO'|'RICHIAMO'|'DA_SCARTARE'`,
  `scheduledAt?: string`, `discardReason?: string`; ripulisce i tag dal testo visibile. I flag
  legacy `appointmentFixed`/`passToHuman` restano per compatibilità col live non-CRM.
- Prompt aggiornato: in chiusura Mario emette il tag appropriato; per APPUNTAMENTO/RICHIAMO
  **sempre** con data assoluta valida.

### 5.6 Direzione 2 — `lib/bot-outcome.ts`
`sendOutcome(supabase, conversationId, { outcome, date?, note?, discardReason?, report? })`:
1. Carica la conv; se manca `crm_lead_id` → **no-op** (lead non-CRM, es. simulatore/live manuale).
2. Costruisce `BotOutcomeBody` (con `leadId = crm_lead_id`), firma con `BOT_WEBHOOK_SECRET`,
   `POST` a `CRM_OUTCOME_URL`.
3. Su **2xx**: persiste `bot_outcome`, `bot_outcome_at`, `bot_scheduled_at`, `bot_report`;
   setta `ai_status='closed'`; logga `bot_outcome_sent`.
4. Su **non-2xx / errore di rete**: logga `[bot-fissatore]` a livello `error`, **non** chiude
   (ritentabile da un drain successivo o manualmente).

Innesco: dentro `drainMarioReplies`, quando `parseMarioReply` produce un esito terminale e la
conv è CRM-linked → genera il report (5.7) e chiama `sendOutcome`.

**Riapertura:** se un lead `closed` riscrive, il webhook Twilio riporta `ai_status` ad `active`
(solo per lead CRM-linked) prima del drain, così Mario riprende e può inviare un nuovo esito.
`shouldAutoReply` resta invariato (gestisce `active`/`replying`); la transizione `closed→active`
avviene nel webhook prima di valutare `shouldAutoReply`.

### 5.7 Report strutturato — `lib/bot-report.ts`
Estende l'infrastruttura del riassunto AI (`lib/mario-summary.ts`). Una chiamata Claude a
**output strutturato** produce `BotReport`:
`summary`, `painPoints[]`, `budgetSignal`, `urgency`, `objections[]`, `levaConsigliata`.
Generato al momento dell'esito per APPUNTAMENTO/RICHIAMO/DA_SCARTARE. Per `NON_RISPOSTO`
nessun report (conversazione assente/vuota), solo `note`.

### 5.8 Solleciti + NON_RISPOSTO — `app/api/cron/bot-followups/route.ts` + `vercel.json`
- Cron orario (`0 * * * *`), protetto da `CRON_SECRET` (Bearer o `?secret=`), come gli altri.
- `maxDuration = 300`, `runtime = 'nodejs'`.
- Seleziona conv **CRM-linked** (`crm_lead_id not null`), in stato attivo (`ai_status in (active, replying)`),
  che **non hanno mai risposto** (`last_inbound_at` null oppure `< ai_started_at`).
- Funzione **pura** `decideFollowupAction({ startedAt, now, followupsSent, hasInbound })`
  → `'sollecito_1' | 'sollecito_2' | 'non_risposto' | 'none'`. Soglie come costanti regolabili:
  `FOLLOWUP_1_H=18`, `FOLLOWUP_2_H=36`, `GIVEUP_H=48`.
- Azioni:
  - `sollecito_1` (elapsed ≥ 18h, followups=0): invia nudge fisso 1, `bot_followups_sent=1`.
  - `sollecito_2` (elapsed ≥ 36h, followups=1): invia nudge fisso 2, `bot_followups_sent=2`.
  - `non_risposto` (elapsed ≥ 48h, followups≥2): `sendOutcome(NON_RISPOSTO, note)`.
- Testo dei solleciti: fisso (nessun costo AI), breve e umano.
- Se il lead ha risposto almeno una volta, il cron lo ignora (lo gestisce il drain normale).

## 6. Sicurezza
- HMAC timing-safe in **entrambe** le direzioni; header sempre `x-bot-signature`.
- Verifica sul **raw body** esatto in byte (nessuna re-serializzazione).
- L'account bot non accede mai all'interfaccia: ogni scambio è via API firmata.
- Rate-limit sul webhook intake.

## 7. Testing
Unit (vitest), che si aggiungono ai 65 esistenti (che restano verdi):
- `bot-hmac`: firma corretta; verifica ok; prefisso errato; length-mismatch; body manomesso; secret errato.
- `bot-contract`: `isoWithOffset` (accetta `+02:00`/`Z`, rifiuta senza offset); `parseIntakePayload`
  (campi mancanti, `companyId` errato); `validateOutcomeBody` (date richiesta per APPUNTAMENTO/RICHIAMO).
- `parseMarioReply`: nuovi tag + estrazione data + pulizia testo; coesistenza coi flag legacy.
- `decideFollowupAction`: tutte le transizioni di soglia e il caso "ha risposto".
- mapping esito → `BotOutcomeBody`.

## 8. Note operative
- **Numero WhatsApp bloccato** (Meta, dal 12/06): apertura e solleciti reali non partono finché non
  si sblocca, ma intake, mapping, callback al CRM e tutti i test sono indipendenti e funzionano.
- Push CRM → Bot è best-effort senza retry: monitorare i log `[bot-fissatore]` su Vercel.
- Concordare con il team CRM il valore di `BOT_WEBHOOK_SECRET` prima di abilitare `BOT_INTAKE_ENABLED=true`.
