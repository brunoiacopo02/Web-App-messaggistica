# Risposta al team CRM — 29/08/2026 (seconda)

*Bozza pronta da mandare. Risponde punto per punto alla loro risposta del 29/08 e
consegna tutti i dati che ci hanno chiesto.*

---

Ciao,

risposta veloce, con dentro tutti gli elenchi che ci avete chiesto. Su due punti avete
ragione voi e ve lo diciamo subito; su uno i dati nostri dicono un'altra cosa e ve li
mettiamo in mano perché possiate verificarli.

## 1. Recupero NR: perfetto, e sì al `CONTATTO_UMANO` dopo il terzo tentativo

Che parta dal click stesso sul mancato contatto, e non da un bottone in più, è la
differenza fra una cosa che funziona e una che non viene premuta. Grazie.

**Confermiamo il punto sul 3° NR, ed è una modifica vera da parte nostra.** Oggi vi
mandiamo `CONTATTO_UMANO` solo quando il lead **chiede** di parlare con una persona: uno
che risponde "sì ci sono, scusate" al messaggio del terzo tentativo per noi è un lead
che ha semplicemente risposto, e voi non ne sapreste niente — resterebbe scartato. Lo
cambiamo: **dopo un messaggio di 3° NR, qualsiasi risposta del lead vi arriva come
`CONTATTO_UMANO`**, con le sue parole esatte e il motivo `risposta_dopo_terzo_nr`, così
le Conferme sanno che c'è qualcuno da riprendere. Vi avvisiamo appena è in produzione.

Sapere che il 3° NR **scarta già** il lead da parte vostra cambia anche il testo del
nostro messaggio, ed è meglio così: quando scriviamo "senza una risposta l'appuntamento
viene annullato" non stiamo minacciando, stiamo descrivendo una cosa appena successa.

**Una domanda che ci serve per chiudere il cerchio:** dopo il messaggio del 3° NR la chat
si riapre da parte nostra e Marta può rifissare la call. Su un lead che voi avete già
scartato, un nostro `APPUNTAMENTO` con data nuova viene **accettato** (come il
`rescheduled: true` del contratto v1.5) o rifiutato perché il lead è chiuso? Se lo
rifiutate, ditecelo e ci fermiamo al `CONTATTO_UMANO` lasciando la riapertura alle
Conferme.

## 2. La sezione Conferme: la diagnosi sbagliata era nostra

Avete ragione e ce ne scusiamo: abbiamo scritto "arriva solo nel riepilogo del giorno
dopo" senza avere modo di saperlo. La notifica era in tempo reale dal 26 agosto e il
problema era la pagina di atterraggio, che adesso c'è. Chiuso.

## 3. Il conto 64 vs 59: la differenza è nostra, e sono 12 persone

Abbiamo controllato subito e il vostro numero è giusto. Le notifiche `CONTATTO_UMANO`
che risultano **partite da noi sono esattamente 59**: non se n'è persa nessuna per
strada, e i vostri 59 combaciano al pezzo.

La differenza è che noi vi avevamo dato il numero delle **chat passate a una persona**
(oggi 65), non delle notifiche mandate. **12 di quelle chat non hanno mai generato una
notifica**: 11 sono precedenti al 5 agosto, cioè a quando l'esito `CONTATTO_UMANO` è
esistito, e una è del 6 agosto e la stiamo guardando. Non è un problema di trasporto: non
sono mai partite.

Sono 12 persone che hanno chiesto di parlare con qualcuno e di cui non sapete nulla. La
più vecchia è del 27 luglio.

