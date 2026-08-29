# Risposta al team CRM — 29/08/2026 (quarta)

*Messaggio unico. Sull'agenda del 31 luglio avevamo torto noi e lo diciamo in chiaro.
Mehdi è già stato riagganciato, e i due riscontri che chiedevate vi danno ragione
entrambi.*

---

Ciao,

partiamo dalla cosa su cui sbagliavamo noi, perché è quella che vi fa perdere tempo.

## 1. L'agenda del 31 luglio: avete ragione voi, e sappiamo perché

Nessuna richiesta è mai arrivata a `/api/send-agenda` per quei dieci lead. Non c'è nessun
buco di registrazione da parte vostra: ritiriamo la frase, era sbagliata.

**Quelle dieci agende le abbiamo mandate noi a mano, da uno script, con un CSV
esportato da voi.** Ecco cosa risulta dal nostro log, al secondo: il primo invio dello
script è delle **12:42:10** del 31 luglio, i dieci lead sono partiti fra le **12:52:24 e
le 12:55:04**, e ognuno di quegli eventi porta scritto testualmente *"agenda inviata
**(script)** per conto del GDO"*. Il canale automatico è arrivato dopo, alle 13:25, ed è
la vostra prima chiamata: quindi le vostre due ore combaciano con le nostre.

Le risposte alle vostre domande:

1. **Nessun timestamp di richiesta in ingresso**, perché non c'è stata nessuna richiesta.
2. **I vostri `leadId` li avevamo dal CSV che ci esportavate voi**, in quei giorni, per
   fare gli invii a mano finché il canale non era pronto. Lo script legge le colonne per
   nome — `Telefono, Nome, Appuntamento, LeadId, GDO, Funnel` — ed è da lì che quegli id
   sono finiti sulle nostre conversazioni.

E allora l'ipotesi della deduplica non serve: non è la terza volta, è un caso diverso. Ma
una cosa da sapere resta, e non è piccola: se voi il **30 luglio** avevate già mandato
l'agenda via ActiveCampaign e noi l'abbiamo rimandata il **31 alle 12:52**, quelle dieci
persone hanno ricevuto **la stessa agenda due volte in due giorni**, da due canali
diversi. All'epoca facevamo gli invii a mano proprio perché Spoki non consegnava: quel CSV
probabilmente conteneva anche chi era già stato servito.

Resta valido il resto: il bot trattava quelle chat come sue e vi mandava un esito, il
vostro 403 ha tenuto, `bot_outcome` è nullo su tutti e dieci, e la regola "sui lead in
modalità postino solo note, mai esiti" oggi c'è. Non ce li rimandiamo.

## 2. Mehdi: riagganciato, oggi alle 12:02

Fatto subito. Gli è arrivato — consegnato — questo:

> «Ciao Mehdi, sono Marta di Fenice Academy: ci eravamo persi a metà discorso 🙂 Se ti va
> riprendiamo da dove eravamo rimasti, altrimenti scrivimi NO e non ti disturbo più.»

Se risponde, Marta riprende da dove si erano lasciati il 18 agosto e prova a rifissare: se
ottiene una data ve la mandiamo come `APPUNTAMENTO`, e con il vostro rifissaggio nuovo
torna sulla board delle Conferme da solo. Se scrive NO, lo lasciamo in pace e ve lo
diciamo.

## 3. I due riscontri: le chat vi danno ragione su tutti e due

Li abbiamo aperti riga per riga. **Erano due appuntamenti veri e li abbiamo persi noi.**

**Giulia Spizzico** — 16 agosto, ore 19:43. Marta le scrive: *«Abbiamo disponibilità
martedì 18 agosto o mercoledì 19, dalle 9 alle 21. Avevi detto mercoledì 19 alle 12, vuoi
confermare quello?»*. Lei alle **19:43:50**: *«Si esatto confermo mercoledì 19 alle 12»*.
Marta risponde: *«Perfetto! Scegli mercoledì 19 alle 12 sul form e dimmi che nome ti
compare quando invii»*. E lì finisce. La nostra stessa nota dice che **il form non le
permetteva di selezionare nessuna data**: problema tecnico. Il sì c'era, l'appuntamento no.

**Viola Davide** — 14 agosto. Aveva già ricevuto lo slot (*«Ricorda di scegliere martedì
18 agosto alle 16:00 sul form»*), **aveva inviato il form** — è per quello che vedeva il
nome di Noemi — e le mancava solo di scrivere FATTO dopo il video. Anche qui: form
compilato, appuntamento mai partito.

