# Sistema Messaggistica WhatsApp Automatica per Lead — Design

| Campo | Valore |
|---|---|
| Data | 2026-05-01 |
| Versione | 1.0 |
| Stato | Design approvato dall'utente, pronto per piano implementativo |
| Riferimento | `specifiche_whatsapp_lead.docx` (specifiche cliente) |

## 1. Obiettivo

Webapp che riceve nuovi lead da ActiveCampaign via webhook, invia immediatamente un messaggio WhatsApp tramite template approvato Meta (Twilio), riceve le risposte dei lead e le mostra in una **inbox stile WhatsApp** dove l'operatore può rispondere (libero entro 24h, template fuori finestra). Configurazione delle campagne (lista AC → template) gestita da una pagina dedicata della webapp.

## 2. Scope V1

**Incluso:**
- Webhook AC → invio template Twilio
- Webhook Twilio inbound → inbox + status delivery
- Inbox stile WhatsApp two-pane con risposta libera/template
- Multi-campagna configurabile dalla UI
- Auth Supabase email/password (single tenant, utenti creati a mano)
- Notifiche real-time: badge + beep + Notification API desktop
- Dashboard con stat e ultime risposte
- Log invii + log eventi sistema
- Deploy Vercel + DB Supabase

**Esplicitamente fuori scope (YAGNI):**
- Multi-tenant / RLS per organizzazione
- Email di notifica al cliente
- Queue distribuita (volumi non lo giustificano)
- Allegati media in WhatsApp (immagini/PDF/audio)
- Sync automatico template da Twilio (lista template inserita a mano)
- Note/tag/blocco lead nella UI
- Export GDPR / soft-delete contatto dalla UI (gestibile via SQL)

## 3. Stack tecnologico

- **Framework:** Next.js 16 (App Router, Server Components, Turbopack)
- **Linguaggio:** TypeScript strict
- **DB:** Supabase Postgres + Realtime + Auth
- **UI:** React 19 + Tailwind CSS + shadcn/ui
- **HTTP/SDK:** `twilio` (Node SDK ufficiale), `@supabase/ssr` + `@supabase/supabase-js`
- **Validazione:** Zod
- **Test:** Vitest (unit/integration), Playwright (E2E happy path)
- **Hosting:** Vercel (Fluid Compute, regione `fra1`)
- **Lingua UI:** italiano

## 4. Architettura

Monolite Next.js: backend (route handler) e frontend (pagine) nella stessa codebase, deploy unico su Vercel.

```
ActiveCampaign ──webhook──▶ /api/webhooks/activecampaign ──┐
                                                            ▼
Twilio (WA inbound) ──webhook──▶ /api/webhooks/twilio ─▶ Supabase Postgres
                                                          + Realtime + Auth
Twilio (WA outbound) ◀─────── lib/twilio.ts ◀────── /api/messages (POST)
                                                          ▲
Webapp (login/dashboard/inbox/campagne/log) ──realtime sub─┘
```

### Struttura cartelle (orientativa)

```
app/
  (auth)/login/page.tsx
  (app)/
    layout.tsx              # sidebar nav, sessione, RealtimeProvider
    dashboard/page.tsx
    inbox/page.tsx
    inbox/[conversationId]/page.tsx
    campagne/page.tsx
    log/page.tsx
  api/
    webhooks/
      activecampaign/route.ts
      twilio/route.ts
    messages/route.ts
    messages/[id]/read/route.ts
    conversations/route.ts
    conversations/[id]/messages/route.ts
    campaigns/route.ts
    campaigns/[id]/route.ts
    stats/route.ts
components/
  ConversationList.tsx
  MessageBubble.tsx
  DeliveryStatus.tsx
  PhoneAvatar.tsx
  Composer.tsx
  TemplateVariablesEditor.tsx
  StatCard.tsx
  RealtimeProvider.tsx
lib/
  supabase/{server,client,middleware,admin}.ts
  twilio.ts          # send template/free, validate signature
  ac.ts              # parse AC payload, dedup window
  phone.ts           # E.164 normalization (default +39)
  campaigns.ts       # match list → campaign, render template variables
middleware.ts        # auth gate
supabase/migrations/ # SQL versionato
```

## 5. Modello dati

Cinque tabelle. Naming inglese, `snake_case`, PK `bigint identity`.

