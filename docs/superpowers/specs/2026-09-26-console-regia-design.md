# Console "Regia" — design

Data: 26/09/2026 · Branch: `feat/console-regia` · Decisioni del PO (Bruno) prese in brainstorming il 26/09.

## Perché

La console web del bot ha tre linguaggi grafici diversi (`(app)`/`(chat)` zinc, `(fenice)` ember con aurora e card
identiche, `/fenice/lancio` sand), è shadcn quasi di default (lo scanner anti-slop segnala K1, K8, T4, C2) e la lista
chat distingue solo Tutte / Non lette / Ultimi 7gg / Lancio con un tetto di 200 righe. Gli avvisi esistono solo per il
lancio e il "cosa fare" è sempre manuale. Il 5/10 alle 21 c'è il lancio del webinar con migliaia di chat live:
serve una sala di regia unica, bella da usare 8 ore, in cui si vede subito cosa richiede attenzione e si può
rimediare con un clic.

## Obiettivi (criteri di successo)

1. Una console unica `/console` per l'admin con: 9 viste chat con contatori, lista paginata e virtualizzata, thread,
   scheda lead, barra di regia del lancio, avvisi di tutto il sistema con pulsanti di rimedio, Assistente Claude.
2. Grafica "Regia" (mockup approvato: `docs/design/console-regia-mockup.html`) che passa lo scanner anti-slop a P1
   senza risultati e le 25 regole di `docs/design/direzione-console-anti-slop.md`.
3. Nessuna regressione: le pagine esistenti (`/inbox`, `/chat`, `/campagne-chat`, `/fenice/*`, `/dashboard`, `/log`,
   `/campagne`) restano identiche e raggiungibili fino a dopo il lancio. Si spengono solo con un OK esplicito del PO.
4. Nessuna azione nuova verso i lead: i pulsanti e l'Assistente usano solo capacità che il codice ha già, con le loro
   guardie.
5. In produzione entro il 2/10/2026.

## Fuori perimetro

- Nuovi invii automatici ai lead (es. "reinvia con template" sui 63016): è una decisione di contratto verso i lead,
  non tecnica. Il pulsante per i 63016 è "Apri le N chat", non un reinvio.
- Modifiche al comportamento del bot (Mario, cron, contratto CRM).
- Spegnimento delle pagine vecchie e degli account confinati (`fenice@academy.com`, `campagne@fenice.com`,
  `fenicebot@fenice.com`): restano come sono.
- Migrazioni DB: nessuna. Il registro delle azioni vive in `event_log`.

## Accesso

- Un solo account per la console: **`admin@fenice.com`** (il PO ha scritto "fanice", refuso). Area `all` per
  costruzione di `lib/access.ts` (ogni email non confinata è `all`).
- Password: il PO ha chiesto `1234`. **Non si usa**: la console espone tutti i lead e azioni che scrivono al CRM; una
  password di 4 cifre su un sito pubblico è indovinabile e Supabase di norma ne rifiuta sotto i 6 caratteri. Si genera
  una password robusta, salvata in `C:\Users\bruno\Desktop\credenziali-console-admin.txt` (fuori da ogni repo); il PO
  può cambiarla.
- Nuova funzione `puoUsareConsole(email) = areaForEmail(email) === 'all'`. `/console` e `/api/console/*` rispondono
  403 / redirect a chi non è `all` (gli account confinati già non ci arrivano per `canAccess`, la guardia è doppia).
- `landingPath` per l'area `all` passa da `/inbox` a `/console`. Serenamente resta raggiungibile dalla console.

## Architettura

Tutto nuovo e isolato; il codice vecchio non si tocca se non per estrarre funzioni riusabili senza cambiarne il
comportamento.

