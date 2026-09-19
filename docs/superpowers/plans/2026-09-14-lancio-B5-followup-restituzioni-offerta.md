# Lancio Web Developer AI — Blocco B5 (parte bot): follow-up del 6, restituzioni, offerta del mese — Piano di implementazione

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

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Riscritto il 16/09 notte e ribasato il 17/09** contro il codice reale di `feat/lancio-webdev` @ **`f5c8ad6`** (= `main`; B1+B2+B4 completi, compresi i fix finali del B4: `impostaFaseLancio` con `soloDaFasi`, il ramo lancio del drain a giri `MAX_GIRI_LANCIO` con `rileggiRigaLancio`, `congedoEsplicito`, `modoEtichette`, e l'invio dall'account che possiede il numero `lib/twilio-account.ts`) e contro i rulings del controller (`.superpowers/sdd/2026-09-14-lancio-B5-followup-restituzioni-offerta/progress.md`, "Rulings del 16/09 notte" + i 5 rulings della seconda passata del 17/09). Le due versioni precedenti (`preflight-proposto.md`, `preflight-piano-nuovo.md`) sono superate. La parte CRM del B5 è **già in produzione** (vedi la sezione "Già in produzione") e qui non si esegue. Ogni `file:riga` citato sotto è di `f5c8ad6`.

**Goal:** Il 6 e il 7 ottobre il bot manda il follow-up (template `LANCIO_FOLLOWUP_TEMPLATE_SID`) a chi ha interagito dopo il benvenuto ma non ha scelto la sera del 5, escludendo chi si è congedato e chi ha appena detto "no"; chi risponde entra nel flusso Mario standard con il video della live editata al posto dei quattro video classici; dall'8/10 chi non ha mai risposto, chi tace 48 ore dopo il follow-up e chi il follow-up non l'ha mai ricevuto torna al CRM come `NON_RISPOSTO` con la nota che il CRM già riconosce; un lead restituito che riscrive non torna al bot; le otto impostazioni del lancio si cambiano da `/fenice/impostazioni`; il video "offerta del mese" dell'agenda GDO viene da `offerta_del_mese_link`.

**Architecture:** Due cron a data fissa (`/api/cron/lancio-followup`, `/api/cron/lancio-restituzioni`) costruiti sullo **stesso motore del blast Zoom**, estratto dal cron `lancio-zoom` in `lib/lancio-blast-motore.ts` (lotti da `LANCIO_BATCH_MAX`, timbro compare-and-set PRIMA di Twilio, 63049 per destinatario = `capped`, esito incerto = timbro tenuto, freno `decideFreno` sui tentativi, `logCronQueryError`, `forza` e `now` solo con `solo=<id>`, mittente da `settings.sender`). Le decisioni stanno in moduli puri testati (`lib/lancio-followup.ts`, `lib/lancio-restituzioni.ts`) e riusano i mattoni del B1/B4 (`haCongedo`, `congedoEsplicito`, `marcaCongedo`, `congedoLancio`, `impostaFaseLancio` con `soloDaFasi`, `sendOutcome`, `giorniLancio`). Il ramo `followup_inviato` entra nello `switch` di `eseguiTurnoLancio` e restituisce un quarto stato, `'handed_to_mario'`, che **non è uno stato di `ai_status`**: il drain lo intercetta nel ciclo dei giri del lancio, esce dal ramo lancio e prosegue nel flusso standard di Mario **nello stesso drain**, con una `contextNote` che porta il link della live. Le restituzioni si segnano `restituito` solo quando il CRM **conferma** il ritorno nel pool (`returnedToPool: true` o `skipped: 'already_returned'` nel corpo della risposta, che `sendOutcome` ora espone). Le impostazioni restano l'oggetto camelCase a 8 chiavi di `lib/lancio-settings.ts` (ruling R1): si aggiungono solo validazione, pagina e API.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase (postgrest-js), Twilio WhatsApp (Content API), Vitest (`bunx vitest run <file>`), `bun run typecheck`, cron in `vercel.json`.

**Spec:** `docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md` — §3.2 (colonne e chiavi), §5.5 (follow-up e flusso standard), §5.7 (offerta del mese e pagina impostazioni), §5.8 (restituzione al pool), §6.2 (contratto: `NON_RISPOSTO`/`INTERROTTO` sui lead lancio = ritorno al pool), §7.3 (testo del follow-up), §11 e §11.1 (numero, capacità, freno, mittente). Nota che vince sui piani: `docs/superpowers/plans/2026-09-14-lancio-00-riconciliazione-interfacce.md` (nomi canonici, marker congedo, "buco di spec": `followup_non_inviato`).

## Global Constraints

- **Comandi.** Test: `bunx vitest run <file>` (tutti: `bun run test`). **Mai `bun test`** (è il runner di Bun, non Vitest). Typecheck: `bun run typecheck`. `bun run lint` non è un cancello di questo repo (ruling B4: `main` ne ha centinaia). Ogni task chiude con i test dei file toccati verdi + `bun run typecheck` verde, poi commit.
- **Regex:** il flag `/s` non compila (target < es2018): usare `[\s\S]*`.
- **Orari:** solo gli helper di `lib/rome-time.ts` (`romeDayKey`, `romeHour`, `romeMinute`, `formatRomeDateTime`) e `giorniLancio(eventoAt)` di `lib/lancio-scelta.ts`. Le date del lancio si **derivano** da `app_settings.lancio_evento_at` (`2026-10-05T21:00:00+02:00`), mai scritte a mano nel codice; solo gli schedule di `vercel.json` sono a data fissa (Vercel non sa leggere le impostazioni). Fuso `+02:00` fino al 25/10: 12:00 Roma = 10:00 UTC, 17:30 Roma = 15:30 UTC.
- **Nomi canonici (riconciliazione):** `impostaFaseLancio(supabase, id, fase, campi?)` è l'unico scrittore di `lancio_fase`; `getLancioSettings(supabase) → LancioSettings { attivo, pulsanteAttivo, zoomLink, videoLiveLink, offertaDelMeseLink, eventoAt, blastPerimetro, sender }` (8 chiavi, **non** un `Record`); `setLancioSetting(supabase, key, value: string | boolean)`; `runPool` da `lib/run-pool.ts`; `LANCIO_BATCH_MAX` è la **env** già letta da `batchMax()` (default 200, `lib/lancio-zoom-blast.ts`): nessuna costante omonima altrove.
- **Marker congedo (vincolante):** il follow-up ESCLUDE le righe con `lancio_info->>'congedo_at'` valorizzato, in query (`.is('lancio_info->>congedo_at', null)`) e in memoria (`haCongedo`), come il blast (ruling C4).
- **Numero WhatsApp (spec §11):** lotti da `LANCIO_BATCH_MAX` (200) ogni 5 minuti; freno automatico (`decideFreno`: >10 % non arrivati su ≥20 tentativi, o 63018/63051) che spegne `lancio_attivo`; 63049 è per destinatario: `capped`, timbro liberato, il run continua; errore Twilio **senza codice** = esito incerto, timbro **tenuto**, nessun ritentativo (ruling B4 I3); mittente da `settings.sender` con warn `lancio_sender_secondario_non_disponibile` se `secondario` (il secondo numero non ha il KYC: resta plumbing spento); template approvati **UTILITY** (il presidio `UTILITY_ONLY` ferma il run con `template_bloccato`). Il follow-up è "il messaggio più marketing del lancio" (§11.9): va SOLO a chi ha interagito. **Nessun messaggio spontaneo** oltre al template del follow-up: il video della live e quello dell'offerta viaggiano in testo libero dentro una conversazione aperta dal lead.
- **Testi:** nessuna promessa o prezzo nuovo nei testi verso il lead o nei prompt. Il testo del follow-up è quello approvato (§7.3), replicato per la cronologia. Le note al CRM per le restituzioni sono **esattamente** `"Lancio: mai risposto"`, `"Lancio: silenzio dopo il follow-up"`, `"Lancio: follow-up non inviato"` (il CRM le riconosce con `motivoRestituzioneDaNota`, `CRM GDO/src/lib/bot-fissatore/lancioReturnRules.ts`).
- **Vincoli del PO:** i lead che scrivono per primi da Telegram non si toccano (`classificaPrimoMessaggio` invariata); **mai un secondo benvenuto** (le guardie del B1 restano); lo `ScriptWidget` è lato CRM e non si tocca; la finestra del form Calendly/Jotform non si tocca; i canali realtime del CRM non si toccano.
- **Altra sessione nello stesso albero:** `lib/twilio.ts` / `lib/twilio.test.ts` possono avere modifiche non committate di un'altra sessione (`TWILIO_AUTH_TOKEN_2`). Non dipendere da quel lavoro, non toccare quei file, e **aggiungere i file al commit per nome** (mai `git add -A` o `git add .`).
- **Commit:** in italiano, uno per task, con in coda le due righe
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD`
  Push su `origin/main` (= deploy prod) solo a blocco finito, dopo la review e la checklist del Task 9.
- **Nessuna migrazione.** Le colonne usate esistono già in `lib/supabase/types.ts` (verificato a `f5c8ad6`): `conversations.lancio_slug / lancio_fase / lancio_ingresso / lancio_link_inviato_at / lancio_followup_inviato_at / lancio_info / lancio_benvenuto_at / ai_paused_at / handed_off_at / last_inbound_at / bot_outcome / crm_lead_id`. Le 8 chiavi `app_settings` sono seedate dalla migrazione `20260914000001_lancio_webdev.sql` (applicata in prod il 16/09).
- **Test dei cron:** stessa forma di `app/api/cron/lancio-zoom/route.test.ts` (finto Supabase che registra ogni chiamata e simula il compare-and-set del timbro e la guardia `soloDaFasi` di `impostaFaseLancio`; `vi.mock('@/lib/supabase/admin')`, `vi.mock('@/lib/twilio')`, `vi.mock('@/lib/lancio-db')`; orologio con `vi.useFakeTimers()` + `vi.setSystemTime`). I **42** test del cron Zoom **non si toccano** e devono restare verdi dopo il Task 1: sono il contratto del refactor (tre di essi asseriscono il quinto argomento `{ soloDaFasi: ['attesa', 'posto_bloccato'] }`).
- **Scrittura della fase dai cron:** sempre `impostaFaseLancio(supabase, id, fase, campi, { soloDaFasi })` — compare-and-set sulla fase di partenza (`lib/lancio-db.ts:14-29`, commit `746492e`): un cron scrive in parallelo a un turno che può aver portato la chat avanti (`post_pitch` dal pulsante, `posto_bloccato` dal turno dell'attesa); senza guardia la fase tornerebbe indietro col template ormai partito. Dentro un turno (già serializzato dal lucchetto del drain) la guardia non serve.
- **`ai_status` ammette solo `active | replying | closed | booked | handed_off`.** Nessun valore nuovo: il quarto stato del turno lancio (`'handed_to_mario'`) è un segnale interno al drain e non deve MAI finire in `finalStatus` (che a `lib/fenice-autoreply.ts:1046` viene scritto grezzo in `conversations.ai_status`).
- **Mittente:** `sendTemplate`/`sendFreeText` scelgono da soli l'account Twilio dal numero `from` (`lib/twilio-account.ts`, `credenzialiPerMittente`): i cron passano `from = TWILIO_WHATSAPP_NUMBER_FENICE` come oggi e non toccano `lib/twilio.ts`.
- **Baseline della suite:** il Task 0 annota `bun run test` PRIMA di ogni modifica (numero di file e di test a `f5c8ad6`); il Task 9 richiede un numero **maggiore** di test e mai un file in meno.

## Già in produzione (lato CRM — non si esegue)

CRM GDO `main` @ `2c60668` (merge `feat/lancio-webdev`): `src/lib/bot-fissatore/lancioReturnRules.ts` (`LancioReturnMotivo = 'mai_risposto' | 'silenzio_dopo_followup' | 'followup_non_inviato'`, `motivoRestituzioneDaNota`, `checkLancioReturnToPool`, `isAlreadyReturned`), `src/lib/bot-fissatore/lancioReturn.ts` (`returnLancioLeadToPool`: torna nel pool di `/import`, evento `LANCIO_RETURNED_TO_POOL`), ramo in `src/app/api/bot/outcome/route.ts` (`NON_RISPOSTO`/`INTERROTTO` su lead `LANCIO_WEBDEV_2026` assegnati al bot → pool, non round robin; un esito ripetuto su un lead già restituito risponde **200** `{ skipped: 'already_returned' }`, non 403 — commit `5bd1ac4`), `AgendaButton` con "Offerta del mese" come pulsante evidente (il payload di `/api/send-agenda` è invariato: `variant.offertaDelMese: boolean`, contratto v1.6). Qui si assume tutto questo come dato.

## Rulings vincolanti → task

| Ruling | Contenuto | Task |
|---|---|---|
| R1 | `lib/lancio-settings.ts` si ESTENDE (8 chiavi camelCase), mai riscritto | T7 (solo validazione + pagina) |
| R2 | `followup_non_inviato` DENTRO: dall'8/10 chi ha interagito senza mai ricevere il follow-up torna al pool con `"Lancio: follow-up non inviato"` | T5 |
| R3 | Il cron follow-up RIUSA il motore del blast, estratto in un nucleo condiviso; il cron Zoom resta identico nel comportamento (test verdi) | T1, T3 |
| C1 | Il follow-up classifica l'ULTIMO inbound: "no" netto → non si manda, `marcaCongedo` + `DA_SCARTARE` "non interessato" + fase `chiuso`, **nessuna bolla** | T2, T3 |
| C2 | Sweeper nel cron restituzioni (pre-passo): `congedo_at` presente e fase ≠ `chiuso` → ritenta `DA_SCARTARE` senza bolla; su accettazione fase `chiuso` | T5 |
| C4 | Il follow-up esclude `congedo_at` in query e in memoria | T2, T3 |
| C5 | `MARKER_PULSANTE_RE` in `lancio-scelta.ts` sostituita dall'import da `primo-messaggio.ts` | T0 |
| C6 | Freno + mittente per fase anche sul follow-up | T1, T3 |
| C7 | `lancio_attivo=false` in finestra: il cron follow-up non manda e scrive `lancio_followup_fermo` warn con `motivo: 'lancio_attivo_spento'` a ogni run della finestra | T3, T9 (runbook) |
| C8 | `shouldReopen` mette il VETO su `lancio_fase='restituito'`; l'inbound produce `lancio_inbound_dopo_restituzione` + `sendCrmNota`; il bot non risponde | T6 |
| C9 | Solo verifica: `chiuso` senza esito torna ai cron di Mario | T4 |
| Finestre | 6/10 12:00–14:00 e 17:30–19:30 Roma, a lotti; sconfina al 7/10 stesse finestre; 63049 = `capped`, non grave | T2, T3 |
| Flusso standard | Chi risponde al follow-up riusa il percorso Mario esistente con `settings.videoLiveLink` al posto del video classico; link vuoto → video classico + evento warn | T4 |
| Pagina | Tutte le 8 chiavi, validazione, ruolo admin | T7 |
| Offerta | Payload agenda invariato; il bot manda il video da `settings.offertaDelMeseLink`; link vuoto → non manda + evento warn | T8 |

Ordine: T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9. T2 non tocca file di T1 e può correre in parallelo a T1. **In serie, mai in parallelo:** T3 e T5 (entrambi scrivono `vercel.json`); T4 → T6 → T8 (tutti e tre scrivono `lib/fenice-autoreply.ts`: T4 il drain, T6 `shouldReopen`, T8 `linkExtra`); T2 → T4 (`lib/lancio-followup.ts`). T7 tocca solo `lancio-settings.ts`, `access.ts`, l'API e la pagina: può correre in parallelo a T5-T8 (T8 importa da `lancio-settings.ts` solo un tipo che esiste già).

---

### Task 0 (BOT): pulizia — il marker del pulsante vive solo in `primo-messaggio.ts` (ruling C5)

**Files:**
- Modify: `lib/lancio-scelta.ts` (riga 299 `export const MARKER_PULSANTE_RE`, riga 307 il `.filter(...)` di `raccogliRisposte`)
- Modify: `lib/lancio-scelta.test.ts` (riga 5 import, riga 222 uso)

**Interfaces:**
- Consumes: `isMarkerPulsanteWebinar(body)` e `MARKER_PULSANTE_WEBINAR` da `lib/primo-messaggio.ts` (B2, già usati da `lancio-fase.ts` e `lancio-post-pitch.ts`).
- Produces: niente di nuovo; `MARKER_PULSANTE_RE` **sparisce** da `lancio-scelta.ts`.

Altri duplicati trovati nella ricognizione, e cosa se ne fa: `eRifiutoDiPolicy`, `authorized`, `logEvento` sono copiati in `app/api/cron/lancio-zoom/route.ts` e `app/api/cron/lancio-aperture/route.ts` → il Task 1 li mette nel motore e li importa nei due cron del lancio (gli altri 14 cron con `authorized` copiato sono preesistenti e fuori perimetro); `PROVENIENZA_LANCIO = PROVENIENZA_LANCIO_WEBDEV` in `lancio-post-pitch.ts` è un alias, non un duplicato; `CODICE_FREQUENCY_CAP = 63049` (`lib/lancio-aperture.ts`) è l'unica definizione e il motore la importa.

- [ ] **Step 0: Baseline della suite (una volta sola, prima di qualunque modifica)**

Run: `bun run test 2>&1 | tail -5 && bun run typecheck`
Expected: tutto verde a `f5c8ad6`. Annota nel messaggio di chiusura del task le due cifre `Test Files N passed` e `Tests M passed`: sono la baseline che il Task 9 confronta.

- [ ] **Step 1: Scrivi il test che fallisce**

In `lib/lancio-scelta.test.ts` togli `MARKER_PULSANTE_RE` dall'import di `./lancio-scelta` (riga 5) e aggiungi sotto gli import:

```ts
import * as scelta from './lancio-scelta';
import { MARKER_PULSANTE_WEBINAR } from './primo-messaggio';
```

Alla riga 222 sostituisci `MARKER_PULSANTE_RE.test(` con `MARKER_PULSANTE_WEBINAR.test(`. Aggiungi in coda al file:

```ts
describe('il marker del pulsante vive solo in primo-messaggio (ruling C5)', () => {
  it('lancio-scelta non esporta piu una copia della regex', () => {
    expect('MARKER_PULSANTE_RE' in scelta).toBe(false);
  });
  it('raccogliRisposte scarta il testo del pulsante anche con altre maiuscole o senza emoji', () => {
    const info = raccogliRisposte(null, ['Ho seguito la LIVE Web Developer AI e voglio saperne di più', 'faccio il barista']);
    expect(info.risposte).toEqual(['faccio il barista']);
  });
});
```

Run: `bunx vitest run lib/lancio-scelta.test.ts`
Expected: FAIL sul primo caso nuovo (`'MARKER_PULSANTE_RE' in scelta` è ancora `true`); il secondo passa già (la regex era identica) e fissa il comportamento che deve sopravvivere.

- [ ] **Step 2: Togli la copia**

In `lib/lancio-scelta.ts` aggiungi in testa `import { isMarkerPulsanteWebinar } from './primo-messaggio';`, cancella le righe

```ts
/** Il testo precompilato del pulsante (spec §6.3): non è una risposta del lead. */
export const MARKER_PULSANTE_RE = /live web developer ai/i;
```

e in `raccogliRisposte` sostituisci `.filter((s) => s.length > 0 && !MARKER_PULSANTE_RE.test(s))` con `.filter((s) => s.length > 0 && !isMarkerPulsanteWebinar(s))`.

- [ ] **Step 3: Verifica**

Run: `grep -rn "MARKER_PULSANTE_RE" lib app --include=*.ts --include=*.tsx`
Expected: nessuna riga.
Run: `bunx vitest run lib/lancio-scelta.test.ts lib/lancio-post-pitch.test.ts && bun run typecheck`
Expected: PASS, nessun errore di tipo.

- [ ] **Step 4: Commit**

```bash
git add lib/lancio-scelta.ts lib/lancio-scelta.test.ts
git commit -m "chore(lancio): il marker del pulsante vive solo in primo-messaggio, tolta la copia in lancio-scelta

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 1 (BOT): `lib/lancio-blast-motore.ts` — il nucleo condiviso del blast, e il cron Zoom ricablato su di esso (ruling R3, C6)

**Files:**
- Create: `lib/lancio-blast-motore.ts`
- Create: `lib/lancio-blast-motore.test.ts`
- Modify: `app/api/cron/lancio-zoom/route.ts` (righe 1-23 import; 49-63 costanti, `FASI_BERSAGLIO` e `Esito`; 74-110 `authorized`/`orologio`/`eRifiutoDiPolicy`/`logEvento`; 152-162 orologio+forza; 244-267 paginazione; 297-507 contatori e `inviaUno`; 509-544 ciclo a blocchi)
- Modify: `app/api/cron/lancio-aperture/route.ts` (solo la funzione locale `eRifiutoDiPolicy`, righe 55-65 docblock compreso)
- Non toccare: `app/api/cron/lancio-zoom/route.test.ts`, `lib/lancio-zoom-blast.ts`

**Interfaces:**
- Consumes: `sendTemplate` (`lib/twilio.ts`, firma `sendTemplate({ to, contentSid, variables, from }) → { sid, status }`, lancia con `code?: number`), `impostaFaseLancio` (`lib/lancio-db.ts`), `setLancioSetting` (`lib/lancio-settings.ts`), `runPool` (`lib/run-pool.ts`), `decideFreno` (`lib/lancio-zoom-blast.ts`), `CODICE_FREQUENCY_CAP` (`lib/lancio-aperture.ts`), `logCronQueryError` (`lib/cron-query-error.ts`).
- Produces (tutto esportato da `lib/lancio-blast-motore.ts`):
  - `PASSO_FRENO = 25`, `TEMPO_MASSIMO_MS = 240_000`, `MAX_PAGINE = 20`, `PAGINA = 1000`
  - `type EsitoInvio = 'sent' | 'riparato' | 'capped' | 'failed' | 'incerto' | 'skip' | 'errore' | 'bloccato'`
  - `type ColonnaTimbro = 'lancio_link_inviato_at' | 'lancio_followup_inviato_at'`
  - `type StatoRun = { fermo: string | null; tentati: number; codici: (number | string)[] }`, `nuovoStatoRun()`
  - `autorizzatoCron(req)`, `leggiParametriCron(req, { nowRichiedeSolo })`, `eRifiutoDiPolicy(e)`, `logEvento(supabase, type, payload, message, level?)`
  - `leggiCoda<T>(supabase, tipoErrore, leggiPagina) → { righe: T[]; queryKo: boolean }`
  - `timbroUpdate(colonna, valore: string | null)` (l'oggetto per l'update postgrest) e `timbroCampi(colonna, valore: string)` (l'oggetto per `impostaFaseLancio`)
  - `inviaTemplateTimbrato(supabase, stato, p: InvioTimbrato) → Promise<EsitoInvio>` — `InvioTimbrato.soloDaFasi: readonly LancioFase[]` è **obbligatorio** e viene passato a `impostaFaseLancio` sia nella riparazione sia dopo l'invio (ruling R3 della seconda passata: la guardia contro il turno concorrente vale per il blast e per il follow-up)
  - `eseguiLotti<T>(lotto, stato, { concorrenza, t0, inviaUno, suFreno }) → Promise<ContiLotti>`
  - `frenaLancio(supabase, stato, conti, { prefisso, etichetta, candidati, lotto })`

Cosa resta nel cron Zoom (non è del motore): la finestra `inFinestraBlast`/`finestraBlastChiusa` dall'evento, la query `bersaglio` (fasi, perimetro, congedo) e la costante `FASI_BERSAGLIO` (riga 61, tipata `readonly LancioFase[]`: **resta**, la usano la query e `soloDaFasi`), `ordinaCandidatiBlast`, il conteggio dei residui a serata finita, il run event `lancio_zoom_run`, le variabili del template (`{{1}}` nome, `{{2}}` link).

- [ ] **Step 1: Test del motore (le parti pure e il ciclo a blocchi)**

```ts
// lib/lancio-blast-motore.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  leggiParametriCron, eRifiutoDiPolicy, eseguiLotti, nuovoStatoRun, timbroUpdate, timbroCampi, PASSO_FRENO,
  type EsitoInvio,
} from './lancio-blast-motore';

const req = (qs: string) => ({ nextUrl: new URL(`https://x/api/cron/x?${qs}`), headers: new Headers() }) as unknown as NextRequest;

describe('leggiParametriCron', () => {
  it('forza=1 senza solo è un errore, con solo passa', () => {
    expect(leggiParametriCron(req('forza=1'), { nowRichiedeSolo: false })).toEqual({ ok: false, errore: 'forza=1 richiede solo=<conversationId>' });
    const r = leggiParametriCron(req('forza=1&solo=7'), { nowRichiedeSolo: false });
    expect(r).toMatchObject({ ok: true, forza: true, solo: 7, dry: false });
  });
  it('now= sposta l orologio; con nowRichiedeSolo vale solo insieme a solo=', () => {
    const libero = leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00'), { nowRichiedeSolo: false });
    expect(libero.ok && libero.now.toISOString()).toBe('2026-10-06T10:10:00.000Z');
    expect(leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00'), { nowRichiedeSolo: true })).toEqual({ ok: false, errore: 'now=<iso> richiede solo=<conversationId>' });
    const conSolo = leggiParametriCron(req('now=2026-10-06T12:10:00%2B02:00&solo=3'), { nowRichiedeSolo: true });
    expect(conSolo.ok && conSolo.now.toISOString()).toBe('2026-10-06T10:10:00.000Z');
  });
  it('now illeggibile = ora vera; dry=1 letto', () => {
    const r = leggiParametriCron(req('now=ieri&dry=1'), { nowRichiedeSolo: false });
    expect(r.ok && Math.abs(r.now.getTime() - Date.now()) < 5_000).toBe(true);
    expect(r.ok && r.dry).toBe(true);
  });
});

describe('eRifiutoDiPolicy', () => {
  it('riconosce il presidio UTILITY_ONLY, non un codice Twilio', () => {
    expect(eRifiutoDiPolicy(new Error('template HX1 bloccato: categoria MARKETING con UTILITY_ONLY attivo'))).toBe(true);
    expect(eRifiutoDiPolicy(new Error('categoria del template HX1 non verificabile (HTTP 500)'))).toBe(true);
    expect(eRifiutoDiPolicy(Object.assign(new Error('giu'), { code: 21211 }))).toBe(false);
    expect(eRifiutoDiPolicy(new Error('socket hang up'))).toBe(false);
  });
});

describe('timbroUpdate', () => {
  it('produce l oggetto con la sola colonna chiesta', () => {
    expect(timbroUpdate('lancio_link_inviato_at', 'T')).toEqual({ lancio_link_inviato_at: 'T' });
    expect(timbroUpdate('lancio_followup_inviato_at', null)).toEqual({ lancio_followup_inviato_at: null });
    expect(timbroCampi('lancio_followup_inviato_at', 'T')).toEqual({ lancio_followup_inviato_at: 'T' });
  });
});

describe('eseguiLotti', () => {
  afterEach(() => vi.useRealTimers());
  const lotto = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('conta gli esiti e non chiama il freno se va tutto bene', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn();
    const conti = await eseguiLotti(lotto(30), stato, {
      concorrenza: 5, t0: Date.now(), suFreno,
      inviaUno: async (id): Promise<EsitoInvio> => { stato.tentati++; return id % 10 === 0 ? 'capped' : 'sent'; },
    });
    expect(conti).toMatchObject({ inviati: 27, capped: 3, falliti: 0, incerti: 0, saltati: 0, errori: 0, riparati: 0 });
    expect(conti.report).toHaveLength(30);
    expect(suFreno).not.toHaveBeenCalled();
    expect(stato.fermo).toBeNull();
  });

  it('si ferma al primo blocco se non arriva niente: il denominatore sono i tentativi', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn(async () => {});
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0: Date.now(), suFreno,
      inviaUno: async (): Promise<EsitoInvio> => { stato.tentati++; stato.codici.push(21211); return 'failed'; },
    });
    expect(conti.falliti).toBe(PASSO_FRENO);
    expect(conti.report).toHaveLength(PASSO_FRENO);
    expect(stato.fermo).toBe('freno');
    expect(suFreno).toHaveBeenCalledTimes(1);
  });

  it('gli incerti pesano come falliti nel freno', async () => {
    const stato = nuovoStatoRun();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0: Date.now(), suFreno: async () => {},
      inviaUno: async (): Promise<EsitoInvio> => { stato.tentati++; return 'incerto'; },
    });
    expect(conti.incerti).toBe(PASSO_FRENO);
    expect(stato.fermo).toBe('freno');
  });

  it('un fermo messo dal worker (template bloccato) interrompe il ciclo senza freno', async () => {
    const stato = nuovoStatoRun();
    const suFreno = vi.fn();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 1, t0: Date.now(), suFreno,
      inviaUno: async (): Promise<EsitoInvio> => { if (stato.fermo) return 'skip'; stato.fermo = 'template_bloccato'; return 'bloccato'; },
    });
    expect(conti.report.length).toBe(PASSO_FRENO);
    expect(conti.saltati).toBe(PASSO_FRENO - 1);
    expect(stato.fermo).toBe('template_bloccato');
    expect(suFreno).not.toHaveBeenCalled();
  });

  it('la sveglia dei 240s ferma il ciclo con fermo=tempo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
    const stato = nuovoStatoRun();
    const t0 = Date.now();
    const conti = await eseguiLotti(lotto(60), stato, {
      concorrenza: 5, t0, suFreno: async () => {},
      inviaUno: async (): Promise<EsitoInvio> => { vi.setSystemTime(Date.now() + 20_000); stato.tentati++; return 'sent'; },
    });
    expect(stato.fermo).toBe('tempo');
    expect(conti.inviati).toBe(PASSO_FRENO);
  });
});
```

Run: `bunx vitest run lib/lancio-blast-motore.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 2: Implementa `lib/lancio-blast-motore.ts`**

