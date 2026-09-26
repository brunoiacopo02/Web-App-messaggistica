# Parco numeri del bot: da "bot 1 / bot 2" a N numeri, scelti dal bot

Data: 2026-09-26 · Stato: approvata dal PO il 26/09 (strada 1, "fai la strada migliore") · Repo: bot (`whatsapp-lead`), tocco minimo sul CRM

## 1. Perché

Il 26/09/2026 il PO ha due numeri nuovi da mettere al lavoro:

| numero | account Twilio | WABA | qualità | limite | template |
|---|---|---|---|---|---|
| `+393520413199` | principale "Clickfunnel" | `1500822281514617` | **MEDIUM** (risalito da LOW) | 10K | tutti |
| `+393520158061` | principale | `1500822281514617` (lo stesso del 3199) | HIGH | 10K | tutti (stesso account) |
| `+393522018718` | **"account elixir"** `AC717b…b356` | `1094465422976837` (nuovo) | n.d. | 10K | 30 sottomessi il 26/09, in attesa di Meta |
| `+393522070047` | "Account fenice 2" | `1083218987430626` | LOW | ~2K (dal PO) | 50 |

Oggi il codice conosce **due** numeri, in due posti che devono restare d'accordo: il CRM sceglie
`numeroBot: 1 | 2` e conta i "bot 2 di oggi"; il bot rifà lo stesso conteggio col suo tetto
`BOT2_DAILY_CAP`. Aggiungere due numeri così vorrebbe dire quattro contatori in due repo.

## 2. Decisioni del PO (26/09)

1. **Divisione "A"**: il 3199 resta il principale e prende tutto quello che gli altri non prendono.
   Elixir e 8061 partono con **150 chat nuove al giorno ciascuno**. Il 0047 va **a riposo**
   (0 chat nuove, finisce le sue). Lunedì 28/09 si guarda come va, e il 0047 va ripreso in
   considerazione perché serve scaldarlo per il lancio del 5/10.
2. **Strada 1**: il numero lo sceglie **solo il bot**. Il CRM smette di scegliere.
3. **Prima di accendere**, test sul telefono del PO (`+393476525616`). Elixir si accende solo
   quando i template sono approvati **e** la categoria è quella giusta.

## 3. Principi (dagli incidenti già pagati)

- **Un lead, un numero** ([project_un_lead_un_numero]): il numero si sceglie **solo alla nascita**
  della conversazione (`conversations.wa_number`) e non cambia mai più. Niente di questo lavoro
  tocca le chat già aperte.
- **Fallisce chiuso verso il 3199.** Qualunque dubbio (manopola illeggibile, conteggio in errore,
  template non traducibile o bloccato dal presidio) = la chat nasce sul 3199, e resta una riga in
  `event_log`. Mai un lead muto, mai un mittente inatteso.
- **Nessun ripiego a chat aperta.** Se un invio dal numero della chat fallisce, fallisce e si logga
  (regola del 17/09, invariata).
- **I tetti in un posto solo**, e cambiabili senza deploy.

## 4. Il disegno

### 4.1 Registro dei numeri e degli account (env, statico)

- `lib/twilio-account.ts` impara un **terzo account**: `TWILIO_ACCOUNT_SID_3`, `TWILIO_AUTH_TOKEN_3`,
  `TWILIO_WHATSAPP_NUMBERS_3` (stesso schema del secondo). Un numero non elencato in nessun account
  secondario sta sul principale: è il caso del 8061, che quindi **non richiede credenziali nuove**.
  Si generalizza a una lista di slot (2, 3) invece di copiare il codice.
- `lib/mittente.ts`: i numeri del bot diventano **primario + `BOT_NUMERI_SECONDARI`** (lista separata
  da virgole, forma `whatsapp:+39…`). Se `BOT_NUMERI_SECONDARI` è assente vale il comportamento di
  oggi (`TWILIO_WHATSAPP_NUMBER_FENICE_2`), così il deploy del codice **non cambia niente** finché non
  si scrive l'env.
- `eNumeroDelBot` / `numeriDelBot` riconoscono l'**unione** di primario, `BOT_NUMERI_SECONDARI`,
  `TWILIO_WHATSAPP_NUMBER_FENICE_2` e `TWILIO_WHATSAPP_NUMBERS_2`/`_3` (deduplicati, forma
  `whatsapp:+…`): è ciò che serve al webhook in ingresso per svegliare Mario su una risposta arrivata
  a elixir o al 8061. `BOT_NUMERI_SECONDARI` resta la lista dei **sceglibili** (`numeriSecondari`,
  voci normalizzate a `whatsapp:+…`): riconosciuto e sceglibile sono separati, così dimenticare il
  0047 nella lista non rompe le sue chat.
- `lib/template-account.ts`: la traduzione per `friendly_name` vale per **qualunque** account diverso
  dal principale (oggi solo per il secondo). Per il 8061 non si traduce niente: stesso account.

### 4.2 I tetti (app_settings, runtime)

Nuova chiave `app_settings.tetti_numeri`, per esempio:

```json
{ "whatsapp:+393522018718": 150, "whatsapp:+393520158061": 150, "whatsapp:+393522070047": 0 }
```

- Un numero secondario **assente** dalla mappa, o con valore non intero / negativo, vale **0**
  (fail-closed: senza un tetto scritto da una persona un numero non apre niente).
- Il primario non ha tetto.
- Si cambia dal DB (o da un campo nel pannello impostazioni, se costa poco) **senza deploy**: è la
  manopola che il PO userà lunedì.
- `BOT2_DAILY_CAP` smette di contare per il bot (resta solo come storico in doc).