### `campaigns`
```sql
id                   bigint pk identity,
name                 text not null,
ac_list_match        text not null,         -- nome o ID lista AC che fa match
twilio_template_sid  text not null,         -- HX...
template_variables   jsonb not null,        -- vedi sotto
active               boolean not null default true,
created_at           timestamptz not null default now(),
updated_at           timestamptz not null default now()
```
`template_variables` formato:
```json
[
  {"key": "1", "source": "lead_field", "value": "first_name"},
  {"key": "2", "source": "static",     "value": "Webinar Marzo"},
  {"key": "3", "source": "static",     "value": "15/03/2026"}
]
```

### `leads`
```sql
id              bigint pk identity,
phone_e164      text not null unique,
first_name      text,
last_name       text,
email           text,
ac_contact_id   text,
created_at      timestamptz not null default now()
```

### `conversations`
```sql
id              bigint pk identity,
lead_id         bigint not null references leads(id) unique,
campaign_id     bigint references campaigns(id),
last_message_at timestamptz not null default now(),
last_inbound_at timestamptz,                -- per finestra 24h
unread_count    int not null default 0,
created_at      timestamptz not null default now()
```
Constraint `unique(lead_id)`: una sola conversazione per lead in V1.

### `messages`
```sql
id              bigint pk identity,
conversation_id bigint not null references conversations(id) on delete cascade,
direction       text not null check (direction in ('in','out')),
body            text not null,
twilio_sid      text unique,                 -- dedup webhook Twilio
twilio_status   text,                        -- queued|sent|delivered|read|failed|undelivered
twilio_error_code int,
template_sid    text,
template_vars   jsonb,
is_template     boolean not null default false,
read_at         timestamptz,                 -- solo inbound: quando l'operatore l'ha letta
created_at      timestamptz not null default now()
```

### `event_log`
```sql
id         bigint pk identity,
type       text not null,                    -- 'ac_webhook'|'twilio_inbound'|'twilio_status'|'send_error'|'dedup_skip'|'config_error'
payload    jsonb,
message    text,
level      text not null default 'info',     -- 'info'|'warn'|'error'
created_at timestamptz not null default now()
```

### Indici
```sql
create index on messages(conversation_id, created_at desc);
create index on conversations(last_message_at desc);
create index on leads(phone_e164);
create index on event_log(created_at desc, level);
create index on event_log(type, created_at desc);
```

### RLS (single tenant)
Abilitata su tutte le tabelle. Policy unica per ognuna: `authenticated` può `select|insert|update|delete`. Le route webhook usano `service_role` key (bypassa RLS).

## 6. API & flussi

### 6.1 Endpoint

| Route | Metodo | Auth | Scopo |
|---|---|---|---|
| `/api/webhooks/activecampaign` | POST | secret in URL/header | Riceve nuovo lead, dedup, sceglie campagna, invia template |
| `/api/webhooks/twilio` | POST | HMAC X-Twilio-Signature | Riceve inbound + status callback delivery |
| `/api/messages` | POST | session | Operatore risponde (free o template) |
| `/api/messages/[id]/read` | POST | session | Marca messaggio inbound come letto |
| `/api/conversations` | GET | session | Lista conversazioni (paginata) |
| `/api/conversations/[id]/messages` | GET | session | Thread completo |
| `/api/campaigns` | GET, POST | session | Lista + crea |
| `/api/campaigns/[id]` | PATCH, DELETE | session | Modifica + soft delete (set `active=false`) |
| `/api/stats` | GET | session | Conteggi dashboard |

Le pagine UI usano direttamente Supabase via Server Components. Le route API esistono solo per **mutazioni** e **webhook esterni**.

### 6.2 Flusso outbound (lead da AC → invio template)

```
POST /api/webhooks/activecampaign?secret=<AC_WEBHOOK_SECRET>
body: { contact: {first_name, last_name, email, phone}, list: {id, name} }

1. Verifica secret → 403 se mismatch
2. Log payload in event_log (type='ac_webhook')
3. Normalizza phone → E.164 (default +39)
   se invalido → log warn, return 200 (no rilancio AC)
4. Dedup: cerca event_log type='ac_webhook' con stesso email|phone
   negli ultimi 5 min → se trovato → log 'dedup_skip', return 200
5. Trova campaign attiva con ac_list_match = list.name OR list.id
   se non trovata → log error 'config_error', return 200
6. Upsert lead per phone_e164
7. Find or create conversation (campaign_id = matched)
8. Costruisci variabili: per ogni template_variables[i]
   - source='lead_field' → leggi lead[value]
   - source='static' → usa value
9. Twilio.messages.create({
     contentSid, contentVariables, to: 'whatsapp:'+phone,
     from: TWILIO_WHATSAPP_NUMBER, statusCallback: '<URL>/api/webhooks/twilio'
   })
   Timeout 10s, retry 2× con backoff (1s, 4s) su 5xx/network
10. INSERT messages (direction='out', is_template=true, twilio_sid, twilio_status='queued')
11. Return 200 OK
```

