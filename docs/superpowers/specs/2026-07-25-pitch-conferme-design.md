# Pitch, conferme e reminder pre-call — design (25/07/2026)

Obiettivo: alzare il tasso di conferma degli appuntamenti (oggi: fissato 8,1%, ma una
quota rilevante non arriva alla call) e la conversione pitch→appuntamento (~8%, 25 lead
al pitch → 2 presi, analisi `2026-06-25-analisi-perdite-pitch.md`). È il complemento
"copy" della sequenza estesa: la meccanica porta i restituiti da 79,6% a ~58%, il resto
del gap verso ≤50% lo chiude il contenuto della conversazione.

Contesto: [[project-sequenza-estesa-restituzioni]], [[project-apertura-marta-ab]].

## Decisioni prese con Bruno (25/07)

1. **Nome**: negli invii solo il nome proprio, mai nome+cognome. FATTO, branch
   `fix/solo-nome-proprio` (fuori da questo documento).
2. **Prezzo**: si dice sempre la cifra intera (1.000–3.000 € a seconda del percorso) e
   si dice che è rateizzabile, **senza mai citare cifre di rata né numero di rate**.
   Motivo: le rateizzazioni hanno interessi e condizioni variabili, un numero detto in
   chat diventa una promessa che la call deve smentire.
