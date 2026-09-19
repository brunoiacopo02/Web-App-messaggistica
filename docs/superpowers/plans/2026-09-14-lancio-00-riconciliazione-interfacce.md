# Lancio Web Dev AI — nota di riconciliazione fra i piani (B1…B5)

> ## ⚠️ SUPERATO IL 19/09/2026 — leggere prima di usare questo piano
>
> Il codice e gli esempi qui sotto sono quelli **come furono scritti allora** e si lasciano
> intatti perché questo è un piano eseguito, cioè un documento storico. Due regole delle
> restituzioni del lancio sono però cambiate dopo, e **vince quanto segue**:
>
> 1. **Le restituzioni partono il 7/10, non l'8.** Il 6 ottobre è tutto del bot (risposte e
>    follow-up); dal 7 si restituisce, così i GDO possono chiamare quei lead quel giorno
>    stesso. In codice: `restituzioniAttive` usa `>= dopodomani`, e `vercel.json` dice
>    `0 * 7-31 10 *`.
> 2. **L'attesa è di 24 ore, non 48, e si misura sull'ultimo messaggio in qualunque
>    direzione** (il follow-up mandato, o la risposta del lead se è arrivata dopo). Il
>    motivo `attesa_48h` si chiama ora `attesa_24h`. Chi è in conversazione viva resta al
>    bot (`ha_risposto`) e torna al pool più avanti, man mano che la chat si spegne — prima
>    un inbound dopo il follow-up lo tratteneva al bot per sempre.
>
> Fonte operativa aggiornata: `docs/lancio-webdev-runbook-b6.md`.

I sei piani sono stati scritti in parallelo da agenti diversi e alcuni nomi divergono. **Questa nota vince sui singoli piani.** Chi esegue un task legge il proprio piano e questa nota; dove il piano usa un nome "vecchio" della tabella sotto, usa quello canonico. I piani B1 (CRM e bot) sono la fonte di verità perché si eseguono per primi.

## CRM (`C:\Users\bruno\Desktop\CRM GDO`)

| Concetto | Canonico (B1-CRM) | Nomi da NON usare (dove compaiono) |
|---|---|---|
| Costanti del lancio | `src/lib/lancio/intake.ts`: `LANCIO_FUNNEL='Lancio Web Dev AI'`, `LANCIO_BUCKET='LANCIO_WEBDEV_2026'`, `LANCIO_SLUG='webdev-2026-10'`, `LANCIO_COMPANY='fenice'`, `type LancioIngresso`, `lancioFieldForLead()` | `src/lib/lancio/costanti.ts` con `LANCIO_WEBDEV_FUNNEL/_BUCKET/_SLUG` (B2 Task 11): **non crearlo**, importa da `intake.ts`. `LANCIO_WEBDEV_BUCKET` in `lancioReturnRules.ts` (B5 Task 10): importa `LANCIO_BUCKET` da `intake.ts` |
| Date/ore del lancio | `src/lib/lancio/config.ts` (B3 Task 2): `LANCIO_WEBDEV = { webinarAt, giornoDopo, dopodomani, oreVenditori, orePomeriggio }` + tipi `LancioScelta`, `LancioBotInfo`. Bucket/funnel/slug NON si ridefiniscono qui: `config.ts` li ri-esporta da `intake.ts` | — |
| Migrazione colonne `leads.lancio*` + riga `launchPools` | B1 Task 1 → `drizzle/migrations/0036_…sql` | B2 Task 11 "migrazione 0036" → **saltare** (B1 già fatto) |
| Migrazione `launchShifts` | B3 Task 1 → `0037_launch_shifts.sql` | — |
| Tipi evento | B1 aggiunge i 5 `LANCIO_*` all'unione `eventType` | B2 Task 13 "aggiungi LANCIO_INTAKE a eventLogger" → verificare che sia già presente, non duplicare |
| `pickAndAssignBuckets` e `assignedAt` | B1 Task 5 lo mette già in `coalesce(assignedAt, now())` | B5 Task 12 stessa modifica → **saltare la parte assignedAt**, tenere solo il contatore "restituiti" se non già presente nella card B1 (B1 lo legge già da `LANCIO_RETURNED_TO_POOL`: verificare e saltare) |
| Push al bot dei lead lancio | sempre con `lancio: lancioFieldForLead(lead)` nel payload (`BotIntakePayload.lancio?`) | — |
| Utente bot | `users.isBot = true`, company `fenice` (GDO 201) | — |
| Test runner | `node --test` via `npm test`; ogni nuovo `*.test.ts` va aggiunto alla riga `"test"` di `package.json` | — |
| Push su `origin/main` = deploy prod | si fa a fine blocco, dopo `npx tsc --noEmit && npm test && npx next build` verdi e migrazione applicata (MCP Supabase `apply_migration`) | — |