**Filosofia**: il webhook AC restituisce **sempre 200** (eccetto secret invalido). Errori applicativi → `event_log`, mai rilanciati come 5xx (causerebbero retry infiniti AC).

### 6.3 Flusso inbound (lead risponde via WhatsApp)

```
POST /api/webhooks/twilio
body: { From, To, Body, MessageSid, ... }   oppure status callback con MessageStatus
header: X-Twilio-Signature

1. Valida X-Twilio-Signature con TWILIO_AUTH_TOKEN
   se fallisce e TWILIO_VALIDATE_SIGNATURE != 'false' → 403
2. Log payload in event_log
3. Branch:
   a) Status callback (MessageStatus presente):
      UPDATE messages SET twilio_status, twilio_error_code WHERE twilio_sid=MessageSid
      Return 200
   b) Inbound message (Body presente):
      - Estrai phone E.164 da From (rimuovi prefix 'whatsapp:')
      - Find or create lead (con solo phone se nuovo)
      - Find or create conversation
      - INSERT messages (direction='in', body=Body, twilio_sid=MessageSid)
        UNIQUE(twilio_sid) → dedup automatica retry Twilio
      - UPDATE conversations SET
          last_message_at=now(),
          last_inbound_at=now(),
          unread_count = unread_count + 1
4. Return 200 (TwiML vuoto)
```

### 6.4 Flusso risposta dell'operatore

```
POST /api/messages
body: { conversation_id, mode: 'free'|'template', body?, template_id?, vars? }

1. Verifica sessione → 401 se assente
2. Carica conversation + lead
3. mode='free':
     verifica last_inbound_at >= now() - 24h
     se no → 422 'window_expired'
     Twilio.messages.create({ body, to, from, statusCallback })
   mode='template':
     carica campaign per template_id (deve essere active)
     Twilio.messages.create({ contentSid, contentVariables: vars, to, from, statusCallback })
4. INSERT messages (direction='out', body, is_template, twilio_sid, twilio_status='queued')
5. UPDATE conversations SET last_message_at=now()
6. Return { id, twilio_sid }
```

UI: optimistic update (bolla con stato 'queued') → Realtime aggiorna stato vero quando arriva il status callback.

## 7. UI

### Layout globale
- Sidebar fissa sx (~220px): logo, nav (Dashboard, Inbox `[badge]`, Campagne, Log), utente in basso con menu logout
- Area contenuto a destra
- Tema: shadcn/ui zinc + accent verde `#25D366` usato con parsimonia su CTA principali e stati positivi
- Dark mode con switch (cookie persistito)
- Responsive: sidebar diventa drawer su mobile; inbox stack (lista → tap → thread)

### `/login`
Form email + password, errori inline, niente self-service. Redirect a `/inbox` (o `?from=`).

### `/dashboard`
Tre stat card (Inviati oggi + delta, Inviati totali, Non lette cliccabile), pallino stato sistema con ultimo errore 60min, area chart invii ultimi 14 giorni (Recharts), card "Ultime 5 risposte".

### `/inbox` — two-pane

**Pannello sx (1/3)**: search, filtri (Tutte / Non lette / Ultimi 7gg), lista conversazioni ordinate per `last_message_at desc`, ognuna con `<PhoneAvatar />` (iniziali, colore deterministico), nome (o numero), preview body 1 riga, timestamp relativo, badge non lette. Realtime: nuove conversazioni scivolano in cima.

**Pannello dx (2/3)**:
- Header: nome lead + numero E.164 + menu `…` (vuoto V1)
- Timeline messaggi con bolle dx/sx per direction, separatori data ("Oggi", "Ieri", "12 marzo"), `<DeliveryStatus />` sotto ogni outbound (queued ⏱ / sent ✓ / delivered ✓✓ / read ✓✓ blu / failed ⚠), bolle template marcate "Template: <nome campagna>", tooltip su errori
- Composer:
  - Finestra aperta (`last_inbound_at >= now() - 24h`): textarea + Invia (Cmd/Ctrl+Enter), tab "Libero" / "Template"
  - Finestra chiusa: banner giallo "Sono passate più di 24 ore..." + selettore campagna + preview con variabili sostituite