| conv | leadId | nome | telefono | ultimo messaggio |
|---|---|---|---|---|
| 3319 | b8c2c36b-d5f9-4327-8ef2-53bacbbebae6 | Giuseppe Sorrentino | +393486935915 | 27/07 08:32 |
| 3312 | 971d511f-6073-4e5e-8ab7-7681c5057b8f | Elisabetta Gamba | +393937332999 | 27/07 14:36 |
| 3597 | 315a6821-c54d-4ec3-b8d0-03dfb381b773 | Irina Zaharchenko | +393933578610 | 30/07 12:02 |
| 3363 | 42bd3fad-c8a6-433e-b761-81279221fb82 | Oumaima | +393423209157 | 30/07 12:55 |
| 3261 | dfb39eb0-76b2-4f52-bfba-095bc1a5a21b | Anna | +393484096111 | 31/07 12:14 |
| 3671 | e4ef3953-a576-4f79-aad7-da9c9a97ffa0 | elisabetta | +393358388659 | 31/07 16:02 |
| 3781 | 295d63a4-f7f6-45a1-8d7d-a3c501aa501c | Dina Tomasiello | +393343108426 | 01/08 17:43 |
| 3862 | fe808e9e-a020-4b34-a544-77d58e6a858f | Ilenia | +393717406388 | 01/08 21:53 |
| 3894 | 62686ffe-ea99-4abf-b2c3-5e47c644c9cf | Fiorella Magnera | +393387627990 | 02/08 10:38 |
| 3748 | 4b0dc03b-e049-4ae5-838f-2e786df61ff3 | Vincenzo | +393281742595 | 03/08 09:26 |
| 4020 | d7184088-5d3b-4a8c-a324-00ca818a1104 | Enkeleda | +393479151410 | 04/08 12:14 |
| 4051 | 1736c0c8-2241-47f0-bdc0-4d18988516dd | Valentina Valente | +393409229432 | 06/08 10:48 |

Tre di queste (3312, 3363, 4051) avevano **già un appuntamento** quando hanno chiesto di
parlare con qualcuno: sono le vostre, non dei GDO.

**Ve le mandiamo come `CONTATTO_UMANO` appena ci dite di sì** — lo script è pronto, sono
notifiche verso persone vere e non le facciamo partire senza il vostro ok. Nel frattempo
l'elenco aggiornato lo trovate quando volete su `/api/bot/contatti-umani` con
`{"stato": "tutti"}`.

Il blocco `contattoUmano` su `lead-status` va benissimo così com'è, `stato` e
`richiestaIl` inclusi. Grazie soprattutto per la nota sul cursore: avevate ragione, con
`updatedAt` legato solo al lead avremmo visto silenzio e concluso la cosa sbagliata.
Iniziamo a leggerlo e vi diciamo quando siamo su.

## 4. Telefoni inventati: niente da aggiungere

367 telefonate a numeri inesistenti per 1 appuntamento e 0 euro è un dato che vale da
solo. Sui lead che erano arrivati a noi, quelli con un telefono non valido erano 21 su
177. Concordi anche sul non scartarli in automatico.

## 5. Riassegnazioni: ecco gli 8 con tutto quello che abbiamo

Prima di tutto: grazie per aver messo la guardia e per aver trovato da soli il secondo
caso dei 4 lead scartati e resuscitati. Quello è il tipo di controllo che nessuno dei due
poteva fare dall'altra parte.

**Gli 8 `leadId`, con l'ora esatta in cui vi abbiamo mandato l'appuntamento e la data
della call che avevamo fissato** (ore italiane):

