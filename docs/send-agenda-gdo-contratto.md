# `POST /api/send-agenda` — contratto per il CRM

Implementazione del brief `docs/send-agenda-gdo-brief.md`. Questo file è quello da
mandare al team CRM: descrive solo ciò che vedono loro.

## Richiesta

`POST https://<app>/api/send-agenda`, header `x-bot-signature: sha256=<hmac>` calcolato
sul **corpo grezzo** con `BOT_WEBHOOK_SECRET` (identico a `/api/bot/intake`).

```json
{
  "leadId": "uuid-del-lead-nel-crm",
  "name": "Mario Rossi",
  "phone": "333 123 4567",
  "email": "mario@esempio.it",
  "funnel": "Nome funnel",
  "companyId": "fenice",
  "variant": { "lavora": true, "haFamiglia": false, "offertaDelMese": false }
}
```

- `leadId`, `phone` e `companyId: "fenice"` sono obbligatori; il resto può mancare.
- Il telefono può arrivare grezzo: la normalizzazione E.164 è nostra.
- `variant` può mancare o avere campi non booleani: vale come tutto `false` (video di
  default). `offertaDelMese` prevale su `lavora`/`haFamiglia`.

## Risposta

Sempre **200** quando la richiesta è valida: l'esito sta nel corpo, non nello stato HTTP.

```json
{
  "ok": true,
  "esito": "consegnato",
  "message": "Messaggio consegnato al lead.",
  "deduplicato": false,
  "conversationId": 1234,
  "sid": "SMxxxxxxxx"
}
```

| `esito` | Significato | Il GDO può ritentare? |
|---|---|---|
| `consegnato` | Twilio ha confermato `delivered`/`read` | — |
| `inviato` | accettato da Twilio, nessuna conferma entro ~8s (telefono spento/offline) | **NO**: arriverebbe doppio appena torna online |
| `fallito` | numero non su WhatsApp, template bloccato, Twilio giù | sì |

La risposta arriva entro ~8 secondi dall'inizio della richiesta: oltre non si aspetta e
si risponde `inviato`.

Codici diversi da 200 solo per errori di protocollo: `401` firma non valida, `403`
`companyId` diverso da `fenice`, `400` corpo non valido, `429` rate limit,
`503` secret non configurato lato nostro.

### Deduplica

Stesso `leadId` entro **15 minuti**: non si rimanda niente, si risponde con l'esito
precedente e `deduplicato: true`. Il blocco **non** vale dopo un `fallito`: lì il
re-invio è proprio quello che serve.

## Cosa fa il bot dopo

1. **Subito**: template `fenice_agenda_gdo_v3` (UTILITY) col link di prenotazione, che
   chiede esplicitamente al lead di rispondere.
2. **Alla prima risposta del lead** (qualunque, anche solo "ok"): il video della
   variante, come testo libero. Senza quella risposta la finestra 24h resta chiusa e il
   video non parte — per questo il GDO deve dire al lead di rispondere al messaggio.
3. **Da lì in poi**: il bot gestisce la conversazione sapendo che l'appuntamento è già
   fissato. Non ripropone la call, non ripete il pitch, non manda solleciti.

## Cosa il bot NON fa su questi lead

Il lead resta di proprietà del GDO:

- **mai un esito**: al CRM arriva solo `outcome: "NOTA"` su `/api/bot/outcome`, che non
  deve toccare stato del lead né appuntamento. Serve il vostro OK perché quell'endpoint
  accetti NOTE su lead non assegnati al bot;
- niente sequenza di riaggancio, niente follow-up "prenota", niente classificazione
  automatica a 14 giorni.

Se il lead chiede esplicitamente di parlare con una persona, la chat passa a un umano
(come sempre) e il bot smette di rispondere.

## Prima del go-live

Da parte vostra: conferma dei tre esiti e della finestra di deduplica,
`BOT_WEBHOOK_SECRET` concordato, permesso perché `/api/bot/outcome` accetti NOTE sui
lead dei GDO, e l'istruzione ai GDO di far rispondere il lead al messaggio.
