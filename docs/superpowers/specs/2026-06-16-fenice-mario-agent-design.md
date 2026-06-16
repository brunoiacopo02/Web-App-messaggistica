# Sezione Fenice — Agente AI "Mario" (design)

Data: 2026-06-16
Stato: approvato (brainstorming) — pronto per piano di implementazione

## Obiettivo

Aggiungere al software una sezione separata, accessibile con un login dedicato
(`fenicebot@fenice.com`), per testare e poi usare un agente AI ("Mario", powered
da Claude) che contatta lead su WhatsApp, li prequalifica e fissa un appuntamento.

Due fasi, stesso "cervello" Mario riutilizzato:

- **Fase 1 — Simulatore web**: chat in cui l'operatore impersona il lead e Mario
  risponde. Nessun WhatsApp reale, nessuna scrittura su DB. Serve a tarare il
  prompt e lo stile di vendita.
- **Fase 2 — WhatsApp reale**: stesso motore Mario risponde in automatico ai lead
  reali sul numero Fenice, dietro un interruttore globale ON/OFF e **solo per i
  lead esplicitamente arruolati**.

## Decisioni prese (brainstorming)

1. **Scope**: costruire entrambe le fasi, simulatore per primo; auto-risposta reale
   dietro interruttore.
2. **Accessi & dati**: sezione separata, **dati condivisi** con le tabelle attuali.
   `fenicebot` vede solo `/fenice`. Nessun ruolo nel DB: gate per email.
3. **Trigger live**: ad auto-risposta accesa, Mario risponde **solo ai lead
   arruolati** (conversazioni marcate `ai_owner = 'mario'`). Tutti gli altri
   inbound sul numero Fenice restano umani.
4. **Modello**: `claude-sonnet-4-6` (come nello script `mario_bot.py` originale).

## Architettura

### 1. Accesso e struttura di rotte

- Nuovo gruppo di rotte **`/fenice`** con layout proprio e nav minima:
  *Simulatore*, *Live*, *Log Fenice*. Nessuna voce del CRM esistente.
- **`lib/access.ts`**: mappa email → area consentita.
  - `fenicebot@fenice.com` → solo `/fenice`. Redirect post-login a `/fenice`;
    qualsiasi tentativo di aprire `/inbox`, `/dashboard`, ecc. → redirect a `/fenice`.
  - Account "admin" (es. `brunoiacopo02@gmail.com`) → CRM completo **+** `/fenice`
    per supervisione.
  - Default per email non mappate: CRM (comportamento attuale invariato).
- Enforcement in due punti:
  - `proxy.ts`: redirect in base all'area consentita.
  - Layout server-side (`app/(app)/layout.tsx` e nuovo `app/(fenice)/layout.tsx`):
    difesa in profondità — un utente "fenice-only" che raggiunge il CRM viene
    rediretto, e viceversa.
- L'account Fenice viene creato in Supabase Auth (email/password) — credenziali
  provvisorie fornite dall'utente; password da cambiare.

### 2. Motore "Mario" (cervello condiviso)

- **`lib/mario-prompt.ts`**: costante `MARIO_SYSTEM_PROMPT`, portata 1:1 dal file
  `mario_bot.py`. File isolato così è facile arricchirlo con i documenti di
  vendita in seguito.
- **`lib/mario.ts`**:
  - Dipendenza nuova: `@anthropic-ai/sdk`. Key da env `ANTHROPIC_API_KEY`.
  - `generateMarioReply(history: MarioTurn[]): Promise<MarioResult>` dove
    `MarioTurn = { role: 'user' | 'assistant'; content: string }` e
    `MarioResult = { visibleReply: string; appointmentFixed: boolean; passToHuman: boolean }`.
  - Chiamata: `model: 'claude-sonnet-4-6'`, `max_tokens: 1024`,
    `system: MARIO_SYSTEM_PROMPT`, `messages: history`.
  - Se `history` è vuota, usa il seed `[{ role: 'user', content: 'Inizia la conversazione presentandoti.' }]`
    (come lo script originale).
  - Rileva i tag `[APPUNTAMENTO_FISSATO]` e `[PASSAGGIO_UMANO]`, li rimuove dal
    testo visibile, e ritorna i flag corrispondenti.

### 3. Simulatore (Fase 1)

- Pagina `/fenice` (home della sezione): UI chat.
  - L'operatore scrive come **lead**; Mario risponde.
  - Bottoni *Invia* e *Reset*. Badge/indicatori quando scattano
    `appointmentFixed` o `passToHuman`.
  - La cronologia vive **client-side** (stato React). Nessuna scrittura su DB,
    nessun Twilio → i dati di test non sporcano le tabelle reali.
- Backend: **`POST /api/fenice/sim`**.
  - Body: `{ history: MarioTurn[] }`. Risposta: `MarioResult`.
  - Protetto da sessione Supabase (solo utenti autenticati con accesso a `/fenice`).

### 4. WhatsApp reale (Fase 2 — dietro interruttore)

#### Numero e invio
- Nuova env `TWILIO_WHATSAPP_NUMBER_FENICE` (= `whatsapp:+393520413199`).
- `lib/twilio.ts`: `sendTemplate` e `sendFreeText` accettano un parametro `from`
  opzionale (default = `TWILIO_WHATSAPP_NUMBER` attuale). Stesso account Twilio,
  sender diverso.