3. **Niente analogie di frazionamento** ("come un caffè", "meno di un pacchetto di
   sigarette"). Vietate esplicitamente nel prompt.
4. **La leva sull'investimento è la situazione del lead**, espressa con le sue parole, e
   il conto lo fa lui: mai minimizzare la spesa al posto suo.
5. **Video e Noemi vanno anticipati** prima del fissaggio, come "come funziona da qui in
   poi", e ogni passaggio chiede una risposta invece di informare e basta.
6. **Reminder pre-call multi-touch** al posto del silenzio attuale tra fissaggio e call.

## Evidenze a supporto

- Dire il prezzo presto migliora la qualità dei lead e la spesa a valle
  (McCombs, *Sellers Who Disclose Prices Can Maximize Profits*) → la regola "prezzi
  prima dell'appuntamento" resta.
- Giustificare o scontare il prezzo **prima** dell'obiezione abbassa il valore percepito
  (pricefx, *10 Sales Signals That Can Expose Your Pricing Weaknesses*) → la rata non si
  offre spontaneamente.
- Il temporal reframing (Gourville, *Pennies-a-Day*, JCR 1998: 52% vs 30%) si **rovescia**
  quando la base è grande, e l'effetto positivo è annullato dalla sensazione di essere
  manipolati (Bambauer-Sachse & Grewal) → niente analogie, e comunque niente cifre.
- Il linguaggio controllante ("devi", "non è facoltativo") genera reattanza psicologica e
  **riduce** la compliance rispetto al framing autonomy-supportive (Miller et al.).
- Far scrivere al paziente il proprio appuntamento riduce i mancati appuntamenti del
  **18%** (Martin, Bassi & Dunbar-Rees); chiedere e attendere un "sì" esplicito invece di
  informare abbatte i no-show (Cialdini, caso ristorante); conferma verbale breve ≈ +20%
  di partecipazione.
- La telefonata di conferma da sola ha prodotto **−62%** di appuntamenti saltati in uno
  studio controllato (pediatric dental clinic, PubMed 11800450); reminder multi-touch
  (conferma + 24h + same-day) battono il singolo reminder; reminder + intake digitale
  danno −25/−40%.
- I playbook high-ticket fanno **confermare esplicitamente** la visione del video pre-call;
  chi interagisce prima della call ha ~3x di probabilità di presentarsi.

## Vincoli

- **Persona parametrica**: `buildMarioSystem(personaName)` deve restare tale che
  `buildMarioSystem('Marta').replace(/Marta/g,'Mario') === buildMarioSystem('Mario')`
  (test esistente in `lib/mario-prompt.test.ts`). Nessun testo nuovo può contenere
  "Mario" o "Marta" hardcoded.
- **Stile**: regole tassative già nel prompt — niente trattini lunghi o corti come
  separatore, max 20-25 parole per messaggio, una sola domanda, niente punto fermo
  finale, niente liste.
- **Onestà**: nessuna manipolazione, nessuna promessa non verificabile, l'IA non si
  spaccia per umana (regola utente [[feedback-no-manipulation-or-human-impersonation]]).
- **WhatsApp**: free-form solo entro 24h dall'ultimo inbound; fuori finestra solo
  template approvati. Cap Meta ~2 template MARKETING per utente/24h → i reminder
  appuntamento vanno creati in categoria **UTILITY**.
- **Stato conversazione**: dopo `[ESITO:APPUNTAMENTO|data]` con callback CRM riuscita la
  conversazione va in `ai_status='closed'` (`lib/fenice-autoreply.ts:189`). Il webhook la
  riapre al primo inbound del lead. APPUNTAMENTO è terminale: nessun esito successivo
  declassa (`lib/bot-outcome.ts`).

## Copy — pitch (FASE 5)

> Fenice ha percorsi davvero completi, ti riassumo in due parole e poi ne parliamo con
> calma in una call ok? Sono fatti di tre cose: teoria, pratica e collegamento al lavoro.
> Le lezioni le guardi quando e dove vuoi, lo stage lo fai da remoto con orari flessibili,
> e a fine corso garantiamo a contratto due colloqui di lavoro con aziende nostre partner.
> La quota va dai 1.000 ai 3.000 euro a seconda del percorso, e si può rateizzare:
> sull'aspetto economico troviamo una soluzione praticamente con tutti. Ma la cosa più
> importante è prima capire se fa davvero per te.

## Copy — regola prezzi (REGOLE ASSOLUTE)

> PREZZI OBBLIGATORI: prima di proporre l'appuntamento DEVI aver comunicato la quota
> almeno una volta, cioè "la quota va dai 1.000 ai 3.000 euro a seconda del percorso, e
> si può rateizzare". Subito dopo averla detta proponi la call nello stesso giro di
> messaggi, senza aspettare che il lead reagisca al prezzo.
>
> MAI CIFRE DI RATA: non dire MAI quanto viene al mese, né quante rate sono, né fare
> paragoni tipo "è come un caffè al giorno" o "meno di un pacchetto di sigarette". Le
> rateizzazioni hanno interessi e condizioni diverse caso per caso: un numero detto qui
> diventa una promessa che poi la call deve smentire. Se il lead chiede quanto viene al
> mese, rispondi onesto che dipende da come si imposta e che in call glielo calcolano
> preciso, es. "dipende da come la imposti, non voglio spararti un numero a caso, in call
> te lo fanno vedere esatto".

## Copy — obiezione prezzo (GESTIONE OBIEZIONI)

> "Costa troppo / non me lo posso permettere" → 1) valida senza difenderti: "eh lo so, è
> un investimento, ci sta". 2) riporta al SUO obiettivo con le SUE parole e lascia fare
> il conto a lui: "tu mi hai detto che [obiettivo suo], quanto vale per te arrivarci?".
> 3) ancora al fatto che sull'aspetto economico si trova una soluzione praticamente con
> tutti e che lo vedono insieme in call. Non minimizzare MAI la spesa al posto suo: vietate
> frasi come "è solo", "è poco", "è un piccolo sacrificio". Il conto lo deve fare lui.

## Copy — anticipo di come funziona (FASE 6, prima del link)

Quando il lead accetta la call, PRIMA di mandare il link:

> Perfetto. Prima di fissare ti dico come funziona, sono due cose veloci.
> Prima della call ti chiama Noemi, una collega, per una preselezione di pochi minuti.
> E c'è un video di 20 minuti da vedere prima, con le professioni, i pacchetti e le quote,
> così in call si parte dal tuo caso e non dalle basi.
> Ti torna?

Aspetta il sì, poi manda il link JotForm.

## Copy — conferma post-appuntamento (dopo che il lead scrive "Noemi")

Quattro passaggi, ognuno chiede una risposta:

1. Ripetizione attiva (l'intervento con l'evidenza più forte, −18%):
   > Perfetto, allora ci siamo. Confermami tu giorno e ora della call come li hai scelti,
   > così sono sicuro che siamo allineati