**La causa è una sola, ed è nostra**: il bot manda l'`APPUNTAMENTO` solo quando ha la
conferma che il form è stato compilato. Un lead che dice sì a voce e poi inciampa sul form
tornava indietro come "chat interrotta", con la conferma sepolta dentro la chat.

**Non sono due casi.** Abbiamo contato: **in agosto sono 49** i lead restituiti senza
appuntamento la cui nota dice che avevano confermato o compilato il form.

**Cosa abbiamo cambiato oggi.** Il classificatore adesso decide anche se il lead aveva
confermato — giorno e ora precisi, o form completato, con la regola stretta: un "va bene"
generico o una disponibilità di massima non contano. Quando è vero, **prima** dell'esito
parte un `CONTATTO_UMANO` con le sue parole e una nota che dice
*"AVEVA CONFERMATO E L'APPUNTAMENTO NON C'È"*. Si aggiunge, non sostituisce: il lead vi
torna come sempre, ma il sì non resta sepolto.

**Cosa NON abbiamo cambiato, e vogliamo dirlo:** il bot continua a **non** fissare senza
il form. La preselezione di Noemi e il calendario restano l'unica fonte degli
appuntamenti — fissare a voce vorrebbe dire mettervi in agenda call che il calendario non
ha. Se preferite l'altra strada, ditelo e ne parliamo con i numeri davanti.

## 4. `presented` e `sold` come stop assoluto: fatto, con una sola eccezione

In produzione da oggi. Il bot legge `lead-status` e **smette di scrivere** se
`presented: true`, se `sold: true` o se c'è una `discardReason`. Vale nei tre punti in cui
scrive da solo: le risposte in chat, i template della sequenza e il recupero delle mancate
risposte.

**L'eccezione, e vi chiediamo di confermarcela.** Sulle vostre 2.626 causali di scarto,
**881 dicono "irreperibile" o "irriperebile (3/4 tentativi vuoti)"**. Quello non è un
giudizio sul lead: è un telefono che non risponde — la stessa identica cosa dei "3 NR",
scritta in un altro campo. Fermarci lì spegnerebbe il bot esattamente dove vale di più,
sulle persone che al telefono non prendono e su WhatsApp rispondono al 98%. Quindi
**"irreperibile" non ferma il bot**, tutto il resto sì: non interessato (632), numero
inesistente (371), non ha soldi, straniero, solo informazioni.

Con questa distinzione le chat vive su cui il bot smette di lavorare sono **92**. Senza
l'eccezione sarebbero 119, e 27 di quelle sono persone irreperibili al telefono con una
conversazione aperta con noi. Se per voi "irreperibile" deve fermare comunque, ditecelo e
lo cambiamo in dieci minuti — ma vi chiediamo di pensarci, perché è la stessa
popolazione del recupero NR.

## 5. I 39 del "giorno e ora": d'accordo, e vi mandiamo gli esiti

Perfetto. Mandateceli quando volete: quelle conversazioni le riprendiamo da dove si erano
fermate, e adesso le date che chiedevano esistono.

Sull'esito lead per lead: **ci sta e lo facciamo**, ma sappiate che una parte ve la
diamo già — ogni lead che lavoriamo esce comunque con il suo esito, "no" compresi. Quello
che aggiungiamo è il **conto separato di questi 39**: quanti hanno risposto, quanti hanno
rifissato, quanti hanno detto no, quanti sono rimasti zitti. Ve lo mandiamo come numero
unico quando la coda è finita, così il dato è confrontabile con la prossima chiusura
d'agenda.

## 6. `e4ef3953`: rimandata, e accettata

Appena l'avete sbloccata l'abbiamo rimandata: **200**. Con questa le dodici sono tutte
dentro. Grazie per aver chiarito che il 403 non c'entrava con il record incoerente: e
grazie soprattutto per la scelta di non rifiutare mai più un `CONTATTO_UMANO` — è
l'esito che costa meno quando sbagliamo e che costa di più quando manca.

## Riassunto

**Fatto da parte nostra oggi:** lo stop su `presented`/`sold`/`discardReason` (con
l'eccezione "irreperibile"); la segnalazione del sì confermato che non è diventato un
appuntamento; Mehdi riagganciato; `e4ef3953` rimandata e accettata.

**Ammesso:** sull'agenda del 31 luglio avevamo torto. Erano nostri invii a mano da un
vostro CSV, non vostre chiamate.

**Ci serve da voi:**

1. **Conferma sull'eccezione "irreperibile"**: non ferma il bot, e vale 881 lead.
2. **I 39** quando volete, e vi torna il conto separato.
3. Un'occhiata al **doppio invio dell'agenda** del 30-31 luglio: se succede ancora, oggi
   che il canale automatico è acceso, quelle persone ricevono due agende.

A presto,
Bruno
