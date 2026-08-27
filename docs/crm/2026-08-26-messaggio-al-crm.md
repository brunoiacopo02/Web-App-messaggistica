# Messaggio al team CRM — 26/08/2026

*Bozza pronta da inviare. Non è stata mandata a nessuno.*

---

Ciao,

faccio il punto sul bot fissatore: prima i nostri numeri, poi le cose che ci servono da
voi. Ho messo tutto in un messaggio solo così non ci perdiamo i pezzi.

## 1. Come sta andando il bot

Dati al 26/08, presi dal nostro database.

**Volumi.** Nella finestra di ferragosto ci avete mandato tutto: la settimana del 10
agosto sono entrati **1.476 lead**, contro i 150-250 a settimana di luglio. Il bot li ha
lavorati tutti senza fermarsi. Da lunedì 17 il flusso è tornato a **30-48 lead al
giorno**, più **40-76 agende GDO** al giorno da consegnare.

**Risposta e fissaggio.**

| settimana | lead entrati | rispondono | appuntamenti | % sui rispondenti |
|---|---|---|---|---|
| 20/07 | 185 | 56% | 21 | 20,2% |
| 27/07 | 245 | 67% | 26 | 15,8% |
| 03/08 | 688 | 65% | 81 | 18,1% |
| 10/08 | 1.476 | 63% | 135 | 14,6% |
| 17/08 | 244 | 67% | 32 | 19,5% |

A giugno rispondeva il 39-44%: oggi risponde due lead su tre. In totale il bot ha
fissato **352 appuntamenti**, di cui **288 negli ultimi 30 giorni**.

**Esiti mandati a voi negli ultimi 14 giorni:** 829 INTERROTTO, 543 NON_RISPOSTO,
366 DA_SCARTARE, 133 APPUNTAMENTO, 5 RICHIAMO.

**Il bot chiude quello che apre:** su 3.525 conversazioni sue, 3.333 sono chiuse, 140
ancora attive, 51 passate a una persona. Restano **176 senza esito, il 5%**.

**Dove si perdono i lead** (analisi automatica delle chat degli ultimi 30 giorni):
qualifica 294, proposta della call 286, prezzo 239, dopo il link 122, apertura 121,
giorno e ora 89, pitch 54. Il punto più caro è la proposta della call: su 10 lead a cui
viene proposta, 8 non ci arrivano — e quasi nessuno dice di no. Ci stiamo lavorando dal
24/08.

**Il numero WhatsApp** è ancora a qualità LOW per Meta (eredità del blast di luglio), ma
gli ultimi 7 giorni sono sani: 9.336 messaggi, 98,6% consegnati, 79,1% letti.

## 2. Quello che ci serve da voi

### a) I dati di quello che succede DOPO il fissaggio — la richiesta principale

Oggi il nostro database si ferma al momento in cui l'appuntamento viene preso. Non
sappiamo **niente** di quello che succede dopo: se il lead è stato confermato, se si è
presentato alla call, com'è andata, se ha comprato.

Senza quei dati stiamo ottimizzando alla cieca: possiamo far crescere il numero di
appuntamenti e non accorgerci che sono appuntamenti peggiori. Le decisioni importanti —
quanto insistere, come gestire il prezzo, se anticipare o meno il video di Noemi —
dipendono tutte da lì.

Ci servirebbe, **per ogni lead che il bot vi restituisce**:

| dato | perché |
|---|---|
| `leadId` | la chiave per agganciarlo alla conversazione |
| appuntamento confermato (sì/no, quando) | quanti fissaggi reggono fino alla call |
| spostato o disdetto (sì/no, quando, motivo) | oggi lo vediamo solo se il lead lo scrive al bot |
| presentato alla call (sì/no) | la metrica vera, non il fissaggio |
| esito della call | dove si perde dopo di noi |
| venduto (sì/no, importo, data) | l'unico numero che dice se il bot serve |
| chiuso da voi con che esito, e quando | per i lead che non fissano |

Sul **come**, la strada più semplice per voi la scegliete voi: possiamo esporre noi un
endpoint firmato HMAC come `/api/bot/intake` a cui mandate gli aggiornamenti quando
cambiano (una riga per evento, anche in ritardo), oppure ci basta un vostro endpoint da
interrogare, o anche solo un export periodico. Ditecelo e lo costruiamo noi.

### b) La sezione per i lead che chiedono di parlare con una persona

Quando un lead scrive che vuole una persona, il bot smette di rispondere e vi manda un
`CONTATTO_UMANO` con le sue parole. È una notifica: arriva una volta e, se in quel
momento non la vede nessuno, il lead resta fermo. **Oggi sono 46 in attesa, il più
vecchio del 27 luglio** ("Mi puoi chiamare").

Vi abbiamo mandato la specifica il 25/08: `POST /api/bot/contatti-umani`, stessa firma
di `/api/bot/intake`, restituisce l'elenco ordinato per attesa con nome, telefono,
motivo (7 categorie chiuse) e **le parole esatte del lead**. È già in produzione: manca
solo la sezione da parte vostra dove l'admin li vede e li assegna.

Da decidere: i 46 arretrati ve li rimandiamo come notifiche una per una, o vi bastano
dall'endpoint?

### c) Chi chiude i lead GDO "postino"

