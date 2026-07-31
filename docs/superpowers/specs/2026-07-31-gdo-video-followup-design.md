# Follow-up del video e promemoria Noemi per i lead dei GDO

Data: 2026-07-31
Stato: design approvato, da pianificare

## Problema

Il flusso postino consegna l'agenda e, alla prima risposta del lead, il video di
preparazione. Poi si ferma. Verificato sul codice il 31/07: i lead GDO sono esclusi da
**tutti e quattro** i meccanismi di sollecito — sequenza anti-restituzioni
(`sequence-touches:183`), follow-up agenda (`agenda-followup.ts:40`), watchdog e
classificazione (`bot-followups:132`), promemoria pre-call (richiede
`bot_outcome='APPUNTAMENTO'`, che sui lead altrui non scriviamo mai).

Conseguenze:

1. **Chi non risponde mai all'agenda non riceve il video** e arriva in call senza aver
   visto niente.
2. **Chi lo riceve non viene più sollecitato**: nessuno gli ricorda di guardarlo.
3. **Nessuno gli parla di Noemi.** Il blocco CONFERMA POST-APPUNTAMENTO che spiega la
   preselezione scatta solo quando il lead scrive "Noemi" a Marta dopo aver prenotato —
   cosa che i lead GDO non fanno mai, perché hanno prenotato al telefono col commerciale.
   Gliene ha parlato il GDO, e basta.

Dal 31/07 il canale è **acceso in produzione**: 22 agende ricevute dal CRM fra le 18:40 e
le 19:06 italiane. Il problema è quindi vivo, non teorico.

## Obiettivo

Che il lead di un GDO arrivi alla call **avendo visto il video** e **sapendo che Noemi lo
chiamerà**, senza che il bot si metta a martellare e senza scavalcare il commerciale che
lo sta lavorando.

## Decisioni

**Un solo meccanismo alle 21:30, non due.** Chi non ha risposto all'agenda riceve il
video (template); chi ha risposto riceve il sollecito. Nessun lead riceve entrambi la
stessa sera.

**Il sollecito non è un messaggio piantato addosso.** Dove la finestra 24h è aperta lo
genera il modello dentro il contesto della chat: se il lead sta parlando d'altro, Marta
risponde a quello e aggancia il video alla fine. Il testo fisso resta solo dove siamo
costretti, cioè fuori finestra.

**Se si sta già parlando col lead, il sollecito automatico non parte affatto.** Il
promemoria vive dentro la conversazione, non sopra.

**Noemi si rispiega anche a chi ha già confermato di aver visto il video**, con la
premessa che il collega gliene avrà già parlato. Ripetere aiuta.

**La durata della chiamata va corretta ovunque.** Oggi il prompt dice *"una preselezione
di pochi minuti"* (`mario-prompt.ts:210`): sono **5-10 minuti**, e vanno detti, altrimenti
il lead si organizza male e la preselezione si fa di corsa. Si corregge sia nel promemoria
GDO nuovo sia nel prompt principale di Mario: due versioni diverse della stessa cosa è
come nascono le incoerenze.

**Le note al CRM sono una fase separata.** Vedi "Rischio dichiarato".

## Architettura

### 1. Stato

Migration `20260801000001_gdo_video_followup.sql`, tre colonne su `conversations`:

| Colonna | Perché |
|---|---|
| `gdo_video_watched_at timestamptz` | oggi il segnale della visione esiste (`videoWatched` dal modello) ma finisce **solo** in `event_log` (`fenice-autoreply.ts:379-386`), che non è interrogabile per decidere |
| `gdo_video_followups_sent smallint not null default 0` | idempotenza: 0, 1 o 2, mai di più |
| `gdo_noemi_reminded_at timestamptz` | Noemi si rispiega una volta, non a ogni turno |
| `gdo_appuntamento_at timestamptz` | data della call, **oggi non la riceviamo** — vedi §3 |

