# Lead fissati dal GDO: recap, riscaldamento, promemoria del giorno prima

Data: 22/10/2026 · Decisione PO (Bruno) in chat · Repo: bot (`whatsapp-lead`), CRM invariato.

## Perché

Il lead che fissa col GDO al telefono riceve dal bot l'agenda, il video e al massimo due
solleciti del video. Non riceve **mai** un riepilogo scritto della call, né il promemoria del
giorno prima, che oggi esiste solo per gli appuntamenti fissati dal bot. I nostri lead hanno un
italiano di base: se data, ora, Noemi e video non li leggono scritti chiari, non li ricordano.

Dati (ultimi 30 giorni, 1.087 agende GDO):
- l'80% risponde dopo l'agenda, il 67% entro 2 ore (il template chiede "rispondimi con un ok");
- 712 video su 1.025 sono partiti in testo libero insieme alla risposta del lead;
- la data della call arriva dal CRM (`/api/appointment-set`) sull'83% delle agende, in media un
  minuto dopo, e la call cade in mediana **41 ore** dopo l'agenda;
- il video lo conferma visto solo il 19%; Noemi è stata spiegata solo nel 43% delle chat.

Bruno vuole tre cose: (1) un recap come quello che riceve chi fissa col bot, (2) un riscaldamento
breve, cioè un paio di domande per preparare la call, che "aggiusti" i lead presi male, (3) che
non diventi ridondante o prolisso.

## Obiettivi

1. **Recap**: il lead GDO legge una volta, scritto chiaro, giorno e ora della call, quando lo
   chiama Noemi, il video da guardare, e che deve scrivere FATTO.
2. **Riscaldamento**: due domande, una per turno, e solo se il lead risponde. Le risposte
   arrivano a Noemi e al venditore come nota nel CRM.
3. **Promemoria del giorno prima** anche per i lead GDO, con dentro Noemi.
4. Chi non risponde non riceve più messaggi programmati di oggi: il totale resta di 3.

## Non obiettivi / anti-obiettivi

- Il bot **non scarta, non sposta e non esita** il lead del GDO: resta il postino, solo
  `outcome:"NOTA"` (regola intoccabile 2). Il riscaldamento non decide niente sul lead.
- Niente catene: nessun sollecito sulle domande di riscaldamento, nessun cron che le insegue.
  La misura del 04/08 dice che chi riceve 2 solleciti dopo aver risposto disdice al 22,4%
  contro il 7,6%.
- Nessun template MARKETING nuovo: i numeri sono a qualità bassa.
- Nessuna modifica al CRM: la NOTA esiste già, finisce in timeline (`BOT_NOTE`) e suona la
  campanella alle Conferme.
- Gli appuntamenti fissati dal bot non cambiano.

## Cosa si costruisce

### A. Recap (testo libero, costruito dal codice, non dal modello)

Un unico messaggio scritto dal codice: deterministico, e uguale per tutti. Testo base:

> Ciao {nome}, ti riassumo tutto 👇
> La tua videochiamata è *{giorno numero} alle {ora}*. A quell'ora devi essere libero.
> *Ti chiama Noemi, una nostra collega, {quando Noemi}* da un numero di cellulare. Sono 5-10
> minuti: rispondi, perché se non rispondi la videochiamata non è confermata.
> *Prima della videochiamata guarda questo video*, dura 20 minuti 👉 {link}
> Quando l'hai visto scrivimi FATTO qui

Le righe stanno in **un'unica bolla**: niente split, perché il testo non passa da `splitMarioMessages`.
`{quando Noemi}` si calcola con la regola già in uso (`NOEMI_SOGLIA_STESSO_GIORNO` = 15):
"{giorno prima} nel pomeriggio" oppure "{stesso giorno} qualche ora prima".

Quando parte:
1. **Data già nota quando esce il video** (il caso comune): il recap **prende il posto** della
   bolla video di oggi (`gdoVideoText`) nel turno in cui il video esce insieme alla risposta del
   lead. Senza data si manda il `gdoVideoText` di oggi.
2. **Data che arriva dopo il video** (`appointment-set` con esito `registrato`, video già
   uscito, finestra 24h aperta): parte il recap **senza la riga del video**, che resta quella
   mandata sopra ("il video te l'ho mandato qui sopra").
3. **Spostamento** (`appointment-set` con esito `spostato`, finestra aperta): parte un recap
   corto con la data nuova: "La tua videochiamata ora è *{giorno numero} alle {ora}*. A
   quell'ora devi essere libero". Niente Noemi e niente video: lo spostamento lo fanno spesso
   le Conferme o il venditore, che col lead hanno appena parlato. *(scelta di chi scrive)*
4. **Finestra 24h chiusa**: niente recap in testo libero. Restano il template video di oggi e il
   promemoria del giorno prima (C).