```
app/(console)/layout.tsx              shell: font, token, sidebar, barra di regia, palette Ctrl+K
app/(console)/console/page.tsx        vista chat (default: Non lette)  ?vista=&fase=&chat=&q=&solo=non_lette
app/(console)/console/avvisi/…        avvisi + registro azioni
app/(console)/console/lancio/…        sala del lancio (numeri, grafico, fasi, avvisi del lancio)
app/(console)/console/impostazioni/…  interruttori e campi lancio (porta ImpostazioniLancioPanel)
app/(console)/console/analisi/…       segmenti e analisi AI (porta LeadPipeline)
app/(console)/console/simulatore/…    simulatore di Mario (porta Simulator)
app/(console)/console/campagne/…      campagne (porta tabella + drawer)
app/(console)/console/log/…           event_log leggibile con filtri
app/(console)/console/serenamente/…   inbox Serenamente (stesso lista/thread, API /api/conversations)
app/api/console/viste                 contatori delle viste
app/api/console/chat                  lista paginata per vista
app/api/console/chat/[id]             dettaglio: messaggi + eventi + scheda lead
app/api/console/regia                 numeri della barra di regia
app/api/console/avvisi                avvisi di sistema con azioni collegate
app/api/console/azioni/anteprima      prova a vuoto di un'azione
app/api/console/azioni/esegui         esecuzione confermata
app/api/console/assistente            Assistente Claude (streaming)
lib/console/viste.ts                  predicati delle viste (puri) + applicazione alla query
lib/console/avvisi.ts                 avvisi di sistema (compone calcolaAvvisi del lancio + sistema)
lib/console/azioni.ts                 registro azioni: anteprima / esegui / registro
lib/console/assistente-tools.ts       strumenti dell'Assistente
components/console/…                  primitivi e componenti della console (NON components/ui)
app/(console)/console.css             token e stili della console, scoped a [data-console]
```

### Grafica

- Token presi 1:1 dal mockup (scuro di base, chiaro disponibile): superfici `--s0…--s4` blu petrolio, testo avorio
  `--fg/--fg2/--fg3`, `--ember` solo per ciò che è "in onda" e il marchio, `--ice` per selezione/focus/azione
  primaria, `--red/--amber/--green` solo come segnale, 6 coppie avatar. Tutti scoped a `[data-console]`, in un file
  CSS della sola console: `globals.css` non cambia, le pagine vecchie non cambiano.
- Font con `next/font/google` nel solo layout console: Schibsted Grotesk 400/500/600 (interfaccia) e JetBrains Mono
  400/500 (solo dati: telefoni, ID, orari dei log, codici).
- Primitivi propri in `components/console/ui/` (bottone, input, badge di testo, kbd, menu, dialog/sheet, tooltip,
  toast) costruiti sui token; si possono usare i Radix già installati. Vietato importare `components/ui/*` shadcn
  dentro la console.
- Tema: `data-theme="dark|light"` su `[data-console]`, scelta salvata in localStorage (try/catch), default scuro.
- Regole vincolanti: le 25 di `docs/design/direzione-console-anti-slop.md` (sezione 1) e i pattern della sezione 3.
- Script `bun run check:slop` = `node scripts/detect-slop.mjs app/(console) components/console --min=P1` (copia dello
  scanner avoid-ai-design, MIT, con attribuzione) che deve uscire 0.

### Viste

Il perimetro è quello di `/chat` (`soloMondoFenice`), tranne "Serenamente" che è il complemento (inbox esistente).
Le viste sono **filtri, non partizioni**: una chat può stare in più viste (es. Lancio e Serve te).

