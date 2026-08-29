# Risposta al team CRM — la regola, e l'elenco di cosa è vivo — 29/08/2026

*Ultimo messaggio del giro. Accetta la regola senza riserve, elenca tutto quello che è
andato in produzione oggi, e ritira la raccomandazione sulla finestra del form.*

---

Ciao,

la regola è giusta e la accettiamo così com'è scritta, senza distinguo.

**Da adesso: niente che arrivi a un lead — un messaggio, un template, un orario, una
frequenza, una regola su chi viene contattato, un lotto rilavorato — va in produzione
senza il vostro sì scritto prima.** Quello che sta dentro casa nostra resta nostro; la
linea "se lo vede un lead, o se cambia quali lead vengono toccati, lo approvate voi" è
chiara e non ha bisogno di essere interpretata.

E avete ragione sul punto che conta: quel messaggio ai sei clienti non l'ha fermato un
controllo, l'ha fermato una coincidenza. Una cosa che va bene per fortuna non è una cosa
che va bene.

## 1. Tutto quello che abbiamo messo in produzione oggi

Elenco completo, in ordine di quando è andato su. La colonna che conta è l'ultima.

| # | Cosa | Ora | Arriva a un lead? |
|---|---|---|---|
| 1 | `CONTATTO_UMANO` su qualsiasi risposta dopo il messaggio del 3° NR (`risposta_dopo_terzo_nr`) | 12:58 | **No** — è una segnalazione a voi |
| 2 | Lettura del blocco `contattoUmano` da `lead-status` (+ colonne nuove da noi) | 12:58 | **No** — sola lettura |
| 3 | `personKey` e `previousLeadIds` letti nell'intake, risposta con `leadIdCorrente` | 12:58 | **No** — cambia solo il corpo della nostra risposta HTTP |
| 4 | L'intake risponde `accettato:false` + `motivo` quando scarta un lead | 12:58 | **No** — idem |
| 5 | Stop del bot su `presented` / `sold` / `discardReason` | 13:49 | **No**: toglie messaggi, non ne aggiunge |
| 6 | Il classificatore riconosce il "sì confermato" → `CONTATTO_UMANO` | 13:53 | **No** — segnalazione a voi |
| 7 | `/api/send-template` accetta variabili e numero mittente | 14:00 | **Solo se lo chiamiamo a mano** (oggi: solo Mehdi) |
| 8 | Distinzione fra scrivere per primi e rispondere, + passaggio a una persona per clienti e presentati | 15:53 | **No**: toglie messaggi. Il passaggio è una segnalazione |
| 9 | `motivo` corretto in `conferma_senza_appuntamento` | 15:48 | **No** — è una stringa nel payload verso di voi |

**Non c'è un decimo punto.** Non abbiamo toccato: le giornate e gli orari che il bot
propone, il testo dei messaggi, i template, la sequenza, gli orari di invio, il numero
mittente, né chi entra nel flusso.

**Alla vostra domanda 2 — se qualcosa di acceso può far partire un messaggio verso una
popolazione non concordata — la risposta è no**, e per una ragione strutturale, non per
fiducia: le cose accese oggi o parlano solo con voi (1, 2, 3, 4, 6, 9), o **riducono** chi
il bot contatta (5, 8). L'unica che può far uscire un messaggio è la 7, ed è un endpoint
che non parte da solo: qualcuno deve chiamarlo, come abbiamo fatto per Mehdi dopo il
vostro sì. Non c'è niente da mettere in pausa, e se ci fosse ve lo diremmo qui invece di
aspettare che lo chiediate.

**Messaggi partiti oggi verso persone, per nostra iniziativa e fuori dal flusso normale:
uno.** Mehdi, alle 14:02, dopo il vostro via libera scritto.

## 2. Le 12 segnalazioni: l'ora esatta, per togliere l'ambiguità

Avete ragione che «partite mentre scrivevamo» non è una risposta. Ecco i minuti:

- **11 segnalazioni fra le 13:21:43 e le 13:23**, cioè **dopo** il vostro «sì,
  mandateceli» scritto nel vostro terzo messaggio;
- **la dodicesima (`e4ef3953`) alle 13:49:39**, dopo che ci avevate scritto di aver tolto
  la guardia.

Nessuna delle due è partita prima del vostro sì. Ma il punto vostro resta valido lo
stesso: la frase che abbiamo usato non permetteva di verificarlo, e da oggi quando una
cosa parte vi diciamo l'ora, non "nel frattempo".

## 3. Le code: ferme, e restano ferme

- **Gli otto**: fermi. Nessun messaggio, e non ne partiranno. Mehdi era l'unico approvato
  ed è già partito.
- **I 39 del "giorno e ora"**: aspettiamo il vostro invio. **Non li ricostruiamo da parte
  nostra** — abbiamo la lista, e resta ferma dov'è.
- **Gli irreperibili**: nessun riaggancio, né ora né dopo, finché non ce lo dite voi. Il
  test dei 500 è in stand-by e non lo tocchiamo.

## 4. Il form: ritiriamo quello che vi avevamo raccomandato

Questa è la parte in cui avevamo torto, e non era un dettaglio.

**Vi abbiamo scritto "allargate la finestra" senza avere il dato per dirlo.** Voi ce
l'avete: più una call è lontana, meno gente si presenta — e il 17,1% di presenza che ci
avete dato è misurato **con** la finestra di adesso. Allargarla poteva benissimo
peggiorare la cosa che conta (le call fatte) migliorando quella che si vede (le call
fissate). Non era una nostra decisione da suggerire, e la ritiriamo.

**Resta un difetto vero, che non c'entra con quanto è larga la finestra:**

> La freccia **"giorno successivo"** del form non avanza di un giorno: dopo il 1°
> settembre porta al 1° ottobre, poi al 1° novembre, poi al 1° dicembre, tutti vuoti.

Quello vale la pena guardarlo qualunque cosa decidiate sulla finestra, perché non offre
niente di nuovo al lead: lo porta solo in un posto vuoto da cui non sa tornare. Ed è
letteralmente la frase del vostro lead, *«mi manda a 1 settembre»*.

## 5. Non adattiamo niente in anticipo

Preso, e vale già adesso: **non cambiamo le giornate che il bot propone, né gli orari, né
la formula con cui le annuncia.** Restano quelle di oggi finché non ci scrivete voi che
cambia qualcosa, con la data. Se la finestra resta stretta va bene così: il nostro lavoro
è portarvi lead che si presentano, non riempirvi l'agenda.

---

Sul metodo, l'ultima cosa. Quello che ci contestate è vero e non lo giriamo: oggi abbiamo
messo in produzione roba nostra e ve l'abbiamo raccontata dopo. Il fatto che quasi tutta
fosse innocua non c'entra — nessuno di noi due poteva saperlo prima. D'ora in avanti
funziona come Mehdi: prima ve lo diciamo, poi si fa.

Aspettiamo voi sul form. Per il resto, da parte nostra è tutto chiuso.

A presto,
Bruno
