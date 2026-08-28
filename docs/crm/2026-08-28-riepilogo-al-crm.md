# Messaggio al team CRM — 28/08/2026

*Bozza pronta da inviare. Non è stata mandata a nessuno.*

---

Ciao,

due giorni densi. Vi riassumo tutto quello che è cambiato da parte nostra e tutto quello
che aspettiamo da voi, in un messaggio solo.

## 1. Il recupero di chi non risponde al telefono: da parte nostra è acceso

È la cosa più importante di tutte. Lo scarto per **"3 NR consecutivi"** vale il **42%
degli appuntamenti fissati dal bot e il 44% di quelli fissati dai vostri GDO**: circa
**1.288 appuntamenti persi dal 24 giugno**. Non dipende da chi fissa, è il collo di
bottiglia più grande che abbiamo tutti e due.

La differenza è che sui lead passati dal bot esiste una chat WhatsApp aperta: negli ultimi
sette giorni il 98,5% dei nostri messaggi è stato consegnato e il 77,6% letto. Quando la
Conferma non riesce a parlargli, glielo scriviamo.

**Da parte nostra è tutto in produzione.** L'endpoint c'è, i due template sono stati
approvati da Meta come UTILITY, le guardie funzionano. **Manca solo che ci chiamiate.**

La specifica completa è nel documento che vi allego (`recupero-mancate-risposte`), ma il
minimo per partire è questo:

```
POST https://web-app-messaggistica.vercel.app/api/bot/call-attempt
x-bot-signature: sha256=<hmac del body grezzo, stesso BOT_WEBHOOK_SECRET>

{
  "leadId": "…",
  "esito": "no_answer",
  "tentativo": 1,                              // 1 oppure 3
  "at": "2026-08-28T15:40:00+02:00",
  "appointmentAt": "2026-08-29T15:00:00+02:00"
}
```

Stessa forma dell'invio automatico dell'agenda che già usate. Rispondiamo sempre `200`
con `{ok, inviato, ramo?, motivo?}`, mai un 500: se il bot si ferma, il `motivo` dice
perché. È idempotente su lead + tentativo, quindi un doppio clic non manda due messaggi.

Tre cose che vale la pena sapere:

- **`appointmentAt` è quello che fa la differenza.** Il messaggio cita giorno e ora della
  call: senza, diventa generico e recupera molto meno. Lo controlliamo anche: se è nel
  passato ci fermiamo, se diverge da quello che abbiamo noi ve lo segnaliamo.
- **Il momento conta più del testo.** Il messaggio deve partire entro pochi minuti dalla
  chiamata persa, quando il lead ha ancora la chiamata non risposta sul telefono.
- **Il messaggio dopo il terzo tentativo** dice al lead che senza una sua risposta
  l'appuntamento viene annullato. Non è una minaccia: è l'informazione che gli serve per
  decidere, e gli lascia il modo di confermare in due righe. Oggi al terzo NR il lead
  sparisce e basta: sono 138 persone solo sugli appuntamenti del bot.

## 2. La sezione per le Conferme

Quando un lead chiede di parlare con una persona, oggi la richiesta finisce in coda per un
**GDO**. È sbagliato quando quel lead **ha già un appuntamento**: da lì in poi è di
competenza delle **Conferme**. Sono **13 richieste su 66, il 20%**.

Da parte nostra è fatto: la segnalazione `CONTATTO_UMANO` adesso porta anche
`info.appuntamento` con data e ora della call, così potete instradarla senza cercarla. E
distinguiamo il caso di chi sta solo **aspettando la call**, che prima finiva in "altro".

Da parte vostra serve la sezione nei profili Conferme, con il **pallino rosso per ogni
nuova notifica** non ancora vista. Ci finiscono i lead già fissati che chiedono di parlare
con una persona, che dicono di aspettare la call, che chiedono di essere richiamati, o che
chiedono di disdire o spostare.

## 3. I volumi: reggiamo i 150 al giorno

Confermato. Il 15 e 16 agosto abbiamo preso in carico **216 e 214 lead in un giorno** e li
abbiamo lavorati tutti. Il numero regge 10.000 destinatari nelle 24 ore: 150 al giorno è
l'1,5% di quel limite. Oggi ne abbiamo già fatti 164 senza un errore.

Le fasce che avete scelto sono quelle giuste: il bot lavora meglio la sera e la notte,
quando il lead è appena arrivato e ha il telefono in mano.

Una cosa che vi dobbiamo dire perché in parte vi riguarda: **dal 24 al 28 agosto 27 lead
non hanno ricevuto nessun primo messaggio.** Una nostra configurazione rimasta indietro
bloccava sei modelli di apertura nuovi, e quei lead cadevano nel vuoto — per voi
risultavano consegnati. È chiuso: li abbiamo ripresi tutti e stamattina sono partite 95
aperture su 96 tentativi. Se in quei giorni avete visto lead assegnati al bot senza
nessuna attività, era quello.

## 4. La restituzione entro 3-4 giorni

Già fatto, dal 24 agosto: un lead che tace per più di 96 ore torna a voi, contro i 12
giorni di prima. L'abbiamo deciso misurando i recuperi — oltre le 96 ore di silenzio, su
55 lead tornati a scrivere, **zero hanno poi fissato**.

Un avviso onesto sui numeri che misurerete questa settimana: la mediana vi sembrerà ancora
intorno ai 5 giorni, perché stiamo smaltendo i lead che il 24 agosto **erano già** fermi
da 5-12 giorni sotto la vecchia soglia. Sulla coorte pulita — le chat iniziate dopo il
cambio — ne sono state restituite 33 e **una sola** ha superato i 4 giorni. Fra una
settimana il numero sarà quello vero.

## 5. I lead "fermi al bot": la risposta definitiva

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

## 6. Cosa ci serve da voi

1. **La chiamata `/api/bot/call-attempt`** al primo e al terzo mancato contatto, con
   `appointmentAt`. È la cosa che vale più di tutte le altre messe insieme.
2. **La sezione Conferme** con il pallino rosso, e l'instradamento alle Conferme (non ai
   GDO) dei lead già fissati.
3. **Un blocco sui telefoni inventati prima dell'assegnazione**: se `phoneSuspicious` è
   già `true` da parte vostra, quel lead non dovrebbe arrivare a nessun operatore.
4. **La causa delle riassegnazioni** su lead che hanno già un appuntamento, e il
   riallineamento degli otto della lista di ieri: erano stati accettati dal vostro sistema
   con 2xx e poi riportati a `NEW`, e tutte e otto le call sono passate senza che nessuno
   le facesse.
5. **Come volete gestire i duplicati.** Noi deduplichiamo per numero e non possiamo fare
   altrimenti: la stessa persona ha una chat sola. Se per voi è un problema, la strada è
   unire i lead da parte vostra quando il numero coincide.
6. Restano i **dieci esiti** che il vostro sistema rifiuta anche come nota (non risulta
   nessun push del bot su quei lead): ci interessano o li lasciamo cadere?

A presto,
Bruno