**Perimetro**: recap e promemoria (C) riguardano solo le chat con `gdo_agenda_at` valorizzato e
`bot_outcome` diverso da `APPUNTAMENTO`: i lead fissati dal bot restano fuori, anche quando il CRM
chiama `appointment-set` per loro. Sui lead GDO, invece, il recap breve dello spostamento (caso 3)
parte chiunque abbia spostato la call: Conferme, venditore o Mario vocale.
*(scelta di chi scrive)*

Un recap per data: se `gdo_recap_for_at` è già uguale a `gdo_appuntamento_at`, non si riparte.
Non parte se la call è già passata, entro 1 ora dalla call, con `ai_paused_at` valorizzato o se
il lead ha chiesto di disdire (`cancel_requested_at`).

Mittente: quello della chat (`mittenteDiConversazione`), come ogni altro invio.

### B. Riscaldamento (dentro la risposta del modello, guidato da una nota di contesto)

Non è un messaggio programmato: è una nota appesa al system prompt, come `NOTA_VIDEO` e
`NOTA_NOEMI` in `lib/gdo-context-note.ts`.

- **Si apre** alla prima risposta del lead **dopo** il recap (A), se la call è fra più di 3 ore.
- **Primo turno**: il modello risponde prima a quello che il lead ha scritto, poi dice una volta
  sola "per preparare bene la tua videochiamata di {giorno} ti faccio 2 domande veloci" e fa
  la domanda 1.
  - Domanda 1: cosa vuole ottenere, e perché proprio adesso.
- **Turno dopo** (il lead ha risposto): domanda 2, con la cifra (decisione PO del 22/10):
  - Domanda 2: "nel video vedi che il percorso va da 1.000 a 3.000 euro, si può rateizzare.
    Alla videochiamata ci sei tu da solo o decidi insieme a qualcuno?" Restano valide le regole
    del prompt: niente cifre di rata, niente analogie.
- **Turno dopo ancora**: ringrazia in una riga, ricorda la call in una riga, e chiude il
  messaggio con
  `[NOTA|Riscaldamento prima della call: obiettivo "<sue parole>"; prezzo e chi decide "<sue parole>"]`.
  Se emerge un segnale brutto ("non ho soldi", "non ricordo di aver fissato", "non mi
  interessa") la nota comincia con `⚠️ Da verificare:`. Il bot **non** esita.
- Una domanda già risposta (al recap, o di sua iniziativa) **si salta**. Se il lead apre un
  altro discorso (disdetta, spostamento, domanda sul corso) vincono le regole che ci sono già,
  e il riscaldamento resta dov'era fino alla risposta dopo. Se due risposte di fila del lead
  non c'entrano niente, il riscaldamento si chiude senza nota.
- **Mai un sollecito**: se il lead smette di rispondere, il riscaldamento resta a metà e non
  parte nessuna nota. La risposta resta comunque nella chat. Una nota sola, alla fine: niente
  colonne per le risposte, niente inneschi fuori turno. *(scelta di chi scrive)*

Stato su `conversations`: `gdo_warmup_step` (smallint, null = mai aperto, 1, 2, 3 = chiuso),
`gdo_warmup_closed_at`. Il passo avanza nel drain quando il modello ha fatto la domanda del passo.
Il marcatore tecnico `[RISCALDAMENTO:1]`/`[RISCALDAMENTO:2]` sta in coda alla risposta, viene
tolto dal testo visibile come gli altri tag e fa avanzare lo stato.

Il riscaldamento e `NOTA_NOEMI` non si sommano nello stesso turno: se serve Noemi, Noemi vince e
il riscaldamento si apre al turno dopo. Col recap partito, Noemi è già stata spiegata
(`gdo_noemi_reminded_at` si valorizza quando parte il recap).

### C. Promemoria del giorno prima per i lead GDO

- Si estende `precall-reminders` alle chat con `gdo_appuntamento_at` valorizzato, **solo T−24h**
  (il T−3h resta del bot), sotto un interruttore suo.
- Template UTILITY nuovo `fenice_reminder_24h_gdo_v1`, da creare su Twilio e mandare a Meta su
  tutti gli account che mandano agende GDO:
  > Ciao {{1}}, ti ricordo la tua videochiamata con Fenice Academy: {{2}}. Prima ti chiama
  > Noemi, una collega, {{3}} da un numero di cellulare: rispondi, serve a confermare la
  > videochiamata. Se non l'hai ancora fatto, guarda il video che ti ho mandato qui.
  - {{2}} = "venerdì 23 ottobre alle 10:00"; {{3}} = "oggi pomeriggio" oppure "domani, qualche
    ora prima".
- Se la finestra 24h è aperta, lo stesso contenuto parte in testo libero, senza template.
- Parte solo se il video è già uscito (`gdo_video_sent_at` valorizzato) e se sono passate almeno
  12 ore dall'agenda: una call così vicina all'agenda la copre già il recap. *(scelta di chi scrive)*
- Non parte se in chat è già uscito un recap per quella data **nelle ultime 12 ore**, se il
  lead ha scritto nelle ultime 6 ore (la conversazione è viva), con `ai_paused_at`, con
  `cancel_requested_at`, o se la call è già passata.
- Un promemoria per data della call: la presa è la colonna `conversations.gdo_reminder24_for_at`,
  scritta con un update condizionale **prima** dell'invio (solo se vuota o con un'altra data) e
  rimessa com'era se l'invio non parte. Uno spostamento della call la riapre. L'evento
  `gdo_reminder24_sent` in `event_log` resta solo come diagnostica.
