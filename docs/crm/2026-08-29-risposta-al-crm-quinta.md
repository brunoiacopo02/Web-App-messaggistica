# Risposta al team CRM — chiusura, 29/08/2026

*Messaggio unico. Il form l'abbiamo aperto e riprodotto: dentro c'è cosa fa, con i numeri.
Sull'irreperibile avete ragione voi e l'eccezione è già tolta.*

---

Ciao,

due cose sole, ed entrambe hanno una risposta con dei numeri invece che con
un'opinione. Poi il resto in due righe.

## 1. Il form: l'abbiamo aperto, e si rompe da solo

Non serviva aspettare i lead: basta aprirlo. Questo è cosa vede chiunque ci clicchi
**adesso**, ed è rifacibile in trenta secondi da voi.

**Le uniche due giornate prenotabili sono lunedì 31 agosto e martedì 1 settembre.**

| giorno | fasce offerte | libere |
|---|---|---|
| lunedì 31/08 | 7 (dalle 15:00 alle 21:00) | **2** |
| martedì 01/09 | 13 (dalle 09:00 alle 21:00) | 13 |
| da mercoledì 02/09 in poi | **nessuna** | — |

Dal 2 settembre in avanti il form dice *«Nessuna fascia oraria disponibile»*, e tutti i
giorni del calendario sono grigi.

**E la freccia "giorno successivo" non avanza di un giorno: salta di mese.** Dopo il 1°
settembre porta al 1° ottobre, poi al 1° novembre, poi al 1° dicembre — tutti vuoti. È
letteralmente la frase del vostro lead: *«Non mi fa scegliere martedì 18 agosto, mi manda
a 1 settembre»*. Non stava esagerando: stava descrivendo il bottone.

**Da qui viene tutto il resto.** La finestra prenotabile è di due giorni: chi apre il link
il giorno dopo averlo ricevuto — cioè la maggioranza — non trova più il giorno che gli
avevamo promesso, e non trova nemmeno un'alternativa, perché dal terzo giorno in poi non
c'è niente. Giulia il 16 agosto ha confermato «mercoledì 19 alle 12» e sul form non
riusciva a selezionare **nessuna** data: con questa finestra, il 19 per lei era già fuori.

### La parte che è colpa nostra, e ve la diciamo con i numeri

Il bot propone due giornate — "domani dalle 15:00 alle 21:00" e "dopodomani dalle 09:00
alle 21:00" — e quelle fasce combaciano con la forma del form. **Ma non con la sua
capienza**, e nessuno dei due lo stava guardando:

- in agosto il bot ha fissato **312 call**, **13,6 al giorno** di media;
- **13 giorni su 23** hanno più di 7 call, cioè più di quante ne regge il primo giorno;
- il 18 agosto, primo giorno dopo Ferragosto, ne ha messe **98 in una giornata sola**;
- **107 su 312 (il 34%) sono prima delle 15:00**, cioè in fasce che il primo giorno
  disponibile non offre proprio.

Il tetto giornaliero da parte nostra esiste già nel codice (`BOOKING_DAILY_CAP`) ma **in
produzione è spento**: senza, il bot propone "domani" a tutti e nessuno conta quante ne
stanno dentro. Lo accendiamo appena ci dite il numero giusto — è un numero di Fenice, non
del software, e adesso abbiamo l'ordine di grandezza: 7 il primo giorno, 13 il secondo.

**Cosa vi chiediamo, in ordine di quanto pesa:**

1. **La finestra a due giorni**: allargatela. Con sette giorni prenotabili chi apre il
   link in ritardo trova ancora qualcosa, e il 34% di call che il bot fissa la mattina
   smette di essere un problema.
2. **La freccia che salta di mese**: è un bug, e mangia i lead che ci arrivano più
   vicini alla prenotazione.
3. **Il numero per il tetto**: quante call al giorno reggete davvero.

## 2. "Irreperibile": avete ragione, l'eccezione è già tolta

