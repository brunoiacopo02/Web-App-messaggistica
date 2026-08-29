# Messaggio al team CRM — 29/08/2026

*Messaggio unico e autosufficiente: niente allegati, la specifica del recupero NR è
dentro. Sostituisce la bozza del 28/08 (`2026-08-28-riepilogo-al-crm.md`), mai inviata.*

---

Ciao,

un messaggio solo con tutto: cosa è cambiato da parte nostra in questi giorni e cosa
aspettiamo da voi. Le prime tre cose valgono più di tutto il resto messo insieme.

## 1. Il recupero di chi non risponde al telefono: da parte nostra è acceso, aspetta voi

Lo scarto per **"3 NR consecutivi"** è il **42% degli appuntamenti fissati dal bot e il
44% di quelli fissati dai vostri GDO**: circa **1.288 appuntamenti persi dal 24 giugno**.
Non dipende da chi fissa: è il collo di bottiglia più grande che abbiamo tutti e due.

La differenza è che sui lead passati dal bot c'è una chat WhatsApp già aperta. Negli
ultimi sette giorni abbiamo mandato 11.606 messaggi: **98,7% consegnati, 70% letti**.
Quando la Conferma non riesce a parlargli al telefono, noi glielo scriviamo lì.

**Da ieri è tutto in produzione da parte nostra**: l'endpoint, le guardie e i due template
approvati da Meta. Ad oggi abbiamo ricevuto **zero chiamate**: finché non ci chiamate,
non parte nessun recupero. Qui sotto c'è tutto quello che vi serve, non serve altro.

### Cosa dovete chiamare

```
POST https://web-app-messaggistica.vercel.app/api/bot/call-attempt
x-bot-signature: sha256=<HMAC-SHA256 del corpo grezzo, stesso BOT_WEBHOOK_SECRET>
Content-Type: application/json

{
  "leadId": "…",                               // il vostro id lead
  "esito": "no_answer",
  "tentativo": 1,                              // 1 oppure 3
  "at": "2026-08-29T15:40:00+02:00",           // quando avete provato a chiamare
  "appointmentAt": "2026-08-30T15:00:00+02:00" // data e ora della call fissata
}
```

Stessa autenticazione e stessa forma dell'invio automatico dell'agenda che già usate.

**Quando:** appena la Conferma registra il mancato contatto, al **primo** e al **terzo**
tentativo. Non a fine giornata: il messaggio funziona quando il lead ha ancora la chiamata
persa sul telefono.

**Risposta:** sempre `200`, mai un 500, con `{ok, inviato, ramo, motivo}`. Se non abbiamo
scritto al lead, `motivo` dice esattamente perché. È **idempotente su lead + tentativo**:
un doppio clic o un retry non manda due messaggi.

**`appointmentAt` è quello che fa la differenza:** il messaggio cita giorno e ora della
call, e senza diventa generico e recupera molto meno. Lo controlliamo anche — se è nel
passato ci fermiamo, se diverge da quello che risulta a noi ve lo segnaliamo nella
risposta.

### Cosa facciamo noi quando ci chiamate

Il messaggio lo scrive Marta, la stessa persona con cui il lead ha già parlato. WhatsApp
apre una finestra di 24 ore dall'ultimo messaggio del lead, e da lì dipende la forma:

- **dentro le 24 ore** (~4 casi su 5, con i vostri orari di chiamata reali): Marta scrive
  a mano libera nella chat, tenendo conto di tutto quello che si erano detti;
- **fuori** (~1 su 5): parte un template approvato da Meta come UTILITY
  (`fenice_nr1_marta_v1`, `fenice_nr3_marta_v1`), e la conversazione riparte da lì.

Al **primo** tentativo il messaggio dice che abbiamo provato a chiamarlo per la call del
[giorno e ora], che bastano 5 minuti, e chiede se va bene o se preferisce un altro
momento. Al **terzo** dice esplicitamente che senza una sua risposta non lo chiameremo più
e l'appuntamento verrà annullato, e gli lascia il modo di confermare in due righe. Non è
una minaccia: è l'informazione che gli serve per decidere. Oggi al terzo NR il lead
sparisce e basta, e sono **138 persone** solo sugli appuntamenti del bot.

