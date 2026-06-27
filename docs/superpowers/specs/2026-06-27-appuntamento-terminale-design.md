# Appuntamento terminale + skip follow-up sui lead terminali — Design

**Data:** 2026-06-27
**Stato:** approvato (design), in attesa scrittura piano

## Problema

Il conteggio "Presi" del pannello Fenice e la % di fissaggio del bot Mario contano
solo le conversazioni con `bot_outcome = 'APPUNTAMENTO'`. Oggi però, se un lead già
fissato torna indietro (disdice, si confronta con un familiare, si raffredda), Mario
emette un esito successivo (`SCARTO`/`INTERROTTO`/`RICHIAMO`) e `sendOutcome`
**sovrascrive** `bot_outcome`, facendo **sparire** l'appuntamento dai Presi e
falsando la percentuale di fissaggio.

Un appuntamento preso è un risultato valido del bot **anche se il lead poi annulla**:
l'annullamento è un evento successivo, gestito dai venditori, non un "mancato
fissaggio".

### Conversazioni già impattate (al 2026-06-27)

Tre conversazioni hanno ricevuto un esito `APPUNTAMENTO` e sono poi state declassate
dal bot:

| Conv | Lead | Funnel | Stato attuale | Note |
|------|------|--------|---------------|------|
| 1263 | 4903 | JOB SIMULATOR | DA_SCARTARE | "Alina"; fissata 29/06 19:00, disdetta dopo confronto con la madre |
| 1246 | 4886 | JOB SIMULATOR | INTERROTTO | da verificare data originale |
| 1268 | 4908 | JOB SIMULATOR | DA_SCARTARE | da verificare data originale |

La % di fissaggio reale è quindi sottostimata di 3.

## Requisiti (decisi con l'utente)

1. **APPUNTAMENTO terminale assoluto.** Una volta che `bot_outcome = 'APPUNTAMENTO'`,
   né l'esito né la data (`bot_scheduled_at`) cambiano più. Qualsiasi evento successivo
   (incluso un nuovo APPUNTAMENTO con data diversa) **non** sovrascrive la riga: viene
   convertito in una **nota** verso il CRM.
2. **Notifica CRM su evento post-fissaggio.** Il bot ri-invia `outcome: APPUNTAMENTO`
   (stessa data originale) con una `note` che descrive l'accaduto. Il lead resta tra
   i Presi ovunque e la % di fissaggio non cambia.
3. **Niente follow-up agenda sui lead terminali.** Il follow-up agenda non deve più
   ripescare lead che hanno già un esito terminale (qualsiasi `bot_outcome` non-null,
   o conversazione chiusa). Questo elimina la pinging osservata (lead disdetto alle
   12:08 ricontattato alle 13:00).
4. **Backfill.** Ripristinare a APPUNTAMENTO le 3 conversazioni storiche impattate,
   con verifica caso per caso.

## Fuori scope (esplicitamente esclusi)

- Badge "annullato" nel pannello Presi.
- Nudge nel system prompt di Mario (la garanzia resta a livello di codice).

## Design

### Blocco 1 — Guard "APPUNTAMENTO terminale" in `lib/bot-outcome.ts`

`sendOutcome` è il **punto unico** in cui ogni esito viene persistito e inviato al CRM.
È usato sia dall'inbound autoreply (`lib/fenice-autoreply.ts`) sia dal cron
`bot-followups`. Mettendo il guard qui, tutti i chiamanti sono protetti.

**Lettura stato attuale.** La query iniziale (oggi seleziona solo `crm_lead_id`) viene
estesa a `crm_lead_id, bot_outcome, bot_scheduled_at`.

**Ramo "già fissato".** Se la conversazione è CRM-linked e `bot_outcome` corrente è
`'APPUNTAMENTO'`:

- **Non** si aggiornano `bot_outcome`, `bot_outcome_at`, `bot_scheduled_at`,
  `bot_report`, `ai_status`: la riga è congelata.
- Si costruisce una `note` dall'esito in arrivo (regole sotto).
- Si ri-invia al CRM `outcome: 'APPUNTAMENTO'` con `date = bot_scheduled_at` (originale),
  la `note` costruita e il `report` aggiornato (solo nel payload CRM, per contesto;
  non persistito localmente).
- Si logga un evento `event_log` di tipo **`bot_outcome_locked`** con
  `{ conversationId, crmLeadId, attemptedOutcome, keptOutcome: 'APPUNTAMENTO', note }`.
- Ritorna `{ sent: true, status }` su 2xx (così il loop autoreply mantiene
  `ai_status = 'closed'`).

