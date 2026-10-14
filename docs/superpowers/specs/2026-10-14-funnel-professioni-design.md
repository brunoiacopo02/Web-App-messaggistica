# Funnel Professioni — design

Data: 2026-10-14 · PO: Bruno · Repo: bot (Software Messaggistica) + CRM (CRM GDO)

## Scopo

Il marketing pubblica una landing con qualche domanda ("a quale professione sei interessato?").
Il pulsante finale apre WhatsApp sul **numero principale +39 352 041 3199** con un messaggio
precompilato. Il lead scrive per primo, il bot lo prende in carico come un **evergreen normale**
da fissare, e la promessa del funnel ("ti mando la scheda del corso") viene mantenuta **dopo**
l'appuntamento, insieme al video.

Successo: ogni lead del funnel nasce nel CRM nel funnel `PROFESSIONI`, assegnato al bot; Mario
lo porta all'appuntamento col flusso standard; nessuno resta senza scheda se l'ha chiesta; la
scheda non diventa una scusa per non fissare.

Contesto deciso il 14/10 (già in produzione, fuori da questa spec): il 3199 non apre più chat a
freddo; le aperture vanno divise equamente su 8061/8718/0047. Il 3199 resta per agende GDO, chat
già aperte e questo funnel.

## I sei corsi

| slug | nome nel link | parole riconosciute (case-insensitive) | PDF |
|---|---|---|---|
| `sviluppatore_web_ai` | Sviluppatore Web AI | sviluppatore web, web developer, sviluppatore | `public/schede/sviluppatore-web-ai.pdf` |
| `video_editor` | Video Editor | video editor, videoeditor, montaggio video | `public/schede/video-editor.pdf` |
| `project_manager` | Project Manager | project manager | `public/schede/project-manager.pdf` |
| `graphic_designer` | Graphic Designer | graphic designer, grafica, grafico | `public/schede/graphic-designer.pdf` |
| `copywriter` | Copywriter | copywriter, copy writer | `public/schede/copywriter.pdf` |
| `social_media_manager` | Social Media Manager | social media manager, smm | `public/schede/social-media-manager.pdf` |

I PDF vengono dalle schede fornite dal PO (0,3–5,5 MB, sotto il limite media di Twilio).

## 1. Ingresso (bot, `lib/primo-messaggio.ts`)

Testo del link: `Ciao, sono interessato alla professione di <Nome> e vorrei ricevere la scheda del corso`

- Marker del funnel: `/scheda del corso/i`. Valutato sul **primo inbound o sul corrente**, come il link
  Sviluppatore: chi scrive "ciao" e poi incolla la frase entra lo stesso.
- Nuovo esito `{ tipo: 'professioni', provenienza: 'PROFESSIONI', professione: slug | null }`.
  Priorità: dopo il pulsante del webinar e il link del lancio, **prima** di Telegram/INBOUND.
  La frase del link del lancio ("professione dello Sviluppatore AI") non contiene "scheda del corso":
  le due porte non si toccano.
- `professione` si ricava dalle parole della tabella sullo stesso messaggio; nessuna corrispondenza = `null`
  (Mario chiede quale corso, vedi §2).
- Nuova colonna `conversations.professione text null` (migrazione). Si scrive quando il marker compare,
  anche su una chat già esistente (la chat non cambia, il corso sì). Il funnel CRM invece si decide solo
  all'adozione, come oggi: un lead già nel CRM non cambia funnel.
- `ProvenienzaLeadEntrante` si allarga a `'PROFESSIONI'`; `crm_funnel` = `PROFESSIONI`; il push verso il CRM
  (`lib/lead-entrante.ts`) aggiunge il campo opzionale `professione`.
- Il riaggancio di Marta (`vaRiagganciato`) vale come per INBOUND.

## 2. Mario (bot, `lib/fenice-autoreply.ts` + `lib/mario-prompt.ts`)

Flusso **standard** (scelta B del PO: si misura prima così). Una nota di contesto, attiva quando
`conversations.professione` è valorizzata o la chat è nel funnel PROFESSIONI:

- **Apertura**: "ti mando volentieri la scheda del corso di <Nome>; prima ti faccio qualche domanda così
  capisco cosa ti serve". Non promettere la scheda subito.
- **La scheda esce dopo l'appuntamento**, insieme al video (§3). Mario non la manda prima.
- **Se il lead insiste** sulla scheda prima di fissare ("mi avevate detto che me la mandavate"): Mario la
  manda insieme al pitch (prezzi compresi) e propone comunque la call, nello stesso messaggio.