- **Sostituisce lo slot "mattina"** di `gdo-video-followups`: con C acceso, `gdo_appuntamento_at`
  noto, il video già uscito e il promemoria ancora in grado di partire (pomeriggio di Noemi non
  passato, agenda di almeno 12 ore prima che scada: `gdoReminder24Raggiungibile`), lo slot
  mattina non parte. Chi non ha mai risposto riceve agenda, video (template della
  sera) e promemoria: 3 messaggi, come oggi (agenda, video, sollecito della mattina). Il
  promemoria fa anche da sollecito, perché chiede del video. *(scelta di chi scrive)*

## Interruttori (spenti al deploy, li accende Bruno)

| Variabile | Accende |
|---|---|
| `GDO_RECAP_ENABLED=1` | A |
| `GDO_WARMUP_ENABLED=1` | B (richiede A acceso) |
| `GDO_PRECALL_24H_ENABLED=1` + `GDO_REMINDER_24H_TEMPLATE_SID` | C |

Un cambiamento alla volta: l'ordine proposto è A+C insieme (sono lo stesso gesto, "ricordare"),
poi B dopo una settimana. Lo decide Bruno.

## Misura

Sui lead GDO, nelle due settimane prima e dopo ogni accensione: % video visto (FATTO), %
confermati dalle Conferme, % presentati (`crm_lead_status`), % disdette. Si annotano anche:
quante NOTA di riscaldamento, quante con `⚠️`, e quanti scarti Conferme ne seguono.

## Lasciato a chi costruisce

- Dove agganciare il recap del caso 2/3: nella route `appointment-set` (subito) o in un cron
  leggero. La preferenza è la route, senza bloccare la risposta al CRM.
- Nomi esatti di funzioni e colonne; la migration va **prima** del deploy (regola 11).
- Test accanto ai moduli in `lib/`, sul modello di `gdo-context-note.test.ts`.

## Stato al rilascio

- **Commit:** `9feba68` su main, deploy Vercel `success` il 22/10/2026. Interruttori tutti spenti.
- **Template** `fenice_reminder_24h_gdo_v1` (UTILITY, `it`, `twilio/text`), creato il 22/10/2026 con
  `bun --env-file=<.env.local> scripts/crea-template-reminder-gdo.ts` (idempotente, rilanciabile):

  | Account | SID | Approvazione Meta |
  |---|---|---|
  | principale (storico) | `HXb477d7335153f54c0a265a69af578130` | `received` (UTILITY), da verificare |
  | slot 2 (+393522070047) | `HX382572f465268198258778c49f9ad1fb` | `received` (UTILITY), da verificare |
  | slot 3 (account elixir) | `HX2df62c3164060220ea7c5f903f9e39bc` | `received` (UTILITY), da verificare |

  Il nome e' identico sui tre account: `lib/template-account.ts` traduce il SID da un account
  all'altro per friendly_name. Verifica dello stato: `GET https://content.twilio.com/v1/Content/{sid}/ApprovalRequests`
  (o rilanciare lo script). Meta decide la categoria: se torna MARKETING il template va rifatto
  con un nome nuovo (`_v2`), non si ricategorizza.
- **Migration:** `20261022000001_gdo_recap_riscaldamento.sql` e `20261022000002_gdo_reminder24_for_at.sql`
  (colonna `gdo_reminder24_for_at`, applicata al DB del bot il 22/10/2026).
- **Interruttori:** tutti spenti, nessuna env toccata.

### Come accendere

Su Vercel (progetto del bot, production), poi redeploy:

```
GDO_RECAP_ENABLED=1                       # A: recap al lead quando il GDO fissa
GDO_PRECALL_24H_ENABLED=1                 # C: promemoria del giorno prima
GDO_REMINDER_24H_TEMPLATE_SID=HXb477d7335153f54c0a265a69af578130   # SID dell'account principale
GDO_WARMUP_ENABLED=1                      # B: riscaldamento (solo dopo A)
```

Accendere C solo quando il template e' `approved` e UTILITY su tutti e tre gli account. Ordine
proposto: A+C insieme, B dopo una settimana. **Il riscaldamento (B) funziona solo col recap (A)
acceso**: da solo non fa nulla.
