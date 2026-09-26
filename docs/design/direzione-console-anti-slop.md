# Direzione grafica della console del bot (26/09/2026)

Punto di partenza, verificato in `Software Messaggistica` (sola lettura): `components.json` ha `baseColor: "zinc"` (K1), `--primary: oklch(0.205 0 0)` è quello di shadcn (K1), `--radius: 0.625rem` è quello di default (K8), i font sono Geist e Bricolage (T4), e nel tema scuro `--sidebar-primary` è un indaco `oklch(0.488 0.243 264)` (C2). Oggi la console è shadcn con un filo di arancio sopra.

## 1. Venticinque regole verificabili

| # | Regola | Come si verifica |
|---|---|---|
| 1 | Nessun token shadcn di default | `detect.mjs` senza K1, K8 e T4; in `globals.css` nessun `oklch(0.205 0 0)` e nessun `0.625rem` |
| 2 | Un solo accento, usato per tre cose: selezione, focus e azione primaria | cercando il token dell'accento, compare solo in quei tre ruoli; su uno screenshot della lista senza non letti, l'accento appare al massimo 2 volte |
| 3 | Il caldo segnala un problema: rosso e ambra solo per errore e attesa | lo screenshot della vista "tutto ok" non ha pixel rossi né ambra |
| 4 | Uno stato non si comunica mai solo col colore | ogni badge ha del testo; lo screenshot in scala di grigi resta leggibile |
| 5 | Testo secondario con contrasto ≥ 4,5:1 | per il testo si usa `sand-11` (5,93:1 su `sand-1`); `sand-9` e `sand-10` (3,3 e 3,8) solo per bordi e icone disattivate |
| 6 | Niente Inter, Geist o Bricolage | cercando `Geist\|Inter\|Bricolage` non trovi niente; `detect.mjs` senza T1, T2 e T4 |
| 7 | Il mono solo per dati che si copiano o si confrontano: telefono, ID lead, SID Twilio, codici errore, orari dei log | ogni `font-mono` si trova su un valore, mai su un'etichetta (SD4m) |
| 8 | `tabular-nums` su contatori, orari e KPI | quando arriva una chat, i contatori della sidebar non spostano il layout |
| 9 | Scala tipografica 12/13/14/16/20, pesi 400/500/600 | nessun `text-[..px]` arbitrario; nessun `font-bold`, `font-light` o `font-black` |
| 10 | Il peso del testo non cambia su hover o selezione (cambia solo per non letto, che è un dato) | nessun `hover:font-*`, `aria-selected:font-*` o `data-[state=active]:font-*` |
| 11 | Niente maiuscoletto, eyebrow o 01/02/03 | nessun `uppercase` o `tracking-wide*`; `detect.mjs` senza SD4 e SD6 |
| 12 | Le righe non stanno in card e le card non si annidano | nessun `<Card` dentro liste, thread o pannelli; al massimo un livello di contenitori |
| 13 | Ombre solo su ciò che galleggia (popover, menu, palette, toast), sempre a due strati | `shadow-*` compare solo in `ui/popover`, `dropdown-menu`, `command` e `sonner`; nessun K2 |
| 14 | Nessuna striscia colorata laterale; la selezione è uno sfondo | nessun `border-l-[2-9]`; nessun K4 |
| 15 | Niente vetro, gradienti o bagliori | cercando `backdrop-blur\|bg-gradient\|bg-clip-text` non trovi niente; nessun C1, C5, C6 o K3 |
| 16 | Solo icone lucide, 16 px, un solo `strokeWidth` (1,75); mai Sparkles, Zap, Rocket o Wand; niente emoji nell'interfaccia | nessun I2; I3 può segnalare soltanto `Check`, che per le spunte è voluto |
| 17 | Densità: riga chat 56 px, riga di log o tabella 32 px, spazi su una scala da 4 | a 1440×900 la lista mostra almeno 12 chat e la vista Avvisi almeno 18 righe |
| 18 | Le azioni frequenti non si animano: aprire una chat, `j`/`k`, cambiare vista, `Ctrl+K` | registrando lo schermo, il cambio di chat avviene nel frame successivo |
| 19 | Le altre animazioni durano ≤ 200 ms, `cubic-bezier(0.23,1,0.32,1)`, animano solo `transform` e `opacity`, mai da `scale(0)` | nessun `transition-all`, `animate-bounce` o `animate-pulse`; esiste una regola globale per `prefers-reduced-motion` (M6) |
| 20 | Ogni vista ha disegnati gli stati vuoto, caricamento ed errore | nel codice ci sono i rami `isEmpty`, `isError` e `isLoading`; lo skeleton ha la forma esatta della riga, compare dopo 200 ms e resta almeno 400 ms |
| 21 | Il microcopy parla la lingua del lavoro: frasi normali, verbi, `…` se l'azione apre altro | nessun "Qualcosa è andato storto", "Invia" generico o "Scopri di più"; i toast riprendono il verbo del bottone ("Rinvia esiti" → "Esiti rinviati") |
| 22 | L'URL è lo stato: vista, chat aperta, filtro e scheda | dopo un refresh sei nello stesso punto; i filtri usano nuqs, non `useState` |
| 23 | Tastiera completa e focus visibile | con Tab si attraversa tutto; l'anello di focus è di 2 px nel colore dell'accento, con `:focus-visible`; `Esc` chiude qualsiasi pannello |
| 24 | Anche le superfici del browser prendono il tema | in `globals.css` ci sono `::selection`, `scrollbar-color`, `caret-color`, `color-scheme` e il meta `theme-color` |
| 25 | Le liste lunghe sono virtualizzate | con 5.000 chat finte lo scroll non scatta (verifica nel pannello Performance); la lista usa virtua |

