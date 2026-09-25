# Lancio Web Developer AI — runbook della prova generale (B6) e della serata

Webinar Zoom **lunedì 5 ottobre 2026, ore 21:00 (Roma)**. Questo file è la lista di
controllo operativa: cosa si prova prima, cosa si accende e quando, cosa si guarda in
`event_log` a ogni passo. Il quadro d'insieme dei blocchi B1-B5 sta in
`docs/lancio-webdev-recap.md`; la spec è
`docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md`.

**Regola che vale sopra tutte le altre:** gli interruttori del lancio li decide Bruno.
Nessuna sessione, nessun cron e nessuno script li accende da solo.

---

## 0-bis. Il giorno del deploy (subito, non il 4/10)

- [ ] **`offerta_del_mese_link` va impostato appena il codice va in produzione**, da
      `/fenice/impostazioni`. Il pulsante **"Offerta del mese"** dell'agenda GDO non
      aspetta il 5 ottobre: è già in cima alla modale e i GDO lo useranno **oggi**. Con il
      link vuoto l'agenda parte **senza video** e resta solo un
      `offerta_del_mese_link_mancante` (warn) che nessuno sta guardando — cioè agende
      andate a vuoto senza che nessuno se ne accorga. È l'unica chiave del lancio che
      **non** si aspetta la sera del 5.

---

## 0. I tre cron a data fissa (`vercel.json`)

| Voce | Schedule (UTC) | Cosa vuol dire a Roma |
|---|---|---|
| `/api/cron/lancio-zoom` | `*/5 17-18 5 10 *` | 5/10, ogni 5', copre le 19:00-20:55; il blast vero è 19:30-20:45 (finestra fine nel codice) |
| `/api/cron/lancio-followup` | `*/5 10-11,15-17 6-7 10 *` | 6 e 7/10, ogni 5', copre 12:00-13:55 e 17:00-19:55; le fasce vere sono 12:00-14:00 e 17:30-19:30 |
| `/api/cron/lancio-restituzioni` | `0 * 7-31 10 *` + `0 * 1-15 11 *` | ogni ora, **dal 7/10** al 15/11 |

Le **finestre vere** le derivano i moduli da `app_settings.lancio_evento_at`
(`inFinestraFollowup`, `restituzioniAttive`, il blast Zoom): la data scritta nel cron è
solo il giorno in cui Vercel sveglia la funzione, e i run in più girano a vuoto.

> **Se `lancio_evento_at` resta indietro non parte niente, in silenzio.** È già successo:
> dopo una prova generale era rimasta al 17/09. Tutti e quattro i cron del lancio ora lo
> controllano da soli (`allarmeEventoStantio`, `lib/lancio-blast-motore.ts`) e scrivono un
> **`lancio_evento_at_nel_passato`** di livello `error` in `event_log`, **una volta al
> giorno per cron**. Non blocca nessun run: urla e basta. La soglia non è uguale per tutti,
> perché non tutti i cron vivono prima dell'evento:
> `lancio-aperture` e `lancio-zoom` girano prima o il giorno stesso → suonano se la data è
> di **ieri**; `lancio-followup` (6-7/10) e `lancio-restituzioni` (dal 7/10) girano per
> definizione dopo → suonano solo se la data è vecchia di **più di 14 giorni**, cioè se è
> il residuo di un lancio precedente.

> **Spostare l'evento = aggiornare `vercel.json`.** Se `lancio_evento_at` cambia senza
> toccare le tre voci qui sopra, il blast, il follow-up e le restituzioni diventano attivi
> in giorni in cui Vercel non chiama nessuno: **non succede niente, in silenzio**. L'unica
> spia è `fuori_finestra_cron` nel riepilogo `lancio_restituzioni_run` — e solo se quel run
> capita di girare. Sul blast e sul follow-up non c'è nessuna spia.

- [ ] Se la data del webinar si sposta: cambiare `lancio_evento_at` **e** le tre voci di
      `vercel.json`, poi ridistribuire (Vercel rilegge i cron solo a deploy fatto) e
      controllare su **Vercel → Settings → Cron Jobs** che le date nuove ci siano.

---

## 1. Prova generale (B6) con un numero di test

Si prova **senza toccare i lead veri**: un numero di test iscritto alla lista, e ogni cron
forzato su quella sola conversazione.

