# WhatsApp Lead Messaging

Webapp che riceve nuovi lead da ActiveCampaign via webhook, invia immediatamente un template WhatsApp tramite Twilio, e gestisce le risposte in un'inbox stile WhatsApp con notifiche real-time.

Spec completa: [`docs/superpowers/specs/2026-05-01-whatsapp-lead-design.md`](docs/superpowers/specs/2026-05-01-whatsapp-lead-design.md)
Piano implementativo: [`docs/superpowers/plans/2026-05-01-whatsapp-lead-messaging.md`](docs/superpowers/plans/2026-05-01-whatsapp-lead-messaging.md)

## Stack

- **Next.js 16** (App Router, Server Components, Turbopack)
- **TypeScript** strict
- **Supabase** (Postgres + Realtime + Auth)
- **Twilio** (WhatsApp Business)
- **ActiveCampaign** (webhook trigger su iscrizione lista)
- **Tailwind v4 + shadcn/ui**
- **Vitest** (unit) + **Playwright** (E2E)
- **Vercel** (Fluid Compute, regione default)

## Setup locale

```bash
bun install
cp .env.example .env.local   # poi compila i valori
bun dev                      # http://localhost:3000
```

Per testare i webhook in locale serve un tunnel pubblico:

```bash
bunx ngrok http 3000
# usa l'URL ngrok come NEXT_PUBLIC_APP_URL e nei webhook
```

## Variabili d'ambiente

Vedi `.env.example`. In production tutte sono settate su Vercel.

| Variabile | Scopo |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role (server only — webhooks) |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_WHATSAPP_NUMBER` | Numero WA approvato Meta (`whatsapp:+...`) |
| `TWILIO_VALIDATE_SIGNATURE` | `true` in prod, `false` solo dev locale |
| `AC_API_KEY` | API key AC (riservato per estensioni future) |
| `AC_ACCOUNT_URL` | URL account AC (es. `nomeaccount.api-us1.com`) |
| `AC_WEBHOOK_SECRET` | Token segreto in URL del webhook AC |
| `NEXT_PUBLIC_APP_URL` | URL base prod (`https://...vercel.app`) |

## Deploy

Auto-deploy via Vercel a ogni push su `main`. Branch diversi → preview deployment.

## Setup webhook

### ActiveCampaign

1. AC → **Automations** → New automation → Start from scratch
2. Trigger: **Subscribes to a list** → seleziona la lista
3. Aggiungi azione **Webhook** con URL:
   ```
   https://<dominio-vercel>/api/webhooks/activecampaign?secret=<AC_WEBHOOK_SECRET>
   ```
4. Active → Save

### Twilio (numero WhatsApp standalone)

```bash
# Trova il SID del numero WA
curl -u $TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json"

# Configura inbound + status callback
curl -u $TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN \
  -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/<NUMBER_SID>.json" \
  --data-urlencode "SmsUrl=https://<dominio-vercel>/api/webhooks/twilio" \
  --data-urlencode "SmsMethod=POST" \
  --data-urlencode "StatusCallback=https://<dominio-vercel>/api/webhooks/twilio"
```

Se il numero è dentro un **Messaging Service**:

```bash
curl -u $TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN \
  -X POST "https://messaging.twilio.com/v1/Services/<SERVICE_SID>" \
  --data-urlencode "InboundRequestUrl=https://<dominio-vercel>/api/webhooks/twilio" \
  --data-urlencode "StatusCallback=https://<dominio-vercel>/api/webhooks/twilio"
```

## Operazioni comuni

### Aggiungere un nuovo utente alla webapp

Supabase Dashboard → Authentication → Users → **Add user** (email + password, "auto confirm").

### Aggiungere una campagna

UI `/campagne` → **Nuova campagna** → compila Nome, Lista AC trigger (nome esatto o ID), Template Content SID (`HX...`), variabili template, Attiva → Crea.

### Test del flusso completo

1. Iscrivi un lead di test alla lista AC con telefono valido
2. `/log` tab "Eventi sistema" → record `ac_webhook` ricevuto
3. `/log` tab "Invii" → riga con stato `queued` → `sent` → `delivered`
4. Telefono di test riceve il messaggio template
5. Risponde dal telefono → `/inbox` mostra la conversazione + bolla in entrata
6. Notifica desktop appare (se permesso)
7. Rispondi dalla webapp con messaggio libero → riceve sul telefono

## GDPR

Dati personali trattati: nome, cognome, email, numero di telefono, contenuto messaggi WhatsApp. V1 non espone UI per export/delete: per richieste GDPR contattare l'amministratore — operazione manuale via SQL su Supabase (`delete from leads where ...`, cascade automatica su conversations + messages).

## Test

```bash
bun test              # unit (Vitest)
bun run typecheck     # tsc --noEmit
bun run build         # next build
bun run test:e2e      # Playwright (richiede E2E_EMAIL + E2E_PASSWORD)
```