- **Se il lead rimanda per guardare la scheda**: Mario la manda e prende un impegno sul quando: deve
  averla vista **entro il giorno dopo**, "ci vogliono due minuti". Vale la regola esistente "PRIMA GUARDO
  IL CORSO" (il quando lo dice il lead, nessuna promessa di Mario).
- Per mandarla prima dell'appuntamento Mario scrive il tag `[SCHEDA:<slug>]`. Il codice toglie il tag dal
  testo e allega il PDF. Se `professione` è `null`, Mario usa il falso bivio e mette nel tag lo slug scelto.
- **Schede dei corsi nel prompt aggiornate dai 6 PDF** (docenti, moduli, sbocchi). Il Web Developer di oggi
  (Zanarella, PHP/jQuery) diventa Sviluppatore Web AI (Filangeri). Nessun'altra parte del prompt cambia.

## 3. Invio del PDF (bot, `lib/twilio.ts` + drain)

- `sendFreeText` accetta `mediaUrl?: string[]` (Twilio `messages.create`), con un testo breve
  ("Ecco la scheda del corso di <Nome> 👇").
- URL pubblico: `<dominio di produzione del bot>/schede/<file>.pdf` (stessa base usata per lo status callback),
  servito dalla cartella `public/` del bot.
- **Dopo l'appuntamento**: quando nel turno parte il link del video (`containsVideoLink`) e la chat ha
  `professione` e non ha ancora ricevuto la scheda, il codice la allega subito dopo il video. Automatico,
  non dipende da Mario.
- **Una volta sola per chat**: colonna `conversations.scheda_inviata_at timestamptz null`; evento
  `scheda_inviata` in `event_log` con slug e momento (`pre_appuntamento` | `post_appuntamento`).
- Errore di invio: si logga (`scheda_invio_fallito`), la conversazione continua; nessun ripiego su altro numero.

## 4. Follow-up entro 24 ore (bot, `lib/sequence.ts`)

Oggi Track B manda un sollecito a testo libero (gratuito, nella finestra 24h) dopo 12–24 ore di silenzio,
poi a 24h il lead si restituisce come oggi. Per le chat con `scheda_inviata_at` valorizzata e **nessun
appuntamento**, `pickNudgeText` usa un testo dedicato:
"<Nome>, sei riuscito a dare un'occhiata alla scheda di <Corso>? Ci vogliono due minuti. Così fissiamo la
call e ne parliamo con calma". Tempi, contatori e resa restano quelli di oggi.

## 5. CRM

- `src/lib/bot-fissatore/leadEntranti.ts`: la provenienza viene già salvata in maiuscolo come funnel, quindi
  `PROFESSIONI` non richiede un ramo dedicato. Si aggiunge la lettura di `professione` (opzionale, validata contro i 6 slug) e un
  evento/nota "Interessato a: <Corso>" nella timeline del lead.
- `PINNED_FUNNELS` (`src/lib/kpi/marketingFunnels.ts`) e `CANONICAL_ORDER` (`panoramicaActions.ts`):
  aggiunto `PROFESSIONI`.
- Nessuna modifica a routing, GDO o AC: il lead adottato nasce assegnato al bot come ogni INBOUND.
- Un payload senza `professione` (bot vecchio) continua a funzionare.

## 6. Consegna al PO

Un messaggio con i 6 link `wa.me/393520413199?text=...` codificati, pronti per il marketing.

## Ordine di deploy

1. CRM (accetta `professione`, mostra il funnel).
2. Migrazione bot (`professione`, `scheda_inviata_at`).
3. Bot (riconoscimento, prompt, PDF, sollecito).
4. Prova dal telefono del PO con uno dei link: adozione, funnel nel CRM, conversazione, scheda dopo l'appuntamento.

## Test

- Classificazione: 6 frasi del link, varianti (senza "ciao", parole cambiate, solo "scheda del corso"),
  frase del lancio che **non** deve diventare PROFESSIONI, Telegram che resta Telegram.
- Riconoscimento del corso: parole della tabella, nessuna corrispondenza → `null`.
- Tag `[SCHEDA:slug]`: tolto dal testo, PDF allegato, slug non valido ignorato e loggato.
- Allegato automatico col video: una sola volta; non parte senza `professione`.
- Nudge dedicato solo con scheda inviata e senza appuntamento.
- CRM: normalizzazione con e senza `professione`, slug sconosciuto scartato.

## Fuori scopo

Landing (la fa il marketing), percorso corto con 2 domande (scelta A, eventuale test futuro), spostare le
agende GDO dal 3199, nuove metriche dedicate oltre al funnel in Panoramica.