### 1.1 Le sonde dei tre cron

Autenticazione: `?secret=$CRON_SECRET` (oppure header `Authorization: Bearer $CRON_SECRET`).

- [ ] **Blast Zoom** — `GET /api/cron/lancio-zoom?secret=…&forza=1&solo=<conversationId>`
- [ ] **Follow-up** — `GET /api/cron/lancio-followup?secret=…&forza=1&solo=<conversationId>`
- [ ] **Restituzioni** — `GET /api/cron/lancio-restituzioni?secret=…&forza=1&solo=<conversationId>`

Regole comuni (`leggiParametriCron`):

- `forza=1` salta **solo** il filtro della finestra/data, e vale **solo** insieme a
  `solo=<conversationId>`: da solo è un `400` (`forza=1 richiede solo=<conversationId>`).
  È la guardia che impedisce di mandare il template a tutta la coda per sbaglio.
- `now=<ISO con offset>` sposta l'orologio del run (es. `now=2026-10-06T12:10:00%2B02:00`,
  ricordarsi di url-encodare il `+`). Su follow-up e restituzioni vale **solo** insieme a
  `solo=`; sul blast Zoom è libero (i suoi 42 test lo usano così).
- `dry=1` fa il giro senza mandare niente: risponde coi conteggi e scrive il riepilogo.
  È il modo giusto per la prima passata.
- Senza `forza` e fuori finestra la risposta è `{ ok: true, skipped: 'fuori_finestra' }`
  (follow-up) o `{ ok: true, skipped: 'prima_della_data' }` (restituzioni).

### 1.2 L'orologio dei turni (assistenza e post-pitch)

I turni della chat (assistenza al collegamento, dopo-pitch) non passano dai cron: leggono
l'ora vera. Per provarli si usa la finta di `lib/lancio-orologio.ts`:

```
LANCIO_FAKE_NOW=2026-10-05T22:40:00+02:00
LANCIO_FAKE_NOW_ARMED=<uguale a CRON_SECRET, solo se si prova in produzione>
```

- [ ] Fuori produzione basta `LANCIO_FAKE_NOW` nel `.env.local`.
- [ ] In produzione la finta vale **solo** se `LANCIO_FAKE_NOW_ARMED` è identica a
      `CRON_SECRET`: è un doppio giro di chiave voluto.
- [ ] **A prova finita si tolgono da Vercel.** `npx vercel env ls production` **non** deve
      elencare `LANCIO_FAKE_NOW` né `LANCIO_FAKE_NOW_ARMED`. Va verificato il 4/10.

### 1.3 Il CRM ha le date scritte a mano

`LANCIO_WEBDEV` in `src/lib/lancio/config.ts` del repo CRM fissa `webinarAt`
(`2026-10-05T21:00:00+02:00`), `giornoDopo` (`2026-10-06`) e `dopodomani` (`2026-10-07`).
Quelle date **non** si leggono da nessun setting. Quindi:

> Se per la prova si sposta `lancio_evento_at` sul bot, `/api/bot/lancio/slots` e
> `/api/bot/lancio/book` rispondono **422 `fuori_regole`**: per il CRM gli slot chiesti non
> esistono. Non è un bug del bot.

Come si prova lo stesso — tre strade, in ordine di preferenza:

- [ ] **(a) Lasciare `lancio_evento_at` dov'è e forzare i cron** (`forza=1&solo=<id>`): è il
      motivo per cui `forza` esiste. Bot e CRM restano d'accordo sulle date, e la prenotazione
      del 6/10 si prova davvero.
- [ ] **(b) Provare sulle date vere con il lead di test:** la sera del 5 e il 6 mattina il
      percorso è quello di produzione, con una conversazione sola.
- [ ] **(c) `?now=` insieme a `solo=<id>`** per le parti che **non** chiamano il CRM (finestre,
      coda, testi, timbri): sposta l'orologio del solo run, sul solo lead di test. Appena il
      giro arriva a `slots`/`book` il 422 torna: quella parte si prova con (a) o (b).
- [ ] Alternativa solo per chi ha un CRM di prova: puntarci `CRM_LANCIO_URL` (vuota =
      produzione) dopo aver spostato lì le date di `LANCIO_WEBDEV`.