| leadId | nome | telefono | `APPUNTAMENTO` inviato | call fissata |
|---|---|---|---|---|
| 9dc36cd0-b1e6-4c6a-91c1-0320fc7b4490 | Clea Tramontano | +393313486646 | 06/08 13:10:11 | 08/08 17:00 |
| bc5e5fa2-41d7-4c28-8a20-7188c6ea636a | Deborah Salmaso | +393711321673 | 07/08 09:29:53 | 08/08 15:00 |
| 7abda86c-7d50-43e2-9cf5-8f63323ad7fc | Sherlyn Jordan Vera | +393466652923 | 09/08 16:06:59 | 11/08 10:00 |
| 554f665e-fef0-4c47-b20c-b49e77b89e56 | Francesco Carinci | +393532182032 | 09/08 20:41:54 | 18/08 13:00 |
| 1cf25901-3025-49d8-9d80-90651144b513 | Mehdi Mehdi | +393888607875 | 11/08 10:34:59 | 18/08 12:00 |
| ada8bc77-03b9-4775-888c-de7964619b8d | luca soave | +393939067881 | 12/08 14:04:21 | 18/08 14:00 |
| 44da42f6-2d81-4b9b-86c5-fed7ed8230fc | Kim Bruno Adrian Nobili | +393662085461 | 15/08 19:08:01 | 18/08 09:30 |
| 428b24b3-4b44-430e-8456-ba278132df57 | Natalia Nuca | +393807812204 | 19/08 18:56:35 | 20/08 17:00 |

**Sul payload e sul corpo della risposta dobbiamo essere onesti: non li conserviamo.**
Quello che conserviamo è più stretto ma dice la stessa cosa: la riga di log
`bot_outcome_sent` viene scritta **solo dentro il ramo in cui la vostra risposta è 2xx**
— se rispondete 4xx o va giù la rete, finiamo in un altro ramo che scrive un errore, e
di errori su questi 8 non ce n'è nessuno. Per tutti e otto la riga esiste, con
`outcome: "APPUNTAMENTO"` scritto dentro: non è un `NOTA` né un `CONTATTO_UMANO`
scambiato per un fissaggio, che era l'ipotesi che ci offrivate.

Il corpo che vi abbiamo mandato è ricostruibile alla lettera, perché lo componiamo sempre
allo stesso modo:

```json
{ "leadId": "…", "outcome": "APPUNTAMENTO", "date": "2026-08-08T17:00:00+02:00", "note": "…" }
```

E la data la validiamo **prima** di spedire: se non ha l'offset di fuso non parte proprio,
quindi l'ipotesi del 400 su questi otto non regge — un 400 non avrebbe lasciato la riga
di 2xx.

**Dove i due racconti divergono davvero:** voi ne avete identificati 7 «tutti rilasciati
il 24 agosto». I nostri otto sono stati fissati fra il **6 e il 19 agosto** e riassegnati
fra il **10 e il 19**, cioè prima. Non sono lo stesso insieme: probabilmente state
guardando un altro gruppo. Con i `leadId` qui sopra si chiude in dieci minuti, e va bene
comunque vada a finire.

**La cosa urgente, che possiamo fare noi e subito.** Le chat di queste otto persone sono
nostre e sono ancora aperte: se ci date il via libera, **le ricontattiamo noi su WhatsApp
domani mattina** e rifissiamo la call con l'agenda vera. Tutte e otto le date sono ormai
passate. Ci serve solo sapere se, su un lead riassegnato o scartato da parte vostra, un
nostro `APPUNTAMENTO` nuovo viene accettato (è la stessa domanda del punto 1).

**Il picco del 20-25 agosto è nostro, ed è voluto.** Ve lo confermiamo con i numeri:
INTERROTTO mandati da noi, 20/08 → 47, 21/08 → 82, 22/08 → 73, 23/08 → 66, **24/08 → 358**,
25/08 → 129, poi 16, 11, 17. È il cambio di soglia di restituzione da 12 giorni a 96 ore,
acceso il 24: tutto l'arretrato che era già oltre le 96 ore è uscito in un colpo solo. Non
c'è stato nessuno svuotamento a mano, e da fine mese la curva è tornata a 11-17 al giorno.

## 6. Duplicati: `personKey` e `previousLeadIds` vanno benissimo

È la soluzione giusta: voi non riscrivete attribuzioni e provvigioni già chiuse, noi
sappiamo con chi stiamo parlando. Li consumiamo e vi diciamo quando siamo su, così
controlliamo insieme che i lead fermi si sblocchino. Anche la finestra anti-doppione a 24
ore ci torna: chi rientra dopo giorni è un lead nuovo davvero.