```ts
import type { NextRequest } from 'next/server';
import type { getSupabaseAdmin } from './supabase/admin';
import type { LancioFase } from './lancio-fase';
import { sendTemplate } from './twilio';
import { impostaFaseLancio } from './lancio-db';
import { setLancioSetting } from './lancio-settings';
import { runPool } from './run-pool';
import { decideFreno } from './lancio-zoom-blast';
import { CODICE_FREQUENCY_CAP } from './lancio-aperture';
import { logCronQueryError } from './cron-query-error';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il motore degli invii a lotti del lancio (spec §11), estratto dal cron del blast Zoom
 * (B4, `app/api/cron/lancio-zoom/route.ts`) perche' il follow-up del 6 (B5) faccia le
 * stesse cose nello stesso modo. Quello che sta qui NON sa che cosa manda ne' a chi:
 * riceve un lotto gia' scelto e un worker che gli dice come costruire il messaggio.
 *
 * Le quattro difese, nell'ordine in cui contano:
 *  0. FASE. La fase dopo l'invio si scrive con `impostaFaseLancio(..., { soloDaFasi })`,
 *     un compare-and-set sulla fase di partenza: mai riportare indietro una chat che un
 *     turno concorrente ha gia' portato avanti (commit 746492e).
 *  1. IDEMPOTENZA. Il timbro (`colonna`) e' insieme il filtro dei candidati e il
 *     lucchetto: si scrive PRIMA di chiamare Twilio con un compare-and-set, e si libera
 *     SOLO se a Twilio non e' partito niente (codice Twilio presente). Un errore senza
 *     codice — timeout, connessione caduta — lascia il timbro dov'e': un lead senza
 *     messaggio si recupera a mano, un lead con due template sullo stesso numero a
 *     qualita' LOW e' danno al mittente.
 *  2. FRENO. Ogni `PASSO_FRENO` invii `decideFreno` guarda i TENTATIVI (riusciti +
 *     falliti + cap + incerti): sopra il 10 % di non arrivati, o al primo 63018/63051, il
 *     run si ferma e `frenaLancio` spegne `lancio_attivo`. Il 63049 e' del destinatario:
 *     si conta come `capped`, il timbro si libera, il run continua.
 *  3. TEMPO. `TEMPO_MASSIMO_MS` sotto `maxDuration = 300`: ci si ferma con un minuto di
 *     margine per scrivere il riepilogo, i residui li prende il run dopo.
 */

/** Ogni quanti invii si rivaluta il freno (con lotti da 200 e concorrenza 5: 8 volte). */
export const PASSO_FRENO = 25;
/** `maxDuration` e' 300s: ci si ferma a 240 per avere il tempo del riepilogo. */
export const TEMPO_MASSIMO_MS = 240_000;
/** Paracadute sulla paginazione dei candidati: 20.000 e' gia' un'anomalia da guardare. */
export const MAX_PAGINE = 20;
export const PAGINA = 1000;

export type EsitoInvio = 'sent' | 'riparato' | 'capped' | 'failed' | 'incerto' | 'skip' | 'errore' | 'bloccato';
export type ColonnaTimbro = 'lancio_link_inviato_at' | 'lancio_followup_inviato_at';

/** Lo stato condiviso fra i worker di un run: il fermo e i numeri che il freno legge. */
export type StatoRun = { fermo: string | null; tentati: number; codici: (number | string)[] };
export const nuovoStatoRun = (): StatoRun => ({ fermo: null, tentati: 0, codici: [] });

export function autorizzatoCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export type ParametriCron =
  | { ok: true; now: Date; forza: boolean; solo: number | null; dry: boolean }
  | { ok: false; errore: string };

/**
 * I parametri della prova generale (B6). `forza=1` salta SOLO il filtro della finestra e
 * vale SOLO con `solo=<conversationId>`: senza, un run forzato fuori data manderebbe il
 * template a tutta la coda. `now=<iso>` sposta l'orologio; chi lo vuole confinato alla
 * singola conversazione passa `nowRichiedeSolo: true` (il follow-up), il blast Zoom lo
 * lascia libero perche' i suoi test lo usano cosi' (ruling R3: il cron Zoom non cambia).
 */
export function leggiParametriCron(req: NextRequest, opts: { nowRichiedeSolo: boolean }): ParametriCron {
  const sp = req.nextUrl.searchParams;
  const forza = sp.get('forza') === '1';
  const soloRaw = parseInt(sp.get('solo') ?? '', 10);
  const solo = Number.isFinite(soloRaw) ? soloRaw : null;
  const nowRaw = sp.get('now');
  if (forza && solo === null) return { ok: false, errore: 'forza=1 richiede solo=<conversationId>' };
  if (opts.nowRichiedeSolo && nowRaw && solo === null) return { ok: false, errore: 'now=<iso> richiede solo=<conversationId>' };
  const t = nowRaw ? Date.parse(nowRaw) : NaN;
  return { ok: true, now: Number.isNaN(t) ? new Date() : new Date(t), forza, solo, dry: sp.get('dry') === '1' };
}

/**
 * Il presidio categoria (`UTILITY_ONLY`, `assertTemplateSendable` dentro `sendTemplate`)
 * ha detto no: nessuna chiamata a Twilio e' partita. Vale identico per ogni
 * conversazione, quindi il run si ferma invece di sbatterci contro duecento volte.
 */
export function eRifiutoDiPolicy(e: { message?: string; code?: number }): boolean {
  if (typeof e?.code === 'number') return false;
  const m = e?.message ?? '';
  return m.includes('bloccato: categoria') || m.includes('non verificabile');
}

export async function logEvento(
  supabase: Supa,
  type: string,
  payload: Record<string, unknown>,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  await supabase.from('event_log').insert({ type, payload: payload as never, message, level });
}

/**
 * Legge TUTTA la coda a pagine di `PAGINA`. Una query fallita torna `data: null`, cioe'
 * zero candidati: senza `queryKo` il run risponderebbe `sent: 0` identico a una coda
 * vuota (e' il caso della migrazione non applicata, Postgres 42703).
 */
export async function leggiCoda<T>(
  supabase: Supa,
  tipoErrore: string,
  leggiPagina: (da: number, a: number) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
): Promise<{ righe: T[]; queryKo: boolean }> {
  const righe: T[] = [];
  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    const { data, error } = await leggiPagina(pagina * PAGINA, pagina * PAGINA + PAGINA - 1);
    if (error) {
      await logCronQueryError(supabase, tipoErrore, error);
      return { righe, queryKo: true };
    }
    const lotto = (data ?? []) as T[];
    righe.push(...lotto);
    if (lotto.length < PAGINA) break;
  }
  return { righe, queryKo: false };
}

/** L'oggetto per l'update del timbro, con la SOLA colonna chiesta (i tipi di
 *  `conversations.Update` non accettano una chiave calcolata su un'unione). */
export function timbroUpdate(
  colonna: ColonnaTimbro,
  valore: string | null,
): { lancio_link_inviato_at: string | null } | { lancio_followup_inviato_at: string | null } {
  return colonna === 'lancio_link_inviato_at'
    ? { lancio_link_inviato_at: valore }
    : { lancio_followup_inviato_at: valore };
}

/** Lo stesso oggetto, ma per `impostaFaseLancio` (i suoi `campi` non ammettono null). */
export function timbroCampi(
  colonna: ColonnaTimbro,
  valore: string,
): { lancio_link_inviato_at: string } | { lancio_followup_inviato_at: string } {
  return colonna === 'lancio_link_inviato_at' ? { lancio_link_inviato_at: valore } : { lancio_followup_inviato_at: valore };
}

export type InvioTimbrato = {
  conv: { id: number; crm_lead_id: string | null; phone: string; nome: string | null };
  colonna: ColonnaTimbro;
  /** La fase scritta con `impostaFaseLancio` a invio riuscito (e nella riparazione). */
  faseDopo: LancioFase;
  sid: string;
  from: string;
  vars: Record<string, string>;
  body: string;
  /** Una riga `messages` col SID (non failed) esiste gia': si ripara la fase, non si rimanda. */
  giaSpedito: boolean;
  /**
   * Le fasi DA CUI la fase puo' avanzare a `faseDopo`: compare-and-set di
   * `impostaFaseLancio` (`soloDaFasi`). Un cron scrive in parallelo a un turno che puo'
   * aver portato la chat avanti (pulsante → `post_pitch`, attesa → `posto_bloccato`):
   * senza guardia la fase tornerebbe indietro col template ormai partito. Il timbro
   * resta comunque (e' del claim di sopra): la chat esce da sola dai candidati.
   */
  soloDaFasi: readonly LancioFase[];
  /** Prefisso dei tipi di evento: `lancio_zoom` | `lancio_followup`. */
  prefisso: string;
  /** Come si chiama il messaggio nei log: 'link Zoom' | 'follow-up'. */
  etichetta: string;
  /** Se presente, scritto a invio riuscito (es. `lancio_followup_inviato`, spec §3.2). */
  eventoInvio?: string;
};

/**
 * Un invio, con timbro e tutte le sue uscite. Il worker non lascia MAI passare
 * un'eccezione: `runPool` le mette in un `Promise.all`, e una sola farebbe cadere tutto
 * il blocco di invii in corso — compresi quelli gia' partiti su WhatsApp.
 */
export async function inviaTemplateTimbrato(supabase: Supa, stato: StatoRun, p: InvioTimbrato): Promise<EsitoInvio> {
  const { id, phone, crm_lead_id: crmLeadId } = p.conv;
  try {
    if (stato.fermo) return 'skip';

    if (p.giaSpedito) {
      await impostaFaseLancio(supabase, id, p.faseDopo, timbroCampi(p.colonna, new Date().toISOString()), { soloDaFasi: p.soloDaFasi });
      return 'riparato';
    }

    // Il timbro PRIMA dell'invio: se due run si accavallano, il secondo trova la riga gia'
    // presa e passa oltre. `is(colonna, null)` rende l'update un compare-and-set.
    const timbro = new Date().toISOString();
    const { data: preso, error: erroreClaim } = await supabase
      .from('conversations')
      .update(timbroUpdate(p.colonna, timbro))
      .eq('id', id)
      .is(p.colonna, null)
      .select('id');
    if (erroreClaim) {
      await logEvento(supabase, `${p.prefisso}_claim_error`, { conversationId: id, error: erroreClaim.message },
        `[lancio] conv ${id}: timbro non scritto, ${p.etichetta} non spedito — ${erroreClaim.message}`, 'error');
      return 'skip';
    }
    if (((preso ?? []) as unknown[]).length === 0) return 'skip';

    // Si libera SOLO il timbro che ha messo questo giro.
    const liberaTimbro = () =>
      supabase.from('conversations').update(timbroUpdate(p.colonna, null)).eq('id', id).eq(p.colonna, timbro);

    stato.tentati++;
    let spedito = false;
    try {
      const res = await sendTemplate({ to: phone, contentSid: p.sid, variables: p.vars, from: p.from });
      // Il messaggio e' su WhatsApp: da qui in poi il timbro non si tocca piu'.
      spedito = true;
      await supabase.from('messages').insert({
        conversation_id: id,
        direction: 'out',
        body: p.body,
        twilio_sid: res.sid,
        twilio_status: res.status,
        template_sid: p.sid,
        template_vars: p.vars as never,
        is_template: true,
        sender: 'automazione',
      });
      await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', id);
      await impostaFaseLancio(supabase, id, p.faseDopo, timbroCampi(p.colonna, timbro), { soloDaFasi: p.soloDaFasi });
      if (p.eventoInvio) {
        await logEvento(supabase, p.eventoInvio, { conversationId: id, crmLeadId, phone, sid: res.sid },
          `[lancio] ${p.etichetta} inviato a ${phone}`);
      }
      return 'sent';
    } catch (err) {
      const e = err as { message?: string; code?: number };
      if (spedito) {
        await logEvento(supabase, `${p.prefisso}_meta_incompleta`, { conversationId: id, crmLeadId, error: e?.message ?? 'errore' },
          `[lancio] ${p.etichetta} inviato a ${phone} ma la registrazione e' fallita: ${e?.message ?? 'errore'}`, 'error');
        return 'errore';
      }
      if (eRifiutoDiPolicy(e)) {
        // Nessuna riga, nessun tentativo consumato (l'unico caso in cui `tentati` torna
        // indietro), timbro restituito, e il run finisce qui.
        await liberaTimbro();
        stato.tentati--;
        stato.fermo = 'template_bloccato';
        await logEvento(supabase, `${p.prefisso}_config_error`, { conversationId: id, templateSid: p.sid, error: e?.message ?? 'template non spedibile' },
          `[lancio] ${p.etichetta} bloccato dal presidio template: run fermato — ${e?.message ?? 'template non spedibile'}`, 'error');
        return 'bloccato';
      }
      if (typeof e?.code !== 'number') {
        // Twilio non ha risposto: il messaggio PUO' essere partito. Timbro TENUTO.
        await logEvento(supabase, `${p.prefisso}_esito_incerto`, { conversationId: id, crmLeadId, error: e?.message ?? 'errore' },
          `[lancio] conv ${id}: Twilio non ha risposto, esito dell'invio incerto — timbro tenuto, nessun ritentativo`, 'warn');
        return 'incerto';
      }
      // Twilio ha risposto con un codice: l'invio non e' partito. Solo qui il timbro va tolto.
      await liberaTimbro();
      if (e.code === CODICE_FREQUENCY_CAP) {
        await logEvento(supabase, `${p.prefisso}_freq_capped`, { conversationId: id, templateSid: p.sid },
          `[lancio] frequency cap Meta su conv ${id}: ${p.etichetta} non spedito, ritento al prossimo run`);
        return 'capped';
      }
      stato.codici.push(e.code);
      await logEvento(supabase, 'send_error', { conversationId: id, crmLeadId, code: e.code, error: e?.message ?? 'errore' },
        `[lancio] ${p.etichetta} fallito per ${phone}: ${e?.message ?? 'errore'}`, 'error');
      // La riga failed si vede nel pannello e NON conta nell'idempotenza: si riprova.
      await supabase.from('messages').insert({
        conversation_id: id,
        direction: 'out',
        body: p.body,
        twilio_status: 'failed',
        twilio_error_code: e.code,
        template_sid: p.sid,
        template_vars: p.vars as never,
        is_template: true,
        sender: 'automazione',
      });
      return 'failed';
    }
  } catch (err) {
    await logEvento(supabase, `${p.prefisso}_error`, { conversationId: id, error: err instanceof Error ? err.message : 'errore' },
      `[lancio] errore su conv ${id}: ${err instanceof Error ? err.message : 'errore'}`, 'error');
    return 'errore';
  }
}

export type ContiLotti = {
  inviati: number; riparati: number; capped: number; falliti: number;
  incerti: number; saltati: number; errori: number; report: EsitoInvio[];
};

/**
 * Il ciclo a blocchi da `PASSO_FRENO` con `runPool`: ogni blocco aggiorna i conti, poi
 * la sveglia dei 240s e il freno. `suFreno` e' del chiamante (scrive l'evento col suo
 * prefisso e spegne il lancio: vedi `frenaLancio`).
 */
export async function eseguiLotti<T>(
  lotto: readonly T[],
  stato: StatoRun,
  p: {
    concorrenza: number;
    t0: number;
    inviaUno: (c: T) => Promise<EsitoInvio>;
    suFreno: (stato: StatoRun, conti: ContiLotti) => Promise<void> | void;
  },
): Promise<ContiLotti> {
  const conti: ContiLotti = { inviati: 0, riparati: 0, capped: 0, falliti: 0, incerti: 0, saltati: 0, errori: 0, report: [] };
  for (let i = 0; i < lotto.length && !stato.fermo; i += PASSO_FRENO) {
    if (Date.now() - p.t0 > TEMPO_MASSIMO_MS) {
      stato.fermo = 'tempo';
      break;
    }
    const esiti = await runPool(lotto.slice(i, i + PASSO_FRENO), p.concorrenza, p.inviaUno);
    conti.report.push(...esiti);
    for (const e of esiti) {
      if (e === 'sent') conti.inviati++;
      else if (e === 'riparato') conti.riparati++;
      else if (e === 'capped') conti.capped++;
      else if (e === 'failed') conti.falliti++;
      else if (e === 'incerto') conti.incerti++;
      else if (e === 'errore') conti.errori++;
      else conti.saltati++;
    }
    if (stato.fermo) break;
    if (decideFreno({ tentati: stato.tentati, falliti: conti.falliti + conti.incerti, codici: stato.codici }) === 'ferma') {
      stato.fermo = 'freno';
      await p.suFreno(stato, conti);
    }
  }
  return conti;
}

/** Il freno: evento `<prefisso>_freno` (error) e `lancio_attivo` spento, cosi' i run
 *  dopo restano fermi finche' un admin non riaccende dal pannello (runbook B6). */
export async function frenaLancio(
  supabase: Supa,
  stato: StatoRun,
  conti: ContiLotti,
  p: { prefisso: string; etichetta: string; candidati: number; lotto: number },
): Promise<void> {
  await logEvento(
    supabase,
    `${p.prefisso}_freno`,
    {
      tentati: stato.tentati, inviati: conti.inviati, falliti: conti.falliti, incerti: conti.incerti,
      capped: conti.capped, codici: stato.codici, candidati: p.candidati, lotto: p.lotto,
    },
    `[lancio] FRENO sul ${p.etichetta}: ${conti.falliti + conti.incerti} non arrivati su ${stato.tentati} tentativi (${conti.falliti} falliti, ${conti.incerti} incerti; codici: ${stato.codici.join(', ') || 'nessuno'}). Lancio spento, riaccendere a mano dal pannello.`,
    'error',
  );
  await setLancioSetting(supabase, 'lancio_attivo', false);
}
```

Run: `bunx vitest run lib/lancio-blast-motore.test.ts`
Expected: PASS.

- [ ] **Step 3: Ricabla il cron Zoom sul motore, senza cambiarne il comportamento**

In `app/api/cron/lancio-zoom/route.ts`:

(a) Import (righe 1-23): togli `runPool`, `setLancioSetting` (resta `getLancioSettings`), `impostaFaseLancio`, `logCronQueryError`, `sendTemplate` (resta `getTemplateBody`) e `decideFreno` dall'import di `lancio-zoom-blast`; **resta** `import type { LancioFase }` (serve a `FASI_BERSAGLIO`); aggiungi

```ts
import {
  autorizzatoCron, leggiParametriCron, logEvento, leggiCoda, nuovoStatoRun, inviaTemplateTimbrato,
  eseguiLotti, frenaLancio, type EsitoInvio,
} from '@/lib/lancio-blast-motore';
```

(b) Cancella le definizioni locali di `PASSO_FRENO`, `TEMPO_MASSIMO_MS`, `MAX_PAGINE`, `PAGINA` (righe 49-58), `type Esito` (63), `authorized`, `orologio`, `eRifiutoDiPolicy`, `logEvento` (74-110). **Non** cancellare `FASI_BERSAGLIO` (riga 61). `logEvento` importata dal motore ha la stessa firma: le chiamate `logEvento(supabase, …)` e `scriviRun` restano come sono. Sostituisci `authorized(req)` con `autorizzatoCron(req)` e `Esito` con `EsitoInvio`. `eRifiutoDiPolicy` non serve più nel route: la usa il motore.

(c) Orologio e `forza` (righe 152-162): sostituisci il blocco da `const now = orologio(req);` alla chiusura dell'`if (forza && solo === null) { … }` con

```ts
  const parametri = leggiParametriCron(req, { nowRichiedeSolo: false });
  if (!parametri.ok) return NextResponse.json({ ok: false, error: parametri.errore }, { status: 400 });
  const { now, forza, solo } = parametri;
```

e più sotto `req.nextUrl.searchParams.get('dry') === '1'` con `parametri.dry`. L'ORDINE dei controlli resta quello di oggi (attivo → evento → parametri → config → finestra): i test lo fissano.

(d) Paginazione (righe 244-267): sostituisci le dichiarazioni `const tutti: Candidata[] = []`, `const t0 = Date.now()`, `let queryKo = false` e il ciclo `for (let pagina = 0; pagina < MAX_PAGINE; pagina++) { … }` con

```ts
  const t0 = Date.now();
  const { righe: tutti, queryKo } = await leggiCoda<Candidata>(supabase, 'lancio_zoom_query_error', (da, a) =>
    bersaglio('id, crm_lead_id, lancio_fase, lancio_info, last_inbound_at, leads(phone_e164, first_name)')
      .order('id', { ascending: true })
      .range(da, a),
  );
```

(e) Il worker e il ciclo (righe 297-544): sostituisci tutto il blocco da `let inviati = 0;` (riga 297) fino alla chiusura del `for` dei blocchi (riga 544, prima di `const residui = candidati.length - report.length;`) con

```ts
  const stato = nuovoStatoRun();
  const inviaUno = (c: Candidata): Promise<EsitoInvio> => {
    const phone = c.leads?.phone_e164 ?? null;
    if (stato.fermo || !phone) return Promise.resolve('skip');
    const vars = { '1': templateName(c.leads?.first_name), '2': link };
    return inviaTemplateTimbrato(supabase, stato, {
      conv: { id: c.id, crm_lead_id: c.crm_lead_id, phone, nome: c.leads?.first_name ?? null },
      colonna: 'lancio_link_inviato_at',
      faseDopo: 'link_inviato',
      sid, from, vars,
      body: renderBodyTemplate(bodyRaw, vars),
      giaSpedito: giaSpediti.has(c.id),
      soloDaFasi: FASI_BERSAGLIO,
      prefisso: 'lancio_zoom',
      etichetta: 'link Zoom',
    });
  };

  const conti = await eseguiLotti(lotto, stato, {
    concorrenza: LANCIO_BLAST_CONCURRENCY,
    t0,
    inviaUno,
    suFreno: (s, c) => frenaLancio(supabase, s, c, { prefisso: 'lancio_zoom', etichetta: 'blast Zoom', candidati: candidati.length, lotto: lotto.length }),
  });
  const { inviati, riparati, capped, falliti, incerti, saltati, errori, report } = conti;
  const { tentati, codici, fermo } = stato;
```

Il riepilogo, `scriviRun` e la risposta JSON sotto restano invariati (usano `inviati`, `riparati`, `capped`, `falliti`, `incerti`, `saltati`, `errori`, `residui`, `fermo`, `tentati`, `codici`, `report`, `queryKo`, `max`, `perimetro`).

(f) In `app/api/cron/lancio-aperture/route.ts` cancella la funzione locale `eRifiutoDiPolicy` col suo docblock (righe 55-65: identica byte per byte a quella del motore) e importala: `import { eRifiutoDiPolicy } from '@/lib/lancio-blast-motore';`.

- [ ] **Step 4: Verifica che il cron Zoom sia rimasto lo stesso**

Run: `bunx vitest run app/api/cron/lancio-zoom/route.test.ts app/api/cron/lancio-aperture/route.test.ts lib/lancio-blast-motore.test.ts lib/lancio-zoom-blast.test.ts && bun run typecheck`
Expected: PASS su tutti (i **42** casi del cron Zoom invariati, compresi i tre che asseriscono `{ soloDaFasi: ['attesa', 'posto_bloccato'] }` come quinto argomento di `impostaFaseLancio`: righe 428-431, 446 e 479 del test), nessun errore di tipo. Se un test del cron Zoom fallisce, si corregge il **motore** o il ricablaggio, mai il test.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-blast-motore.ts lib/lancio-blast-motore.test.ts app/api/cron/lancio-zoom/route.ts app/api/cron/lancio-aperture/route.ts
git commit -m "refactor(lancio): il motore del blast (timbro, freno, 63049, esito incerto) esce dal cron Zoom in lib/lancio-blast-motore

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 2 (BOT): `lib/lancio-followup.ts` — chi riceve il follow-up, quando, e il "no" dell'ultimo inbound (rulings C1, C4, finestre)

**Files:**
- Create: `lib/lancio-followup.ts`
- Create: `lib/lancio-followup.test.ts`

**Interfaces:**
- Consumes: `romeDayKey`, `romeHour`, `romeMinute` (`lib/rome-time.ts`); `giorniLancio(eventoAt) → { evento, giornoDopo, dopodomani }` (`lib/lancio-scelta.ts:50-53`); `haCongedo(lancioInfo)`, `type RigaLancio` (`lib/lancio-fase.ts`); `congedoEsplicito(body) → boolean` (`lib/lancio-classifica.ts:84-89`, commit `9d17b88`: solo `NO_FRASI`, mai il "no" secco); `templateName` (`lib/name.ts:45`, `'Anna Verdi' → 'Anna'`).
- Produces:
  - `FASI_FOLLOWUP = ['attesa', 'posto_bloccato', 'link_inviato'] as const`
  - `FASCE_FOLLOWUP` (minuti di Roma, estremi `[da, a)`): `12:00–14:00`, `17:30–19:30`
  - `inFinestraFollowup(now: Date, eventoAt: Date): boolean` — giorno dopo l'evento o dopodomani, dentro una fascia
  - `finestraFollowupChiusa(now: Date, eventoAt: Date): boolean` — dopo le 19:30 di dopodomani (per contare i residui una volta sola)
  - `ancoraLancio(i: { rows, welcomeSid, benvenutoAt, ingressoAt }): string | null` — l'istante da cui un inbound "conta"
  - `inboundDopo(rows: RigaLancio[], ancoraIso: string): RigaLancio[]`, `haInteragito(rows, ancoraIso: string | null): boolean`, `ultimoTestoInbound(rows, ancoraIso): string`
  - `haDettoNo(testo: string): boolean` — alias di `congedoEsplicito` (ruling C1 aggiornato)
  - `type DecisioneFollowup = { kind: 'invia' } | { kind: 'congeda'; leadWords: string } | { kind: 'salta'; motivo: MotivoSalto }`, `type MotivoSalto = 'fase' | 'gia_inviato' | 'congedato' | 'ancora_ignota' | 'mai_scritto'`
  - `decideFollowup(c: CandidataFollowup): DecisioneFollowup`
  - `lancioFollowupText(name): string` (testo §7.3) e `NOTA_CONGEDO_FOLLOWUP`
  - `lancioStandardContextNote(videoLiveLink: string | null): string | null` e `lancioStandardDrain(c: { lancio_slug?, lancio_fase? }): boolean` (usate dal Task 4, definite qui perché il file è di questo task)

**"Ha interagito" — definizione precisa (dalle righe, non da `last_inbound_at`).** Un inbound conta se `created_at >= ancora`, dove l'ancora è, nell'ordine: (1) `conversations.lancio_benvenuto_at` (timbrato dall'enroll e dal cron `lancio-aperture` quando il benvenuto parte); (2) altrimenti il `created_at` dell'ultima riga `messages` con `template_sid = LANCIO_WELCOME_TEMPLATE_SID`; (3) altrimenti l'istante dell'evento `lancio_intake` (`leggiIngressoLancioAt`, letto dal cron solo per queste righe: sono le chat riusate senza benvenuto, `duplicato:true`); (4) altrimenti `null` = ancora ignota → **non si manda** (si sbaglia dalla parte del silenzio: è un template su un numero a qualità LOW). `last_inbound_at` resta solo un pre-filtro in query (`not null`): su una chat riusata è vecchio di settimane e non dice nulla del lancio.

**Il "no" (ruling C1, aggiornato il 17/09).** Si guarda l'ULTIMO inbound con testo dopo l'ancora, non l'ultimo lotto, e conta **solo il rifiuto esplicito**: `congedoEsplicito(testo)` (`NO_FRASI`: "no grazie", "non mi interessa", "toglimi dalla lista", "non scrivermi più"…), MAI il "no" secco né "certo che no" — in assistenza il bot fa domande ("hai l'app Zoom?") e quel "no" è una risposta, non un congedo (è la regressione chiusa da `9d17b88`). Chi ha rifiutato esplicitamente dopo mezzanotte del 5 (quando l'assistenza taceva per design) non riceve "ti va di parlarne?": il cron lo congeda senza bolla (Task 3). Chi ha scritto un "no" secco riceve il follow-up: se davvero non vuole, lo dirà a Mario e sarà lui a scartarlo.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// lib/lancio-followup.test.ts
import { describe, it, expect } from 'vitest';
import {
  FASI_FOLLOWUP, inFinestraFollowup, finestraFollowupChiusa, ancoraLancio, inboundDopo, haInteragito,
  ultimoTestoInbound, haDettoNo, decideFollowup, lancioFollowupText, lancioStandardContextNote,
  lancioStandardDrain, NOTA_CONGEDO_FOLLOWUP, type CandidataFollowup,
} from './lancio-followup';
import type { RigaLancio } from './lancio-fase';

const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const t = (iso: string) => new Date(iso);
const WELCOME = 'HX_WELCOME';
const out = (body: string, created_at: string, template_sid: string | null = null): RigaLancio => ({ direction: 'out', body, template_sid, created_at });
const inb = (body: string, created_at: string): RigaLancio => ({ direction: 'in', body, template_sid: null, created_at });

describe('inFinestraFollowup — 12:00-14:00 e 17:30-19:30 di Roma, il giorno dopo e dopodomani', () => {
  it('dentro: 12:00, 13:59, 17:30, 19:29 del 6 e del 7', () => {
    for (const iso of ['2026-10-06T12:00:00+02:00', '2026-10-06T13:59:00+02:00', '2026-10-06T17:30:00+02:00', '2026-10-06T19:29:00+02:00', '2026-10-07T12:05:00+02:00', '2026-10-07T18:00:00+02:00']) {
      expect(inFinestraFollowup(t(iso), EVENTO), iso).toBe(true);
    }
  });
  it('fuori: 11:59, 14:00, 17:29, 19:30, e le ore UTC coperte dallo schedule ma fuori fascia', () => {
    for (const iso of ['2026-10-06T11:59:00+02:00', '2026-10-06T14:00:00+02:00', '2026-10-06T17:29:00+02:00', '2026-10-06T19:30:00+02:00', '2026-10-06T17:05:00+02:00', '2026-10-06T19:45:00+02:00']) {
      expect(inFinestraFollowup(t(iso), EVENTO), iso).toBe(false);
    }
  });
  it('vale il 6 e il 7, non il 5 ne l 8, e segue l evento se si sposta', () => {
    expect(inFinestraFollowup(t('2026-10-05T12:30:00+02:00'), EVENTO)).toBe(false);
    expect(inFinestraFollowup(t('2026-10-08T12:30:00+02:00'), EVENTO)).toBe(false);
    expect(inFinestraFollowup(t('2026-10-13T12:30:00+02:00'), new Date('2026-10-12T21:00:00+02:00'))).toBe(true);
  });
  it('la finestra e chiusa solo dopo le 19:30 di dopodomani', () => {
    expect(finestraFollowupChiusa(t('2026-10-06T20:00:00+02:00'), EVENTO)).toBe(false);
    expect(finestraFollowupChiusa(t('2026-10-07T19:29:00+02:00'), EVENTO)).toBe(false);
    expect(finestraFollowupChiusa(t('2026-10-07T19:30:00+02:00'), EVENTO)).toBe(true);
    expect(finestraFollowupChiusa(t('2026-10-08T09:00:00+02:00'), EVENTO)).toBe(true);
  });
});

describe('ancoraLancio — da quando un inbound conta', () => {
  const rows = [out('vecchio giro di Mario', '2026-08-01T10:00:00Z'), out('benvenuto', '2026-09-20T10:00:00Z', WELCOME)];
  it('la colonna lancio_benvenuto_at vince su tutto', () => {
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: '2026-09-20T10:00:05Z', ingressoAt: '2026-09-19T00:00:00Z' })).toBe('2026-09-20T10:00:05Z');
  });
  it('poi la riga del benvenuto in cronologia (l ultima), poi l istante dell intake', () => {
    expect(ancoraLancio({ rows, welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: null })).toBe('2026-09-20T10:00:00Z');
    expect(ancoraLancio({ rows: [rows[0]], welcomeSid: WELCOME, benvenutoAt: null, ingressoAt: '2026-09-19T00:00:00Z' })).toBe('2026-09-19T00:00:00Z');
  });
  it('senza nessuno dei tre e null: ancora ignota', () => {
    expect(ancoraLancio({ rows: [rows[0]], welcomeSid: null, benvenutoAt: null, ingressoAt: null })).toBeNull();
  });
});

describe('haInteragito / ultimoTestoInbound', () => {
  const ancora = '2026-09-20T10:00:00Z';
  it('un inbound prima dell ancora non conta, uno dopo si', () => {
    expect(haInteragito([inb('ciao', '2026-09-01T10:00:00Z')], ancora)).toBe(false);
    expect(haInteragito([inb('ciao', '2026-09-01T10:00:00Z'), inb('ok', '2026-09-20T10:30:00Z')], ancora)).toBe(true);
    expect(inboundDopo([inb('ciao', '2026-09-01T10:00:00Z'), inb('ok', '2026-09-20T10:30:00Z')], ancora)).toHaveLength(1);
  });
  it('ancora ignota: mai interagito (si sbaglia verso il silenzio)', () => {
    expect(haInteragito([inb('ok', '2026-09-20T10:30:00Z')], null)).toBe(false);
  });
  it('l ultimo testo e l ultimo inbound leggibile dopo l ancora: i media si saltano', () => {
    const rows = [inb('si', '2026-09-20T10:30:00Z'), out('perfetto', '2026-09-20T10:31:00Z'), inb('no grazie', '2026-10-06T00:30:00Z'), inb('', '2026-10-06T00:31:00Z')];
    expect(ultimoTestoInbound(rows, ancora)).toBe('no grazie');
    expect(ultimoTestoInbound([inb('', '2026-09-20T10:30:00Z')], ancora)).toBe('');
  });
});

describe('haDettoNo — solo il rifiuto esplicito (congedoEsplicito), mai il no secco', () => {
  it('le frasi di rifiuto sono un no', () => {
    for (const s of ['No grazie', 'non mi interessa', 'toglimi dalla lista', 'non scrivetemi più', 'basta messaggi', 'numero sbagliato']) expect(haDettoNo(s), s).toBe(true);
  });
  it('un no secco, "certo che no" e tutto il resto NON sono un congedo: in assistenza il no risponde a una domanda del bot', () => {
    for (const s of ['no', 'certo che no', 'si', 'ok', 'quanto costa?', 'no ma sono interessato', 'nessun problema, ci sono', '']) expect(haDettoNo(s), s).toBe(false);
  });
});

describe('decideFollowup', () => {
  const ancora = '2026-09-20T10:00:00Z';
  const c = (over: Partial<CandidataFollowup> = {}): CandidataFollowup => ({
    lancio_fase: 'attesa',
    lancio_followup_inviato_at: null,
    lancio_info: null,
    rows: [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z')],
    ancora,
    ...over,
  });
  it('attesa/posto_bloccato/link_inviato con un inbound dopo l ancora: si manda', () => {
    for (const f of FASI_FOLLOWUP) expect(decideFollowup(c({ lancio_fase: f }))).toEqual({ kind: 'invia' });
  });
  it('fasi fuori perimetro: post_pitch, scelta_fatta, followup_inviato, chiuso, restituito, null', () => {
    for (const f of ['post_pitch', 'scelta_fatta', 'followup_inviato', 'chiuso', 'restituito', null]) {
      expect(decideFollowup(c({ lancio_fase: f }))).toEqual({ kind: 'salta', motivo: 'fase' });
    }
  });
  it('gia inviato (timbro presente, anche con fase indietro = esito incerto): non si rimanda', () => {
    expect(decideFollowup(c({ lancio_followup_inviato_at: '2026-10-06T10:00:00Z' }))).toEqual({ kind: 'salta', motivo: 'gia_inviato' });
  });
  it('congedato (lancio_info.congedo_at) vince su tutto, in qualunque fase', () => {
    expect(decideFollowup(c({ lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }))).toEqual({ kind: 'salta', motivo: 'congedato' });
  });
  it('ancora ignota o nessun inbound dopo l ancora: mai scritto', () => {
    expect(decideFollowup(c({ ancora: null }))).toEqual({ kind: 'salta', motivo: 'ancora_ignota' });
    expect(decideFollowup(c({ rows: [out('benvenuto', ancora, WELCOME), inb('ciao', '2026-08-01T10:00:00Z')] }))).toEqual({ kind: 'salta', motivo: 'mai_scritto' });
  });
  it('l ultimo inbound e un no netto: si congeda con le sue parole, non si manda', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z'), out('link', '2026-10-05T19:40:00Z', 'HX_ZOOM'), inb('No grazie, non mi interessa', '2026-10-06T00:30:00Z')];
    expect(decideFollowup(c({ lancio_fase: 'link_inviato', rows }))).toEqual({ kind: 'congeda', leadWords: 'No grazie, non mi interessa' });
  });
  it('un rifiuto seguito da un si non e un no: conta l ultimo', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('non mi interessa', '2026-09-20T10:30:00Z'), inb('anzi si, mi interessa', '2026-09-20T10:35:00Z')];
    expect(decideFollowup(c({ rows }))).toEqual({ kind: 'invia' });
  });
  it('un no secco come ultimo inbound NON congeda: si manda (il no era la risposta a una domanda)', () => {
    const rows = [out('benvenuto', ancora, WELCOME), inb('si', '2026-09-20T10:30:00Z'), out('hai gia l app Zoom?', '2026-10-05T20:00:00Z'), inb('no', '2026-10-05T20:05:00Z')];
    expect(decideFollowup(c({ lancio_fase: 'link_inviato', rows }))).toEqual({ kind: 'invia' });
  });
});

describe('lancioStandardDrain — quando il drain deve usare il contesto della live', () => {
  it('vero solo per una chat del lancio in fase chiuso', () => {
    expect(lancioStandardDrain({ lancio_slug: 'webdev-2026-10', lancio_fase: 'chiuso' })).toBe(true);
    for (const f of ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato', 'restituito', null]) {
      expect(lancioStandardDrain({ lancio_slug: 'webdev-2026-10', lancio_fase: f })).toBe(false);
    }
    expect(lancioStandardDrain({ lancio_slug: null, lancio_fase: 'chiuso' })).toBe(false);
    expect(lancioStandardDrain({})).toBe(false);
  });
});

describe('testi', () => {
  it('il follow-up e il template approvato (spec §7.3) col nome proprio', () => {
    expect(lancioFollowupText('Anna Verdi')).toBe(
      'Ciao Anna, ieri sera alla live abbiamo presentato il percorso Web Developer AI. Ti va di parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live.',
    );
  });
  it('la nota del congedo dal follow-up dice cosa e successo', () => {
    expect(NOTA_CONGEDO_FOLLOWUP).toBe('Lancio Web Dev AI: aveva detto di no prima del follow-up del giorno dopo la live, non gli abbiamo scritto.');
  });
  it('la nota di contesto porta il link della live e sostituisce i quattro video; senza link e null', () => {
    const nota = lancioStandardContextNote('https://corso.feniceacademy.it/live-webdev-2026');
    expect(nota).toContain('https://corso.feniceacademy.it/live-webdev-2026');
    expect(nota).toContain('conferenza-*');
    expect(nota).not.toMatch(/prezz|€|euro|sconto/i);
    expect(lancioStandardContextNote(null)).toBeNull();
    expect(lancioStandardContextNote('  ')).toBeNull();
  });
});
```