Sono le conversazioni in cui il bot fa solo da corriere per un appuntamento già fissato
dal GDO: per scelta non le classifica e non le chiude mai. **Oggi sono 873 senza esito**,
e continuano a crescere di 40-70 al giorno. Da parte vostra sono indistinguibili da lead
abbandonati. Non è un problema di software: va deciso chi le chiude e con che esito.

### d) Due modifiche al contratto

1. **`noteOnly` (o idempotenza) sull'APPUNTAMENTO.** Ogni POST `APPUNTAMENTO` da voi
   viene trattato come un appuntamento nuovo e risegnato. Per questo oggi, quando su un
   lead già fissato succede qualcosa (una disdetta, un cambio), vi mandiamo una NOTA e
   non l'esito. Ci servirebbe un campo `noteOnly` — o l'idempotenza su stesso lead +
   stessa data — per poter aggiornare senza duplicare.
2. **RICHIAMO senza data certa.** Oggi il contratto pretende un timestamp ISO su ogni
   RICHIAMO. Quando il lead dice "ci risentiamo a settembre", il bot non ha modo di
   scriverlo e **inventa** un giorno e un'ora: su 26 RICHIAMO, 22 cadevano su ore tonde
   che nessun lead aveva mai detto. Ci serve poter dire "richiamo, periodo indicativo".

### e) 127 esiti rifiutati in 30 giorni

Negli ultimi 30 giorni 127 nostri esiti sono stati rifiutati con `403 lead non assegnato
a un account bot`: avete ripreso il lead prima che il bot finisse. La guardia è corretta
e noi chiudiamo il lead da parte nostra, ma **quegli esiti non arrivano a voi**: sono
lead su cui il bot ha lavorato e di cui non vedete il risultato. Se vi interessano
possiamo mandarveli come NOTA invece che come esito, oppure lasciarli cadere: decidete
voi, ma sappiate che esistono.

### f) La query "lead fermi al bot senza esito"

Sul CSV di 338 lead che ci avete mandato il 06/08: **211 avevano un esito già inviato e
accettato dal vostro sistema con 2xx**, e il vostro `stato_crm` coincideva col nostro
esito (173 REJECTED su 177 DA_SCARTARE). Quella query non misura l'assenza dell'esito,
misura qualcos'altro — probabilmente l'assegnazione del lead all'account bot. Prima di
qualsiasi sanatoria di massa capiamo insieme cosa conta davvero.

### g) Avviso di consegna dell'agenda

Ci servono: l'OK sul payload (`leadId`, `esito`, `sid`, `at`), l'URL a cui mandarlo, la
conferma dei tre stati di consegna e della finestra di deduplica a 15 minuti. Abbiamo
**239 avvisi arretrati** pronti da mandarvi: aspettiamo il vostro via prima di lanciarli.

### h) Invio agenda per conto dei GDO

Il canale è pronto da entrambe le parti e spento dietro una vostra variabile. Per
accenderlo mancano: il permesso perché `/api/bot/outcome` accetti le NOTE su lead non
assegnati al bot, e una prova d'invio fatta insieme.

### i) Tre domande sull'analisi delle disdette

Ve l'abbiamo girata ad agosto. Le tre cose che dipendono da voi:

1. I casi di attrito telefonico che abbiamo trovato nelle chat (chiamata sgradevole,
   chiamate insistenti, nessuno ha chiamato, hanno chiamato e riattaccato): conv 3312,
   3363, 3809, 3828, 3893, 3948, 4018.
2. Siete disposti a **ri-fissare** davvero i lead che chiedono di spostare? Oggi il bot
   dice "ti ricontatta una collega" ed è un vicolo cieco.
3. Potete accettare call più ravvicinate? L'attesa mediana fra fissaggio e call è di
   **44 ore** ed è la causa numero uno delle disdette.

### j) Il report quindicinale

Ce lo aspettiamo con il taglio sulla **data di assegnazione** del lead, non sulla data
dell'esito: altrimenti confronta coorti diverse e non dice niente.

### k) Tre lead di giugno da riallineare

Alina, David e Daniela risultano da voi DA_SCARTARE/INTERROTTO ma da noi sono
appuntamenti reali, declassati da un nostro vecchio bug e poi ripristinati. Serve
l'allineamento da parte vostra.

## 3. Cosa è cambiato da parte nostra (per informazione)

- **Resa a 4 giorni.** Dal 24/08 un lead che tace per più di 96 ore torna a voi, invece
  che dopo 12 giorni: abbiamo misurato che oltre le 96 ore di silenzio **nessun lead
  fissa più** (55 tornati a scrivere, zero appuntamenti). Al momento del cambio 423 lead
  superavano già la soglia: se avete visto un picco di INTERROTTO in quei giorni, è
  quello.
- **Guardia sulla data.** Un appuntamento in un giorno di chiusura, di domenica o fuori
  dalla fascia 09-21 non entra più in agenda: durante ferragosto ne erano finiti 27 nei
  giorni chiusi.
- **Dichiarazione IA.** Dal 24/08 metà dei nuovi lead riceve un primo messaggio che
  dichiara che Marta è un assistente digitale (obbligo europeo dal 2 agosto). Stiamo
  misurando quanto costa in termini di risposta.

Grazie,
Bruno
