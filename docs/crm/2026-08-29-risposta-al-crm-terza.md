# Risposta al team CRM — 29/08/2026 (terza)

*Messaggio unico. Risponde alla loro terza del 29/08 e chiude quattro punti su cinque.
Le 12 segnalazioni arretrate sono già partite mentre scrivevamo.*

---

Ciao,

grazie: l'incrocio sugli otto è la cosa più utile arrivata in tutto lo scambio, e ci ha
fermato la mano su un messaggio che avremmo mandato domani mattina a sei clienti.

## 1. Gli 8: fermato tutto, e ci avevamo visto male tutti e due

Nessun messaggio parte. Sei di quelle persone sono clienti da tre settimane e ricevere un
"rifissiamo la call?" sarebbe stato imbarazzante quanto dite voi.

**Il vostro incrocio spiega tutto e chiude il punto**: l'esito era partito sotto l'id del
gemello, quello con la stessa persona e lo stesso numero. Da parte nostra risultava
mandato e accettato con 2xx, da parte vostra quell'id era rimasto intonso. Non era né un
vostro azzeramento né un nostro errore d'invio: era la deduplica per numero vista dai due
lati opposti.

Prendiamo atto anche del resto: 7 confermati su 8, 7 presentati, 6 vendite. Su un lotto di
otto appuntamenti fissati dal bot è un dato che non avevamo mai potuto vedere — ed è
esattamente il motivo per cui `lead-status` ci serviva.

**Mehdi.** La chat c'è ed è nostra. L'ultimo scambio è del 18 agosto: alle 09:09 scrive
«Ciao perdonami, ma oggi proprio non riesco» e «ho avuto degli imprevisti», Marta gli
risponde «quando saresti libero? mercoledì pomeriggio o giovedì ti funzionerebbero?» e da
lì lui non ha più scritto. È un recupero vero, e possiamo farlo noi: la finestra delle 24
ore è chiusa, quindi partirebbe un template di riaggancio e poi Marta rifissa. Non l'
abbiamo ancora mandato — ve lo diciamo prima di farlo, non dopo.

## 2. Il rifissaggio: da parte nostra è già attivo

Bene, e grazie per aver chiuso il buco della board: se il lead rifissato non compare
dov'è che le Conferme guardano, il "sì, accettato" vale zero. Avete ragione anche sul
tempismo — quel buco sarebbe rimasto aperto proprio mentre accendevamo il recupero NR.

Da parte nostra il ramo di rifissaggio è acceso dal 27 agosto, quando abbiamo preso il
contratto v1.5: se il lead chiede di spostare, il bot ripropone i suoi slot e vi manda un
`APPUNTAMENTO` con la data nuova, invece di dire "ti ricontatta una collega". Quindi dopo
il 3° NR Marta può fare tutto il giro: segnalarvi la risposta **e** rifissare.

## 3. `risposta_dopo_terzo_nr` mappato

Perfetto, alias compresi. Da parte nostra parte già.

## 4. I dieci esiti: il 403 era giusto, ma non per il motivo che pensate

Li abbiamo tracciati uno per uno, e la causa non è la deduplica: **quei dieci lead ce li
avete mandati voi**, il 31 luglio, chiedendoci di spedire l'agenda per conto del GDO.

Tutte e dieci le conversazioni cominciano allo stesso modo, nello stesso giorno: agenda
inviata su WhatsApp (`gdo_agenda_sent`), poi il video, poi le risposte del lead. Il 31
luglio era il **primo giorno** di `/send-agenda`, l'endpoint che avevamo acceso per
rimpiazzare Spoki.

Il problema è cosa faceva il bot dopo: la regola "sui lead in modalità postino niente
esiti, al CRM va solo una nota" da parte nostra è arrivata **dopo** quei giorni. Fino ad
allora il bot classificava quelle chat come le sue e vi mandava un esito — che voi
respingevate, giustamente, perché quei lead erano dei vostri GDO. Da noi infatti non
risulta nessun esito registrato su quei dieci: `bot_outcome` è nullo su tutti e dieci,
proprio perché il vostro 403 ha tenuto.

Quindi: **d'accordo, non ce li rimandate, la guardia resta**. Il meccanismo che li
generava è chiuso da parte nostra da settimane, e su `bea7627a` (il lead di GDO 109 che ha
comprato) siete stati protetti dalla vostra stessa guardia.

Una cosa da guardare da parte vostra: dite che nessuno dei dieci ha un'agenda recapitata
dal nostro canale. Noi abbiamo il log dell'invio WhatsApp e del video per tutti e dieci,
del 31 luglio. Se da voi quelle consegne non risultano, è un buco di registrazione
sull'integrazione `/send-agenda`, non sui lead: vale la pena vederlo prima che diventi una
discussione fra tre settimane.

## 5. Le 12: mandate, 11 accettate e 1 respinta

Sono partite mentre scrivevamo. **11 accettate con 200**, una respinta:

- `e4ef3953…` (elisabetta, conv 3671) → `403 lead mai passato dal bot`.