Run: `bunx vitest run lib/lancio-followup.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 2: Implementa `lib/lancio-followup.ts`**

```ts
import { romeDayKey, romeHour, romeMinute } from './rome-time';
import { giorniLancio } from './lancio-scelta';
import { haCongedo, type RigaLancio } from './lancio-fase';
import { congedoEsplicito } from './lancio-classifica';
import { templateName } from './name';

/**
 * Follow-up del giorno dopo la live (spec §5.5): a chi ha interagito col bot dopo il
 * benvenuto ma non ha scelto la sera del pitch. Qui le sole decisioni, senza effetti:
 * il cron `/api/cron/lancio-followup` le applica col motore del blast.
 */

/** Fasi che ricevono il follow-up. `post_pitch`/`scelta_fatta` hanno gia' scelto. */
export const FASI_FOLLOWUP = ['attesa', 'posto_bloccato', 'link_inviato'] as const;

/** Le due fasce di Roma, in minuti del giorno, estremi `[da, a)`: 12:00-14:00 e 17:30-19:30. */
export const FASCE_FOLLOWUP: readonly { daMin: number; aMin: number }[] = [
  { daMin: 12 * 60, aMin: 14 * 60 },
  { daMin: 17 * 60 + 30, aMin: 19 * 60 + 30 },
];

const minutiDelGiorno = (d: Date) => romeHour(d) * 60 + romeMinute(d);

// Il giorno dopo l'evento e dopodomani (sconfinamento), dentro una delle due fasce. Lo
// schedule UTC di vercel.json (ogni 5 minuti nelle ore 10-11 e 15-17 UTC del 6 e 7/10)
// copre 12:00-13:55 e 17:00-19:55 di Roma: il filtro fine sta qui, e i giorni si
// derivano dall'evento, non da date scritte a mano.
export function inFinestraFollowup(now: Date, eventoAt: Date): boolean {
  const g = giorniLancio(eventoAt);
  const giorno = romeDayKey(now);
  if (giorno !== g.giornoDopo && giorno !== g.dopodomani) return false;
  const m = minutiDelGiorno(now);
  return FASCE_FOLLOWUP.some((f) => m >= f.daMin && m < f.aMin);
}

/** Dopo la fine dell'ultima fascia di dopodomani: i residui sono definitivi. */
export function finestraFollowupChiusa(now: Date, eventoAt: Date): boolean {
  const g = giorniLancio(eventoAt);
  const giorno = romeDayKey(now);
  if (giorno > g.dopodomani) return true;
  if (giorno < g.dopodomani) return false;
  return minutiDelGiorno(now) >= FASCE_FOLLOWUP[FASCE_FOLLOWUP.length - 1].aMin;
}

/**
 * L'istante da cui un messaggio del lead "conta" per questo lancio: la colonna
 * `lancio_benvenuto_at` (timbrata all'invio del benvenuto), poi l'ultima riga del
 * template di benvenuto in cronologia, poi l'evento `lancio_intake` (chat riusate senza
 * benvenuto). Null = non si sa: chi chiama NON manda (template su numero a qualita' LOW).
 */
export function ancoraLancio(i: {
  rows: RigaLancio[];
  welcomeSid: string | null;
  benvenutoAt: string | null;
  ingressoAt: string | null;
}): string | null {
  if (i.benvenutoAt) return i.benvenutoAt;
  if (i.welcomeSid) {
    for (let k = i.rows.length - 1; k >= 0; k--) {
      const r = i.rows[k];
      if (r.template_sid === i.welcomeSid && r.created_at) return r.created_at;
    }
  }
  return i.ingressoAt;
}

/** Gli inbound dall'ancora in poi (compresa). */
export function inboundDopo(rows: RigaLancio[], ancoraIso: string): RigaLancio[] {
  return rows.filter((m) => m.direction === 'in' && !!m.created_at && m.created_at >= ancoraIso);
}

/** "Ha interagito" = almeno un messaggio del lead dall'ancora in poi. */
export function haInteragito(rows: RigaLancio[], ancoraIso: string | null): boolean {
  if (!ancoraIso) return false;
  return inboundDopo(rows, ancoraIso).length > 0;
}

/** L'ultimo messaggio del lead con del testo, dall'ancora in poi. Vuoto = solo media. */
export function ultimoTestoInbound(rows: RigaLancio[], ancoraIso: string): string {
  const dopo = inboundDopo(rows, ancoraIso);
  for (let k = dopo.length - 1; k >= 0; k--) {
    const testo = (dopo[k].body ?? '').trim();
    if (testo !== '') return testo;
  }
  return '';
}

/**
 * Il rifiuto ESPLICITO (ruling C1 aggiornato il 17/09): solo le frasi di `NO_FRASI`
 * ("non mi interessa", "toglimi dalla lista", "no grazie"…), mai il "no" secco — in
 * assistenza il bot fa domande e quel "no" e' una risposta (commit 9d17b88). Un lead
 * freddo che riceve il follow-up costa un template; un lead scartato per un "no" detto
 * a "hai l'app Zoom?" e' irreversibile.
 */
export function haDettoNo(testo: string): boolean {
  return congedoEsplicito(testo);
}

export type MotivoSalto = 'fase' | 'gia_inviato' | 'congedato' | 'ancora_ignota' | 'mai_scritto';
export type DecisioneFollowup =
  | { kind: 'invia' }
  | { kind: 'congeda'; leadWords: string }
  | { kind: 'salta'; motivo: MotivoSalto };

export type CandidataFollowup = {
  lancio_fase: string | null;
  lancio_followup_inviato_at: string | null;
  lancio_info: unknown;
  rows: RigaLancio[];
  ancora: string | null;
};

/**
 * Cosa fare con questa chat. L'ordine e' quello del costo dell'errore: una fase fuori
 * perimetro e un timbro gia' scritto non si toccano; il congedo vince su tutto (C4); senza
 * ancora o senza inbound dopo l'ancora non si manda; chi ha detto no per ultimo si
 * congeda (C1) invece di ricevere "ti va di parlarne?".
 */
export function decideFollowup(c: CandidataFollowup): DecisioneFollowup {
  if (!c.lancio_fase || !(FASI_FOLLOWUP as readonly string[]).includes(c.lancio_fase)) return { kind: 'salta', motivo: 'fase' };
  if (c.lancio_followup_inviato_at) return { kind: 'salta', motivo: 'gia_inviato' };
  if (haCongedo(c.lancio_info)) return { kind: 'salta', motivo: 'congedato' };
  if (!c.ancora) return { kind: 'salta', motivo: 'ancora_ignota' };
  if (!haInteragito(c.rows, c.ancora)) return { kind: 'salta', motivo: 'mai_scritto' };
  const testo = ultimoTestoInbound(c.rows, c.ancora);
  if (testo !== '' && haDettoNo(testo)) return { kind: 'congeda', leadWords: testo };
  return { kind: 'invia' };
}

/** Nota al CRM col `DA_SCARTARE` del congedo deciso dal cron (nessuna bolla al lead). */
export const NOTA_CONGEDO_FOLLOWUP =
  'Lancio Web Dev AI: aveva detto di no prima del follow-up del giorno dopo la live, non gli abbiamo scritto.';

/**
 * Corpo del template `LANCIO_FOLLOWUP_TEMPLATE_SID` (spec §7.3) con {{1}} risolto: e'
 * quello che finisce nella riga `messages` per i pannelli. Identico al template approvato.
 */
export function lancioFollowupText(name: string | null | undefined): string {
  return (
    `Ciao ${templateName(name)}, ieri sera alla live abbiamo presentato il percorso Web Developer AI. ` +
    'Ti va di parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live.'
  );
}

/**
 * Nota di contesto per `generateMarioReply` dopo il follow-up (spec §5.5): il flusso e'
 * quello standard, l'unica differenza e' il video, che e' la live editata. Null senza
 * link: Mario usa i quattro video classici (meglio un video che nessun video). Nessuna
 * promessa nuova: "il video riassuntivo della live" e' nel template approvato.
 */
export function lancioStandardContextNote(videoLiveLink: string | null): string | null {
  const link = videoLiveLink?.trim();
  if (!link) return null;
  return [
    'CONTESTO LANCIO WEB DEVELOPER AI: questo lead era iscritto alla live del percorso Web Developer AI e ha risposto al nostro messaggio del giorno dopo.',
    `Il video di preparazione da mandargli e' UNO SOLO ed e' la registrazione della live: ${link}`,
    'Usa questo link al posto dei quattro link conferenza-* del blocco sul video, in ogni punto in cui manderesti il video. Non chiedere se lavora o ha famiglia per scegliere il video: il video e' questo.',
    'Nel messaggio gli abbiamo scritto che gli mandiamo il video riassuntivo della live: se lo chiede, mandaglielo subito, anche prima di fissare la call.',
  ].join('\n');
}

/**
 * La chat e' del lancio ed e' in mano a Mario standard: fase `chiuso` (dopo il
 * follow-up, o dopo il congedo — ma un congedato non arriva al drain: `shouldReopen`
 * lo tiene chiuso). `restituito` NO: quel lead e' del GDO (ruling C8).
 */
export function lancioStandardDrain(c: { lancio_slug?: string | null; lancio_fase?: string | null }): boolean {
  return !!c.lancio_slug && c.lancio_fase === 'chiuso';
}
```

Run: `bunx vitest run lib/lancio-followup.test.ts lib/lancio-classifica.test.ts`
Expected: PASS (`templateName('Anna Verdi')` dà `'Anna'`: `firstNameOf` in `lib/name.ts:34-42` prende la prima parola in title case).

- [ ] **Step 3: Commit**

```bash
git add lib/lancio-followup.ts lib/lancio-followup.test.ts
git commit -m "feat(lancio): regole pure del follow-up del giorno dopo (finestre, ancora del lancio, rifiuto esplicito)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 3 (BOT): cron `/api/cron/lancio-followup` sul motore + schedule (rulings R3, C1, C4, C6, C7)

**Files:**
- Create: `app/api/cron/lancio-followup/route.ts`
- Create: `app/api/cron/lancio-followup/route.test.ts`
- Modify: `vercel.json` (una voce in coda a `crons`)

**Interfaces:**
- Consumes: Task 1 (motore, che chiama `impostaFaseLancio(..., { soloDaFasi })`), Task 2 (regole), `getLancioSettings` (`lib/lancio-settings.ts`), `giorniLancio` (`lib/lancio-scelta.ts`), `marcaCongedo`, `leggiIngressoLancioAt` (`lib/lancio-db.ts:118-130`), `congedoLancio(supabase, contesto, leadWords, nota, { giaInviato: true })` (`lib/lancio-effetti.ts`: con `giaInviato` non manda nessuna bolla e non scrive il marcatore; manda `DA_SCARTARE` "non interessato", accetta 200/403/`note_duplicate`, porta a `chiuso` e scrive `lancio_congedo` + traccia), `getTemplateBody` (`lib/twilio.ts`), `renderBodyTemplate` (`lib/campaigns.ts`), `templateName`, `batchMax`, `LANCIO_BLAST_CONCURRENCY` (`lib/lancio-zoom-blast.ts`).
- Produces: `GET /api/cron/lancio-followup` (auth `CRON_SECRET`; `?dry=1`; `?forza=1&solo=<id>`; `?now=<iso>&solo=<id>`) → JSON `{ ok, skipped? | candidati, valutati, nonValutati, targets, sent, riparati, capped, failed, incerti, skip, errori, congedati, saltati: { fase, gia_inviato, congedato, ancora_ignota, mai_scritto }, residui, fermo, max, queryKo, report }`. La fase `followup_inviato` si scrive con `soloDaFasi: FASI_FOLLOWUP` (compare-and-set: se intanto il pulsante ha portato la chat a `post_pitch`, la fase non torna indietro; il timbro resta). `gia_inviato` è raggiungibile solo se il filtro `.is('lancio_followup_inviato_at', null)` della query cambiasse: la colonna viene comunque letta e passata a `decideFollowup`, che è l'unica fonte della decisione. Eventi: `lancio_followup_run` (sempre), `lancio_followup_fermo` (C7), `lancio_followup_config_error`, `lancio_followup_query_error`, `lancio_followup_messages_query_error`, `lancio_followup_inviato` (per invio riuscito), `lancio_followup_congedo_da_cron`, e quelli del motore col prefisso `lancio_followup` (`_claim_error`, `_freq_capped`, `_esito_incerto`, `_meta_incompleta`, `_freno`, `_error`). Colonna: `lancio_followup_inviato_at` (timbro), fase `followup_inviato` via `impostaFaseLancio`.

**Schedule.** Roma è UTC+2 il 6-7/10: 12:00–14:00 = 10:00–12:00 UTC, 17:30–19:30 = 15:30–17:30 UTC. Voce: `*/5 10-11,15-17 6-7 10 *` (copre 10:00–11:55 e 15:00–17:55 UTC; il route filtra con `inFinestraFollowup`; i 12 run al giorno fuori fascia — 17:00-17:25 e 19:30-19:55 di Roma — scrivono solo `lancio_followup_run` `fuori_finestra`, e quelli delle 19:30-19:55 del 7/10 sono proprio quelli che contano i residui a finestra chiusa). **Deviazione dichiarata dalla spec §5.5** (`*/10`, 250 per run): qui `*/5` con `LANCIO_BATCH_MAX` = 200, cioè il ritmo del blast (§11.5, delibera 16/09, ledger B4 "default 200 ovunque"): stessa cadenza, stesso motore, stesso tetto per run. A 200 per run ogni 5 minuti una fascia di due ore serve fino a 4.800 conversazioni: il bersaglio è ~3.000 lead di cui una parte ha interagito.

**Perché la coda si legge tutta e non solo i primi 200.** Chi viene saltato (`mai_scritto`, `ancora_ignota`) resta candidato in query a ogni run: prendendo i primi 200 per id, un centinaio di righe saltate in testa affamerebbe la coda per tutta la finestra. Si legge tutta la coda (paginata come il blast), si valutano a blocchi di 200 con UNA query `messages` per blocco, e ci si ferma quando i bersagli sono `max`.

**Costo di `leggiIngressoLancioAt`.** È una `maybeSingle` su `event_log` filtrata per `payload->>conversationId` (`lib/lancio-db.ts:118-130`), una per chat senza benvenuto in cronologia né `lancio_benvenuto_at` (le chat riusate con `duplicato: true`: decine, non migliaia). Per non pagarla in sequenza su un blocco patologico, il run ne fa al massimo `MAX_LETTURE_INTAKE` (50): oltre, quelle chat contano `ancora_ignota` in questo run e si rivalutano al run dopo (ogni 5 minuti). Il tempo delle letture entra nel budget dei 240 s come tutto il resto.

- [ ] **Step 1: Scrivi il test del route che fallisce**

```ts
// app/api/cron/lancio-followup/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Finto Supabase sul modello di lancio-zoom/route.test.ts: registra ogni chiamata e
// simula per davvero il compare-and-set su `lancio_followup_inviato_at`.
type Filtro = { m: string; args: unknown[] };
type Chiamata = { table: string; op: 'select' | 'insert' | 'update' | 'upsert'; arg: unknown; filtri: Filtro[]; opzioni?: { head?: boolean; count?: string } };
const chiamate: Chiamata[] = [];

type Riga = { direction: string; body: string | null; template_sid: string | null; created_at: string; conversation_id: number };
type ConvFinta = {
  id: number;
  crm_lead_id: string | null;
  lancio_fase: string | null;
  lancio_info: Record<string, unknown> | null;
  lancio_benvenuto_at: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  ai_paused_at: string | null;
  handed_off_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

const stato = {
  convs: [] as ConvFinta[],
  messaggi: new Map<number, Riga[]>(),
  spediti: [] as { conversation_id: number }[],
  settings: {} as Record<string, unknown>,
  timbrate: new Set<number>(),
  timbri: new Map<number, string>(),
  convSelectError: null as { message: string; code?: string } | null,
  timbrateAllInvio: [] as number[][],
};

const arg = (rec: Chiamata, metodo: string, colonna: string): Filtro | undefined =>
  rec.filtri.find((f) => f.m === metodo && f.args[0] === colonna);
const congedato = (c: ConvFinta) => typeof c.lancio_info?.congedo_at === 'string';

function filtraCandidati(rec: Chiamata): ConvFinta[] {
  let out = stato.convs.filter((c) => !stato.timbrate.has(c.id));
  if (arg(rec, 'is', 'lancio_info->>congedo_at')) out = out.filter((c) => !congedato(c));
  const fasi = arg(rec, 'in', 'lancio_fase')?.args[1] as string[] | undefined;
  if (fasi) out = out.filter((c) => c.lancio_fase !== null && fasi.includes(c.lancio_fase));
  if (arg(rec, 'not', 'last_inbound_at')) out = out.filter((c) => Boolean(c.last_inbound_at));
  if (arg(rec, 'is', 'ai_paused_at')) out = out.filter((c) => c.ai_paused_at === null);
  if (arg(rec, 'is', 'handed_off_at')) out = out.filter((c) => c.handed_off_at === null);
  const solo = rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'id');
  if (solo) out = out.filter((c) => c.id === solo.args[1]);
  return out;
}

function esegui(rec: Chiamata): { data: unknown; error: unknown; count?: number } {
  if (rec.table === 'conversations' && rec.op === 'update') {
    const campi = rec.arg as Record<string, unknown>;
    const id = Number(rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'id')?.args[1]);
    if (!('lancio_followup_inviato_at' in campi)) return { data: [], error: null };
    if (campi.lancio_followup_inviato_at === null) {
      const atteso = arg(rec, 'eq', 'lancio_followup_inviato_at')?.args[1];
      if (atteso === undefined || stato.timbri.get(id) === atteso) { stato.timbrate.delete(id); stato.timbri.delete(id); }
      return { data: [], error: null };
    }
    if (stato.timbrate.has(id)) return { data: [], error: null };
    stato.timbrate.add(id);
    stato.timbri.set(id, String(campi.lancio_followup_inviato_at));
    return { data: [{ id }], error: null };
  }
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'app_settings') return { data: Object.entries(stato.settings).map(([key, value]) => ({ key, value })), error: null };
  if (rec.table === 'conversations') {
    if (stato.convSelectError) return { data: null, error: stato.convSelectError };
    const righe = filtraCandidati(rec);
    if (rec.opzioni?.head) return { data: null, error: null, count: righe.length };
    const range = (rec.filtri.find((f) => f.m === 'range')?.args as number[] | undefined) ?? [0, 999];
    return { data: righe.slice(range[0], range[1] + 1), error: null };
  }
  if (rec.table === 'messages') {
    const ids = (arg(rec, 'in', 'conversation_id')?.args[1] as number[] | undefined) ?? [];
    if (arg(rec, 'eq', 'template_sid')) return { data: stato.spediti.filter((m) => ids.includes(m.conversation_id)), error: null };
    const righe = ids.flatMap((id) => stato.messaggi.get(id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { data: righe, error: null };
  }
  return { data: [], error: null };
}

function query(table: string, op: Chiamata['op'], a: unknown, opzioni?: Chiamata['opzioni']) {
  const rec: Chiamata = { table, op, arg: a, filtri: [], opzioni };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'order', 'limit', 'range', 'gte', 'lte', 'select']) {
    q[m] = (...args: unknown[]) => { rec.filtri.push({ m, args }); return q; };
  }
  q.maybeSingle = () => q;
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(() => esegui(rec)).then(ok, ko);
  return q;
}

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string, opzioni?: Chiamata['opzioni']) => query(table, 'select', s, opzioni),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
      upsert: (r: unknown) => query(table, 'upsert', r),
    }),
  }),
}));

const sendTemplate = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  getTemplateBody: async () => 'Ciao {{1}}, ieri sera alla live...',
}));

const impostaFaseLancio = vi.fn<(...a: unknown[]) => Promise<void>>(async (...a) => {
  const c = stato.convs.find((x) => x.id === a[1]);
  if (!c) return;
  // `soloDaFasi` e' il compare-and-set sulla fase di partenza: finto come nel test del
  // cron Zoom, perche' e' esattamente quello che questo test deve vedere.
  const soloDaFasi = (a[4] as { soloDaFasi?: readonly string[] } | undefined)?.soloDaFasi;
  if (soloDaFasi && !soloDaFasi.includes(c.lancio_fase ?? '')) return;
  c.lancio_fase = a[2] as string;
});
const marcaCongedo = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const leggiIngressoLancioAt = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null);
vi.mock('@/lib/lancio-db', () => ({
  impostaFaseLancio: (...a: unknown[]) => impostaFaseLancio(...a),
  marcaCongedo: (...a: unknown[]) => marcaCongedo(...a),
  leggiIngressoLancioAt: (...a: unknown[]) => leggiIngressoLancioAt(...a),
}));
const congedoLancio = vi.fn<(...a: unknown[]) => Promise<'active' | 'closed' | 'handed_off'>>(async () => 'closed');
vi.mock('@/lib/lancio-effetti', () => ({ congedoLancio: (...a: unknown[]) => congedoLancio(...a) }));

import { GET } from './route';

const SEGRETO = 'segreto-di-test';
const SID = 'HXfollowup';
const WELCOME = 'HXwelcome';
const EVENTO = '2026-10-05T21:00:00+02:00';
/** 12:10 di Roma del 6/10: dentro la prima fascia. */
const DENTRO = '2026-10-06T12:10:00+02:00';
const FUORI = '2026-10-06T16:00:00+02:00';
const CHIUSA = '2026-10-07T20:00:00+02:00';
const ANCORA = '2026-09-20T10:00:00Z';

const richiesta = (extra = '', secret: string | null = SEGRETO) =>
  GET({
    headers: new Headers(secret ? { authorization: `Bearer ${secret}` } : {}),
    nextUrl: new URL(`https://x/api/cron/lancio-followup?${extra}`),
  } as never);

const tel = (id: number) => `+39333000${String(id).padStart(4, '0')}`;
const conv = (id: number, extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id, crm_lead_id: `crm-${id}`, lancio_fase: 'attesa', lancio_info: null, lancio_benvenuto_at: ANCORA,
  lancio_followup_inviato_at: null, last_inbound_at: '2026-09-20T10:30:00Z', ai_paused_at: null, handed_off_at: null,
  leads: { phone_e164: tel(id), first_name: 'mario rossi' }, ...extra,
});
const righe = (id: number, ...testi: [string, string][]): Riga[] => [
  { conversation_id: id, direction: 'out', body: 'benvenuto', template_sid: WELCOME, created_at: ANCORA },
  ...testi.map(([body, created_at]) => ({ conversation_id: id, direction: 'in', body, template_sid: null, created_at })),
];

const insertIn = (table: string) => chiamate.filter((c) => c.table === table && c.op === 'insert').map((c) => c.arg as Record<string, unknown>);
const eventi = () => insertIn('event_log');
const tipiEvento = () => eventi().map((e) => e.type);
const eventoRun = () => eventi().find((e) => e.type === 'lancio_followup_run');
const selectConv = () => chiamate.find((c) => c.table === 'conversations' && c.op === 'select');
const upserts = () => chiamate.filter((c) => c.op === 'upsert').map((c) => c.arg as Record<string, unknown>);

beforeEach(() => {
  chiamate.length = 0;
  stato.convs = [conv(1), conv(2, { leads: { phone_e164: tel(2), first_name: 'anna verdi' } })];
  stato.messaggi = new Map([[1, righe(1, ['si', '2026-09-20T10:30:00Z'])], [2, righe(2, ['ok ci sono', '2026-09-21T10:30:00Z'])]]);
  stato.spediti = [];
  stato.timbrate = new Set();
  stato.timbri = new Map();
  stato.convSelectError = null;
  stato.timbrateAllInvio = [];
  stato.settings = { lancio_attivo: true, lancio_evento_at: EVENTO, lancio_sender: 'principale' };
  sendTemplate.mockReset().mockImplementation(async () => { stato.timbrateAllInvio.push([...stato.timbrate]); return { sid: 'SMtest', status: 'queued' }; });
  impostaFaseLancio.mockClear();
  marcaCongedo.mockClear();
  congedoLancio.mockClear();
  leggiIngressoLancioAt.mockClear().mockResolvedValue(null);
  vi.stubEnv('CRON_SECRET', SEGRETO);
  vi.stubEnv('LANCIO_FOLLOWUP_TEMPLATE_SID', SID);
  vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', WELCOME);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
  vi.stubEnv('LANCIO_BATCH_MAX', '');
  vi.useFakeTimers();
  vi.setSystemTime(new Date(DENTRO));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('GET /api/cron/lancio-followup — cancelli', () => {
  it('senza segreto: 401 e nessuna lettura', async () => {
    expect((await richiesta('', null)).status).toBe(401);
    expect(chiamate).toHaveLength(0);
  });
  it('fuori dalle fasce di Roma: skip, run scritto, nessun invio', async () => {
    vi.setSystemTime(new Date(FUORI));
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'fuori_finestra' });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect((eventoRun()?.payload as Record<string, unknown>).motivo).toBe('fuori_finestra');
  });
  it('a finestra chiusa il run conta chi e rimasto senza follow-up', async () => {
    vi.setSystemTime(new Date(CHIUSA));
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'fuori_finestra', finestraChiusa: true, residui: 2 });
    expect(eventoRun()?.level).toBe('warn');
  });
  it('lancio spento DENTRO la finestra: nessun invio e un warn lancio_followup_fermo (C7)', async () => {
    stato.settings.lancio_attivo = false;
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'lancio_non_attivo' });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(selectConv()).toBeUndefined();
    const fermo = eventi().find((e) => e.type === 'lancio_followup_fermo');
    expect(fermo?.level).toBe('warn');
    expect((fermo?.payload as Record<string, unknown>).motivo).toBe('lancio_attivo_spento');
    expect(eventoRun()).toBeTruthy();
  });
  it('lancio spento FUORI finestra: solo il run, niente warn', async () => {
    stato.settings.lancio_attivo = false;
    vi.setSystemTime(new Date(FUORI));
    await richiesta();
    expect(tipiEvento()).not.toContain('lancio_followup_fermo');
    expect(eventoRun()).toBeTruthy();
  });
  it('forza=1 senza solo e now= senza solo sono 400', async () => {
    expect((await richiesta('forza=1')).status).toBe(400);
    expect((await richiesta(`now=${encodeURIComponent(DENTRO)}`)).status).toBe(400);
    expect(sendTemplate).not.toHaveBeenCalled();
  });
  it('forza=1&solo=<id> salta la finestra e manda a quella sola conversazione', async () => {
    vi.setSystemTime(new Date(FUORI));
    await expect((await richiesta('forza=1&solo=2')).json()).resolves.toMatchObject({ sent: 1 });
    expect(selectConv()?.filtri).toContainEqual({ m: 'eq', args: ['id', 2] });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });
  it('template o mittente mancanti: config error prima della finestra', async () => {
    vi.stubEnv('LANCIO_FOLLOWUP_TEMPLATE_SID', '');
    vi.setSystemTime(new Date(FUORI));
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(tipiEvento()).toContain('lancio_followup_config_error');
  });
  it('evento illeggibile: config error', async () => {
    stato.settings.lancio_evento_at = 'domani';
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
  });
  it('dry: valuta e conta, non timbra e non manda', async () => {
    await expect((await richiesta('dry=1')).json()).resolves.toMatchObject({ dry: true, candidati: 2, targets: 2 });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(stato.timbrate.size).toBe(0);
  });
  it('query dei candidati fallita: si logga, queryKo, nessuna coda finta', async () => {
    stato.convSelectError = { message: 'column conversations.lancio_fase does not exist', code: '42703' };
    await expect((await richiesta()).json()).resolves.toMatchObject({ queryKo: true, sent: 0 });
    expect(tipiEvento()).toContain('lancio_followup_query_error');
  });
});

describe('GET /api/cron/lancio-followup — perimetro (C4) e decisione', () => {
  it('la query esclude congedati, timbrati, fasi fuori perimetro, chi non ha mai scritto, pausa e passaggio a umano', async () => {
    await richiesta();
    const f = selectConv()?.filtri ?? [];
    expect(f).toContainEqual({ m: 'is', args: ['lancio_info->>congedo_at', null] });
    expect(f).toContainEqual({ m: 'is', args: ['lancio_followup_inviato_at', null] });
    expect(f).toContainEqual({ m: 'in', args: ['lancio_fase', ['attesa', 'posto_bloccato', 'link_inviato']] });
    expect(f).toContainEqual({ m: 'not', args: ['last_inbound_at', 'is', null] });
    expect(f).toContainEqual({ m: 'is', args: ['ai_paused_at', null] });
    expect(f).toContainEqual({ m: 'is', args: ['handed_off_at', null] });
    expect(f).toContainEqual({ m: 'order', args: ['id', { ascending: true }] });
  });
  it('chi si e congedato non riceve il follow-up', async () => {
    stato.convs = [conv(1, { lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }), conv(2)];
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 1, sent: 1 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });
  it('un inbound solo PRIMA dell ancora (chat riusata) non e interazione: si salta, niente template', async () => {
    stato.messaggi.set(1, righe(1, ['ciao', '2026-08-01T10:00:00Z']));
    const res = await (await richiesta()).json();
    expect(res.saltati.mai_scritto).toBe(1);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });
  it('senza benvenuto ne colonna si chiede l istante dell intake; se manca pure quello, ancora ignota', async () => {
    stato.convs = [conv(1, { lancio_benvenuto_at: null })];
    stato.messaggi.set(1, [{ conversation_id: 1, direction: 'in', body: 'si', template_sid: null, created_at: '2026-09-20T10:30:00Z' }]);
    const res = await (await richiesta()).json();
    expect(leggiIngressoLancioAt).toHaveBeenCalledWith(expect.anything(), 1);
    expect(res.saltati.ancora_ignota).toBe(1);
    expect(sendTemplate).not.toHaveBeenCalled();
    leggiIngressoLancioAt.mockResolvedValue('2026-09-20T09:00:00Z');
    chiamate.length = 0;
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1 });
  });
  it('un no secco come ultimo inbound non congeda: riceve il follow-up (C1 aggiornato)', async () => {
    stato.messaggi.set(1, righe(1, ['si', '2026-09-20T10:30:00Z'], ['no', '2026-10-05T20:05:00Z']));
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 2, congedati: 0 });
    expect(congedoLancio).not.toHaveBeenCalled();
  });
  it('l ultimo inbound e un rifiuto esplicito: marcaCongedo + congedoLancio senza bolla, nessun template (C1)', async () => {
    stato.messaggi.set(1, righe(1, ['si', '2026-09-20T10:30:00Z'], ['no grazie non mi interessa', '2026-10-06T00:30:00Z']));
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 1, congedati: 1 });
    expect(marcaCongedo).toHaveBeenCalledWith(expect.anything(), 1);
    expect(congedoLancio).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 1, crmLeadId: 'crm-1', phone: tel(1) }),
      'no grazie non mi interessa',
      expect.stringContaining('Lancio Web Dev AI'),
      { giaInviato: true },
    );
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
    expect(tipiEvento()).toContain('lancio_followup_congedo_da_cron');
    expect(stato.timbrate.has(1)).toBe(false);
  });
  it('le letture dell intake sono al massimo MAX_LETTURE_INTAKE per run: il resto conta ancora_ignota e si rivaluta al run dopo', async () => {
    stato.convs = Array.from({ length: 60 }, (_, i) => conv(i + 1, { lancio_benvenuto_at: null }));
    for (const c of stato.convs) stato.messaggi.set(c.id, [{ conversation_id: c.id, direction: 'in', body: 'si', template_sid: null, created_at: '2026-09-20T10:30:00Z' }]);
    const res = await (await richiesta()).json();
    expect(leggiIngressoLancioAt).toHaveBeenCalledTimes(50);
    expect(res.saltati.ancora_ignota).toBe(60);
    expect(sendTemplate).not.toHaveBeenCalled();
  });
  it('il tetto del lotto vale sui bersagli, non sui candidati: chi si salta non ruba posti', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '1');
    stato.convs = [conv(1), conv(2), conv(3)];
    stato.messaggi.set(1, righe(1, ['ciao', '2026-08-01T10:00:00Z']));
    stato.messaggi.set(3, righe(3, ['si', '2026-09-22T10:30:00Z']));
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ sent: 1, residui: 0, nonValutati: 1 });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(2) }));
  });
  it('mittente secondario chiesto ma non disponibile: warn e si parte dal principale', async () => {
    stato.settings.lancio_sender = 'secondario';
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 2 });
    expect(tipiEvento()).toContain('lancio_sender_secondario_non_disponibile');
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ from: 'whatsapp:+390000000000' }));
  });
});