2. Noemi, senza minaccia, con la ragione:
   > Noemi è la collega della preselezione, ti chiama prima della call: è il passaggio
   > che conferma l'appuntamento, quindi tieni il telefono a portata.
   > Se ti scappa la chiamata non è un problema, richiamala pure allo stesso numero
3. Video, con scelta attiva al posto dell'obbligo:
   > [link video giusto in base alla situazione del lead]
   >
   > Qui dentro ci sono le professioni, i pacchetti e le quote di investimento. Sono 20
   > minuti e servono perché in call partiamo dal tuo caso invece che dalle basi.
   > Quando riesci a vederlo, stasera o domani?
4. Micro-impegno finale, misurabile:
   > Perfetto. Scrivimi FATTO qui quando l'hai visto, così lo segno

## Copy — comportamento a appuntamento già fissato

Nuova sezione del prompt, per quando la conversazione riapre dopo il fissaggio:

> SE L'APPUNTAMENTO È GIÀ FISSATO (hai già mandato Noemi e il video): non ripartire col
> pitch e non riproporre la call. Se il lead conferma di aver visto il video (es. "fatto",
> "visto", "l'ho guardato"), ringrazia in una riga e chiudi il messaggio con [VIDEO_VISTO].
> Se vuole spostare o disdire, non gestirlo da solo: rispondi che lo fai sistemare da un
> collega e usa [PASSAGGIO_UMANO]. Se fa una domanda sul percorso, rispondi breve e
> rimanda alla call.

`[VIDEO_VISTO]` viene rimosso dal testo visibile e loggato come evento: è la metrica di
"pre-frame completato" da incrociare col tasso di presenza.

## Reminder pre-call (sottosistema separato)

Oggi tra il fissaggio e la call non parte nulla (l'unico follow-up esistente è a 2h sul
link JotForm, `lib/agenda-followup.ts`). Si aggiunge un cron dedicato:

- Target: conversazioni con `bot_outcome='APPUNTAMENTO'` e `bot_scheduled_at` futuro.
- **R1 a T−24h**, **R2 a T−3h** (clampato: mai prima delle 08:30 Rome; se T−3h cade prima,
  si invia alle 08:30 dello stesso giorno).
- Sempre via **template UTILITY** (non free-form): rende l'invio possibile fuori finestra
  24h, non consuma il budget MARKETING, e rende l'idempotenza derivabile dai `messages`
  (stesso pattern della sequenza: template_sid già presente sulla conversazione → salta).
- Variabili: `{{1}}` nome proprio, `{{2}}` giorno e ora in chiaro (es. "domani alle 15:00").
- Entrambi chiedono una risposta (conferma esplicita), che è il punto: il reminder che
  non chiede niente vale molto meno di quello che chiede.
- Le risposte arrivano su conversazione chiusa/riaperta: le gestisce la sezione
  "appuntamento già fissato" del prompt.

Testi template (da approvare, categoria UTILITY):

- `fenice_reminder_24h_v1`:
  > Ciao {{1}}, ti ricordo la videocall di {{2}}. Hai già visto il video che ti ho mandato?
  > Fammi sapere qui, così arriviamo pronti.
- `fenice_reminder_3h_v1`:
  > Ciao {{1}}, ci sentiamo tra poco, {{2}}. Confermi che ci sei?

## Fuori scope

- Modifiche alla telefonata di Noemi e al suo script (fuori dal software).
- Verifica del profilo business Meta e typing indicator (task separati già in coda).
- Dashboard restituzioni in /fenice.
- Il cron legacy `send-video` (agganciato a `AGENDA_TEMPLATE_SID`, fermo dal 19/06) resta
  com'è: non viene toccato né rimosso in questo lavoro.

## Definition of done

- Pitch e conferme: prompt aggiornato, test verdi, nessuna cifra di rata pronunciabile,
  parametricità persona intatta.
- `[VIDEO_VISTO]` loggato e conteggiabile.
- Reminder: 2 template approvati, cron attivo, idempotente, con kill-switch env.
- Misura a 30 giorni sulla coorte post-modifica: quota di appuntamenti che arrivano alla
  call, confrontata con il periodo precedente alla data di stacco.