## 2. Due direzioni visive

### A. "Registro" (la consiglio)

- **Font**: Atkinson Hyperlegible Next per il testo e Atkinson Hyperlegible Mono per i dati. Licenza OFL, entrambi su Google Fonts, quindi si caricano con `next/font/google`. Ho verificato che il font ha la feature `tnum`. È disegnato dal Braille Institute per distinguere 0/O e 1/l/I, e qui conta: i numeri di telefono e gli ID si leggono tutto il giorno.
- **Neutri**: la scala Radix `sand`.
  - Chiaro: 1 `#fdfdfc`, 2 `#f9f9f8`, 3 `#f1f0ef`, 4 `#e9e8e6`, 6 `#dad9d6`, 11 `#63635e`, 12 `#21201c`.
  - Scuro: 1 `#111110`, 2 `#191918`, 3 `#222221`, 6 `#3b3a37`, 11 `#b5b3ad`, 12 `#eeeeec`.
- **Accento**: blu inchiostro.
  - Chiaro: `#1364b0` (oklch 0.50 0.14 252). Il bianco sopra dà 6,0:1; come testo su `sand-1` dà 5,9:1.
  - Scuro: `#6ab1f3`. Il testo in `#111110` sopra dà 8,3:1.
  - La tinta HSL è 209°, fuori dalla fascia viola e indaco del tell C2.
- **Ember**: non lo userei come accento. Resta nel marchio della sidebar (16 px) e come indicatore della "modalità lancio".
- **Raggi**: 6 px per i controlli, 8 px per popover e palette, 0 per le righe.
- **Densità**: testo base 13/20. Chat 56 px, log 32 px.
- **Ombre**: solo sugli elementi che galleggiano, `0 1px 2px rgb(33 32 28/.06), 0 8px 24px -8px rgb(33 32 28/.18)` più un bordo `sand-6`. Nel tema scuro niente ombre: si usa il gradino di superficie `sand-3` con bordo `sand-6`.
- **Pro nelle 8 ore**: sfondo chiaro in ufficio e neutri appena caldi, che non affaticano. Il blu non si confonde con nessun segnale.
- **Pro nel lancio**: le uniche cose calde sullo schermo sono i problemi, quindi l'occhio va dritto a rosso e ambra anche tra migliaia di chat.
- **Contro**: il blu ha poca personalità, e l'identità deve venire da tipografia e densità. Atkinson è largo: a 13 px le anteprime si troncano prima, va provato su anteprime reali a 13 e a 14 px.