## Bot (`C:\Users\bruno\Desktop\Software Messaggistica`)

| Concetto | Canonico (B1-bot) | Nomi da NON usare (dove compaiono) |
|---|---|---|
| Impostare la fase | `impostaFaseLancio(supabase, conversationId, fase: LancioFase, campi?: { lancio_link_inviato_at?, lancio_followup_inviato_at?, lancio_info? })` in `lib/lancio-db.ts` — unico scrittore di `lancio_fase`, scrive da solo l'evento `lancio_fase_cambiata` | `setLancioFase(...)` in `lib/lancio-fase.ts` (B2 Task 3, B4, B5): **non crearla**; per un evento in più (es. `lancio_pulsante`) inserire una riga in `event_log` a parte, dopo la chiamata |
| Colonne `lancio_slug/lancio_ingresso/ai_status` all'ingresso | le scrive l'enroll (B1 Task 7) o il ramo B2 del webhook con un update diretto su `conversations`, poi `impostaFaseLancio` per la fase | — |
| Modulo puro delle fasi | `lib/lancio-fase.ts`: `LANCIO_SLUG`, `LANCIO_FASI`, `type LancioFase`, `LANCIO_FASI_TERMINALI`, `lancioInCorso(row)`, `FILTRO_FUORI_LANCIO`, `decideLancioTurno`, `contaScambiDomande`, testi fissi | B2 `LANCIO_SLUG_WEBDEV` → usare `LANCIO_SLUG` |
| Settings | `lib/lancio-settings.ts`: `getLancioSettings(supabase) → { attivo: boolean, zoomLink, videoLiveLink, offertaDelMeseLink, eventoAt }`, `setLancioSetting(supabase, key, value)`, `LANCIO_SETTING_KEYS` (chiavi DB: `lancio_attivo`, `lancio_zoom_link`, `lancio_video_live_link`, `offerta_del_mese_link`, `lancio_evento_at`) | B4 `LancioSettings` con le chiavi grezze e B5 `Record<key,string|null>` + `isLancioAttivo(s)`: usare l'oggetto di B1 (`s.attivo`, `s.zoomLink`…). B5 Task 1 (crea `lancio-settings.ts`) → **saltare**, aggiungere solo `validateLancioSettingInput` se serve alla pagina |
| Prompt e modello | `buildLancioSystem({ fase, nome, eventoAt })` in `lib/lancio-prompt.ts`; `generateLancioReply(history, opts) → { classe, passToHuman, visibleReply }` in `lib/lancio-reply.ts`; B4 estende `buildLancioSystem` con i rami `link_inviato`/`post_pitch` e aggiunge i tag `[LANCIO:CHIAMA_ORA]`, `[LANCIO:PRENOTA|iso]`, `[LANCIO:SLOTS]` al parser | B4 `lib/lancio-model.ts` → **non crearlo**, estendere `lancio-reply.ts` |
| Turno per fase | `eseguiTurnoLancio(supabase, {...}) → 'active'|'closed'|'handed_off'` in `lib/lancio-turno.ts`, con uno `switch` sulla fase; B4 aggiunge i rami `link_inviato` e `post_pitch` (può metterli in `lib/lancio-post-pitch.ts` e chiamarli dallo switch); B5 aggiunge il ramo `followup_inviato → chiuso` | B4 `lib/lancio-drain.ts`/`turnoLancio` → **non crearli** |
| Aggancio nel drain | B1 Task 8 mette il ramo lancio in `drainMarioReplies` (≈10 righe) PRIMA di Mario; B4/B5 non aggiungono un secondo ramo | — |
| Migrazione | B1 Task 1 `supabase/migrations/20260914000001_lancio_webdev.sql` (6 colonne + indice + seed `app_settings`) | B2 Task 2 e B5 Task 0 "migrazione di riserva" → **saltare** |
| Marker e provenienze | `lib/primo-messaggio.ts` (B2): `MARKER_PULSANTE_WEBINAR`, `classificaPrimoMessaggio`, `PROVENIENZA_LANCIO_WEBDEV` | — |
| `runPool` | `lib/run-pool.ts` (B4 Task 1 lo estrae da `send-batch`); B5 lo importa da lì, non lo ricrea | — |
| Reset esito all'arruolamento lancio | B1 Task 7: su conversazione riusata azzerare `bot_outcome`, `bot_outcome_at`, `bot_scheduled_at` (ritrovamento B5 #2) | — |
| Test runner | `bunx vitest run <file>`, tutti: `bun run test`; typecheck `bun run typecheck` | `bun test` da solo (runner di Bun, NON Vitest) |
| Migrazione prima del deploy | DDL via Supabase SQL Editor (Chrome) o Management API (vedi memoria del repo `reference_supabase_ddl_senza_pat`); il push su `origin/main` è il deploy | — |

