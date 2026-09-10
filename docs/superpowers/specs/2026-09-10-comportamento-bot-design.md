# Comportamento del bot: Noemi, appuntamento, fuori finestra — design

Data: 10/09/2026. Decisioni di Bruno raccolte in sessione, misure su settembre 2026
(66.255 messaggi, 2.567 conversazioni, 48.329 messaggi in uscita).

## Il problema, in una riga

Il bot perde lead in tre modi che sappiamo misurare: dice al lead di aspettare una telefonata
in un momento in cui chi deve chiamare non c'è, promette di passare informazioni che non passa,
e fissa call fuori dalle regole oppure molla il lead quando le regole non bastano.

## Cosa NON è in perimetro (verificato, non serve lavoro)

**La durata della call.** Il prompt dice già la cosa giusta (`lib/mario-prompt.ts:216`,
"videocall di 30/40 minuti"; riga 232, "sono 30/40 minuti in tutto"). Su 48.329 messaggi in
uscita di settembre, 1.139 dicono correttamente "30/40 minuti" e **uno solo** (conv 9595)
vende la call come breve: *"anche solo 10 minuti in call, ti costerebbe nulla"*. Il modello
obbedisce. Non tocchiamo niente qui; il presidio arriva di rimbalzo dal blocco Noemi (punto 1),
che separa esplicitamente le due durate.

**L'insistenza.** Decisione esplicita di Bruno: il bot **deve** insistere e fare il venditore al
100%. Anche se il suo lavoro è fissare appuntamenti e non vendere il corso, deve comunque
vendere *quell'appuntamento*, e farlo bene. Le 19 conversazioni con 2+ re-pitch dopo un no non
sono un difetto da correggere. Resta il solo limite non negoziabile: se il lead chiede di non
essere più contattato (opt-out esplicito), si smette — è rischio ban di piattaforma.

**Nota:** su `main` esistono oggi tre freni all'insistenza (`lib/mario-prompt.ts:337` "non
insistere più di 2 volte sulla stessa obiezione", più due nella sezione disdette e in SE RIMANDA
LA CALL). Contraddicono la volontà di Bruno ma **non sono in questo perimetro**: vanno guardati
insieme, come decisione a sé.

## Punto 1 — Noemi non è l'appuntamento, e si sa quando chiama

### La verità operativa

| | Chi | Durata | Cosa succede |
|---|---|---|---|
| **L'appuntamento** (l'unica cosa che il bot fissa) | il venditore / tutor / consulente | **30-40 min** | videocall: percorsi, pacchetti, quote, proposta |
| **La chiamata di Noemi** (conseguenza, non l'appuntamento) | Noemi, Conferme | **5-10 min** | preselezione: valuta se **confermare o no** l'appuntamento e chiarisce i dubbi sul video |

Noemi **inizia alle 13:00**. Le Conferme chiamano il **pomeriggio prima** per gli appuntamenti
del mattino e lo **stesso pomeriggio** per quelli del pomeriggio.

### Il difetto misurato

46 appuntamenti fissati prima delle 13:00. In **35 chat su 46 (76%)** il bot lasciava intendere
che Noemi chiamasse la stessa mattina. Caso peggiore, conv 8348: *"Noemi ti chiama a momenti"*
scritto alle 10:19 per una call delle 10:00, già iniziata. Gli appuntamenti del mattino **non
sono rotti per progetto** — Noemi li copre chiamando il pomeriggio prima. Il difetto sta solo in
quello che il bot racconta al lead, e produce lead che tengono il telefono nel momento sbagliato:
è una delle fonti del 51,3% di scarti per "3 NR consecutivi".

### Cosa deve fare il bot

1. Non chiamare mai Noemi "la consulente" o "la tutor", e non dire che con lei si vedono prezzi,
   rate o preventivi. Lei fa la preselezione.
2. Non usare mai "sono solo cinque minuti" per vendere **la call**. Quella leva vale solo per Noemi.
3. Dire al lead **quando** chiama Noemi, calcolandolo dall'ora dell'appuntamento confermato:
   - call **dalle 13:00 in poi** → chiama **lo stesso giorno, qualche ora prima**;
   - call **prima delle 13:00** → chiama **il pomeriggio del giorno prima**, mai la mattina stessa.
4. Dare la **finestra**, mai l'orario al minuto ("ti chiama alle 14 in punto" è un secondo
   appuntamento che poi non torna).
