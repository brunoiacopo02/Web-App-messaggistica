# Lancio "Web Developer AI" — webinar del 5 ottobre 2026

Data: 2026-09-14 · Stato: **bozza da approvare (Bruno)** · Repo coinvolti: CRM GDO (`crm-sales-fenice`) e Software Messaggistica (`web-app-messaggistica`) · Sessione coordinatrice: CRM GDO, autorizzata a operare su entrambi.

## 0. In una pagina

I lead della lista ActiveCampaign **"Lancio Web Developer AI" (id 132)** non vanno ai GDO. Entrano nel CRM con funnel **"Lancio Web Dev AI"** e bucket **`LANCIO_WEBDEV_2026`**, vengono assegnati al bot (GDO 201) e **spinti subito al bot con la provenienza "lancio"**. Il bot:

1. **All'arrivo** manda il benvenuto (template, l'unico preimpostato). A chi risponde "sì" dice che il posto è bloccato e si ferma. Alle domande risponde secco (gratuito, niente prezzi, "ne parliamo dopo la live").
2. **Il 5 ottobre alle 20:00** manda a tutti il link Zoom (`https://us06web.zoom.us/j/89845223337`, nessun passcode) e fino a mezzanotte fa assistenza (il "codice" è l'ID nel link).
3. **La sera del 5**, chi preme il pulsante WhatsApp dopo il pitch sceglie: **chiamata subito** (round robin fra i venditori di turno, che chiamano e esitano da una scheda dedicata) oppure **appuntamento il 6**: le ore **9-15** ai venditori del giorno dopo (solo ore dichiarate nel loro calendario, slot occupato, niente chiamata di conferma), le ore **15-21** alle Conferme con etichetta lancio. Mattina piena → il bot propone il pomeriggio; chi può solo la mattina → 7/10 mattina, alle Conferme. Nel frattempo il bot fa due domande per riscaldare il lead e passa le info al venditore.
4. **Il 6 ottobre** (fasce 12-14 e 17:30-19:30, scaglionato, può sconfinare al 7) manda un follow-up a chi ha interagito ma non ha premuto il pulsante. Chi risponde fa il **flusso standard** (form + Conferme) con il **video della live editata** al posto del video classico.
5. **Chi non risponde** al follow-up entro 48 ore, e chi non ha mai risposto al benvenuto, **torna nel pool su /import** e da lì viene distribuito ai GDO come per Black Summer.
6. Dal 6 in poi, quando un GDO manda l'agenda con la spunta **"Offerta del mese"**, il bot manda il **video dell'offerta Web Dev** (link configurabile senza deploy).

In più, fuori dal lancio ma richiesto ora: **i lead che scrivono per primi da Telegram vanno gestiti** (branch del bot mai acceso), distinti da chi scrive dal pulsante del webinar.

Tutte le chat del lancio sono visibili nei pannelli chat del bot (le Conferme cercano per numero).

## 1. Decisioni prese con Bruno (14/09)

| # | Decisione |
|---|---|
| 1 | Lista 132 **bloccata subito** nel webhook (fatto, commit `cbbaa7d`): ads dal 15-16/09, i lead si accumulano in AC e vengono recuperati con un sync quando il flusso è live. La "Lista Pre lancio 2026" (133) si ignora. Duplicati cross-funnel voluti. |
| 2 | Solo il **primo** messaggio è template; il resto testo libero. Eccezione tecnica accettata: il link Zoom del 5 e il follow-up del 6 partono verso persone che non scrivono da giorni → per WhatsApp sono per forza template (§7). Il **video** invece viaggia sempre in testo libero, dentro la conversazione. |
| 3 | Webinar ore **21:00**, link **~1 ora prima**. Zoom senza passcode. |
| 4 | Numero WhatsApp: **quello attuale**, invii scaglionati. Il passo successivo a questo lavoro è attivare altri numeri (memoria salvata in entrambi i progetti; ne parla Bruno). |
| 5 | Domande prima del 5: risposte secche. "È a pagamento?" → l'evento è totalmente gratuito, la sera presentiamo le opportunità dell'accademia, **niente prezzi**. Il resto: "ne parliamo dopo la live". |
| 6 | Chiamata subito: venditori scelti dall'admin, round robin, scheda venditore dedicata; **NR → seconda chiamata come i GDO**; note e follow-up come oggi. |
| 7 | Slot solo **dichiarati**; la fascia **14-15 va ai venditori** (quindi venditori 9-15, Conferme 15-21). |
| 8 | Il pomeriggio (Conferme) non ha tetto. Mattina piena → pomeriggio; chi può solo la mattina → **dopodomani mattina alle Conferme**. |
| 9 | Solo i prenotati della **mattina del 6** saltano la telefonata di conferma. |
| 10 | Chi scrive il 6-7 dopo il follow-up: **flusso standard** (calendario standard, form, trafila Conferme), cambia solo il video = live editata (link da Bruno la mattina del 6). |
| 11 | Follow-up post webinar: 6/10 nelle fasce **12-14** e **17:30-19:30**, scaglionato, se serve anche il 7. Poi 48 ore e restituzione al pool. |
| 12 | Funnel "Lancio Web Dev AI", bucket `LANCIO_WEBDEV_2026`. Conta nelle KPI come Black Summer. |
| 13 | Agenda GDO: spunta **"Offerta del mese"** → video offerta Web Dev (link da Bruno dopo la live). |
| 14 | Lead che scrivono per primi da Telegram: gestiti normalmente, distinti dal pulsante webinar. |

Assunzioni mie non discusse (da confermare leggendo, altrimenti valgono):

- **A1.** Dopo 3 NR sulla chiamata subito, il lead passa alle Conferme il giorno dopo con etichetta lancio (non resta appeso al venditore).
- **A2.** Il promemoria della mattina del 6 ai prenotati 9-15 parte alle 08:30 in testo libero (sono dentro la finestra 24h perché hanno scritto la sera prima).
- **A3.** Il pulsante WhatsApp è un link `wa.me` con testo precompilato che definisco io (§6.3); lo mettete voi nella pagina/nella live.
- **A4.** Il benvenuto contiene la dichiarazione "assistente virtuale" richiesta dall'AI Act art. 50 (già regola del bot dal 2/8).
- **A5.** La restituzione al pool avviene dall'8/10 in poi (48 h dopo l'ultimo follow-up possibile), non prima: fino ad allora nessun lead lancio esce dal bot per silenzio.

