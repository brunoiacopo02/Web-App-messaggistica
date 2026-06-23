# Lead recuperabili — esito INTERROTTO (contratto bot v1.1)

Data: 2026-06-23
Stato: approvato (design)

## Contesto

Il CRM Fenice (repo separato, commit `38b685a`, live) ha aggiornato il contratto
bot→CRM alla v1.1. Da ora i lead "recuperabili" non vengono più scartati ma
riassegnati a un operatore umano (round-robin GDO):

- `NON_RISPOSTO` (mai risposto) → riassegnato a umano. **Criterio invariato**.
- `INTERROTTO` (**nuovo**): chat avviata ma interrotta senza un'obiezione ferrea
  (silenzio a metà, tentennamenti, sparizione) → riassegnato a umano.
- `DA_SCARTARE` → scarto definitivo, **solo** per obiezione ferrea reale
  (es. "non ho soldi", "non mi interessa").
- `APPUNTAMENTO` / `RICHIAMO` → invariati.

Endpoint, firma HMAC e URL (`crm-sales-fenice.vercel.app/api/bot/outcome`)
invariati. Questo spec copre **solo il lato bot** (repo Software Messaggistica):
emettere il nuovo esito e allineare la semantica di scarto.

## Stato attuale (mappato)

Due "decisori" di esito:

1. **Live** (`lib/fenice-autoreply.ts`): Mario emette un tag, `parseMarioReply`
   (`lib/mario.ts`) lo estrae, `sendOutcome` (`lib/bot-outcome.ts`) chiama il CRM
   e chiude la conversazione (`ai_status='closed'`). Tag attuali:
   `APPUNTAMENTO`, `RICHIAMO`, `SCARTO`→`DA_SCARTARE`, più `[PASSAGGIO_UMANO]`.
2. **Cron** (`app/api/cron/bot-followups/route.ts` + `lib/bot-followups.ts`):
   per i lead che **non hanno mai risposto** (`hasInbound=false`) invia solleciti
   a 12h/22h e a 24h chiude con `NON_RISPOSTO`.

**Buco identificato**: un lead che risponde almeno una volta e poi sparisce ha
`hasInbound=true`; `decideFollowupAction` ritorna subito `'none'` e la
conversazione resta `active` per sempre, mai rimandata al CRM. È esattamente il
caso che `INTERROTTO` deve coprire.

## Tassonomia esiti (target)

| Esito | Quando | Chi lo emette |
|---|---|---|
| `APPUNTAMENTO` / `RICHIAMO` | invariati | AI live (tag) |
| `DA_SCARTARE` | **solo** obiezione ferrea / no netto reale | AI live (tag `SCARTO`) |
| `INTERROTTO` *(nuovo)* | disimpegno senza no netto | AI live **+** cron |
| `NON_RISPOSTO` | mai risposto dopo i solleciti (invariato) | cron |

`INTERROTTO` ha due forme:
- **Sparizione a metà** (caso principale): lead risponde poi sparisce → lo chiude
  il **cron**.
- **Tentennamento esplicito live**: "adesso non posso", "ti faccio sapere io",
  "lascia stare per ora" senza no netto → lo emette l'**AI** con un tag.

## Modifiche

### 1. `lib/bot-contract.ts`
- `BotOutcome` += `'INTERROTTO'`.
- `OUTCOMES` += `'INTERROTTO'`.
- **Non** entra in `DATE_REQUIRED` (nessuna data richiesta).

### 2. `lib/mario.ts`
- `MarioOutcome` += `'INTERROTTO'`.
- `ESITO_RE` estesa: `/\[ESITO:(APPUNTAMENTO|RICHIAMO|SCARTO|INTERROTTO)\|([^\]]*)\]/i`.
- Nuovo ramo di parsing: `INTERROTTO` → `outcome='INTERROTTO'`, motivo in un nuovo
  campo `note?: string` di `MarioResult` (non `discardReason`, che resta
  semantico per lo scarto).
- `fenice-autoreply.ts`: la chiamata a `sendOutcome` passa anche `note: result.note`.

### 3. `lib/mario-prompt.ts`
- Restringe `[ESITO:SCARTO]`: solo obiezione ferrea reale / fuori target chiaro
  (es. "non ho soldi", "non mi interessa per niente").
