# Risposta al CRM — 27/08/2026: volumi, restituzione e i 174

*Bozza pronta da inviare. Non è stata mandata a nessuno.*

---

Ciao,

vi rispondo sui tre punti in ordine inverso, perché il terzo spiega gli altri due.

## 1. I 174 lead fermi: avete ragione sul push, ma "200" non vuol dire "lavorato"

Avete fatto bene a verificare prima di scriverci, e il vostro controllo è corretto: su
tutti c'è `BOT_PUSHED` con `result: sent, status: 200`. Quel 200 l'abbiamo mandato noi.

Il punto è che il nostro endpoint di intake **risponde 200 anche quando il lead non
viene preso in carico** — l'avevamo scritto così di proposito, per non far figurare
l'endpoint giù su un canale che non ha retry. È una scelta sbagliata: dal vostro lato
diventa indistinguibile da un lead lavorato, ed è esattamente il motivo per cui questa
lista continua a crescere. **La cambiamo noi**, vedi il punto 4.

Li abbiamo incrociati uno per uno. Oggi i lead `NEW` sull'account bot sono **177**:

**51 da noi non esistono sotto quel `leadId`.** Si dividono in due gruppi:

- **21 hanno un numero di telefono che non è un numero.** Letteralmente: `000`, `3`,
  `0000000000`, `11423229`, `32906789`. Li abbiamo scartati al momento del push e
  registrati come tali da parte nostra. Su 15 di questi il vostro sistema aveva già messo
  `phoneSuspicious: true`, quindi lo sapevate prima di noi. Non sono lavorabili da
  nessuno, né da noi né da un GDO: andrebbero fermati prima dell'assegnazione.
- **30 sono persone che avevamo già**, arrivate una seconda volta con un `leadId` nuovo.
  Noi deduplichiamo per numero di telefono, quindi il secondo push si è agganciato alla
  conversazione che già esisteva. **Il bot quelle persone le ha lavorate, e l'esito ve
  l'ha mandato** — sotto il `leadId` precedente. Sono 10 INTERROTTO, 7 DA_SCARTARE,
  6 NON_RISPOSTO, **3 APPUNTAMENTO**, 4 ancora in corso. Non sono lead persi: sono lead
  contati due volte.

**126 li abbiamo, e quasi tutti hanno la palla dalla vostra parte:**

- **33 hanno chiesto di parlare con una persona** — sono i vostri 31, e sono nella coda
  `/richieste-contatto` che avete appena messo in piedi. Il bot si è fatto da parte come
  da contratto: da lì in poi tocca a voi.
- **8 sono gli appuntamenti azzerati** di cui vi ho scritto ieri: fissati dal bot,
  accettati dal vostro sistema con 2xx, e poi riportati a `NEW` con `appointmentDate` a
  `NULL` da una riassegnazione successiva al fissaggio. Tutte e otto le call sono passate
  e non le ha fatte nessuno.
- **12 hanno già un altro esito nostro** (NON_RISPOSTO, DA_SCARTARE, RICHIAMO,
  INTERROTTO) che vi è stato mandato.
- **Circa 5 sono davvero fermi da parte nostra.** Quelli li chiudiamo noi.

Quindi: su 177, quelli su cui la sequenza è "interrotta senza chiudersi" sono una
manciata. Il resto è, in ordine di peso, **duplicati di persone già lavorate**,
**richieste di contatto umano che aspettano voi**, **numeri di telefono inventati** e
**appuntamenti che il vostro sistema ha cancellato da solo**.

## 2. Restituzione entro 3-4 giorni: fatto, dal 24 agosto

Avete ragione sulla diagnosi e la modifica è già in produzione da tre giorni, prima che
ce lo chiedeste. **Un lead che tace per più di 96 ore torna a voi**, contro i 12 giorni
di prima. L'abbiamo deciso misurando i recuperi: oltre le 96 ore di silenzio, su 55 lead
tornati a scrivere, **zero hanno poi fissato**. Tenerli oltre non serviva a noi e vi
costava una chiamata fredda.

I nostri tempi, misurati per coorte (settimana del primo contatto del bot, non del
ritorno):

| coorte | lead | mediana di restituzione |
|---|---|---|
| 20/07 | 185 | 1,1 giorni |
| 27/07 | 431 | 4,0 giorni |
| 03/08 | 989 | 4,0 giorni |
| 10/08 | 1.471 | 4,1 giorni |
| 17/08 | 541 | 4,0 giorni |
| 24/08 | 425 | 1,0 giorni, nessuno oltre i 4 |