describe('GET /api/cron/lancio-followup — invio col motore', () => {
  it('manda il template col nome proprio, registra il messaggio, timbra e passa a followup_inviato', async () => {
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 2, sent: 2, failed: 0, capped: 0, fermo: null });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: tel(1), contentSid: SID, variables: { '1': 'Mario' } }));
    const msg = insertIn('messages');
    expect(msg).toHaveLength(2);
    expect(msg[0]).toMatchObject({ template_sid: SID, is_template: true, direction: 'out', sender: 'automazione' });
    expect(String(msg[0].body)).toContain('Ciao Mario, ieri sera');
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'followup_inviato', { lancio_followup_inviato_at: expect.any(String) }, { soloDaFasi: ['attesa', 'posto_bloccato', 'link_inviato'] });
    expect(tipiEvento()).toContain('lancio_followup_inviato');
    expect(stato.timbrateAllInvio[0]).toContain(1);
  });
  it('una fase avanzata durante l invio (pulsante → post_pitch) non torna indietro; il timbro resta', async () => {
    stato.convs = [conv(1)];
    sendTemplate.mockImplementationOnce(async () => {
      stato.convs[0].lancio_fase = 'post_pitch';
      return { sid: 'SMtest', status: 'queued' };
    });
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1, failed: 0 });
    expect(stato.convs[0].lancio_fase).toBe('post_pitch');
    expect(stato.timbrate).toEqual(new Set([1]));
  });
  it('un run gemello non rimanda: le chat timbrate escono dalla coda', async () => {
    await richiesta();
    sendTemplate.mockClear();
    chiamate.length = 0;
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 0, sent: 0 });
    expect(sendTemplate).not.toHaveBeenCalled();
  });
  it('gia spedito secondo messages.template_sid: si ripara la fase, non si rimanda', async () => {
    stato.spediti = [{ conversation_id: 1 }];
    await expect((await richiesta()).json()).resolves.toMatchObject({ sent: 1, riparati: 1 });
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'followup_inviato', expect.anything(), { soloDaFasi: ['attesa', 'posto_bloccato', 'link_inviato'] });
  });
  it('63049: capped, timbro liberato, il run tira dritto e non spegne il lancio', async () => {
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('cap'), { code: 63049 }));
    await expect((await richiesta()).json()).resolves.toMatchObject({ capped: 1, sent: 1, fermo: null });
    expect(tipiEvento()).toContain('lancio_followup_freq_capped');
    expect(stato.timbrate.has(1)).toBe(false);
    expect(upserts()).toHaveLength(0);
  });
  it('errore Twilio senza codice: esito incerto, timbro tenuto', async () => {
    sendTemplate.mockRejectedValueOnce(new Error('socket hang up'));
    await expect((await richiesta()).json()).resolves.toMatchObject({ incerti: 1, sent: 1 });
    expect(stato.timbrate.has(1)).toBe(true);
    expect(tipiEvento()).toContain('lancio_followup_esito_incerto');
  });
  it('oltre il 10% di falliti il freno ferma il run e spegne lancio_attivo (C6)', async () => {
    stato.convs = Array.from({ length: 60 }, (_, i) => conv(i + 1));
    for (const c of stato.convs) stato.messaggi.set(c.id, righe(c.id, ['si', '2026-09-20T10:30:00Z']));
    sendTemplate.mockImplementation(async () => { throw Object.assign(new Error('giu'), { code: 21211 }); });
    const res = await (await richiesta()).json();
    expect(res.fermo).toBe('freno');
    expect(res.failed).toBe(25);
    expect(tipiEvento()).toContain('lancio_followup_freno');
    expect(upserts()).toContainEqual(expect.objectContaining({ key: 'lancio_attivo', value: false }));
  });
  it('i conti tornano: targets = inviati + riparati + capped + falliti + incerti + saltatiInvio + errori + residui; candidati = valutati + nonValutati', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '3');
    stato.convs = [conv(1), conv(2), conv(3, { leads: null }), conv(4)];
    for (const id of [3, 4]) stato.messaggi.set(id, righe(id, ['si', '2026-09-20T10:30:00Z']));
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('giu'), { code: 21211 }));
    const res = await (await richiesta()).json();
    const p = eventoRun()?.payload as Record<string, number>;
    expect(p.candidati).toBe(4);
    expect(p.targets).toBe(3);
    expect(p.nonValutati).toBe(1);
    expect(p.inviati + p.riparati + p.capped + p.falliti + p.incerti + p.saltatiInvio + p.errori + p.residui).toBe(3);
    expect(res).toMatchObject({ sent: 1, failed: 1, skip: 1, nonValutati: 1 });
  });
  it('il run si scrive anche senza candidati', async () => {
    stato.convs = [];
    await expect((await richiesta()).json()).resolves.toMatchObject({ candidati: 0, sent: 0 });
    expect(eventoRun()).toBeTruthy();
  });
});
```

Run: `bunx vitest run app/api/cron/lancio-followup/route.test.ts`
Expected: FAIL (route mancante).

- [ ] **Step 2: Implementa `app/api/cron/lancio-followup/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getTemplateBody } from '@/lib/twilio';
import { renderBodyTemplate } from '@/lib/campaigns';
import { templateName } from '@/lib/name';
import { getLancioSettings } from '@/lib/lancio-settings';
import { marcaCongedo, leggiIngressoLancioAt } from '@/lib/lancio-db';
import { congedoLancio } from '@/lib/lancio-effetti';
import { logCronQueryError } from '@/lib/cron-query-error';
import { batchMax, LANCIO_BLAST_CONCURRENCY } from '@/lib/lancio-zoom-blast';
import type { RigaLancio } from '@/lib/lancio-fase';
import {
  FASI_FOLLOWUP, inFinestraFollowup, finestraFollowupChiusa, ancoraLancio, decideFollowup,
  lancioFollowupText, NOTA_CONGEDO_FOLLOWUP, type MotivoSalto,
} from '@/lib/lancio-followup';
import {
  autorizzatoCron, leggiParametriCron, logEvento, leggiCoda, nuovoStatoRun, inviaTemplateTimbrato,
  eseguiLotti, frenaLancio, TEMPO_MASSIMO_MS, type EsitoInvio,
} from '@/lib/lancio-blast-motore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Follow-up del giorno dopo la live (spec §5.5): ogni 5' nelle fasce 12:00-14:00 e
// 17:30-19:30 di Roma del giorno dopo l'evento e di dopodomani, a lotti di
// LANCIO_BATCH_MAX (200), a chi ha interagito dopo il benvenuto e non ha scelto.
// Mai a chi si e' congedato (C4), mai a chi ha appena detto no (C1: si congeda senza
// bolla). Stesso motore del blast Zoom: timbro `lancio_followup_inviato_at` prima di
// Twilio, 63049 = capped, esito incerto = timbro tenuto, freno che spegne il lancio.

type Supa = ReturnType<typeof getSupabaseAdmin>;

type Candidata = {
  id: number;
  crm_lead_id: string | null;
  lancio_fase: string | null;
  lancio_info: unknown;
  lancio_benvenuto_at: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};
type RigaMessaggio = RigaLancio & { conversation_id: number };

/** Quante candidate si valutano per giro: una query `messages` per blocco. */
const BLOCCO_VALUTAZIONE = 200;
const MAX_RIGHE_BLOCCO = BLOCCO_VALUTAZIONE * 40;
/** Letture dell'evento `lancio_intake` per run (chat riusate senza benvenuto): oltre,
 *  quelle chat contano `ancora_ignota` adesso e si rivalutano al run dopo. */
export const MAX_LETTURE_INTAKE = 50;

const contatoreSalti = (): Record<MotivoSalto, number> => ({ fase: 0, gia_inviato: 0, congedato: 0, ancora_ignota: 0, mai_scritto: 0 });

export async function GET(req: NextRequest) {
  if (!autorizzatoCron(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase: Supa = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);

  const scriviRun = (payload: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') =>
    logEvento(supabase, 'lancio_followup_run', { attivo: settings.attivo, ...payload }, message, level);

  const parametri = leggiParametriCron(req, { nowRichiedeSolo: true });
  if (!parametri.ok) return NextResponse.json({ ok: false, error: parametri.errore }, { status: 400 });
  const { now, forza, solo, dry } = parametri;

  const configError = async (missing: string[]) => {
    await logEvento(supabase, 'lancio_followup_config_error', { missing }, `[lancio] follow-up saltato: manca ${missing.join(', ')}`, 'error');
    await scriviRun({ motivo: 'config', missing, candidati: 0, inviati: 0 }, `[lancio] follow-up: run saltato per configurazione mancante (${missing.join(', ')})`, 'error');
    return NextResponse.json({ ok: true, skipped: 'config', missing });
  };

  const eventoMs = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  if (Number.isNaN(eventoMs)) return configError(['lancio_evento_at']);
  const evento = new Date(eventoMs);

  const sid = process.env.LANCIO_FOLLOWUP_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const welcomeSid = process.env.LANCIO_WELCOME_TEMPLATE_SID || null;
  const missing = [!sid && 'LANCIO_FOLLOWUP_TEMPLATE_SID', !from && 'TWILIO_WHATSAPP_NUMBER_FENICE'].filter((x): x is string => typeof x === 'string');
  if (missing.length > 0 || !sid || !from) return configError(missing);

  const bersaglio = (select: string, opzioni?: { head: true; count: 'exact' }) => {
    let q = supabase
      .from('conversations')
      .select(select, opzioni)
      .not('lancio_slug', 'is', null)
      .in('lancio_fase', [...FASI_FOLLOWUP])
      .is('lancio_followup_inviato_at', null)
      // Il congedo vince sulla fase (C4): chi si e' tirato indietro non riceve niente.
      .is('lancio_info->>congedo_at', null)
      // Pre-filtro economico: chi non ha MAI scritto non e' un bersaglio. La regola vera
      // (inbound dopo l'ancora del lancio) si applica sulle righe, sotto.
      .not('last_inbound_at', 'is', null)
      // Chat in mano a una persona: un template di marketing sopra sarebbe una seconda voce.
      .is('ai_paused_at', null)
      .is('handed_off_at', null);
    if (solo !== null) q = q.eq('id', solo);
    return q;
  };

  if (!forza && !inFinestraFollowup(now, evento)) {
    const chiusa = finestraFollowupChiusa(now, evento);
    let residui: number | null = null;
    if (chiusa) {
      const { count, error } = await bersaglio('id', { head: true, count: 'exact' });
      residui = error ? null : (count ?? 0);
    }
    await scriviRun(
      { motivo: 'fuori_finestra', finestraChiusa: chiusa, candidati: 0, inviati: 0, residui },
      chiusa ? `[lancio] follow-up: finestra chiusa, ${residui ?? '?'} chat candidate senza follow-up` : '[lancio] follow-up: fuori dalla finestra, nessun invio',
      chiusa ? 'warn' : 'info',
    );
    return NextResponse.json({ ok: true, skipped: 'fuori_finestra', finestraChiusa: chiusa, residui });
  }

  // C7: il freno della sera prima spegne `lancio_attivo`, e questo cron non manderebbe
  // nulla in silenzio per due giorni. Dentro la finestra il silenzio si dichiara a ogni
  // run, a livello warn: la riaccensione e' un gesto umano dal pannello (runbook B6).
  if (!settings.attivo) {
    await logEvento(supabase, 'lancio_followup_fermo', { motivo: 'lancio_attivo_spento', now: now.toISOString() },
      '[lancio] follow-up FERMO: lancio_attivo e\' spento dentro la finestra del follow-up. Riaccendere dal pannello /fenice/impostazioni se il freno della sera prima e\' stato capito.', 'warn');
    await scriviRun({ motivo: 'lancio_non_attivo', candidati: 0, inviati: 0 }, '[lancio] follow-up: lancio spento, nessun invio');
    return NextResponse.json({ ok: true, skipped: 'lancio_non_attivo' });
  }

  if (settings.sender === 'secondario') {
    await logEvento(supabase, 'lancio_sender_secondario_non_disponibile', { sender: settings.sender, from },
      '[lancio] follow-up: chiesto il mittente secondario, non ancora disponibile — si parte dal principale', 'warn');
  }

  const t0 = Date.now();
  const { righe: coda, queryKo } = await leggiCoda<Candidata>(supabase, 'lancio_followup_query_error', (da, a) =>
    bersaglio('id, crm_lead_id, lancio_fase, lancio_info, lancio_benvenuto_at, lancio_followup_inviato_at, last_inbound_at, leads(phone_e164, first_name)')
      .order('id', { ascending: true })
      .range(da, a),
  );

  // ─────────────── valutazione a blocchi: una query messages per blocco ───────────────
  const max = batchMax(process.env.LANCIO_BATCH_MAX);
  const saltati = contatoreSalti();
  const targets: Candidata[] = [];
  const daCongedare: { c: Candidata; leadWords: string }[] = [];
  let valutati = 0;
  let lettureIntake = 0;
  for (let i = 0; i < coda.length && targets.length < max; i += BLOCCO_VALUTAZIONE) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    const blocco = coda.slice(i, i + BLOCCO_VALUTAZIONE);
    const { data, error } = await supabase
      .from('messages')
      .select('conversation_id, direction, body, template_sid, created_at')
      .in('conversation_id', blocco.map((c) => c.id))
      .order('created_at', { ascending: true })
      .limit(MAX_RIGHE_BLOCCO);
    if (error) {
      await logCronQueryError(supabase, 'lancio_followup_messages_query_error', error);
      break;
    }
    const perConv = new Map<number, RigaLancio[]>();
    for (const r of (data ?? []) as unknown as RigaMessaggio[]) {
      const lista = perConv.get(r.conversation_id) ?? [];
      lista.push(r);
      perConv.set(r.conversation_id, lista);
    }
    for (const c of blocco) {
      valutati++;
      const rows = perConv.get(c.id) ?? [];
      // `decideFollowup` rifa' in memoria il filtro del congedo (C4) e quello della fase:
      // se il filtro JSON della query cambiasse forma, il congedato esce comunque qui.
      const ancoraNota = ancoraLancio({ rows, welcomeSid, benvenutoAt: c.lancio_benvenuto_at, ingressoAt: null });
      let ancora = ancoraNota;
      if (!ancora && lettureIntake < MAX_LETTURE_INTAKE) {
        lettureIntake++;
        ancora = await leggiIngressoLancioAt(supabase, c.id);
      }
      const decisione = decideFollowup({
        lancio_fase: c.lancio_fase, lancio_followup_inviato_at: c.lancio_followup_inviato_at, lancio_info: c.lancio_info, rows, ancora,
      });
      if (decisione.kind === 'salta') { saltati[decisione.motivo]++; continue; }
      if (decisione.kind === 'congeda') { daCongedare.push({ c, leadWords: decisione.leadWords }); continue; }
      targets.push(c);
      if (targets.length >= max) break;
    }
  }

  if (dry) {
    return NextResponse.json({ ok: true, dry: true, candidati: coda.length, valutati, targets: targets.length, daCongedare: daCongedare.length, saltati, max, queryKo });
  }

  // ─────────────── C1: chi ha detto no si congeda senza bolla ───────────────
  let congedati = 0;
  for (const { c, leadWords } of daCongedare) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    const phone = c.leads?.phone_e164 ?? null;
    if (!phone) continue;
    await marcaCongedo(supabase, c.id);
    const esitoCongedo = await congedoLancio(
      supabase,
      { conversationId: c.id, phone, from, crmLeadId: c.crm_lead_id, fase: c.lancio_fase },
      leadWords,
      NOTA_CONGEDO_FOLLOWUP,
      { giaInviato: true },
    );
    congedati++;
    await logEvento(supabase, 'lancio_followup_congedo_da_cron', { conversationId: c.id, crmLeadId: c.crm_lead_id, stato: esitoCongedo, leadWords: leadWords.slice(0, 300) },
      `[lancio] conv ${c.id}: aveva detto no, niente follow-up (${esitoCongedo})`);
  }

  // ─────────────── seconda idempotenza ───────────────
  const giaSpediti = new Set<number>();
  if (targets.length > 0) {
    const { data: spediti, error } = await supabase
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', targets.map((c) => c.id))
      .eq('template_sid', sid)
      .not('twilio_status', 'in', '(failed,undelivered)');
    if (error) await logCronQueryError(supabase, 'lancio_followup_messages_query_error', error);
    for (const m of (spediti ?? []) as unknown as { conversation_id: number }[]) giaSpediti.add(m.conversation_id);
  }

  const bodyRaw = await getTemplateBody(sid);
  const stato = nuovoStatoRun();
  const inviaUno = (c: Candidata): Promise<EsitoInvio> => {
    const phone = c.leads?.phone_e164 ?? null;
    if (stato.fermo || !phone) return Promise.resolve('skip');
    const nome = c.leads?.first_name ?? null;
    const vars = { '1': templateName(nome) };
    return inviaTemplateTimbrato(supabase, stato, {
      conv: { id: c.id, crm_lead_id: c.crm_lead_id, phone, nome },
      colonna: 'lancio_followup_inviato_at',
      faseDopo: 'followup_inviato',
      sid, from, vars,
      body: bodyRaw ? renderBodyTemplate(bodyRaw, vars) : lancioFollowupText(nome),
      giaSpedito: giaSpediti.has(c.id),
      // Mentre il template e' in volo il pulsante puo' aver portato la chat a
      // `post_pitch`: la fase non torna indietro, il timbro resta.
      soloDaFasi: FASI_FOLLOWUP,
      prefisso: 'lancio_followup',
      etichetta: 'follow-up',
      eventoInvio: 'lancio_followup_inviato',
    });
  };

  const conti = await eseguiLotti(targets, stato, {
    concorrenza: LANCIO_BLAST_CONCURRENCY,
    t0,
    inviaUno,
    suFreno: (s, c) => frenaLancio(supabase, s, c, { prefisso: 'lancio_followup', etichetta: 'follow-up', candidati: coda.length, lotto: targets.length }),
  });

  // Due code diverse: i bersagli che questo run non ha servito (residui, come nel blast)
  // e le candidate che non ha nemmeno valutato perche' il lotto era gia' pieno.
  const residui = targets.length - conti.report.length;
  const nonValutati = coda.length - valutati;
  const riepilogo = {
    candidati: coda.length, valutati, nonValutati, targets: targets.length, congedati,
    inviati: conti.inviati, riparati: conti.riparati, capped: conti.capped, falliti: conti.falliti,
    incerti: conti.incerti, saltatiInvio: conti.saltati, errori: conti.errori, residui,
    saltati, lettureIntake, tentati: stato.tentati, codici: stato.codici, fermo: stato.fermo, max, sender: settings.sender, queryKo,
  };
  await scriviRun(
    riepilogo,
    `[lancio] follow-up: ${conti.inviati} inviati, ${conti.riparati} riparati, ${conti.capped} cap, ${conti.falliti} falliti, ${conti.incerti} incerti, ${congedati} congedati, ${residui} residui (su ${targets.length} bersagli, ${coda.length} candidati)${stato.fermo ? ` — FERMO: ${stato.fermo}` : ''}`,
    stato.fermo || conti.falliti > 0 || conti.incerti > 0 || conti.errori > 0 ? 'warn' : 'info',
  );

  return NextResponse.json({
    ok: true,
    candidati: coda.length, valutati, targets: targets.length, queryKo,
    sent: conti.inviati, riparati: conti.riparati, capped: conti.capped, failed: conti.falliti,
    incerti: conti.incerti, skip: conti.saltati, errori: conti.errori, congedati, saltati, residui, nonValutati,
    fermo: stato.fermo, max, report: conti.report,
  });
}
```

- [ ] **Step 3: `vercel.json`**

Aggiungi in coda all'array `crons`, dopo la voce `lancio-zoom`:

```json
    {
      "path": "/api/cron/lancio-followup",
      "schedule": "*/5 10-11,15-17 6-7 10 *"
    }
```

- [ ] **Step 4: Verifica**

Run: `bunx vitest run app/api/cron/lancio-followup/route.test.ts app/api/cron/lancio-zoom/route.test.ts lib/lancio-followup.test.ts && bun run typecheck`
Expected: PASS, nessun errore di tipo. `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('ok')"` → `ok`.

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/lancio-followup/route.ts app/api/cron/lancio-followup/route.test.ts vercel.json
git commit -m "feat(lancio): cron del follow-up del giorno dopo sul motore del blast, con congedo di chi ha detto no

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 4 (BOT): il ramo `followup_inviato` nello switch di `eseguiTurnoLancio` passa la mano a Mario nello stesso drain, col video della live (ruling "flusso standard" e ruling 3 della seconda passata, C9)

**Files:**
- Modify: `lib/lancio-turno.ts` (tipo di ritorno di `eseguiTurnoLancio`, riga 51; nuovo ramo PRIMA dello `switch` del B4, riga 74; `welcomeSid`/`righe` righe 61-68)
- Modify: `lib/lancio-turno.test.ts` (un `describe` nuovo)
- Modify: `lib/fenice-autoreply.ts` (`drainMarioReplies`: import riga 20; ramo lancio righe 541-595 — il ciclo `for (let giro = 0; giro < MAX_GIRI_LANCIO; giro++)` a 561-594; `videoGiaInviato` riga 539; opzioni di `generateMarioReply` righe 661-685; `unknownFeniceLinks` riga 755; `ensureConfirmationBlock` righe 771-772)
- Modify: `lib/fenice-autoreply.test.ts` (un `describe` nuovo con `makeDrainSupabase`, righe 283-359, e un `vi.mock('./lancio-settings')`)
- Modify: `lib/outbound-sanitize.ts` (`unknownFeniceLinks`, riga 45) + `lib/outbound-sanitize.test.ts`
- Modify: `lib/confirmation-block.ts` (`containsVideoLink` riga 19, `hasVideoLink` riga 21, `ensureConfirmationBlock` riga 60) + `lib/confirmation-block.test.ts`

**Interfaces:**
- Consumes: `impostaFaseLancio` (dentro un turno: senza `soloDaFasi`, il lucchetto del drain serializza), `getLancioSettings`, `lancioStandardContextNote` e `lancioStandardDrain` (Task 2), `lancioInCorso` (`lib/lancio-fase.ts`: falso per `chiuso`/`restituito`), `generateMarioReply(history, { personaName, giorniPieni, contextNote? })` (`lib/mario.ts`), `MAX_GIRI_LANCIO`, `ultimoInboundAt`, `indiceInboundDopo`, `rileggiRigaLancio` (già nel drain).
- Produces:
  - `eseguiTurnoLancio(...) → Promise<'active' | 'closed' | 'handed_off' | 'handed_to_mario'>` — `'handed_to_mario'` = "ho portato la fase a `chiuso`; il drain prosegua ORA col flusso standard". **Non è uno stato di `ai_status`** e non deve mai finire in `finalStatus`.
  - `unknownFeniceLinks(text, extraKnown?: readonly string[])`, `containsVideoLink(p, extraVideoLinks?: readonly string[])`, `ensureConfirmationBlock(parts, opts?: { extraVideoLinks?: readonly string[] })` — parametri opzionali, retro-compatibili
  - nel drain: `linkExtra` (link ufficiali in più per `unknownFeniceLinks`) e `videoExtra` (link video in più per `containsVideoLink`/`ensureConfirmationBlock`); in questo task entrambi valgono `[videoLive]`; il Task 8 aggiunge il video del GDO SOLO a `linkExtra`
  - eventi `lancio_followup_risposta` (info, dal turno) e `lancio_video_live_link_missing` (warn, una volta per drain)

**Come si "apre" il flusso standard, contro il codice reale.** Il ramo lancio del drain (`fenice-autoreply.ts:541-595`) è un ciclo di al massimo `MAX_GIRI_LANCIO` turni: ogni giro chiama `eseguiTurnoLancio`, assegna il risultato a `finalStatus` (riga 564), esce se non è `'active'` (576), rilegge la riga con `rileggiRigaLancio` (582) e alla fine fa `break` (594) verso la chiusura del round. `finalStatus` finisce grezzo in `conversations.ai_status` (riga 1046). Quindi: il turno `followup_inviato` chiude il lancio (`impostaFaseLancio(chiuso)`) e torna `'handed_to_mario'`; il ciclo lo intercetta PRIMA di assegnare `finalStatus`, alza `passaggioAMario` ed esce dal ciclo; al posto del `break` finale, se `passaggioAMario` è vero, si aggiorna la copia in memoria (`lancio.lancio_fase = 'chiuso'`) e si prosegue nel corpo di Mario dello stesso round (prompt, `splitMarioMessages`, `sendFreeText`, esiti, blocco di conferma). Da quel momento `lancioInCorso` è falso: al round successivo e ai drain successivi la chat è una chat normale, e `FILTRO_FUORI_LANCIO` la lascia ai cron di Mario (C9). L'unica differenza dal flusso standard è la `contextNote` col link della live e il fatto che quel link è "ufficiale" per `unknownFeniceLinks`, `containsVideoLink`, `ensureConfirmationBlock`. Link vuoto: nessuna nota (Mario usa i quattro video classici) + evento warn.

- [ ] **Step 1: Test che falliscono**

In `lib/lancio-turno.test.ts` aggiungi in coda (usa `makeSupabase`, `base`, `WELCOME`, `inb`, `genera`, `sendFreeText`, `turnoAssistenza`, `turnoPostPitch` già importati nel file):

```ts
describe('followup_inviato — il lead ha risposto al follow-up: la chat passa a Mario', () => {
  it('porta la fase a chiuso, scrive l evento e torna handed_to_mario senza bolle, senza modello, senza traccia', async () => {
    const { supabase, calls } = makeSupabase();
    const esito = await eseguiTurnoLancio(supabase, base({
      fase: 'followup_inviato',
      rows: [WELCOME, inb('si'), { direction: 'out', body: 'Ciao Anna, ieri sera alla live...', template_sid: 'HX_FU' }, inb('si mi interessa, dimmi')],
      inboundBody: 'si mi interessa, dimmi',
    }));
    expect(esito).toBe('handed_to_mario');
    expect(calls.convUpdates).toContainEqual(expect.objectContaining({ lancio_fase: 'chiuso' }));
    expect(calls.events.map((e) => e.type)).toContain('lancio_followup_risposta');
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(genera).not.toHaveBeenCalled();
    expect(turnoAssistenza).not.toHaveBeenCalled();
    expect(turnoPostPitch).not.toHaveBeenCalled();
    // Nessuna traccia fenice_ai_reply qui: la scrive il giro di Mario che segue.
    expect(calls.events.map((e) => e.type)).not.toContain('fenice_ai_reply');
  });
});
```

In `lib/fenice-autoreply.test.ts` aggiungi, accanto agli altri `vi.mock` in testa al file:

```ts
const LIVE = 'https://corso.feniceacademy.it/live-webdev-2026';
vi.mock('./lancio-settings', () => ({
  getLancioSettings: vi.fn(async () => ({
    attivo: true, pulsanteAttivo: false, zoomLink: null, videoLiveLink: LIVE, offertaDelMeseLink: null,
    eventoAt: '2026-10-05T21:00:00+02:00', blastPerimetro: 'tutti', sender: 'principale',
  })),
}));
```

poi `import { getLancioSettings } from './lancio-settings';` e `import { eseguiTurnoLancio } from './lancio-turno';` fra gli import (se `eseguiTurnoLancio` è già importato per i test dei giri, non duplicarlo), e in coda al file (usa `makeDrainSupabase`, `ClaimedRow`, `FakeMsgRow` già definiti a righe 261-359):

```ts
describe('drainMarioReplies — dopo il follow-up la chat passa a Mario nello STESSO drain (B5)', () => {
  const FU: FakeMsgRow = { direction: 'out', body: 'Ciao Anna, ieri sera alla live...', template_sid: 'HX_FU', created_at: '2026-10-06T10:10:00Z' };
  const RISPOSTA: FakeMsgRow = { direction: 'in', body: 'si mi interessa, mandami il video', template_sid: null, created_at: '2026-10-06T10:20:00Z' };
  const riga = (): ClaimedRow => ({
    id: 7, ai_started_at: null, crm_lead_id: 'crm7', bot_outcome: null,
    lancio_slug: 'webdev-2026-10', lancio_fase: 'followup_inviato', lancio_info: null,
  });
  const rispostaMario = (testo: string) => ({
    visibleReply: testo, appointmentFixed: false, passToHuman: false, videoWatched: false, outcome: null, scheduledAt: null,
  });

  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(generateMarioReply).mockReset();
    vi.mocked(eseguiTurnoLancio).mockReset();
    vi.mocked(getLancioSettings).mockClear();
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('handed_to_mario: Mario risponde subito, con il link della live nel contesto, e ai_status resta active', async () => {
    vi.mocked(eseguiTurnoLancio).mockResolvedValueOnce('handed_to_mario');
    vi.mocked(generateMarioReply).mockResolvedValueOnce(rispostaMario(`Perfetto! Ecco il video della live: ${LIVE}`));
    const { supabase, calls } = makeDrainSupabase(riga(), [FU, RISPOSTA]);

    await drainMarioReplies(supabase, 7, '+391234567890', () => 0);

    expect(eseguiTurnoLancio).toHaveBeenCalledTimes(1);
    expect(generateMarioReply).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(generateMarioReply).mock.calls[0][1] as { contextNote?: string };
    expect(opts.contextNote).toContain(LIVE);
    expect(opts.contextNote).toContain('conferenza-*');
    expect(calls.messageInserts.map((m) => m.body)).toEqual([`Perfetto! Ecco il video della live: ${LIVE}`]);
    // Il link della live e' ufficiale: nessun "link inventato" a log.
    expect(calls.events.map((e) => e.type)).not.toContain('unknown_fenice_link');
    // Il quarto stato del turno non arriva MAI a conversations.ai_status.
    expect(calls.finalStatusWrites).toEqual(['active']);
    expect(calls.finalStatusWrites).not.toContain('handed_to_mario');
  });

  it('senza lancio_video_live_link: Mario risponde coi video classici (nessuna contextNote) e resta un warn', async () => {
    vi.mocked(getLancioSettings).mockResolvedValueOnce({
      attivo: true, pulsanteAttivo: false, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null,
      eventoAt: '2026-10-05T21:00:00+02:00', blastPerimetro: 'tutti', sender: 'principale',
    });
    vi.mocked(eseguiTurnoLancio).mockResolvedValueOnce('handed_to_mario');
    vi.mocked(generateMarioReply).mockResolvedValueOnce(rispostaMario('Ciao! Raccontami: lavori al momento?'));
    const { supabase, calls } = makeDrainSupabase(riga(), [FU, RISPOSTA]);

    await drainMarioReplies(supabase, 7, '+391234567890', () => 0);

    const opts = vi.mocked(generateMarioReply).mock.calls[0][1] as { contextNote?: string };
    expect(opts.contextNote).toBeUndefined();
    expect(calls.events.map((e) => e.type)).toContain('lancio_video_live_link_missing');
    expect(calls.finalStatusWrites).toEqual(['active']);
  });

  it('un turno che chiude il lancio in altro modo (closed) non passa a Mario e scrive closed', async () => {
    vi.mocked(eseguiTurnoLancio).mockResolvedValueOnce('closed');
    const { supabase, calls } = makeDrainSupabase({ ...riga(), lancio_fase: 'attesa' }, [FU, RISPOSTA]);

    await drainMarioReplies(supabase, 7, '+391234567890', () => 0);

    expect(generateMarioReply).not.toHaveBeenCalled();
    expect(calls.finalStatusWrites).toEqual(['closed']);
  });
});
```

In `lib/outbound-sanitize.test.ts` aggiungi in coda:

