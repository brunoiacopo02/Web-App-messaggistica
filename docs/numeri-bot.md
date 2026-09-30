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

- `BOT_NUMERI_SECONDARI`: lista dei numeri secondari **sceglibili** per una
  chat nuova, separati da virgola (`lib/mittente.ts`, `numeriSecondari`). Forma
  `whatsapp:+39…`; una voce scritta `+39…` viene normalizzata. Assente → vale il
  solo `TWILIO_WHATSAPP_NUMBER_FENICE_2` (comportamento di prima del 26/09);
  vuota (`""`) → nessun secondario sceglibile.
  Sceglibile non vuol dire riconosciuto: i numeri che il bot **riconosce** come
  suoi (webhook che sveglia Mario, chat esistenti che continuano dal loro
  numero) sono l'unione di primario, `BOT_NUMERI_SECONDARI`,
  `TWILIO_WHATSAPP_NUMBER_FENICE_2` e `TWILIO_WHATSAPP_NUMBERS_2`/`_3`
  (`numeriDelBot`). Così dimenticare il `0047` nella lista non rompe le sue
  chat vive. Mai togliere dalla lista un numero con chat vive (§5, Regola).
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
`enrollLeadIntoMario` ed `enrollLancio`. `findOrCreateLeadConversation`
(`lib/messaging.ts`) non sceglie niente: usa il mittente che gli passa chi
chiama, e senza mittente fa nascere la chat sul primario
(`mittentePerNuovaConversazione`).

`scegliMittenteNuovo` legge `tetti_numeri` (illeggibili → `3199`), scarta i
secondari a riposo (tetto 0 o assenti dalla mappa), conta le chat nate oggi
(giorno civile di Roma) per numero e scarta chi ha raggiunto il tetto, scarta
i numeri dichiarati su un altro account di cui mancano le credenziali
(`credenziali_mancanti`), poi quelli non spedibili (template non tradotto o
bloccato dal presidio `UTILITY_ONLY`) e sceglie fra i rimasti quello con meno
chat nate oggi (a parità, ordine della lista). Nessun candidato → `3199`.

Con `ignoraTetti` (il lancio con `lancio_sender='secondario'`) salta il
conteggio e il tetto giornaliero, ma **non il riposo**: un numero a tetto 0
resta escluso anche lì. La quota (`lancio_quota_secondario`) i tetti li
rispetta.

Il campo `numeroBot` e `riscaldamento` restano nel contratto CRM↔bot (v1.7,
invariato), ma dal 26/09/2026 il bot li **ignora** per questa scelta.

### Da guardare in `event_log`

- `mittente_ripiego` (`warn`): uno scarto dovuto a un problema (non al tetto
  pieno, che è normale) — template non traducibile, presidio, conteggio
  fallito, credenziali dello slot mancanti, tetti illeggibili, nessun template
  da verificare. Payload con numero e motivo.
- `mittente_tetto` (`info`): un numero ha raggiunto il tetto del giorno.
  **Una riga per numero per giorno di Roma**: prima di scriverla si contano in
  `event_log` le righe `mittente_tetto` di oggi con `payload->>numero` uguale;
  se ce n'è già una non si riscrive, e se il conteggio fallisce non si scrive
  (è solo un log).
- `lancio_mittente_ripiego`: lo stesso, lato benvenuti del lancio
  (`lib/lancio-mittente.ts`, `lib/lancio-blast-motore.ts`).

## 5. Accensione (ordine, un passo alla volta)

Copiato da `docs/superpowers/specs/2026-09-26-parco-numeri-design.md` §5.

1. **Deploy del codice con le env nuove assenti** (`BOT_NUMERI_SECONDARI` e
   `tetti_numeri` non scritti). Con `TWILIO_WHATSAPP_NUMBER_FENICE_2` impostata il
   `0047` resta l'unico secondario sceglibile, ma `tetti_numeri` assente vuol dire
   tetto 0 (fail-closed): il `0047` va a riposo **subito, al deploy**. È voluto
   (il `0047` è a riposo per decisione PO). Verifica:
   - `0047`: zero chat nuove; le risposte sulle chat esistenti del `0047` sono
     ancora gestite (Mario risponde da lì);
   - aperture nuove tutte dal `3199`; zero `mittente_ripiego`;
   - `app_settings.lancio_quota_secondario`: se è > 0, ogni benvenuto in quota
     scrive un `lancio_mittente_ripiego` (`warn`) perché non trova un secondario
     disponibile. Va letto prima del deploy e deciso col PO (0, o righe accettate).