## Marker congedo (B1, vincolante per B4 e B5)

Quando il bot manda la frase di congedo (il lead ha detto che non gli interessa), B1 scrive `congedo_at` dentro `conversations.lancio_info` (merge: le altre chiavi restano). Il marker si scrive **sull'invio della frase**, non sull'esito al CRM: se il CRM rifiuta il `DA_SCARTARE` la fase resta `attesa`, ma la persona si è già tirata indietro e le abbiamo promesso che non le scriviamo più.

Conseguenze, da rispettare senza eccezioni:

- **B4 (blast del link)** e **B5 (follow-up)** devono ESCLUDERE le righe con `lancio_info->>'congedo_at'` valorizzato, in aggiunta ai filtri che hanno già. PostgREST: `.is('lancio_info->>congedo_at', null)` (o equivalente: `.filter('lancio_info->>congedo_at', 'is', null)`). Senza questo filtro una chat congedata ma con la fase rimasta `attesa` (CRM giù al momento dello scarto) riceverebbe il link del 5 ottobre.
- **`congedoGiaInviato()`** (`lib/lancio-fase.ts`) può leggere prima il marker (`haCongedo(lancio_info)`, helper puro esportato da `lib/lancio-fase.ts`) e solo dopo la cronologia dei messaggi: il marker è una colonna, la cronologia è una query.
- La **riapertura** del webhook Twilio (`shouldReopen`) già non riapre una chat con `lancio_slug` valorizzato e `haCongedo(lancio_info)` vero: chi è stato congedato non torna a Mario se riscrive. La restituzione di fine lancio (B5) resta l'unico canale che lo tocca.

## Ordine di esecuzione
B1-CRM ∥ B1-bot → B2 (bot prima, poi CRM) → B3 (CRM) ∥ B4 (bot) → B5 (bot e CRM) → B6 prova generale.

## Buco di spec chiuso qui (ritrovamento B5 #3)
Chi ha interagito ma non ha mai ricevuto il follow-up entro la fine del 7/10 (cap 63049 per tutta la finestra, SID mancante) viene comunque restituito al pool dal 7/10 (aggiornato il 19/09; era l'8/10) con nota "Lancio: follow-up non inviato" (`motivo='followup_non_inviato'`, stesso ramo di `mai_risposto` lato CRM). B5 Task 7 aggiunge questo caso a `decideRestituzione`.