```ts
describe('unknownFeniceLinks con link extra (video della live, offerta del mese)', () => {
  const live = 'https://corso.feniceacademy.it/live-webdev-2026';
  it('un link extra noto non e piu inventato; senza extra lo e', () => {
    expect(unknownFeniceLinks(`ecco il video ${live}`, [live])).toEqual([]);
    expect(unknownFeniceLinks(`ecco il video ${live}`)).toEqual([live]);
  });
  it('gli altri link ignoti restano segnalati', () => {
    expect(unknownFeniceLinks(`${live} e https://corso.feniceacademy.it/conferenza-zx`, [live])).toEqual(['https://corso.feniceacademy.it/conferenza-zx']);
  });
});
```

In `lib/confirmation-block.test.ts` aggiungi in coda (l'import di `ensureConfirmationBlock` c'è già; aggiungi `containsVideoLink` all'import da `./confirmation-block`):

```ts
describe('blocco di conferma con un video extra', () => {
  const live = 'https://corso.feniceacademy.it/live-webdev-2026';
  it('containsVideoLink riconosce il link extra solo se glielo si passa', () => {
    expect(containsVideoLink(`guarda ${live}`)).toBe(false);
    expect(containsVideoLink(`guarda ${live}`, [live])).toBe(true);
  });
  it('ensureConfirmationBlock non segnala il video assente se il link extra c e, e aggiunge il FATTO', () => {
    const res = ensureConfirmationBlock([`Ecco il video ${live}`], { extraVideoLinks: [live] });
    expect(res.missingVideoLink).toBe(false);
    expect(res.parts.some((p) => /\bFATTO\b/.test(p))).toBe(true);
    expect(ensureConfirmationBlock([`Ecco il video ${live}`]).missingVideoLink).toBe(true);
  });
});
```

Run: `bunx vitest run lib/lancio-turno.test.ts lib/fenice-autoreply.test.ts lib/outbound-sanitize.test.ts lib/confirmation-block.test.ts`
Expected: FAIL sui casi nuovi (il turno torna `'active'` con silenzio `fase_non_gestita`; il drain fa `break`; gli argomenti in più sono ignorati).

- [ ] **Step 2: Le due funzioni pure sui link**

`lib/outbound-sanitize.ts`, sostituisci `unknownFeniceLinks` (riga 45):

```ts
/** URL del dominio dei video che non sono nella lista ufficiale: vanno loggati,
 * significa che il modello si e inventato un link. `extraKnown` sono i link che
 * arrivano da `app_settings` a runtime (live editata, offerta del mese): per quella
 * conversazione sono ufficiali quanto gli altri. */
export function unknownFeniceLinks(text: string, extraKnown: readonly string[] = []): string[] {
  const found = text.match(FENICE_LINK_RE) ?? [];
  const cleaned = found.map((u) => u.replace(TRAILING_PUNCT_RE, ''));
  return cleaned.filter((u) => !(KNOWN_LINKS as readonly string[]).includes(u) && !extraKnown.includes(u));
}
```

`lib/confirmation-block.ts`: sostituisci le righe 19-21 con

```ts
/** Vero se il testo contiene uno dei link video ufficiali, o uno dei link video extra
 * passati dal chiamante (live editata del lancio). */
export const containsVideoLink = (p: string, extraVideoLinks: readonly string[] = []) =>
  VIDEO_LINKS.some((l) => p.includes(l)) || extraVideoLinks.some((l) => l !== '' && p.includes(l));
```

(cancella `const hasVideoLink = containsVideoLink;`, riga 21: non è usata fuori dal file) e la firma di `ensureConfirmationBlock` (riga 60) con

```ts
export function ensureConfirmationBlock(
  parts: string[],
  opts: { extraVideoLinks?: readonly string[] } = {},
): { parts: string[]; added: string[]; missingVideoLink: boolean } {
  const extra = opts.extraVideoLinks ?? [];
  const hasVideoLink = (p: string) => containsVideoLink(p, extra);
  const out = [...parts];
  const added: string[] = [];

  const videoIdx = out.findIndex(hasVideoLink);
```

Il resto della funzione (pitch, `isStep4`, ritorno) resta identico.

- [ ] **Step 3: Il ramo nello switch di `lib/lancio-turno.ts`**

Cambia la firma (riga 51):

```ts
export async function eseguiTurnoLancio(supabase: Supa, i: TurnoLancioInput): Promise<'active' | 'closed' | 'handed_off' | 'handed_to_mario'> {
```

Sposta il blocco `const welcomeSid = … ; const conBenvenuto = … ; const righe = tagliaRigheDalLancio(…);` (righe 61-68) DOPO il ramo nuovo, che va inserito subito dopo `const genera = i.genera ?? generateLancioReply;`:

```ts
  // Ha risposto al follow-up del giorno dopo (spec §5.5): da qui la chat e' di Mario
  // standard. Si chiude il lancio e si torna 'handed_to_mario': il drain lo intercetta
  // nel ciclo dei giri, esce dal ramo lancio e prosegue NELLO STESSO drain col flusso
  // classico (prompt Mario, slot, form, Conferme), con la sola differenza del video (la
  // live editata, via contextNote). 'handed_to_mario' NON e' uno stato di ai_status.
  // Niente bolla qui, niente traccia `fenice_ai_reply`: a questo inbound risponde Mario
  // fra un istante, e la traccia la scrive lui. Il taglio delle righe non serve: non si
  // interpella nessuno. Nessun `soloDaFasi`: dentro un turno il lucchetto del drain
  // serializza gia'.
  if (i.fase === 'followup_inviato') {
    await impostaFaseLancio(supabase, i.conversationId, 'chiuso');
    await supabase.from('event_log').insert({
      type: 'lancio_followup_risposta',
      payload: { conversationId: i.conversationId, crmLeadId: i.crmLeadId, testo: i.inboundBody.slice(0, 300) } as never,
      message: `[lancio] conv ${i.conversationId}: ha risposto al follow-up, la chat passa a Mario`,
      level: 'info',
    });
    return 'handed_to_mario';
  }
```

- [ ] **Step 4: Il drain (`lib/fenice-autoreply.ts`)**

Import (riga 20, accanto a `eseguiTurnoLancio`): `import { lancioStandardDrain, lancioStandardContextNote } from './lancio-followup';` e `import { getLancioSettings } from './lancio-settings';`.

(a) Dopo `let finalStatus = 'active';` (riga 520) e la lettura di `giorniPieni` (523), prima del `try`:

```ts
  // Lancio Web Developer AI, dopo il follow-up (spec §5.5): la chat e' di Mario standard e
  // il video di preparazione e' la live editata. Il link si legge una volta per drain, e
  // solo se serve; se manca, Mario usa i quattro video classici e resta la traccia.
  let lancioVideoLive: string | null | undefined;
  const leggiVideoLive = async (): Promise<string | null> => {
    if (lancioVideoLive !== undefined) return lancioVideoLive;
    lancioVideoLive = (await getLancioSettings(supabase)).videoLiveLink;
    if (!lancioVideoLive) {
      await supabase.from('event_log').insert({
        type: 'lancio_video_live_link_missing',
        payload: { conversationId, crmLeadId } as never,
        message: `[lancio] conv ${conversationId}: lancio_video_live_link non impostato, Mario usa i video classici`,
        level: 'warn',
      });
    }
    return lancioVideoLive;
  };
```

(b) Cancella la riga 539 (`const videoGiaInviato = rows.some((m) => m.direction === 'out' && containsVideoLink(m.body));`) e il commento sopra: si ricalcola dopo il ramo lancio, coi link extra.

(c) Nel ramo lancio (541-595) cambia SOLO queste righe; i commenti e il resto del ciclo (`ultimoVisto`, `dopoIlTurno`, `iNuovo`, `rileggiRigaLancio`, gli aggiornamenti di `faseTurno`/`infoTurno`/`leadIdTurno`/`righeTurno`/`inboundTurno`) restano come sono:

```ts
        let leadIdTurno = crmLeadId;
        // B5: ha risposto al follow-up. Il turno chiude il lancio e passa la mano a Mario
        // in QUESTO drain: 'handed_to_mario' non e' uno stato di ai_status e non deve mai
        // entrare in finalStatus (che il finally scrive grezzo in conversations).
        let passaggioAMario = false;
        for (let giro = 0; giro < MAX_GIRI_LANCIO; giro++) {
          // La soglia si prende PRIMA del turno: dopo, la cronologia e' gia' cambiata.
          const ultimoVisto = ultimoInboundAt(righeTurno);
          const esitoTurno = await eseguiTurnoLancio(supabase, {
            conversationId, phone, from,
            crmLeadId: leadIdTurno,
            fase: faseTurno,
            nome: gdo.leads?.first_name ?? null,
            rows: righeTurno, inboundBody: inboundTurno,
            // Le risposte del riscaldamento (e il marcatore del congedo): senza, il turno
            // post-pitch ricomincerebbe da capo a ogni messaggio del lead.
            lancioInfo: infoTurno,
          });
          if (esitoTurno === 'handed_to_mario') {
            passaggioAMario = true;
            break;
          }
          finalStatus = esitoTurno;
          // Solo mentre il lancio resta 'active': un congedo o un passaggio umano hanno
          // chiuso la partita.
          if (finalStatus !== 'active') break;
```

e in fondo al ramo, al posto dell'ultimo `break;` (riga 594, quello subito dopo la chiusura del `for`):

```ts
        }
        if (!passaggioAMario) break;
        // Ha risposto al follow-up: il turno ha chiuso il lancio, da qui in poi e' Mario
        // standard NELLO STESSO round. La copia in memoria segue il DB, e finalStatus
        // resta 'active' come per qualunque chat che Mario sta servendo.
        lancio.lancio_fase = 'chiuso';
        finalStatus = 'active';
      }

      // Link ufficiali "in piu'" per questa conversazione: il video della live (lancio).
      // `linkExtra` = link che non sono "inventati"; `videoExtra` = link che valgono
      // come "video gia' uscito" per il blocco di conferma. Qui coincidono; il Task 8
      // aggiunge il video del GDO SOLO a `linkExtra`, per non cambiare il blocco di
      // conferma dei lead postino.
      const lancioStandard = lancioStandardDrain(lancio);
      const videoLive = lancioStandard ? await leggiVideoLive() : null;
      const videoExtra: string[] = videoLive ? [videoLive] : [];
      const linkExtra: string[] = [...videoExtra];
      // Un link del video gia' uscito in questa chat: serve sia alla patch del blocco
      // conferma, sia alla rete di sicurezza sul FATTO qui sotto.
      const videoGiaInviato = rows.some((m) => m.direction === 'out' && containsVideoLink(m.body, videoExtra));
```

(d) Nelle opzioni di `generateMarioReply` (righe 661-685) sostituisci

```ts
          : notaPrimo
            ? { contextNote: notaPrimo }
            : {}),
```

con

```ts
          : lancioStandard && lancioStandardContextNote(videoLive)
            ? { contextNote: lancioStandardContextNote(videoLive) as string }
            : notaPrimo
              ? { contextNote: notaPrimo }
              : {}),
```

(e) Riga 755: `const linkInventati = parts.flatMap((p) => unknownFeniceLinks(p));` → `unknownFeniceLinks(p, linkExtra)`. Riga 772: `const block = ensureConfirmationBlock(parts);` → `ensureConfirmationBlock(parts, { extraVideoLinks: videoExtra })`.

`finalStatus` è tipizzato come stringa (`let finalStatus = 'active'`): dopo il confronto con `'handed_to_mario'`, `esitoTurno` è narrowato a `'active' | 'closed' | 'handed_off'` e l'assegnazione compila; il test sul drain dimostra che il quarto stato non arriva a `ai_status`.

- [ ] **Step 5: Verifica, compresa la C9**

Run: `bunx vitest run lib/lancio-turno.test.ts lib/fenice-autoreply.test.ts lib/lancio-followup.test.ts lib/outbound-sanitize.test.ts lib/confirmation-block.test.ts && bun run typecheck`
Expected: PASS, nessun errore di tipo.

C9 (solo verifica, cancello automatico già esistente): `bunx vitest run lib/lancio-fase.test.ts -t "chiuso e restituito"` → PASS: `lancioInCorso` è falso su `chiuso` e `FILTRO_FUORI_LANCIO = 'lancio_slug.is.null,lancio_fase.in.(chiuso,restituito)'` (`lib/lancio-fase.ts:23,124-134`), quindi una chat chiusa dal follow-up senza esito rientra in `sequence-touches`, `bot-followups`, `precall-reminders`, `gdo-video-followups`, `riapri-mute`, `agenda-followup` come una chat normale. Nessun codice da scrivere.

Prova manuale (B6, con un numero di test): conversazione con `lancio_slug='webdev-2026-10'`, `lancio_fase='followup_inviato'`, `lancio_video_live_link` impostato → il lead risponde "sì mi interessa" → su `conversations` `lancio_fase='chiuso'` e `ai_status='active'`; in `event_log` `lancio_followup_risposta` poi `fenice_ai_reply` nello stesso minuto; quando Mario manda il video, il messaggio contiene il link della live e non un `conferenza-*`; nessun `unknown_fenice_link`.

- [ ] **Step 6: Commit**

```bash
git add lib/lancio-turno.ts lib/lancio-turno.test.ts lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts lib/outbound-sanitize.ts lib/outbound-sanitize.test.ts lib/confirmation-block.ts lib/confirmation-block.test.ts
git commit -m "feat(lancio): chi risponde al follow-up passa a Mario nello stesso drain, col video della live al posto dei quattro classici

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 5 (BOT): restituzioni al pool — regole pure + cron `/api/cron/lancio-restituzioni` con lo sweeper del congedo (rulings R2, C2)

**Files:**
- Modify: `lib/bot-outcome.ts` (`sendOutcome`: tipo di ritorno riga 617, ramo `if (res.ok)` righe 829-884) + `lib/bot-outcome.test.ts`
- Create: `lib/lancio-restituzioni.ts`
- Create: `lib/lancio-restituzioni.test.ts`
- Create: `app/api/cron/lancio-restituzioni/route.ts`
- Create: `app/api/cron/lancio-restituzioni/route.test.ts`
- Modify: `vercel.json` (due voci in coda a `crons`)

**Interfaces:**
- Consumes: `haCongedo`, `paroleDelCongedo(rows) → string | null` (`lib/lancio-fase.ts:264`), `type RigaLancio` (`lib/lancio-fase.ts`); `giorniLancio` (`lib/lancio-scelta.ts`); `romeDayKey`, `formatRomeDateTime` (`lib/rome-time.ts`); `ancoraLancio`, `haInteragito` (Task 2); `sendOutcome(supabase, conversationId, { outcome: 'NON_RISPOSTO', note }) → { sent, status?, error?, corpo? }` (`lib/bot-outcome.ts:612-617`: su 2xx scrive `bot_outcome`/`bot_outcome_at`/`ai_status='closed'` da sé; su 403 chiude localmente; `validateOutcomeBody` accetta `NON_RISPOSTO` senza data; **`corpo` è il campo nuovo di questo task**); `congedoLancio(..., { giaInviato: true })` e `impostaFaseLancio` (senza `soloDaFasi`: `restituito` e `chiuso` sono terminali e la riga è già `closed`); `leggiIngressoLancioAt`; motore (Task 1: `autorizzatoCron`, `leggiParametriCron`, `logEvento`, `leggiCoda`, `TEMPO_MASSIMO_MS`), `runPool`, `batchMax`, `LANCIO_BLAST_CONCURRENCY`.
- Produces:
  - `RESTITUZIONE_ATTESA_MS = 48h`, `type MotivoRestituzione = 'mai_risposto' | 'silenzio_dopo_followup' | 'followup_non_inviato'`, `NOTA_RESTITUZIONE`, `FASI_RESTITUIBILI = ['attesa', 'posto_bloccato', 'link_inviato', 'followup_inviato']`
  - `restituzioniAttive(now: Date, eventoAt: Date): boolean` — dal giorno DOPO dopodomani (8/10 per l'evento del 5)
  - `type DecisioneRestituzione = { kind: 'restituisci'; motivo } | { kind: 'ritenta_scarto' } | { kind: 'niente'; motivo: MotivoNiente }`
  - `decideRestituzione(c: CandidataRestituzione, nowMs: number): DecisioneRestituzione`
  - `notaInboundDopoRestituzione(testo: string, quandoIso: string): string` (usata dal Task 6)
  - `type EsitoCrmRestituzione = 'restituito' | 'gia_restituito' | 'rifiutato_dal_crm' | 'non_confermato' | 'terminale' | 'ritenta'` e `esitoRestituzioneDalCrm(res: { sent: boolean; status?: number; corpo?: Record<string, unknown> }): { esito: EsitoCrmRestituzione; skipped: string | null }` — legge il corpo della risposta del CRM (ruling 4 della seconda passata)
  - `sendOutcome(...)` torna anche `corpo?: Record<string, unknown>` (il JSON della risposta 2xx del CRM, se leggibile) — ~10 righe in `lib/bot-outcome.ts`, nessun altro cambio di comportamento
  - `NOTA_SCARTO_RITENTATO` (costante del route, nota del `DA_SCARTARE` ritentato dallo sweeper)
  - route `GET /api/cron/lancio-restituzioni` (auth; `?dry=1`; `?forza=1&solo=<id>`; `?now=<iso>&solo=<id>`) → `{ ok, skipped? | candidati, valutati, nonValutati, daRestituire, restituiti, giaRestituiti, rifiutati, rifiutateDalCrm, nonConfermate, errori, residui, scartiRitentati, scartiChiusi, niente: {...}, max, queryKo }`. Eventi: `lancio_restituzioni_run` (sempre), `lancio_restituzioni_config_error`, `lancio_restituzioni_query_error`, `lancio_restituzioni_messages_query_error`, `lancio_restituito` (per lead), `lancio_restituzione_rifiutata` (warn: il CRM ha risposto 200 ma `returnedToPool: false` con uno `skipped` diverso da `already_returned`, o un corpo illeggibile), `lancio_restituzione_error`, `lancio_scarto_ritentato_da_cron`. Fase `restituito` via `impostaFaseLancio` + `ai_status='closed'` **solo** su `restituito`/`gia_restituito`/`terminale`.

**Regole (in quest'ordine, lo stesso del codice).** `crm_lead_id` nullo → niente (`senza_crm`). `congedo_at` presente e fase ∉ {`chiuso`, `restituito`} → **`ritenta_scarto`** (C2: il congedo era uscito e il CRM aveva rifiutato lo scarto; con `bot_outcome` già scritto — 403 registrato localmente — si porta solo la fase a `chiuso`, senza richiamare il CRM). Fase fuori da `FASI_RESTITUIBILI` → niente (`fase`: `post_pitch`, `scelta_fatta`, `chiuso`, `restituito` non si toccano — chi ha scelto è del venditore; il CRM lo ribadisce con `scelta_fatta`; su una chat `post_pitch` con un esito già dato il motivo contato è `fase`, non `esito_presente`). `bot_outcome` non nullo → niente (`esito_presente`: il CRM ha già questo lead in uno stato). Ancora ignota → niente (`ancora_ignota`: non si può dire se ha interagito, si lascia a una persona). Fasi `attesa`/`posto_bloccato`/`link_inviato`: non ha interagito → `mai_risposto`; ha interagito e `lancio_followup_inviato_at` nullo → `followup_non_inviato` (R2: cap 63049 per tutta la finestra, SID mancante, freno, o `lancio_attivo` spento); ha interagito e timbro presente con fase indietro (esito incerto del follow-up) → stesse regole di `followup_inviato`. Fase `followup_inviato`: timbro nullo → niente (`incoerente`); prima di 48 h dal timbro → niente (`attesa_48h`); un inbound dopo il timbro → niente (`ha_risposto`: la chiude il drain); altrimenti `silenzio_dopo_followup`. Esito al CRM sempre `NON_RISPOSTO` (spec §5.8): il CRM legge il motivo dalla nota.

**Cosa risponde il CRM e cosa se ne fa (ruling 4 della seconda passata).** Il ramo lancio di `/api/bot/outcome` (CRM `route.ts:556-562`) risponde `200 { ok: true, returnedToPool: true, motivo }` quando il lead è tornato nel pool; `200 { ok: true, returnedToPool: false, skipped: <reason> }` quando `checkLancioReturnToPool` lo ha fermato (`reason ∈ not_lancio | not_bot | already_rejected | locked_appointment | scelta_fatta | lead_not_found`, `lancioReturn.ts:38-41`); `200 { ok: true, returnedToPool: false, skipped: 'already_returned' }` su un doppione (`route.ts:190`). Finora `sendOutcome` buttava il corpo del 2xx: il cron lo legge (`res.corpo`) e segna `restituito` **solo** su `returnedToPool: true` o `skipped: 'already_returned'`; su ogni altro `skipped`, o su un corpo illeggibile, scrive `lancio_restituzione_rifiutata` (warn) e **non tocca la fase** — è un lead che un GDO ha già fissato (`locked_appointment`) o che ha scelto (`scelta_fatta`): lo guarda una persona. Effetto collaterale dichiarato: su un 2xx `sendOutcome` ha già scritto `bot_outcome='NON_RISPOSTO'` e `ai_status='closed'` localmente (`bot-outcome.ts:859-866`), quindi al run dopo quella riga esce con `esito_presente` e non si ritenta: nessun loop, ma il rifiuto resta visibile solo nell'evento. 403/404 (lead non più del bot / inesistente) restano terminali → `restituito` (contati in `rifiutati`); rete/5xx/409 → `ritenta` al run dopo.

- [ ] **Step 1: Test delle regole pure che fallisce**

```ts
// lib/lancio-restituzioni.test.ts
import { describe, it, expect } from 'vitest';
import {
  RESTITUZIONE_ATTESA_MS, NOTA_RESTITUZIONE, FASI_RESTITUIBILI, restituzioniAttive, decideRestituzione,
  esitoRestituzioneDalCrm, notaInboundDopoRestituzione, type CandidataRestituzione,
} from './lancio-restituzioni';

const H = 3600_000;
const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const NOW = Date.parse('2026-10-08T10:00:00+02:00');
const c = (over: Partial<CandidataRestituzione> = {}): CandidataRestituzione => ({
  lancio_fase: 'attesa',
  lancio_followup_inviato_at: null,
  last_inbound_at: null,
  crm_lead_id: 'lead-1',
  bot_outcome: null,
  lancio_info: null,
  ancora: '2026-09-20T10:00:00Z',
  haInteragito: false,
  ...over,
});

describe('restituzioniAttive — dal giorno dopo dopodomani (8/10 per l evento del 5)', () => {
  it('7/10 23:59 Roma no, 8/10 00:00 Roma si, e segue l evento', () => {
    expect(restituzioniAttive(new Date('2026-10-07T23:59:00+02:00'), EVENTO)).toBe(false);
    expect(restituzioniAttive(new Date('2026-10-08T00:00:00+02:00'), EVENTO)).toBe(true);
    expect(restituzioniAttive(new Date('2026-10-20T10:00:00+02:00'), EVENTO)).toBe(true);
    expect(restituzioniAttive(new Date('2026-10-08T10:00:00+02:00'), new Date('2026-10-12T21:00:00+02:00'))).toBe(false);
  });
});

describe('decideRestituzione', () => {
  it('senza lead CRM: niente', () => {
    expect(decideRestituzione(c({ crm_lead_id: null }), NOW)).toEqual({ kind: 'niente', motivo: 'senza_crm' });
  });
  it('C2: congedo uscito e fase non chiusa → ritenta lo scarto, in qualunque fase', () => {
    for (const f of ['attesa', 'link_inviato', 'post_pitch']) {
      expect(decideRestituzione(c({ lancio_fase: f, lancio_info: { congedo_at: '2026-10-05T23:00:00Z' }, haInteragito: true }), NOW)).toEqual({ kind: 'ritenta_scarto' });
    }
    expect(decideRestituzione(c({ lancio_fase: 'chiuso', lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }), NOW)).toEqual({ kind: 'niente', motivo: 'fase' });
  });
  it('un esito gia dato non si sovrascrive; su una fase fuori perimetro conta prima la fase', () => {
    expect(decideRestituzione(c({ bot_outcome: 'APPUNTAMENTO' }), NOW)).toEqual({ kind: 'niente', motivo: 'esito_presente' });
    expect(decideRestituzione(c({ lancio_fase: 'post_pitch', bot_outcome: 'APPUNTAMENTO' }), NOW)).toEqual({ kind: 'niente', motivo: 'fase' });
  });
  it('post_pitch, scelta_fatta, chiuso, restituito, null: mai', () => {
    for (const f of ['post_pitch', 'scelta_fatta', 'chiuso', 'restituito', null]) {
      expect(decideRestituzione(c({ lancio_fase: f }), NOW)).toEqual({ kind: 'niente', motivo: 'fase' });
    }
  });
  it('ancora ignota: si lascia a una persona', () => {
    expect(decideRestituzione(c({ ancora: null }), NOW)).toEqual({ kind: 'niente', motivo: 'ancora_ignota' });
  });
  it('attesa/posto_bloccato/link_inviato senza interazione → mai_risposto', () => {
    for (const f of ['attesa', 'posto_bloccato', 'link_inviato']) {
      expect(decideRestituzione(c({ lancio_fase: f }), NOW)).toEqual({ kind: 'restituisci', motivo: 'mai_risposto' });
    }
  });
  it('R2: ha interagito ma il follow-up non e mai partito → followup_non_inviato', () => {
    expect(decideRestituzione(c({ lancio_fase: 'link_inviato', haInteragito: true }), NOW)).toEqual({ kind: 'restituisci', motivo: 'followup_non_inviato' });
    expect(decideRestituzione(c({ lancio_fase: 'posto_bloccato', haInteragito: true }), NOW)).toEqual({ kind: 'restituisci', motivo: 'followup_non_inviato' });
  });
  it('timbro del follow-up presente con fase indietro (esito incerto): valgono le regole del followup_inviato', () => {
    const fu = new Date(NOW - RESTITUZIONE_ATTESA_MS - H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'link_inviato', haInteragito: true, lancio_followup_inviato_at: fu }), NOW)).toEqual({ kind: 'restituisci', motivo: 'silenzio_dopo_followup' });
  });
  it('followup_inviato: silenzio dopo 48h → silenzio_dopo_followup; prima no; con risposta no', () => {
    const fu = new Date(NOW - RESTITUZIONE_ATTESA_MS - H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: fu, last_inbound_at: '2026-10-05T20:00:00Z' }), NOW)).toEqual({ kind: 'restituisci', motivo: 'silenzio_dopo_followup' });
    const recente = new Date(NOW - RESTITUZIONE_ATTESA_MS + H).toISOString();
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: recente }), NOW)).toEqual({ kind: 'niente', motivo: 'attesa_48h' });
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true, lancio_followup_inviato_at: fu, last_inbound_at: new Date(NOW - H).toISOString() }), NOW)).toEqual({ kind: 'niente', motivo: 'ha_risposto' });
    expect(decideRestituzione(c({ lancio_fase: 'followup_inviato', haInteragito: true }), NOW)).toEqual({ kind: 'niente', motivo: 'incoerente' });
  });
  it('le note al CRM sono esattamente quelle che il CRM riconosce', () => {
    expect(NOTA_RESTITUZIONE).toEqual({
      mai_risposto: 'Lancio: mai risposto',
      silenzio_dopo_followup: 'Lancio: silenzio dopo il follow-up',
      followup_non_inviato: 'Lancio: follow-up non inviato',
    });
    expect([...FASI_RESTITUIBILI]).toEqual(['attesa', 'posto_bloccato', 'link_inviato', 'followup_inviato']);
  });
});

describe('esitoRestituzioneDalCrm — si legge il corpo, non solo lo status', () => {
  it('returnedToPool true → restituito; already_returned → gia_restituito', () => {
    expect(esitoRestituzioneDalCrm({ sent: true, status: 200, corpo: { ok: true, returnedToPool: true, motivo: 'mai_risposto' } })).toEqual({ esito: 'restituito', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped: 'already_returned' } })).toEqual({ esito: 'gia_restituito', skipped: 'already_returned' });
  });
  it('un 200 che dice "non l ho restituito" e un rifiuto, con il suo motivo', () => {
    for (const skipped of ['locked_appointment', 'scelta_fatta', 'already_rejected', 'not_bot', 'lead_not_found']) {
      expect(esitoRestituzioneDalCrm({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped } })).toEqual({ esito: 'rifiutato_dal_crm', skipped });
    }
  });
  it('un 2xx senza corpo leggibile non e una conferma', () => {
    expect(esitoRestituzioneDalCrm({ sent: true, status: 200 })).toEqual({ esito: 'non_confermato', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: true, status: 200, corpo: { ok: true } })).toEqual({ esito: 'non_confermato', skipped: null });
  });
  it('403 e 404 sono terminali; rete e 5xx si ritentano', () => {
    expect(esitoRestituzioneDalCrm({ sent: false, status: 403 })).toEqual({ esito: 'terminale', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: false, status: 404 })).toEqual({ esito: 'terminale', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: false, status: 500 })).toEqual({ esito: 'ritenta', skipped: null });
    expect(esitoRestituzioneDalCrm({ sent: false })).toEqual({ esito: 'ritenta', skipped: null });
  });
});

describe('notaInboundDopoRestituzione', () => {
  it('dice che ha riscritto, quando (ora di Roma) e cosa, e che il bot tace', () => {
    const n = notaInboundDopoRestituzione('ci sono ancora?', '2026-10-09T08:15:00Z');
    expect(n).toContain('dopo il ritorno nel pool');
    expect(n).toContain('alle 10:15');
    expect(n).toContain('"ci sono ancora?"');
    expect(n).toContain('il bot non risponde');
  });
});
```

Run: `bunx vitest run lib/lancio-restituzioni.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 2: Implementa `lib/lancio-restituzioni.ts`**

```ts
import { romeDayKey, formatRomeDateTime } from './rome-time';
import { giorniLancio } from './lancio-scelta';
import { haCongedo } from './lancio-fase';

/**
 * Restituzione al pool (spec §5.8, §4.6; riconciliazione "buco di spec"): dal giorno
 * dopo dopodomani (8/10 per l'evento del 5) chi non ha mai risposto, chi tace 48 ore dopo
 * il follow-up e chi il follow-up non l'ha mai ricevuto tornano al CRM come
 * `NON_RISPOSTO` con una nota fissa; il CRM li rimette nel pool di /import. Qui la sola
 * decisione; il cron `/api/cron/lancio-restituzioni` la applica.
 */

export const RESTITUZIONE_ATTESA_MS = 48 * 3600_000;

export type MotivoRestituzione = 'mai_risposto' | 'silenzio_dopo_followup' | 'followup_non_inviato';

/** Note al CRM: `motivoRestituzioneDaNota` (CRM) le riconosce cosi'. Non cambiare una virgola. */
export const NOTA_RESTITUZIONE: Record<MotivoRestituzione, string> = {
  mai_risposto: 'Lancio: mai risposto',
  silenzio_dopo_followup: 'Lancio: silenzio dopo il follow-up',
  followup_non_inviato: 'Lancio: follow-up non inviato',
};

export const FASI_RESTITUIBILI = ['attesa', 'posto_bloccato', 'link_inviato', 'followup_inviato'] as const;
const FASI_PRIMA_DEL_FOLLOWUP: readonly string[] = ['attesa', 'posto_bloccato', 'link_inviato'];

/** Dal giorno dopo dopodomani (regola a data, derivata dall'evento: nessuno stato). */
export function restituzioniAttive(now: Date, eventoAt: Date): boolean {
  return romeDayKey(now) > giorniLancio(eventoAt).dopodomani;
}

export type MotivoNiente = 'senza_crm' | 'esito_presente' | 'fase' | 'ancora_ignota' | 'incoerente' | 'attesa_48h' | 'ha_risposto';
export type DecisioneRestituzione =
  | { kind: 'restituisci'; motivo: MotivoRestituzione }
  | { kind: 'ritenta_scarto' }
  | { kind: 'niente'; motivo: MotivoNiente };

export type CandidataRestituzione = {
  lancio_fase: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  crm_lead_id: string | null;
  /** Un esito gia' dato (di questo lancio o del giro precedente sulla stessa chat) non si sovrascrive. */
  bot_outcome: string | null;
  lancio_info: unknown;
  /** L'ancora del lancio (`ancoraLancio`, lib/lancio-followup.ts): null = ignota. */
  ancora: string | null;
  /** `haInteragito(rows, ancora)` calcolato dal cron sulle righe `messages`. */
  haInteragito: boolean;
};

export function decideRestituzione(c: CandidataRestituzione, nowMs: number): DecisioneRestituzione {
  if (!c.crm_lead_id) return { kind: 'niente', motivo: 'senza_crm' };
  // C2: il congedo e' uscito ma la fase non e' terminale — il CRM aveva rifiutato lo scarto
  // (o era giu'). Non e' una restituzione: e' uno scarto da ritentare, in qualunque fase.
  if (haCongedo(c.lancio_info) && c.lancio_fase !== 'chiuso' && c.lancio_fase !== 'restituito') return { kind: 'ritenta_scarto' };
  if (!c.lancio_fase || !(FASI_RESTITUIBILI as readonly string[]).includes(c.lancio_fase)) return { kind: 'niente', motivo: 'fase' };
  if (c.bot_outcome !== null) return { kind: 'niente', motivo: 'esito_presente' };
  if (!c.ancora) return { kind: 'niente', motivo: 'ancora_ignota' };

  const timbro = c.lancio_followup_inviato_at;
  if (FASI_PRIMA_DEL_FOLLOWUP.includes(c.lancio_fase)) {
    if (!c.haInteragito) return { kind: 'restituisci', motivo: 'mai_risposto' };
    // Ha interagito e il follow-up non e' mai partito (cap per tutta la finestra, SID
    // mancante, freno, lancio spento): torna al pool lo stesso, con la sua nota (R2).
    if (!timbro) return { kind: 'restituisci', motivo: 'followup_non_inviato' };
    // Timbro presente con fase indietro = esito incerto del follow-up: si tratta come inviato.
  }
  if (!timbro) return { kind: 'niente', motivo: 'incoerente' };
  const fuMs = Date.parse(timbro);
  if (Number.isNaN(fuMs)) return { kind: 'niente', motivo: 'incoerente' };
  if (nowMs < fuMs + RESTITUZIONE_ATTESA_MS) return { kind: 'niente', motivo: 'attesa_48h' };
  const inboundMs = c.last_inbound_at ? Date.parse(c.last_inbound_at) : NaN;
  if (!Number.isNaN(inboundMs) && inboundMs > fuMs) return { kind: 'niente', motivo: 'ha_risposto' };
  return { kind: 'restituisci', motivo: 'silenzio_dopo_followup' };
}

export type EsitoCrmRestituzione = 'restituito' | 'gia_restituito' | 'rifiutato_dal_crm' | 'non_confermato' | 'terminale' | 'ritenta';

/** Un rifiuto del CRM (lead non piu' del bot / inesistente) e' una decisione presa: si
 *  segna `restituito` per non ritentare ogni ora. */
const STATUS_TERMINALI: readonly number[] = [403, 404];

/**
 * Cosa ha detto davvero il CRM (ruling 4 della seconda passata). Il ramo lancio di
 * `/api/bot/outcome` risponde SEMPRE 200 sui lead del lancio, anche quando NON li ha
 * rimessi nel pool (`returnedToPool: false, skipped: <motivo>`): un lead con una call in
 * agenda (`locked_appointment`) o che ha scelto (`scelta_fatta`). Leggere solo lo status
 * lo marcherebbe `restituito` per sempre. Conferma = `returnedToPool: true` o il
 * doppione `already_returned`; un corpo illeggibile non e' una conferma.
 */
export function esitoRestituzioneDalCrm(res: {
  sent: boolean;
  status?: number;
  corpo?: Record<string, unknown>;
}): { esito: EsitoCrmRestituzione; skipped: string | null } {
  if (res.sent) {
    const skipped = typeof res.corpo?.skipped === 'string' ? res.corpo.skipped : null;
    if (res.corpo?.returnedToPool === true) return { esito: 'restituito', skipped: null };
    if (skipped === 'already_returned') return { esito: 'gia_restituito', skipped };
    if (res.corpo?.returnedToPool === false) return { esito: 'rifiutato_dal_crm', skipped };
    return { esito: 'non_confermato', skipped: null };
  }
  if (res.status !== undefined && STATUS_TERMINALI.includes(res.status)) return { esito: 'terminale', skipped: null };
  return { esito: 'ritenta', skipped: null };
}

/** Nota al CRM quando un lead gia' restituito riscrive (ruling C8): chi lo ha in mano
 *  deve sapere che ha scritto e che il bot non gli risponde. */
export function notaInboundDopoRestituzione(testo: string, quandoIso: string): string {
  const parole = testo.trim().slice(0, 300);
  return `Lancio Web Dev AI: il lead ha riscritto su WhatsApp dopo il ritorno nel pool (${formatRomeDateTime(quandoIso)}): "${parole}". Il bot non risponde: il lead e' di chi lo ha in carico.`;
}
```

Run: `bunx vitest run lib/lancio-restituzioni.test.ts`
Expected: PASS.

- [ ] **Step 2b: `sendOutcome` espone il corpo della risposta 2xx (`lib/bot-outcome.ts`)**

Test prima, in `lib/bot-outcome.test.ts` (usa `makeSupabase` del file, righe 44-87; il mock di `fetch` di `beforeEach` non ha `json`, quindi il caso "corpo illeggibile" è quello di default):

```ts
describe('sendOutcome — il corpo della risposta 2xx viene esposto (restituzioni del lancio)', () => {
  it('con un JSON leggibile torna corpo; senza, corpo e undefined e sent resta true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ ok: true, returnedToPool: false, skipped: 'locked_appointment' }),
    })));
    const { supabase } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: mai risposto' });
    expect(res).toMatchObject({ sent: true, status: 200, corpo: { returnedToPool: false, skipped: 'locked_appointment' } });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })));
    const senza = await sendOutcome(makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null }).supabase, 1, { outcome: 'NON_RISPOSTO' });
    expect(senza.sent).toBe(true);
    expect(senza.corpo).toBeUndefined();
  });
});
```

Run: `bunx vitest run lib/bot-outcome.test.ts` → Expected: FAIL (`corpo` assente).

Poi in `lib/bot-outcome.ts`: il tipo di ritorno di `sendOutcome` (riga 617) diventa

```ts
): Promise<{ sent: boolean; status?: number; error?: string; keepOpen?: true; notifySuppressed?: true; corpo?: Record<string, unknown> }> {
```

sopra `sendOutcome` aggiungi

```ts
/** Il JSON di una risposta 2xx del CRM, se c'e' e se e' un oggetto; altrimenti undefined.
 *  Non lancia mai: un corpo che non si legge non rende meno vero l'esito appena inviato. */
async function leggiCorpoJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const j: unknown = await res.json();
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
```

e nel ramo `if (res.ok) {` (riga 829) la prima istruzione diventa `const corpo = await leggiCorpoJson(res);`, mentre i due `return { sent: true, status: res.status };` di quel ramo (quello dell'`interim`, riga 839, e quello finale, riga 884) diventano `return { sent: true, status: res.status, corpo };`. Nient'altro cambia: chi ignora `corpo` (turni, cron, webhook) si comporta come prima.

Run: `bunx vitest run lib/bot-outcome.test.ts lib/lancio-turno.test.ts lib/lancio-effetti.test.ts 2>/dev/null; bunx vitest run lib/bot-outcome.test.ts` → Expected: PASS.

- [ ] **Step 3: Test del route che fallisce**

```ts
// app/api/cron/lancio-restituzioni/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Filtro = { m: string; args: unknown[] };
type Chiamata = { table: string; op: 'select' | 'insert' | 'update' | 'upsert'; arg: unknown; filtri: Filtro[]; opzioni?: { head?: boolean; count?: string } };
const chiamate: Chiamata[] = [];
type Riga = { direction: string; body: string | null; template_sid: string | null; created_at: string; conversation_id: number };
type ConvFinta = {
  id: number; crm_lead_id: string | null; lancio_fase: string | null; lancio_info: Record<string, unknown> | null;
  lancio_benvenuto_at: string | null; lancio_followup_inviato_at: string | null; last_inbound_at: string | null;
  bot_outcome: string | null; leads: { phone_e164: string | null; first_name: string | null } | null;
};
const stato = {
  convs: [] as ConvFinta[],
  messaggi: new Map<number, Riga[]>(),
  settings: {} as Record<string, unknown>,
  convSelectError: null as { message: string; code?: string } | null,
};
const arg = (rec: Chiamata, m: string, col: string) => rec.filtri.find((f) => f.m === m && f.args[0] === col);

function esegui(rec: Chiamata): { data: unknown; error: unknown; count?: number } {
  if (rec.op === 'update') return { data: [], error: null };
  if (rec.op !== 'select') return { data: null, error: null };
  if (rec.table === 'app_settings') return { data: Object.entries(stato.settings).map(([key, value]) => ({ key, value })), error: null };
  if (rec.table === 'conversations') {
    if (stato.convSelectError) return { data: null, error: stato.convSelectError };
    let out = stato.convs.filter((c) => c.lancio_fase !== 'chiuso' && c.lancio_fase !== 'restituito' && c.crm_lead_id !== null);
    const solo = rec.filtri.find((f) => f.m === 'eq' && f.args[0] === 'id');
    if (solo) out = out.filter((c) => c.id === solo.args[1]);
    if (rec.opzioni?.head) return { data: null, error: null, count: out.length };
    const range = (rec.filtri.find((f) => f.m === 'range')?.args as number[] | undefined) ?? [0, 999];
    return { data: out.slice(range[0], range[1] + 1), error: null };
  }
  if (rec.table === 'messages') {
    const ids = (arg(rec, 'in', 'conversation_id')?.args[1] as number[] | undefined) ?? [];
    return { data: ids.flatMap((id) => stato.messaggi.get(id) ?? []), error: null };
  }
  return { data: [], error: null };
}
function query(table: string, op: Chiamata['op'], a: unknown, opzioni?: Chiamata['opzioni']) {
  const rec: Chiamata = { table, op, arg: a, filtri: [], opzioni };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'in', 'not', 'order', 'limit', 'range', 'select']) q[m] = (...args: unknown[]) => { rec.filtri.push({ m, args }); return q; };
  q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(() => esegui(rec)).then(ok, ko);
  return q;
}
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string, o?: Chiamata['opzioni']) => query(table, 'select', s, o),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
      upsert: (r: unknown) => query(table, 'upsert', r),
    }),
  }),
}));
type EsitoOutcome = { sent: boolean; status?: number; error?: string; corpo?: Record<string, unknown> };
const RESTITUITO: EsitoOutcome = { sent: true, status: 200, corpo: { ok: true, returnedToPool: true, motivo: 'mai_risposto' } };
const sendOutcome = vi.fn<(...a: unknown[]) => Promise<EsitoOutcome>>(async () => RESTITUITO);
vi.mock('@/lib/bot-outcome', () => ({ sendOutcome: (...a: unknown[]) => sendOutcome(...a) }));
const impostaFaseLancio = vi.fn(async (...a: unknown[]) => { const c = stato.convs.find((x) => x.id === a[1]); if (c) c.lancio_fase = a[2] as string; });
const leggiIngressoLancioAt = vi.fn<(...a: unknown[]) => Promise<string | null>>(async () => null);
vi.mock('@/lib/lancio-db', () => ({
  impostaFaseLancio: (...a: unknown[]) => impostaFaseLancio(...a),
  leggiIngressoLancioAt: (...a: unknown[]) => leggiIngressoLancioAt(...a),
}));
const congedoLancio = vi.fn<(...a: unknown[]) => Promise<'active' | 'closed' | 'handed_off'>>(async () => 'closed');
vi.mock('@/lib/lancio-effetti', () => ({ congedoLancio: (...a: unknown[]) => congedoLancio(...a) }));