| Vista | Predicato |
|---|---|
| Serve te | `ai_paused_at` non nullo, oppure (`ai_status='handed_off'` o `bot_outcome='CONTATTO_UMANO'`) con `last_inbound_at` negli ultimi 7 giorni |
| Non lette | `unread_count > 0` (è anche un filtro sovrapponibile a ogni vista: `solo=non_lette`) |
| Lancio | `lancio_slug` non nullo; sotto-filtro `fase` ∈ `LANCIO_FASI` |
| Fissati dal bot | `bot_outcome='APPUNTAMENTO'` |
| Lead dei GDO | `mondoDi(c)==='GDO'` (`gdo_agenda_at` non nullo, oppure `gdo_video_sent_at` non nullo e non Mario) |
| Mario in corso | `ai_owner='mario'`, `gdo_agenda_at` nullo, `bot_outcome` nullo, `ai_status` ∉ {closed, booked, handed_off}, `lancio_fase` ∉ {chiuso, restituito} |
| Chiuse e restituite | `ai_status='closed'` o `lancio_fase` ∈ {chiuso, restituito} o `bot_outcome` ∈ {DA_SCARTARE, NON_RISPOSTO, INTERROTTO, RICHIAMO} |
| Campagne | `mondoDi(c)==='CAMPAGNA'` |
| Con errori | ultimo messaggio in uscita della chat con `twilio_status` ∈ {failed, undelivered} nelle ultime 48 h |

- I predicati vivono in `lib/console/viste.ts` in due forme che devono dare lo stesso risultato: una funzione pura
  `inVista(riga, vista, now)` (testata) e `applicaVista(query, vista)` per PostgREST. Un test confronta le due su un
  campione di righe.
- "Con errori" si risolve in due passi (id delle chat da `messages`, poi `.in('id', …)`), con paginazione esplicita
  per il tetto di 1.000 righe di PostgREST.
- Contatori: una richiesta `GET /api/console/viste` che esegue i conteggi (`count: 'exact', head: true`) in parallelo,
  cache in memoria 15 s. Lista: `GET /api/console/chat?vista&fase&solo&q&cursore`, 50 righe per pagina a cursore su
  `(last_message_at, id)`, ricerca come oggi (prima i `lead_id`, poi le conversazioni).
- Aggiornamento: Realtime come `RealtimeProvider` (nessun canale nuovo o modificato) + polling 10 s dei contatori,
  sospeso a scheda nascosta. Aprire una chat la segna letta con le stesse regole di `lib/segna-letta.ts`.
- Lista virtualizzata con `virtua`; stato nell'URL con `nuqs`. Tastiera: `j/k` o frecce, `Invio`, `Esc`, `Ctrl+K`,
  `]` apre/chiude la scheda lead, `g a` avvisi, `g l` lancio.

### Thread e scheda lead

- Thread: bolle lead a sinistra, Mario/operatore a destra con etichetta, eventi di sistema come righe centrate,
  separatori di giorno, stato di consegna per messaggio, fallito in rosso con codice Twilio e spiegazione
  (`erroreTwilio`). Composer: se Mario è attivo mostra "Mario gestisce questa chat" + "Metti in pausa Mario"; se in
  pausa permette di scrivere (API esistente `/api/chat/messages`, che risponde 409 se il bot è attivo) e mostra la
  finestra 24 h.
- Scheda lead: telefono (copia), ID lead, numero WA di partenza, mondo, fase lancio, esito bot, stato CRM
  (`crm_lead_status`), GDO, riassunto AI se presente, storico eventi compresso; azioni: pausa/riprendi Mario, Apri nel
  CRM, Chiedi all'Assistente.

### Barra di regia

Sempre visibile in alto: luce "In onda"/countdown calcolati da `lancio_evento_at` (`app_settings`), scaletta della
serata (benvenuto, link, inizio, pitch, chiusura), iscritti, posto bloccato, link inviati, consegnati oggi, falliti,
consegne ora per ora (SVG proprio, falliti in rosso). Dati da `fotografia()`/`consegne()` di
`lib/lancio-monitor-db.ts` (cache esistente 20 s) via `GET /api/console/regia`, polling 30 s. Se il lancio è spento
(`lancio_attivo=false`) la barra si riduce a una riga "Nessun lancio in corso".

### Avvisi e azioni