Ed è **la stessa** che ci segnalate al punto 6 come record incoerente da bonificare — data
di creazione dell'appuntamento valorizzata e data dell'appuntamento nulla. Quando l'avete
sistemata ditecelo e ve la rimandiamo in un secondo.

Grazie per la precisazione sulla coda nata l'8 agosto: cambia la lettura del conto, e
significa che il "12 richieste mai arrivate" non era un problema di trasporto né di
ricezione. Delle dodici, teniamo buona la vostra classificazione: **cinque sono quelle
vive** — Giuseppe Sorrentino, Irina, Ilenia, Fiorella, Anna.

Le loro parole, che ora sono nella coda insieme alla notifica: Giuseppe «Mi puoi
chiamare», Irina «Ho capito, farmi sentire la tua collega», Anna «Siete imbarazzanti».
L'ultima è una lamentela, non una richiesta di richiamo: chi la chiama è meglio che lo
sappia prima di comporre il numero.

## 6. Il bot sulle chat che voi avete già chiuso: non ci fermiamo, rifissiamo

Il blocco `contattoUmano` lo leggiamo da oggi, ogni 30 minuti. Ma sul caso che portate —
Valentina, auto-scartata il 5 agosto e la nostra nota del 6 che dice che vuole spostare a
sabato — la risposta giusta non ci sembra fermare la chat: quel lead **voleva** una call e
lo diceva il giorno dopo lo scarto. Con il rifissaggio che da oggi riapre davvero lo
scarto, il comportamento corretto è che il bot rifissi e ve lo mandi.

Quindi useremo `contattoUmano` per **sapere**, non per tacere: se una richiesta risulta
chiusa da voi, il bot non la ri-segnala; ma se il lead è ancora vivo e vuole una data,
continua a lavorarlo e ve la manda. Se per voi esiste un caso in cui invece dobbiamo
proprio smettere — un lead che avete chiuso per un motivo che noi non possiamo vedere —
ditecelo e lo mettiamo come regola.

## 7. I vostri 7 del 24 agosto: da parte nostra nessuno aveva un appuntamento

Li abbiamo cercati con i mezzi che abbiamo, cioè senza i loro `leadId`. Ecco cosa risulta
da noi su **tutti** i lead restituiti quel giorno, non su un campione.

Il 24 agosto vi abbiamo restituito **358 lead** come `INTERROTTO` — è il giorno del cambio
di soglia, quello del picco. Di quei 358:

- **zero** hanno una data di appuntamento addosso (né nostra né vostra);
- **zero** hanno mai prodotto un `APPUNTAMENTO` verso di voi.

Dove si sono fermate quelle conversazioni, secondo il nostro stesso log: 105 in
qualificazione, 91 alla proposta della call, 55 dopo il link, **39 mentre si concordava
giorno e ora**, 18 non classificabili, 17 sul prezzo, 12 in apertura, 11 al pitch, 10 sul
video di Noemi.

I 39 "giorno e ora" sono i soli che somigliano alla vostra descrizione, e capiamo perché
una nota così possa leggersi come "interrotta dopo la conferma dell'appuntamento". Ma le
parole vere di quei lead non sono conferme. Tre a caso, testuali:

- «Fissiamo per fine mese. Appena torno dalle vacanze»;
- «Allora magari ti faccio sapere se mai per il 19»;
- «Perfetto! Sabato sera ti scrivo 👍».

**Mandateci i 7 `leadId`** e li verifichiamo uno per uno: di ognuno abbiamo la chat intera
e vi diamo le parole esatte con data e ora. Se ci fosse anche un solo caso in cui il lead
aveva confermato davvero e noi non ve l'abbiamo mandato, è un bug nostro e lo vogliamo
sapere.

**E c'è un'occasione dentro quei 39.** Molti chiedevano date **dopo Ferragosto** — «dal 23
in poi», «fine mese» — mentre in quei giorni il bot aveva in agenda solo il 18 e il 19,
per la chiusura dall'11 al 17. Sono stati restituiti il 24, cioè il giorno esatto in cui
le date che chiedevano erano tornate disponibili. Se ce li rimandate adesso, quelle
conversazioni sono le più recuperabili che abbiamo: il lead aveva già detto di sì alla
call, mancava solo il giorno.

## Riassunto

**Fatto da parte nostra oggi:** le 12 segnalazioni arretrate (11 accettate, 1 respinta,
sopra); tracciati i dieci esiti fino alla causa; verificati tutti i 358 restituiti il 24
agosto.

**Fermato:** nessun messaggio agli otto. Mehdi resta pronto e non parte finché non ve lo
diciamo.

**Ci serve da voi:**

1. **I 7 `leadId`** del 24 agosto: è l'unica cosa rimasta aperta, e da noi non c'è traccia
   di un appuntamento su nessuno dei 358 di quel giorno.
2. **`e4ef3953…`** quando l'avete bonificata: la sua notifica ve la rimandiamo subito.
3. Se volete che vi **rimandiamo i lead del "giorno e ora"** ora che le date dopo
   Ferragosto esistono: sono 39 conversazioni in cui il sì c'era già.
4. Un occhio alle **consegne dell'agenda del 31 luglio**, che da noi risultano e da voi no.

A presto,
Bruno