### B. "Turno"

- **Font**: IBM Plex Sans, più IBM Plex Sans Condensed per log e tabelle, più IBM Plex Mono. Licenza OFL, tutti su Google Fonts. Il file di Google non dichiara `tnum`: nel render va controllato che le cifre abbiano davvero larghezza fissa.
- **Neutri**: la scala Radix `slate`, fredda, così da staccarsi dall'arancio.
  - Chiaro: 1 `#fcfcfd`, 3 `#f0f0f3`, 6 `#d9d9e0`, 11 `#60646c`, 12 `#1c2024`.
  - Scuro: 2 `#18191b` (sfondo; non `#111`), 3 `#212225`, 6 `#363a3f`, 11 `#b0b4ba`.
- **Accento**: ember, corretto.
  - Chiaro: `#ca3c00` (oklch 0.56 0.19 40), bianco sopra 5,05:1. L'ember attuale `#e34d00` (oklch 0.62 0.2 42) col bianco dà solo 3,94:1, quindi fallisce AA sui bottoni.
  - Scuro: `#f67f2f`, testo `#111110` sopra 7,2:1.
- **Raggi**: 4 px per i controlli, 6 px per i popover.
- **Densità**: riga chat 48 px, log 28 px in Condensed.
- **Ombre**: nel chiaro nessuna, bastano i bordi `slate-7`. Nel lancio serale si usa lo scuro.
- **Pro**: è coerente col marchio del CRM Fenice. Plex Condensed fa stare più colonne nei log, e lo scuro regge bene il webinar delle 21.
- **Contro**:
  - Il bottone primario arancio compete con ambra e rosso proprio quando gli avvisi contano di più. Per evitarlo bisognerebbe spostare "attesa" su un neutro con icona e usare un rosso più freddo (Radix `crimson`).
  - Rischia i tell SD2 (quasi nero con vermiglio) e SD1 (lo scanner classifica `#e34d00` come terracotta).
  - Plex è molto usato nelle interfacce "tecniche".

**Consiglio A.** È una console di triage: il canale dei colori caldi va lasciato ai problemi. Ember resta come firma e non come comando.

## 3. Pattern

**Sidebar con le viste (220 px, sfondo `sand-2`)**
- Gruppi senza intestazioni in maiuscolo:
  - Mario: Da leggere, Serve operatore, Appuntamenti presi, Tutte.
  - GDO: Consegne fallite, Tutte.
  - Lancio 5/10: Domande aperte, Iscritti, Tutte.
  - Sistema: Avvisi, Cron, Assistente.
- Contatori allineati a destra, `tabular-nums`, in `sand-11`, sempre esatti ("1.284").
- Solo "Serve operatore" e "Avvisi aperti" diventano rossi quando sono sopra zero.
- Ogni vista è un URL.

**Riga chat**
- Griglia `1fr auto`, due linee:
  - Prima linea: nome a 14 px, peso 500, o 600 se non letto; ora a destra a 12 px in `tabular-nums`.
  - Seconda linea: anteprima a 13 px, in `sand-11`, o `sand-12` se non letta, con il prefisso "Mario:", "Tu:" o "GDO 105:".
- Al massimo un badge di testo, che è ad alto contrasto solo per "Serve operatore".
- Il canale lo indica la vista, non un chip su ogni riga.
- Hover in `sand-3`, selezione in `sand-4`, puntino non letto da 8 px nell'accento.

**Thread**
- Colonna larga al massimo 640 px.
- Bolle:
  - Lead: a sinistra, sfondo `sand-3`.
  - Mario: a destra, sfondo `sand-1` con bordo `sand-6` ed etichetta "Mario" sul primo messaggio del gruppo.
  - Operatore umano: a destra, con una tinta leggera dell'accento ed etichetta col suo nome.