- Auto-marca-letti: aprendo conversazione, UPDATE batch `read_at = now()` su tutti gli inbound non letti, UPDATE `conversations.unread_count = 0`
- Realtime: nuovo `in` → bolla in fondo + beep + Notification API (se permesso) + badge sidebar incrementa se non è la conversazione aperta
- Notification API: chiediamo permesso al primo accesso a `/inbox` con toast non invasivo

### `/campagne`
Tabella (Nome, Lista AC, Template SID, # variabili, Attiva, Azioni). Bottone "Nuova campagna" → drawer con form: nome, `ac_list_match`, Template SID, `<TemplateVariablesEditor />` (righe dinamiche con dropdown `Campo lead | Valore statico` + valore), toggle Attiva. Validazione Zod client + server. Modifica/Elimina = soft delete (`active=false`).

### `/log`
Tab "Invii": tabella `messages` direction='out' (Lead, Campagna, Stato, Inviato il, Errore), filtri (stato, range data, ricerca numero), paginazione 50. Click riga → drawer dettaglio (payload Twilio, error code, link conversazione).

Tab "Eventi sistema": ultimi 200 record `event_log`, filtri tipo + livello.

## 8. Sicurezza

- **Auth**: Supabase Auth email/password. Middleware Next.js protegge tutto tranne `/login`, `/api/webhooks/*`, asset statici. Cookie httpOnly+Secure via `@supabase/ssr`. Niente registrazione self-service.
- **Webhook AC**: token segreto via `?secret=<AC_WEBHOOK_SECRET>` (AC non firma). Mismatch → 403.
- **Webhook Twilio**: validazione `X-Twilio-Signature` con SDK ufficiale. Mismatch → 403. Override `TWILIO_VALIDATE_SIGNATURE=false` solo in dev locale.
- **Rate limit base**: 60 req/min per IP sui webhook (Vercel Runtime Cache key `rl:<ip>`). Non bloccante in V1 — si attiva se vediamo abusi.
- **DB**: RLS abilitata, policy `authenticated` per tutto (single tenant). Webhook usano `service_role` key (mai esposta al browser).
- **Segreti**: tutti in env Vercel, scope Production+Preview+Development. `.env.example` checkato, `.env.local` ignorato.
- **GDPR**: nota in README sui dati personali trattati. V1 niente UI export/delete (gestibile via SQL on demand).

## 9. Gestione errori

| Caso | Comportamento |
|---|---|
| Telefono AC assente/malformato | Normalizza E.164. Se ancora invalido → log warn, no invio, AC riceve 200 |
| Campagna non trovata per lista | Log error 'config_error' con payload, no invio, AC riceve 200 |
| Twilio 5xx / timeout | Retry 2× con backoff (1s, 4s). Se ko → `twilio_status='failed'`, log error |
| Twilio 4xx (numero non WA, template invalido) | No retry, `twilio_status='failed'` + error code, log |
| Webhook AC duplicato (<5 min) | Log 'dedup_skip', no invio, AC riceve 200 |
| Webhook Twilio duplicato (stesso SID) | UNIQUE constraint blocca INSERT silenziosamente, log info |
| Server temp down | AC e Twilio ritentano in autonomia → flussi sono idempotenti |
| Errore invio dalla UI | Toast con messaggio chiaro, optimistic update annullato, log error |
| Sessione scaduta | Middleware → redirect a `/login?from=<path>` |

**Filosofia**: webhook rispondono **sempre 200** salvo problemi di sicurezza (firma/secret invalidi → 403). Errori applicativi finiscono in `event_log`, visibili nella tab "Eventi sistema".

## 10. Testing

- **Unit (Vitest)**: `lib/phone.ts` (normalizzazione +39 default), `lib/twilio.ts` con SDK mockato, `lib/ac.ts` (dedup window), `lib/campaigns.ts` (matching + render variabili)
- **Integration (Vitest)**: route handler webhook chiamati con fixture di payload AC e Twilio reali (anonymizzati) → assert su DB Supabase locale
- **E2E (Playwright)**: solo happy path UI (login → inbox → click conversazione → invio risposta libera → bolla outbound visibile)
- **CI minimale**: GitHub Action su push → `bun install`, `bun typecheck`, `bun test`

## 11. Deploy & infrastruttura

- **Hosting**: Vercel, Fluid Compute (default), regione `fra1` (latenza UE)
- **Build**: `next build` con Turbopack
- **Branch strategy**: `main` → production, ogni branch → preview deployment automatico
- **Webhook URL**: production `https://<dominio>/api/webhooks/{activecampaign,twilio}`. Per dev locale: ngrok o tunnel Vercel CLI (istruzioni in README)
- **Supabase**: progetto unico, free tier sufficiente. Migrations versionate in `supabase/migrations/`, applicate via MCP `mcp__supabase__apply_migration` o `supabase db push`. Tipi TypeScript generati con `supabase gen types typescript`
- **Tipo client SDK**: `@supabase/supabase-js` typed (no Drizzle V1)

## 12. Configurazione & credenziali

### 12.1 Divisione delle responsabilità

**Azioni manuali necessarie dell'utente** (ridotte all'osso):
1. Crea repo GitHub vuota → comunica URL
2. Login Vercel + collega repo (auto-deploy on push) → comunica project name
3. Crea progetto Supabase vuoto → comunica project URL + service role key (servirà per MCP)
4. Comunica credenziali Twilio: Account SID, Auth Token, numero WhatsApp (`whatsapp:+1...`), Content SID di ogni template approvato Meta + descrizione delle variabili `{{1}}`, `{{2}}`, ...
5. Comunica credenziali ActiveCampaign: API key + URL account (es. `nomeaccount.api-us1.com`) + nome esatto della/e lista/e che farà da trigger
6. **L'unica config in pannello esterno**: in AC creare l'Automation con trigger "Si iscrive a lista X" + azione Webhook POST verso `https://<dominio>/api/webhooks/activecampaign?secret=<AC_WEBHOOK_SECRET>`. Le Automation di AC non sono modificabili via API.