5. Frasi vietate, sempre: "ti chiama poco prima", "qualche minuto prima", "5 minuti prima",
   "prima di collegarti", "la mattina stessa", "a momenti", "a breve", "ti sta per chiamare".
6. Se giorno e ora non sono ancora noti, **non tirare a indovinare**: dire solo che lo chiama
   prima della call e aspettare la conferma.

La stessa regola vale nella nota che il bot manda ai GDO (`lib/gdo-context-note.ts`), che oggi si
calcola sull'invio dell'agenda e non sull'ora vera dell'appuntamento.

## Punto 2 — Il numero alternativo arriva alle Conferme

### Il difetto

Quando il lead dà un secondo recapito (*"se sulla rete ordinaria mi deve chiamare qui: 392..."*),
il bot risponde *"lo segno, avviso Noemi"* — e non succede niente. Il numero muore in chat e non
raggiunge nessuno. È una promessa a vuoto verso il lead e un recapito perso per chi telefona.

### La decisione

Il numero **va nelle note alle Conferme**. Il canale esiste già ed è vivo in produzione: l'outcome
**`NOTA`** del contratto bot→CRM (`lib/bot-contract.ts:66,98,218`), lo stesso usato per le disdette.
Non cambia lo stato del lead, non richiede data, e notifica subito le Conferme. **Nessun
allineamento col CRM necessario**: è contratto già accettato dal loro lato.

Quindi il bot **può** dire che lo passa, perché lo passerà davvero. Cambia anche la copy: sparisce
il rimbalzo al lead ("diglielo tu a Noemi").

## Punto 3 — Fuori dalla finestra non si fissa mai

### Il difetto

**32 call su 251** fissate fuori dalla finestra dei due giorni. Il prompt lo vietava già
(`lib/mario-prompt.ts:218`) ma il modello lo violava, e nessun controllo in codice lo fermava.
Un appuntamento fuori finestra è un appuntamento che l'agenda vera non regge.

### La regola dura

Fuori finestra **non si fissa mai**. La finestra è "domani + dopodomani", saltando domenica,
chiusure e giorni pieni (`lib/booking-slots.ts`). Oggi non è mai prenotabile. Oltre al prompt
serve una **guardia in codice**: un `[ESITO:APPUNTAMENTO|<data>]` con data fuori finestra non
diventa un appuntamento.

### Cosa fa il bot quando il lead non può

1. **Insiste dentro la finestra.** Non cede al primo no e non passa subito al secondo giorno:
   cerca il buco — un'altra fascia, presto la mattina, tardi la sera fino alle 21. È una call che
   può cambiargli il lavoro, il tempo si trova.
2. **Se davvero non può**, non fissa fuori e non lo perde. Gli dice la verità operativa e
   **nomina il giorno del ricontatto**: *"gli slot per giovedì li vedo solo martedì, ti scrivo io
   quel giorno e te lo fisso"*.
3. **Poi lo ricontatta davvero.** Questa è **l'unica eccezione autorizzata** alla regola "niente
   promesse di ricontatto" (nata da 54 promesse mai mantenute): qui l'impalcatura si costruisce.

### Il giorno del ricontatto si calcola, non si sceglie

È il **primo giorno in cui il giorno voluto dal lead entra nella finestra "domani + dopodomani"**.
Verificato contro `lib/booking-slots.ts`; i due esempi di Bruno tornano al giorno esatto:

| Oggi | Il lead vuole | Ricontatto | Come |
|---|---|---|---|
| gio 10 | **lun 14** | **ven 11** (domani) | messaggio libero — dentro le 24h WhatsApp |
| gio 10 | **gio 17** | **mar 15** | template — le 24h sono scadute |

La domenica non conta come giorno prenotabile, quindi da venerdì 11 la finestra è "sab 12 + lun 14".

### Il confine: 7 giorni

Entro **7 giorni** dal giorno voluto, il lead resta al bot con questo meccanismo. Oltre, torna al
CRM come `[ESITO:RICHIAMO|...]` e lo lavora un umano, come oggi. Decisione di Bruno.

### Il template