### Quando NON scriviamo (le guardie)

Chiamateci pure sempre, filtriamo noi. Il bot non scrive se: il lead non è nostro; il bot
è stato fermato a mano dal pannello; il lead ha già chiesto di disdire o spostare; la chat
è già passata a una persona; il lead ha già risposto dopo la chiamata persa;
l'appuntamento è già passato o non risulta; per quel tentativo abbiamo già scritto.

## 2. La sezione per le Conferme, con la notifica in tempo reale

Quando un lead chiede di parlare con una persona, oggi la richiesta finisce in coda per un
**GDO**. È sbagliato quando quel lead **ha già un appuntamento**: da lì in poi è di
competenza delle **Conferme**. Sono **14 richieste su 64, il 22%**.

**Fatto da parte nostra, da ieri:** la segnalazione `CONTATTO_UMANO` porta anche
`info.appuntamento` con data e ora della call, così potete instradarla senza doverla
cercare; e distinguiamo il caso di chi sta **solo aspettando la call**, che prima finiva
in "altro".

**Serve da parte vostra** la sezione nei profili Conferme, e su due cose insistiamo:

- **La notifica deve comparire in tempo reale anche lì**, con il pallino rosso finché
  qualcuno non l'ha vista. Noi ve la mandiamo nell'istante in cui il lead scrive: se
  compare solo nel riepilogo del giorno dopo, il vantaggio è già perso — è esattamente il
  motivo per cui oggi ci sono 48 richieste ferme.
- Ci finiscono i lead già fissati che chiedono di parlare con una persona, che dicono di
  aspettare la call, che chiedono di essere richiamati, o che chiedono di disdire o
  spostare.

## 3. I 48 fermi, e l'automazione che ci dice che fine fanno

Al momento ci sono **48 richieste di contatto umano ancora aperte**. La più vecchia è del
**27 luglio**: "Mi puoi chiamare". L'elenco completo e aggiornato ve lo serviamo noi, con
la stessa firma HMAC di `/api/bot/intake`:

```
POST https://web-app-messaggistica.vercel.app/api/bot/contatti-umani
{ "stato": "aperti", "limit": 500 }
```

Per ogni lead: `leadId`, telefono, nome, quando ha chiesto, il motivo in categoria, **le
parole esatte del lead**, gli ultimi messaggi. Ordinati per attesa: prima chi aspetta da
più tempo.

**Quello che manca è il ritorno.** Oggi noi consegniamo la richiesta e finisce lì: non
sappiamo se qualcuno l'ha presa in carico, quando, e com'è andata. Finché è così, il bot
resta zitto su quella chat all'infinito anche quando il caso è chiuso da settimane, e
nessuno dei due può dire se la sezione sta funzionando.

Vi chiediamo **un'automazione che ci dica che fine fa ogni richiesta**. La strada più
economica per voi è aggiungere un blocco alle righe che già servite su
`/api/bot/lead-status`, che noi leggiamo ogni 30 minuti: nessun endpoint nuovo, nessun
segreto nuovo, e recupera da solo anche l'arretrato perché è a cursore.

```json
"contattoUmano": {
  "presoInCaricoDa": "Nome Operatore | null",
  "presoInCaricoIl": "2026-08-29T10:12:00+02:00",
  "esito": "chiamato_ok | non_raggiungibile | rifissato | disdetto | non_gestito",
  "esitoIl": "2026-08-29T11:03:00+02:00",
  "nota": "testo libero, opzionale"
}
```

Se preferite spingere invece che farvi leggere, apriamo noi un endpoint gemello e ci
mandate lo stesso oggetto quando lo stato cambia: ditecelo e in giornata è pronto.
L'importante è che il segnale esista.

## 4. I volumi: reggiamo i 150 al giorno

Confermato. Il 15 e 16 agosto abbiamo preso in carico **216 e 214 lead in un giorno** e li
abbiamo lavorati tutti. Il numero regge 10.000 destinatari nelle 24 ore: 150 al giorno è
l'1,5% di quel limite. Le fasce che avete scelto sono quelle giuste: il bot lavora meglio
la sera e la notte, quando il lead è appena arrivato e ha il telefono in mano.