Indice parziale su `gdo_agenda_at` già esistente (migration `20260729000001`): il cron
filtra su quello, non servono indici nuovi.

`gdo_video_watched_at` va valorizzata **anche nel percorso esistente**: dove oggi
`result.videoWatched` scrive l'evento, si scrive pure la colonna.

### 2. Il cron

Nuova rotta `app/api/cron/gdo-video-followups/route.ts`, schedule `30 7-21 * * *` (UTC).

La maglia larga con filtro sull'ora di Roma dentro è il modo in cui il repo tratta già
gli orari (`precall-reminders`, `sequence-touches`) ed è a prova di cambio d'ora: 21:30
italiane sono le 19:30 UTC d'estate e le 20:30 d'inverno. Il codice agisce solo se
`romeHour:romeMinute` è `21:30` o `10:00`, altrimenti esce subito.

**Perimetro:** conversazioni con `gdo_agenda_at` negli ultimi 7 giorni. Il limite dei 7
giorni evita che il cron ripeschi lead vecchi se qualcosa resta indietro.

Non è un ramo dentro `bot-followups` perché quello gira a `:00` — le 21:30 non
esisterebbero — ed è il watchdog della classificazione, da cui i lead GDO sono esclusi
per principio: mescolare le due responsabilità confonde un cron che oggi è chiaro.

### 3. La decisione

Modulo puro `lib/gdo-video-followup.ts`, nessun effetto, tutto testabile:

```ts
export type GdoFollowupAction = 'video-template' | 'sollecito-libero' | 'sollecito-template' | 'none';

export interface GdoFollowupInput {
  gdoAgendaAt: string | null;
  gdoVideoSentAt: string | null;
  gdoVideoWatchedAt: string | null;
  followupsSent: number;
  /** Appuntamento del lead, dal CRM. Null = non lo sappiamo. */
  appointmentAt: string | null;
  lastInboundAtMs: number | null;
  lastMessageIsInbound: boolean;
  nowMs: number;
  slot: 'sera' | 'mattina';
}

export function decideGdoVideoFollowup(input: GdoFollowupInput): GdoFollowupAction;
```

Regole, in quest'ordine (la prima che risponde vince):

1. `gdoAgendaAt` nullo → `none` (non è un lead postino)
2. `appointmentAt` valorizzato e già passato → `none` — **un sollecito dopo la call è solo
   danno**. Se `appointmentAt` è nullo vale il ripiego: `none` oltre 48h dall'agenda
3. `gdoVideoWatchedAt` valorizzato → `none`
4. `followupsSent >= 2` → `none`
5. **conversazione viva**: il lead ha scritto nelle ultime `CONVERSAZIONE_VIVA_MS` (6 ore)
   → `none`. Si sta parlando: il promemoria lo porta la chat (§4), non un messaggio
   programmato addosso.
6. `lastMessageIsInbound` → `none`: c'è una sua domanda senza risposta, ci pensa il
   re-drive di `bot-followups`; due nostri messaggi di fila sarebbero maleducati
7. `gdoVideoSentAt` nullo → `video-template`
8. finestra 24h aperta (ultimo inbound < 24h) → `sollecito-libero`
9. altrimenti → `sollecito-template`

**Il buco della data d'appuntamento.** Verificato il 31/07 su `lib/bot-contract.ts`:
`SendAgendaPayload` è l'intake più la sola `variant` — anagrafica, funnel, companyId,
profilo del video. **La data della call non ci arriva.** E non la ricaviamo altrove: il
lead prenota su JotForm e noi non vediamo lo slot; `bot_scheduled_at` esiste solo per i
lead nostri, dove il modello la estrae dalla chat.

Conseguenza concreta: se il GDO fissa stamattina una call per **oggi alle 18:00**, alle
21:30 manderemmo "ricordati di vedere il video" a chi la call l'ha già fatta. Non è un
caso di scuola — i GDO prenotano spesso in giornata o per l'indomani.

