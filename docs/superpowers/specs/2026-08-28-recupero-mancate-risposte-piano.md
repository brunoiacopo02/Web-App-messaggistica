# Piano: recupero dei lead che non rispondono alle Conferme

Da approvare prima di eseguire. La parte rivolta al CRM sta in
`docs/crm/2026-08-28-recupero-mancate-risposte.md`.

**Il numero che giustifica tutto:** lo scarto per "3 NR consecutivi" vale il 42% degli
appuntamenti del bot e il 44% di quelli dei GDO, ~1.288 appuntamenti persi dal 24/06.

---

## Fase 0 — I due template (si fa per prima: l'approvazione Meta ha i suoi tempi)

Script `scripts/create-recupero-nr-templates.mjs`, sullo stampo di
`create-reminder-3h-utility.mjs`. Categoria richiesta: **UTILITY**.

- `fenice_nr1_marta_v1` — `{{1}}` nome, `{{2}}` giorno e ora della call
  > Ciao {{1}}, ti abbiamo appena chiamato per la call di {{2}} con Noemi: sono 5 minuti
  > per sistemare gli ultimi dettagli e mandarti il link per collegarti. Quando ti va
  > bene che ti richiamiamo?
- `fenice_nr3_marta_v1` — stesse variabili
  > Ciao {{1}}, abbiamo provato a chiamarti tre volte per la call di {{2}} con Noemi e
  > non siamo riusciti a sentirti. Se la vuoi ancora scrivimi qui, bastano due righe e la
  > confermiamo: sono 5 minuti al telefono. Senza una tua risposta l'appuntamento lo
  > annulliamo.

**Alla creazione, i SID vanno subito in `UTILITY_ONLY_ALLOW` e in env** (`NR1_TEMPLATE_SID`,
`NR3_TEMPLATE_SID`). È l'errore del 24/08: template creati, messi in env, e mai aggiunti
alla allow-list — 27 lead senza primo messaggio per quattro giorni.

Se Meta li classifica MARKETING invece che UTILITY, ci si ferma e se ne riparla: da un
numero a qualità LOW non ci mandiamo un MARKETING nuovo.

---

## Fase 1 — Il contratto in ingresso

**`lib/call-attempt.ts`** (puro, TDD):
- `parseCallAttempt(raw)` → `{leadId, esito, tentativo, at, appointmentAt}` oppure motivo.
- `tentativo` ammesso: `1` e `3`. Il `2` si accetta e si risponde `inviato: false,
  motivo: "tentativo_non_gestito"` — meglio che un 400 su un canale senza retry.
- `at` e `appointmentAt` ISO con offset, come già `isoWithOffset`.

**`app/api/bot/call-attempt/route.ts`**:
- HMAC con `BOT_WEBHOOK_SECRET`, stessa verifica di `/api/bot/intake`.
- Idempotenza su `leadId` + `tentativo` via `event_log` (`recupero_nr_inviato`).
- Risposta sempre `200 {ok, inviato, motivo?}`: il CRM non ritenta, e un 500 da noi
  perderebbe il lead senza lasciare traccia da loro.

---

## Fase 2 — Le quattro guardie

**`lib/recupero-nr.ts`** (puro, TDD): `puoScrivere(conv, evento, nowMs)` →
`{ok: true}` | `{ok: false, motivo}`.

Le quattro condizioni, tutte verificabili su colonne, **nessun giudizio del modello**:
1. `cancel_requested_at` valorizzato → `disdetta_chiesta`
2. `ai_status === 'handed_off'` → `passato_a_persona`
3. esiste un messaggio in ingresso dopo `evento.at` → `gia_risposto`
4. `bot_scheduled_at` nel passato, oppure niente appuntamento → `appuntamento_non_valido`

Più due di sicurezza che aggiungo io:
5. il lead non è del bot (`ai_owner !== 'mario'`) → `non_nostro`
6. un messaggio di recupero per lo stesso tentativo è già partito → `gia_inviato`

Test: una per condizione, più il caso pulito che passa.

---

## Fase 3 — I due rami di invio

**`lib/recupero-nr-invio.ts`**:
- `dentroFinestra(lastInboundAt, nowMs)` → 24h esatte dall'ultimo messaggio **del lead**.
- **dentro** (79%): messaggio libero di Marta, generato sulla chat vera riusando la
  macchina di `fenice-autoreply`, con un'istruzione dedicata che dice: le Conferme hanno
  appena provato a chiamare, la call è il `{data}`, servono 5 minuti, chiedi quando
  richiamarlo. Vietato inventare orari: valgono le regole già nel prompt.
- **fuori** (21%): template `NR1`/`NR3` con nome e `{{2}}` = giorno e ora in formato
  leggibile (`formatRomeDateTime`).
- Fuori fascia 08:30-20:30 si manda lo stesso: è la risposta a una loro telefonata, non
  un contatto a freddo. Le Conferme lavorano fino alle 20, quindi capiterà di rado.

---

## Fase 4 — Riaprire senza declassare

Un lead fissato ha `bot_outcome = 'APPUNTAMENTO'` e la chat chiusa: oggi una sua risposta
non verrebbe lavorata. Serve che:
- il messaggio di recupero **riapra** la conversazione (`ai_status = 'active'`) **senza
  toccare `bot_outcome` né `bot_outcome_at`**: l'appuntamento resta quello;
- alla risposta del lead valgano le regole già scritte — se conferma si chiude lì, se
  chiede di spostare Marta **rifissa** (contratto v1.5, attivo da ieri), se disdice parte
  la nota al CRM;
- il tetto di riapertura non venga aggirato: se il lead non risponde, la conversazione
  torna chiusa senza generare un nuovo esito.

Questa è la fase più delicata: tocca l'invariante "una volta fissato resta Preso", che
era essa stessa la correzione di un bug. Test espliciti sul fatto che `bot_outcome` e
`bot_outcome_at` non cambiano mai in tutto il percorso.

---

## Fase 5 — La notifica alle Conferme

Sul `CONTATTO_UMANO` che già mandiamo:
- aggiungere `info.appuntamento` con data e ora quando il lead è già fissato, così il CRM
  può instradare alle Conferme invece che ai GDO;
- mandare come `motivo` anche i due casi nuovi: **aspetta la call** e **chiede di essere
  richiamato**, che oggi finiscono in `altro`.

`lib/contatti-umani.ts` ha già le regole a categorie: si aggiungono due voci e la
traduzione verso le loro.

---

## Fase 6 — Verifica e messaggio al CRM

- Suite completa verde, build pulita, typecheck.
- Prova end-to-end in produzione con un lead vero controllato da noi, su entrambi i rami
  (dentro e fuori finestra) e su almeno due delle quattro guardie.
- Controllo che i messaggi partano davvero: **riga in uscita con `twilio_sid`**, non solo
  "nessun errore". È la lezione del 24/08.
- Poi parte il messaggio al CRM con quello che devono fare loro.

---

## Cosa NON è in questo piano

- La sezione nei profili Conferme e il pallino rosso: è lavoro loro.
- Il messaggio dopo il secondo tentativo: si accetta e si ignora, per non insistere tre
  volte in tre giorni su un numero ancora in riabilitazione.
- Il recupero degli scartati storici per "3 NR": prima si guarda se il meccanismo
  funziona sui nuovi, poi si decide se tornare indietro sui 138.
