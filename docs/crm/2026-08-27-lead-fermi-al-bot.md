# Messaggio al team CRM — 27/08/2026: i lead fermi al bot

*Bozza pronta da inviare. Non è stata mandata a nessuno.*

---

Ciao,

siamo andati a fondo sulla lista dei lead fermi sull'account bot, quella dei 295 che ci
avete segnalato. Li abbiamo incrociati uno per uno con le nostre conversazioni. La
risposta breve è che la stragrande maggioranza non è ferma da parte nostra, e che dentro
quella lista c'è un problema vero ma diverso da quello che pensavamo tutti e due.

## 1. Cosa sono, uno per uno

Oggi i lead assegnati all'account bot con stato `NEW` o `IN_PROGRESS` sono **303**: 174
`NEW` e 129 `IN_PROGRESS`. Il più vecchio è assegnato dal 22 giugno, 130 sono oltre i 12
giorni. Fin qui siamo d'accordo con voi.

Incrociandoli con le nostre chat:

| | quanti | di chi è la palla |
|---|---|---|
| **Mai arrivati al bot** — nessuna conversazione da parte nostra | **58** | vostra: il push non ci è mai arrivato |
| Hanno già un esito nostro | **61** | vostra: l'esito c'è, lo stato non si è mosso |
| Aspettano una persona (`CONTATTO_UMANO`, il bot si è già fatto da parte) | **37** | vostra: sono nella coda `/richieste-contatto` |
| In lavorazione dentro i nostri tempi | **140** | nostra, e sta andando |
| **Fermi davvero da parte nostra** oltre la resa di 4 giorni | **7** | nostra, li chiudiamo noi |

Su 303, quelli su cui avete ragione sono **sette**. E li sistemiamo noi.

I 61 con un esito nostro sono: 36 RICHIAMO, 10 APPUNTAMENTO, 6 NON_RISPOSTO,
5 DA_SCARTARE, 4 INTERROTTO.

Due cose che aiutano a leggere il resto: **93** di questi lead non hanno **mai** risposto
a un messaggio del bot, quindi per loro non c'è nessun esito da aspettarsi oltre a
`NON_RISPOSTO` a fine sequenza. E i **36 RICHIAMO** non sono un errore: un richiamo non
chiude il lead, quindi è normale che da voi resti aperto — ma allora non dovrebbe
comparire in una lista di "fermi senza esito".

I **58 mai arrivati** sono la cosa da guardare per prima da parte vostra: il lead risulta
assegnato all'account bot, ma il push non ci è mai arrivato e per noi quella persona non
esiste. Se il push è best-effort senza retry, come dice il contratto, questa è la misura
di quanto costa.

## 2. Otto appuntamenti sono stati cancellati da una riassegnazione

Questa è la parte importante, e non ce l'aspettavamo.

Dei 10 lead con un `APPUNTAMENTO` nostro, due li ha fissati il bot mentre facevamo
questo conteggio e sono arrivati da voi regolarmente. Gli altri **otto** no: hanno un
appuntamento fissato dal bot, con il vostro sistema che ha risposto **2xx** al momento
dell'invio. Oggi da voi sono `NEW`, con `appointmentDate` a
`NULL`. In tutti e otto i casi la data di assegnazione al bot è **successiva** al momento
in cui il bot aveva fissato:

| lead | nome | fissato dal bot | call prevista | riassegnato al bot |
|---|---|---|---|---|
| `9dc36cd0` | Clea Tramontano | 06/08 | 08/08 15:00 | 10/08 |
| `bc5e5fa2` | Deborah Salmaso | 07/08 | 08/08 13:00 | 10/08 |
| `7abda86c` | Sherlyn Jordan V. | 09/08 | 11/08 08:00 | 11/08 |
| `554f665e` | Francesco Carinci | 09/08 | 18/08 11:00 | 18/08 |
| `1cf25901` | Mehdi | 11/08 | 18/08 10:00 | 11/08 |
| `ada8bc77` | luca soave | 12/08 | 18/08 12:00 | 19/08 |
| `44da42f6` | Kim Bruno Adrian | 15/08 | 18/08 07:30 | 18/08 |
| `428b24b3` | Natalia Nuca | 19/08 | 20/08 15:00 | 19/08 |

Quello che sembra succedere: il lead rientra nel pool di assegnazione, viene riassegnato
all'account bot e l'appuntamento viene azzerato. **Tutte e otto le call sono ormai
passate e non le ha fatte nessuno.**

E da lì il lead resta bloccato per sempre: da parte nostra l'esito `APPUNTAMENTO` è
terminale (è la regola che ci avete chiesto voi, per non declassare un lead già fissato),
quindi il bot non lo rilavora. Il lead resta `NEW` da voi e finisce dritto dentro la
lista dei "fermi al bot" che ci state segnalando. È un cerchio che si chiude da solo.

Quello che ci serve da voi: **capire cosa rimette nel pool un lead che ha già un
appuntamento**. Finché quel meccanismo è vivo, ogni sanatoria che facciamo si riempie di
nuovo. Nel frattempo quegli otto vanno riallineati a mano da parte vostra: noi la data ce
l'abbiamo ancora.

## 3. Dieci esiti che il vostro sistema rifiuta anche come nota

Come d'accordo vi abbiamo rimandato gli esiti che avevate respinto con 403. **71 sono
stati accettati.** Dieci no: li rifiutate anche come `NOTA`, perché sul vostro lato non
risulta nessun push del bot su quei lead (`botReport` vuoto). Sono tutti già
`APPOINTMENT` da parte vostra, quindi non si perde niente di commerciale, ma se volete
anche quelli va allentata la guardia "lead mai passato dal bot" sulle note. Ditecelo e
ve li rimandiamo, altrimenti li lasciamo cadere.

## 4. Cosa abbiamo mandato nel frattempo

- **638 avvisi di consegna dell'agenda**, tutti accettati, zero errori. Erano più dei 239
  che vi avevamo detto: la coda ha continuato a crescere mentre ne parlavamo. Come ci
  avevate confermato, non è servita nessuna finestra di deduplica.
- **71 note** per gli esiti respinti con 403.
- Abbiamo acceso da parte nostra le tre cose del contratto v1.5: `RICHIAMO` con
  `periodo`, lo **spostamento** di una call già fissata (il bot adesso ripropone lui gli
  slot invece di dire "ti ricontatta una collega"), e `CONTATTO_UMANO` con `motivo` e
  `info`.

## 5. Cosa vi chiediamo

1. **La causa delle riassegnazioni** sui lead già appuntati, e il riallineamento degli
   otto qui sopra.
2. Una guardata ai **58 lead assegnati al bot che non ci sono mai arrivati**.
3. Se volete anche i **dieci esiti** rimasti fuori, o se li lasciamo cadere.
4. Restano aperte le due domande di ieri: il **dettaglio dei "3 NR"** (quante chiamate, a
   che ora, in che giorni) e il **via libera** perché sia il bot a scrivere su WhatsApp
   quando le Conferme non prendono la linea. Sul secondo punto abbiamo un numero nuovo
   che vale la pena mettere sul tavolo: lo scarto per "3 NR consecutivi" è al **42% sugli
   appuntamenti del bot e al 44% su quelli fissati dalle persone**. Non è un problema di
   chi fissa, è il collo di bottiglia più grande che abbiamo tutti e due — vale circa
   **1.288 appuntamenti persi dal 24 giugno**. La differenza è che sui lead del bot c'è
   una chat aperta e nessuno la sta usando.

Grazie,
Bruno