**Tutto il resto fatto in autonomia tramite MCP/CLI/API:**
- Migrations Supabase (`mcp__supabase__apply_migration`)
- Creazione utente admin in Supabase Auth (admin API via service role)
- Set env vars Vercel (`vercel env add` o MCP)
- Configurazione webhook Twilio sul numero WA (Twilio API: `POST /2010-04-01/Accounts/{SID}/IncomingPhoneNumbers/{SID}.json` con `SmsUrl` e `StatusCallback`) o equivalente per Messaging Services
- Generazione `AC_WEBHOOK_SECRET` (random 32 bytes)
- Setup repo (`git init`, `gh repo create`, push iniziale)
- Tutti i deploy (push → auto-deploy Vercel)
- Test end-to-end con un lead di prova

### 12.2 Variabili d'ambiente

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # solo server, mai al browser

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_NUMBER=           # formato whatsapp:+1XXXXXXXXXX
TWILIO_VALIDATE_SIGNATURE=true    # false solo in dev locale

# ActiveCampaign
AC_API_KEY=                        # opzionale V1 (per future query attive)
AC_ACCOUNT_URL=                    # opzionale V1
AC_WEBHOOK_SECRET=                 # generato a deploy time

# App
NEXT_PUBLIC_APP_URL=               # https://...vercel.app
```

`.env.example` checkato in repo con tutte le chiavi e descrizioni.

## 13. Deliverable

Coerenti con sezione 10 della spec cliente:

1. Codice sorgente Next.js completo, env documentate, README di setup
2. Webapp con Dashboard, Inbox, Campagne, Log
3. `.env.example` con tutte le variabili
4. README con istruzioni deploy Vercel + setup Supabase + collegamento webhook
5. Istruzioni per la creazione dell'Automation AC (l'unica azione manuale residua)
6. Documento di test (in README): come verificare il flusso completo con un lead di prova

## 14. Open questions / da definire in fase implementazione

Nessuna decisione architetturale aperta. Dettagli minori che si chiariranno cammin facendo:
- Esatto formato del payload AC (quale campo conterrà nome lista? `list.name`, `[[contact.list]]`, `tags`?) — verificheremo con un primo test webhook reale
- Quale endpoint Twilio è giusto per setup webhook se il numero WA è dentro un Messaging Service vs standalone — verificheremo all'atto della configurazione