2. **Riposo del `0047`**: `tetti_numeri = {"whatsapp:+393522070047": 0}` + env
   `BOT_NUMERI_SECONDARI` col solo `0047` (mette per iscritto lo stato del passo
   1). Lato CRM `BOT2_DAILY_CAP=0`, `BOT_WARMUP` spento.
3. **`8061`**:
   0. `TWILIO_WHATSAPP_NUMBER` → `whatsapp:+393520413199` su Vercel (§4.6 della
      spec: Serenamente è sospeso e si tratta come se non esistesse);
   a. **prima di metterlo in lista**: contare le chat con
      `wa_number = 'whatsapp:+393520158061'` che hanno risposte recenti del lead.
      Dal passo b il `8061` è un numero del bot: se `INBOUND_ADOPTION_ENABLED=1`
      Mario prenderebbe in carico quelle chat alla prossima risposta. Se ce ne
      sono, si decide col PO prima di proseguire;
   b. aggiunta dell'`8061` a `BOT_NUMERI_SECONDARI` **con tetto 0**
      (`"whatsapp:+393520158061": 0` in `tetti_numeri`): è riconosciuto dal
      webhook e Mario risponde da lì, ma non viene mai scelto per una chat nuova;
   c. messaggio di prova dal `8061` al telefono del PO: il PO conferma di
      leggere **"Fenice Academy"** (la console e l'API non valgono: ci siamo già
      cascati il 19/09);
   d. il PO risponde e verifica che Mario risponda dal `8061`;
   e. solo dopo il test: tetto 150 in `tetti_numeri`.
4. **Elixir** (quando Meta ha approvato):
   a. verifica su elixir, template per template, di **presenza e categoria di
      tutti i template che una chat può ricevere** — non solo l'apertura:
      aperture (`OPENING_SID_*`), sequenza (`MARTA_SEQ_*`), NR, agenda,
      promemoria, video, riaggancio, lancio. Quelli mandati UTILITY devono
      essere UTILITY; se uno manca o è stato riclassificato MARKETING si decide
      col PO prima di proseguire. La fa il controller con uno script sulla
      Content API dell'account elixir. Limite noto: la rotta
      `/api/admin/secondo-numero` non serve qui, guarda solo lo slot 2 (`0047`)
      e in questo giro non è stata generalizzata agli altri slot;
   b. webhook del sender `+393522018718` puntato a
      `https://web-app-messaggistica.vercel.app/api/webhooks/twilio`
      (callback e status callback);
   c. env `TWILIO_ACCOUNT_SID_3`, `TWILIO_AUTH_TOKEN_3`,
      `TWILIO_WHATSAPP_NUMBERS_3` su Vercel (da qui elixir è già riconosciuto
      come numero del bot, perché `numeriDelBot` legge anche
      `TWILIO_WHATSAPP_NUMBERS_3`, ma non è sceglibile);
   d. aggiunta a `BOT_NUMERI_SECONDARI` **con tetto 0**
      (`"whatsapp:+393522018718": 0` in `tetti_numeri`): mai scelto per una
      chat nuova finché il tetto resta 0;
   e. test sul telefono del PO: apertura, risposta, risposta di Mario, agenda
      — tutto da elixir;
   f. credito e ricarica automatica di elixir attivi (li imposta il PO);
   g. solo dopo il test: tetto 150 in `tetti_numeri`.
5. **Lunedì 28/09**: lettura qualità dei 4 numeri, chat nate per numero,
   `mittente_ripiego`; decisione PO su tetti e sul `0047`.

**Regola**: mai togliere da `BOT_NUMERI_SECONDARI` un numero che ha chat vive.
Per fermarlo si mette il suo tetto a 0: resta riconosciuto e le sue chat
continuano. Vale anche se dal 26/09 il riconoscimento non dipende più solo da
quella env (`numeriDelBot` unisce anche `TWILIO_WHATSAPP_NUMBER_FENICE_2` e
`TWILIO_WHATSAPP_NUMBERS_2`/`_3`): l'`8061`, che sta sul principale, è
riconosciuto solo finché è in lista.