- `lib/console/avvisi.ts` restituisce `AvvisoConsole = Avviso & { area: 'lancio'|'crm'|'twilio'|'cron'|'bot'|'gdo',
  azioni: AzioneRef[] }`, componendo:
  - `calcolaAvvisi()` del lancio (invariato);
  - errori CRM delle ultime 24 h: `bot_outcome_error`, `bot_outcome_rejected`, `bot_outcome_senza_leadid`,
    `stale_booked_no_outcome`, `booked_without_outcome`, `contatto_umano_non_segnalato`, `handed_off_non_registrato`,
    `lead_entrante_push_error`;
  - bot: `fenice_ai_error`, `fenice_ai_claim_error`, `invio_template_fallito`, `sequence_touch_error`, `*_config_error`;
  - GDO: `gdo_agenda_error`, `gdo_followup_error`, agende con `gdo_agenda_esito='fallito'`;
  - Twilio: `twilio_status` warn dell'ultima ora raggruppati per codice con `erroreTwilio`;
  - cron: per ogni cron di `vercel.json` attivo nell'orario corrente, "fermo" se l'ultimo evento di giro è più vecchio
    di 2 volte il periodo (solo per i cron che scrivono un evento di giro; gli altri non si stimano).
  Ogni avviso ha "cosa significa", "cosa fare", conteggio, chat coinvolte (link alla vista), prima e ultima occorrenza.
- Un avviso si può "segnare risolto" con una nota: evento `console_avviso_risolto` (id avviso + firma dei conteggi);
  resta nascosto finché i conteggi non cambiano.
- Registro azioni `lib/console/azioni.ts`. Ogni azione: `id`, `titolo`, `perimetro` (cosa tocca), `anteprima(params)`
  → `{ descrizione, conteggio, righe[] }` senza scritture, `esegui(params)` → `{ ok, fatti, falliti, dettagli }`.
  Azioni v1 (solo capacità esistenti):
  1. `rinvia_esiti_403` → logica di `/api/cron/arretrati` `cosa:'esiti-403'` (anteprima = `esegui:false`).
  2. `recupera_agende_consegnate` → `/api/cron/arretrati` `cosa:'agenda-delivery'`.
  3. `rinvia_esito` (una conversazione) → `sendOutcome()` come `/api/cron/resend-outcome`, con l'esito già registrato
     sulla conversazione; anteprima = payload che partirebbe.
  4. `rilancia_cron` (`lancio-aperture|lancio-zoom|lancio-inizio|lancio-followup|lancio-restituzioni|riapri-mute|adotta-mai-risposti|bot-followups|crm-lead-status`) → chiamata server-side alla rotta con `CRON_SECRET`. Anteprima = cosa fa + esito dell'ultimo giro (questi cron non hanno una prova a vuoto: lo si dice).
  5. `interruttore` (`lancio_attivo`, `lancio_pulsante_attivo`, `fenice_ai_autoreply`) → stessa scrittura e audit di
     `/api/fenice/lancio-settings`.
  6. `pausa_mario` / `riprendi_mario` su una chat → stessa logica di `/api/chat/pause`.
  Le funzioni dietro 1, 2 e 3 si estraggono dalle rotte in `lib/` senza cambiarne il comportamento; le rotte vecchie
  le richiamano.
- Flusso UI: **Prova a vuoto** (pannello con descrizione, conteggio, prime righe) → **Conferma** nella riga con il
  numero ("Rinvia 38 esiti al CRM") → avanzamento → **esito scritto nella riga** (fatti/falliti, falliti apribili).
- Ogni esecuzione scrive `event_log` `type='console_azione'`, payload `{ azione, params, anteprima, esito, by }`,
  level `info`/`error`. La pagina Avvisi ha la tab "Registro azioni".
- `POST /api/console/azioni/esegui` accetta solo azioni del registro, valida i parametri con zod, richiede
  `conferma: true` e rifiuta se l'anteprima di prima non corrisponde più (conteggio cambiato di oltre il 20% →
  nuova anteprima).

### Assistente