**Regole di costruzione della nota** (in base all'`outcome` in arrivo):

| Outcome in arrivo | Nota generata |
|-------------------|---------------|
| `DA_SCARTARE` | `Il lead vuole annullare l'appuntamento. Motivo: <discardReason>` |
| `INTERROTTO` | `Conversazione interrotta dopo l'appuntamento. <note>` |
| `RICHIAMO` | `Il lead ha chiesto di essere ricontattato (<date>). Appuntamento mantenuto.` |
| `APPUNTAMENTO`, data = originale | `Il lead ha riconfermato l'appuntamento.` |
| `APPUNTAMENTO`, data diversa | `Il lead ha chiesto di spostare a <nuova data>. Appuntamento originale mantenuto: <data orig>.` |

Se è presente anche `args.note`, viene appeso alla nota.

**Ramo normale.** Se `bot_outcome` corrente non è `'APPUNTAMENTO'` → comportamento
identico a oggi (persiste esito, data, report, chiude la conversazione).

**Edge case.** Se per anomalia `bot_outcome = 'APPUNTAMENTO'` ma `bot_scheduled_at` è
null (la data è obbligatoria per il re-invio APPUNTAMENTO), si salta il re-POST CRM, si
logga un `bot_outcome_locked` con `warning` e si ritorna `{ sent: true }` senza
declassare (la riga resta comunque APPUNTAMENTO). Non si declassa mai.

### Blocco 2 — Skip follow-up sui lead terminali in `lib/agenda-followup.ts`

`decideAgendaFollowup` oggi salta solo `booked`
(`bot_outcome === 'APPUNTAMENTO' || ai_status === 'booked'`). Si introduce un concetto
più ampio di **terminale**:

- Il parametro `booked` viene sostituito da `terminal: boolean`.
- `decideAgendaFollowup` ritorna `'none'` se `terminal` è true (mantiene tutte le altre
  guardie esistenti: `followupAlreadySent`, `lastMessageIsInbound`, finestre temporali,
  fascia oraria).
- In `runAgendaFollowups`, `terminal` viene calcolato come:
  `c.bot_outcome != null || ['closed','booked','handed_off'].includes(c.ai_status)`.

Questo copre il caso `DA_SCARTARE`/`INTERROTTO` (lead già deciso) oltre a
`APPUNTAMENTO`.

### Blocco 3 — Backfill una-tantum

Migrazione SQL + re-callback CRM per le 3 conversazioni storiche (1263, 1246, 1268):

1. **Verifica per-conversazione** dai messaggi/eventi che il fissaggio fosse reale e
   recupero della data originale dell'appuntamento.
2. `UPDATE conversations SET bot_outcome = 'APPUNTAMENTO', bot_scheduled_at = <data orig>,
   ai_status = 'closed' WHERE id = <conv>`.
3. Re-invio al CRM `outcome: APPUNTAMENTO` (stessa data) con `note` di ripristino, es.
   *"Ripristino: l'appuntamento era stato erroneamente declassato dal bot. Stato
   successivo registrato come nota: <esito precedente>."*

Date note finora:
- 1263 (Alina): lunedì 29/06 ore 19:00 Rome → `2026-06-29T17:00:00Z`.
- 1246, 1268: da estrarre dai messaggi in fase di backfill.

### Blocco 4 — Dipendenza CRM (non-codice)

Confermare col team CRM che un re-invio di `APPUNTAMENTO` con `note` su un lead già
fissato: (a) registra la nota, (b) non crea un appuntamento duplicato, (c) non altera
stato/owner. Se il comportamento differisce, si adatta il payload (eventuale campo
dedicato `cancelledReason`). Messaggio già preparato per il team.

## Testing

- **Nuovo `lib/bot-outcome.test.ts`** (mock di Supabase admin + `fetch` globale):
  - già-APPUNTAMENTO + SCARTO → CRM riceve APPUNTAMENTO + note; riga locale invariata;
    evento `bot_outcome_locked`.
  - idem per INTERROTTO, RICHIAMO, APPUNTAMENTO con data diversa.
  - APPUNTAMENTO con stessa data → nota di riconferma.
  - non-APPUNTAMENTO → comportamento normale (persiste e chiude).
  - edge: APPUNTAMENTO con `bot_scheduled_at` null → no declassamento, warning.
- **`lib/agenda-followup.test.ts`**: aggiorno i casi `booked` → `terminal`; aggiungo
  caso `DA_SCARTARE`/`INTERROTTO` → `'none'`.

## File toccati

- `lib/bot-outcome.ts` — guard terminale + costruzione nota.
- `lib/bot-outcome.test.ts` — nuovo.
- `lib/agenda-followup.ts` — parametro `terminal`.
- `lib/agenda-followup.test.ts` — test aggiornati.
- Migrazione/backfill SQL (eseguita via MCP, non file applicativo) per 1263/1246/1268.