La vostra mediana di agosto a 4,9 giorni e la nostra a 4,0-4,1 dicono la stessa cosa: la
differenza è che voi misurate sull'evento di ritorno, e nella settimana del 24 agosto
dentro quel conteggio ci sono **423 lead vecchi** che hanno superato la nuova soglia
tutti insieme il giorno del cambio. Ve l'avevamo segnalato: è quello il picco, non un
peggioramento.

La coorte del 24 agosto ha mediana 1 giorno e **nessun lead oltre i 4**, ma ha solo tre
giorni di vita: il numero vero lo avremo la settimana prossima. **Prendiamo l'impegno sui
4 giorni**, che è la soglia che abbiamo già in codice.

## 3. I 150 lead al giorno: sì, ma diamoci due settimane

Sul volume in sé non abbiamo dubbi: **il 15 e il 16 agosto abbiamo preso in carico 216 e
214 lead in un giorno** e li abbiamo lavorati tutti, senza code e senza rallentamenti.
150 al giorno è dentro quello che abbiamo già dimostrato di reggere.

Vi diciamo però una cosa che abbiamo scoperto oggi proprio guardando questi numeri.
**Dal 24 agosto una parte dei lead non riceve nessun primo messaggio**: una configurazione
rimasta indietro quando abbiamo introdotto sei nuovi modelli di apertura blocca l'invio, e
il lead cade nel vuoto senza che se ne accorga nessuno. Sono **75 lead in quattro giorni**,
circa 19 al giorno su 40: a 150 al giorno diventerebbero una settantina.

È un fix di una riga e lo chiudiamo oggi. Ve lo diciamo lo stesso perché parte di quei 75
sono probabilmente nella lista che ci avete mandato, e perché se domani vedete lead
assegnati al bot senza nessuna attività, adesso sapete cos'era.

Sul resto siamo pronti: il numero regge **10.000 destinatari nelle 24 ore** e negli ultimi
sette giorni ha fatto 9.738 messaggi con il **98,5% consegnati e il 77,8% letti**. 150 al
giorno è l'1,5% di quel limite.

Una cosa che invece ci aiuta molto: **le fasce che avete scelto sono quelle giuste**. Il
bot lavora meglio proprio la sera e la notte, quando il lead è appena arrivato e ha il
telefono in mano.

## 4. Cosa cambiamo noi, subito

1. **L'intake smette di rispondere 200 quando non prende in carico il lead.** Da ora vi
   diciamo cosa è successo, e soprattutto **vi mandiamo un esito anche per i lead che
   scartiamo**: telefono non valido, duplicato di una persona che abbiamo già, o errore
   nostro. Così non finiscono mai più in una lista di "fermi al bot" senza spiegazione.
2. Chiudiamo i **~5** che sono davvero fermi da parte nostra.
3. Chiudiamo il problema dei modelli bloccati.

## 5. Cosa ci serve da voi

1. **Un blocco sui telefoni inventati prima dell'assegnazione.** Se `phoneSuspicious` è
   già `true` da parte vostra, quel lead non dovrebbe arrivare a nessun operatore, bot o
   persona.
2. **La causa delle riassegnazioni** su lead che hanno già un appuntamento, e il
   riallineamento degli otto della lista di ieri.
3. **Come volete gestire i duplicati.** Noi deduplichiamo per numero di telefono e non
   possiamo fare altrimenti: la stessa persona ha una chat sola. Se ci mandate un
   `leadId` nuovo per una persona che abbiamo già, l'esito continuerà ad arrivarvi sul
   primo. Se per voi è un problema, la strada è unire i lead da parte vostra quando il
   numero coincide.
4. Restano aperte le due domande di ieri: il **dettaglio dei "3 NR"** e il **via libera**
   perché sia il bot a scrivere su WhatsApp quando le Conferme non prendono la linea.
   Ricordo il numero: lo scarto per "3 NR consecutivi" è al **42% sugli appuntamenti del
   bot e al 44% su quelli fissati dalle persone** — vale circa **1.288 appuntamenti persi
   dal 24 giugno**, ed è il collo di bottiglia più grande che abbiamo tutti e due.

A presto,
Bruno
