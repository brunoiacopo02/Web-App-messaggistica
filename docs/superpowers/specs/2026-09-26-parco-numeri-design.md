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
- `eNumeroDelBot` / `numeriDelBot` riconoscono tutti i numeri della lista: è ciò che serve al webhook
  in ingresso per svegliare Mario su una risposta arrivata a elixir o al 8061.
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

Un solo modulo, `lib/scelta-mittente.ts`, usato da tutti i punti di nascita:
`enrollLeadIntoMario`, `enrollLancio` e il sorteggio di default di `findOrCreateLeadConversation`
(`lib/messaging.ts`, che oggi chiama `mittentePerNuovaConversazione`).

```
scegliMittenteNuovo(supabase, { templateSid, chiave, ignoraTetti? }) → { from, motivo, scartati[] }
```

1. Legge `tetti_numeri`. Candidati = i secondari con tetto > 0.
2. Per ciascuno conta le conversazioni **nate oggi** (giorno civile di Roma) con quel `wa_number`
   — la stessa prova usata oggi da `bot2-tetto.ts`, che si generalizza da un numero a N. Scarta chi
   ha raggiunto il tetto.
3. Sui rimasti verifica che il template d'apertura sia **spedibile** da quel numero
   (`spedibileDa`: traduzione riuscita + presidio `UTILITY_ONLY`). Scarta chi non lo è.
4. Fra i rimasti prende **quello con meno chat nate oggi** (a parità, ordine della lista): i numeri
   nuovi si riempiono in modo bilanciato invece che uno dopo l'altro.
5. Nessun candidato → **3199**. Ogni scarto dovuto a un problema (non al tetto pieno, che è normale)
   finisce in `event_log` come `mittente_ripiego` con numero, motivo ed errore; il tetto pieno come
   `mittente_tetto` a livello `info`, una volta per numero al giorno.

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
  secondario scelto da `scegliMittenteNuovo`". `secondario` scelto a mano **ignora i tetti** (come
  oggi: decisione umana dal pannello), la quota automatica li rispetta.
- La decisione su quale numero usare il 5/10 resta del PO e non fa parte di questo lavoro.

### 4.6 Il numero di default `TWILIO_WHATSAPP_NUMBER` (oggi = 8061)

Il 8061 è ancora il mittente di default di `sendTemplate` senza `from` (`/api/send-template`, anche
dal CRM per Serenamente; `send-batch`; conversazioni nate dal webhook ActiveCampaign). Da settembre da
lì non è partito niente di tutto questo (verificato su Twilio: solo i 5 promemoria sbagliati del 18/09).

**Decisione PO 26/09: Serenamente è un progetto sospeso, si tratta come se non esistesse.** Quindi
`TWILIO_WHATSAPP_NUMBER` si porta al **3199** prima di accendere il 8061: da quel momento il 8061
parla solo quando lo sceglie `scegliMittenteNuovo`, e nessun flusso di default può mandare da lì.

## 5. Accensione (ordine, un passo alla volta)

1. **Deploy del codice con le env nuove assenti**: comportamento identico a oggi (§4.1). Verifica:
   aperture dal 3199 e dal 0047 come prima, zero `mittente_ripiego`.
2. **Riposo del 0047**: `tetti_numeri = {"whatsapp:+393522070047": 0}` + env `BOT_NUMERI_SECONDARI`
   col solo 0047. Lato CRM `BOT2_DAILY_CAP=0`, `BOT_WARMUP` spento.
3. **8061**:
   0. `TWILIO_WHATSAPP_NUMBER` → `whatsapp:+393520413199` su Vercel (§4.6);
   a. messaggio di prova dal 8061 al telefono del PO: il PO conferma di leggere **"Fenice Academy"**
      (la console e l'API non valgono: ci siamo già cascati il 19/09);
   b. il PO risponde e verifica che Mario risponda dal 8061;
   c. aggiunta del 8061 a `BOT_NUMERI_SECONDARI` e tetto 150.
4. **Elixir** (quando Meta ha approvato):
   a. controllo categoria template per template: quelli mandati UTILITY devono essere UTILITY.
      Se uno è stato riclassificato MARKETING, si decide col PO prima di proseguire;
   b. webhook del sender `+393522018718` puntato a `https://web-app-messaggistica.vercel.app/api/webhooks/twilio`
      (callback e status callback);
   c. env `TWILIO_ACCOUNT_SID_3`, `TWILIO_AUTH_TOKEN_3`, `TWILIO_WHATSAPP_NUMBERS_3` su Vercel;
   d. test sul telefono del PO: apertura, risposta, risposta di Mario, agenda — tutto da elixir;
   e. credito e ricarica automatica di elixir attivi (li imposta il PO);
   f. aggiunta a `BOT_NUMERI_SECONDARI` e tetto 150.
5. **Lunedì 28/09**: lettura qualità dei 4 numeri, chat nate per numero, `mittente_ripiego`; decisione
   PO su tetti e sul 0047.

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