#### Arruolamento lead
- Pagina `/fenice/live`: form "Avvia lead" (telefono + nome opzionale).
- Azione: invia il **template di apertura** `HXa2da97153df29161cc4151a83b809e1e`
  dal numero Fenice (riuso di `findOrCreateLeadConversation` + `sendTemplateAndLog`
  con `from` Fenice), poi marca la conversazione `ai_owner = 'mario'`,
  `ai_status = 'active'`.
- Lista delle conversazioni arruolate con stato (`active` / `handed_off` / `booked`).

#### Interruttore globale
- Mini tabella **`app_settings`** (`key text primary key`, `value jsonb`,
  `updated_at`). Chiave `fenice_ai_autoreply` = `true|false`.
- Toggle nella UI `/fenice/live` per accendere/spegnere l'auto-risposta.

#### Modifiche DB (tabella `conversations`)
- `ai_owner text` — `null` (umano) | `'mario'`.
- `ai_status text` — `null` | `'active'` | `'handed_off'` | `'booked'`.
- Migrazione SQL additiva (nessuna colonna esistente toccata).

#### Auto-risposta nel webhook Twilio
- In `app/api/webhooks/twilio/route.ts`, dopo aver salvato un inbound:
  - Procedi all'auto-risposta solo se TUTTE vere:
    1. `params.To` corrisponde al numero Fenice (`TWILIO_WHATSAPP_NUMBER_FENICE`),
    2. `app_settings.fenice_ai_autoreply == true`,
    3. la conversazione ha `ai_owner == 'mario'` e `ai_status == 'active'`.
  - Ricostruisci la cronologia da `messages` (ordinata per `created_at`):
    `direction 'in' → role 'user'`, `direction 'out' → role 'assistant'`.
  - Chiama `generateMarioReply(history)`.
  - Invia `visibleReply` in **testo libero** dal numero Fenice
    (`sendFreeText`, valido entro la finestra 24h WhatsApp) e salva il messaggio
    `out` nella conversazione + bump `last_message_at`.
  - Gestione tag:
    - `passToHuman` → `ai_status = 'handed_off'`, niente più auto-risposte;
      log evento per segnalare l'handoff.
    - `appointmentFixed` → `ai_status = 'booked'`; log evento.
  - Logga ogni risposta AI in `event_log` (`type: 'fenice_ai_reply'`).
  - Robustezza: l'auto-risposta è best-effort. Se la chiamata Claude o l'invio
    Twilio falliscono, logga l'errore e ritorna comunque `200` al webhook
    (non bloccare Twilio, niente loop di retry sull'AI).

## Flusso dati (Fase 2)

```
Arruolamento:
  /fenice/live (form) -> POST /api/fenice/enroll
     -> findOrCreateLeadConversation
     -> sendTemplate(from=Fenice, HX...apertura)
     -> conversations.ai_owner='mario', ai_status='active'

Conversazione:
  Lead risponde --WhatsApp--> Twilio --POST--> /api/webhooks/twilio
     -> salva inbound
     -> [gate: To=Fenice & switch ON & ai_owner=mario & status=active]
     -> ricostruisci history da messages
     -> generateMarioReply (Claude)
     -> sendFreeText(from=Fenice) + salva out
     -> aggiorna ai_status su tag (handed_off / booked)
```

## Variabili d'ambiente (nuove)

```
ANTHROPIC_API_KEY=                       # da ruotare; mai in git
TWILIO_WHATSAPP_NUMBER_FENICE=whatsapp:+393520413199
FENICE_OPENING_TEMPLATE_SID=HXa2da97153df29161cc4151a83b809e1e
```

(`.env.example` aggiornato di conseguenza.)

## Gestione errori

- Simulatore: errori API Claude → messaggio d'errore in UI, la cronologia resta
  intatta per ritentare.
- Webhook auto-risposta: best-effort, non blocca mai la `200` verso Twilio; ogni
  errore finisce in `event_log` con `level: 'error'`.
- Mancanza env (key/numero/template): fallimento esplicito con messaggio chiaro
  lato server, log evento.

## Testing

- `lib/mario.ts`: unit test sul parsing dei tag (rimozione `[APPUNTAMENTO_FISSATO]`
  / `[PASSAGGIO_UMANO]` e flag) con chiamata Anthropic mockata.
- `lib/twilio.ts`: test che `from` override venga passato correttamente.
- Webhook: test del gate di auto-risposta (risponde solo quando le 4 condizioni
  sono vere; resta umano altrimenti).
- `lib/access.ts`: test della mappatura email → area e dei redirect.
- Simulatore: smoke test e2e opzionale (Playwright) della chat.

## Fuori scope (per ora)

- Integrazione dei documenti di vendita extra nel prompt (fase successiva).
- Invio automatico della sequenza post-appuntamento a 3 messaggi e selezione del
  link video in base allo stato del lead (per v1 Mario produce il testo; la logica
  di branching dei link resta manuale/successiva).
- Isolamento completo multi-tenant dei dati (scelta: dati condivisi).
- Gestione esplicita oltre la finestra 24h (se il lead risponde dopo 24h servirà
  un template; per v1 si assume conversazione attiva entro la finestra).
```
