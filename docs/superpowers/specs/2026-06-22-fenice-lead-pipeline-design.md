# Fenice — Pipeline Lead Mario: Segmentazione, Report e Analisi AI

**Data:** 2026-06-22
**Stato:** Design approvato, pronto per la pianificazione
**Area:** Interfaccia `/fenice` (lead WhatsApp gestiti da Mario)

## Obiettivo

Dare chiarezza sullo stato dei lead che Mario gestisce su WhatsApp, oggi visibili
solo come liste piatte in `/fenice/live` e `/fenice/conversazioni`. Servono:

1. Tre sezioni di stato chat: **Attive**, **Mai risposto**, **Ferme/Perse**.
2. Un report **Presi vs Non presi** (preso = appuntamento fissato).
3. Un'analisi con le API di Claude che fa capire **dove si bloccano** i lead e
   le loro **obiezioni principali** per cui non prendono l'appuntamento.

## Definizioni e decisioni chiave

- **Popolazione:** solo `conversations` con `ai_owner = 'mario'`. Il traffico CRM
  normale (`ai_owner IS NULL`) resta escluso, coerente con la dashboard attuale.
- **"Preso" = appuntamento fissato**, cioè `bot_outcome = 'APPUNTAMENTO'`. Non
  significa iscrizione/acquisto del corso (dato non tracciato oggi).
- **Soglia Attiva/Ferma:** ultimo messaggio in ingresso del lead entro **22h**
  (allineata alla finestra follow-up/chiusura a 24h del cron `bot-followups`).
- **Analisi AI:** solo i lead che **hanno risposto ma non hanno preso**. I "mai
  risposto" non hanno testo da analizzare: vengono **contati a parte** così si
  vede la quota di non-presi persi per mancata risposta.
- **Trigger analisi AI:** **cron giornaliero**; la UI mostra sempre l'ultimo
  report salvato con la sua data.
- **Modello Claude:** `claude-sonnet-4-6`, coerente con `lib/mario.ts` e
  `lib/mario-summary.ts`. Client via `ANTHROPIC_API_KEY`.

## Segmentazione (calcolata in SQL/JS, nessun costo Claude, sempre live)

Per ogni conversazione Mario si deriva **un** segmento, valutato in quest'ordine
di priorità (la prima regola che matcha vince):

| Segmento | Regola | Significato |
|---|---|---|
| `PRESO` | `bot_outcome = 'APPUNTAMENTO'` | Appuntamento fissato |
| `MAI_RISPOSTO` | `last_inbound_at IS NULL` | Ha ricevuto il template, non ha mai scritto |
| `ATTIVA` | `last_inbound_at IS NOT NULL` AND `ai_status IN ('active','replying')` AND `last_inbound_at >= now - 22h` | Ha risposto, chat viva, lead ingaggiato |
| `FERMA` | tutti gli altri lead che hanno risposto (chat `closed`, oppure `bot_outcome` in RICHIAMO/DA_SCARTARE/NON_RISPOSTO, oppure silenzio > 22h) | Ha risposto ma non prende l'app / non risponde più |

Le tre sezioni richieste mappano su `ATTIVA`, `MAI_RISPOSTO`, `FERMA`; `PRESO` è
evidenziato a parte come esito positivo.

Sotto-motivo per `FERMA` (mostrato come etichetta, non un segmento separato):
`bot_outcome` (RICHIAMO / DA_SCARTARE / NON_RISPOSTO) oppure `SILENTE` quando ha
risposto e poi sparito senza esito.

## Report "Presi vs Non presi"

Header con i numeri chiave su tutta la popolazione Mario (con filtro periodo):

- Totale lead
- **Presi** = count `PRESO`
- **Non presi** = totale − presi
- **Tasso conversione** = presi / totale
- Di cui **mai risposto** = count `MAI_RISPOSTO` (e relativa % sui non presi:
  "quota di non-presi persi per mancata risposta")

Sotto: distribuzione per segmento (conteggi + %), filtro periodo
(**7 gg / 30 gg / tutto**, su `created_at` della conversazione) e, se presente,
breakdown per `crm_funnel`.

## Analisi AI (Claude, due stadi, cron giornaliero)

### Stadio 1 — estrazione per conversazione (in cache)

Per ogni conversazione Mario che **ha risposto ma non ha preso** (`last_inbound_at
NOT NULL` AND `bot_outcome != 'APPUNTAMENTO'`), Claude estrae una volta sola dal
transcript (dai messaggi dopo `ai_started_at`):

- `ai_dropoff_stage` — testo breve sullo stadio in cui si è bloccato
  (es. "dopo il prezzo", "prima degli slot", "subito dopo apertura").
- `ai_objection_category` — categoria normalizzata tra un set chiuso:
  `prezzo`, `tempo`, `sfiducia` (truffa/scetticismo), `garanzia_lavoro`,
  `ci_penso`, `altro`, `nessuna`.
- `ai_objection_note` — citazione/sintesi breve dell'obiezione.
- `ai_insight_at` — timestamp dell'estrazione.