## 2. Cosa esiste già e cosa si riusa

**CRM**
- Webhook AC (`src/app/api/webhooks/activecampaign/route.ts`): liste bloccate per nome normalizzato, quarantena funnel, routing bot/GDO, push `pushLeadToBot`. Il lancio aggiunge un **ramo prima del routing**: se il contatto è nella lista 132 → lead lancio, assegnato al bot, push immediato con provenienza lancio (§4.1).
- Pool: `leads.launchBucket` + registro `launchPools` (`kind='LAUNCH'`) + `pickAndAssignBuckets` + card su `/import`. Si clona il pattern Black Summer (`launchPoolActions.ts`) per il sync di recupero e la distribuzione ai GDO.
- Push al bot (`src/lib/bot-fissatore/push.ts`): il payload cresce di un campo opzionale `lancio` (§7.1). Prova di consegna = eventi `BOT_PUSHED` in `DELIVERED_PUSH_RESULTS`, invariato.
- Esiti dal bot (`/api/bot/outcome`): invariato nel vocabolario. Per i lead con `launchBucket='LANCIO_WEBDEV_2026'`, `NON_RISPOSTO`/`INTERROTTO` **non** fanno round robin verso un GDO ma **rimettono il lead nel pool** (§4.6).
- Calendario venditori (`salesAvailabilitySlots`, `salesSlotBlocks`, `checkBookingAllowed`, occupazione implicita = `appointmentDate`+`salespersonUserId`): è la fonte degli slot 9-15.
- Catena APPUNTAMENTO → Conferme → `setConfermeOutcome('confermato', venditore)` → Google Calendar: si riusa via service context per creare gli appuntamenti mattina già confermati.
- Agenda GDO: `AgendaButton.tsx` ha già la spunta "È offerta del mese" e il payload `variant.offertaDelMese`.