**Uno solo, generico**, buono a qualunque distanza e qualunque giorno della settimana. Serve
perché a più di 24h dall'ultimo messaggio del lead il free-text è vietato da WhatsApp. Bozza
approvata da Bruno:

> Ciao {{1}}, sono Marta di Fenice Academy. Come concordato insieme ti scrivo per fissare
> l'appuntamento che qualche giorno fa non abbiamo preso per mancanza di orari disponibili:
> adesso ho disponibilità in linea con le tue esigenze. Ti interessa ancora?

Categoria **UTILITY** (il numero Fenice è a qualità LOW e l'app presidia la categoria sugli invii:
vedi `project_qualita_numero_utility_only`). Il lead risponde → si riapre la finestra 24h → il bot
riprende in free-text:
- **sì** → propone subito l'orario preciso che aveva chiesto lui;
- **no** → riprende il suo need e spinge per fissare lo stesso (vedi "L'insistenza" sopra).

**Prima di spedire** il codice deve verificare che il giorno voluto sia ancora prenotabile (non
pieno, non chiuso, non domenica): il template promette disponibilità, e prometterla a vuoto ci
gioca il lead una seconda volta. Se non è più prenotabile, il ricontatto parte comunque ma senza
promettere quel giorno.

### Allineamento col CRM

Questo punto **cambia chi lavora i lead**: conversazioni che oggi tornerebbero al CRM come
`RICHIAMO` restano al bot fino a 7 giorni. Per la regola di Bruno
(`feedback_niente_modifiche_senza_ok_crm`) va allineato con l'altro terminale **prima del deploy**.

## Sequenza di rilascio

1. **Lotto A — comportamento in chat** (punti 1, 2, e la regola dura + guardia del punto 3).
   Prompt, tag, guardia in codice, nota GDO. Nessuna migration, nessun template, nessun
   allineamento CRM. Si può rilasciare da solo.
2. **Lotto B — il ricontatto fuori finestra** (l'impalcatura del punto 3). Migration, cron,
   template Meta, allineamento CRM. Il template va sottomesso subito: l'approvazione è di giorni.

## Vincoli globali

- Prompt in `lib/mario-prompt.ts`: è una template literal e **un blocco su riga fisica unica
  arriva come UNA bolla WhatsApp**. `splitMarioMessages` spezza solo sui `\n` reali. C'è un test a
  soglia di parole per riga: rispettarlo.
- Le date del DB sono `timestamptz` (UTC), quelle dei tag del modello hanno offset locale: mai
  confrontarle come stringhe, usare `sameInstant` (`lib/rome-time.ts`).
- Le note leggibili da umani vanno scritte in ora di Roma (`formatRomeDateTime`).
- I tag non devono **mai** essere visibili al lead: vanno rimossi dal testo in `parseMarioReply`.
- Migration **prima** del deploy (`project_pannello_chat`).
- `main` si aggiorna al **push** su `origin/main`, non al merge (`project_deploy_push_non_automatico`).

## Lotto A — completato

Completato il 2026-09-10. Verifica finale (Task 6) eseguita su `feat/comportamento-bot-settembre`:
suite completa verde (1228 test, typecheck pulito; lint ha solo errori `no-explicit-any`
preesistenti fuori perimetro, vedi report di Task 6), e i tre casi reali che hanno motivato il
lotto (conv 8348, conv 9595, call proposta a 4 giorni) verificati a mano contro `lib/mario-prompt.ts`
e `lib/bot-outcome-rules.ts`.

Commit del branch (`git log --oneline main..HEAD`, dal più recente):

```
151a726 fix(prompt): correggi 'cambiarti' in 'cambiargli' nel testo della finestra
18a20ed fix(prompt): la finestra dei due giorni non si scavalca, si lavora dentro
f42cc62 fix(gdo): la nota su Noemi si calcola dall'ora dell'appuntamento
037bd51 fix(prompt): quando chiama Noemi dipende dall'ora della call
adba810 test(bot): copertura end-to-end per nota + esito nello stesso turno
5c98fc8 feat(bot): il secondo numero del lead arriva davvero alle Conferme
caa5436 docs: correggo il test di T4 che avrebbe bocciato l'implementazione giusta
b7e4785 fix(bot): fuori dai due giorni non e' un appuntamento, e' una nota
0936a27 docs: spec e piano del lotto A sul comportamento del bot
```