Due mosse, in quest'ordine:

- **Chiedere al CRM di aggiungere `appointmentAt` al payload.** Ce l'hanno (sta già nei
  CSV che ci mandano), è un campo, e rende la regola 2 esatta. È la soluzione vera.
- **Nel frattempo il ripiego:** nessun sollecito oltre 48h dall'agenda, e nessun sollecito
  serale se l'agenda è arrivata **oggi dopo le 18:00** (una call fissata a ridosso è
  probabilmente già avvenuta o sta per avvenire). Copre male ma non fa danni evidenti.

`gdo_appuntamento_at` si aggiunge già ora alla migration e si valorizza appena il campo
arriva: la colonna vuota non costa niente, la migration successiva sì.

### 4. I promemoria dentro la chat

`generateMarioReply` accetta già una `contextNote` appesa al system prompt, e la modalità
postino la usa (`GDO_CONTEXT_NOTE` in `lib/mario.ts:84`). Il promemoria si aggancia lì:
niente prompt nuovo, niente secondo modello.

Nuovo modulo `lib/gdo-context-note.ts` che compone la nota del momento:

- **video non confermato** → *"Il lead ha ricevuto il video ma non ha ancora confermato di
  averlo visto. Ricordaglielo in modo naturale: se c'è un discorso aperto rispondi prima a
  quello e aggancia il video alla fine. Non richiederlo a ogni messaggio — se glielo hai
  già chiesto in uno dei tuoi ultimi messaggi, lascia stare per questo turno."*
  Il modello vede la cronologia, quindi sa se l'ha già fatto: non serve una colonna.
- **Noemi non ancora spiegata** e il lead ha appena confermato la visione **oppure** ha
  risposto a un sollecito → il blocco Noemi, con la premessa *"te ne avrà già parlato il
  mio collega, te lo ripeto così non ti scappa"*, la durata **5-10 minuti** e il perché
  (serve tempo per capire bene la sua situazione). Il resto è il passaggio 2 già
  collaudato, riusato alla lettera: chiama da un cellulare, è il passaggio che conferma
  l'appuntamento, se ti scappa richiamala pure su quel numero. **Tono invariato: nessuna
  minaccia** (`mario-prompt.test.ts:83` lo presidia).

Dopo l'invio, `gdo_noemi_reminded_at` si valorizza **solo se il testo uscito contiene
"Noemi"**: iniettare la nota non garantisce che il modello l'abbia detto, e segnarlo a
vuoto significherebbe non ripeterlo mai più.

### 5. I template

Sottomessi il 31/07 in due copie identiche (`scripts/create-sollecito-video-templates.mjs`):

- `SOLLECITO_VIDEO_GDO_SID=HX3e54993f4e225ac290c9ba3676ebe367`
- `SOLLECITO_VIDEO_GDO_SID_RISERVA=HXf0fd2cf65ddbf7a84ef19b01fd789fbf`

Due copie perché il 29/07 una copia risottomessa è passata in 20 minuti mentre l'originale
restava ferma oltre 17 ore: **i tempi di Meta non sono prevedibili, non ci si pianifica
sopra**. Si usa la prima approvata.

Il testo **contiene anche il richiamo a Noemi**, oltre al video. È una scelta: per un lead
che non risponde mai quello è l'ultimo messaggio automatico che riceve, e sarebbe l'unico
posto in cui può sentirsi dire da noi che quella chiamata conferma l'appuntamento.

Il `video-template` riusa i cinque SID UTILITY per variante già approvati e già in env,
scelti da `gdo_video_url`. **Fail-closed**: se il SID della variante manca in env non si
inventa niente, si logga e si salta — la stessa regola dello script d'invio, nata
dall'errore del 30/07.

### 6. Correzione della durata di Noemi

- `lib/mario-prompt.ts:210`: *"per una preselezione di pochi minuti"* → **5-10 minuti**,
  col perché.