Una cosa che vi dobbiamo dire perché in parte vi riguarda: **dal 24 al 28 agosto 27 lead
non hanno ricevuto nessun primo messaggio.** Una nostra configurazione rimasta indietro
bloccava sei modelli di apertura nuovi, e quei lead cadevano nel vuoto — per voi
risultavano consegnati. È chiuso da ieri: li abbiamo ripresi tutti, e nelle ultime 36 ore
sono partiti 4.057 messaggi con 2 soli errori.

## 5. La restituzione entro 3-4 giorni

Già fatto, dal 24 agosto: un lead che tace per più di 96 ore torna a voi, contro i 12
giorni di prima. L'abbiamo deciso misurando i recuperi — oltre le 96 ore di silenzio, su
55 lead tornati a scrivere, **zero** hanno poi fissato.

Un avviso onesto sui numeri di questa settimana: la mediana vi sembrerà ancora intorno ai
5 giorni, perché stiamo smaltendo i lead che il 24 agosto **erano già** fermi da 5-12
giorni sotto la vecchia soglia. Sulla coorte pulita — le chat iniziate dopo il cambio — ne
sono state restituite 33 e **una sola** ha superato i 4 giorni.

## 6. I lead "fermi al bot": la risposta definitiva

Li abbiamo incrociati uno per uno con le nostre conversazioni. Dei 177 in stato `NEW`
sull'account bot:

| | quanti |
|---|---|
| telefono che non è un numero (`000`, `3`, `0000000000`) | 21 |
| **persone che avevamo già**, ripushate con un `leadId` nuovo | 30 |
| aspettano una persona (sono i vostri 31) | 33 |
| appuntamenti azzerati da una riassegnazione | 8 |
| hanno già un altro esito nostro | 12 |
| **fermi davvero da parte nostra** | **~6** |

I 30 duplicati sono la scoperta più utile: **quelle persone il bot le ha lavorate** — 10
INTERROTTO, 7 DA_SCARTARE, 6 NON_RISPOSTO, 3 APPUNTAMENTO — solo che l'esito è partito
sotto il `leadId` precedente, perché noi deduplichiamo per numero di telefono e voi create
un lead nuovo ogni volta che la persona rientra. Non sono lead persi: sono lead contati
due volte.

E una cosa che avevamo sbagliato noi, che vi diciamo perché non si ripeta: il nostro
endpoint di intake **rispondeva 200 anche quando non prendeva in carico il lead**. Dal
vostro lato era indistinguibile da un lead lavorato, ed è il motivo per cui questa lista
continuava a crescere.

## Cosa ci serve da voi, in ordine di valore

1. **La chiamata `/api/bot/call-attempt`** al primo e al terzo mancato contatto, con
   `appointmentAt`, entro pochi minuti dalla chiamata persa.
2. **La sezione Conferme con la notifica in tempo reale** e il pallino rosso, e
   l'instradamento alle Conferme — non ai GDO — dei lead che hanno già un appuntamento.
3. **L'automazione di ritorno sui contatti umani**: chi l'ha presa, quando, com'è finita.
   Sulle righe di `lead-status`, oppure in push su un endpoint che apriamo noi.
4. **Un blocco sui telefoni inventati prima dell'assegnazione**: se `phoneSuspicious` è
   già `true` da parte vostra, quel lead non dovrebbe arrivare a nessun operatore.
5. **La causa delle riassegnazioni** su lead che hanno già un appuntamento, e il
   riallineamento degli otto della lista: erano stati accettati dal vostro sistema con 2xx
   e poi riportati a `NEW`, e tutte e otto le call sono passate senza che nessuno le
   facesse.
6. **Come volete gestire i duplicati.** Noi deduplichiamo per numero e non possiamo fare
   altrimenti: la stessa persona ha una chat sola. Se per voi è un problema, la strada è
   unire i lead da parte vostra quando il numero coincide.
7. Restano i **dieci esiti** che il vostro sistema rifiuta anche come nota (non risulta
   nessun push del bot su quei lead): ci interessano o li lasciamo cadere?

Per qualsiasi dubbio sull'integrazione rispondete a questo messaggio: non serve andare a
cercare altri documenti, qui dentro c'è tutto.

A presto,
Bruno