import { GET } from './route';

const SEGRETO = 's';
const WELCOME = 'HXwelcome';
const EVENTO = '2026-10-05T21:00:00+02:00';
const ANCORA = '2026-09-20T10:00:00Z';
const OGGI = '2026-10-08T10:00:00+02:00';
const richiesta = (extra = '', secret: string | null = SEGRETO) =>
  GET({ headers: new Headers(secret ? { authorization: `Bearer ${secret}` } : {}), nextUrl: new URL(`https://x/api/cron/lancio-restituzioni?${extra}`) } as never);
const conv = (id: number, extra: Partial<ConvFinta> = {}): ConvFinta => ({
  id, crm_lead_id: `crm-${id}`, lancio_fase: 'attesa', lancio_info: null, lancio_benvenuto_at: ANCORA,
  lancio_followup_inviato_at: null, last_inbound_at: null, bot_outcome: null,
  leads: { phone_e164: `+3933300000${id}`, first_name: 'mario' }, ...extra,
});
const welcome = (id: number): Riga => ({ conversation_id: id, direction: 'out', body: 'benvenuto', template_sid: WELCOME, created_at: ANCORA });
const inb = (id: number, body: string, created_at: string): Riga => ({ conversation_id: id, direction: 'in', body, template_sid: null, created_at });
const eventi = () => chiamate.filter((c) => c.table === 'event_log' && c.op === 'insert').map((c) => c.arg as Record<string, unknown>);
const tipi = () => eventi().map((e) => e.type);
const eventoRun = () => eventi().find((e) => e.type === 'lancio_restituzioni_run');

beforeEach(() => {
  chiamate.length = 0;
  stato.convs = [conv(1), conv(2, { lancio_fase: 'link_inviato' })];
  stato.messaggi = new Map([[1, [welcome(1)]], [2, [welcome(2)]]]);
  stato.settings = { lancio_attivo: true, lancio_evento_at: EVENTO };
  stato.convSelectError = null;
  sendOutcome.mockReset().mockResolvedValue(RESTITUITO);
  impostaFaseLancio.mockClear();
  congedoLancio.mockClear();
  leggiIngressoLancioAt.mockClear().mockResolvedValue(null);
  vi.stubEnv('CRON_SECRET', SEGRETO);
  vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', WELCOME);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
  vi.stubEnv('LANCIO_BATCH_MAX', '');
  vi.useFakeTimers();
  vi.setSystemTime(new Date(OGGI));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('GET /api/cron/lancio-restituzioni — cancelli', () => {
  it('401 senza segreto', async () => { expect((await richiesta('', null)).status).toBe(401); });
  it('prima dell 8/10 (Roma) non si restituisce nessuno, ma il run resta scritto', async () => {
    vi.setSystemTime(new Date('2026-10-07T23:00:00+02:00'));
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'prima_della_data' });
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(eventoRun()).toBeTruthy();
  });
  it('non dipende da lancio_attivo: spento, restituisce lo stesso', async () => {
    stato.settings.lancio_attivo = false;
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 2 });
  });
  it('evento illeggibile: config error', async () => {
    stato.settings.lancio_evento_at = 'boh';
    await expect((await richiesta()).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(tipi()).toContain('lancio_restituzioni_config_error');
  });
  it('forza=1 e now= vogliono solo=', async () => {
    expect((await richiesta('forza=1')).status).toBe(400);
    expect((await richiesta('now=2026-10-20T10:00:00%2B02:00')).status).toBe(400);
  });
  it('forza=1&solo=<id> prima della data: solo quella conversazione', async () => {
    vi.setSystemTime(new Date('2026-10-07T23:00:00+02:00'));
    await expect((await richiesta('forza=1&solo=2')).json()).resolves.toMatchObject({ restituiti: 1 });
    expect(sendOutcome).toHaveBeenCalledTimes(1);
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 2, expect.anything());
  });
  it('dry: decide e conta, non chiama il CRM', async () => {
    const res = await (await richiesta('dry=1')).json();
    expect(res).toMatchObject({ dry: true, daRestituire: 2 });
    expect(res.motivi).toEqual({ mai_risposto: 2 });
    expect(sendOutcome).not.toHaveBeenCalled();
  });
  it('query fallita: queryKo e log', async () => {
    stato.convSelectError = { message: 'column does not exist', code: '42703' };
    await expect((await richiesta()).json()).resolves.toMatchObject({ queryKo: true, restituiti: 0 });
    expect(tipi()).toContain('lancio_restituzioni_query_error');
  });
});

describe('GET /api/cron/lancio-restituzioni — decisioni e CRM', () => {
  it('mai risposto: NON_RISPOSTO con la nota, fase restituito, ai_status closed, evento', async () => {
    stato.convs = [conv(1)];
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 1, rifiutati: 0, errori: 0 });
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: mai risposto' });
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'restituito');
    const chiusura = chiamate.find((c) => c.table === 'conversations' && c.op === 'update' && (c.arg as Record<string, unknown>).ai_status === 'closed');
    expect(chiusura?.filtri).toContainEqual({ m: 'eq', args: ['id', 1] });
    const ev = eventi().find((e) => e.type === 'lancio_restituito');
    expect(ev?.payload).toMatchObject({ conversationId: 1, crmLeadId: 'crm-1', motivo: 'mai_risposto', status: 200 });
  });
  it('R2: ha interagito ma niente follow-up → "Lancio: follow-up non inviato"', async () => {
    stato.convs = [conv(1, { lancio_fase: 'link_inviato', last_inbound_at: '2026-09-21T10:00:00Z' })];
    stato.messaggi.set(1, [welcome(1), inb(1, 'si', '2026-09-21T10:00:00Z')]);
    await richiesta();
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: follow-up non inviato' });
  });
  it('silenzio 48h dopo il follow-up → "Lancio: silenzio dopo il follow-up"', async () => {
    stato.convs = [conv(1, { lancio_fase: 'followup_inviato', lancio_followup_inviato_at: '2026-10-06T07:00:00Z', last_inbound_at: '2026-09-21T10:00:00Z' })];
    stato.messaggi.set(1, [welcome(1), inb(1, 'si', '2026-09-21T10:00:00Z')]);
    await richiesta();
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: silenzio dopo il follow-up' });
  });
  it('un inbound solo prima dell ancora (chat riusata) e mai risposto per il lancio', async () => {
    stato.convs = [conv(1, { last_inbound_at: '2026-08-01T10:00:00Z' })];
    stato.messaggi.set(1, [inb(1, 'ciao', '2026-08-01T10:00:00Z'), welcome(1)]);
    await richiesta();
    expect(sendOutcome).toHaveBeenCalledWith(expect.anything(), 1, { outcome: 'NON_RISPOSTO', note: 'Lancio: mai risposto' });
  });
  it('ancora ignota (nessun benvenuto, nessun intake): non si tocca e si conta', async () => {
    stato.convs = [conv(1, { lancio_benvenuto_at: null })];
    stato.messaggi.set(1, [inb(1, 'si', '2026-09-21T10:00:00Z')]);
    const res = await (await richiesta()).json();
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(res.niente.ancora_ignota).toBe(1);
    expect(leggiIngressoLancioAt).toHaveBeenCalledWith(expect.anything(), 1);
  });
  it('C2: congedo uscito e fase attesa → ritenta lo scarto senza bolla; con bot_outcome gia scritto solo la fase', async () => {
    stato.convs = [
      conv(1, { lancio_info: { congedo_at: '2026-10-05T23:00:00Z' } }),
      conv(2, { lancio_fase: 'link_inviato', lancio_info: { congedo_at: '2026-10-05T23:30:00Z' }, bot_outcome: 'DA_SCARTARE' }),
    ];
    const res = await (await richiesta()).json();
    expect(res).toMatchObject({ scartiRitentati: 1, scartiChiusi: 1, restituiti: 0 });
    expect(congedoLancio).toHaveBeenCalledTimes(1);
    expect(congedoLancio).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ conversationId: 1 }), '', expect.stringContaining('Lancio Web Dev AI'), { giaInviato: true });
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 2, 'chiuso');
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(tipi()).toContain('lancio_scarto_ritentato_da_cron');
  });
  it('200 con returnedToPool:false e skipped (locked_appointment, scelta_fatta): warn, fase INTATTA, nessun restituito', async () => {
    stato.convs = [conv(1), conv(2)];
    sendOutcome
      .mockResolvedValueOnce({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped: 'locked_appointment' } })
      .mockResolvedValueOnce({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped: 'scelta_fatta' } });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, rifiutateDalCrm: 2, errori: 0 });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    const rifiuti = eventi().filter((e) => e.type === 'lancio_restituzione_rifiutata');
    expect(rifiuti).toHaveLength(2);
    expect(rifiuti[0]?.level).toBe('warn');
    expect(rifiuti.map((e) => (e.payload as Record<string, unknown>).skipped).sort()).toEqual(['locked_appointment', 'scelta_fatta']);
  });
  it('200 already_returned: e un doppione, si segna restituito e non si ritenta', async () => {
    stato.convs = [conv(1)];
    sendOutcome.mockResolvedValueOnce({ sent: true, status: 200, corpo: { ok: true, returnedToPool: false, skipped: 'already_returned' } });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, giaRestituiti: 1 });
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'restituito');
  });
  it('200 senza corpo leggibile non e una conferma: warn e fase intatta', async () => {
    stato.convs = [conv(1)];
    sendOutcome.mockResolvedValueOnce({ sent: true, status: 200 });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, nonConfermate: 1 });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(tipi()).toContain('lancio_restituzione_rifiutata');
  });
  it('403/404 del CRM sono terminali: restituito lo stesso, contato fra i rifiutati', async () => {
    stato.convs = [conv(1), conv(2)];
    sendOutcome.mockResolvedValueOnce({ sent: false, status: 403, error: 'http_403' }).mockResolvedValueOnce({ sent: false, status: 404, error: 'http_404' });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, rifiutati: 2, errori: 0 });
    expect(impostaFaseLancio).toHaveBeenCalledTimes(2);
  });
  it('rete o 5xx: nessuna fase scritta, errore contato, si riprova al run dopo', async () => {
    stato.convs = [conv(1)];
    sendOutcome.mockResolvedValueOnce({ sent: false, error: 'fetch failed' });
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 0, errori: 1 });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
    expect(tipi()).toContain('lancio_restituzione_error');
  });
  it('un esito gia presente non si tocca', async () => {
    stato.convs = [conv(1, { bot_outcome: 'APPUNTAMENTO' })];
    const res = await (await richiesta()).json();
    expect(sendOutcome).not.toHaveBeenCalled();
    expect(res.niente.esito_presente).toBe(1);
  });
  it('il tetto del lotto lascia il resto al run dopo', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '1');
    stato.convs = [conv(1), conv(2)];
    await expect((await richiesta()).json()).resolves.toMatchObject({ restituiti: 1, residui: 0, nonValutati: 1 });
  });
});
```

Run: `bunx vitest run app/api/cron/lancio-restituzioni/route.test.ts`
Expected: FAIL (route mancante).

- [ ] **Step 4: Implementa `app/api/cron/lancio-restituzioni/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings } from '@/lib/lancio-settings';
import { sendOutcome } from '@/lib/bot-outcome';
import { impostaFaseLancio, leggiIngressoLancioAt } from '@/lib/lancio-db';
import { congedoLancio } from '@/lib/lancio-effetti';
import { paroleDelCongedo, type RigaLancio } from '@/lib/lancio-fase';
import { logCronQueryError } from '@/lib/cron-query-error';
import { runPool } from '@/lib/run-pool';
import { batchMax, LANCIO_BLAST_CONCURRENCY } from '@/lib/lancio-zoom-blast';
import { ancoraLancio, haInteragito } from '@/lib/lancio-followup';
import {
  restituzioniAttive, decideRestituzione, esitoRestituzioneDalCrm, NOTA_RESTITUZIONE,
  type MotivoNiente, type MotivoRestituzione,
} from '@/lib/lancio-restituzioni';
import { autorizzatoCron, leggiParametriCron, logEvento, leggiCoda, TEMPO_MASSIMO_MS } from '@/lib/lancio-blast-motore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Restituzioni al pool (spec §5.8): ogni ora dal giorno dopo dopodomani. NON_RISPOSTO
// al CRM con la nota fissa, poi `restituito` + `closed`. Pre-passo (C2): gli scarti
// rifiutati dal CRM dopo un congedo si ritentano senza bolla. NON dipende da
// `lancio_attivo`: spegnere il lancio non deve lasciare lead appesi al bot.

type Supa = ReturnType<typeof getSupabaseAdmin>;
type Candidata = {
  id: number;
  crm_lead_id: string | null;
  lancio_fase: string | null;
  lancio_info: unknown;
  lancio_benvenuto_at: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  bot_outcome: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};
type RigaMessaggio = RigaLancio & { conversation_id: number };

const BLOCCO_VALUTAZIONE = 200;
const MAX_RIGHE_BLOCCO = BLOCCO_VALUTAZIONE * 40;
/** Nota del `DA_SCARTARE` ritentato dallo sweeper (C2): il lead aveva gia' detto no. */
export const NOTA_SCARTO_RITENTATO = 'Lancio Web Dev AI: aveva detto di no e il congedo era gia\' uscito; esito ritentato dal cron.';

const contatoreNiente = (): Record<MotivoNiente, number> =>
  ({ senza_crm: 0, esito_presente: 0, fase: 0, ancora_ignota: 0, incoerente: 0, attesa_48h: 0, ha_risposto: 0 });

export async function GET(req: NextRequest) {
  if (!autorizzatoCron(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase: Supa = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);
  const scriviRun = (payload: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') =>
    logEvento(supabase, 'lancio_restituzioni_run', payload, message, level);

  const parametri = leggiParametriCron(req, { nowRichiedeSolo: true });
  if (!parametri.ok) return NextResponse.json({ ok: false, error: parametri.errore }, { status: 400 });
  const { now, forza, solo, dry } = parametri;

  const eventoMs = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  if (Number.isNaN(eventoMs)) {
    await logEvento(supabase, 'lancio_restituzioni_config_error', { missing: ['lancio_evento_at'] }, '[lancio] restituzioni saltate: manca lancio_evento_at', 'error');
    await scriviRun({ motivo: 'config', candidati: 0, restituiti: 0 }, '[lancio] restituzioni: run saltato per configurazione mancante', 'error');
    return NextResponse.json({ ok: true, skipped: 'config', missing: ['lancio_evento_at'] });
  }
  const evento = new Date(eventoMs);
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE ?? '';
  const welcomeSid = process.env.LANCIO_WELCOME_TEMPLATE_SID || null;

  if (!forza && !restituzioniAttive(now, evento)) {
    await scriviRun({ motivo: 'prima_della_data', candidati: 0, restituiti: 0 }, '[lancio] restituzioni: prima della data, nessun ritorno al pool');
    return NextResponse.json({ ok: true, skipped: 'prima_della_data' });
  }

  const t0 = Date.now();
  const { righe: coda, queryKo } = await leggiCoda<Candidata>(supabase, 'lancio_restituzioni_query_error', (da, a) => {
    let q = supabase
      .from('conversations')
      .select('id, crm_lead_id, lancio_fase, lancio_info, lancio_benvenuto_at, lancio_followup_inviato_at, last_inbound_at, bot_outcome, leads(phone_e164, first_name)')
      .not('lancio_slug', 'is', null)
      // Tutto quello che non e' terminale: le fasi restituibili E gli scarti da
      // ritentare (che possono stare in qualunque fase, `post_pitch` compresa).
      .not('lancio_fase', 'in', '(chiuso,restituito)')
      .not('crm_lead_id', 'is', null);
    if (solo !== null) q = q.eq('id', solo);
    return q.order('id', { ascending: true }).range(da, a);
  });

  // ─────────────── valutazione a blocchi ───────────────
  const max = batchMax(process.env.LANCIO_BATCH_MAX);
  const niente = contatoreNiente();
  const daRestituire: { c: Candidata; motivo: MotivoRestituzione }[] = [];
  const scartiDaRitentare: { c: Candidata; rows: RigaLancio[] }[] = [];
  let valutati = 0;
  for (let i = 0; i < coda.length && daRestituire.length < max; i += BLOCCO_VALUTAZIONE) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    const blocco = coda.slice(i, i + BLOCCO_VALUTAZIONE);
    const { data, error } = await supabase
      .from('messages')
      .select('conversation_id, direction, body, template_sid, created_at')
      .in('conversation_id', blocco.map((c) => c.id))
      .order('created_at', { ascending: true })
      .limit(MAX_RIGHE_BLOCCO);
    if (error) {
      await logCronQueryError(supabase, 'lancio_restituzioni_messages_query_error', error);
      break;
    }
    const perConv = new Map<number, RigaLancio[]>();
    for (const r of (data ?? []) as unknown as RigaMessaggio[]) {
      const lista = perConv.get(r.conversation_id) ?? [];
      lista.push(r);
      perConv.set(r.conversation_id, lista);
    }
    for (const c of blocco) {
      valutati++;
      const rows = perConv.get(c.id) ?? [];
      const ancoraNota = ancoraLancio({ rows, welcomeSid, benvenutoAt: c.lancio_benvenuto_at, ingressoAt: null });
      const ancora = ancoraNota ?? (await leggiIngressoLancioAt(supabase, c.id));
      const decisione = decideRestituzione({
        lancio_fase: c.lancio_fase, lancio_followup_inviato_at: c.lancio_followup_inviato_at, last_inbound_at: c.last_inbound_at,
        crm_lead_id: c.crm_lead_id, bot_outcome: c.bot_outcome, lancio_info: c.lancio_info, ancora, haInteragito: haInteragito(rows, ancora),
      }, now.getTime());
      if (decisione.kind === 'niente') { niente[decisione.motivo]++; continue; }
      if (decisione.kind === 'ritenta_scarto') { scartiDaRitentare.push({ c, rows }); continue; }
      daRestituire.push({ c, motivo: decisione.motivo });
      if (daRestituire.length >= max) break;
    }
  }

  if (dry) {
    const motivi = daRestituire.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.motivo]: (acc[d.motivo] ?? 0) + 1 }), {});
    return NextResponse.json({ ok: true, dry: true, candidati: coda.length, valutati, daRestituire: daRestituire.length, motivi, scartiDaRitentare: scartiDaRitentare.length, niente, queryKo });
  }

  // ─────────────── C2: gli scarti rifiutati dopo un congedo ───────────────
  let scartiRitentati = 0;
  let scartiChiusi = 0;
  for (const { c, rows } of scartiDaRitentare) {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) break;
    if (c.bot_outcome !== null) {
      // Il CRM ha gia' registrato l'esito (o `sendOutcome` l'ha chiuso localmente sul
      // 403): manca solo la fase. Nessuna chiamata al CRM.
      await impostaFaseLancio(supabase, c.id, 'chiuso');
      scartiChiusi++;
      continue;
    }
    const phone = c.leads?.phone_e164 ?? null;
    if (!phone) continue;
    const esito = await congedoLancio(
      supabase,
      { conversationId: c.id, phone, from, crmLeadId: c.crm_lead_id, fase: c.lancio_fase },
      paroleDelCongedo(rows) ?? '',
      NOTA_SCARTO_RITENTATO,
      { giaInviato: true },
    );
    scartiRitentati++;
    await logEvento(supabase, 'lancio_scarto_ritentato_da_cron', { conversationId: c.id, crmLeadId: c.crm_lead_id, fase: c.lancio_fase, stato: esito },
      `[lancio] conv ${c.id}: scarto dopo congedo ritentato dal cron (${esito})`, esito === 'closed' ? 'info' : 'warn');
  }

  // ─────────────── restituzioni ───────────────
  let restituiti = 0;
  let giaRestituiti = 0;
  let rifiutati = 0;
  let rifiutateDalCrm = 0;
  let nonConfermate = 0;
  let errori = 0;
  const lotto = daRestituire;
  let serviti = 0;
  await runPool(lotto, LANCIO_BLAST_CONCURRENCY, async ({ c, motivo }) => {
    if (Date.now() - t0 > TEMPO_MASSIMO_MS) return;
    serviti++;
    try {
      const res = await sendOutcome(supabase, c.id, { outcome: 'NON_RISPOSTO', note: NOTA_RESTITUZIONE[motivo] });
      // Si legge il CORPO della risposta, non solo lo status: il CRM risponde 200 anche
      // quando NON ha rimesso il lead nel pool (`returnedToPool: false, skipped`).
      const { esito, skipped } = esitoRestituzioneDalCrm(res);
      if (esito === 'ritenta') {
        errori++;
        await logEvento(supabase, 'lancio_restituzione_error', { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, status: res.status ?? null, error: res.error ?? null },
          `[lancio] conv ${c.id}: restituzione non riuscita (${res.error ?? res.status ?? 'errore'}), riprovo al prossimo run`, 'error');
        return;
      }
      if (esito === 'rifiutato_dal_crm' || esito === 'non_confermato') {
        // Il CRM ha detto di no (call in agenda, scelta gia' fatta, lead non del bot) o
        // non si e' capito: la fase NON si tocca e lo guarda una persona. `sendOutcome`
        // ha gia' scritto bot_outcome localmente, quindi al run dopo questa riga esce
        // con `esito_presente`: nessun loop, ma il rifiuto resta solo qui.
        if (esito === 'rifiutato_dal_crm') rifiutateDalCrm++; else nonConfermate++;
        await logEvento(supabase, 'lancio_restituzione_rifiutata', { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, esito, skipped, status: res.status ?? null },
          `[lancio] conv ${c.id}: il CRM non ha rimesso il lead nel pool (${skipped ?? 'corpo illeggibile'}): fase intatta, da guardare a mano`, 'warn');
        return;
      }
      await impostaFaseLancio(supabase, c.id, 'restituito');
      // `sendOutcome` chiude gia' su 2xx e 403; sul 404 no. Idempotente.
      await supabase.from('conversations').update({ ai_status: 'closed' }).eq('id', c.id);
      await logEvento(supabase, 'lancio_restituito', { conversationId: c.id, crmLeadId: c.crm_lead_id, motivo, esito, status: res.status ?? null, sent: res.sent },
        esito === 'terminale'
          ? `[lancio] conv ${c.id}: il CRM ha rifiutato (${res.status}), segnata restituita per non ritentare`
          : `[lancio] conv ${c.id} restituita al pool (${esito}): ${NOTA_RESTITUZIONE[motivo]}`,
        esito === 'terminale' ? 'warn' : 'info');
      if (esito === 'restituito') restituiti++;
      else if (esito === 'gia_restituito') giaRestituiti++;
      else rifiutati++;
    } catch (err) {
      errori++;
      await logEvento(supabase, 'lancio_restituzione_error', { conversationId: c.id, motivo, error: err instanceof Error ? err.message : 'errore' },
        `[lancio] conv ${c.id}: restituzione esplosa — ${err instanceof Error ? err.message : 'errore ignoto'}`, 'error');
    }
  });

  const residui = lotto.length - serviti;
  const nonValutati = coda.length - valutati;
  const riepilogo = {
    candidati: coda.length, valutati, nonValutati, daRestituire: lotto.length,
    restituiti, giaRestituiti, rifiutati, rifiutateDalCrm, nonConfermate, errori, residui,
    scartiRitentati, scartiChiusi, niente, max, queryKo,
  };
  await scriviRun(
    riepilogo,
    `[lancio] restituzioni: ${restituiti} restituiti, ${giaRestituiti} gia' restituiti, ${rifiutati} rifiutati (403/404), ${rifiutateDalCrm} non rimessi nel pool dal CRM, ${nonConfermate} non confermati, ${errori} errori, ${scartiRitentati} scarti ritentati, ${scartiChiusi} scarti chiusi, ${residui} residui (su ${lotto.length} da restituire, ${coda.length} candidati)`,
    errori > 0 || rifiutateDalCrm > 0 || nonConfermate > 0 || queryKo ? 'warn' : 'info',
  );
  return NextResponse.json({ ok: true, ...riepilogo });
}
```

- [ ] **Step 5: `vercel.json`**

Aggiungi in coda a `crons` (dopo `lancio-followup`): ogni ora dall'8/10 a fine ottobre e, per la coda che sconfina, la prima metà di novembre. Il route rifà comunque il controllo di data (`restituzioniAttive`), quindi le due voci sono innocue prima dell'8.

```json
    {
      "path": "/api/cron/lancio-restituzioni",
      "schedule": "0 * 8-31 10 *"
    },
    {
      "path": "/api/cron/lancio-restituzioni",
      "schedule": "0 * 1-15 11 *"
    }