### 1.4 Il percorso completo da provare

- [ ] benvenuto (lista d'attesa) → "sì" → fase `posto_bloccato`
- [ ] blast Zoom forzato → `lancio_link_inviato_at` timbrato, fase `link_inviato`
- [ ] assistenza al collegamento (con `LANCIO_FAKE_NOW` sulla sera del 5)
- [ ] pulsante del webinar → `post_pitch` → scelta (chiamata subito / prenotazione) →
      `slots` e `book` del CRM
- [ ] follow-up forzato del 6 → risposta del lead → Mario standard con il **video della
      live** (`lancio_video_live_link`)
- [ ] agenda GDO con **"Offerta del mese"** → il video arriva da `offerta_del_mese_link`
- [ ] restituzione forzata → il lead compare nel pool `LANCIO_WEBDEV_2026` di `/import`
- [ ] il lead restituito riscrive → evento `lancio_inbound_dopo_restituzione`, nota al CRM,
      **il bot non risponde** e non lo ri-drive nemmeno il cron orario

---

## 2. Prima del 5/10 (da fare entro il 4)

- [ ] I tre template `fenice_lancio_*` **approvati UTILITY** sull'account in uso:
      `node scripts/qualita-numero.mjs` per qualità e limite del numero, e per la categoria
      di ogni SID
      `curl -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" https://content.twilio.com/v1/Content/<SID>/ApprovalRequests`
      (`whatsapp.category` = `UTILITY`, `status` = `approved`). Con `UTILITY_ONLY=1` un
      template MARKETING ferma il run con `fermo: 'template_bloccato'` alla prima chiamata;
      la deroga è `UTILITY_ONLY_ALLOW` (SID separati da virgola).
- [ ] Env di produzione presenti (`npx vercel env ls production` — si guardano **solo i
      nomi**, i valori non si aprono e non si stampano): `LANCIO_WELCOME_TEMPLATE_SID`,
      `LANCIO_ZOOM_TEMPLATE_SID`, `LANCIO_FOLLOWUP_TEMPLATE_SID`,
      `TWILIO_WHATSAPP_NUMBER_FENICE`, `CRON_SECRET`, `BOT_WEBHOOK_SECRET`, `UTILITY_ONLY`.
      **Verificato il 17/09: ci sono tutte.**
- [ ] Env di produzione **assenti**: `LANCIO_FAKE_NOW`, `LANCIO_FAKE_NOW_ARMED`
      (verificato il 17/09: assenti, come deve essere).
- [ ] `LANCIO_ZOOM_BATCH_MAX`, `LANCIO_BATCH_MAX`, `LANCIO_RESTITUZIONI_MAX`,
      `LANCIO_WELCOME_MAX_PER_HOUR`, `LANCIO_APERTURE_MAX_PER_RUN` e `CRM_LANCIO_URL`
      **non sono in produzione, ed è giusto così**: i default del codice sono già i valori
      deliberati (300 / 200 / 500 / 200 / 100 / URL di produzione del CRM). Si
      aggiunge l'env solo per cambiarli.
- [ ] **Chi governa cosa (dal 25/09):** il blast Zoom del 5 ha la sua,
      `LANCIO_ZOOM_BATCH_MAX` (300 per run: 16 run × 300 = 4.800 posti per ~4.000 iscritti);
      `LANCIO_BATCH_MAX` (200) resta **solo** del follow-up del 6, che prima degli invii fa
      letture e congedi in sequenza e non ha bisogno di correre. Le restituzioni hanno la
      loro, `LANCIO_RESTITUZIONI_MAX` (500).
- [ ] Il mittente secondario resta spento: `TWILIO_WHATSAPP_NUMBERS_2` non è in produzione,
      quindi `TWILIO_ACCOUNT_SID_2`/`TWILIO_AUTH_TOKEN_2` (dell'altra sessione) non
      instradano niente. Il lancio parte dal numero principale, `lancio_sender=principale`.
- [ ] `/fenice/impostazioni` si apre in produzione e mostra le **8 chiavi** del lancio coi
      valori attuali.
- [ ] `lancio_zoom_link` è il link giusto e si apre.
- [ ] Vercel → Settings → Cron Jobs: le tre voci del lancio ci sono.

---

## 3. Timeline 4/10 → 7/10

Gli interruttori sono chiavi di `app_settings` (valore `jsonb`). Si cambiano da
**`/fenice/impostazioni`** (pagina admin, scrive via `POST /api/fenice/lancio-settings` e
lascia un `lancio_setting_cambiata` con `{key, old, new, who}`), oppure — solo se la pagina
non fosse raggiungibile — in SQL:

```sql
update app_settings set value = 'true'::jsonb           where key = 'lancio_attivo';
update app_settings set value = '"https://…"'::jsonb    where key = 'lancio_video_live_link';
```

> L'audit `lancio_setting_cambiata` esiste solo passando dalla pagina: da SQL nessuno saprà
> chi ha girato la manopola. La pagina è la strada normale, SQL è l'uscita di emergenza.

### 4/10 — preparazione
- [ ] Tutta la sezione 2 spuntata.
- [ ] `lancio_attivo` = **false** (si accende domani), `lancio_pulsante_attivo` = **false**.
- [ ] `lancio_blast_perimetro` = `tutti`, `lancio_sender` = `principale`.
- [ ] `lancio_quota_secondario` = **0**, salvo decisione di Bruno. E' la quota di
      riscaldamento del numero nuovo sui **benvenuti** del lancio: 9 vuol dire uno dal
      numero nuovo ogni dieci dal vecchio. Si spegne rimettendola a 0 dal pannello (o
      `update app_settings set value='0'::jsonb where key='lancio_quota_secondario';`).
      Lo stesso lead finisce sempre sullo stesso numero, e se il benvenuto non e'
      spedibile dal numero nuovo parte comunque dal vecchio con un
      `lancio_mittente_ripiego` (warn) in `event_log`.

### 5/10 ore 18:00 — go / no-go
- [ ] Qualità del numero ≥ MEDIUM e limite ≥ 10K (`node scripts/qualita-numero.mjs`).
- [ ] **Go:** `lancio_attivo` = **true**.
- [ ] **Piano B** (qualità bassa o limite stretto): `lancio_blast_perimetro` = `risposto` —
      il link Zoom va solo a chi ha risposto almeno una volta. Si decide **adesso**, non a
      blast partito.
- [ ] `lancio_sender` resta **`principale`**. Il secondario si accende solo se lo dice Bruno,
      e oggi non è pronto (KYC del secondo numero mai avviata).

### 5/10 ore 19:00-20:45 — blast del link Zoom
Da guardare in `event_log`:
`lancio_zoom_run` (riepilogo di ogni run) · `lancio_zoom_config_error` · `lancio_zoom_query_error`
· `lancio_zoom_messages_query_error` · `lancio_zoom_messaggio_non_costruito` · `lancio_zoom_freno`
(error) · `lancio_zoom_freno_non_applicato` (error) · `lancio_sender_secondario_non_disponibile`
(warn) · `lancio_mittente_ripiego` (warn: un benvenuto che doveva partire dal numero nuovo
e' partito da quello storico) · `lancio_apertura_freq_capped` · `lancio_fase_non_cambiata` · `lancio_fase_non_scritta`.

- [ ] Il primo `lancio_zoom_run` fuori finestra (le 19:00) verifica la configurazione senza
      mandare: se manca qualcosa esce `lancio_zoom_config_error`.
- [ ] Dalle 19:30 lotti da 300 ogni 5'. `inviati` + `riparati` devono salire a ogni run.
- [ ] Un run con `fermo: 'tempo'` vuol dire che 300 invii non sono stati nei 240s (stima:
      120-180s): non si perde nessuno, i residui li prende il run dopo. Se capita a ogni
      run, abbassare `LANCIO_ZOOM_BATCH_MAX` (per esempio a 250) — ma a quel punto gli
      ultimi iscritti potrebbero restare senza link a finestra chiusa: guardare `residui`.
- [ ] `capped` (63049, frequency cap di Meta per destinatario) **non è un freno**: il timbro
      si libera e si ritenta al run dopo.

### 5/10 dopo le 21:00 — il pulsante
- [ ] `lancio_pulsante_attivo` = **true** **SOLO dopo le 21:00**, poco prima del pitch. Acceso
      prima, chi scrive per caso quella frase entra nel dopo-pitch a vuoto.
- [ ] Turni venditori "sera" caricati su `/lancio` (CRM).
- [ ] Da guardare: `lancio_pulsante` (anche `orfano` col motivo), `lancio_scelta`,
      `lancio_slots_mostrati`, `lancio_slots_vuoti`, `lancio_slots_non_letti`,
      `lancio_crm_call`, `lancio_crm_errore`, `lancio_giro_interrotto`.

### 6/10 ore 11:30 — **il controllo che vale più di tutti gli altri**

> Il modo più probabile in cui questo lancio fallisce non è un bug: è **il freno rimasto
> tirato**. Se la sera del 5 il blast si è fermato da solo, `lancio_attivo` è `false`, e
> alle 12:00 il follow-up **non parte** — senza che niente si rompa. Si accorge solo chi
> guarda: nei log c'è un `lancio_followup_fermo` (warn) a ogni run, e il danno si vede
> il 7/10, quando quelle persone tornano nel pool con la nota `Lancio: follow-up non inviato`.

- [ ] **Alle 11:30 del 6/10 una persona apre `/fenice/impostazioni` e guarda
      `lancio_attivo`.** Se è `false`: capire perché (§4), decidere, e riaccenderlo **prima
      delle 12:00**. Non è un controllo automatico e non lo fa nessun cron.
- [ ] `lancio_video_live_link` impostato **prima delle 12:00**. Senza, chi risponde riceve i
      video classici e in `event_log` compare `lancio_video_live_link_missing` (warn, **una
      volta per chat**: se lo vedi una volta sola non vuol dire che sia successo una volta
      sola).
- [ ] **Dalle 03:00 del 6 i pulsanti di scelta non esistono più** (decisione PO 25/09).
      Chi preme il pulsante del webinar dal 6 in poi va a **Mario standard**, che fissa la
      call come per qualunque lead, con la nota "ha visto la live" e la registrazione
      (`lancio_fase` = `chiuso`, `lancio_info.mario_dopo_notte.da` = `pulsante`; evento
      `lancio_pulsante` con `dopoNotte: true`). Da quell'ora vale **anche a
      `lancio_pulsante_attivo` spento**: l'interruttore governa solo la sera del 5, e lo si
      può spegnere il 6 senza conseguenze.
- [ ] Le chat rimaste in `post_pitch` che riscrivono dopo le 03:00 passano anche loro a Mario
      (evento `lancio_post_pitch_a_mario`, `mario_dopo_notte.da` = `post_pitch`): Mario
      riceve le risposte del riscaldamento date la sera e non le richiede. Un tocco il 6 su
      un pulsante della sera ("Fissiamo domani") non chiama il CRM del lancio: lo legge Mario.

### 6/10 12:00-14:00 e 17:30-19:30 (sconfina al 7/10) — follow-up
Da guardare: `lancio_followup_run` · `lancio_followup_inviato` · `lancio_followup_fermo` (warn,
a ogni run se `lancio_attivo` è spento) · `lancio_followup_config_error` ·
`lancio_followup_query_error` · `lancio_followup_messages_query_error` ·
`lancio_followup_idempotenza_query_error` · `lancio_followup_blocco_troncato` (warn) ·
`lancio_followup_ancora_non_marcata` · `lancio_followup_congedo_da_cron` ·
`lancio_followup_congedo_senza_telefono` · `lancio_followup_freno` /
`lancio_followup_freno_non_applicato` (error) · `lancio_followup_risposta`.

- [ ] Chi aveva già detto "no" in modo esplicito non riceve niente: il cron lo congeda senza
      bolla (`lancio_followup_congedo_da_cron`).
- [ ] Il follow-up va anche a chi era rimasto in **`post_pitch`** (pulsante premuto la sera
      del 5 e poi silenzio). Chi invece **scrive il 6** — un inbound dalle 03:00 in poi —
      è già passato a Mario standard (fase `chiuso`) e il follow-up non lo tocca; il
      contatore `saltati.in_scelta` resta per chi fosse ancora in `post_pitch` con un
      inbound dopo le 03:00 (turno non ancora girato).
- [ ] Chi risponde al follow-up torna al flusso standard di Mario, col video della live.
- [ ] Chi risponde "no" dopo il follow-up lo gestisce Mario standard (`DA_SCARTARE`).

### 7/10 in poi — restituzioni al pool

> **Il 6/10 è tutto del bot** (risposte e follow-up): non si restituisce nessuno. Le
> restituzioni partono il **7/10**, così i GDO possono chiamare quei lead quel giorno
> stesso (decisione PO del 19/09; prima partivano l'8).
Da guardare: `lancio_restituzioni_run` (con `restituiti`, `rifiutati`, `errori`,
`niente.ancora_ignota`, `scartiRitentati`/`scartiChiusi`, `fuori_finestra_cron`) ·
`lancio_restituito` · `lancio_restituito_terminale` · `lancio_restituzione_rifiutata` (warn) ·
`lancio_restituzione_fase_cambiata` (warn) ·
`lancio_restituzione_error` · `lancio_restituzioni_config_error` ·
`lancio_restituzioni_query_error` · `lancio_restituzioni_messages_query_error` ·
`lancio_restituzioni_blocco_troncato` (warn) · `lancio_scarto_ritentato_da_cron` ·
`lancio_scarto_senza_telefono` · `lancio_inbound_dopo_restituzione` ·
`lancio_nota_restituzione_non_marcata`.

- [ ] Tre motivi, con note **verbatim** che il CRM riconosce: `Lancio: mai risposto`,
      `Lancio: silenzio dopo il follow-up` (**24 ore** di chat ferma, misurate
      sull'ultimo messaggio in qualunque direzione: il follow-up che abbiamo mandato, o la
      risposta del lead se è arrivata dopo),
      `Lancio: follow-up non inviato`. Non si cambia una virgola.
- [ ] I lead restituiti compaiono nel pool `LANCIO_WEBDEV_2026` di `/import` sul CRM.
- [ ] `lancio_restituzione_rifiutata` (il CRM ha risposto 200 ma `returnedToPool: false`,
      cioè `skipped`): la fase resta intatta, quei lead si guardano **a mano**.
- [ ] `niente.ancora_ignota`: righe senza benvenuto né intake, da guardare a mano.
- [ ] `faseCambiata` (evento `lancio_restituzione_fase_cambiata`, warn): il lead è andato al
      CRM ma nel frattempo la chat si era mossa (il lead ha risposto, Mario l'ha chiusa), e
      la fase **non** viene timbrata `restituito`. Non si ritenta: si guarda a mano se il
      numero non è zero.
- [ ] Tornano al pool anche i **`post_pitch`** rimasti a metà. Restano fuori solo le chat in
      `scelta_fatta`: quel lead ce l'ha in mano il CRM.
- [ ] Chi è **in conversazione viva** resta al bot e torna al pool più avanti, man mano che
      la chat si spegne: nel riepilogo è `niente.ha_risposto` finché l'ultimo messaggio ha
      meno di 24 ore, poi `niente.attesa_24h` non lo trattiene più.
- [ ] `offerta_del_mese_link` **non** si aspetta il 7/10: va impostato il giorno del deploy
      (§0-bis). Se dopo la live cambia l'offerta, si aggiorna da `/fenice/impostazioni`.

---

## 4. Il freno automatico, e la riaccensione

Il freno guarda i **tentativi** (riusciti + falliti) a blocchi di 25: se i non arrivati
superano la soglia, o compaiono codici gravi (63018 = limite del numero, 63051 = numero
sospeso), il run si ferma e **`lancio_attivo` va a `false` da solo**.

- [ ] Evento `lancio_zoom_freno` / `lancio_followup_freno` (**error**) con `tentati`,
      `inviati`, `falliti`, `incerti`, `capped`, `codici`, `candidati`, `lotto`.
- [ ] Se compare anche `lancio_zoom_freno_non_applicato` / `lancio_followup_freno_non_applicato`
      (**error**): la scrittura del setting è fallita, `lancio_attivo` è rimasto acceso.
      **Spegnerlo a mano dal pannello, subito.**
- [ ] A lancio spento i run successivi rispondono `skipped: 'lancio_non_attivo'`, e il
      follow-up **in finestra** scrive anche `lancio_followup_fermo` (warn) a **ogni run**:
      se la sezione Follow-up sembra morta il 6, la spiegazione è quella.

**Riaccensione = decisione umana.** Prima si capisce la causa (63018: il numero ha finito il
limite giornaliero; 63051: numero sospeso; oltre il 10% di falliti su almeno 20 tentativi, senza codice grave: numeri
morti o Meta che rifiuta), poi `lancio_attivo` = true dal pannello. Il run successivo riparte
**da dove si era fermato**: i timbri (`lancio_link_inviato_at`, `lancio_followup_inviato_at`)
tengono i già serviti fuori dalla coda.

> **Il freno della sera del 5 blocca anche il follow-up del 6.** Se non si riaccende prima
> delle 12:00 del 6, il follow-up non parte, e chi aveva interagito torna al pool dal 7/10
> con la nota `Lancio: follow-up non inviato`. La decisione va presa la mattina del 6.

---

## 5. Gotcha da tenere a mente

- **`bot-followups` e il re-drive.** Il cron orario decide "c'è un inbound senza risposta" col
  predicato *l'ultima riga è un inbound*: un messaggio arrivato **prima** di una bolla del bot
  non viene visto. Riguarda **tutte** le chat di Mario, non solo il lancio. Le chat del lancio
  in corso sono comunque fuori dal watchdog (`lancioInCorso`), e quelle **restituite** hanno un
  veto esplicito (`lancioRestituito`): un lead tornato al GDO non viene mai ri-drivato, qualunque
  cosa dica `ai_status`.
- **Ore dure duplicate bot/CRM.** Le fasce (9-14 venditori, 15-20 Conferme, anticipo minimo 1h)
  stanno sia nel bot sia in `src/lib/lancio/config.ts` del CRM: se cambia una parte va cambiata
  l'altra, o le prenotazioni cominciano a tornare 422.
- **`adotta-mai-risposti` è manuale e bypassa l'interruttore.** Si lancia in POST con
  `{ esegui: true }`; per disegno **non** guarda `INBOUND_ADOPTION_ENABLED`, così può recuperare
  i "mai risposti" anche ad adozione spenta. Non va messo in un cron.
- **Una nota CRM all'ora per le chat restituite.** Un lead restituito che scrive cinque volte
  genera **una** nota (finestra oraria su `lancio_info.restituito_nota_at`); l'evento
  `lancio_inbound_dopo_restituzione` invece si scrive **sempre**. Se il marcatore è illeggibile
  si avvisa lo stesso: meglio una campanella in più che un GDO che chiama a vuoto.
- **`MAX_LETTURE_INTAKE = 50` per run** nel cron del follow-up: le righe senza ancora (né
  benvenuto né pulsante) costano una query a testa, e oltre 50 il run smette di cercarle e le
  riprende al giro dopo. Se il follow-up sembra "dimenticare" qualcuno, è quasi sempre questo:
  si risolve da solo nei run successivi, e i residui restano nel riepilogo.
- **Troncamento della cronologia.** `lancio_followup_blocco_troncato` e
  `lancio_restituzioni_blocco_troncato` (warn) dicono che un blocco di messaggi ha toccato il
  tetto di righe: quelle conversazioni finiscono in `ancora_ignota` invece di essere decise su
  una cronologia incompleta. Vanno guardate a mano, non ignorate.
- **`lancio_giro_interrotto`** (warn): un turno del lancio si è fermato a metà del ciclo dei
  giri. La chat resta `active` e la riprende il drain successivo.
- **`offerta_del_mese_link_mancante`** (warn, lato agenda GDO): qualcuno ha chiesto l'offerta del
  mese ma il link non è impostato: l'agenda parte **senza** video.

---

## 6. Da chiudere lato CRM prima del 5/10

- [ ] **Contratto `docs/bot-fissatore-contract.md` v1.7** (repo CRM): documentare i campi
      `returnedToPool` e `skipped` della risposta a `/api/bot/outcome` sui lead del lancio —
      è quello che il cron delle restituzioni legge per decidere se la fase diventa
      `restituito` o resta dov'è.
- [ ] **`LANCIO_WEBDEV_INTAKE`**: l'interruttore dell'intake lato CRM è ancora spento. Va
      acceso quando Bruno dà il via alla lista 132.
- [ ] **Turni venditori su `/lancio`**: turno "sera" del 5/10 e turno "giorno dopo" del 6/10
      compilati, con le ore dichiarate nel calendario disponibilità.