- `POST /api/console/assistente` (runtime nodejs, streaming SSE) con `@anthropic-ai/sdk`, modello `claude-sonnet-5`
  (come Mario), `ANTHROPIC_API_KEY` di Vercel. Storico della conversazione tenuto nel client (non persistito),
  massimo 8 giri di strumenti per domanda, risultati degli strumenti troncati (≤ 50 righe, testi ≤ 2.000 caratteri).
- Strumenti di lettura: `cerca_lead(q)`, `leggi_chat(conversationId, ultimi)`, `leggi_eventi(tipo?, conversationId?,
  da?)`, `conta_viste()`, `elenca_avvisi()`, `spiega_errore_twilio(code)`, `stato_lancio()`. Tutti nel perimetro della
  console, tutti in sola lettura.
- Strumento di azione: `proponi_azione(azione, params, motivo)` — **non esegue**: restituisce una proposta che la UI
  mostra come riga con "Prova a vuoto" / "Conferma", che passa da `/api/console/azioni/*` come i pulsanti.
- Strumento `bozza_risposta(conversationId, istruzioni)`: solo se la chat ha `ai_paused_at` valorizzato; la bozza va
  nel composer, la invia l'admin.
- UI: pannello a destra richiamabile e palette `Ctrl+K` ("Chiedi all'Assistente…"). Righe compatte e richiudibili per
  gli strumenti usati, citazioni cliccabili verso chat/avvisi, testo "Sto leggendo…" invece di animazioni, niente
  Sparkles/gradienti. Stato vuoto con domande sui dati di oggi.
- System prompt: ruolo (assistente dell'admin della console Fenice), regole (non inventare dati, citare le fonti,
  mai eseguire, proporre solo azioni del registro, italiano), contesto (data/ora IT, stato del lancio).

### Altre sezioni

Impostazioni lancio, Analisi (segmenti + analisi AI), Simulatore, Campagne, Log e Serenamente vengono **riportate**
nella console con la nuova grafica riusando le stesse API e la stessa logica delle pagine vecchie (che restano).

## Errori e casi limite

- Ogni vista ha stati vuoto / caricamento (skeleton della forma delle righe, dopo 200 ms, minimo 400 ms) / errore
  (cosa è successo + "Riprova").
- API della console: 401 senza sessione, 403 se non `all`, 400 su parametri non validi, errori Supabase riportati con
  messaggio leggibile, mai stack.
- PostgREST 1.000 righe: ogni lettura che può superarle usa `fetchAllRows` o un cursore.
- Assistente: se Anthropic fallisce o va in timeout, messaggio in linea con "Riprova"; mai azioni implicite.
- Azioni: timeout 280 s lato server (maxDuration 300); le azioni lunghe riportano avanzamento a lotti.

## Test

- Unit (Vitest, accanto ai moduli): `lib/console/viste` (ogni vista, precedenze, coerenza pura vs query), `avvisi`
  (composizione, raggruppamento Twilio, cron fermi, risolti nascosti), `azioni` (anteprima non scrive mai; esegui
  richiede conferma e registra), `assistente-tools` (perimetro, troncamenti, `proponi_azione` non esegue,
  `bozza_risposta` rifiutata con bot attivo), `access` (`puoUsareConsole`, `landingPath`).
- Route test per `/api/console/*` (auth 401/403, validazione).
- `bun run typecheck`, `bun test`, `bun run build`, `bun run check:slop` verdi.
- Verifica visiva: Playwright headless (script in `scripts/`) che accede con l'account admin e salva screenshot di
  ogni schermata in chiaro e in scuro a 1440×900 e 1280×800; revisione degli screenshot contro la checklist.

## Rilascio

1. Merge su `main` a lavoro verificato → deploy Vercel automatico. Additivo: le pagine vecchie restano.
2. Creazione dell'account `admin@fenice.com` con la Admin API di Supabase (service role già in `.env.local`).
3. Smoke test in produzione con Playwright sull'URL pubblico.
4. Dopo il lancio (non ora): decisione del PO su spegnimento pagine vecchie e account confinati.