Il 30% con storico recuperabile contro il nostro 30 è la stessa cosa vista da due lati:
noi contavamo solo chi aveva ancora una chat aperta.

## 7. I dieci esiti: eccoli

| conv | leadId | esito | quando |
|---|---|---|---|
| 3665 | bea7627a-ee60-4317-90d9-f567d0fc7ced | APPUNTAMENTO | 31/07 |
| 3684 | c314b2b0-af7c-49b7-a47c-ce0baee9f603 | APPUNTAMENTO | 31/07 |
| 3687 | f9ae189f-952e-4b71-a632-ce4dec50ebf7 | APPUNTAMENTO | 31/07 |
| 3668 | b5d663bb-539c-42d4-b123-091c7cc3af10 | DA_SCARTARE | 31/07 |
| 3716 | 25c91118-2cd3-461f-b0dd-2b4d8944eb9c | DA_SCARTARE | 31/07 |
| 3700 | 4bbe204f-d805-4153-8a10-13d8aa2f3fdf | DA_SCARTARE | 31/07 |
| 3706 | 3dcfe802-f3cd-4b55-9693-4f7fd395a288 | DA_SCARTARE | 01/08 |
| 3670 | 626a5189-3611-4750-95fd-c395f9c7f7cf | RICHIAMO | 31/07 |
| 3696 | 5e7e2402-8abe-49b1-af3e-9508e12af567 | RICHIAMO | 31/07 |
| 3702 | 6ef47f45-6e3c-404b-99bf-844ae395a3d9 | RICHIAMO | 03/08 |

Sono tutti del 31 luglio - 3 agosto, cioè della stessa finestra dei 403. Se allentate la
guardia sulle note ve li rimandiamo con lo stesso script che ha già smaltito i 71.

## 8. Sul nostro 200: avete ragione, e lo chiudiamo

Che le vostre statistiche sul bot sovrastimino i lead presi in carico è una conseguenza
reale del nostro bug, e va detta in entrambe le direzioni quando confrontiamo numeri.

Per non portarcelo dietro: **cambiamo la risposta dell'intake**. Continueremo a
rispondere 200 (il canale non ha retry e un 500 vi farebbe solo rumore), ma il corpo
dirà esplicitamente `{"accettato": false, "motivo": "…"}` quando non prendiamo in carico
il lead — telefono non valido, duplicato per numero, e così via. Se lo registrate, da lì
in poi la vostra colonna "lavorato dal bot" torna vera senza che nessuno debba
riconciliare a mano.

## Riassunto

**Vi abbiamo dato:** gli 8 `leadId` con orari e date, i 10 esiti rifiutati, i 12 lead che
hanno chiesto una persona senza che ve lo dicessimo, e la conferma con i numeri che il
picco del 24 agosto è il nostro cambio di soglia.

**Facciamo noi:** `CONTATTO_UMANO` su qualsiasi risposta dopo il 3° NR; lettura del blocco
`contattoUmano` da `lead-status`; consumo di `personKey` e `previousLeadIds`; l'intake che
dice quando scarta un lead. Vi avvisiamo mano a mano che vanno in produzione.

**Ci serve da voi:**

1. **Se un `APPUNTAMENTO` nuovo su un lead scartato o riassegnato viene accettato.** Da
   questo dipende se dopo il 3° NR il bot può rifissare o deve solo passare la palla.
2. **Il via libera a ricontattare le 8 persone** della tabella del punto 5: le chat sono
   aperte, ci pensiamo noi.
3. **Il sì o il no sulle 12 notifiche arretrate** del punto 3.
4. **Se volete i 10 esiti** del punto 7.
5. Il vostro riscontro sugli 8 `leadId`: se da voi risultano diversi dai 7 che avevate
   trovato, sapere dove divergono serve a tutti e due.

A presto,
Bruno
