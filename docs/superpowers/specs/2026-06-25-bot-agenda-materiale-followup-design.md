# Spec — Modifiche al bot Mario: agenda 20:00, materiale gratuito, follow-up 2h, analisi pitch

**Data:** 2026-06-25
**Branch:** `feat/bot-agenda-materiale-followup`
**Stato:** approvato in brainstorming, pronto per il piano di implementazione

## Contesto

Mario è il bot WhatsApp "fissatore" di Fenice Academy (Next.js + Supabase + Twilio).
Prequalifica i lead e fissa appuntamenti (videocall di consulenza). Architettura:

- Prompt/persona: `lib/mario-prompt.ts`
- Chiamata AI + parsing esito: `lib/mario.ts` (Claude Sonnet 4.6)
- Orchestrazione autoreply: `lib/fenice-autoreply.ts`
- Slot prenotabili: `lib/booking-slots.ts`
- Cron backstop + classificazione CRM: `app/api/cron/bot-followups/route.ts` (orario, `0 * * * *`)
- Rilevamento "agenda inviata": già presente in `app/api/cron/send-video/route.ts` (ogni minuto)
- Funnel del lead: colonna `conversations.crm_funnel`

Problema misurato: conversione bassissima. Funnel **CORSO 10 ORE = 54 lead, 1 preso (~2%)**.
Due cause note che questo spec affronta: (a) gestione errata della richiesta di "materiale
gratuito", (b) agenda che propone slot ormai passati la sera. Più follow-up assente e
un'analisi strutturata delle perdite al pitch.

## Decisioni prese in brainstorming

1. **Follow-up:** un solo messaggio **free-text** dal bot a ~2h (l'utente accetta il rischio,
   mitigato dal singolo invio dentro la finestra 24h).
2. **Materiale gratuito:** la nuova gestione si applica a **chiunque** chieda materiale
   gratuito, non solo al funnel CORSO 10 ORE. Nessuna logica per-funnel necessaria.
3. **Fasce orarie agenda:** posizionali (1° giorno offerto = 15–21, 2° = 9–21).
4. **Testo follow-up:** stringa fissa in voce Mario (più sicuro/prevedibile di una
   generazione AI), configurabile.
5. **Sequenza:** Fase 1 = punti 1+2+3; Fase 2 = analisi (punto 4); Fase 3 = tuning prompt
   guidato dall'analisi (piano separato).

---

## 1. Rollover agenda alle 20:00

**File:** `lib/booking-slots.ts`

Oggi `computeBookingDays(now)` ancora il calcolo a "oggi" e i due giorni partono da domani,
con rollover a mezzanotte Rome. I lead la sera ricevono ancora slot del giorno il cui
pomeriggio è quasi finito.

**Cambio:** calcolare l'ora locale Europe/Rome di `now`; **se ora ≥ 20:00, anticipare
l'anchor di +1 giorno** prima di calcolare `day1`/`day2`. La finestra proposta scorre quindi
in avanti di un giorno dopo le 20.

**Invarianti mantenute:**
- Skip domenica (`nextNonSunday`) invariato.
- Sicurezza DST (ancora UTC a mezzogiorno) invariata.
- Fasce **posizionali**: `day1` sempre "dalle 15:00 alle 21:00", `day2` sempre "dalle 09:00
  alle 21:00" (testo in `bookingSlotsContext` invariato).
- `[ESITO:APPUNTAMENTO|...]` continua a usare `day1.date` / `day2.date`.

**Helper:** serve l'ora locale Rome di una `Date`. Verificare se `lib/rome-time.ts` la
espone già; altrimenti aggiungere una piccola funzione pura (es. `romeHour(date): number`)
ricavata da `Intl.DateTimeFormat` con `hour: '2-digit', hour12: false, timeZone: 'Europe/Rome'`.

**Test (`lib/booking-slots.test.ts`):**
- prima delle 20:00 → comportamento attuale invariato;
- alle 20:00 esatte e dopo → shift +1 giorno;
- confine domenica combinato con lo shift (es. sabato 21:00);
- coerenza label/date ISO dopo lo shift;
- nessuna regressione DST.

---

## 2. Gestione "materiale gratuito" (solo prompt)

**File:** `lib/mario-prompt.ts`

Sostituire/aggiornare la sezione che oggi nega l'esistenza di materiale gratuito.
Nuovo comportamento, valido per **qualunque** lead che chiede materiale gratuito:

1. Riconoscere che esiste un **corso orientativo gratuito di 10 ore** che spiega come
   funzionano le professioni digitali offerte.
2. Spiegare che **arriva via email** e si può guardare da lì.
3. Se non l'ha ricevuto → invitare a scrivere a **info@feniceacademysrl.com**.
4. **Prendere comunque l'appuntamento**: il corso 10h è solo *orientativo*; in consulenza un
   tutor orienta direttamente e meglio. L'obiettivo resta fissare la videocall.

**Vincoli:**
- Confine netto: il 10h gratuito è *orientamento*; i corsi professionali restano a pagamento
  (1.000–3.000€). Mario non deve far credere che i corsi a pagamento siano gratis.