### 4.3 La scelta del numero per una chat che nasce adesso

Un solo modulo, `lib/scelta-mittente.ts`, usato da `enrollLeadIntoMario` ed `enrollLancio`.
`findOrCreateLeadConversation` (`lib/messaging.ts`) non sceglie: usa il mittente che riceve, e senza
mittente fa nascere la chat sul primario (`mittentePerNuovaConversazione`, sorteggio tolto).

```
scegliMittenteNuovo(supabase, { templateSid, chiave, ignoraTetti? }) → { from, motivo, scartati[] }
```

1. Legge `tetti_numeri`. Candidati = i secondari con tetto > 0.
2. Per ciascuno conta le conversazioni **nate oggi** (giorno civile di Roma) con quel `wa_number`
   — la stessa prova usata oggi da `bot2-tetto.ts`, che si generalizza da un numero a N. Scarta chi
   ha raggiunto il tetto.
3. Scarta i numeri dichiarati su un altro account (`TWILIO_WHATSAPP_NUMBERS_N`) di cui mancano
   SID/TOKEN dello slot: le credenziali ripiegherebbero sul principale, che non possiede il numero
   (401). Motivo `credenziali_mancanti`, riga `mittente_ripiego`.
4. Sui rimasti verifica che il template d'apertura sia **spedibile** da quel numero
   (`spedibileDa`: traduzione riuscita + presidio `UTILITY_ONLY`). Scarta chi non lo è.
5. Fra i rimasti prende **quello con meno chat nate oggi** (a parità, ordine della lista): i numeri
   nuovi si riempiono in modo bilanciato invece che uno dopo l'altro.
6. Nessun candidato → **3199**. Ogni scarto dovuto a un problema (non al tetto pieno, che è normale)
   finisce in `event_log` come `mittente_ripiego` con numero, motivo ed errore; il tetto pieno come
   `mittente_tetto` a livello `info`, una volta per numero al giorno (prima di scriverla si contano le
   righe di oggi con lo stesso `payload->>numero`; conteggio fallito = non si scrive).

Il conteggio fra la lettura e l'INSERT non è atomico: due intake concorrenti possono sforare il tetto
di qualche unità. È accettato (il tetto protegge la qualità, non un contratto): più sicuro di un lock.

### 4.4 Cosa arriva dal CRM

- `numeroBot` e `riscaldamento` restano nel contratto (niente versione nuova), ma il bot **non li
  usa più per scegliere**: "decide il bot". Un `numeroBot: 2` da un CRM non ancora aggiornato non
  forza più il 0047, che è a riposo.
- Lato CRM: `BOT2_DAILY_CAP=0` in produzione (manda sempre 1, il conteggio `contaBot2Oggi` diventa
  inerte) e `BOT_WARMUP` spento (il cron del riscaldamento del 0047 non sposta più lead). **Nessuna
  modifica di codice obbligatoria nel CRM**; la pulizia di `numeroBot.ts` si può fare dopo, a parte.

### 4.5 Il lancio

- `lancio_sender='principale'` (valore attuale): invariato, tutti i benvenuti dal 3199.
- `lancio_sender='secondario'` e `lancio_quota_secondario`: invece di "il 0047" vogliono dire "un
  secondario scelto da `scegliMittenteNuovo`". `secondario` scelto a mano **ignora i tetti giornalieri** (come
  oggi: decisione umana dal pannello) ma **non il riposo**: un numero a tetto 0 resta escluso. La
  quota automatica rispetta i tetti.
- La decisione su quale numero usare il 5/10 resta del PO e non fa parte di questo lavoro.

### 4.6 Il numero di default `TWILIO_WHATSAPP_NUMBER` (oggi = 8061)

Il 8061 è ancora il mittente di default di `sendTemplate` senza `from` (`/api/send-template`, anche
dal CRM per Serenamente; `send-batch`; conversazioni nate dal webhook ActiveCampaign). Da settembre da
lì non è partito niente di tutto questo (verificato su Twilio: solo i 5 promemoria sbagliati del 18/09).

**Decisione PO 26/09: Serenamente è un progetto sospeso, si tratta come se non esistesse.** Quindi
`TWILIO_WHATSAPP_NUMBER` si porta al **3199** prima di accendere il 8061: da quel momento il 8061
parla solo quando lo sceglie `scegliMittenteNuovo`, e nessun flusso di default può mandare da lì.

## 5. Accensione (ordine, un passo alla volta)

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

## 6. Test

- Unitari (Vitest, accanto ai moduli): registro account a 3 slot; `numeriDelBot` con/senza
  `BOT_NUMERI_SECONDARI`; lettura `tetti_numeri` fail-closed; `scegliMittenteNuovo` su tutti i casi
  (nessun secondario, tetto pieno, template non traducibile, bloccato dal presidio, conteggio in
  errore, bilanciamento, `ignoraTetti`); traduzione template sul terzo account.
- Aggiornamento dei test esistenti che presuppongono il solo 0047 (`fenice-enroll`, `lancio-mittente`,
  `bot2-tetto`, `mittente`, `twilio-account`, `template-account`).
- `bun run typecheck`, `bun test`, `bun run build` verdi prima del push.

## 7. Fuori perimetro

- Nessuna modifica ai testi verso i lead, agli orari o alle sequenze.
- Nessun cambio del contratto CRM↔bot (resta v1.7).
- Pulizia del codice `numeroBot` nel CRM: dopo, a parte.
- Il TODO di `sendTemplate` sul template non tradotto a chat aperta (audit 18/09 §3): resta com'è;
  il nuovo modulo ne è protetto perché verifica la spedibilità **prima** di far nascere la chat.