- Nelle chat GDO, dove il bot fa da postino, i messaggi inoltrati hanno la riga "Inoltrato da GDO 105".
- Gli eventi di sistema (esito inviato al CRM, template, passaggio a operatore) sono righe centrate a 12 px con l'ID in mono, non bolle.
- Un invio fallito mostra l'icona rossa, il codice Twilio in mono e "Riprova invio" nella riga stessa.
- Il composer mostra "Finestra 24h: chiude alle 18:42" e diventa "Solo template" quando la finestra è chiusa. Si invia con `Ctrl+Invio`, i template si aprono con `/`.

**Pannello lead (320 px, si chiude con `]`)**
- Una `dl` a due colonne (etichetta a 12 px in `sand-11`, valore a 13 px), senza card.
- Voci: Telefono (mono, si copia con una spunta nella riga), Numero WA di partenza (0047 o 3199), Stato CRM, Esito bot, GDO assegnato.
- Azioni: "Metti in pausa Mario", "Ridai al bot", "Apri nel CRM".
- Sotto, lo storico eventi compresso.

**Pannello avvisi**
- Raggruppato per causa: Twilio 63016, invio esiti al CRM, cron. Ogni gruppo mostra conteggio, prima e ultima occorrenza e si espande nelle singole righe.
- Azioni per gruppo:
  - **Riprova** (primario): la conferma è nella riga e porta il numero, "Rinvia 38 esiti al CRM". Non serve un modale.
  - **Prova a vuoto**: apre un pannello col payload e con la scritta "Nessun invio reale".
  - **Segna risolto**: con una nota.
- Durante l'invio: "Invio… 12/38".
- L'esito resta scritto nella riga ("36 inviati, 2 falliti", e i falliti si aprono); non è solo un toast.

**Command palette**
- Si apre con `Ctrl+K` (cmdk tramite shadcn `command`), larga 560 px, senza animazione di apertura.
- Gruppi: Vai a; Chat (ricerca per nome, telefono o ID lead); Azioni sulla chat aperta; Sistema.
- La scorciatoia di ogni voce è in un `kbd` a destra; in cima ci sono i recenti.

**Assistente Claude**
- Si chiama "Assistente": niente Sparkles, gradienti, avatar luminosi o puntini che pulsano.
- La domanda sta in un blocco `sand-3`. La risposta è testo pieno, largo al massimo 65 caratteri.
- Le chiamate agli strumenti sono righe compatte e richiudibili ("Letto event_log, ultime 2 ore, 214 righe"), con la query in mono.
- Mentre lavora mostra un testo ("Sto leggendo 3 chat…"), non un'animazione.
- Le citazioni portano alla chat o all'avviso citato.
- Le azioni che propone sono bottoni normali con la conferma esplicita; non esegue mai nulla da sola.
- Lo stato vuoto propone domande legate ai dati di oggi ("Perché 41 invii sono falliti con 63016?"), non "Come posso aiutarti?".

**Grafici e KPI**
- Niente griglia di `StatCard`. In testa alla vista Lancio o Avvisi c'è una sola riga di coppie etichetta/valore separate da spazio, non dal punto mediano (SD4d).
- Tremor `Tracker` (24 segmenti) per le consegne ora per ora.
- `BarList` per le cause di errore.
- `SparkChart` solo accanto al numero che spiega, per esempio gli iscritti al lancio.
- I confronti vanno in una tabella, non in card.
- Serie in neutro; accento solo sulla serie selezionata; semantici solo per lo stato.
- Nei componenti Tremor copiati vanno tolti `transition` generico e `hover:opacity-50`.

## 4. Checklist da far girare su ogni schermata