- Passaggio 2 del blocco CONFERMA (`mario-prompt.ts:230-232`): aggiungere la durata.
- I test `mario-prompt.test.ts` presidiano quelle stringhe **e un limite di parole per
  riga**: la copy nuova deve rispettarlo, non basta aggiornare le asserzioni.

Vale per tutti i lead, non solo i GDO: è un fatto sul mondo, non una regola del flusso
postino.

### 7. Le note alle conferme — fase separata

Nuovo modulo `lib/gdo-note.ts`: manda `outcome: 'NOTA'` sul callback firmato esistente,
riusando la deduplica per impronta SHA-256 già in `lib/bot-outcome.ts`.

Quattro casi:

| Nota | Quando |
|---|---|
| ha confermato di aver visto il video | al passaggio di `gdo_video_watched_at` |
| non risulta aver visto il video | al secondo sollecito senza conferma |
| vuole annullare o spostare | quando il modello lo rileva |
| riassunto di ciò che ha raccontato di sé | campo nuovo `notaPerConferme` nella risposta del modello, popolato solo quando c'è sostanza |

**Tetto di 5 note libere per conversazione**, per non inondare il CRM se il modello
diventa loquace. Tutte le note passano da `event_log`, quindi dopo qualche giorno si
guarda cosa è uscito davvero e si stringe la vite.

## Rischio dichiarato

**La variante `NOTA` non è mai stata esercitata.** Verificato il 31/07: l'evento
`bot_note_sent` ha **zero occorrenze da sempre**. Il trasporto è provato (106
`bot_outcome_sent` dal 29/07 sui lead normali, stesso callback firmato), ma nessuna nota
ha mai raggiunto il CRM, perché la nota parte solo dietro un esito del modello e sui lead
postino gli esiti non arrivano quasi mai.

Per questo la §7 è **fase 3, dopo una prova concordata col CRM**: si manda una nota vera
su un lead di prova e loro confermano di vederla. Se il loro endpoint non gestisce `NOTA`,
quel pezzo va rinegoziato — ma le fasi 1 e 2 sono già live e utili da sole.

**Il riassunto libero produrrà rumore.** È il modello a decidere cosa è degno di nota. Il
tetto e la deduplica lo contengono, non lo eliminano. Accettato consapevolmente, da tarare
sui dati dopo la prima settimana.

## Fasi di consegna

1. **Fatta il 31/07**: template del sollecito sottomessi in due copie.
2. **Indipendente dal CRM**: colonne, cron, decisione, solleciti, promemoria in chat,
   promemoria Noemi, correzione della durata. Va live da sola.
3. **Dopo la prova col CRM**: le note alle conferme.

## Test

- `decideGdoVideoFollowup`: un caso per regola, più gli incroci che contano —
  appuntamento passato con video non visto (deve tacere), conversazione viva
  (deve tacere), finestra chiusa (template e non testo libero), secondo giro dopo il
  primo (contatore), lead che ha confermato la visione fra il primo e il secondo sollecito.
- Composizione della `contextNote`: nota del video presente solo se non confermato, nota
  Noemi solo alle condizioni previste, mai entrambe le volte dopo che è stata data.
- `gdo_noemi_reminded_at` si valorizza solo se il testo uscito contiene "Noemi".
- Selezione del template per variante, con fail-closed sul SID mancante.
- Copy: la durata 5-10 minuti presente in entrambi i punti, limite di parole per riga
  rispettato, tono non minaccioso invariato.
- Fase 3: la nota si compone e si deduplica; il tetto per conversazione regge.

## Fuori scope

- I lead GDO restano fuori da sequenza, classificazione e watchdog: non cambia.
- Nessun promemoria pre-call T-24h/T-3h per i lead GDO (richiederebbe `bot_outcome`, che
  su un lead altrui non scriviamo). Il richiamo a Noemi dentro il sollecito ne copre in
  parte lo scopo.
- Le ~139 conversazioni GDO storiche senza marcatore restano fuori da tutto.