**Bot**
- Intake HMAC `/api/bot/intake` → `enrollLeadIntoMario` (manda subito l'apertura). Il lancio aggiunge un ramo: apertura = template benvenuto lancio, `conversations.lancio_*` valorizzati.
- Motore risposte `drainMarioReplies` + `contextNote` per-conversazione (seam usato dal modo GDO): il modo lancio entra da lì con un prompt proprio per fase.
- Cron a data fissa + invio a lotti (`send-batch`, 13/07): base per il blast Zoom e il follow-up.
- Branch `feat/lead-scrivono-per-primi` (adozione inbound, `funnelDaPrimoMessaggio`, push `lead-entrante` al CRM): da **rebasare su main** e accendere; il CRM lato suo è già live.
- `videoLinkForVariant` (`lib/gdo-agenda.ts`): oggi `offertaDelMese` → link Black Summer hardcoded; diventa una impostazione.
- Pannelli `/fenice`, `/chat`: mostrano le conversazioni `ai_owner='mario'` → i lead lancio ci finiscono da soli; si aggiunge il badge/filtro "Lancio".

## 3. Modello dati

### 3.1 CRM (Drizzle, migrazioni a mano — `drizzle-kit generate` inutilizzabile)

- `leads`: nessuna colonna nuova per l'appartenenza (basta `launchBucket='LANCIO_WEBDEV_2026'` + `funnel='Lancio Web Dev AI'`). Colonne nuove, tutte nullable:
  - `lancioIngresso text` — `'lista' | 'pulsante_webinar'` (come è arrivato)
  - `lancioScelta text` — `'chiamata_subito' | 'app_mattina' | 'app_pomeriggio' | 'app_dopodomani' | 'followup' | null`
  - `lancioSceltaAt timestamptz`
  - `lancioCallNowAttempts int default 0`, `lancioCallNowNextAt timestamptz` (seconda/terza chiamata)
  - `lancioBotInfo jsonb` — le risposte alle due domande di riscaldamento, mostrate al venditore
- `launchPools`: riga `('fenice','LANCIO_WEBDEV_2026','LAUNCH','Lancio Web Dev AI 2026')`.
- **Nuova tabella `launchShifts`** (turni venditori del lancio):
  `id, companyId, bucket, kind ('SERA' | 'GIORNO_DOPO'), salesUserId FK users, lastAssignedAt timestamptz null, createdBy, createdAt`, unique `(bucket, kind, salesUserId)`. Il round robin ordina per `coalesce(lastAssignedAt,'epoch'), salesUserId`.
- Eventi `leadEvents` nuovi (solo `eventType`, nessuna tabella): `LANCIO_INTAKE`, `LANCIO_CALL_NOW_ASSIGNED`, `LANCIO_BOOKED`, `LANCIO_RETURNED_TO_POOL`, `LANCIO_SHIFT_CHANGED`.

### 3.2 Bot (Supabase, migrazione SQL applicata PRIMA del deploy — regola del repo)

- `conversations`: `lancio_slug text null` (`'webdev-2026-10'`), `lancio_fase text null` (`attesa | posto_bloccato | link_inviato | post_pitch | scelta_fatta | followup_inviato | restituito | chiuso`), `lancio_ingresso text null` (`lista | pulsante_webinar`), `lancio_link_inviato_at`, `lancio_followup_inviato_at`, `lancio_info jsonb null` (risposte di riscaldamento).
- `app_settings` (chiavi nuove, editabili da `/fenice`): `lancio_zoom_link`, `lancio_video_live_link` (live editata, per il flusso standard post follow-up), `offerta_del_mese_link` (video offerta Web Dev per l'agenda GDO), `lancio_evento_at` (`2026-10-05T21:00:00+02:00`), `lancio_attivo` (`0/1`).
- `event_log` tipi nuovi: `lancio_intake`, `lancio_posto_bloccato`, `lancio_link_inviato`, `lancio_pulsante`, `lancio_scelta`, `lancio_followup_inviato`, `lancio_restituito`. L'idempotenza dei blast usa `messages.template_sid` come oggi.

## 4. Flussi lato CRM

### 4.1 Ingresso dei lead lancio
- **Webhook AC**: prima del routing, `isContactInLaunchList(contactId)` (stesso meccanismo delle liste bloccate: id lista risolto per nome normalizzato, cache 10 min, fastpath sul campo `list` del payload). Se sì: lead con `funnel='Lancio Web Dev AI'`, `source='activecampaign'`, `launchBucket='LANCIO_WEBDEV_2026'`, `lancioIngresso='lista'`, `assignedToId=bot`, `assignedAt=now`, `status='NEW'`; eventi `IMPORTED` + `ASSIGNED` (`metadata.routing='lancio'`) + `LANCIO_INTAKE`; `after(() => pushLeadToBot({..., lancio:{slug:'webdev-2026-10', ingresso:'lista'}}))`. **Bypassa** fasce orarie, tetto giornaliero, finestra ferie e `acAutoIntake`. Dedup: `acContactId` nel bucket (indice unico esistente) e telefono nel funnel lancio; il dedup 24h del flusso normale non si applica (duplicati cross-funnel voluti). Telefono sospetto → resta nel bucket non assegnato, come oggi.
- **Interruttore**: `LANCIO_WEBDEV_INTAKE` (`off` = la lista resta bloccata e i lead finiscono in `acIntakeFailures` come oggi). Si accende quando il bot è pronto (§9).
- **Sync di recupero** (card ambra su `/import`, solo Fenice, ADMIN/MANAGER/TL): "Sincronizza lista lancio da ActiveCampaign" clona `syncBlackSummerPool` (status=-1, dedup bucket+telefono, risoluzione `blocked_list:132` in `acIntakeFailures`) **e in più** assegna al bot e spinge con `pushLeadsToBotPaced` (30/min, `remainingLeadIds`, ripetibile). Idempotente: un lead già `BOT_PUSHED` consegnato non viene rispinto. La stessa card mostra: nel pool (non assegnati), al bot, restituiti, assegnati ai GDO, e il bottone di distribuzione ai GDO (`assignFromLaunchPool` esistente).

### 4.2 API per il bot (nuove, HMAC come le altre, prefisso `/api/bot/lancio/`)
- `POST /api/bot/lancio/slots` `{ date: 'YYYY-MM-DD' }` (POST e non GET: `bot-hmac` firma il body) → `{ date, mattina: [{ hour, liberi }], pomeriggio: { aperto: true, ore: [15..20] }, mattinaEsaurita: boolean }`. `mattina` = ore 9..14 in cui almeno un venditore del turno `GIORNO_DOPO` ha lo slot dichiarato, non bloccato, non esente, e senza appuntamento in quell'ora (stessa lettura di `checkBookingAllowed`, senza `companyId` sui busy per scelta già presa). Solo per `date` = giorno dopo il webinar; per `date` = dopodomani risponde `{ mattina: 'conferme' }` (tutte le ore 9-14 accettate, vanno alle Conferme).
- `POST /api/bot/lancio/book` `{ leadId, at (ISO con offset), info?: {...}, note? }` →
  - ora 9-14 del 6/10: transazione con `pg_advisory_xact_lock(hash('lancio', at))`; sceglie il venditore libero in quell'ora con `lastAssignedAt` più vecchio; scrive `status='APPOINTMENT'`, `appointmentDate=at`, `appointmentCreatedAt`, `confirmationsOutcome='confermato'`, `confirmationsUserId=bot`, `salespersonUserId/Assigned/AssignedAt`, `lancioScelta='app_mattina'`, `lancioBotInfo`; evento Google Calendar sul venditore (riuso della funzione di `setConfermeOutcome`); webhook marketing `appointment.outcome`+`deal.assigned` come oggi; `lastAssignedAt` aggiornato; eventi `APPOINTMENT_SET`, `LANCIO_BOOKED`. Se l'ora si è riempita nel frattempo → `409 { motivo:'ora_esaurita', slots: <stessa risposta di GET> }` e il bot ripropone.
  - ora 15-20 del 6/10, o qualsiasi ora 9-20 del 7/10: `status='APPOINTMENT'`, `appointmentDate=at`, nessun venditore, `lancioScelta='app_pomeriggio' | 'app_dopodomani'`; notifica alle Conferme come per un APPUNTAMENTO del bot.
  - Guardie: lead deve essere del bucket lancio e `assignedToId=bot` (o `lancioIngresso='pulsante_webinar'`); `at` fuori dalle regole → `422`. Idempotente sullo stesso `at` (±60s) → `{ ok:true, deduped:true }`.
- `POST /api/bot/lancio/call-now` `{ leadId, info?, note? }` → round robin sul turno `SERA`: `lancioScelta='chiamata_subito'`, `salespersonUserId` = venditore scelto, `status='APPOINTMENT'`, `appointmentDate=now`, `confirmationsOutcome='confermato'`, `lancioCallNowAttempts=0`; notifica realtime al venditore (bus Broadcast esistente, canale notifiche utente, nessun canale nuovo); eventi `LANCIO_CALL_NOW_ASSIGNED`. Turno vuoto → `409 { motivo:'nessun_venditore' }` e il bot ripiega sulla prenotazione.
- Tutte e tre rispondono in < 3 s (niente chiamate esterne in linea, il Calendar va in `after()`).

### 4.3 Sezione admin "Lancio" (`/lancio`, ADMIN/MANAGER)
- **Turni**: due liste di spunte sui venditori attivi (Sera del webinar / Giorno dopo). Salvataggio → `launchShifts`, evento `LANCIO_SHIFT_CHANGED`. Sotto, per il turno "giorno dopo", la copertura 9-15 del 6/10 letta dal calendario (ore dichiarate per venditore, con avviso rosso su chi non ha compilato).
- **Monitor lancio**: in lista (bucket), spinti al bot, benvenuto consegnato, hanno risposto, posto bloccato, link Zoom inviato, pulsante premuto, chiamate subito (assegnate / esitate / chiuse / €), prenotati mattina / pomeriggio / dopodomani, follow-up inviati, restituiti al pool, distribuiti ai GDO. Sorgenti: eventi CRM + `lead-status`. Stesso stile del Monitor Black Summer (`blackSummerStats.ts` come modello).
- **Impostazioni**: link video offerta e link live editata **si impostano dal pannello del bot** (`/fenice`), non qui: un solo posto.

### 4.4 Venditori: scheda "Lancio: chiamate subito"
- Nuova tab nella dashboard venditore, visibile solo se esistono lead con `lancioScelta='chiamata_subito'` assegnati a lui. Colonne: **Da chiamare** (attempts 0), **Seconda chiamata** (1), **Terza chiamata** (2), **Esitati**. Card: nome, telefono, ora della richiesta, le risposte di riscaldamento (`lancioBotInfo`), note.
- Azioni: **Non risponde** → `lancioCallNowAttempts+1`, `lancioCallNowNextAt=now+30min`, callLog; al 3° NR → A1 (passa alle Conferme il giorno dopo: `salespersonUserId=null`, `confirmationsOutcome=null`, `appointmentDate=6/10 09:00`, badge lancio). **Registra esito** → drawer esiti venditore esistente (`salesAttempts`, Chiuso / Non chiuso + motivo + follow-up, In lavorazione), `presentedAt` latchato alla prima risposta. Niente OutcomeGate su queste chiamate (non hanno un appuntamento scaduto da giustificare).
- Le multe calendario/ritardi **non** si applicano ai lead `chiamata_subito` (esclusione per `lancioScelta`).

### 4.5 Conferme
- I lead `app_pomeriggio` / `app_dopodomani` / A1 entrano nella board Conferme normale con badge **"LANCIO"** ambra e in cima alla prima chiamata (stesso meccanismo del badge "Aveva detto sì"). Le info di riscaldamento sono nel drawer (tab Note, blocco "Dal bot – lancio").
- I lead `app_mattina` compaiono in **Confermati** con badge lancio e venditore; nessuna chiamata richiesta. Il muro di prenotazione resta valido se una Conferma sposta l'ora.
- Ricerca per numero: le chat sono nel pannello del bot (§5.6), come oggi.

### 4.6 Ritorno al pool
- `/api/bot/outcome` con `NON_RISPOSTO`/`INTERROTTO` su lead `launchBucket='LANCIO_WEBDEV_2026'` e `assignedToId=bot`: invece di `reassignBotLeadToHumanPool` → `assignedToId=null`, `status='NEW'`, `callCount=0`, `assignedAt` **conservato**, evento `LANCIO_RETURNED_TO_POOL` (`metadata.motivo` = `mai_risposto | silenzio_dopo_followup`). Guardie `isLeadLocked`/`REJECTED` invariate. Da `/import` poi si distribuiscono ai GDO con `assignFromLaunchPool` (FIFO, `assignedAt` non si riscrive perché già valorizzato: i lead contano dal giorno dell'arrivo, coerente con la regola "magazzino" perché erano assegnati al bot).
- Un lead lancio con `appointmentDate`, `chiamata_subito` o `presentedAt` non torna mai nel pool (guardia).

### 4.7 Agenda GDO "Offerta del mese"
- `AgendaButton.tsx`: la spunta esistente "È offerta del mese" diventa un **pulsante/toggle evidente "Offerta del mese"** in cima alle domande lavora/famiglia (le esclude, come oggi). Nessun cambio di payload (`variant.offertaDelMese=true` già viaggia).
- Lato bot il link diventa `app_settings.offerta_del_mese_link` (§5.7).

### 4.8 KPI
- Funnel "Lancio Web Dev AI" trattato come Black Summer: conta in Marketing Analytics e nelle KPI GDO solo dopo l'assegnazione a un GDO umano (regola `launchBucket IS NULL OR assignedToId IS NOT NULL`, dove il bot è un assegnatario). Il monitor lancio (§4.3) è la vista del lancio in sé. `resyncMarketingClosures` non cambia.

## 5. Flussi lato bot

### 5.1 Intake lancio
- `lib/bot-contract.ts`: campo opzionale `lancio: { slug: string; ingresso: 'lista' | 'pulsante_webinar' }`. Assente → flusso attuale, invariato.
- `enrollLeadIntoMario` ramo lancio: `ai_owner='mario'`, `ai_status='active'`, `lancio_slug`, `lancio_fase='attesa'`, `crm_funnel`; apertura = **template benvenuto lancio** (SID `LANCIO_WELCOME_TEMPLATE_SID`), finestra 07-23 come le aperture (fuori orario → differita, la riprende il cron lancio, non `sequence-touches`). Guardia duplicati (`apertutaDaFermare`) invariata. Un lead già in chat con Mario per un altro funnel (conversazione viva) → **niente secondo benvenuto**, ma `lancio_*` valorizzati e `duplicato:true` al CRM; la chat prosegue nel modo lancio.
- **Esclusioni**: le conversazioni con `lancio_slug` non entrano in `sequence-touches`, nei nudge di `bot-followups` (Track B), in `precall-reminders`, in `gdo-video-followups`. `lead-analysis` e `crm-lead-status` restano.

### 5.2 Fase `attesa` → `posto_bloccato` (dal benvenuto al 5/10 19:59)
- Prompt lancio per fase (file `lib/lancio-prompt.ts`, separato da `mario-prompt.ts`, mai riusare i pezzi di fissaggio). Istruzioni: sei l'assistente virtuale di Fenice Academy; il lead è iscritto alla lista d'attesa del webinar del 5/10 ore 21; obiettivo = confermare l'interesse; risposte di una-due righe; **non** proporre call, video, form, prezzi.
- Classificazione deterministica prima del modello (regex + fallback modello con tag `[LANCIO:SI]`, `[LANCIO:DOMANDA]`, `[LANCIO:NO]`): "sì/ok/certo/interessato" → risposta fissa **"Perfetto, il tuo posto è bloccato. Ti scrivo qui il 5 ottobre con il link per collegarti."** → `lancio_fase='posto_bloccato'`, evento, **nessun altro messaggio spontaneo** fino al 5. "No/non mi interessa/togliermi" → risposta fissa di congedo, `lancio_fase='chiuso'`, esito `DA_SCARTARE` al CRM con `discardReason='non interessato'` (non torna nel pool). Domanda → il modello risponde con le regole: gratuito / opportunità la sera senza prezzi / logistica (data, ora, WhatsApp, Zoom) / tutto il resto "ne parliamo dopo la live". Massimo 1 risposta per lotto di inbound; dopo 3 scambi consecutivi di domande il bot chiude con "ci sentiamo il 5!" e non risponde più fino al link.
- `[PASSAGGIO_UMANO]` resta possibile (richiesta di contatto umano → `CONTATTO_UMANO` al CRM come oggi).

### 5.3 Blast link Zoom (5/10)
- Cron `/api/cron/lancio-zoom` ogni 5 minuti dalle **19:30 alle 20:45** Rome del 5/10 (`vercel.json`, schedule a data fissa in UTC: `*/5 17-18 5 10 *`, il route filtra su minuto Rome), guardia `lancio_attivo`. Ogni run: fino a `LANCIO_BATCH_MAX` (400) conversazioni con `lancio_slug` set, `lancio_fase ∈ {attesa, posto_bloccato}` e `lancio_link_inviato_at IS NULL`, ordinate per id; **template** `LANCIO_ZOOM_TEMPLATE_SID` con variabili `{nome, link}`; concorrenza 5 come `send-batch`; idempotenza doppia (`lancio_link_inviato_at` + `template_sid` nei `messages`). Chi non ha mai risposto al benvenuto **riceve comunque il link** (decisione 14/09). Frequency cap Meta 63049 → salta e riprova al run dopo.
- Dopo il blast: `lancio_fase='link_inviato'`. Da qui a mezzanotte, prompt **assistenza**: "codice riunione" → l'ID è 898 4522 3337 (i numeri nel link), niente passcode; "non riesco a collegarmi" → app Zoom / browser / link ricliccato; tutto il resto breve. Zero pitch.

### 5.4 Sera del 5: pulsante e scelta
- Inbound con il **marker del pulsante** (§6.3) — da numero noto **o** sconosciuto — porta `lancio_fase='post_pitch'`, `lancio_ingresso='pulsante_webinar'` se nuovo. Numero sconosciuto: adozione (§5.6) + push `lead-entrante` al CRM con `provenienza='Lancio Web Dev AI'` → il CRM crea il lead nel bucket (`lancioIngresso='pulsante_webinar'`, assegnato al bot, **senza** benvenuto) e torna il `leadId`; il bot lo scrive in `crm_lead_id` prima di qualunque scelta.
- Prompt `post_pitch`: due domande di riscaldamento (esempio: cosa fa oggi / cosa lo ha colpito della live) e poi la scelta: **"Preferisci che ti chiami un nostro consulente adesso, anche se è tardi, oppure fissiamo una call domani?"**. Tag di uscita: `[LANCIO:CHIAMA_ORA]`, `[LANCIO:PRENOTA|iso]`, `[LANCIO:SLOTS]` (chiede gli slot al CRM e li mostra: "domattina ho libero alle 9, 11 e 14, oppure il pomeriggio dalle 15 alle 20"). Mattina esaurita (`mattinaEsaurita`) → propone solo il pomeriggio; se il lead insiste sulla mattina → 7/10 mattina (`slots` con `date` = 7/10). Regole dure nel codice, non nel prompt: date ammesse = 6/10 (9-20) e 7/10 (9-14), ora tonda; il bot non "inventa" ore.
- `[LANCIO:CHIAMA_ORA]` → `POST call-now`; risposta fissa "Perfetto, ti chiama <nome venditore> tra pochissimo." → `lancio_fase='scelta_fatta'`, `ai_status='closed'`. `409 nessun_venditore` → "stasera i consulenti sono tutti occupati, fissiamo domani?" e prosegue.
- `[LANCIO:PRENOTA|iso]` → `POST book`; `200` → conferma con giorno/ora e (mattina) nome venditore → `scelta_fatta`, `closed`; `409 ora_esaurita` → ripropone dagli slot aggiornati.
- `lancio_info` (le due risposte) viaggia in `info` sia su `book` sia su `call-now`.
- Finestra: il flusso `post_pitch` accetta inbound dal 5/10 21:30 al 6/10 03:00 senza limiti d'orario di risposta (il lead sta scrivendo ora); dopo le 03:00 del 6 la fase resta `post_pitch` ma il bot risponde solo dalle 08:30 e propone solo il **6 pomeriggio** o il 7 (le ore mattina del 6 sono ormai imminenti: si accettano solo se `at ≥ now+1h`).

### 5.5 Follow-up del 6 e flusso standard
- Cron `/api/cron/lancio-followup` ogni 10 minuti nelle fasce **12:00-14:00** e **17:30-19:30** Rome del 6 e del 7 ottobre (schedule UTC `*/10 10-11,15-17 6-7 10 *`, filtro minuto Rome nel route). Bersaglio: `lancio_slug` set, `lancio_fase ∈ {posto_bloccato, link_inviato, attesa}` **con almeno un inbound** (ha interagito) e `lancio_followup_inviato_at IS NULL`; `LANCIO_BATCH_MAX` per run (250 → ~3.000 per fascia). Chi non ha mai scritto **non** riceve il follow-up (torna al pool, §5.8). **Template** `LANCIO_FOLLOWUP_TEMPLATE_SID` (§7.2) → `lancio_fase='followup_inviato'`.
- Alla risposta: il bot passa al **flusso standard di Mario** (`lancio_fase='chiuso'` per il lancio, la chat prosegue come fissaggio normale: prompt Mario, slot standard, form Jotform, Conferme). Unica differenza: il video "materiale" che Mario manda è `lancio_video_live_link` (la live editata) e non il video classico. Implementazione: `contextNote` con il link e regola "il video è questo", più override in `videoLinkForVariant`-equivalente del flusso Mario quando `lancio_slug` è valorizzato.

### 5.6 Lead che scrivono per primi (Telegram e pulsante)
- Rebase di `feat/lead-scrivono-per-primi` su `main` (25 commit avanti, 22 indietro), test verdi, merge. Accensione `INBOUND_ADOPTION_ENABLED=1`.
- `funnelDaPrimoMessaggio` esteso: marker Telegram → `TELEGRAM` (flusso Mario standard, push `lead-entrante` con provenienza TELEGRAM, come già progettato); marker pulsante webinar → lancio `post_pitch` (§5.4); altro → `INBOUND` (Mario standard). Il match è sul **primo** inbound della conversazione, ma per il pulsante vale **anche su una conversazione già esistente** (il lead della lista che preme il pulsante ha già la chat aperta): in quel caso il marker scatta sull'inbound corrente.
- Il CRM (`/api/bot/lead-entrante`) accetta già `provenienza` libera: per `'Lancio Web Dev AI'` scrive bucket, `lancioIngresso='pulsante_webinar'`, assegna al bot, **non** manda intake.
- Pannelli `/fenice` e `/chat`: filtro "Lancio" e badge sulla riga; la ricerca per numero è quella esistente.

### 5.7 Offerta del mese e video
- `videoLinkForVariant(v, settings)`: `offertaDelMese` → `settings.offerta_del_mese_link` (fallback env `OFFERTA_DEL_MESE_LINK`, poi il link Black Summer attuale finché Bruno non imposta il nuovo). Anche `gdo-video-followups` (`VIDEO_TEMPLATE_ENV_BY_LINK`) deve mappare il link dinamico al `VIDEO_GDO_OFFERTA_SID`.
- Pagina impostazioni in `/fenice` con i tre link (`offerta_del_mese_link`, `lancio_video_live_link`, `lancio_zoom_link`) e `lancio_attivo`. Bruno li cambia da lì il 6 mattina e dopo la live, senza deploy.

### 5.8 Restituzione al pool
- Cron `/api/cron/lancio-restituzioni` ogni ora dall'**8/10** (A5): per ogni conversazione lancio con `lancio_fase ∈ {attesa, link_inviato}` senza alcun inbound → esito `NON_RISPOSTO` al CRM con nota "Lancio: mai risposto"; con `lancio_fase='followup_inviato'` e nessun inbound dopo `lancio_followup_inviato_at + 48h` → `NON_RISPOSTO` con nota "Lancio: silenzio dopo il follow-up". Poi `lancio_fase='restituito'`, `ai_status='closed'`. Le fasi `scelta_fatta`, `chiuso`, `restituito` non si toccano. Il CRM fa il resto (§4.6).

## 6. Contratto bot ↔ CRM (v1.6, "cresce, non cambia")

### 6.1 Intake (CRM → bot), campo nuovo opzionale
```json
{ "leadId":"…","name":"…","phone":"…","email":null,"funnel":"Lancio Web Dev AI","companyId":"fenice",
  "personKey":"…","previousLeadIds":[],
  "lancio": { "slug":"webdev-2026-10", "ingresso":"lista" } }
```

### 6.2 Nuove rotte CRM (bot → CRM), tutte HMAC `x-bot-signature`
- `POST /api/bot/lancio/slots` `{ "date": "2026-10-06" }` → `200 { date, mattina, pomeriggio, mattinaEsaurita }` (POST con body firmato, per non cambiare `bot-hmac`).
- `POST /api/bot/lancio/book` `{ leadId, at, info?, note? }` → `200 { ok, kind:'mattina'|'pomeriggio'|'dopodomani', venditore?:{ id, nome }, deduped? }` · `409 { ok:false, motivo:'ora_esaurita', slots }` · `422 { ok:false, motivo:'fuori_regole' }` · `403` se il lead non è del lancio.
- `POST /api/bot/lancio/call-now` `{ leadId, info?, note? }` → `200 { ok, venditore:{ id, nome } }` · `409 { ok:false, motivo:'nessun_venditore' }`.
- `/api/bot/lead-entrante`: `provenienza='Lancio Web Dev AI'` ha l'effetto di §5.6 (documentato, nessun campo nuovo).
- `/api/bot/outcome`: invariato; semantica di `NON_RISPOSTO`/`INTERROTTO` sui lead lancio = ritorno al pool (documentata).

### 6.3 Pulsante WhatsApp del webinar
Link `https://wa.me/<numero Fenice>?text=<urlencoded>` con testo precompilato **"Ho seguito la live Web Developer AI e voglio saperne di più 🚀"** (marker regex `/live web developer ai/i`). Da mettere nella pagina della live/nella chat Zoom al momento del pitch. Il testo lo fisso nella spec così il bot lo riconosce; se Bruno lo vuole diverso, va cambiato in entrambi i posti.

## 7. Template Meta (da sottomettere per primi, approvazione in giorni)

Categoria **UTILITY** dove regge, altrimenti MARKETING con `UTILITY_ONLY_ALLOW` per SID. Testi **proposti, da approvare da Bruno**; variabili `{{1}}`=nome, `{{2}}`=link.

1. **Benvenuto lista** (parole di Bruno + AI Act): *"Ciao {{1}}, sono l'assistente virtuale di Fenice Academy. Complimenti per esserti iscritto alla lista d'attesa dell'evento del 5 ottobre: ti invieremo il link per collegarti alla live direttamente qui su WhatsApp il giorno stesso. Rispondi a questo messaggio se sei realmente interessato, per bloccare il posto."*
2. **Link Zoom**: *"Ciao {{1}}, ci siamo! Alle 21:00 inizia la live Web Developer AI. Questo è il tuo link per collegarti: {{2}} — ti consigliamo di entrare qualche minuto prima. Se hai problemi a collegarti scrivimi qui."*
3. **Follow-up del 6**: *"Ciao {{1}}, ieri sera alla live abbiamo presentato il percorso Web Developer AI. Ti va di parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live."*

Il video riassuntivo e il video dell'offerta viaggiano sempre in testo libero.

## 8. Cosa NON si fa (fuori scope, deciso)
- Secondo numero WhatsApp (passo successivo, memoria salvata).
- Round robin dei venditori fuori dal lancio; auto-prenotazione per il flusso standard (resta il form).
- Cambiare la finestra del form Calendly/Jotform (decisione chiusa del 31/08).
- Merge retroattivo dei duplicati; modifiche allo ScriptWidget.
- Notifiche push/email nuove: si usa il bus realtime esistente.

## 9. Ordine di consegna e interruttori

| Blocco | Contenuto | Pronto entro | Interruttore |
|---|---|---|---|
| **B0** | Lista 132 bloccata (fatto) · template 1-3 creati e sottomessi · migrazioni CRM e bot · memorie | 15/09 | — |
| **B1** | CRM: ingresso lancio nel webhook + sync di recupero + push con `lancio` · Bot: intake lancio, fase attesa/posto bloccato, esclusioni dai cron, badge pannelli · contratto v1.6 | 18/09 | `LANCIO_WEBDEV_INTAKE=on` (CRM), `lancio_attivo=1` (bot) |
| **B2** | Bot: rebase e accensione lead che scrivono per primi (Telegram + marker pulsante) | 22/09 | `INBOUND_ADOPTION_ENABLED=1` |
| **B3** | CRM: `launchShifts`, `/lancio` (turni + monitor), API slots/book/call-now, scheda venditore, badge Conferme, esclusione multe | 28/09 | — (le API rispondono 409 finché i turni sono vuoti) |
| **B4** | Bot: blast Zoom + assistenza, `post_pitch` con scelta, chiamate alle API CRM | 1/10 | cron a data fissa + `lancio_attivo` |
| **B5** | Bot: follow-up del 6, flusso standard con live editata, restituzioni · CRM: ritorno al pool · Offerta del mese configurabile + pulsante agenda · pagina impostazioni | 3/10 | `lancio_video_live_link`, `offerta_del_mese_link` |
| **B6** | Prova generale con numeri di test (tutte le fasi, orologio forzato via `FORZA_ORARIO`/parametri dei cron), verifica dal vivo, file riassuntivo nella cartella del bot, contratto e memorie | 4/10 | — |

Ogni blocco: spec → piano (`writing-plans`) → esecuzione subagent-driven con review, test verdi (`node --test` CRM, `bun test` bot, `tsc` su entrambi), commit e push su `main` di ciascun repo (la produzione si aggiorna al push).

## 10. Rischi noti
- **Numero a qualità LOW**: 2-3.000 template in un'ora il 5/10 e altri 3.000 il 6. Mitigazione: lotti da 400 ogni 5 minuti, categoria UTILITY, stop automatico sul 63049. Il rischio di limitazione del numero resta e Bruno lo accetta (decisione 4).
- **Approvazione template**: se Meta rifiuta il benvenuto, i lead restano bloccati in AC: il sync di recupero li spinge tutti quando il template è ok (idempotente).
- **Ore dichiarate**: se i venditori del turno "giorno dopo" non compilano il calendario del 6/10 entro il 5, la mattina risulta piena e tutto va alle Conferme. Il pannello `/lancio` lo mostra in rosso; promemoria del lunedì già esistente.
- **Intake in timeout**: il push lancio eredita il timeout 15 s e la regola "un `network_error` è già arrivato, non si rimanda".
- **Branch inbound**: 22 commit di distanza da main; se il rebase è troppo conflittuale si reimplementa il solo necessario (adozione + marker) sopra main.

## 11. Numero WhatsApp, capacità e rischio ban (aggiunto 16/09 dopo il flood del 15/09)

Fatti che vincolano (vedi memorie `reference_whatsapp_regole_piattaforma`, `project_incident_flood_lista133`):
- I **limiti di invio** (250 / 1K / 10K / 100K contatti per 24 h) sono per **Business Portfolio Meta**; la **qualità** (HIGH/MEDIUM/LOW) è per numero, calcolata sui 7 giorni da blocchi e segnalazioni. Un numero **nuovo** parte da 250 (1K dopo la verifica dell'azienda) e sale di tier solo usando almeno metà del limite in 7 giorni con qualità non LOW.
- Il numero attuale del bot (`+393520413199`) è a qualità **LOW** dopo il flood della lista 133 (7.882 push in un giorno). Il PO ha sospeso i lead nuovi al bot fino a sab 19/09 h13.
- Esiste un **secondo numero su un altro account Twilio** (nuovo, limiti bassi). Se sta sotto un altro Business Manager ha capacità propria; se sta sotto lo stesso, condivide il tier ma non la qualità.
- Il 5/10 alle 20:00 vanno mandati ~3.000 template in poco più di un'ora; il 6/10 fino a ~3.000 follow-up. Il 15/09 il numero ha retto un volume simile ma ne è uscito a LOW: **il rischio è la qualità (livelli 1-3: flagged, restricted, ban del numero), non il limite numerico**.

Regole che entrano nei piani B4/B5/B6:

1. **Mittente per fase, senza deploy.** Impostazione `lancio_sender` (`principale` | `secondario`) letta dal blast Zoom, dal follow-up e dal benvenuto. Il bot ottiene un secondo client Twilio (`TWILIO_ACCOUNT_SID_2`, `TWILIO_AUTH_TOKEN_2`, `TWILIO_WHATSAPP_NUMBER_2`), i **3 template vanno creati e approvati anche sul secondo account** (i Content SID sono per account), e il webhook inbound del secondo numero deve puntare al bot (routing per `To`). Le risposte a un template partito dal numero X restano sul numero X.
2. **Riscaldamento del secondo numero** dal 21/09: i benvenuti della lista d'attesa partono dal numero con tier e qualità migliori; se il PO lo decide, dal secondario, per portarlo a 10K entro il 5/10 (servono ≥7 giorni sopra metà del limite con qualità ≥ MEDIUM).
3. **Tetto orario sui benvenuti realtime** (`LANCIO_WELCOME_MAX_PER_HOUR`, default 200): oltre, il benvenuto viene differito e lo riprende il cron a ≤400/h. Nessun picco "a forma di blast" fuori dal 5/10.
4. **Go/no-go la sera del 5/10 (ore 18:00)** con lo script `scripts/qualita-numero.mjs` esteso a entrambi gli account: il mittente del blast deve avere **qualità ≥ MEDIUM e limite ≥ 10K** (o ≥ 3× la coorte). Se nessun numero passa: blast in **ordine di intenzione** — prima chi ha risposto sì (`posto_bloccato`), poi chi ha interagito, per ultimi i mai-risposti — spezzato sui due numeri, e i mai-risposti si mandano solo se la qualità regge dopo i primi lotti (decisione PO da prendere quel giorno).
5. **Ritmo del blast**: lotti da **200 ogni 5 minuti** (2.400/h) dalle 19:30, non 400: 3.000 link entro ~75 minuti, senza la forma del blast del 13/07.
6. **Freno automatico**: se in un lotto i falliti/undelivered superano il 10 %, o compaiono i codici 63018 (rate limit) o 63051 (sender locked), il run si ferma da solo (il 63049 è per singolo destinatario: quel lead si salta e si conta come `capped`, il run continua), scrive l'evento e avvisa l'admin; la ripresa è manuale (`lancio_attivo`).
7. **Categoria template**: i tre template devono risultare **approvati UTILITY** su ogni account usato (rilanciare `create-lancio-templates.mjs`); un template MARKETING va in `UTILITY_ONLY_ALLOW` solo per scelta esplicita.
8. **Monitoraggio quotidiano** dal 21/09 al 7/10: qualità, tier e consegna/lettura a 7 giorni di entrambi i numeri, annotati nel file di recap; soglia d'allarme = qualità LOW o lettura < 60 %.
9. **Il follow-up del 6/10** resta limitato a chi ha interagito (spec §5.5): è il messaggio più "marketing" del lancio ed è quello che pesa di più sulla qualità.
10. **Mai ripushare un `network_error`** e mai un secondo benvenuto: le guardie del B1 (`lancio_benvenuto_at`, `BOT_PUSHED` in `NO_REPUSH_RESULTS`) sono la difesa contro le doppie aperture.

### 11.1 Decisioni PO del 16/09 sul numero e sul blast
- **Ads dal 19/09** (non 15-16). Benvenuti dal 19/09.
- **Riscaldamento del secondo numero ("Account fenice 2", account Twilio e Business Manager separati)**: i primi **50 benvenuti al giorno** partono dal secondo numero (`LANCIO_WELCOME_MAX_PER_DAY_SECONDARIO`, default 50); **tutti gli altri li prende in carico il numero principale** (nessuna coda), sotto il tetto orario `LANCIO_WELCOME_MAX_PER_HOUR`. Finché il secondo client Twilio non esiste nel bot (task B4 "Mittente secondario"), tutto parte dal principale. Le agende sul secondo numero si decidono in un'altra sessione.
- **Stato al 16/09 sera (PO):** il secondo numero è ancora senza le verifiche legali Twilio → **per ora TUTTI i benvenuti partono dal numero principale**. Il mittente secondario resta nel piano (task B4 "Mittente secondario") ma spento di default (`lancio_sender=principale`, quota giornaliera secondario = 0) finché Bruno non dà il via.
- **Link Zoom del 5/10: a tutti** (template UTILITY approvato), in ordine di intenzione (`posto_bloccato` → interagito → mai risposto) e con il freno automatico. **Piano B**, pronto da accendere il giorno stesso con l'impostazione `lancio_blast_perimetro` = `risposto`: link solo a chi ha risposto almeno una volta; chi non ha mai risposto lo riceve solo se lo chiede (il bot glielo dà in chat). Si passa al piano B al primo segnale di problemi (qualità in calo, errori nei lotti, numero limitato).
- Il template del link Zoom (e gli altri due) vanno approvati come **UTILITY su entrambi gli account Meta**; il 15/09 l'altra sessione ha replicato 38 template sull'Account fenice 2 (tutti `pending`): verificare che i tre `fenice_lancio_*` siano inclusi, altrimenti sottometterli. Le credenziali dell'Account fenice 2 non sono nei repo: vanno messe nel `.env.local` del bot (`TWILIO2_ACCOUNT_SID`, `TWILIO2_API_KEY_SID`, `TWILIO2_API_KEY_SECRET`, `TWILIO2_WHATSAPP_NUMBER`).
- Il **go/no-go del 5/10** (punto 4) in parole semplici: alle 18:00 si legge da Twilio, per ciascun numero, la qualità Meta (HIGH/MEDIUM/LOW) e il limite giornaliero; il blast parte dal numero che ha qualità almeno MEDIUM e limite sufficiente; se nessuno dei due ce l'ha, si manda comunque ma solo a chi ha risposto (già deciso) e a lotti piccoli, fermandosi al primo segnale di errore.