```

- [ ] **Step 6: Verifica**

Run: `bunx vitest run lib/lancio-restituzioni.test.ts lib/bot-outcome.test.ts app/api/cron/lancio-restituzioni/route.test.ts && bun run typecheck && node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('ok')"`
Expected: PASS, nessun errore di tipo, `ok`.

- [ ] **Step 7: Commit**

```bash
git add lib/bot-outcome.ts lib/bot-outcome.test.ts lib/lancio-restituzioni.ts lib/lancio-restituzioni.test.ts app/api/cron/lancio-restituzioni/route.ts app/api/cron/lancio-restituzioni/route.test.ts vercel.json
git commit -m "feat(lancio): restituzioni al pool dall'8/10 (mai risposto, silenzio dopo il follow-up, follow-up non inviato), sweeper degli scarti e lettura della risposta del CRM

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 6 (BOT): veto alla riapertura di una chat `restituito` (ruling C8)

**Files:**
- Modify: `lib/fenice-autoreply.ts` (`shouldReopen`, righe 77-88; la riga `if (g.lancioSlug && haCongedo(g.lancioInfo)) return false;` è la 86)
- Modify: `lib/fenice-autoreply.test.ts` (nuovo `describe`)
- Modify: `app/api/webhooks/twilio/route.ts` (blocco della riapertura, righe 437-461, e il gate `shouldAutoReply`, riga 463 — verificati a `f5c8ad6`)
- Modify: `app/api/webhooks/twilio/route.test.ts` (nuovo `describe`)

**Interfaces:**
- Consumes: `sendCrmNota(supabase, conversationId, note)` (`lib/bot-outcome.ts`, rilegge `crm_lead_id` da sé), `notaInboundDopoRestituzione` (Task 5), `after` di `next/server` (già usato nel webhook).
- Produces: `shouldReopen(g: { …, lancioFase?: string | null })` — falso su `lancio_slug` valorizzato e `lancioFase === 'restituito'`; nel webhook, evento `lancio_inbound_dopo_restituzione` (info) + `sendCrmNota` dopo la risposta a Twilio; il drain non parte.

Perché serve: `lancioInCorso('restituito')` è falso per design (la chat è fuori dal lancio), quindi senza veto un lead già restituito al pool che riscrive verrebbe riaperto (`ai_status: 'closed'` → `'active'`) e Mario gli risponderebbe mentre un GDO lo sta chiamando. Il lead è del CRM: si avvisa chi lo ha in carico e si tace.

- [ ] **Step 1: Test che falliscono**

In `lib/fenice-autoreply.test.ts` aggiungi (importa `shouldReopen` dall'import esistente di `./fenice-autoreply`):

```ts
describe('shouldReopen — veto sulle chat del lancio restituite al pool (C8)', () => {
  const base = { aiOwner: 'mario', aiStatus: 'closed', aiPausedAt: null, lancioSlug: 'webdev-2026-10', lancioInfo: null };
  it('restituito: mai, anche se closed e senza congedo', () => {
    expect(shouldReopen({ ...base, lancioFase: 'restituito' })).toBe(false);
  });
  it('chiuso dal follow-up: si riapre come una chat normale', () => {
    expect(shouldReopen({ ...base, lancioFase: 'chiuso' })).toBe(true);
  });
  it('senza slug la fase non conta', () => {
    expect(shouldReopen({ ...base, lancioSlug: null, lancioFase: 'restituito' })).toBe(true);
  });
  it('il congedo continua a vincere', () => {
    expect(shouldReopen({ ...base, lancioFase: 'chiuso', lancioInfo: { congedo_at: '2026-10-05T23:00:00Z' } })).toBe(false);
  });
});
```

In `app/api/webhooks/twilio/route.test.ts` aggiungi il mock di `sendCrmNota` accanto agli altri `vi.mock` (PRIMA degli import del route):

```ts
vi.mock('@/lib/bot-outcome', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  sendCrmNota: vi.fn(async () => ({ sent: true })),
}));
```

poi `import { sendCrmNota } from '@/lib/bot-outcome';` e `import { drainMarioReplies } from '@/lib/fenice-autoreply';` fra gli import, e in coda al file:

```ts
describe('lead restituito al pool che riscrive (C8)', () => {
  beforeEach(() => {
    stato.conv = {
      ai_owner: 'mario', ai_status: 'closed', ai_paused_at: null, handed_off_at: null,
      crm_lead_id: 'L9', bot_outcome: 'NON_RISPOSTO',
      lancio_slug: 'webdev-2026-10', lancio_fase: 'restituito', lancio_ingresso: 'lista', lancio_info: null,
    };
    vi.mocked(sendCrmNota).mockClear();
    vi.mocked(drainMarioReplies).mockClear();
  });
  it('non si riapre, il bot non risponde, si scrive l evento e la nota al CRM', async () => {
    const res = await inbound('ci sono ancora?');
    expect(res.status).toBe(200);
    expect(stato.updates.some((u) => u.valori.ai_status === 'active')).toBe(false);
    expect(eventi('lancio_inbound_dopo_restituzione')).toHaveLength(1);
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(sendCrmNota).mock.calls[0][2])).toContain('dopo il ritorno nel pool');
    expect(drainMarioReplies).not.toHaveBeenCalled();
  });
  it('senza crm_lead_id: evento si, nota no', async () => {
    stato.conv.crm_lead_id = null;
    await inbound('ci sono ancora?');
    expect(eventi('lancio_inbound_dopo_restituzione')).toHaveLength(1);
    expect(sendCrmNota).not.toHaveBeenCalled();
  });
});
```

Run: `bunx vitest run lib/fenice-autoreply.test.ts app/api/webhooks/twilio/route.test.ts`
Expected: FAIL (`shouldReopen` riapre; nessun evento).

- [ ] **Step 2: `shouldReopen`**

In `lib/fenice-autoreply.ts` aggiungi `lancioFase?: string | null;` al parametro di `shouldReopen` e, dopo la riga `if (g.lancioSlug && haCongedo(g.lancioInfo)) return false;`:

```ts
  // Restituito al pool (B5, ruling C8): il lead e' del CRM, non del bot. Riaprire qui
  // rimetterebbe Mario su una persona che un GDO sta chiamando. Il webhook avvisa il CRM.
  if (g.lancioSlug && g.lancioFase === 'restituito') return false;