Zero su 50.380 chiude la discussione, e la seconda osservazione è ancora più forte della
prima: lo scarto "irreperibile" arriva **dopo** che la nostra chat non ha convertito, non
prima. Riscrivere a quelle persone è ritentare la stessa cosa. In produzione da oggi:
**di nostra iniziativa il bot non scrive più a nessuno scartato, irreperibile compreso.**

Sul conteggio avete ragione anche lì: 811, non 881. Era una nostra trasposizione.

**Ma guardando i dati per togliere l'eccezione ne è saltata fuori una terza cosa, che non
era in nessuna delle due proposte.** Sulle 185 chat vive con uno stop, **87 hanno un
messaggio del lead negli ultimi 14 giorni**. E 39 di quelle sono **clienti o persone che
alla call ci sono andate**: gente che scrive a Marta *dopo* aver comprato. Con la regola
secca — la vostra e la nostra — il bot lì tace e basta. Una persona scrive e non le
risponde nessuno.

Quindi la regola che abbiamo messo distingue **scrivere per primi** da **rispondere**:

- **di nostra iniziativa** (sequenza, recupero NR, follow-up): fermo su `presented`,
  `sold` e qualsiasi `discardReason`. Nessuna eccezione;
- **quando è il lead a scriverci**: la sua iniziativa vale più del nostro stato, e il bot
  risponde — tranne a clienti e presentati, dove il bot si toglie di mezzo **e la chat
  passa a una persona**, con un `CONTATTO_UMANO` che dice chi ha scritto e cosa. Non
  silenzio: una segnalazione.

**Il perimetro** che chiedevate: applichiamo lo stop ai lead di cui `lead-status` ci dà lo
stato, cioè quelli passati dal bot — oggi 2.766 righe con uno stop possibile. Sugli altri
non abbiamo visibilità e non possiamo applicarlo.

**Sul test dei 500:** la soglia del 3% a 30 giorni ci sembra onesta e la accettiamo così
com'è, decisa prima e non dopo. Ma dopo la vostra evidenza non siamo più noi a chiederlo:
se volete farlo lo misuriamo volentieri, e vi proponiamo una sola modifica — prendete i
500 fra chi ha **una chat ancora aperta con noi**, non a freddo. Se il canale non esiste,
il test misura la nostra capacità di riaprire una conversazione, non il valore del lead.

## 3. Il resto, in breve

**`conferma_senza_appuntamento`**: corretto e in produzione. Avevamo scritto
`confermato_senza_appuntamento` — una parola di differenza e la marcatura non sarebbe
scattata. Grazie di averlo detto per esteso invece di darlo per scontato: è esattamente il
tipo di dettaglio che fa fallire un'integrazione in silenzio.

**Mehdi**: il messaggio è partito oggi alle 14:02 ed è stato consegnato. Non ha ancora
risposto. Vi diciamo com'è andata, anche se dice NO.

**I 39 del "giorno e ora"**: mandateceli quando volete, e vi torna il conto separato a
coda finita.

**Il vostro numero sugli appuntamenti** — 19,7% di conferme contro 10,4%, presentati al
17,1% contro 8,6%, scontrino più alto — non l'avevamo mai visto da questo lato, ed è la
prima volta che possiamo misurare se quello che cambiamo migliora o peggiora la **qualità**
invece del solo numero di appuntamenti. È il motivo per cui `lead-status` valeva la pena.

Sui 50 che avevano confermato: prendiamo il vostro conteggio e il "valore realizzato:
zero". Con il form a due giorni e la segnalazione che prima non c'era, quel numero
dovrebbe muoversi da solo — e adesso lo vediamo tutti e due.

## Riassunto

**Fatto da parte nostra:** eccezione "irreperibile" tolta; stop distinto fra iniziativa e
risposta, con passaggio a una persona per clienti e presentati; `conferma_senza_appuntamento`
corretto; Mehdi riagganciato.

**Ci serve da voi:**

1. **La finestra del form** allargata, e la **freccia che salta di mese** sistemata.
2. **Il numero di call al giorno** che reggete, per accendere il tetto da parte nostra.
3. I **39**, quando volete.
4. Il **test sui 500**, se lo volete fare: soglia accettata, lotto da prendere fra chi ha
   una chat aperta.

A presto,
Bruno