- Aggiunge `[ESITO:INTERROTTO|<motivo breve>]` con istruzioni **strette**: usalo
  solo quando il lead si disimpegna esplicitamente senza un no netto ("non ora",
  "ti faccio sapere", "lascia perdere per ora"). Nel dubbio NON chiudere: tieni
  viva la chat, al silenzio ci pensa il cron. Non è la gestione obiezioni normale.
- Corregge l'incoerenza attuale: la riga "se il lead dice che non è interessato
  → `[PASSAGGIO_UMANO]`" diventa: "non mi interessa" fermo → `SCARTO`;
  `[PASSAGGIO_UMANO]` resta solo per "voglio parlare con una persona".
- Aggiorna l'elenco dei tag esito in fondo al prompt con `INTERROTTO`.

### 4. Cron `bot-followups` — logica unificata

`decideFollowupAction` diventa simmetrica rispetto al riferimento temporale.
Richiede un nuovo input `lastInboundAtMs: number | null`.

```
ref = hasInbound ? lastInboundAtMs : startedAtMs
elapsedH = (now - ref) / H
mai risposto (hasInbound=false):  solleciti 12h/22h → 'non_risposto' a 24h   [INVARIATO]
ha risposto poi silente (true):   nessun sollecito  → 'interrotto'   a 24h    [NUOVO]
```

- `FollowupAction` += `'interrotto'`.
- Il route gestisce `'interrotto'` chiamando
  `sendOutcome(supabase, c.id, { outcome: 'INTERROTTO', note: 'Chat interrotta senza obiezione, riassegnare a operatore.' })`.
- La query del cron già seleziona `ai_status in ['active','replying']` e i lead
  silenti sono `active`: nessuna modifica alla query oltre a leggere
  `last_inbound_at` (già selezionato).

Scelte di design:
- **Niente solleciti extra** ai lead che hanno già risposto: i testi attuali
  ("sei riuscito a leggere?") non hanno senso per chi ha già scritto, e il
  contratto vuole che li rilavori un umano a voce. Mantiene il flusso esistente
  intatto e a rischio zero.
- Soglia **24h di silenzio** (= `GIVEUP_H`, riuso costante) dall'ultimo messaggio
  del lead: coincide con la chiusura della finestra free-text WhatsApp e dà al
  lead una giornata per riprendere da solo. Singola costante, facile da tarare.
- Il flusso "mai risposto → NON_RISPOSTO" resta identico: nessuna regressione.

### 5. Dashboard Fenice (`lib/lead-segments.ts`)
- Allarga il tipo di ritorno di `fermaReason` per includere `'INTERROTTO'`.
- Verifica che la pagina `/fenice/lead` mostri l'etichetta del nuovo motivo
  (aggiungere label se esiste una mappa). Modifica di sola visualizzazione.

## Test

- `bot-contract.test.ts`: `INTERROTTO` accettato da `validateOutcomeBody`, senza data.
- `mario-parse.test.ts`: `[ESITO:INTERROTTO|motivo]` → `outcome='INTERROTTO'`,
  `note='motivo'`, testo visibile pulito.
- `bot-followups` (test puro su `decideFollowupAction`):
  - mai risposto, ≥24h → `'non_risposto'` (invariato);
  - risposto poi silente, ≥24h da `last_inbound_at` → `'interrotto'`;
  - risposto poi silente, <24h → `'none'`.

## Fuori scope

`[PASSAGGIO_UMANO]` mette il lead in `handed_off` nell'inbox interno e **non**
notifica il CRM. Comportamento pre-esistente, separato da questo contratto:
lasciato invariato salvo indicazione esplicita.

## Criteri di accettazione

- L'endpoint CRM accetta `INTERROTTO` (validazione lato bot ok, niente data).
- Un lead che risponde e poi tace 24h viene chiuso `INTERROTTO` e notificato al CRM.
- Un lead che non risponde mai resta `NON_RISPOSTO` (comportamento invariato).
- `DA_SCARTARE` viene emesso solo per obiezione ferrea.
- `typecheck`, test e build verdi.