```

Aggiorna il docblock con una riga: "Falso anche per una chat del lancio in fase `restituito`: il lead è tornato al pool del CRM (ruling C8)."

- [ ] **Step 3: Il webhook**

In `app/api/webhooks/twilio/route.ts`: import `notaInboundDopoRestituzione` da `@/lib/lancio-restituzioni`. Sostituisci il blocco che inizia con `if (conv && shouldReopen({` (riga 437) e finisce con la chiusura del suo `if` (riga 461) con:

```ts
      // Lead del lancio gia' restituito al pool (B5, ruling C8): non si riapre, il bot
      // tace, e chi lo ha in carico sul CRM viene avvisato con una nota — e' l'unico
      // modo perche' non chiami a vuoto una persona che intanto sta scrivendo qui.
      const restituito = !!conv?.lancio_slug && conv.lancio_fase === 'restituito';
      if (conv && restituito) {
        await supabase.from('event_log').insert({
          type: 'lancio_inbound_dopo_restituzione',
          payload: { conversationId, phone, crmLeadId: conv.crm_lead_id, testo: messageBody.slice(0, 300) } as never,
          message: `[lancio] ${phone} ha riscritto dopo il ritorno nel pool (conv ${conversationId}): il bot non risponde`,
          level: 'info',
        });
        if (conv.crm_lead_id) {
          after(sendCrmNota(supabase, conversationId, notaInboundDopoRestituzione(messageBody, new Date().toISOString())));
        }
      }

      if (conv && shouldReopen({
        aiOwner: conv.ai_owner,
        aiStatus: conv.ai_status,
        aiPausedAt: conv.ai_paused_at,
        // Chat del lancio gia' congedata o restituita: non si riapre (vedi `shouldReopen`).
        lancioSlug: conv.lancio_slug,
        lancioInfo: conv.lancio_info,
        lancioFase: conv.lancio_fase,
      })) {
        await supabase.from('conversations').update({ ai_status: 'active' }).eq('id', conversationId);
        conv.ai_status = 'active';
        if (conv.crm_lead_id && conv.bot_outcome && conv.bot_outcome !== 'APPUNTAMENTO') {
          after(
            sendCrmNota(
              supabase,
              conversationId,
              buildBotRipresoNote({ esitoPrecedente: conv.bot_outcome, quandoIso: new Date().toISOString() }),
            ),
          );
        }
      }
```

(i commenti originali sul caso Marina Destefanis e sull'`after()` restano dove sono). Poi il gate dell'auto-risposta:

```ts
      if (!restituito && shouldAutoReply({
```

- [ ] **Step 4: Verifica**

Run: `bunx vitest run lib/fenice-autoreply.test.ts app/api/webhooks/twilio/route.test.ts && bun run typecheck`
Expected: PASS, nessun errore di tipo.

- [ ] **Step 5: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts app/api/webhooks/twilio/route.ts app/api/webhooks/twilio/route.test.ts
git commit -m "feat(lancio): un lead restituito al pool che riscrive non torna al bot, il CRM riceve una nota

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 7 (BOT): pagina `/fenice/impostazioni` con le 8 chiavi, validazione, ruolo admin (rulings R1, "Pagina")

**Files:**
- Modify: `lib/lancio-settings.ts` (aggiunge `LANCIO_EDITABLE_KEYS`, `validateLancioSettingInput`; niente altro cambia)
- Modify: `lib/lancio-settings.test.ts`
- Modify: `lib/access.ts` (aggiunge `puoModificareLancio`) + `lib/access.test.ts`
- Create: `app/api/fenice/lancio-settings/route.ts`
- Create: `app/(fenice)/fenice/impostazioni/page.tsx`
- Create: `app/(fenice)/fenice/impostazioni/_components/ImpostazioniLancioPanel.tsx`
- Modify: `components/FeniceSidebar.tsx` (array `NAV`)

**Interfaces:**
- Consumes: `LANCIO_SETTING_KEYS`, `getLancioSettings`, `setLancioSetting(supabase, key, value: string | boolean)` (`lib/lancio-settings.ts:24-34, 108-121`; `normalizza`/`stringaOrNull` sono funzioni private dello stesso file, righe 81-89, e si usano da dentro), `isoWithOffset` (`lib/bot-contract.ts:145`; il modulo è puro — unico import `LANCIO_SLUG` da `lancio-fase` — quindi importarlo in `lancio-settings.ts` non trascina Supabase né Twilio), `areaForEmail` (`lib/access.ts:9`), `getSupabaseServer`/`getSupabaseAdmin`, `PageHeader({ icon, kicker, title, description, actions? })` (`components/fenice/PageHeader.tsx`), `Button`, `Input`, `Label`, `Switch` (`components/ui/switch.tsx`: wrapper di Radix `SwitchPrimitives.Root`, quindi accetta `checked`, `onCheckedChange(checked: boolean)`, `disabled`, `id`).
- Produces:
  - `LANCIO_EDITABLE_KEYS = LANCIO_SETTING_KEYS` (tutte e 8: ruling "Pagina"), `type SettingValidation = { ok: true; value: string | boolean } | { ok: false; reason: 'chiave_non_modificabile' | 'link_non_https' | 'data_non_valida' | 'valore_non_valido' }`, `validateLancioSettingInput(key: string, raw: unknown): SettingValidation`
  - `puoModificareLancio(email): boolean` — vero per gli account con area `'all'` (gli account confinati a una sola area — `fenicebot@fenice.com` — vedono la pagina in sola lettura). Nel repo non esiste un ruolo nel DB (`lib/access.ts`: "Nessun ruolo nel DB, scelta: dati condivisi"): "admin" qui è l'area `all`.
  - `GET /api/fenice/lancio-settings` → `{ settings: LancioSettings, puoModificare: boolean }`; `POST` body `{ key, value }` → `200 { ok: true, key, value }` | `400 { ok: false, error: reason }` | `401` | `403 { ok: false, error: 'sola_lettura' }`; evento `lancio_setting_changed`
  - pagina con: due interruttori (`lancio_attivo`, `lancio_pulsante_attivo`), tre link (`offerta_del_mese_link`, `lancio_video_live_link`, `lancio_zoom_link`), `lancio_evento_at` (ISO con offset), due `<select>` (`lancio_blast_perimetro`: tutti/risposto; `lancio_sender`: principale/secondario)

**Convenzione dei valori scritti.** Booleani per i due interruttori (è ciò che scrive già il freno: `setLancioSetting('lancio_attivo', false)`; `isAttivo` li legge); stringhe per il resto; **stringa vuota per azzerare un link** (`parseLancioSettings` la legge come `null`; `setLancioSetting` non accetta `null` e non si cambia, ruling R1). `lancio_evento_at` non si azzera: il blast e le finestre ne dipendono.

- [ ] **Step 1: Test che falliscono**

In `lib/lancio-settings.test.ts` aggiungi `LANCIO_EDITABLE_KEYS, validateLancioSettingInput` all'import e in coda:

```ts
describe('validateLancioSettingInput — le regole della pagina', () => {
  it('tutte e 8 le chiavi sono modificabili; una chiave estranea no', () => {
    expect([...LANCIO_EDITABLE_KEYS].sort()).toEqual([...LANCIO_SETTING_KEYS].sort());
    expect(validateLancioSettingInput('fenice_ai_autoreply', true)).toEqual({ ok: false, reason: 'chiave_non_modificabile' });
  });
  it('interruttori: booleano o 0/1/on/off; vuoto = spento; altro = errore', () => {
    for (const k of ['lancio_attivo', 'lancio_pulsante_attivo']) {
      expect(validateLancioSettingInput(k, true)).toEqual({ ok: true, value: true });
      expect(validateLancioSettingInput(k, '1')).toEqual({ ok: true, value: true });
      expect(validateLancioSettingInput(k, 'off')).toEqual({ ok: true, value: false });
      expect(validateLancioSettingInput(k, '')).toEqual({ ok: true, value: false });
      expect(validateLancioSettingInput(k, 'forse')).toEqual({ ok: false, reason: 'valore_non_valido' });
    }
  });
  it('link: https obbligatorio, spazi tolti, vuoto = azzera (stringa vuota)', () => {
    for (const k of ['offerta_del_mese_link', 'lancio_video_live_link', 'lancio_zoom_link']) {
      expect(validateLancioSettingInput(k, ' https://corso.feniceacademy.it/live-webdev ')).toEqual({ ok: true, value: 'https://corso.feniceacademy.it/live-webdev' });
      expect(validateLancioSettingInput(k, 'http://corso.feniceacademy.it/x')).toEqual({ ok: false, reason: 'link_non_https' });
      expect(validateLancioSettingInput(k, 'ciao')).toEqual({ ok: false, reason: 'link_non_https' });
      expect(validateLancioSettingInput(k, '')).toEqual({ ok: true, value: '' });
      expect(validateLancioSettingInput(k, null)).toEqual({ ok: true, value: '' });
    }
  });
  it('lancio_evento_at: ISO con offset, mai vuoto', () => {
    expect(validateLancioSettingInput('lancio_evento_at', '2026-10-05T21:00:00+02:00')).toEqual({ ok: true, value: '2026-10-05T21:00:00+02:00' });
    expect(validateLancioSettingInput('lancio_evento_at', '2026-10-05 21:00')).toEqual({ ok: false, reason: 'data_non_valida' });
    expect(validateLancioSettingInput('lancio_evento_at', '')).toEqual({ ok: false, reason: 'data_non_valida' });
  });
  it('perimetro e mittente: solo i due valori, vuoto = default', () => {
    expect(validateLancioSettingInput('lancio_blast_perimetro', ' Risposto ')).toEqual({ ok: true, value: 'risposto' });
    expect(validateLancioSettingInput('lancio_blast_perimetro', '')).toEqual({ ok: true, value: 'tutti' });
    expect(validateLancioSettingInput('lancio_blast_perimetro', 'alcuni')).toEqual({ ok: false, reason: 'valore_non_valido' });
    expect(validateLancioSettingInput('lancio_sender', 'secondario')).toEqual({ ok: true, value: 'secondario' });
    expect(validateLancioSettingInput('lancio_sender', null)).toEqual({ ok: true, value: 'principale' });
    expect(validateLancioSettingInput('lancio_sender', 'terzo')).toEqual({ ok: false, reason: 'valore_non_valido' });
  });
});
```

In `lib/access.test.ts` aggiungi `puoModificareLancio` all'import e:

```ts
describe('puoModificareLancio — chi scrive le impostazioni del lancio', () => {
  it('gli account con area all si; fenicebot (solo /fenice) no; email sconosciuta = all', () => {
    expect(puoModificareLancio('bruno@esempio.it')).toBe(true);
    expect(puoModificareLancio('fenicebot@fenice.com')).toBe(false);
    expect(puoModificareLancio('campagne@fenice.com')).toBe(false);
    expect(puoModificareLancio(null)).toBe(true);
  });
});
```

Run: `bunx vitest run lib/lancio-settings.test.ts lib/access.test.ts`
Expected: FAIL (export mancanti).

- [ ] **Step 2: `lib/lancio-settings.ts` (solo aggiunte)**

In testa: `import { isoWithOffset } from './bot-contract';`. In coda al file:

```ts
/** Le chiavi che la pagina /fenice/impostazioni puo' scrivere: tutte (ruling B5). */
export const LANCIO_EDITABLE_KEYS: readonly LancioSettingKey[] = LANCIO_SETTING_KEYS;

export type SettingValidation =
  | { ok: true; value: string | boolean }
  | { ok: false; reason: 'chiave_non_modificabile' | 'link_non_https' | 'data_non_valida' | 'valore_non_valido' };

/**
 * Le regole di scrittura dalla pagina. I valori scritti sono quelli che
 * `parseLancioSettings` sa leggere: booleani per i due interruttori (come li scrive il
 * freno), stringhe per il resto, stringa vuota per azzerare un link (letta come null).
 * `lancio_evento_at` non si azzera: blast, follow-up e restituzioni ne derivano le date.
 */
export function validateLancioSettingInput(key: string, raw: unknown): SettingValidation {
  if (!(LANCIO_EDITABLE_KEYS as readonly string[]).includes(key)) return { ok: false, reason: 'chiave_non_modificabile' };
  const k = key as LancioSettingKey;
  if (k === 'lancio_attivo' || k === 'lancio_pulsante_attivo') {
    if (raw === true || raw === false) return { ok: true, value: raw };
    const s = normalizza(raw);
    if (s === null || ['0', 'false', 'off'].includes(s)) return { ok: true, value: false };
    if (['1', 'true', 'on'].includes(s)) return { ok: true, value: true };
    return { ok: false, reason: 'valore_non_valido' };
  }
  if (k === 'lancio_blast_perimetro') {
    const s = normalizza(raw);
    if (s === null || s === 'tutti') return { ok: true, value: 'tutti' };
    if (s === 'risposto') return { ok: true, value: 'risposto' };
    return { ok: false, reason: 'valore_non_valido' };
  }
  if (k === 'lancio_sender') {
    const s = normalizza(raw);
    if (s === null || s === 'principale') return { ok: true, value: 'principale' };
    if (s === 'secondario') return { ok: true, value: 'secondario' };
    return { ok: false, reason: 'valore_non_valido' };
  }
  const v = stringaOrNull(raw);
  if (k === 'lancio_evento_at') {
    if (v === null || !isoWithOffset(v) || Number.isNaN(Date.parse(v))) return { ok: false, reason: 'data_non_valida' };
    return { ok: true, value: v };
  }
  if (v === null) return { ok: true, value: '' };
  if (!/^https:\/\/\S+$/.test(v)) return { ok: false, reason: 'link_non_https' };
  return { ok: true, value: v };
}
```

- [ ] **Step 3: `lib/access.ts`**

In coda:

```ts
/** Chi puo' scrivere le impostazioni del lancio (/fenice/impostazioni): gli account
 *  con area `all`. Gli account confinati a una sola area (il bot, le campagne) le
 *  vedono e basta. Non c'e' un ruolo nel DB: l'area e' l'unica nozione di ruolo qui. */
export function puoModificareLancio(email: string | null | undefined): boolean {
  return areaForEmail(email) === 'all';
}
```

Run: `bunx vitest run lib/lancio-settings.test.ts lib/access.test.ts`
Expected: PASS.

- [ ] **Step 4: API `app/api/fenice/lancio-settings/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings, setLancioSetting, validateLancioSettingInput, type LancioSettingKey } from '@/lib/lancio-settings';
import { puoModificareLancio } from '@/lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

export async function GET() {
  const user = await requireUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const settings = await getLancioSettings(getSupabaseAdmin());
  return NextResponse.json({ settings, puoModificare: puoModificareLancio(user.email) });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  if (!puoModificareLancio(user.email)) return NextResponse.json({ ok: false, error: 'sola_lettura' }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { key?: unknown; value?: unknown };
  const key = typeof body.key === 'string' ? body.key : '';
  const valid = validateLancioSettingInput(key, body.value);
  if (!valid.ok) return NextResponse.json({ ok: false, error: valid.reason }, { status: 400 });
  const admin = getSupabaseAdmin();
  await setLancioSetting(admin, key as LancioSettingKey, valid.value);
  await admin.from('event_log').insert({
    type: 'lancio_setting_changed',
    payload: { key, value: valid.value, by: user.email ?? user.id } as never,
    message: `[lancio] impostazione ${key} = ${valid.value === '' ? '(vuoto)' : String(valid.value)} (${user.email ?? user.id})`,
    level: 'info',
  });
  return NextResponse.json({ ok: true, key, value: valid.value });
}
```

- [ ] **Step 5: Pagina e pannello**

`app/(fenice)/fenice/impostazioni/page.tsx`:

```tsx
import { Settings } from 'lucide-react';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings } from '@/lib/lancio-settings';
import { puoModificareLancio } from '@/lib/access';
import { PageHeader } from '@/components/fenice/PageHeader';
import { ImpostazioniLancioPanel } from './_components/ImpostazioniLancioPanel';

export const dynamic = 'force-dynamic';

export default async function FeniceImpostazioniPage() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  const settings = await getLancioSettings(getSupabaseAdmin());
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Settings}
        kicker="Lancio Web Developer AI"
        title="Impostazioni"
        description="Interruttori, link e mittente del lancio si cambiano da qui, senza deploy: il video della live editata e l'offerta del mese arrivano dopo il 5 ottobre."
      />
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <ImpostazioniLancioPanel initial={settings} puoModificare={puoModificareLancio(user?.email)} />
      </div>
    </div>
  );
}
```

`app/(fenice)/fenice/impostazioni/_components/ImpostazioniLancioPanel.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Save, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { LancioSettings, LancioSettingKey } from '@/lib/lancio-settings';

type Esito = { ok: boolean; text: string };

const ERRORI: Record<string, string> = {
  link_non_https: 'Serve un link completo che inizi con https://',
  data_non_valida: 'Serve una data ISO con fuso, es. 2026-10-05T21:00:00+02:00',
  chiave_non_modificabile: 'Questa impostazione non si cambia da qui.',
  valore_non_valido: 'Valore non valido.',
  sola_lettura: 'Il tuo account vede le impostazioni ma non le cambia.',
};

const CAMPI_TESTO: Array<{ key: LancioSettingKey; label: string; hint: string; placeholder: string }> = [
  { key: 'offerta_del_mese_link', label: 'Video offerta del mese', hint: 'Lo manda Marta quando il GDO sceglie "Offerta del mese" in agenda. Vuoto = nessun video (resta un avviso nei log).', placeholder: 'https://corso.feniceacademy.it/...' },
  { key: 'lancio_video_live_link', label: 'Video della live editata', hint: 'Lo manda Mario, al posto dei quattro video classici, a chi risponde al follow-up del giorno dopo. Vuoto = video classici.', placeholder: 'https://corso.feniceacademy.it/...' },
  { key: 'lancio_zoom_link', label: 'Link Zoom della live', hint: 'Lo manda il blast della sera dell\'evento. Senza, il blast non parte.', placeholder: 'https://us06web.zoom.us/j/...' },
  { key: 'lancio_evento_at', label: 'Inizio della live (ISO con fuso)', hint: 'Da qui derivano blast, finestre del follow-up e data delle restituzioni. Non si azzera.', placeholder: '2026-10-05T21:00:00+02:00' },
];

const CAMPI_SCELTA: Array<{ key: LancioSettingKey; label: string; hint: string; opzioni: Array<{ value: string; label: string }> }> = [
  { key: 'lancio_blast_perimetro', label: 'Perimetro del blast Zoom', hint: '"Tutti" manda il link a chiunque sia in attesa o con il posto bloccato; "risposto" solo a chi ha scritto almeno una volta (piano B).', opzioni: [{ value: 'tutti', label: 'Tutti' }, { value: 'risposto', label: 'Solo chi ha risposto' }] },
  { key: 'lancio_sender', label: 'Mittente del lancio', hint: 'Il secondario non e\' ancora disponibile: sceglierlo lascia un avviso nei log e si parte comunque dal principale.', opzioni: [{ value: 'principale', label: 'Numero principale' }, { value: 'secondario', label: 'Numero secondario' }] },
];

function valoriIniziali(s: LancioSettings): Record<LancioSettingKey, string> {
  return {
    lancio_attivo: s.attivo ? '1' : '0',
    lancio_pulsante_attivo: s.pulsanteAttivo ? '1' : '0',
    lancio_zoom_link: s.zoomLink ?? '',
    lancio_video_live_link: s.videoLiveLink ?? '',
    offerta_del_mese_link: s.offertaDelMeseLink ?? '',
    lancio_evento_at: s.eventoAt ?? '',
    lancio_blast_perimetro: s.blastPerimetro,
    lancio_sender: s.sender,
  };
}

export function ImpostazioniLancioPanel({ initial, puoModificare }: { initial: LancioSettings; puoModificare: boolean }) {
  const [valori, setValori] = useState<Record<LancioSettingKey, string>>(valoriIniziali(initial));
  const [esiti, setEsiti] = useState<Partial<Record<LancioSettingKey, Esito>>>({});
  const [busy, setBusy] = useState<LancioSettingKey | null>(null);

  async function salva(key: LancioSettingKey, value: string | boolean) {
    setBusy(key);
    try {
      const res = await fetch('/api/fenice/lancio-settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; value?: string | boolean };
      if (!res.ok || !data.ok) {
        setEsiti((s) => ({ ...s, [key]: { ok: false, text: ERRORI[data.error ?? ''] ?? 'Errore di salvataggio' } }));
        return;
      }
      setEsiti((s) => ({ ...s, [key]: { ok: true, text: data.value === '' ? 'Azzerato' : 'Salvato' } }));
    } finally {
      setBusy(null);
    }
  }

  const interruttore = (key: 'lancio_attivo' | 'lancio_pulsante_attivo', label: string, hint: string) => (
    <div key={key} className="fenice-rise rounded-2xl border border-border/70 bg-card/60 p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-semibold">{label}</div>
          <div className="text-xs text-muted-foreground">{hint}</div>
        </div>
        <Switch
          checked={valori[key] === '1'}
          disabled={!puoModificare || busy === key}
          onCheckedChange={(on: boolean) => {
            setValori((v) => ({ ...v, [key]: on ? '1' : '0' }));
            void salva(key, on);
          }}
        />
      </div>
      {esiti[key] && <EsitoRiga e={esiti[key] as Esito} />}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      {!puoModificare && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          Il tuo account vede le impostazioni ma non le cambia.
        </div>
      )}

      {interruttore('lancio_attivo', 'Lancio attivo', 'Spento: benvenuti differiti, blast Zoom e follow-up non mandano nulla. Il freno automatico lo spegne da solo: riaccenderlo e\' un gesto umano. Le restituzioni al pool non dipendono da qui.')}
      {interruttore('lancio_pulsante_attivo', 'Pulsante del webinar', 'Acceso la sera della live: la frase del pulsante wa.me porta la chat nel dopo-pitch. Spento, e\' un messaggio come un altro.')}

      {CAMPI_TESTO.map(({ key, label, hint, placeholder }) => (
        <div key={key} className="fenice-rise rounded-2xl border border-border/70 bg-card/60 p-5">
          <Label htmlFor={key} className="text-sm font-semibold">{label}</Label>
          <div className="mb-3 text-xs text-muted-foreground">{hint}</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={key}
              value={valori[key]}
              placeholder={placeholder}
              disabled={!puoModificare}
              onChange={(e) => setValori((v) => ({ ...v, [key]: e.target.value }))}
            />
            <Button type="button" disabled={!puoModificare || busy === key} onClick={() => void salva(key, valori[key].trim())}>
              <Save className="mr-1.5 size-4" /> Salva
            </Button>
          </div>
          {esiti[key] && <EsitoRiga e={esiti[key] as Esito} />}
        </div>
      ))}

      {CAMPI_SCELTA.map(({ key, label, hint, opzioni }) => (
        <div key={key} className="fenice-rise rounded-2xl border border-border/70 bg-card/60 p-5">
          <Label htmlFor={key} className="text-sm font-semibold">{label}</Label>
          <div className="mb-3 text-xs text-muted-foreground">{hint}</div>
          <select
            id={key}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto"
            value={valori[key]}
            disabled={!puoModificare || busy === key}
            onChange={(e) => {
              const value = e.target.value;
              setValori((v) => ({ ...v, [key]: value }));
              void salva(key, value);
            }}
          >
            {opzioni.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {esiti[key] && <EsitoRiga e={esiti[key] as Esito} />}
        </div>
      ))}
    </div>
  );
}

function EsitoRiga({ e }: { e: Esito }) {
  return (
    <div className={`mt-2 flex items-center gap-1.5 text-xs ${e.ok ? 'text-emerald-600' : 'text-red-600'}`}>
      {e.ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
      {e.text}
    </div>
  );
}
```

`components/FeniceSidebar.tsx`: aggiungi `Settings` all'import da `lucide-react` e in coda a `NAV`:

```ts
  { href: '/fenice/impostazioni', label: 'Impostazioni', desc: 'Lancio: interruttori, link, mittente', icon: Settings },
```

- [ ] **Step 6: Verifica**

Run: `bunx vitest run lib/lancio-settings.test.ts lib/access.test.ts && bun run typecheck`
Expected: PASS, nessun errore di tipo. Le prop usate esistono: `Switch` inoltra tutte le prop di Radix `Switch.Root` (`checked`, `onCheckedChange`, `disabled`, `id`); `Input` e `Label` inoltrano le prop native di `<input>`/`<label>`; `Button` accetta `type`, `disabled`, `onClick`.

Prova manuale con `bun run dev` (serve `.env.local` con Supabase): `http://localhost:3000/fenice/impostazioni` → con un account `all` si salva `lancio_video_live_link` e in `app_settings` la riga cambia (`select key, value from app_settings where key like 'lancio%'`); con `fenicebot@fenice.com` i controlli sono disabilitati e un `POST` diretto risponde 403.

- [ ] **Step 7: Commit**

```bash
git add lib/lancio-settings.ts lib/lancio-settings.test.ts lib/access.ts lib/access.test.ts app/api/fenice/lancio-settings/route.ts "app/(fenice)/fenice/impostazioni/page.tsx" "app/(fenice)/fenice/impostazioni/_components/ImpostazioniLancioPanel.tsx" components/FeniceSidebar.tsx
git commit -m "feat(lancio): pagina /fenice/impostazioni con le otto chiavi del lancio, validazione e sola lettura per gli account confinati

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 8 (BOT): offerta del mese — il video dell'agenda GDO viene da `settings.offertaDelMeseLink`; vuoto = non si manda + warn (ruling "Offerta")

**Files:**
- Modify: `lib/gdo-agenda.ts` (`BLACK_SUMMER_LINK` riga 13, `videoLinkForVariant` righe 22-27) + `lib/gdo-agenda.test.ts` (i due `it` su `offertaDelMese` e sulla whitelist, righe 29-37)
- Modify: `lib/gdo-video-followup.ts` (dopo `VIDEO_TEMPLATE_ENV_BY_LINK`, riga 182) + `lib/gdo-video-followup.test.ts`
- Modify: `lib/fenice-enroll.ts` (`GdoEnrollArgs` riga 287; `gdo_video_url` riga 352)
- Modify: `lib/send-agenda-gdo.ts` (`runSendAgenda`: dopo il controllo del telefono riga ~66; `videoCorretto` riga 104; chiamata a `enrollGdoLeadAsPostino` riga ~140) + `lib/send-agenda-gdo.test.ts` (fake `makeSupabase`)
- Modify: `app/api/cron/gdo-video-followups/route.ts` (import riga 14; ramo `video-template` riga 216)
- Modify: `lib/fenice-autoreply.ts` (la riga `const linkExtra: string[] = [...videoExtra];` scritta dal Task 4: aggiunge il video del GDO SOLO lì)

**Interfaces:**
- Consumes: `getLancioSettings` e `type LancioSettings` (`lib/lancio-settings.ts`), `GdoVariant` (`lib/bot-contract.ts`: `{ lavora, haFamiglia, offertaDelMese }`, invariato — il CRM v1.6 manda già `offertaDelMese: true` dal pulsante "Offerta del mese"), `unknownFeniceLinks(text, extra)` / `containsVideoLink(p, extra)` (Task 4).
- Produces:
  - `type OffertaDelMeseSettings = Pick<LancioSettings, 'offertaDelMeseLink'>`
  - `videoLinkForVariant(v: GdoVariant, settings?: OffertaDelMeseSettings | null): string | null` — `offertaDelMese` → `settings.offertaDelMeseLink` o **`null`** (nessun ripiego su env né sul Black Summer: ruling "link vuoto → non manda"); le quattro varianti lavora/famiglia invariate
  - `videoTemplateEnvForLink(link: string | null, offertaDelMeseLink: string | null): string | undefined` — il link dinamico dell'offerta mappa su `VIDEO_GDO_OFFERTA_SID`; il resto come `VIDEO_TEMPLATE_ENV_BY_LINK`
  - `GdoEnrollArgs.gdoVideoUrl?: string | null` — se presente (anche `null`) vince sul calcolo dalla variante
  - evento `offerta_del_mese_link_mancante` (warn) in `runSendAgenda` quando la variante chiede l'offerta e il link non c'è: l'agenda parte lo stesso, `gdo_video_url` resta `null`, il drain — già oggi — scrive `gdo_video_missing` e risponde senza video
  - nel drain, il video del GDO entra in `linkExtra` (così un `offerta_del_mese_link` nuovo non è "inventato" per `unknownFeniceLinks`) ma **NON** in `videoExtra`: `videoGiaInviato` e `ensureConfirmationBlock` dei lead postino restano quelli di oggi (oggi `containsVideoLink` riconosce solo i `conferenza-*` della whitelist, `confirmation-block.ts:15-19`; allargarlo cambierebbe il ramo `result.appointmentFixed && !videoGiaInviato` a `fenice-autoreply.ts:771` per i lead GDO, e questo task non lo vuole)

`BLACK_SUMMER_LINK` resta esportato (è in `KNOWN_LINKS` e nella mappa dei template: le chat vecchie ce l'hanno in cronologia) ma non è più il valore di nessuna variante.

- [ ] **Step 1: Test che falliscono**

`lib/gdo-agenda.test.ts`: sostituisci `it('offertaDelMese prevale su lavora e famiglia', …)` e il test successivo che itera le varianti sulla whitelist `KNOWN_LINKS` con:

```ts
  it('offertaDelMese prende il link dalle impostazioni e prevale su lavora e famiglia', () => {
    const settings = { offertaDelMeseLink: 'https://corso.feniceacademy.it/webdev-offerta' };
    expect(videoLinkForVariant(V(true, true, true), settings)).toBe('https://corso.feniceacademy.it/webdev-offerta');
    expect(videoLinkForVariant(V(false, false, true), settings)).toBe('https://corso.feniceacademy.it/webdev-offerta');
  });
  it('offertaDelMese senza link impostato: null, mai il Black Summer ne un link inventato', () => {
    expect(videoLinkForVariant(V(true, false, true))).toBeNull();
    expect(videoLinkForVariant(V(true, false, true), null)).toBeNull();
    expect(videoLinkForVariant(V(true, false, true), { offertaDelMeseLink: null })).toBeNull();
  });
  it('l impostazione non tocca le quattro varianti lavora/famiglia, che restano nella whitelist', () => {
    const settings = { offertaDelMeseLink: 'https://corso.feniceacademy.it/webdev-offerta' };
    expect(videoLinkForVariant(V(true, false), settings)).toBe('https://corso.feniceacademy.it/conferenza-bx');
    for (const variant of [V(true, false), V(false, false), V(true, true), V(false, true)]) {
      expect(KNOWN_LINKS as readonly string[]).toContain(videoLinkForVariant(variant) as string);
    }
  });
```

`lib/gdo-video-followup.test.ts`: aggiungi `videoTemplateEnvForLink` all'import e in coda:

```ts
describe('videoTemplateEnvForLink — il link dell offerta e dinamico, il template no', () => {
  const offerta = 'https://corso.feniceacademy.it/webdev-offerta';
  it('il link impostato mappa sul template offerta; i quattro fissi sulla mappa statica; un link ignoto resta senza template', () => {
    expect(videoTemplateEnvForLink(offerta, offerta)).toBe('VIDEO_GDO_OFFERTA_SID');
    expect(videoTemplateEnvForLink('https://corso.feniceacademy.it/conferenza-bx', offerta)).toBe('VIDEO_GDO_LAVORA_SID');
    expect(videoTemplateEnvForLink('https://corso.feniceacademy.it/conferenza-black-summer', offerta)).toBe('VIDEO_GDO_OFFERTA_SID');
    expect(videoTemplateEnvForLink('https://corso.feniceacademy.it/boh', offerta)).toBeUndefined();
    expect(videoTemplateEnvForLink(null, offerta)).toBeUndefined();
    expect(videoTemplateEnvForLink(offerta, null)).toBeUndefined();
  });
});
```

`lib/send-agenda-gdo.test.ts`: allarga `makeSupabase` a `opts: { convPrecedente?: any; statusSequence?: (string | null)[]; settingsRows?: { key: string; value: unknown }[] } = {}` e, dentro `from(table)`, PRIMA del ramo `if (table === 'conversations')`:

```ts
      if (table === 'app_settings') {
        return {
          select() {
            return { in() { return Promise.resolve({ data: opts.settingsRows ?? [] }); } };
          },
        };
      }
```

poi aggiungi i casi (dentro il `describe` di `runSendAgenda`):

```ts
  it('offerta del mese con link impostato: il video dell arruolamento e quello impostato', async () => {
    const { supabase } = makeSupabase({ settingsRows: [{ key: 'offerta_del_mese_link', value: 'https://corso.feniceacademy.it/webdev-offerta' }] });
    await runSendAgenda(supabase, { ...PAYLOAD, variant: { lavora: false, haFamiglia: false, offertaDelMese: true } });
    const args = (enrollGdoLeadAsPostino as any).mock.calls.at(-1)[1];
    expect(args.gdoVideoUrl).toBe('https://corso.feniceacademy.it/webdev-offerta');
  });
  it('offerta del mese senza link: l agenda parte, il video e null e resta un avviso', async () => {
    const { supabase, calls } = makeSupabase();
    const res = await runSendAgenda(supabase, { ...PAYLOAD, variant: { lavora: true, haFamiglia: false, offertaDelMese: true } });
    expect(res.ok).toBe(true);
    const args = (enrollGdoLeadAsPostino as any).mock.calls.at(-1)[1];
    expect(args.gdoVideoUrl).toBeNull();
    expect(calls.events.some((e) => e.type === 'offerta_del_mese_link_mancante' && e.level === 'warn')).toBe(true);
  });
  it('correzione della variante entro la finestra: il video corretto viene dalle impostazioni', async () => {
    const { supabase, calls } = makeSupabase({
      // Stessa forma del caso 'stessa variante → deduplica secca' (riga 214 del test).
      convPrecedente: { id: 42, gdo_agenda_at: new Date(Date.now() - 3 * 60_000).toISOString(), gdo_agenda_esito: 'consegnato', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx', gdo_video_sent_at: null },
      settingsRows: [{ key: 'offerta_del_mese_link', value: 'https://corso.feniceacademy.it/webdev-offerta' }],
    });
    const res = await runSendAgenda(supabase, { ...PAYLOAD, variant: { lavora: true, haFamiglia: false, offertaDelMese: true } });
    expect(res.deduplicato).toBe(true);
    expect(res.varianteAggiornata).toBe(true);
    expect(calls.updates.some((u) => u.gdo_video_url === 'https://corso.feniceacademy.it/webdev-offerta')).toBe(true);
  });
  it('le quattro varianti classiche non leggono niente dalle impostazioni', async () => {
    const { supabase } = makeSupabase();
    await runSendAgenda(supabase, { ...PAYLOAD, variant: { lavora: true, haFamiglia: true, offertaDelMese: false } });
    const args = (enrollGdoLeadAsPostino as any).mock.calls.at(-1)[1];
    expect(args.gdoVideoUrl).toBe('https://corso.feniceacademy.it/conferenza-dx');
  });
```

Run: `bunx vitest run lib/gdo-agenda.test.ts lib/gdo-video-followup.test.ts lib/send-agenda-gdo.test.ts`
Expected: FAIL.

- [ ] **Step 2: `lib/gdo-agenda.ts`**

Sostituisci il blocco da `/** Video dell'offerta del mese …` a fine `videoLinkForVariant` con:

```ts
import type { LancioSettings } from './lancio-settings';

/** Il link del Black Summer: NON e' piu' il valore di nessuna variante (l'offerta del mese
 *  viene da `app_settings.offerta_del_mese_link`), ma resta nella whitelist e nella mappa
 *  dei template perche' le chat vecchie ce l'hanno in cronologia. */
export const BLACK_SUMMER_LINK = 'https://corso.feniceacademy.it/conferenza-black-summer';

const VIDEO_BY_PROFILO = {
  lavora: 'https://corso.feniceacademy.it/conferenza-bx',
  nonLavora: 'https://corso.feniceacademy.it/conferenza-axmsbn9r50',
  lavoraFamiglia: 'https://corso.feniceacademy.it/conferenza-dx',
  nonLavoraFamiglia: 'https://corso.feniceacademy.it/conferenza-ex',
} as const;

/** Il pezzo di `LancioSettings` che serve qui: il modulo resta client-safe e puro. */
export type OffertaDelMeseSettings = Pick<LancioSettings, 'offertaDelMeseLink'>;

/**
 * Il video da mandare al lead, dal profilo raccolto dal GDO al telefono. L'offerta del
 * mese (spec §5.7, ruling B5) e' un'impostazione: senza link si torna `null` e il video
 * NON parte — niente ripiego su un video vecchio spacciato per l'offerta di questo mese.
 */
export function videoLinkForVariant(v: GdoVariant, settings?: OffertaDelMeseSettings | null): string | null {
  if (v.offertaDelMese) return settings?.offertaDelMeseLink?.trim() || null;
  if (v.haFamiglia) return v.lavora ? VIDEO_BY_PROFILO.lavoraFamiglia : VIDEO_BY_PROFILO.nonLavoraFamiglia;
  return v.lavora ? VIDEO_BY_PROFILO.lavora : VIDEO_BY_PROFILO.nonLavora;
}
```

(l'`import type` va in testa al file insieme agli altri. `lancio-settings.ts` ha un import di VALORE — `parsePerimetroBlast` da `lancio-zoom-blast`, riga 2 — e un `import type` da `supabase/admin`: `gdo-agenda.ts` resta client-safe **solo perché** usa `import type`, che il compilatore cancella. Non trasformarlo mai in un import di valore.)

- [ ] **Step 3: `lib/gdo-video-followup.ts`**

Dopo `VIDEO_TEMPLATE_ENV_BY_LINK`:

```ts
/**
 * Come la mappa sopra, ma col link dell'offerta del mese letto a runtime da
 * `app_settings`: il link cambia dal pannello senza deploy, il template resta
 * `VIDEO_GDO_OFFERTA_SID`. Fail-closed come la mappa statica: link ignoto = nessun template.
 */
export function videoTemplateEnvForLink(link: string | null, offertaDelMeseLink: string | null): string | undefined {
  if (!link) return undefined;
  if (offertaDelMeseLink && link === offertaDelMeseLink) return 'VIDEO_GDO_OFFERTA_SID';
  return VIDEO_TEMPLATE_ENV_BY_LINK[link];
}
```

- [ ] **Step 4: I chiamanti**

`lib/fenice-enroll.ts`: in `GdoEnrollArgs` aggiungi `/** Link video gia' risolto dal chiamante (offerta del mese da impostazione). `null` = nessun video. Assente = si calcola dalla variante. */ gdoVideoUrl?: string | null;` e alla riga `gdo_video_url: videoLinkForVariant(args.variant),` scrivi `gdo_video_url: args.gdoVideoUrl !== undefined ? args.gdoVideoUrl : videoLinkForVariant(args.variant),`.

`lib/send-agenda-gdo.ts`: `import { getLancioSettings } from './lancio-settings';`. In `runSendAgenda`, subito dopo il blocco `if (!phone) { … }`:

```ts
  // L'offerta del mese e' un'impostazione (spec §5.7): si legge una volta per richiesta e
  // vale sia per la deduplica sia per l'arruolamento. Senza link il video non parte.
  const settings = await getLancioSettings(supabase);
  const videoCorretto = videoLinkForVariant(payload.variant, settings);
  if (payload.variant.offertaDelMese && !videoCorretto) {
    await supabase.from('event_log').insert({
      type: 'offerta_del_mese_link_mancante',
      payload: { crmLeadId: payload.leadId } as never,
      message: `[gdo] offerta del mese chiesta per il lead ${payload.leadId} ma offerta_del_mese_link non e' impostato: agenda inviata senza video`,
      level: 'warn',
    });
  }
```

Nel ramo della deduplica cancella la riga `const videoCorretto = videoLinkForVariant(payload.variant);` e cambia la condizione in `if (precedente.gdo_video_url && videoCorretto && videoCorretto !== precedente.gdo_video_url) {` (senza link corretto non c'è niente da correggere). Nella chiamata a `enrollGdoLeadAsPostino` aggiungi `gdoVideoUrl: videoCorretto,`.

`app/api/cron/gdo-video-followups/route.ts`: importa `videoTemplateEnvForLink` da `@/lib/gdo-video-followup` (al posto di `VIDEO_TEMPLATE_ENV_BY_LINK`) e `getLancioSettings` da `@/lib/lancio-settings`. Dopo `const supabase = getSupabaseAdmin();` aggiungi `const offertaLink = (await getLancioSettings(supabase)).offertaDelMeseLink;` e nel ramo `video-template` sostituisci `const envName = link ? VIDEO_TEMPLATE_ENV_BY_LINK[link] : undefined;` con `const envName = videoTemplateEnvForLink(link, offertaLink);`.

`lib/fenice-autoreply.ts`: nel punto del Task 4 dove nasce `linkExtra`, aggiungi il video del GDO (che ora può essere un link non in whitelist) SOLO a `linkExtra`; `videoExtra` non cambia:

```ts
      const linkExtra: string[] = [...videoExtra, ...(gdoVideoUrl ? [gdoVideoUrl] : [])];
```

- [ ] **Step 5: Verifica**

Run: `bunx vitest run lib/gdo-agenda.test.ts lib/gdo-video-followup.test.ts lib/send-agenda-gdo.test.ts lib/fenice-enroll.test.ts lib/fenice-autoreply.test.ts && bun run typecheck`
Expected: PASS, nessun errore di tipo (in particolare dove `videoLinkForVariant` ora torna `string | null`: `gdo_video_url` è nullable a DB, `videoCorretto` è guardato).

- [ ] **Step 6: Commit**

```bash
git add lib/gdo-agenda.ts lib/gdo-agenda.test.ts lib/gdo-video-followup.ts lib/gdo-video-followup.test.ts lib/fenice-enroll.ts lib/send-agenda-gdo.ts lib/send-agenda-gdo.test.ts app/api/cron/gdo-video-followups/route.ts lib/fenice-autoreply.ts
git commit -m "feat(offerta): il video dell'offerta del mese arriva da offerta_del_mese_link; senza link non parte e resta un avviso

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

### Task 9 (BOT): env, suite completa, checklist di deploy, runbook B6

**Files:**
- Modify: `.env.example` (blocco lancio, righe 54-79)
- Create: `docs/lancio-webdev-runbook-b6.md`
- Nessun altro file: **nessuna migrazione** (vedi Global Constraints: tutte le colonne e le chiavi esistono già).

**Interfaces:**
- Consumes: tutto il blocco.
- Produces: la lista di controllo prima del push e il runbook della prova generale (B6) e della serata.

- [ ] **Step 1: `.env.example`**

Nel blocco del lancio (dopo `LANCIO_FOLLOWUP_TEMPLATE_SID=`) aggiungi i commenti; nessuna env nuova:

```
# Follow-up del giorno dopo (B5): SID del template 3 (UTILITY), gia' in prod. Senza SID il
# cron /api/cron/lancio-followup scrive lancio_followup_config_error e non manda.
# LANCIO_BATCH_MAX (sopra) governa sia il blast Zoom sia il follow-up (200 ogni 5').
# L'offerta del mese NON ha una env: si imposta da /fenice/impostazioni (offerta_del_mese_link).
```

- [ ] **Step 2: Suite completa e typecheck**

Run: `bun run test 2>&1 | tail -5 && bun run typecheck`
Expected: tutti i file verdi, nessun errore di tipo; `Tests M passed` con M **maggiore** della baseline annotata nel Task 0 Step 0, e `Test Files` non inferiore a quella baseline più i 6 file di test nuovi (`lancio-blast-motore`, `lancio-followup`, `lancio-restituzioni`, `cron/lancio-followup`, `cron/lancio-restituzioni`, più i test aggiunti ai file esistenti). Se un test non toccato da questo blocco fallisce, si ferma e si segnala: non si "aggiusta" un test altrui.

- [ ] **Step 3: Runbook `docs/lancio-webdev-runbook-b6.md`**

```markdown
# Lancio Web Developer AI — runbook della prova generale (B6) e della serata

Cron a data fissa (`vercel.json`): `lancio-zoom` (5/10 19:30-20:45 Roma), `lancio-followup`
(6-7/10, 12:00-14:00 e 17:30-19:30 Roma), `lancio-restituzioni` (ogni ora dall'8/10 al 15/11).
Tutti leggono `app_settings.lancio_evento_at` per le finestre: la data nel cron e' solo il
giorno in cui Vercel li sveglia.

## Prova generale con un numero di test (senza toccare i lead veri)
- Forzare un cron su UNA conversazione: `?forza=1&solo=<conversationId>` (salta la finestra
  o la data; `forza` senza `solo` e' un 400). Spostare l'orologio: `?now=<ISO con offset>`,
  che per follow-up e restituzioni vale SOLO insieme a `solo=`. Auth: `?secret=$CRON_SECRET`.
- Orologio dei turni (assistenza, post-pitch): `LANCIO_FAKE_NOW` + `LANCIO_FAKE_NOW_ARMED`
  nel `.env.local`. **Non devono MAI stare nelle env di Vercel prod**: `vercel env ls production`
  non deve elencarle. Toglierle a prova finita.
- Il CRM ha date scritte a mano (`LANCIO_WEBDEV` in `src/lib/lancio/config.ts`): se si sposta
  `lancio_evento_at` sul bot per la prova, `book`/`call-now` rispondono 422.
- Percorso completo da provare: benvenuto → "si" → blast Zoom (forzato) → follow-up (forzato)
  → risposta → Mario manda il video della live → restituzione (forzata) → riscrittura del lead
  dopo la restituzione (evento `lancio_inbound_dopo_restituzione`, nessuna risposta del bot).

## Prima del 5/10
- I tre template `fenice_lancio_*` devono risultare **approvati UTILITY** sull'account in uso:
  `node scripts/qualita-numero.mjs` per qualita'/limite, e per la categoria di ciascun SID
  `curl -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" https://content.twilio.com/v1/Content/<SID>/ApprovalRequests`
  (`whatsapp.category` = `UTILITY`, `status` = `approved`). Con `UTILITY_ONLY=1` un template
  MARKETING ferma il run con `fermo: 'template_bloccato'` alla prima chiamata.
- Env prod: `LANCIO_WELCOME_TEMPLATE_SID`, `LANCIO_ZOOM_TEMPLATE_SID`, `LANCIO_FOLLOWUP_TEMPLATE_SID`,
  `TWILIO_WHATSAPP_NUMBER_FENICE`, `CRON_SECRET`, `BOT_WEBHOOK_SECRET`, `LANCIO_BATCH_MAX=200`.
- `app_settings` da /fenice/impostazioni: `lancio_zoom_link`, `lancio_evento_at`, `lancio_attivo=1`;
  `lancio_pulsante_attivo` si accende la sera stessa, poco prima del pitch.
- Go/no-go 18:00: qualita' >= MEDIUM e limite >= 10K sul mittente, altrimenti
  `lancio_blast_perimetro = risposto` (piano B) dal pannello.

## Freno automatico: come si legge e come si riparte
- Evento `lancio_zoom_freno` / `lancio_followup_freno` (level error) con `tentati`, `falliti`,
  `incerti`, `codici`. Il freno **spegne `lancio_attivo`**: i run successivi scrivono
  `lancio_*_run` con `motivo: 'lancio_non_attivo'`, e il follow-up in finestra scrive anche
  `lancio_followup_fermo` (warn) a ogni run.
- Riaccensione = decisione umana: capire la causa (63018 = limite del numero, 63051 = numero
  sospeso, >10% falliti = numeri morti o Meta che rifiuta), poi `lancio_attivo` ON dal pannello.
  Il run dopo riparte da dove si era fermato (i timbri tengono i gia' serviti fuori dalla coda).
- Se il freno e' scattato la sera del 5, il 6 mattina PRIMA delle 12:00 va deciso se riaccendere:
  altrimenti il follow-up non parte e chi ha interagito torna al pool dall'8/10 con
  "Lancio: follow-up non inviato".
- 63049 (frequency cap di Meta, per destinatario) NON e' un freno: si conta `capped` e si ritenta
  al run dopo.

## Il 6-7/10
- `lancio_video_live_link` va impostato PRIMA delle 12:00 del 6: senza, chi risponde riceve i
  video classici e in `event_log` compare `lancio_video_live_link_missing` (warn).
- Chi risponde "no" al follow-up: lo gestisce Mario standard (esito `DA_SCARTARE` col suo flusso).
- Chi aveva detto "no" PRIMA del follow-up: il cron non gli scrive, lo congeda senza bolla
  (`lancio_followup_congedo_da_cron`).

## Dall'8/10
- `lancio_restituzioni_run` ogni ora: `restituiti`, `rifiutati` (403/404 del CRM: comunque
  `restituito`), `errori` (rete/5xx: si riprova), `niente.ancora_ignota` (righe senza benvenuto
  ne' intake: da guardare a mano), `scartiRitentati`/`scartiChiusi` (sweeper dei congedi).
- Un lead restituito che riscrive: evento `lancio_inbound_dopo_restituzione` + nota al CRM; il bot
  non risponde. Lo chiama chi lo ha in carico.
```

- [ ] **Step 4: Checklist di deploy (nel messaggio di chiusura del task, spuntata)**

1. `git log --oneline main..feat/lancio-webdev` mostra i commit T0-T9 e nient'altro di inatteso; `git status` pulito a parte i file dell'altra sessione (`lib/twilio.ts`, `lib/twilio.test.ts`, `tmp-*.mjs`, `scripts/recupera-inbound-downtime.mjs`), che **non** entrano nel merge.
2. `bun run test && bun run typecheck` verdi sul branch.
3. Nessuna migrazione da applicare (verificare una volta sola: `grep -c "lancio_followup_inviato_at" lib/supabase/types.ts` ≥ 3).
4. Env prod presenti (`vercel env ls production`): `LANCIO_FOLLOWUP_TEMPLATE_SID`, `LANCIO_WELCOME_TEMPLATE_SID`; assenti: `LANCIO_FAKE_NOW`, `LANCIO_FAKE_NOW_ARMED`.
5. Review del branch (`superpowers:requesting-code-review`), poi merge su `main` e push (= deploy).
6. Dopo il deploy: `curl "https://<prod>/api/cron/lancio-followup?secret=$CRON_SECRET&dry=1"` → `{ ok: true, skipped: 'fuori_finestra' }` (siamo prima del 6/10) e `curl ".../api/cron/lancio-restituzioni?secret=$CRON_SECRET&dry=1"` → `{ ok: true, skipped: 'prima_della_data' }`; in `event_log` compaiono `lancio_followup_run` e `lancio_restituzioni_run`. Su Vercel → Settings → Cron Jobs compaiono le tre voci nuove.
7. `/fenice/impostazioni` si apre in prod e mostra le 8 chiavi coi valori attuali.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/lancio-webdev-runbook-b6.md
git commit -m "docs(lancio): env del follow-up in .env.example e runbook della prova generale (freno, template UTILITY, orologio forzato)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TqdFfxeDbRPq6iBmWYWSFD"
```

---

## Self-review (fatta riscrivendo il piano)

**Copertura della spec e dei rulings.**

| Requisito | Dove |
|---|---|
| §5.5 cron 6-7/10, fasce 12-14 e 17:30-19:30 Roma, bersaglio `attesa/posto_bloccato/link_inviato` con interazione, `LANCIO_BATCH_MAX`, template, `followup_inviato` | T2 (`inFinestraFollowup`, `decideFollowup`), T3 (route + schedule `*/5 10-11,15-17 6-7 10 *`) |
| §5.5 alla risposta → Mario standard, `chiuso`, video = `lancio_video_live_link` via `contextNote` | T4 (`'handed_to_mario'` intercettato nel ciclo dei giri + `lancioStandardContextNote` + `videoExtra`/`linkExtra`) |
| §5.7 `videoLinkForVariant(v, settings)` + mappa template dinamica; pagina con i link e `lancio_attivo` | T8, T7 (tutte le 8 chiavi per ruling) |
| §5.8 restituzioni dall'8/10, `mai_risposto`, `silenzio_dopo_followup` (48 h), `restituito` + `closed`, fasi intoccabili | T5 |
| §6.2 `NON_RISPOSTO` sui lead lancio = pool; 200 `already_returned` | T5 (`res.sent` copre il 200 con `skipped`) |
| §7.3 testo del follow-up | T2 (`lancioFollowupText`, test verbatim) |
| §11.5-6 lotti 200/5', freno, 63049 per destinatario; §11.1 mittente | T1 (motore), T3 (`frenaLancio`, warn mittente) |
| §3.2 eventi `lancio_followup_inviato`, `lancio_restituito` | T3 (`eventoInvio`), T5 |
| R1, R2, R3, C1, C2, C4, C5, C6, C7, C8, C9, Finestre, Flusso standard, Pagina, Offerta | tabella "Rulings vincolanti → task"; ogni task cita i suoi |
| Seconda passata 1 — `haDettoNo` = `congedoEsplicito` | T2 (codice + test riscritti; test del route in T3 per il "no" secco che NON congeda) |
| Seconda passata 2 — `soloDaFasi` nel motore | T1 (`InvioTimbrato.soloDaFasi`, entrambe le chiamate a `impostaFaseLancio`), T3 (`FASI_FOLLOWUP`, test sulla fase avanzata) |
| Seconda passata 3 — stesso drain, `'handed_to_mario'` mai in `ai_status` | T4 (turno + ciclo `MAX_GIRI_LANCIO` + 3 test sul drain) |
| Seconda passata 4 — il cron legge `returnedToPool`/`skipped` | T5 (`sendOutcome.corpo`, `esitoRestituzioneDalCrm`, evento `lancio_restituzione_rifiutata`, 3 test di rotta + 4 puri + 1 su `sendOutcome`) |
| Seconda passata 5 — ribasato su `f5c8ad6` | tutte le citazioni `file:riga` |
| Avvertenze cron — `*/5` vs `*/10` dichiarato; run a vuoto accettati | T3 (paragrafo Schedule) |
| Riconciliazione: `impostaFaseLancio` unico scrittore, `runPool` da `lib/run-pool.ts`, `LANCIO_SLUG`, nessuna migrazione di riserva, marker congedo, `followup_non_inviato` | Global Constraints, T3, T5 |

**Segnaposto.** Nessun "TBD", "simile al task N", "aggiungi validazione", nessuna uscita condizionale ("se non passa si adegua il test/il pannello"): ogni funzione nominata nelle Interfaces è definita in uno step (`leggiParametriCron`, `inviaTemplateTimbrato`, `eseguiLotti`, `frenaLancio`, `leggiCoda`, `timbroUpdate`/`timbroCampi` in T1; `ancoraLancio`, `haInteragito`, `haDettoNo`, `decideFollowup`, `lancioStandardContextNote`, `lancioStandardDrain` in T2; `decideRestituzione`, `esitoRestituzioneDalCrm`, `notaInboundDopoRestituzione`, `leggiCorpoJson` in T5; `validateLancioSettingInput`, `puoModificareLancio` in T7; `videoTemplateEnvForLink` in T8). Ogni passo TDD ha un test che fallisce prima (T0 compreso: `'MARKER_PULSANTE_RE' in scelta`). Le istruzioni "sostituisci X con Y" sono su righe citate col numero e col testo esatto del file a `f5c8ad6`; la verifica C9 è un test esistente (`lib/lancio-fase.test.ts -t "chiuso e restituito"`), non un grep in prosa.

**Coerenza con le firme reali (verificate a `f5c8ad6`).** `impostaFaseLancio(supabase, id, fase: LancioFase, campi?: { lancio_link_inviato_at?, lancio_followup_inviato_at?, lancio_info? }, opzioni?: { soloDaFasi?: readonly LancioFase[] })` → `timbroCampi` produce esattamente il quarto argomento e il motore passa sempre il quinto (i tre test del cron Zoom lo asseriscono); `setLancioSetting(supabase, key, value: string | boolean)` → la pagina scrive `''` per azzerare e booleani per gli interruttori; `congedoLancio(supabase, c: ContestoTurno, leadWords, nota, { giaInviato?, testo? })` → T3/T5 lo chiamano con `giaInviato: true`; `sendOutcome(supabase, id, { outcome, note })` → `{ sent, status?, error? }`; `sendCrmNota(supabase, id, note)`; `shouldReopen(g)` allargata con un campo opzionale (i chiamanti esistenti compilano); `eseguiTurnoLancio` allarga il tipo di ritorno a `'handed_to_mario'` e il drain è l'unico chiamante: lo intercetta nel ciclo `MAX_GIRI_LANCIO` prima di `finalStatus = …` (i test `lancio-turno.test.ts` confrontano con stringhe; il test nuovo sul drain asserisce `finalStatusWrites === ['active']`); `sendOutcome` torna `{ sent, status?, error?, keepOpen?, notifySuppressed?, corpo? }` e tutti i chiamanti esistenti ignorano `corpo`; `congedoEsplicito(body)` (`lancio-classifica.ts:84-89`) è la base di `haDettoNo`; `videoLinkForVariant` torna `string | null` e i tre chiamanti (`fenice-enroll`, `send-agenda-gdo`, il test) sono aggiornati nello stesso task; `getLancioSettings` → oggetto camelCase (`settings.videoLiveLink`, `settings.offertaDelMeseLink`, `settings.sender`, `settings.attivo`, `settings.eventoAt`), mai `settings.lancio_*`.

**Rischi lasciati esplicitamente aperti (da decidere in review, non bloccano il dispatch).**
1. Su un 200 `returnedToPool: false` il cron lascia la fase intatta (ruling 4) ma `sendOutcome` ha già scritto `bot_outcome='NON_RISPOSTO'` e `ai_status='closed'` localmente: la riga non rientra più nelle restituzioni (`esito_presente`) e il rifiuto vive solo nell'evento `lancio_restituzione_rifiutata` (warn). Annullare quella scrittura vorrebbe dire insegnare a `sendOutcome` la semantica del ramo lancio del CRM: fuori dalle "~10 righe" del ruling.
2. `?now=` nel cron Zoom resta libero (i suoi 42 test lo passano senza `solo`): il ruling R3 sul `now` vale per i cron nuovi via `nowRichiedeSolo: true`; portarlo anche sul blast vorrebbe dire toccare i suoi test, che il ruling vieta.
3. Le restituzioni non guardano `lancio_attivo` (scelta esplicita, come nel piano vecchio): un lancio spento dall'8/10 restituisce lo stesso. Se il PO volesse tenere i lead al bot durante un fermo, serve un'impostazione in più. Inoltre 403/404 restano terminali → `restituito` (il lead non è più del bot): non è una "conferma" del CRM in senso stretto, ma l'alternativa è ritentare ogni ora per sempre.
