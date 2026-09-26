# Il parco numeri del bot

Da "bot 1 / bot 2" a **N numeri**, e la scelta del mittente di una chat nuova la
fa **solo il bot** (decisione PO 26/09/2026). Riferimento pieno:
`docs/superpowers/specs/2026-09-26-parco-numeri-design.md`.

## 1. Numeri, account, WABA

| numero | account Twilio | WABA | ruolo dal 26/09 |
|---|---|---|---|
| `+393520413199` | principale ("Clickfunnel") | `1500822281514617` | principale: prende tutto quello che i secondari non prendono, nessun tetto |
| `+393520158061` | principale (stesso account del 3199) | `1500822281514617` | secondario, tetto 150/giorno |
| `+393522018718` | "account elixir" (slot 3) | `1094465422976837` | secondario, tetto 150/giorno, si accende solo a template approvati |
| `+393522070047` | "Account fenice 2" (slot 2) | `1083218987430626` | secondario, a riposo (tetto 0) |

Il numero di un account "slot" (2 e 3) sta su un WABA suo: se Meta restringe un
WABA blocca tutti i suoi numeri insieme, quindi un numero nuovo su un account
separato è il ripiego vero, non lo stesso punto di rottura con un nome diverso
(`lib/twilio-account.ts`). Il `8061` non ha bisogno di credenziali nuove: sta
sullo stesso account del `3199`, è solo un numero in più nello stesso WABA.

## 2. Env

- `BOT_NUMERI_SECONDARI`: lista dei numeri secondari del bot, separati da
  virgola, forma `whatsapp:+39…` (`lib/mittente.ts`). Assente → vale il solo
  `TWILIO_WHATSAPP_NUMBER_FENICE_2` (comportamento di prima del 26/09): il
  deploy del codice non cambia niente finché non si scrive questa env.
- `TWILIO_ACCOUNT_SID_3`, `TWILIO_AUTH_TOKEN_3`, `TWILIO_WHATSAPP_NUMBERS_3`:
  terzo slot di credenziali ("account elixir"), stesso schema del secondo
  (`TWILIO_ACCOUNT_SID_2` / `TWILIO_AUTH_TOKEN_2` / `TWILIO_WHATSAPP_NUMBERS_2`,
  già esistenti). Un numero non elencato in nessuno slot sta sul principale:
  è il caso dell'`8061` (`lib/twilio-account.ts`).
- `TWILIO_WHATSAPP_NUMBER`: il mittente di default di `sendTemplate` senza
  `from` (`/api/send-template`, `send-batch`, conversazioni nate dal webhook
  ActiveCampaign). Va portato al `3199` **prima** di accendere l'`8061` come
  secondario (spec §4.6), altrimenti un flusso di default potrebbe mandare
  dall'`8061` fuori dal controllo di `scegliMittenteNuovo`.
- `BOT2_DAILY_CAP`: storico, non conta più per la scelta del mittente (che
  guarda `tetti_numeri`, sotto). Va messo a `0` lato CRM insieme a `BOT_WARMUP`
  spento, così il CRM smette di contare/forzare un numero che ormai decide
  solo il bot.

Nessun segreto (SID, token) va scritto in questo file: vivono solo su Vercel.

## 3. Il tetto giornaliero: `app_settings.tetti_numeri`

Chiave runtime, non env: il PO la cambia da DB senza deploy. Colonne di
`app_settings` (`supabase/migrations/20260616000005_fenice_ai.sql`): `key`
(text, PK), `value` (jsonb), `updated_at`.

Formato di `value` — mappa numero (forma `whatsapp:+39…`) → tetto intero:

```json
{ "whatsapp:+393522018718": 150, "whatsapp:+393520158061": 150, "whatsapp:+393522070047": 0 }
```

- Un numero secondario assente dalla mappa, o con un valore che non è un
  intero ≥ 0, vale **0**: fail-closed, un numero non apre niente finché una
  persona non ci scrive un tetto (`lib/tetti-numeri.ts`).