1. **Scanner** (Node 18+, senza dipendenze), dalla cartella del bot:
   ```
   node C:/Users/bruno/Desktop/ui-riferimenti/avoid-ai-design/scripts/detect.mjs app components --min=P1
   node C:/Users/bruno/Desktop/ui-riferimenti/avoid-ai-design/scripts/detect.mjs app components --json > detect.json
   ```
   - Exit 0 = pulito; 2 = almeno un P0 o P1; `--rules` elenca le regole.
   - Tre limiti noti:
     - non legge `oklch()`, quindi SD1 e C9 sui token oklch vanno controllati a mano (o si scrivono i token in hex);
     - `components.json` con `baseColor` zinc, neutral o stone fa sempre scattare K1, per questo si scansionano solo `app` e `components`;
     - I3 segnala `Check`.
   - Per tenere una scelta voluta si mette `avoid-ai-design-ignore: ID` sulla riga.
   - Si può usare come hook PostToolUse con `--hook`.
2. **Le 25 regole** della sezione 1: tutte verdi.
3. **Squint test** con lo screenshot al 25%: si leggono nell'ordine lista, chat aperta e avvisi rossi, e nient'altro.
4. **Scala di grigi**: ogni stato si capisce ancora.
5. **Stati**: vuoto, caricamento, errore, con 1 elemento e con 5.000; nome di 60 caratteri, anteprima con emoji del lead, numero senza nome.
6. **Tastiera**: il giro completo senza mouse (`j/k`, `Invio`, `e`, `Ctrl+K`, `Esc`, `]`).
7. **Tema scuro** composto a mano (gradini `sand-dark`), non il chiaro invertito; niente transizioni al cambio di tema.
8. **Test del telaio**: riconosceresti ancora il prodotto dal solo layout, senza il logo? Se la schermata sembra lo starter di shadcn, non è finita.
9. **Movimento**: niente dura più di 200 ms e niente è animato su `j/k`; con reduce-motion attivo restano solo i cambi di opacità.

## 5. Repo in più (stelle verificate via API GitHub il 26/09/2026)

**Utili**
- **VoltAgent/awesome-design-md**, 118.021 stelle, MIT. DESIGN.md di Linear, Intercom, Superhuman, Raycast, Sentry, PostHog. Attenzione: sono analisi dei siti marketing, non dell'app. Utile Intercom, che riserva l'arancio al solo brand AI: è lo stesso ragionamento fatto qui per ember.
- **google-labs-code/design.md**, 28.113 stelle, Apache-2.0. Il formato del file di contratto; `npx @google/design.md lint` controlla anche il contrasto. Serve contro la deriva tra le pagine (X1).
- **assistant-ui/assistant-ui**, 12.312 stelle, MIT. Primitivi senza stile per il pannello Assistente: streaming, chiamate agli strumenti, azioni.
- **dip/cmdk**, 12.989 stelle, MIT, e **emilkowalski/sonner**, 13.005 stelle, MIT. Già la base di shadcn command e dei toast.
- **47ng/nuqs**, 10.859 stelle, MIT, per lo stato nell'URL. **inokawa/virtua**, 3.747 stelle, MIT, per la virtualizzazione.
- **jnsahaj/tweakcn**, 10.405 stelle, Apache-2.0. Editor visuale dei token shadcn, per provare le direzioni A e B in pochi minuti.
- **chatwoot/chatwoot**, 37.208 stelle, MIT con cartella enterprise, in Vue. Utile solo come riferimento di struttura dell'inbox (viste, assegnazione, stati), non come estetica.

**Scartate**
- **nextlevelbuilder/ui-ux-pro-max-skill**, 130.727 stelle, MIT: è un menu di 79 stili pensato per le landing, cioè proprio la scelta di stile da catalogo da evitare.
- **Leonxlnx/taste-skill**, 90.234 stelle, MIT: orientata a GSAP e spring per le landing. Al massimo si possono leggere `minimalist-skill` e `redesign-skill`.
- **twentyhq/twenty**, 57.516 stelle, licenza AGPL e commerciale: si può guardare, non copiare.
- no-slop-ui e anti-ai-slop: meno di 10 stelle.
- plugin87/ux-ui-agent-skills, 1.473 stelle: doppione di impeccable.