- Coerenza onestà (memoria progetto "no manipolazione / no impersonificazione umana"): nessun
  inganno, nessuna falsa promessa.
- Email esatta: `info@feniceacademysrl.com`.

Nessun test automatico (è copy di prompt); validazione in Fase 3 + revisione manuale.

---

## 3. Follow-up singolo a ~2h

**File:** logica in `lib/bot-followups.ts`; integrazione nel cron
`app/api/cron/bot-followups/route.ts` (orario). Granularità ~2–3h: accettabile per "circa 2h".

**Trigger (tutte le condizioni):**
- esiste un messaggio agenda inviato: `messages` con `template_sid = AGENDA_TEMPLATE_SID`,
  `direction='out'`, `is_template=true`, `twilio_status NOT IN ('failed','undelivered')`
  (stesso pattern già usato in `send-video`);
- l'invio agenda risale ad **almeno 2h** fa;
- il lead **non ha preso** l'appuntamento (`bot_outcome` ≠ `'APPUNTAMENTO'`; conversazione non
  in stato `booked`);
- **nessun follow-up già inviato** (riuso colonna esistente `bot_followups_sent`: incrementata
  a 1 dopo l'invio; il follow-up parte solo se `bot_followups_sent = 0/null`);

**Guardie anti-ban (tutte obbligatorie):**
- **Finestra 24h WhatsApp aperta:** ultimo messaggio *inbound* del lead < 24h fa; altrimenti
  skip (il free-text non sarebbe lecito). Senza inbound → skip.
- **Orario sensato:** invio solo se ora locale Rome ∈ [09:00, 21:00]; se le 2h cadono fuori
  fascia, rimandare al primo run utile dentro fascia (il flag impedisce doppi invii).
- **Esattamente uno** per lead: il flag `bot_followups_sent` rende l'azione idempotente.

**Messaggio (stringa fissa, voce Mario, nome del lead interpolato):**
> "Ciao {nome} 🙂 ti avevo mandato gli orari per la videocall ma non ho ancora visto la
> conferma. Vuoi che ti tenga uno slot? Dimmi pure giorno e ora che preferisci."

Inviato via il normale percorso di invio WhatsApp free-text (stesso usato da Mario), loggato
in `event_log` (`type: 'agenda_followup_sent'`). Se il lead risponde, riprende l'autoreply
standard.

**Nota di scope query:** la rilevazione "agenda inviata + non preso" non deve essere
ristretta al solo set CRM-linked se esistono lead agenda-inviata senza `crm_lead_id`. Il
piano definirà se estendere la query del cron o aggiungere una query dedicata.

**Backfill una tantum:** identificare i lead "agenda inviata da >2h, non preso, nessun
follow-up" attualmente esistenti (~4) e inviare loro il follow-up. Realizzabile lasciando
girare il cron aggiornato (idempotente) oppure con uno script/route una-tantum. Verificare
prima che gli outbound vengano effettivamente consegnati (storia blocco numero Meta in
memoria; ma l'utente conferma che le agende sono state recapitate).

**Test (`lib/bot-followups.test.ts`):** decisione pura `decideAgendaFollowup(input)` →
- agenda <2h → none;
- agenda ≥2h, non preso, finestra aperta, orario ok, mai inviato → send;
- già preso → none;
- già inviato (`bot_followups_sent>0`) → none;
- finestra 24h chiusa → none;
- orario notturno → none (defer).

---

## 4. Analisi perdite al pitch + gestione obiezioni (deliverable)

Task **read-only**, nessuna modifica di codice; produce un report.

**Dataset:** conversazioni Mario che hanno **raggiunto il pitch** (prezzi comunicati) e **non
hanno convertito** (esito SCARTO / INTERROTTO / nessun appuntamento). Estrazione da Supabase
(`conversations` + `messages`).

**Metodo:** subagent in parallelo leggono i transcript a blocchi ed estraggono per ciascuna
chat: punto di morte (turno dopo il pitch), obiezione sollevata, risposta di Mario, motivo
del fallimento. Aggregazione in pattern ricorrenti.

**Output:** `docs/superpowers/specs/2026-06-25-analisi-perdite-pitch.md` (o report dedicato)
con: top obiezioni, pattern di fallimento al pitch, raccomandazioni puntuali di modifica al
prompt per la gestione obiezioni. Alimenta la Fase 3 (tuning prompt, piano separato).

---

## Out of scope

- Tuning prompt guidato dall'analisi (Fase 3, piano separato).
- Sblocco/diagnostica deliverability del numero WhatsApp (gestito altrove; solo verifica
  pre-backfill).
- Solleciti multipli / catena di follow-up (esplicitamente escluso: un solo messaggio).
- Modifiche al flusso post-appuntamento (video di conferma) non toccate.

## Criteri di completamento Fase 1

- `computeBookingDays` ruota alle 20:00, test verdi.
- Prompt aggiornato sul materiale gratuito (revisione manuale ok).
- Follow-up a 2h con tutte le guardie, idempotente, test verdi; backfill dei lead esistenti
  eseguito.
- Typecheck + build verdi.