- Il primario non ha tetto e non passa da questa chiave.
- La riga non esiste ancora: il primo `update` va fatto con un `insert … on
  conflict` (idempotente, funziona sia la prima volta sia le successive):

```sql
insert into app_settings (key, value)
values (
  'tetti_numeri',
  '{"whatsapp:+393522018718": 150, "whatsapp:+393520158061": 150, "whatsapp:+393522070047": 0}'::jsonb
)
on conflict (key) do update set value = excluded.value, updated_at = now();
```

## 4. Chi sceglie il mittente di una chat nuova

Un solo modulo, `lib/scelta-mittente.ts` (`scegliMittenteNuovo`), usato da
tutti i punti di nascita di una conversazione (`enrollLeadIntoMario`,
`enrollLancio`, il sorteggio di default di `findOrCreateLeadConversation`).
Guarda `tetti_numeri`, conta le chat nate oggi (giorno civile di Roma) per
numero, scarta i numeri non spedibili (template non tradotto o bloccato dal
presidio `UTILITY_ONLY`) e sceglie fra i rimasti quello con meno chat nate
oggi. Nessun candidato → `3199`.

Il campo `numeroBot` e `riscaldamento` restano nel contratto CRM↔bot (v1.7,
invariato), ma dal 26/09/2026 il bot li **ignora** per questa scelta.

### Da guardare in `event_log`

- `mittente_ripiego` (`warn`): uno scarto dovuto a un problema (non al tetto
  pieno, che è normale) — template non traducibile, presidio, conteggio
  fallito, tetti illeggibili. Payload con numero e motivo.
- `mittente_tetto` (`info`): un numero ha raggiunto il tetto del giorno.
  Una riga per numero al giorno.
- `lancio_mittente_ripiego`: lo stesso, lato benvenuti del lancio
  (`lib/lancio-mittente.ts`, `lib/lancio-blast-motore.ts`).

## 5. Accensione (ordine, un passo alla volta)

Copiato da `docs/superpowers/specs/2026-09-26-parco-numeri-design.md` §5.

1. **Deploy del codice con le env nuove assenti**: comportamento identico a
   oggi. Verifica: aperture dal `3199` e dal `0047` come prima, zero
   `mittente_ripiego`.
2. **Riposo del `0047`**: `tetti_numeri = {"whatsapp:+393522070047": 0}` +
   env `BOT_NUMERI_SECONDARI` col solo `0047`. Lato CRM `BOT2_DAILY_CAP=0`,
   `BOT_WARMUP` spento.
3. **`8061`**:
   0. `TWILIO_WHATSAPP_NUMBER` → `whatsapp:+393520413199` su Vercel (§4.6 della
      spec, Serenamente è sospeso e si tratta come se non esistesse);
   a. messaggio di prova dal `8061` al telefono del PO: il PO conferma di
      leggere **"Fenice Academy"** (la console e l'API non valgono);
   b. il PO risponde e verifica che Mario risponda dal `8061`;
   c. aggiunta dell'`8061` a `BOT_NUMERI_SECONDARI` e tetto 150.
4. **Elixir** (quando Meta ha approvato):
   a. controllo categoria template per template: quelli mandati UTILITY
      devono essere UTILITY. Se uno è stato riclassificato MARKETING, si
      decide col PO prima di proseguire;
   b. webhook del sender `+393522018718` puntato a
      `https://web-app-messaggistica.vercel.app/api/webhooks/twilio`
      (callback e status callback);
   c. env `TWILIO_ACCOUNT_SID_3`, `TWILIO_AUTH_TOKEN_3`,
      `TWILIO_WHATSAPP_NUMBERS_3` su Vercel;
   d. test sul telefono del PO: apertura, risposta, risposta di Mario, agenda
      — tutto da elixir;
   e. credito e ricarica automatica di elixir attivi (li imposta il PO);
   f. aggiunta a `BOT_NUMERI_SECONDARI` e tetto 150.
5. **Lunedì 28/09**: lettura qualità dei 4 numeri, chat nate per numero,
   `mittente_ripiego`; decisione PO su tetti e sul `0047`.