**Cache:** si ricalcola solo se `last_message_at > ai_insight_at` (chat cambiata)
o se `ai_insight_at IS NULL`. Le chat invariate non vengono re-inviate a Claude.

### Stadio 2 — aggregazione

A partire da tutte le estrazioni:

- Conteggi per `ai_objection_category` (top obiezioni).
- Conteggi/funnel per `ai_dropoff_stage` (raggruppati in modo robusto).
- Un riassunto Claude con **insight narrativi + 3-5 suggerimenti concreti** per
  migliorare lo script di Mario (`lib/mario-prompt.ts`).
- Contesto: numero `MAI_RISPOSTO` riportato a parte per dare la quota di lead
  persi senza alcuna interazione.

Il risultato aggregato è salvato in `lead_analysis_reports` con `generated_at`.

### Cron

`GET /api/cron/lead-analysis` (1×/giorno):
1. Aggiorna le estrazioni Stadio 1 mancanti/obsolete (con un cap di sicurezza per
   run, es. max N conversazioni per evitare run troppo lunghe/costose; il resto
   viene completato nelle run successive — il cap viene loggato).
2. Esegue lo Stadio 2 e salva il report.
3. Logga su `event_log` (`type='lead_analysis'`).

Protezione cron: stessa modalità degli altri endpoint cron del progetto (header
`CRON_SECRET` Vercel). Da verificare in fase di piano come sono protetti
`bot-followups`/`send-batch` e seguire lo stesso schema.

## Modifiche al modello dati (migration Supabase)

Nuove colonne su `conversations` (nullable, nessun impatto sulle query esistenti):

- `ai_dropoff_stage text`
- `ai_objection_category text`
- `ai_objection_note text`
- `ai_insight_at timestamptz`

Nuova tabella `lead_analysis_reports`:

- `id bigint generated always as identity primary key`
- `generated_at timestamptz not null default now()`
- `period text not null default 'all'`  — periodo di riferimento del report
- `payload jsonb not null`  — top obiezioni, funnel blocchi, insight, conteggi

Dopo la migration: rigenerare `lib/supabase/types.ts` via MCP Supabase
(`generate_typescript_types`) e scriverlo su disco (l'MCP non scrive da solo).

## Nuovi file / modifiche principali

**UI**
- `app/(fenice)/fenice/lead/page.tsx` — pagina con tab:
  **Attive · Mai risposto · Ferme · Report · Analisi AI**.
- Componenti tab (liste lead per segmento, header report, vista analisi).
- Riuso del viewer chat esistente (`ConversationsPanel`) per aprire un lead.
- Voce "Lead" nella sidebar Fenice.

**API**
- `GET /api/fenice/segments` — conteggi per segmento + liste (con `segment`,
  `q`, `period`, limite come `/api/conversations`).
- `GET /api/fenice/report` — aggregati presi/non presi + breakdown.
- `GET /api/fenice/analysis` — ultimo `lead_analysis_reports`.
- `GET /api/cron/lead-analysis` — cron giornaliero (estrazione + aggregazione).

**Lib**
- `lib/lead-segments.ts` — funzione pura che, data una riga conversazione,
  restituisce il segmento + sotto-motivo. **Testata con unit test** (TDD).
- `lib/lead-analysis.ts` — estrazione Stadio 1 e aggregazione Stadio 2 via Claude
  (parsing robusto in JSON con categoria forzata nel set chiuso).

**Config**
- `vercel.json` — nuova entry cron giornaliera per `/api/cron/lead-analysis`.

## Testing

- `lib/lead-segments.ts`: unit test su tutti i rami (preso, mai risposto, attiva
  entro/oltre 22h, ferma per outcome, ferma per silenzio). TDD.
- `lib/lead-analysis.ts`: test sul parser/normalizzatore di categoria (set chiuso,
  fallback su `altro`) con risposte Claude mockate; nessuna chiamata reale nei test.
- API segments/report: test sulla logica di aggregazione con dati seed mockati.
- Typecheck con `npm run typecheck` (non `npx tsc`). Suite intera verde.

## Edge cases

- Lead enrollato ma template non ancora inviato (`last_inbound_at NULL`,
  `ai_status` active) → `MAI_RISPOSTO`. Corretto.
- Conversazione con esito `APPUNTAMENTO` ma poi riaperta → resta `PRESO` (priorità
  massima all'esito positivo).
- Chat con `ai_status='active'` ma ultimo inbound 5 giorni fa → `FERMA` (silente),
  anche se il cron non l'ha ancora chiusa (lead non-CRM senza follow-up).
- Categoria obiezione fuori dal set chiuso restituita da Claude → forzata a `altro`.
- Zero lead non-presi che hanno risposto → report Stadio 2 con messaggio "dati
  insufficienti", nessuna chiamata Claude sprecata.

## Fuori scope (YAGNI)

- Tracciamento iscrizione/acquisto reale del corso (oltre l'appuntamento).
- Modifica del traffico CRM non-Mario (`ai_owner IS NULL`).
- Azioni in bulk sui lead (invio messaggi di massa dai segmenti).
- Grafici storici dell'andamento conversione nel tempo (solo snapshot per periodo).
