# Lancio Web Developer AI — B4: blast Zoom, assistenza e scelta della sera (bot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La sera del 5/10 il bot manda a tutti i lead del lancio il link Zoom a lotti (cron a data fissa), fa assistenza fino a mezzanotte, e dopo il pitch fa scegliere a chi ha premuto il pulsante fra "chiamata adesso" e "call domani", registrando la scelta sul CRM con le tre API `/api/bot/lancio/*`.

**Architecture:** Tre pezzi che condividono solo le colonne `lancio_*` e il prompt per fase del B1. (1) Un cron `/api/cron/lancio-zoom` che clona il modello di `send-batch` (lotti, `runPool` a concorrenza 5, idempotenza su `messages.template_sid`) più la doppia idempotenza su `lancio_link_inviato_at` e il filtro del minuto di Roma come `gdo-video-followups`. (2) Un client HTTP `lib/lancio-crm.ts` verso il CRM, firmato HMAC come `sendOutcome`, con timeout 8 s ed errori tipizzati. (3) Due rami nuovi dello `switch` di `eseguiTurnoLancio` (`lib/lancio-turno.ts`, B1) — `link_inviato` in `lib/lancio-assistenza.ts` e `post_pitch` in `lib/lancio-post-pitch.ts` — che il drain chiama già al posto di Mario quando `lancio_fase` è valorizzata (B1 Task 8, nessun secondo ramo): le regole dure (date ammesse, ora tonda, `at ≥ now+1h`, finestra notturna) e tutti i testi di conferma vivono in `lib/lancio-scelta.ts`, modulo puro; il modello sceglie SOLO fra le ore che il codice gli elenca e le riporta in un tag.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase (postgrest-js), Twilio WhatsApp (Content API), Anthropic SDK (`claude-sonnet-4-6`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md` — §5.3 (blast Zoom e assistenza), §5.4 (sera del 5: pulsante e scelta), §6.2 (contratto delle tre rotte CRM), §9 (blocco B4), §10 (rischi: numero a qualità LOW).

## Global Constraints

- **Perimetro B4 e basta.** Il marker del pulsante `wa.me` e l'adozione dei numeri sconosciuti sono del B2: qui si assume che una conversazione arrivi in `lancio_fase='post_pitch'` con `crm_lead_id` valorizzato. Il follow-up del 6, il flusso standard con la live editata e le restituzioni sono del B5. L'intake, le fasi `attesa`/`posto_bloccato` e le esclusioni dai cron esistenti sono del B1.
- **Nessuna migrazione.** Le colonne `conversations.lancio_slug / lancio_fase / lancio_ingresso / lancio_link_inviato_at / lancio_info` e le chiavi `app_settings` (`lancio_zoom_link`, `lancio_attivo`, `lancio_evento_at`) sono del B1 (spec §3.2).
- **Numero a qualità LOW: nessun messaggio spontaneo** oltre al blast del link e alle risposte di conferma. Ogni messaggio del bot in questo blocco è o il template del blast o una risposta a un inbound del lead.
- **Le risposte di conferma sono testo fisso in codice.** Il modello non scrive mai un'ora: le ore che vede stanno in un blocco che il codice costruisce dalla risposta del CRM, e le riporta in un tag che il codice valida.
- **Regole dure nel codice, non nel prompt** (spec §5.4): date ammesse = giorno dopo il webinar (6/10, ore 9-20) e dopodomani (7/10, ore 9-14); ora tonda (minuti e secondi a zero, fuso Roma); `at ≥ now + 1h`; `[LANCIO:CHIAMA_ORA]` accettato solo nella finestra notturna (5/10 dalle 21:00 al 6/10 03:00). Le date NON si scrivono a mano: si derivano da `lancio_evento_at` (`2026-10-05T21:00:00+02:00`), così la prova generale del B6 può spostare l'orologio e l'evento.
- **Finestra `post_pitch`:** dal 5/10 21:00 (inizio evento) al 6/10 03:00 il bot risponde a qualsiasi ora; dopo le 03:00 la fase resta `post_pitch` ma il bot risponde solo dalle 08:30 alle 23:00 di Roma e propone solo il pomeriggio del 6 o il 7 (un'ora della mattina del 6 si accetta solo se `at ≥ now+1h`). Fase `link_inviato`: risposte dall'invio del link fino alle 23:59 di Roma del giorno dell'evento; dopo mezzanotte silenzio tracciato (nessuna assistenza il 6: risponde il follow-up del B5, che riporta la chat a Mario).
- **Cron:** schedule in `vercel.json` a data fissa in UTC (`*/5 17-18 5 10 *`); il route filtra sul minuto di Roma (19:30-20:45 del giorno dell'evento). Auth con `CRON_SECRET` (header `Authorization: Bearer` o `?secret=`) come tutti i cron. `maxDuration = 300`.
- **Tag del lancio:** `[LANCIO:CHIAMA_ORA]`, `[LANCIO:PRENOTA|<ISO con offset>]`, `[LANCIO:SLOTS]`, `[LANCIO:NO]`; resta `[PASSAGGIO_UMANO]`. I tag non arrivano MAI al lead: si tolgono dal testo visibile.
- **Chiamate al CRM** firmate con `signPayload(rawBody, BOT_WEBHOOK_SECRET)` in `x-bot-signature` (come `sendOutcome`). URL base `CRM_LANCIO_URL ?? 'https://crm-sales-fenice.vercel.app/api/bot/lancio'`. Timeout 8 s. Il CRM risponde < 3 s per contratto.
- **Env nuove:** `LANCIO_ZOOM_TEMPLATE_SID` (Content SID del template "Link Zoom", `{{1}}`=nome `{{2}}`=link), `LANCIO_BATCH_MAX` (default `400`), `CRM_LANCIO_URL` (opzionale), `LANCIO_FAKE_NOW` + `LANCIO_FAKE_NOW_ARMED` (orologio forzato del turno per la prova generale, Task 7: letto fuori produzione, o in produzione solo se `LANCIO_FAKE_NOW_ARMED` è uguale a `CRON_SECRET`). Esistenti riusate: `BOT_WEBHOOK_SECRET`, `CRON_SECRET`, `TWILIO_WHATSAPP_NUMBER_FENICE`, `UTILITY_ONLY`/`UTILITY_ONLY_ALLOW`.
- **Date reali:** 5/10/2026 è lunedì, 6/10 martedì, 7/10 mercoledì; fuso `+02:00` (l'ora legale finisce il 25/10). Le fixture dei test usano queste date con offset esplicito.
- **Comandi:** test `bunx vitest run <file>` (tutti: `bun run test`), typecheck `bun run typecheck`. Commit su `main` solo a task verde; il deploy parte al push, che si fa a fine Task 10 dopo la verifica dal vivo sul numero di test. È sicuro anche prima del 5/10: le fasi del B4 si raggiungono solo col blast (cron a data fissa + `attivo`; `forza` solo con `solo=<id>`) o col marker del pulsante (testo non pubblico prima della live); i lead veri restano in `attesa`/`posto_bloccato`, cioè nel turno del B1.
- Stile del repo: commenti in italiano che spiegano il PERCHÉ, `event_log` per ogni decisione non ovvia, mai lanciare da un ramo che ha già scritto al lead.

---

## Interfacce del B1 assunte (verificare al Task 0)

Il B1 si esegue prima di questo piano (ordine della nota di riconciliazione: B1 → B2 → B3 ∥ B4). Questo piano consuma i nomi seguenti, **canonici per `docs/superpowers/plans/2026-09-14-lancio-00-riconciliazione-interfacce.md`**, che vince su ogni piano. Se al momento dell'esecuzione un modulo manca, il Task 0 lo crea con il codice minimo indicato lì (stessa firma) e va segnalato nel report finale perché il B1 lo riassorba.

| Modulo (B1) | Firma consumata |
|---|---|
| `lib/lancio-fase.ts` (B1 Task 4) | `LANCIO_SLUG = 'webdev-2026-10'`; `LANCIO_FASI`; `type LancioFase = 'attesa' \| 'posto_bloccato' \| 'link_inviato' \| 'post_pitch' \| 'scelta_fatta' \| 'followup_inviato' \| 'restituito' \| 'chiuso'`; `lancioInCorso(row)`; `TESTO_CONGEDO`, `TESTO_PASSAGGIO_UMANO`. **Non contiene `setLancioFase`**: quel nome non esiste (la fase si scrive con `impostaFaseLancio` di `lib/lancio-db.ts`). |
| `lib/lancio-db.ts` (B1 Task 8) | `impostaFaseLancio(supabase, conversationId: number, fase: LancioFase, campi?: { lancio_link_inviato_at?: string; lancio_followup_inviato_at?: string; lancio_info?: Json }): Promise<void>` — unico scrittore di `lancio_fase`, scrive da solo l'evento `lancio_fase_cambiata` (o `lancio_fase_non_scritta`). Per un evento in più si inserisce una riga in `event_log` a parte, dopo la chiamata. |
| `lib/lancio-settings.ts` (B1 Task 2) | `type LancioSettings = { attivo: boolean; zoomLink: string \| null; videoLiveLink: string \| null; offertaDelMeseLink: string \| null; eventoAt: string \| null }`; `getLancioSettings(supabase): Promise<LancioSettings>`; `LANCIO_SETTING_KEYS` (chiavi DB `lancio_attivo`, `lancio_zoom_link`, `lancio_video_live_link`, `offerta_del_mese_link`, `lancio_evento_at`). Nel codice si usano SOLO le proprietà dell'oggetto (`s.attivo`, `s.zoomLink`, `s.eventoAt`), mai le chiavi grezze. |
| `lib/lancio-classifica.ts` (B1 Task 5) | `classificaLancio(body): 'si' \| 'no' \| 'domanda' \| 'incerto'`; `type LancioReplyParsed = { classe: 'si' \| 'no' \| 'domanda'; passToHuman: boolean; visibleReply: string }`; `parseLancioReply(raw)` (toglie dal testo visibile anche i tag `[LANCIO:CHIAMA_ORA]`, `[LANCIO:PRENOTA\|…]`, `[LANCIO:SLOTS]` grazie ad `ALTRI_TAG_RE`). |
| `lib/lancio-prompt.ts` (B1 Task 6) | `type LancioPromptInput = { fase: string \| null; nome: string \| null; eventoAt: string \| null }`; `buildLancioSystem(i: LancioPromptInput): string`. Il B4 (Task 6) lo estende con i rami `link_inviato` e `post_pitch` e i campi opzionali che servono loro. |
| `lib/lancio-reply.ts` (B1 Task 6) | `generateLancioReply(history: MarioTurn[], opts: LancioPromptInput & { now?: Date }): Promise<LancioReplyParsed>`. Il B4 (Task 6) aggiunge al risultato `lancioTag: LancioTag \| null` (parser dei tag della scelta). **Non si crea `lib/lancio-model.ts`.** |
| `lib/lancio-turno.ts` (B1 Task 8) | `type TurnoLancioInput = { conversationId; phone; from; crmLeadId: string \| null; fase: string \| null; nome: string \| null; rows: { direction; body: string \| null; template_sid: string \| null }[]; inboundBody: string; genera?: typeof generateLancioReply; settings?: LancioSettings }`; `eseguiTurnoLancio(supabase, i): Promise<'active' \| 'closed' \| 'handed_off'>`. Il B4 (Task 9) ci mette uno `switch` sulla fase con i rami `link_inviato`, `post_pitch`, `scelta_fatta` e aggiunge a `TurnoLancioInput` `lancioInfo`, `now?`, `rows[].created_at?`. **Non si crea `lib/lancio-drain.ts` né `turnoLancio`.** |
| `lib/fenice-autoreply.ts` (B1 Task 8) | il claim del drain seleziona `lancio_slug, lancio_fase` e, se `lancioInCorso`, il round lo fa `eseguiTurnoLancio` (≈10 righe prima di `generateMarioReply`). Il B4 non aggiunge un secondo ramo: allarga solo la select (`lancio_info`) e il passaggio dei campi (Task 9). |
| `lib/mario.ts` (B1 Task 6) | `getAnthropicClient()`, `MARIO_MODEL`, `MEDIA_SENZA_TESTO`, `type MarioTurn`. |
| `lib/lead-entrante.ts` (B2 Task 6) | `pushLeadEntrante(supabase, { conversationId, telefono, nome, provenienza: 'Lancio Web Dev AI', primoMessaggio, scrittoIl }): Promise<{ ok: boolean; leadId?: string; motivo?: string }>` — scrive da sé `crm_lead_id` sulla conversazione quando il CRM risponde. Il webhook del B2 lo chiama in `after()` (fire-and-forget): prima di `book`/`call-now` il B4 rilegge `crm_lead_id` e, se è ancora null, lo richiama (idempotente lato CRM). |
| Colonne (B1 Task 1) | `conversations.lancio_slug text`, `lancio_fase text`, `lancio_ingresso text`, `lancio_link_inviato_at timestamptz`, `lancio_followup_inviato_at timestamptz`, `lancio_info jsonb`. |

**Comportamento dei cron esistenti sui lead lancio** (`sequence-touches`, `bot-followups` Track B, `precall-reminders`, `gdo-video-followups`, `riapri-mute`): esclusi dal B1 Task 10 (spec §5.1). Verificato sul codice di `app/api/cron/bot-followups/route.ts` (14/09): il **re-drive** (blocco "2. Rete di sicurezza") viene PRIMA dello skip lancio "2a-bis" del B1, quindi resta acceso sulle chat del lancio; scatta ogni ora per un inbound che non ha un `fenice_ai_reply` successivo, e solo sulle conversazioni con `crm_lead_id` valorizzato. Da qui due regole per i silenzi di questo piano:
- silenzio **temporaneo** (post_pitch fra le 03:00 e le 08:30, o dopo le 23:00): NON si scrive `fenice_ai_reply`, così il re-drive delle 08:30 fa rispondere;
- silenzio **definitivo** (link_inviato dopo mezzanotte, `scelta_fatta` già ringraziata, tag ignoto): si scrive `fenice_ai_reply` con `lancio: true`, come fa il B1, altrimenti il re-drive ripeterebbe lo stesso silenzio ogni ora fino al tetto dei 5 giorni.

---

## File Structure

**Nuovi**
- `lib/run-pool.ts` — `runPool` estratto da `send-batch` (usato dal blast; il B5 lo importa da qui).
- `lib/lancio-zoom-blast.ts` — logica pura del blast: finestra 19:30-20:45 derivata da `lancio_evento_at`, ID riunione dal link, corpo di fallback, tetto del lotto.
- `app/api/cron/lancio-zoom/route.ts` — il cron del blast.
- `lib/lancio-crm.ts` — client HMAC verso `/api/bot/lancio/{slots,book,call-now}`.
- `lib/lancio-scelta.ts` — regole di orario e finestra, validazione di `at`, parsing dei tag `[LANCIO:*]`, ore proponibili, testi fissi (slot in italiano, conferme, errori).
- `lib/lancio-orologio.ts` — `adessoLancio()`: l'ora "vera" del turno, forzabile con `LANCIO_FAKE_NOW` fuori produzione (o in produzione solo con `LANCIO_FAKE_NOW_ARMED = CRON_SECRET`), per la prova generale.
- `lib/lancio-effetti.ts` — gli effetti condivisi dai turni del B4: una bolla, un evento, la traccia `fenice_ai_reply`, silenzio temporaneo/definitivo, congedo, passaggio umano (il B1 tiene le sue copie inline).
- `lib/lancio-assistenza.ts` — `turnoAssistenza`: il turno della fase `link_inviato` (risposta breve del modello fino alle 23:59 del giorno dell'evento; congedo su un no; dopo mezzanotte silenzio tracciato).
- `lib/lancio-post-pitch.ts` — `turnoPostPitch` (due domande, la scelta, le chiamate al CRM, le conferme) e `turnoDopoScelta` (fase `scelta_fatta`: un solo "Ricevuto", le parole del lead al CRM come nota).
- Test: `lib/run-pool.test.ts`, `lib/lancio-zoom-blast.test.ts`, `app/api/cron/lancio-zoom/route.test.ts`, `lib/lancio-crm.test.ts`, `lib/lancio-scelta.test.ts`, `lib/lancio-orologio.test.ts`, `lib/lancio-assistenza.test.ts`, `lib/lancio-post-pitch.test.ts`.

**Modificati**
- `app/api/cron/send-batch/route.ts` — importa `runPool` da `lib/run-pool.ts` (rimossa la copia privata).
- `vercel.json` — voce `/api/cron/lancio-zoom`.
- `lib/lancio-prompt.ts` (B1) — `buildLancioSystem` diventa uno `switch` sulla fase: rami `link_inviato` (assistenza) e `post_pitch` (scelta) + campi opzionali di `LancioPromptInput`.
- `lib/lancio-reply.ts` (B1) — `generateLancioReply` restituisce anche `lancioTag` (parser di `[LANCIO:CHIAMA_ORA]`, `[LANCIO:PRENOTA|iso]`, `[LANCIO:SLOTS]`, `[LANCIO:NO]`; `[PASSAGGIO_UMANO]` resta in `passToHuman`).
- `app/api/cron/lancio-zoom/route.ts` (Task 3) — `?forza=1` vale solo con `?solo=<conversationId>` (prova generale su una conversazione sola).
- `lib/lancio-turno.ts` (B1) — `switch` sulla fase in testa a `eseguiTurnoLancio`: `link_inviato` → `turnoAssistenza`, `post_pitch` → `turnoPostPitch`, `scelta_fatta` → `turnoDopoScelta`, il resto → il turno del B1; `TurnoLancioInput` cresce di `lancioInfo`, `now?`, `rows[].created_at?`.
- `lib/fenice-autoreply.ts` (B1) — la select del claim legge anche `lancio_info`; il ramo lancio del B1 passa `lancioInfo` e `created_at` delle righe. Nessun secondo ramo.
- Test toccati: `lib/lancio-prompt.test.ts`, `lib/lancio-reply.test.ts`, `lib/lancio-turno.test.ts`, `lib/fenice-autoreply.test.ts` (il ramo lancio scavalca Mario anche in `link_inviato`/`post_pitch`).
- `.env.example` — `LANCIO_ZOOM_TEMPLATE_SID` (se il B1 non l'ha già messo), `LANCIO_BATCH_MAX`, `CRM_LANCIO_URL`, `LANCIO_FAKE_NOW`, `LANCIO_FAKE_NOW_ARMED`.

**Non si creano** (nota di riconciliazione): `lib/lancio-model.ts`, `lib/lancio-drain.ts`, `setLancioFase`, un `LancioSettings` con le chiavi grezze.

---

### Task 0: Le interfacce del B1 esistono? (verifica, stub minimi solo se mancano)

**Files:**
- Verify/Create: `lib/lancio-fase.ts`, `lib/lancio-db.ts`, `lib/lancio-settings.ts`, `lib/lancio-prompt.ts`, `lib/lancio-reply.ts`, `lib/lancio-turno.ts`
- Verify: `lib/supabase/types.ts` (colonne `lancio_*` su `conversations`), `lib/fenice-autoreply.ts` (ramo lancio del B1 presente), `app/api/cron/bot-followups/route.ts` (re-drive prima dello skip lancio), `lib/lead-entrante.ts` (B2 fuso su `main`)

**Interfaces:**
- Consumes: niente.
- Produces: i nomi della tabella "Interfacce del B1 assunte", con quelle firme.

- [ ] **Step 1: Verifica cosa c'è**

Run: `ls lib/lancio-*.ts lib/lead-entrante.ts; grep -n "lancio_fase\|lancio_info\|lancio_link_inviato_at" lib/supabase/types.ts | head; grep -n "eseguiTurnoLancio\|lancioInCorso" lib/fenice-autoreply.ts; grep -n "impostaFaseLancio" lib/lancio-db.ts; grep -n "2a-bis\|Rete di sicurezza" app/api/cron/bot-followups/route.ts`
Expected: i sei moduli esistono con le firme della tabella e il drain ha già il ramo `if (lancioInCorso(lancio))` (→ salta allo Step 5). Se manca `lib/lead-entrante.ts` il B2 non è ancora su `main`: il Task 8 lo importa, quindi o si aspetta il B2 o si crea lo stub dello Step 4. Se `types.ts` non ha le colonne, aggiungerle a mano nei tre blocchi `Row`/`Insert`/`Update` di `conversations` (come `ai_lock_at: string | null`, più `lancio_info: Json | null`) — la migrazione è del B1, ma il typecheck di questo piano ne ha bisogno.

- [ ] **Step 2: (solo se manca) `lib/lancio-db.ts`**

Stessa firma del B1 Task 8, verbatim:

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import type { Json } from './supabase/types';
import type { LancioFase } from './lancio-fase';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Cambio di fase di una chat del lancio: un update e una traccia. E' l'unico punto che
 * scrive `lancio_fase`, cosi' la storia di ogni chat si ricostruisce da `event_log`
 * (`lancio_fase_cambiata`) senza interpretare gli altri eventi.
 */
export async function impostaFaseLancio(
  supabase: Supa,
  conversationId: number,
  fase: LancioFase,
  campi: { lancio_link_inviato_at?: string; lancio_followup_inviato_at?: string; lancio_info?: Json } = {},
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ lancio_fase: fase, ...campi })
    .eq('id', conversationId);
  await supabase.from('event_log').insert({
    type: error ? 'lancio_fase_non_scritta' : 'lancio_fase_cambiata',
    payload: { conversationId, fase, ...campi, ...(error ? { errore: error.message } : {}) } as never,
    message: error
      ? `[lancio] conv ${conversationId}: fase ${fase} NON scritta — ${error.message}`
      : `[lancio] conv ${conversationId}: fase → ${fase}`,
    level: error ? 'error' : 'info',
  });
}
```

- [ ] **Step 3: (solo se manca) `lib/lancio-settings.ts`**

Stessa firma del B1 Task 2 (oggetto con proprietà camelCase, MAI le chiavi grezze):

```ts
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export const LANCIO_SETTING_KEYS = [
  'lancio_attivo', 'lancio_zoom_link', 'lancio_video_live_link', 'offerta_del_mese_link', 'lancio_evento_at',
] as const;
export type LancioSettingKey = (typeof LANCIO_SETTING_KEYS)[number];

export type LancioSettings = {
  attivo: boolean;
  zoomLink: string | null;
  videoLiveLink: string | null;
  offertaDelMeseLink: string | null;
  eventoAt: string | null;
};

export function isAttivo(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['1', 'true', 'on'].includes(value.trim().toLowerCase());
  return false;
}

function stringaOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

export function parseLancioSettings(rows: { key: string; value: unknown }[]): LancioSettings {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    attivo: isAttivo(byKey.get('lancio_attivo')),
    zoomLink: stringaOrNull(byKey.get('lancio_zoom_link')),
    videoLiveLink: stringaOrNull(byKey.get('lancio_video_live_link')),
    offertaDelMeseLink: stringaOrNull(byKey.get('offerta_del_mese_link')),
    eventoAt: stringaOrNull(byKey.get('lancio_evento_at')),
  };
}

export async function getLancioSettings(supabase: Supa): Promise<LancioSettings> {
  const { data } = await supabase.from('app_settings').select('key, value').in('key', [...LANCIO_SETTING_KEYS]);
  return parseLancioSettings((data ?? []) as { key: string; value: unknown }[]);
}
```

- [ ] **Step 4: (solo se mancano) gli altri stub**

`lib/lancio-fase.ts`, `lib/lancio-classifica.ts`, `lib/lancio-prompt.ts`, `lib/lancio-reply.ts`, `lib/lancio-turno.ts`: copiare il codice dei Task 4, 5, 6 e 8 del piano B1 (`docs/superpowers/plans/2026-09-14-lancio-B1-bot-intake.md`) così com'è — sono le implementazioni canoniche, non si riscrivono qui. `lib/lead-entrante.ts`: se il B2 non è ancora su `main`, `git show feat/lead-scrivono-per-primi:lib/lead-entrante.ts > lib/lead-entrante.ts` e allargare `provenienza` a `string` se il tipo del branch non ammette `'Lancio Web Dev AI'` (il B2 Task 6 lo stringe poi al tipo a tre valori).

- [ ] **Step 5: Verifica il re-drive sui lead lancio**

Leggi `app/api/cron/bot-followups/route.ts`: il blocco "2. Rete di sicurezza: re-drive" deve stare PRIMA di "2a-bis. Lancio in corso … continue" (B1 Task 10). Se il B1 avesse messo lo skip prima del re-drive, gli inbound notturni (03:00-08:30) resterebbero senza risposta: la correzione è del B1 (spostare lo skip sotto il re-drive) e va scritta nel report finale. Verifica anche che `lib/bot-followups.ts` `serveCronologia` ritorni `true` per il caso re-drive anche con `lancio_slug` (test "il re-drive resta" del B1).

- [ ] **Step 6: Typecheck e commit (solo se hai creato qualcosa)**

Run: `bun run typecheck`
Expected: nessun errore.

```bash
git add lib/lancio-*.ts lib/supabase/types.ts
git commit -m "chore(lancio): interfacce minime del B1 per il B4 (fase, db, settings, prompt, reply, turno)"
```

---

### Task 1: `runPool` condiviso

**Files:**
- Create: `lib/run-pool.ts`
- Modify: `app/api/cron/send-batch/route.ts:44-59` (rimuovere la copia privata, importare)
- Test: `lib/run-pool.test.ts`

**Interfaces:**
- Produces: `runPool<T, R>(items: T[], concurrency: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]>` — stesso comportamento della copia in `send-batch`: al massimo `concurrency` worker, risultati nell'ordine degli input.

- [ ] **Step 1: Write the failing test**

`lib/run-pool.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { runPool } from './run-pool';

describe('runPool', () => {
  it('risultati nell ordine degli input, anche se finiscono in ordine diverso', async () => {
    const out = await runPool([30, 10, 20], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('non supera la concorrenza', async () => {
    let attivi = 0;
    let picco = 0;
    await runPool(Array.from({ length: 12 }, (_, i) => i), 5, async () => {
      attivi++;
      picco = Math.max(picco, attivi);
      await new Promise((r) => setTimeout(r, 5));
      attivi--;
    });
    expect(picco).toBe(5);
  });

  it('lista vuota: nessun worker, array vuoto', async () => {
    let chiamate = 0;
    const out = await runPool([], 5, async () => { chiamate++; });
    expect(out).toEqual([]);
    expect(chiamate).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run lib/run-pool.test.ts`
Expected: FAIL — `Cannot find module './run-pool'`.

- [ ] **Step 3: Write minimal implementation**

`lib/run-pool.ts`:
```ts
/**
 * Esegue `worker` su ogni elemento con al massimo `concurrency` esecuzioni in volo.
 * I risultati tornano nell'ordine degli input. Nato in `send-batch` (13/07/2026) per il
 * blast delle campagne; il blast del link Zoom (lancio) usa lo stesso motore.
 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
```

In `app/api/cron/send-batch/route.ts`: cancella la funzione `runPool` privata (righe 44-59) e aggiungi `import { runPool } from '@/lib/run-pool';` agli import. Nient'altro cambia.

- [ ] **Step 4: Run tests and typecheck**

Run: `bunx vitest run lib/run-pool.test.ts lib/batch.test.ts && bun run typecheck`
Expected: PASS, nessun errore di tipo.

- [ ] **Step 5: Commit**

```bash
git add lib/run-pool.ts lib/run-pool.test.ts app/api/cron/send-batch/route.ts
git commit -m "refactor(batch): runPool condiviso in lib/run-pool.ts"
```

---

### Task 2: Logica pura del blast Zoom + voce in `vercel.json`

**Files:**
- Create: `lib/lancio-zoom-blast.ts`
- Modify: `vercel.json` (aggiungere la voce cron)
- Test: `lib/lancio-zoom-blast.test.ts`

**Interfaces:**
- Consumes: `romeDayKey(date: Date): string`, `romeHour(date: Date): number`, `romeMinute(date: Date): number` da `lib/rome-time.ts`.
- Produces:
  - `inFinestraBlast(now: Date, eventoAt: Date): boolean` — stesso giorno di Roma dell'evento e minuti-del-giorno in `[evento−90', evento−15']` (21:00 → 19:30-20:45 inclusi).
  - `zoomMeetingId(link: string): string | null` — `'https://us06web.zoom.us/j/89845223337'` → `'898 4522 3337'`.
  - `zoomBlastBody(nome: string, link: string): string` — il testo del template 2 (spec §7) per il corpo salvato a DB quando Twilio non restituisce il body.
  - `batchMax(raw: string | undefined): number` — intero positivo o `400`.
  - `LANCIO_BLAST_CONCURRENCY = 5`, `LANCIO_BATCH_MAX_DEFAULT = 400`.

- [ ] **Step 1: Write the failing test**

`lib/lancio-zoom-blast.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inFinestraBlast, zoomMeetingId, zoomBlastBody, batchMax } from './lancio-zoom-blast';

const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const rome = (hhmm: string, giorno = '2026-10-05') => new Date(`${giorno}T${hhmm}:00+02:00`);

describe('inFinestraBlast: 19:30-20:45 di Roma del giorno dell evento', () => {
  it('19:30 dentro, 19:25 fuori', () => {
    expect(inFinestraBlast(rome('19:30'), EVENTO)).toBe(true);
    expect(inFinestraBlast(rome('19:25'), EVENTO)).toBe(false);
  });
  it('20:45 dentro, 20:50 fuori', () => {
    expect(inFinestraBlast(rome('20:45'), EVENTO)).toBe(true);
    expect(inFinestraBlast(rome('20:50'), EVENTO)).toBe(false);
  });
  it('stessa ora del giorno prima o dopo: fuori', () => {
    expect(inFinestraBlast(rome('20:00', '2026-10-04'), EVENTO)).toBe(false);
    expect(inFinestraBlast(rome('20:00', '2026-10-06'), EVENTO)).toBe(false);
  });
  it('la finestra segue l evento: evento alle 20:00 ⇒ 18:30-19:45', () => {
    const prova = new Date('2026-10-05T20:00:00+02:00');
    expect(inFinestraBlast(rome('18:30'), prova)).toBe(true);
    expect(inFinestraBlast(rome('19:50'), prova)).toBe(false);
  });
});

describe('lo schedule di vercel.json copre esattamente la finestra', () => {
  const { crons } = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const entry = crons.find((c: { path: string }) => c.path === '/api/cron/lancio-zoom');
  it('la voce esiste con lo schedule a data fissa', () => {
    expect(entry?.schedule).toBe('*/5 17-18 5 10 *');
  });
  it('i run utili sono 16, dal 19:30 al 20:45 di Roma', () => {
    const run: Date[] = [];
    for (const h of [17, 18]) for (let m = 0; m < 60; m += 5) run.push(new Date(Date.UTC(2026, 9, 5, h, m)));
    const utili = run.filter((d) => inFinestraBlast(d, EVENTO));
    const hhmm = (d: Date) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    expect(utili).toHaveLength(16);
    expect(hhmm(utili[0])).toBe('19:30');
    expect(hhmm(utili[utili.length - 1])).toBe('20:45');
  });
});

describe('zoomMeetingId', () => {
  it('raggruppa le cifre 3-4-4 come le mostra Zoom', () => {
    expect(zoomMeetingId('https://us06web.zoom.us/j/89845223337')).toBe('898 4522 3337');
  });
  it('link con query string: ignora il resto', () => {
    expect(zoomMeetingId('https://us06web.zoom.us/j/89845223337?pwd=abc')).toBe('898 4522 3337');
  });
  it('link senza /j/: null, non si inventa un codice', () => {
    expect(zoomMeetingId('https://zoom.us/')).toBeNull();
  });
});

describe('zoomBlastBody e batchMax', () => {
  it('il corpo di fallback contiene nome, link e l ora della live', () => {
    const b = zoomBlastBody('Mario', 'https://us06web.zoom.us/j/1');
    expect(b).toContain('Ciao Mario');
    expect(b).toContain('https://us06web.zoom.us/j/1');
    expect(b).toContain('21:00');
  });
  it('batchMax: default 400, env valida, env sporca', () => {
    expect(batchMax(undefined)).toBe(400);
    expect(batchMax('250')).toBe(250);
    expect(batchMax('zero')).toBe(400);
    expect(batchMax('0')).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run lib/lancio-zoom-blast.test.ts`
Expected: FAIL — modulo assente e voce cron assente.

- [ ] **Step 3: Write minimal implementation**

`lib/lancio-zoom-blast.ts`:
```ts
import { romeDayKey, romeHour, romeMinute } from './rome-time';

// Blast del link Zoom (spec §5.3): la logica senza rete e senza database. La finestra si
// deriva dall'ora dell'evento e non da numeri scritti qui, così la prova generale del B6
// sposta l'evento e la finestra la segue.

/** Quante conversazioni per run, salvo `LANCIO_BATCH_MAX`. 400 ogni 5' ⇒ ~3.000 in 40'. */
export const LANCIO_BATCH_MAX_DEFAULT = 400;
/** Stessa concorrenza di `send-batch`: Twilio regge, Meta conta i template, non i secondi. */
export const LANCIO_BLAST_CONCURRENCY = 5;

const DA_MINUTI_PRIMA = 90;
const A_MINUTI_PRIMA = 15;

const minutiDelGiorno = (d: Date) => romeHour(d) * 60 + romeMinute(d);

/**
 * Siamo nella fascia del blast? Stesso giorno italiano dell'evento e fra 90 e 15 minuti
 * prima dell'inizio (21:00 ⇒ 19:30-20:45 inclusi). Il cron gira a maglia larga in UTC
 * (`* /5 17-18`) e decide qui, in ora di Roma, come `gdo-video-followups`.
 */
export function inFinestraBlast(now: Date, eventoAt: Date): boolean {
  if (romeDayKey(now) !== romeDayKey(eventoAt)) return false;
  const m = minutiDelGiorno(now);
  const evento = minutiDelGiorno(eventoAt);
  return m >= evento - DA_MINUTI_PRIMA && m <= evento - A_MINUTI_PRIMA;
}

/** L'ID riunione come lo legge il lead ("898 4522 3337"): sono le cifre dopo `/j/`. */
export function zoomMeetingId(link: string): string | null {
  const m = /\/j\/(\d{9,11})(?:[/?#]|$)/.exec(link);
  if (!m) return null;
  const cifre = m[1];
  return `${cifre.slice(0, 3)} ${cifre.slice(3, 7)} ${cifre.slice(7)}`.trim();
}

/** Il testo del template "Link Zoom" (spec §7.2): corpo salvato a DB se Twilio non lo dà. */
export function zoomBlastBody(nome: string, link: string): string {
  return `Ciao ${nome}, ci siamo! Alle 21:00 inizia la live Web Developer AI. Questo è il tuo link per collegarti: ${link} — ti consigliamo di entrare qualche minuto prima. Se hai problemi a collegarti scrivimi qui.`;
}

/** Tetto del lotto da env: intero positivo, altrimenti il default. */
export function batchMax(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : LANCIO_BATCH_MAX_DEFAULT;
}
```

In `vercel.json`, aggiungi in coda all'array `crons`:
```json
    {
      "path": "/api/cron/lancio-zoom",
      "schedule": "*/5 17-18 5 10 *"
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run lib/lancio-zoom-blast.test.ts lib/cron-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-zoom-blast.ts lib/lancio-zoom-blast.test.ts vercel.json
git commit -m "feat(lancio): finestra e testi del blast Zoom, cron a data fissa in vercel.json"
```

---

### Task 3: Il cron `/api/cron/lancio-zoom`

**Files:**
- Create: `app/api/cron/lancio-zoom/route.ts`
- Test: `app/api/cron/lancio-zoom/route.test.ts`

**Interfaces:**
- Consumes: `inFinestraBlast`, `zoomBlastBody`, `batchMax`, `LANCIO_BLAST_CONCURRENCY` (Task 2); `runPool` (Task 1); `getLancioSettings(supabase)` (B1 Task 2: oggetto `{ attivo, zoomLink, eventoAt, … }`) e `impostaFaseLancio(supabase, id, 'link_inviato', { lancio_link_inviato_at })` (B1 Task 8, `lib/lancio-db.ts`); `sendTemplate({ to, contentSid, variables, from })` e `getTemplateBody(sid)` da `lib/twilio.ts`; `renderBodyTemplate(body, vars)` da `lib/campaigns.ts`; `templateName(raw)` da `lib/name.ts`.
- Produces: `GET /api/cron/lancio-zoom` → `{ ok, skipped?, candidati, sent, riparati, capped, failed, report }`. Parametri: `?dry=1` (conta e basta), `?now=<ISO>` (orologio forzato per la prova generale del B6; vale solo con l'auth del cron), `?forza=1&solo=<conversationId>` (salta SOLO il filtro della finestra di Roma, non il kill-switch `attivo`, e SOLO per quella conversazione: per spedire il link a un numero di test senza spostare `lancio_evento_at`; `forza` senza `solo` è un 400).

Decisioni fissate qui:
- Bersaglio: `lancio_slug IS NOT NULL AND lancio_fase IN ('attesa','posto_bloccato') AND lancio_link_inviato_at IS NULL`, `ORDER BY id`, `LIMIT batchMax`. **Nessun filtro su `ai_paused_at`/`handed_off`**: il link è ciò per cui il lead si è iscritto, e chi ha preso in mano la chat non lo manderebbe a 3.000 persone a mano. Chi non ha mai risposto lo riceve comunque (decisione 14/09).
- Idempotenza doppia: la query esclude `lancio_link_inviato_at`; prima di spedire si leggono le righe `messages.template_sid = LANCIO_ZOOM_TEMPLATE_SID` sulle candidate (non `failed`/`undelivered`): chi ce l'ha già viene solo **riparato** (fase + timestamp, nessun invio) — copre un run morto fra l'invio e la scrittura della fase.
- 63049 (frequency cap Meta): nessuna riga in `messages`, fase invariata, `event_log lancio_zoom_freq_capped`; il run dopo lo riprende.
- Qualsiasi altro errore Twilio: riga `messages` con `twilio_status='failed'` (così il pannello lo mostra), `send_error`, fase invariata: al run dopo si riprova (la riga failed non conta nell'idempotenza).
- Ogni run scrive un `lancio_zoom_blast` riassuntivo.

- [ ] **Step 1: Write the failing test**

`app/api/cron/lancio-zoom/route.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Finto Supabase: `conversations` restituisce le candidate, `messages` le righe già
// spedite; insert e update vengono registrate per poterle interrogare.
type Chiamata = { table: string; op: string; arg: unknown; filtri: [string, unknown][] };
const chiamate: Chiamata[] = [];
const righe = { candidate: [] as unknown[], messaggiSpediti: [] as unknown[] };

function query(table: string, op: string, arg: unknown) {
  const rec: Chiamata = { table, op, arg, filtri: [] };
  chiamate.push(rec);
  const q: Record<string, unknown> = {};
  for (const m of ['is', 'not', 'in', 'order', 'gte', 'maybeSingle']) q[m] = (...a: unknown[]) => { rec.filtri.push([m, a]); return q; };
  q.eq = (c: string, v: unknown) => { rec.filtri.push([c, v]); return q; };
  q.limit = (n: number) => { rec.filtri.push(['limit', n]); return q; };
  q.then = (ok: (v: unknown) => unknown) => {
    if (table === 'conversations' && op === 'select') return Promise.resolve({ data: righe.candidate, error: null }).then(ok);
    if (table === 'messages' && op === 'select') return Promise.resolve({ data: righe.messaggiSpediti, error: null }).then(ok);
    return Promise.resolve({ data: null, error: null }).then(ok);
  };
  return q;
}
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: (s: string) => query(table, 'select', s),
      insert: (r: unknown) => query(table, 'insert', r),
      update: (r: unknown) => query(table, 'update', r),
    }),
  }),
}));

const sendTemplate = vi.fn();
vi.mock('@/lib/twilio', () => ({
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  getTemplateBody: async () => 'Ciao {{1}}, link: {{2}}',
}));

// Stessa forma dell'oggetto di `getLancioSettings` (B1): proprietà camelCase, mai le chiavi grezze.
const settings = {
  zoomLink: 'https://us06web.zoom.us/j/89845223337', attivo: true,
  eventoAt: '2026-10-05T21:00:00+02:00', videoLiveLink: null, offertaDelMeseLink: null,
};
vi.mock('@/lib/lancio-settings', () => ({ getLancioSettings: async () => settings }));

const impostaFaseLancio = vi.fn(async () => undefined);
vi.mock('@/lib/lancio-db', () => ({ impostaFaseLancio: (...a: unknown[]) => impostaFaseLancio(...a) }));

import { GET } from './route';

const SEGRETO = 's3cret';
const SID = 'HXzoom';
const url = (now: string, extra = '') =>
  `https://x/api/cron/lancio-zoom?secret=${SEGRETO}&now=${encodeURIComponent(now)}${extra}`;
const chiama = (extra = '') => GET(new Request(url('2026-10-05T20:00:00+02:00', extra)) as never);
const conv = (id: number, nome = 'mario rossi') => ({ id, leads: { phone_e164: `+3933300000${id}`, first_name: nome } });
const inserimenti = (t: string) => chiamate.filter((c) => c.table === t && c.op === 'insert').map((c) => c.arg as Record<string, unknown>);

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SEGRETO);
  vi.stubEnv('LANCIO_ZOOM_TEMPLATE_SID', SID);
  vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
  vi.stubEnv('LANCIO_BATCH_MAX', '');
  chiamate.length = 0;
  righe.candidate = [conv(1), conv(2, 'anna verdi')];
  righe.messaggiSpediti = [];
  settings.attivo = true;
  sendTemplate.mockReset().mockResolvedValue({ sid: 'SM1', status: 'queued' });
  impostaFaseLancio.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/cron/lancio-zoom — cancelli', () => {
  it('senza segreto: 401', async () => {
    const res = await GET(new Request('https://x/api/cron/lancio-zoom') as never);
    expect(res.status).toBe(401);
  });
  it('lancio non attivo: nessuna query, nessun invio', async () => {
    settings.attivo = false;
    await expect((await chiama()).json()).resolves.toMatchObject({ skipped: 'lancio_non_attivo' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });
  it('fuori dalla finestra di Roma: skip', async () => {
    const res = await GET(new Request(url('2026-10-05T19:20:00+02:00')) as never);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'fuori_finestra' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });
  it('forza=1 vale solo con solo=<id>: senza è 400; con, manda a quella sola conversazione; il kill-switch vince', async () => {
    const senza = await GET(new Request(url('2026-10-05T19:20:00+02:00', '&forza=1')) as never);
    expect(senza.status).toBe(400);
    expect(sendTemplate).not.toHaveBeenCalled();
    righe.candidate = [conv(2, 'anna verdi')];
    await expect((await GET(new Request(url('2026-10-05T19:20:00+02:00', '&forza=1&solo=2')) as never)).json()).resolves.toMatchObject({ sent: 1 });
    const sel = chiamate.find((c) => c.table === 'conversations' && c.op === 'select');
    expect(sel?.filtri).toContainEqual(['id', 2]);
    settings.attivo = false;
    await expect((await GET(new Request(url('2026-10-05T19:20:00+02:00', '&forza=1&solo=2')) as never)).json()).resolves.toMatchObject({ skipped: 'lancio_non_attivo' });
  });
  it('template o link mancanti: si logga e non si manda', async () => {
    vi.stubEnv('LANCIO_ZOOM_TEMPLATE_SID', '');
    await expect((await chiama()).json()).resolves.toMatchObject({ skipped: 'config' });
    expect(inserimenti('event_log').map((e) => e.type)).toContain('lancio_zoom_config_error');
    expect(sendTemplate).not.toHaveBeenCalled();
  });
  it('dry: conta e basta', async () => {
    await expect((await chiama('&dry=1')).json()).resolves.toMatchObject({ dry: true, candidati: 2 });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/lancio-zoom — invio', () => {
  it('manda il template con nome proprio e link, registra il messaggio e passa a link_inviato', async () => {
    await expect((await chiama()).json()).resolves.toMatchObject({ sent: 2, failed: 0, capped: 0 });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      to: '+39333000001', contentSid: SID, variables: { '1': 'Mario', '2': settings.zoomLink },
    }));
    const msg = inserimenti('messages');
    expect(msg).toHaveLength(2);
    expect(msg[0]).toMatchObject({ template_sid: SID, is_template: true, direction: 'out', sender: 'automazione' });
    expect(String(msg[0].body)).toContain('Ciao Mario, link: https://us06web.zoom.us/j/89845223337');
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'link_inviato', { lancio_link_inviato_at: expect.any(String) });
  });
  it('rispetta il tetto del lotto nella query', async () => {
    vi.stubEnv('LANCIO_BATCH_MAX', '250');
    await chiama();
    const sel = chiamate.find((c) => c.table === 'conversations' && c.op === 'select');
    expect(sel?.filtri).toContainEqual(['limit', 250]);
  });
  it('già spedito per messages.template_sid: si ripara la fase, non si rimanda', async () => {
    righe.messaggiSpediti = [{ conversation_id: 1, template_sid: SID }];
    await expect((await chiama()).json()).resolves.toMatchObject({ sent: 1, riparati: 1 });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: '+39333000002' }));
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 1, 'link_inviato', expect.anything());
  });
  it('63049: nessuna riga messages, fase invariata, si riprova al run dopo', async () => {
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('cap'), { code: 63049 }));
    await expect((await chiama()).json()).resolves.toMatchObject({ sent: 1, capped: 1 });
    expect(inserimenti('messages')).toHaveLength(1);
    expect(impostaFaseLancio).toHaveBeenCalledTimes(1);
    expect(inserimenti('event_log').map((e) => e.type)).toContain('lancio_zoom_freq_capped');
  });
  it('altro errore Twilio: riga failed, send_error, fase invariata', async () => {
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('giu'), { code: 20429 }));
    await expect((await chiama()).json()).resolves.toMatchObject({ sent: 1, failed: 1 });
    expect(inserimenti('messages').some((m) => m.twilio_status === 'failed' && m.template_sid === SID)).toBe(true);
    expect(inserimenti('event_log').map((e) => e.type)).toContain('send_error');
    expect(impostaFaseLancio).toHaveBeenCalledTimes(1);
  });
  it('lead senza telefono: saltato senza rompere il giro', async () => {
    righe.candidate = [{ id: 9, leads: null }, conv(2)];
    await expect((await chiama()).json()).resolves.toMatchObject({ sent: 1, skip: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run app/api/cron/lancio-zoom/route.test.ts`
Expected: FAIL — `./route` non esiste.

- [ ] **Step 3: Write the route**

`app/api/cron/lancio-zoom/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplate, getTemplateBody } from '@/lib/twilio';
import { renderBodyTemplate } from '@/lib/campaigns';
import { templateName } from '@/lib/name';
import { runPool } from '@/lib/run-pool';
import { getLancioSettings } from '@/lib/lancio-settings';
import { impostaFaseLancio } from '@/lib/lancio-db';
import { inFinestraBlast, zoomBlastBody, batchMax, LANCIO_BLAST_CONCURRENCY } from '@/lib/lancio-zoom-blast';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Blast del link Zoom (spec §5.3): ogni 5' dalle 19:30 alle 20:45 di Roma del giorno
// dell'evento, a lotti di LANCIO_BATCH_MAX, a chi è ancora in `attesa`/`posto_bloccato`
// — anche a chi non ha mai risposto al benvenuto (decisione 14/09). Idempotenza doppia:
// `lancio_link_inviato_at` nella query e `messages.template_sid` prima di spedire.
// Il numero è a qualità LOW: da qui non parte nient'altro che questo template.

type Supa = ReturnType<typeof getSupabaseAdmin>;
type Esito = 'sent' | 'riparato' | 'capped' | 'failed' | 'skip';
type Candidata = { id: number; leads?: { phone_e164?: string | null; first_name?: string | null } | null };

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

/** `?now=` sposta l'orologio SOLO per la prova generale (B6): l'auth del cron è già passata. */
function orologio(req: NextRequest): Date {
  const forzato = req.nextUrl.searchParams.get('now');
  const t = forzato ? Date.parse(forzato) : NaN;
  return Number.isNaN(t) ? new Date() : new Date(t);
}

async function configError(supabase: Supa, missing: string[]): Promise<NextResponse> {
  await supabase.from('event_log').insert({
    type: 'lancio_zoom_config_error',
    payload: { missing } as never,
    message: `[lancio] blast Zoom saltato: manca ${missing.join(', ')}`,
    level: 'error',
  });
  return NextResponse.json({ ok: true, skipped: 'config', missing });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);
  // Kill-switch dal pannello, prima di qualsiasi altra lettura.
  if (!settings.attivo) return NextResponse.json({ ok: true, skipped: 'lancio_non_attivo' });

  const eventoMs = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  if (Number.isNaN(eventoMs)) return configError(supabase, ['lancio_evento_at']);
  const now = orologio(req);
  // Prova generale: `?forza=1` salta SOLO il filtro della finestra e vale SOLO insieme a
  // `?solo=<conversationId>` — senza, un run forzato prima del 5/10 manderebbe il link a
  // tutti i lead in attesa. Il kill-switch `attivo` qui sopra vale sempre.
  const forza = req.nextUrl.searchParams.get('forza') === '1';
  const solo = parseInt(req.nextUrl.searchParams.get('solo') ?? '', 10);
  if (forza && !Number.isFinite(solo)) {
    return NextResponse.json({ ok: false, error: 'forza=1 richiede solo=<conversationId>' }, { status: 400 });
  }
  if (!forza && !inFinestraBlast(now, new Date(eventoMs))) return NextResponse.json({ ok: true, skipped: 'fuori_finestra' });

  const sid = process.env.LANCIO_ZOOM_TEMPLATE_SID;
  const link = settings.zoomLink;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const missing = [
    !sid && 'LANCIO_ZOOM_TEMPLATE_SID',
    !link && 'lancio_zoom_link',
    !from && 'TWILIO_WHATSAPP_NUMBER_FENICE',
  ].filter((x): x is string => typeof x === 'string');
  if (missing.length > 0 || !sid || !link) return configError(supabase, missing);

  const dry = req.nextUrl.searchParams.get('dry') === '1';
  const max = batchMax(process.env.LANCIO_BATCH_MAX);

  let q = supabase
    .from('conversations')
    .select('id, leads(phone_e164, first_name)')
    .not('lancio_slug', 'is', null)
    .in('lancio_fase', ['attesa', 'posto_bloccato'])
    .is('lancio_link_inviato_at', null)
    .order('id', { ascending: true })
    .limit(max);
  if (Number.isFinite(solo)) q = q.eq('id', solo); // prova generale: una conversazione sola
  const { data } = await q;
  const candidati = (data ?? []) as unknown as Candidata[];
  if (dry) return NextResponse.json({ ok: true, dry: true, candidati: candidati.length, max });
  if (candidati.length === 0) return NextResponse.json({ ok: true, candidati: 0, sent: 0 });

  // Seconda idempotenza: un run morto fra l'invio e la scrittura della fase lascia il
  // messaggio a DB e la fase indietro; qui si ripara senza rimandare.
  const ids = candidati.map((c) => c.id);
  const { data: spediti } = await supabase
    .from('messages')
    .select('conversation_id, template_sid')
    .in('conversation_id', ids)
    .eq('template_sid', sid)
    .not('twilio_status', 'in', '(failed,undelivered)');
  const giaSpediti = new Set((spediti ?? []).map((m) => m.conversation_id as number));

  const bodyRaw = (await getTemplateBody(sid)) ?? zoomBlastBody('{{1}}', '{{2}}');
  const inviatoAt = new Date().toISOString();

  const inviaUno = async (c: Candidata): Promise<Esito> => {
    const phone = c.leads?.phone_e164;
    if (!phone) return 'skip';
    if (giaSpediti.has(c.id)) {
      await impostaFaseLancio(supabase, c.id, 'link_inviato', { lancio_link_inviato_at: inviatoAt });
      return 'riparato';
    }
    const vars = { '1': templateName(c.leads?.first_name), '2': link };
    const body = renderBodyTemplate(bodyRaw, vars);
    try {
      const sent = await sendTemplate({ to: phone, contentSid: sid, variables: vars, from });
      await supabase.from('messages').insert({
        conversation_id: c.id, direction: 'out', body,
        twilio_sid: sent.sid, twilio_status: sent.status,
        template_sid: sid, template_vars: vars, is_template: true, sender: 'automazione',
      });
      await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', c.id);
      await impostaFaseLancio(supabase, c.id, 'link_inviato', { lancio_link_inviato_at: new Date().toISOString() });
      return 'sent';
    } catch (err: unknown) {
      const e = err as { message?: string; code?: number; status?: number };
      if (e?.code === 63049) {
        // Frequency cap Meta: niente riga, niente fase — il run dopo lo riprende.
        await supabase.from('event_log').insert({
          type: 'lancio_zoom_freq_capped',
          payload: { conversationId: c.id, templateSid: sid } as never,
          message: `[lancio] frequency cap Meta su conv ${c.id}: link non spedito, ritento al prossimo run`,
          level: 'info',
        });
        return 'capped';
      }
      await supabase.from('event_log').insert({
        type: 'send_error',
        payload: { conversationId: c.id, phone, code: e?.code ?? null, status: e?.status ?? null } as never,
        message: `[lancio] Twilio send fallito su conv ${c.id}: ${e?.message ?? 'unknown'}`,
        level: 'error',
      });
      // La riga failed si vede nel pannello e NON conta nell'idempotenza: si riprova.
      await supabase.from('messages').insert({
        conversation_id: c.id, direction: 'out', body,
        twilio_status: 'failed', twilio_error_code: e?.code ?? null,
        template_sid: sid, template_vars: vars, is_template: true, sender: 'automazione',
      });
      return 'failed';
    }
  };

  const esiti = await runPool(candidati, LANCIO_BLAST_CONCURRENCY, inviaUno);
  const conta = (k: Esito) => esiti.filter((e) => e === k).length;
  const riepilogo = {
    candidati: candidati.length, sent: conta('sent'), riparati: conta('riparato'),
    capped: conta('capped'), failed: conta('failed'), skip: conta('skip'),
  };

  await supabase.from('event_log').insert({
    type: 'lancio_zoom_blast',
    payload: { ...riepilogo, max } as never,
    message: `[lancio] blast Zoom: ${riepilogo.sent} inviati, ${riepilogo.riparati} riparati, ${riepilogo.capped} cap, ${riepilogo.failed} falliti (su ${riepilogo.candidati})`,
    level: riepilogo.failed > 0 ? 'warn' : 'info',
  });

  return NextResponse.json({ ok: true, ...riepilogo, report: esiti });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run app/api/cron/lancio-zoom/route.test.ts && bun run typecheck`
Expected: PASS. Se il typecheck si lamenta di `lancio_slug`/`lancio_fase` nelle query, mancano le colonne in `lib/supabase/types.ts` (Task 0, Step 1).

- [ ] **Step 5: Nota operativa (va nel report finale, non nel codice)**

Con `UTILITY_ONLY=1` in produzione `sendTemplate` blocca ogni template non-UTILITY: se Meta approva il "Link Zoom" come MARKETING, il SID va in `UTILITY_ONLY_ALLOW` prima del 5/10 (verifica del B6).

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/lancio-zoom/route.ts app/api/cron/lancio-zoom/route.test.ts
git commit -m "feat(lancio): cron del blast Zoom a lotti con doppia idempotenza e stop sul 63049"
```

---

### Task 4: Il client CRM `lib/lancio-crm.ts`

**Files:**
- Create: `lib/lancio-crm.ts`
- Test: `lib/lancio-crm.test.ts`

**Interfaces:**
- Consumes: `signPayload(rawBody: string, secret: string): string` da `lib/bot-hmac.ts`; env `BOT_WEBHOOK_SECRET`, `CRM_LANCIO_URL`.
- Produces (riusate dal B5 e dal Task 8):
  ```ts
  export type LancioKind = 'mattina' | 'pomeriggio' | 'dopodomani';
  export type LancioVenditore = { id: string; nome: string };
  export type LancioSlots = {
    date: string;
    mattina: { hour: number; liberi: number }[] | 'conferme';
    pomeriggio?: { aperto: boolean; ore: number[] };
    mattinaEsaurita?: boolean;
  };
  export type LancioInfo = { risposte: string[]; slotsMostratiAt?: string | null };
  export type LancioCrmErrore =
    | { ok: false; kind: 'ora_esaurita'; slots: LancioSlots | null }
    | { ok: false; kind: 'nessun_venditore' }
    | { ok: false; kind: 'fuori_regole' }
    | { ok: false; kind: 'forbidden' }
    | { ok: false; kind: 'http'; status: number; body: string }
    | { ok: false; kind: 'rete'; error: string }
    | { ok: false; kind: 'not_configured' };
  export type LancioSlotsResult = { ok: true; slots: LancioSlots } | LancioCrmErrore;
  export type LancioBookResult = { ok: true; kind: LancioKind; venditore?: LancioVenditore; deduped?: boolean } | LancioCrmErrore;
  export type LancioCallNowResult = { ok: true; venditore: LancioVenditore } | LancioCrmErrore;
  export function lancioSlots(date: string): Promise<LancioSlotsResult>;
  export function lancioBook(args: { leadId: string; at: string; info?: LancioInfo; note?: string }): Promise<LancioBookResult>;
  export function lancioCallNow(args: { leadId: string; info?: LancioInfo; note?: string }): Promise<LancioCallNowResult>;
  export const LANCIO_CRM_TIMEOUT_MS = 8_000;
  ```
  Nessun accesso a Supabase e nessun `event_log` qui dentro: solo rete. Chi chiama registra.

- [ ] **Step 1: Write the failing test**

`lib/lancio-crm.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lancioSlots, lancioBook, lancioCallNow, LANCIO_CRM_TIMEOUT_MS } from './lancio-crm';
import { signPayload } from './bot-hmac';

const risposta = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body),
});
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv('BOT_WEBHOOK_SECRET', 'segreto');
  vi.stubEnv('CRM_LANCIO_URL', '');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('lancioSlots', () => {
  it('POST firmato a /slots con il body esatto, timeout 8s', async () => {
    fetchMock.mockResolvedValue(risposta(200, { date: '2026-10-06', mattina: [{ hour: 9, liberi: 2 }], pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] }, mattinaEsaurita: false }));
    const out = await lancioSlots('2026-10-06');
    expect(out).toMatchObject({ ok: true, slots: { date: '2026-10-06', mattinaEsaurita: false } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://crm-sales-fenice.vercel.app/api/bot/lancio/slots');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ date: '2026-10-06' }));
    expect((init.headers as Record<string, string>)['x-bot-signature']).toBe(signPayload(init.body as string, 'segreto'));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(LANCIO_CRM_TIMEOUT_MS).toBe(8_000);
  });
  it('CRM_LANCIO_URL sovrascrive la base', async () => {
    vi.stubEnv('CRM_LANCIO_URL', 'http://localhost:3000/api/bot/lancio');
    fetchMock.mockResolvedValue(risposta(200, { date: '2026-10-07', mattina: 'conferme' }));
    await lancioSlots('2026-10-07');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/api/bot/lancio/slots');
  });
  it('segreto mancante: not_configured, nessuna rete', async () => {
    vi.stubEnv('BOT_WEBHOOK_SECRET', '');
    expect(await lancioSlots('2026-10-06')).toEqual({ ok: false, kind: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('corpo non JSON su 200: http con il testo', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>' });
    expect(await lancioSlots('2026-10-06')).toMatchObject({ ok: false, kind: 'http', status: 200 });
  });
});

describe('lancioBook', () => {
  const args = { leadId: 'L1', at: '2026-10-06T09:00:00+02:00', info: { risposte: ['faccio il barista'] }, note: 'dalla live' };
  it('200 mattina con venditore', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } }));
    expect(await lancioBook(args)).toEqual({ ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' }, deduped: undefined });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/book$/);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual(args);
  });
  it('200 deduped: lo stesso at ripetuto non e un errore', async () => {
    fetchMock.mockResolvedValue(risposta(200, { ok: true, kind: 'pomeriggio', deduped: true }));
    expect(await lancioBook(args)).toMatchObject({ ok: true, kind: 'pomeriggio', deduped: true });
  });
  it('409 ora_esaurita porta gli slot aggiornati', async () => {
    fetchMock.mockResolvedValue(risposta(409, { ok: false, motivo: 'ora_esaurita', slots: { date: '2026-10-06', mattina: [], mattinaEsaurita: true } }));
    expect(await lancioBook(args)).toEqual({ ok: false, kind: 'ora_esaurita', slots: { date: '2026-10-06', mattina: [], mattinaEsaurita: true } });
  });
  it('409 nessun_venditore, 422 fuori_regole, 403 forbidden', async () => {
    fetchMock.mockResolvedValueOnce(risposta(409, { ok: false, motivo: 'nessun_venditore' }));
    expect(await lancioBook(args)).toEqual({ ok: false, kind: 'nessun_venditore' });
    fetchMock.mockResolvedValueOnce(risposta(422, { ok: false, motivo: 'fuori_regole' }));
    expect(await lancioBook(args)).toEqual({ ok: false, kind: 'fuori_regole' });
    fetchMock.mockResolvedValueOnce(risposta(403, { ok: false }));
    expect(await lancioBook(args)).toEqual({ ok: false, kind: 'forbidden' });
  });
  it('500: http con status e corpo; rete: rete con il messaggio', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    expect(await lancioBook(args)).toEqual({ ok: false, kind: 'http', status: 500, body: 'boom' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await lancioBook(args)).toEqual({ ok: false, kind: 'rete', error: 'ECONNRESET' });
  });
  it('timeout: l abort torna come rete', async () => {
    fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_, rej) => {
      init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.useFakeTimers();
    const p = lancioBook(args);
    await vi.advanceTimersByTimeAsync(LANCIO_CRM_TIMEOUT_MS + 1);
    expect(await p).toMatchObject({ ok: false, kind: 'rete' });
    vi.useRealTimers();
  });
});

describe('lancioCallNow', () => {
  it('200 con venditore; 409 nessun_venditore', async () => {
    fetchMock.mockResolvedValueOnce(risposta(200, { ok: true, venditore: { id: 'u1', nome: 'Sara' } }));
    expect(await lancioCallNow({ leadId: 'L1', info: { risposte: [] } })).toEqual({ ok: true, venditore: { id: 'u1', nome: 'Sara' } });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/call-now$/);
    fetchMock.mockResolvedValueOnce(risposta(409, { ok: false, motivo: 'nessun_venditore' }));
    expect(await lancioCallNow({ leadId: 'L1' })).toEqual({ ok: false, kind: 'nessun_venditore' });
  });
  it('200 senza venditore leggibile: http, non si inventa un nome', async () => {
    fetchMock.mockResolvedValueOnce(risposta(200, { ok: true }));
    expect(await lancioCallNow({ leadId: 'L1' })).toMatchObject({ ok: false, kind: 'http', status: 200 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run lib/lancio-crm.test.ts`
Expected: FAIL — modulo assente.

- [ ] **Step 3: Write minimal implementation**

`lib/lancio-crm.ts`:
```ts
import { signPayload } from './bot-hmac';

// Client verso le tre rotte del lancio sul CRM (spec §6.2). Solo rete: niente Supabase,
// niente event_log — chi chiama registra. Firma HMAC identica a `sendOutcome`, timeout
// proprio perché queste chiamate stanno dentro un turno del drain (il lead aspetta).

const DEFAULT_BASE = 'https://crm-sales-fenice.vercel.app/api/bot/lancio';
export const LANCIO_CRM_TIMEOUT_MS = 8_000;

export type LancioKind = 'mattina' | 'pomeriggio' | 'dopodomani';
export type LancioVenditore = { id: string; nome: string };
export type LancioSlots = {
  date: string;
  /** Ore 9..14 con posti liberi; `'conferme'` per dopodomani (tutte le 9-14 accettate). */
  mattina: { hour: number; liberi: number }[] | 'conferme';
  pomeriggio?: { aperto: boolean; ore: number[] };
  mattinaEsaurita?: boolean;
};
/** Il contenuto di `conversations.lancio_info`: le risposte di riscaldamento, più lo
 *  stato interno del turno post-pitch. Al CRM viaggia dentro `info`. */
export type LancioInfo = { risposte: string[]; slotsMostratiAt?: string | null };

export type LancioCrmErrore =
  | { ok: false; kind: 'ora_esaurita'; slots: LancioSlots | null }
  | { ok: false; kind: 'nessun_venditore' }
  | { ok: false; kind: 'fuori_regole' }
  | { ok: false; kind: 'forbidden' }
  | { ok: false; kind: 'http'; status: number; body: string }
  | { ok: false; kind: 'rete'; error: string }
  | { ok: false; kind: 'not_configured' };

export type LancioSlotsResult = { ok: true; slots: LancioSlots } | LancioCrmErrore;
export type LancioBookResult =
  | { ok: true; kind: LancioKind; venditore?: LancioVenditore; deduped?: boolean }
  | LancioCrmErrore;
export type LancioCallNowResult = { ok: true; venditore: LancioVenditore } | LancioCrmErrore;

type Grezza = { status: number; json: Record<string, unknown> | null; text: string };

async function postLancio(path: string, body: unknown): Promise<Grezza | LancioCrmErrore> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { ok: false, kind: 'not_configured' };
  const base = process.env.CRM_LANCIO_URL || DEFAULT_BASE;
  const rawBody = JSON.stringify(body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LANCIO_CRM_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
    return { status: res.status, json, text };
  } catch (e) {
    return { ok: false, kind: 'rete', error: e instanceof Error ? e.message : 'errore' };
  } finally {
    clearTimeout(timer);
  }
}

const eErrore = (g: Grezza | LancioCrmErrore): g is LancioCrmErrore => 'ok' in g && g.ok === false;

/** Traduce gli status del contratto in errori tipizzati; `null` se è un 2xx con JSON. */
function erroreDaStatus(g: Grezza): LancioCrmErrore | null {
  const motivo = typeof g.json?.motivo === 'string' ? g.json.motivo : null;
  if (g.status === 403) return { ok: false, kind: 'forbidden' };
  if (g.status === 422) return { ok: false, kind: 'fuori_regole' };
  if (g.status === 409 && motivo === 'ora_esaurita') return { ok: false, kind: 'ora_esaurita', slots: leggiSlots(g.json?.slots) };
  if (g.status === 409 && motivo === 'nessun_venditore') return { ok: false, kind: 'nessun_venditore' };
  if (g.status < 200 || g.status >= 300 || !g.json) return { ok: false, kind: 'http', status: g.status, body: g.text.slice(0, 300) };
  return null;
}

function leggiSlots(raw: unknown): LancioSlots | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.date !== 'string') return null;
  const mattina = o.mattina === 'conferme'
    ? 'conferme' as const
    : Array.isArray(o.mattina)
      ? o.mattina
          .filter((s): s is { hour: number; liberi: number } => !!s && typeof s === 'object' && typeof (s as { hour?: unknown }).hour === 'number')
          .map((s) => ({ hour: s.hour, liberi: typeof s.liberi === 'number' ? s.liberi : 0 }))
      : [];
  const pom = o.pomeriggio && typeof o.pomeriggio === 'object' ? (o.pomeriggio as { aperto?: unknown; ore?: unknown }) : null;
  return {
    date: o.date,
    mattina,
    ...(pom ? { pomeriggio: { aperto: pom.aperto === true, ore: Array.isArray(pom.ore) ? pom.ore.filter((h): h is number => typeof h === 'number') : [] } } : {}),
    ...(typeof o.mattinaEsaurita === 'boolean' ? { mattinaEsaurita: o.mattinaEsaurita } : {}),
  };
}

function leggiVenditore(raw: unknown): LancioVenditore | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.nome !== 'string' || !o.nome.trim()) return undefined;
  return { id: String(o.id ?? ''), nome: o.nome.trim() };
}

export async function lancioSlots(date: string): Promise<LancioSlotsResult> {
  const g = await postLancio('slots', { date });
  if (eErrore(g)) return g;
  const err = erroreDaStatus(g);
  if (err) return err;
  const slots = leggiSlots(g.json);
  if (!slots) return { ok: false, kind: 'http', status: g.status, body: g.text.slice(0, 300) };
  return { ok: true, slots };
}

export async function lancioBook(args: { leadId: string; at: string; info?: LancioInfo; note?: string }): Promise<LancioBookResult> {
  const g = await postLancio('book', args);
  if (eErrore(g)) return g;
  const err = erroreDaStatus(g);
  if (err) return err;
  const kind = g.json?.kind;
  if (kind !== 'mattina' && kind !== 'pomeriggio' && kind !== 'dopodomani') {
    return { ok: false, kind: 'http', status: g.status, body: g.text.slice(0, 300) };
  }
  return { ok: true, kind, venditore: leggiVenditore(g.json?.venditore), deduped: g.json?.deduped === true ? true : undefined };
}

export async function lancioCallNow(args: { leadId: string; info?: LancioInfo; note?: string }): Promise<LancioCallNowResult> {
  const g = await postLancio('call-now', args);
  if (eErrore(g)) return g;
  const err = erroreDaStatus(g);
  if (err) return err;
  const venditore = leggiVenditore(g.json?.venditore);
  // Senza un nome la conferma fissa "ti chiama <nome>" non si può scrivere: meglio un
  // errore leggibile che un lead a cui promettiamo una chiamata da nessuno.
  if (!venditore) return { ok: false, kind: 'http', status: g.status, body: g.text.slice(0, 300) };
  return { ok: true, venditore };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run lib/lancio-crm.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-crm.ts lib/lancio-crm.test.ts
git commit -m "feat(lancio): client HMAC verso /api/bot/lancio (slots, book, call-now) con errori tipizzati"
```

---

### Task 5: Le regole della scelta, i tag e i testi fissi — `lib/lancio-scelta.ts`

**Files:**
- Create: `lib/lancio-scelta.ts`
- Test: `lib/lancio-scelta.test.ts`

**Interfaces:**
- Consumes: `LancioSlots`, `LancioKind`, `LancioInfo` (Task 4); `isoWithOffset` da `lib/bot-contract.ts`; `romeDayKey`, `romeHour`, `romeMinute`, `romeOffset` da `lib/rome-time.ts`.
- Produces (tutto puro, nessun I/O):
  ```ts
  export type GiorniLancio = { evento: string; giornoDopo: string; dopodomani: string };   // 'YYYY-MM-DD' di Roma
  export function giorniLancio(eventoAt: Date): GiorniLancio;
  export type ModoPostPitch = 'notte' | 'giorno';
  export function modoPostPitch(now: Date, eventoAt: Date): ModoPostPitch;          // notte = [evento, giornoDopo 03:00)
  export function puoRispondere(now: Date, eventoAt: Date, fase: 'link_inviato' | 'post_pitch'): boolean;
  export type MotivoAtNonValido = 'formato' | 'giorno_non_ammesso' | 'ora_non_tonda' | 'fuori_fascia' | 'troppo_vicino';
  export type ValidazioneAt = { ok: true; kind: LancioKind; date: string; hour: number } | { ok: false; motivo: MotivoAtNonValido };
  export function validaAtLancio(at: string, now: Date, eventoAt: Date): ValidazioneAt;
  export type LancioTag = { tag: 'CHIAMA_ORA' } | { tag: 'PRENOTA'; at: string } | { tag: 'SLOTS' } | { tag: 'NO' };
  export function parseLancioTag(raw: string): LancioTag | null;
  export function stripLancioTags(raw: string): string;
  export type OreProponibili = { mattina: number[]; pomeriggio: number[]; dopodomani: number[]; mattinaEsaurita: boolean };
  export function oreProponibili(slots: LancioSlots | null, now: Date, eventoAt: Date): OreProponibili;
  export function atIso(date: string, hour: number): string;                       // '2026-10-06T09:00:00+02:00'
  export function etichettaGiorno(date: string): string;                           // 'martedì 6 ottobre'
  export function testoSlots(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string;
  export function bloccoSlotPerPrompt(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string;
  export function testoConfermaChiamata(nomeVenditore: string): string;
  export function testoConfermaPrenotazione(kind: LancioKind, at: string, nomeVenditore?: string | null): string;
  export function testoOraEsaurita(hour: number, ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string;
  export function testoAtNonValido(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string;
  export const TESTO_NESSUN_VENDITORE: string;        // prefisso; chi chiama appende testoSlots
  export const TESTO_CHIAMATA_FUORI_ORARIO: string;   // idem
  export const TESTO_ERRORE_CRM: string;
  export const TESTO_DOPO_SCELTA: string;
  export const TESTO_CONGEDO_POST_PITCH: string;
  export const MARKER_PULSANTE_RE: RegExp;            // /live web developer ai/i (spec §6.3)
  export function raccogliRisposte(info: LancioInfo | null, nuoviInbound: string[]): LancioInfo;
  ```

Regole fissate qui (spec §5.4, "regole dure nel codice"):
- `validaAtLancio`, nell'ordine: ISO con offset → giorno ∈ {giornoDopo, dopodomani} → minuti/secondi a zero → fascia (giornoDopo 9-20, dopodomani 9-14) → `at ≥ now + 1h`. `kind`: dopodomani → `'dopodomani'`; giornoDopo ore 9-14 → `'mattina'`, 15-20 → `'pomeriggio'`.
- `oreProponibili`: la mattina del giorno dopo viene SOLO dagli slot del CRM (`liberi > 0`); il pomeriggio 15-20 e la mattina di dopodomani 9-14 sono sempre proponibili (nessun tetto, spec decisione 8) anche se il CRM non risponde; tutte filtrate con `at ≥ now+1h`. `mattinaEsaurita` = flag del CRM, oppure nessuna ora di mattina rimasta.
- `testoSlots` in modo `giorno` (dopo le 03:00 del 6) non nomina la mattina del 6: propone solo il pomeriggio o il 7. Nel blocco per il prompt le ore di mattina ≥ now+1h restano, marcate "solo se le chiede il lead", così `[LANCIO:PRENOTA|…]` può mapparle e la guardia le accetta (spec: "si accettano solo se `at ≥ now+1h`").
- Il modello vede le ore SOLO come stringhe ISO da copiare nel tag: il blocco le elenca una per riga.

- [ ] **Step 1: Write the failing test**

`lib/lancio-scelta.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  giorniLancio, modoPostPitch, puoRispondere, validaAtLancio, parseLancioTag, stripLancioTags,
  oreProponibili, atIso, etichettaGiorno, testoSlots, bloccoSlotPerPrompt,
  testoConfermaChiamata, testoConfermaPrenotazione, testoOraEsaurita, raccogliRisposte, MARKER_PULSANTE_RE,
} from './lancio-scelta';
import type { LancioSlots } from './lancio-crm';

const EVENTO = new Date('2026-10-05T21:00:00+02:00');
const t = (iso: string) => new Date(iso);
const NOTTE = t('2026-10-05T22:40:00+02:00');
const MATTINA6 = t('2026-10-06T09:10:00+02:00');

describe('giorniLancio e modo', () => {
  it('i tre giorni di Roma derivano dall evento', () => {
    expect(giorniLancio(EVENTO)).toEqual({ evento: '2026-10-05', giornoDopo: '2026-10-06', dopodomani: '2026-10-07' });
  });
  it('notte dalle 21:00 del 5 alle 02:59 del 6, giorno dopo', () => {
    expect(modoPostPitch(t('2026-10-05T21:00:00+02:00'), EVENTO)).toBe('notte');
    expect(modoPostPitch(t('2026-10-06T02:59:00+02:00'), EVENTO)).toBe('notte');
    expect(modoPostPitch(t('2026-10-06T03:00:00+02:00'), EVENTO)).toBe('giorno');
    expect(modoPostPitch(t('2026-10-05T20:00:00+02:00'), EVENTO)).toBe('giorno');
  });
});

describe('puoRispondere', () => {
  it('post_pitch: sempre di notte, poi solo 08:30-23:00', () => {
    expect(puoRispondere(t('2026-10-06T01:30:00+02:00'), EVENTO, 'post_pitch')).toBe(true);
    expect(puoRispondere(t('2026-10-06T04:00:00+02:00'), EVENTO, 'post_pitch')).toBe(false);
    expect(puoRispondere(t('2026-10-06T08:29:00+02:00'), EVENTO, 'post_pitch')).toBe(false);
    expect(puoRispondere(t('2026-10-06T08:30:00+02:00'), EVENTO, 'post_pitch')).toBe(true);
    expect(puoRispondere(t('2026-10-06T23:00:00+02:00'), EVENTO, 'post_pitch')).toBe(false);
  });
  it('link_inviato: dal blast alle 23:59 del giorno dell evento, poi mai (il 6 risponde il follow-up del B5)', () => {
    expect(puoRispondere(t('2026-10-05T19:20:00+02:00'), EVENTO, 'link_inviato')).toBe(false);
    expect(puoRispondere(t('2026-10-05T19:35:00+02:00'), EVENTO, 'link_inviato')).toBe(true);
    expect(puoRispondere(t('2026-10-05T23:50:00+02:00'), EVENTO, 'link_inviato')).toBe(true);
    expect(puoRispondere(t('2026-10-06T00:10:00+02:00'), EVENTO, 'link_inviato')).toBe(false);
    expect(puoRispondere(t('2026-10-06T10:00:00+02:00'), EVENTO, 'link_inviato')).toBe(false);
  });
});

describe('validaAtLancio: le regole dure', () => {
  it('mattina del 6 a ore piene: ok, kind mattina', () => {
    expect(validaAtLancio('2026-10-06T09:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: true, kind: 'mattina', date: '2026-10-06', hour: 9 });
    expect(validaAtLancio('2026-10-06T14:00:00+02:00', NOTTE, EVENTO)).toMatchObject({ ok: true, kind: 'mattina' });
  });
  it('15-20 del 6: pomeriggio; 9-14 del 7: dopodomani', () => {
    expect(validaAtLancio('2026-10-06T15:00:00+02:00', NOTTE, EVENTO)).toMatchObject({ ok: true, kind: 'pomeriggio' });
    expect(validaAtLancio('2026-10-06T20:00:00+02:00', NOTTE, EVENTO)).toMatchObject({ ok: true, kind: 'pomeriggio' });
    expect(validaAtLancio('2026-10-07T14:00:00+02:00', NOTTE, EVENTO)).toMatchObject({ ok: true, kind: 'dopodomani' });
  });
  it('senza offset: formato; l ora UTC equivalente conta come Roma', () => {
    expect(validaAtLancio('2026-10-06T09:00:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'formato' });
    expect(validaAtLancio('2026-10-06T07:00:00Z', NOTTE, EVENTO)).toMatchObject({ ok: true, hour: 9 });
  });
  it('giorno non ammesso: il 5, l 8', () => {
    expect(validaAtLancio('2026-10-05T23:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'giorno_non_ammesso' });
    expect(validaAtLancio('2026-10-08T10:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'giorno_non_ammesso' });
  });
  it('ora non tonda', () => {
    expect(validaAtLancio('2026-10-06T09:30:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'ora_non_tonda' });
  });
  it('fuori fascia: 8 e 21 del 6, 15 del 7', () => {
    expect(validaAtLancio('2026-10-06T08:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'fuori_fascia' });
    expect(validaAtLancio('2026-10-06T21:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'fuori_fascia' });
    expect(validaAtLancio('2026-10-07T15:00:00+02:00', NOTTE, EVENTO)).toEqual({ ok: false, motivo: 'fuori_fascia' });
  });
  it('troppo vicino: alle 09:10 del 6 le 9 e le 10 sono andate, le 11 no', () => {
    expect(validaAtLancio('2026-10-06T09:00:00+02:00', MATTINA6, EVENTO)).toEqual({ ok: false, motivo: 'troppo_vicino' });
    expect(validaAtLancio('2026-10-06T10:00:00+02:00', MATTINA6, EVENTO)).toEqual({ ok: false, motivo: 'troppo_vicino' });
    expect(validaAtLancio('2026-10-06T11:00:00+02:00', MATTINA6, EVENTO)).toMatchObject({ ok: true, kind: 'mattina' });
  });
});

describe('tag', () => {
  it('riconosce i quattro tag e toglie tutto dal testo', () => {
    expect(parseLancioTag('Perfetto! [LANCIO:CHIAMA_ORA]')).toEqual({ tag: 'CHIAMA_ORA' });
    expect(parseLancioTag('[LANCIO:PRENOTA|2026-10-06T09:00:00+02:00] ok')).toEqual({ tag: 'PRENOTA', at: '2026-10-06T09:00:00+02:00' });
    expect(parseLancioTag('Vediamo le ore [LANCIO:SLOTS]')).toEqual({ tag: 'SLOTS' });
    expect(parseLancioTag('[lancio:no]')).toEqual({ tag: 'NO' });
    expect(parseLancioTag('nessun tag')).toBeNull();
    expect(stripLancioTags('Ciao [LANCIO:SLOTS] a te [LANCIO:PRENOTA|x]')).toBe('Ciao  a te');
  });
  it('PRENOTA senza argomento non e un tag valido', () => {
    expect(parseLancioTag('[LANCIO:PRENOTA|]')).toBeNull();
  });
});

const SLOTS: LancioSlots = { date: '2026-10-06', mattina: [{ hour: 9, liberi: 1 }, { hour: 11, liberi: 2 }, { hour: 13, liberi: 0 }, { hour: 14, liberi: 1 }], pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] }, mattinaEsaurita: false };
const GIORNI = giorniLancio(EVENTO);

describe('oreProponibili', () => {
  it('di notte: mattina dagli slot con liberi>0, pomeriggio intero, dopodomani 9-14', () => {
    expect(oreProponibili(SLOTS, NOTTE, EVENTO)).toEqual({ mattina: [9, 11, 14], pomeriggio: [15, 16, 17, 18, 19, 20], dopodomani: [9, 10, 11, 12, 13, 14], mattinaEsaurita: false });
  });
  it('senza slot (CRM giu): niente mattina, pomeriggio e dopodomani restano', () => {
    expect(oreProponibili(null, NOTTE, EVENTO)).toMatchObject({ mattina: [], pomeriggio: [15, 16, 17, 18, 19, 20], mattinaEsaurita: true });
  });
  it('alle 09:10 del 6 la regola +1h taglia 9 e 10', () => {
    expect(oreProponibili(SLOTS, MATTINA6, EVENTO).mattina).toEqual([11, 14]);
  });
  it('alle 19:30 del 6 resta solo il 7', () => {
    const ore = oreProponibili(SLOTS, t('2026-10-06T19:30:00+02:00'), EVENTO);
    expect(ore.pomeriggio).toEqual([]);
    expect(ore.dopodomani).toEqual([9, 10, 11, 12, 13, 14]);
  });
});

describe('testi', () => {
  it('atIso ed etichetta', () => {
    expect(atIso('2026-10-06', 9)).toBe('2026-10-06T09:00:00+02:00');
    expect(etichettaGiorno('2026-10-07')).toBe('mercoledì 7 ottobre');
  });
  it('slot di notte: mattina elencata, pomeriggio a fascia', () => {
    const s = testoSlots(oreProponibili(SLOTS, NOTTE, EVENTO), GIORNI, 'notte');
    expect(s).toBe('Per la call ho libero domattina alle 9, alle 11 o alle 14, oppure domani pomeriggio dalle 15 alle 20: che ora preferisci?');
  });
  it('mattina piena: si propone il pomeriggio e il 7 solo per chi puo solo la mattina', () => {
    const s = testoSlots(oreProponibili({ ...SLOTS, mattina: [], mattinaEsaurita: true }, NOTTE, EVENTO), GIORNI, 'notte');
    expect(s).toContain('Domattina è tutto pieno');
    expect(s).toContain('domani pomeriggio dalle 15 alle 20');
    expect(s).toContain('mercoledì 7 ottobre dalle 9 alle 14');
  });
  it('di giorno non si nomina la mattina di oggi anche se ha ore', () => {
    const s = testoSlots(oreProponibili(SLOTS, MATTINA6, EVENTO), GIORNI, 'giorno');
    expect(s).not.toMatch(/alle 11/);
    expect(s).toContain('oggi pomeriggio dalle 15 alle 20');
    expect(s).toContain('domani mattina');
  });
  it('il blocco per il prompt elenca stringhe ISO da copiare', () => {
    const b = bloccoSlotPerPrompt(oreProponibili(SLOTS, NOTTE, EVENTO), GIORNI, 'notte');
    expect(b).toContain('2026-10-06T09:00:00+02:00');
    expect(b).toContain('2026-10-06T20:00:00+02:00');
    expect(b).toContain('2026-10-07T14:00:00+02:00');
    expect(b).not.toContain('2026-10-06T13:00:00+02:00');
    expect(b).not.toContain('2026-10-06T21:00:00+02:00');
  });
  it('conferme fisse', () => {
    expect(testoConfermaChiamata('Luca')).toBe('Perfetto, ti chiama Luca tra pochissimo.');
    expect(testoConfermaPrenotazione('mattina', '2026-10-06T09:00:00+02:00', 'Luca')).toBe('Perfetto, ci sentiamo martedì 6 ottobre alle 9:00: ti chiama Luca. Tieni il telefono a portata di mano.');
    expect(testoConfermaPrenotazione('pomeriggio', '2026-10-06T17:00:00+02:00')).toBe('Perfetto, ci sentiamo martedì 6 ottobre alle 17:00: ti chiama un nostro consulente. Tieni il telefono a portata di mano.');
    expect(testoOraEsaurita(9, oreProponibili(SLOTS, NOTTE, EVENTO), GIORNI, 'notte')).toMatch(/^Le 9 si sono appena riempite\. Per la call ho libero/);
  });
});

describe('raccogliRisposte', () => {
  it('accumula le parole del lead, salta il marker del pulsante, taglia a 6 e a 300 caratteri', () => {
    const uno = raccogliRisposte(null, ['Ho seguito la live Web Developer AI e voglio saperne di più 🚀', 'faccio il barista']);
    expect(uno.risposte).toEqual(['faccio il barista']);
    const lunga = 'x'.repeat(400);
    const due = raccogliRisposte(uno, ['a', 'b', 'c', 'd', 'e', lunga, '  ']);
    expect(due.risposte).toHaveLength(6);
    expect(due.risposte[5]).toHaveLength(300);
    expect(MARKER_PULSANTE_RE.test('ho seguito la LIVE web developer AI')).toBe(true);
  });
  it('conserva slotsMostratiAt', () => {
    expect(raccogliRisposte({ risposte: [], slotsMostratiAt: 'x' }, ['ciao']).slotsMostratiAt).toBe('x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run lib/lancio-scelta.test.ts`
Expected: FAIL — modulo assente.

- [ ] **Step 3: Write minimal implementation**

`lib/lancio-scelta.ts`:
```ts
import type { LancioSlots, LancioKind, LancioInfo } from './lancio-crm';
import { isoWithOffset } from './bot-contract';
import { romeDayKey, romeHour, romeMinute, romeOffset } from './rome-time';

// La scelta della sera del webinar (spec §5.4), senza rete e senza database: le regole
// dure, i tag, le ore proponibili e ogni testo fisso che il lead legge. Il modello non
// scrive mai un'ora: le vede qui, come stringhe ISO da copiare in un tag, e il tag torna
// qui per essere validato. Tutto si deriva da `lancio_evento_at`, niente date scritte a
// mano: la prova generale del B6 sposta l'evento e tutto il resto lo segue.

export type GiorniLancio = { evento: string; giornoDopo: string; dopodomani: string };
export type ModoPostPitch = 'notte' | 'giorno';
export type MotivoAtNonValido = 'formato' | 'giorno_non_ammesso' | 'ora_non_tonda' | 'fuori_fascia' | 'troppo_vicino';
export type ValidazioneAt =
  | { ok: true; kind: LancioKind; date: string; hour: number }
  | { ok: false; motivo: MotivoAtNonValido };
export type LancioTag = { tag: 'CHIAMA_ORA' } | { tag: 'PRENOTA'; at: string } | { tag: 'SLOTS' } | { tag: 'NO' };
export type OreProponibili = { mattina: number[]; pomeriggio: number[]; dopodomani: number[]; mattinaEsaurita: boolean };

const H = 3600_000;
/** Un'ora prenotabile deve stare almeno un'ora avanti: i venditori vanno avvisati. */
const ANTICIPO_MINIMO_MS = 1 * H;
const FASCIA_GIORNO_DOPO = { da: 9, a: 20 };
const FASCIA_DOPODOMANI = { da: 9, a: 14 };
const PRIMA_ORA_POMERIGGIO = 15;
/** Fine della notte del webinar: dopo, si risponde solo in fascia. */
const FINE_NOTTE_HHMM = '03:00';
const FASCIA_RISPOSTE = { daMin: 8 * 60 + 30, aMin: 23 * 60 };
/** Il blast parte 90' prima dell'evento: da lì il lead può chiedere assistenza. */
const ASSISTENZA_DA_MIN_PRIMA = 90;

const pad = (n: number) => String(n).padStart(2, '0');

/** Somma giorni a una chiave 'YYYY-MM-DD' con ancora UTC a mezzogiorno (immune dalla DST). */
function aggiungiGiorni(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const a = new Date(Date.UTC(y, m - 1, d, 12));
  a.setUTCDate(a.getUTCDate() + n);
  return `${a.getUTCFullYear()}-${pad(a.getUTCMonth() + 1)}-${pad(a.getUTCDate())}`;
}

export function giorniLancio(eventoAt: Date): GiorniLancio {
  const evento = romeDayKey(eventoAt);
  return { evento, giornoDopo: aggiungiGiorni(evento, 1), dopodomani: aggiungiGiorni(evento, 2) };
}

/** 'YYYY-MM-DD' + ora tonda ⇒ ISO con l'offset di Roma di QUEL giorno. */
export function atIso(date: string, hour: number): string {
  const ancora = new Date(`${date}T12:00:00Z`);
  return `${date}T${pad(hour)}:00:00${romeOffset(ancora)}`;
}

const istante = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00${romeOffset(new Date(`${date}T12:00:00Z`))}`);

/** Notte = dall'inizio dell'evento alle 03:00 del giorno dopo: il lead sta scrivendo ora. */
export function modoPostPitch(now: Date, eventoAt: Date): ModoPostPitch {
  const { giornoDopo } = giorniLancio(eventoAt);
  const ms = now.getTime();
  return ms >= eventoAt.getTime() && ms < istante(giornoDopo, FINE_NOTTE_HHMM) ? 'notte' : 'giorno';
}

const minutiDelGiorno = (d: Date) => romeHour(d) * 60 + romeMinute(d);

/**
 * Il bot può rispondere adesso? Dentro la finestra dell'evento sempre (il lead sta
 * guardando la live o ha appena premuto il pulsante); fuori, in post_pitch solo 08:30-23:00
 * di Roma — un inbound delle 04:00 lo riprende il re-drive di `bot-followups` alle 08:30.
 * In link_inviato fuori finestra non si risponde più: il 6 arriva il follow-up (B5).
 */
export function puoRispondere(now: Date, eventoAt: Date, fase: 'link_inviato' | 'post_pitch'): boolean {
  const { giornoDopo } = giorniLancio(eventoAt);
  const ms = now.getTime();
  const da = fase === 'link_inviato' ? eventoAt.getTime() - ASSISTENZA_DA_MIN_PRIMA * 60_000 : eventoAt.getTime();
  const a = fase === 'link_inviato' ? istante(giornoDopo, '00:00') : istante(giornoDopo, FINE_NOTTE_HHMM);
  if (ms >= da && ms < a) return true;
  // L'assistenza finisce col giorno dell'evento: il 6 il lead riceve il follow-up (B5) e
  // da lì risponde Mario. Un turno di assistenza il giorno dopo non esiste.
  if (fase === 'link_inviato') return false;
  const m = minutiDelGiorno(now);
  return m >= FASCIA_RISPOSTE.daMin && m < FASCIA_RISPOSTE.aMin;
}

const kindDi = (date: string, hour: number, g: GiorniLancio): LancioKind =>
  date === g.dopodomani ? 'dopodomani' : hour < PRIMA_ORA_POMERIGGIO ? 'mattina' : 'pomeriggio';

/** Le regole dure sull'ora scelta (spec §5.4). L'ordine dei motivi va dal più grave al più fine. */
export function validaAtLancio(at: string, now: Date, eventoAt: Date): ValidazioneAt {
  if (!isoWithOffset(at)) return { ok: false, motivo: 'formato' };
  const ms = Date.parse(at);
  const d = new Date(ms);
  const g = giorniLancio(eventoAt);
  const date = romeDayKey(d);
  if (date !== g.giornoDopo && date !== g.dopodomani) return { ok: false, motivo: 'giorno_non_ammesso' };
  // Roma ha sempre un offset a ore intere: minuti e secondi UTC sono quelli italiani.
  if (d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) return { ok: false, motivo: 'ora_non_tonda' };
  const hour = romeHour(d);
  const fascia = date === g.giornoDopo ? FASCIA_GIORNO_DOPO : FASCIA_DOPODOMANI;
  if (hour < fascia.da || hour > fascia.a) return { ok: false, motivo: 'fuori_fascia' };
  if (ms < now.getTime() + ANTICIPO_MINIMO_MS) return { ok: false, motivo: 'troppo_vicino' };
  return { ok: true, kind: kindDi(date, hour, g), date, hour };
}

const TAG_RE = /\[LANCIO:(CHIAMA_ORA|PRENOTA|SLOTS|NO)(?:\|([^\]]*))?\]/gi;

/** Il primo tag del lancio nel testo del modello. PRENOTA senza argomento non vale. */
export function parseLancioTag(raw: string): LancioTag | null {
  for (const m of raw.matchAll(TAG_RE)) {
    const kind = m[1].toUpperCase();
    const arg = (m[2] ?? '').trim();
    if (kind === 'CHIAMA_ORA') return { tag: 'CHIAMA_ORA' };
    if (kind === 'SLOTS') return { tag: 'SLOTS' };
    if (kind === 'NO') return { tag: 'NO' };
    if (kind === 'PRENOTA' && arg) return { tag: 'PRENOTA', at: arg };
  }
  return null;
}

export function stripLancioTags(raw: string): string {
  return raw.replace(TAG_RE, '').replace(/[ \t]{2,}/g, '  ').trim();
}

const oreDa = (da: number, a: number) => Array.from({ length: a - da + 1 }, (_, i) => da + i);

/**
 * Le ore che si possono proporre adesso. La mattina del giorno dopo la decide il CRM
 * (calendario dei venditori); il pomeriggio e la mattina di dopodomani vanno alle
 * Conferme e non hanno tetto (decisione 8), quindi restano proponibili anche se la
 * chiamata agli slot è fallita — il lead non deve restare senza un'ora per un timeout.
 */
export function oreProponibili(slots: LancioSlots | null, now: Date, eventoAt: Date): OreProponibili {
  const g = giorniLancio(eventoAt);
  const abbastanzaAvanti = (date: string, hour: number) => Date.parse(atIso(date, hour)) >= now.getTime() + ANTICIPO_MINIMO_MS;
  const mattinaGrezza = slots && Array.isArray(slots.mattina)
    ? slots.mattina.filter((s) => s.liberi > 0 && s.hour >= FASCIA_GIORNO_DOPO.da && s.hour < PRIMA_ORA_POMERIGGIO).map((s) => s.hour)
    : [];
  const mattina = [...new Set(mattinaGrezza)].sort((a, b) => a - b).filter((h) => abbastanzaAvanti(g.giornoDopo, h));
  const pomeriggio = oreDa(PRIMA_ORA_POMERIGGIO, FASCIA_GIORNO_DOPO.a).filter((h) => abbastanzaAvanti(g.giornoDopo, h));
  const dopodomani = oreDa(FASCIA_DOPODOMANI.da, FASCIA_DOPODOMANI.a).filter((h) => abbastanzaAvanti(g.dopodomani, h));
  return { mattina, pomeriggio, dopodomani, mattinaEsaurita: slots?.mattinaEsaurita === true || mattina.length === 0 };
}

const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

/** 'martedì 6 ottobre' da 'YYYY-MM-DD'. */
export function etichettaGiorno(date: string): string {
  return fmtGiorno.format(new Date(`${date}T12:00:00Z`));
}

const elencoOre = (ore: number[]) =>
  ore.length === 1 ? `alle ${ore[0]}` : `${ore.slice(0, -1).map((h) => `alle ${h}`).join(', ')} o alle ${ore[ore.length - 1]}`;
const fasciaOre = (ore: number[]) => (ore.length === 1 ? `alle ${ore[0]}` : `dalle ${ore[0]}` + ` alle ${ore[ore.length - 1]}`);

/** Come chiamare i due giorni a seconda di quando siamo: di notte "domani", di giorno "oggi". */
function nomiGiorni(g: GiorniLancio, modo: ModoPostPitch) {
  return modo === 'notte'
    ? { mattinaDopo: 'domattina', pomDopo: 'domani pomeriggio', giornoDopo: 'domani', dopodomani: etichettaGiorno(g.dopodomani), dopodomaniMattina: `${etichettaGiorno(g.dopodomani)} dalle 9 alle 14` }
    : { mattinaDopo: 'stamattina', pomDopo: 'oggi pomeriggio', giornoDopo: 'oggi', dopodomani: 'domani', dopodomaniMattina: 'domani mattina dalle 9 alle 14' };
}

/** Il messaggio con le ore, scritto dal codice. Di giorno la mattina del 6 non si nomina. */
export function testoSlots(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string {
  const n = nomiGiorni(giorni, modo);
  const mattina = modo === 'notte' ? ore.mattina : [];
  const dd = ore.dopodomani.length > 0 ? fasciaOre(ore.dopodomani) : null;
  const ddTesto = dd ? `${n.dopodomani} ${dd}` : null;
  if (mattina.length > 0 && ore.pomeriggio.length > 0) {
    return `Per la call ho libero ${n.mattinaDopo} ${elencoOre(mattina)}, oppure ${n.pomDopo} ${fasciaOre(ore.pomeriggio)}: che ora preferisci?`;
  }
  if (ore.pomeriggio.length > 0) {
    const testa = modo === 'notte' ? 'Domattina è tutto pieno. ' : '';
    const coda = ddTesto ? ` Se puoi solo la mattina, ho ${ddTesto}.` : '';
    return `${testa}Per la call ho ${n.pomDopo} ${fasciaOre(ore.pomeriggio)}: che ora preferisci?${coda}`;
  }
  if (ddTesto) return `Per ${n.giornoDopo} non ho più ore libere. Ho ${ddTesto}: che ora preferisci?`;
  return 'Per questi due giorni non ho più ore libere: ti fa richiamare un nostro consulente, lascio nota.';
}

/** Il blocco per il system prompt: le sole stringhe che il modello può mettere nel tag. */
export function bloccoSlotPerPrompt(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string {
  const riga = (date: string, h: number, nota: string) => `- ${atIso(date, h)} → ${etichettaGiorno(date)} alle ${h}:00 (${nota})`;
  const righe = [
    ...ore.mattina.map((h) => riga(giorni.giornoDopo, h, modo === 'notte' ? 'domattina' : 'stamattina, SOLO se la chiede il lead: non proporla tu')),
    ...ore.pomeriggio.map((h) => riga(giorni.giornoDopo, h, modo === 'notte' ? 'domani pomeriggio' : 'oggi pomeriggio')),
    ...ore.dopodomani.map((h) => riga(giorni.dopodomani, h, modo === 'notte' ? 'dopodomani mattina, solo se il lead può solo la mattina o lo chiede' : 'domani mattina')),
  ];
  return [
    'ORE PRENOTABILI (nel tag [LANCIO:PRENOTA|...] copia ESATTAMENTE una di queste stringhe ISO, nessun altro giorno o ora esiste):',
    ...(righe.length > 0 ? righe : ['- (nessuna ora libera: rispondi con [LANCIO:SLOTS] e basta)']),
    ore.mattina.length === 0 ? `Mattina di ${etichettaGiorno(giorni.giornoDopo)}: NESSUNA ora libera, non proporla.` : '',
  ].filter(Boolean).join('\n');
}

const oraLeggibile = (at: string) => {
  const d = new Date(Date.parse(at));
  return `${etichettaGiorno(romeDayKey(d))} alle ${romeHour(d)}:00`;
};

export function testoConfermaChiamata(nomeVenditore: string): string {
  return `Perfetto, ti chiama ${nomeVenditore} tra pochissimo.`;
}

export function testoConfermaPrenotazione(kind: LancioKind, at: string, nomeVenditore?: string | null): string {
  const chi = kind === 'mattina' && nomeVenditore ? `ti chiama ${nomeVenditore}` : 'ti chiama un nostro consulente';
  return `Perfetto, ci sentiamo ${oraLeggibile(at)}: ${chi}. Tieni il telefono a portata di mano.`;
}

export function testoOraEsaurita(hour: number, ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string {
  return `Le ${hour} si sono appena riempite. ${testoSlots(ore, giorni, modo)}`;
}

export function testoAtNonValido(ore: OreProponibili, giorni: GiorniLancio, modo: ModoPostPitch): string {
  return `Quell'ora non riesco a fissarla. ${testoSlots(ore, giorni, modo)}`;
}

export const TESTO_NESSUN_VENDITORE = 'Stasera i consulenti sono tutti occupati: fissiamo domani?';
export const TESTO_CHIAMATA_FUORI_ORARIO = 'A quest\'ora fissiamo direttamente la call.';
export const TESTO_ERRORE_CRM = 'Ho un problema tecnico a registrare la scelta in questo momento: riscrivimi tra qualche minuto e la fisso subito.';
export const TESTO_DOPO_SCELTA = 'Ricevuto, lo passo al consulente che ti chiama.';
export const TESTO_CONGEDO_POST_PITCH = 'Nessun problema, grazie per aver seguito la live! Se ci ripensi, scrivimi qui.';

/** Il testo precompilato del pulsante (spec §6.3): non è una risposta del lead. */
export const MARKER_PULSANTE_RE = /live web developer ai/i;
const MAX_RISPOSTE = 6;
const MAX_LUNGHEZZA_RISPOSTA = 300;

/** Le parole del lead nel post-pitch, accumulate: sono le "info" che vanno al venditore. */
export function raccogliRisposte(info: LancioInfo | null, nuoviInbound: string[]): LancioInfo {
  const pulite = nuoviInbound
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0 && !MARKER_PULSANTE_RE.test(s))
    .map((s) => s.slice(0, MAX_LUNGHEZZA_RISPOSTA));
  return { ...(info ?? {}), risposte: [...(info?.risposte ?? []), ...pulite].slice(0, MAX_RISPOSTE) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run lib/lancio-scelta.test.ts && bun run typecheck`
Expected: PASS. Se `etichettaGiorno` restituisce la maiuscola o un formato diverso su Node (ICU), adegua l'atteso al valore reale di `Intl` **solo** se resta "giorno della settimana + numero + mese" in italiano.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-scelta.ts lib/lancio-scelta.test.ts
git commit -m "feat(lancio): regole dure della scelta, tag, ore proponibili e testi fissi (modulo puro)"
```

---

### Task 6: I prompt delle fasi `link_inviato` e `post_pitch` e i tag della scelta — `lib/lancio-prompt.ts`, `lib/lancio-reply.ts` (B1, estesi)

**Files:**
- Modify: `lib/lancio-prompt.ts` (B1 Task 6: `buildLancioSystem` diventa uno `switch` sulla fase)
- Modify: `lib/lancio-reply.ts` (B1 Task 6: il risultato porta anche `lancioTag`)
- Test: `lib/lancio-prompt.test.ts`, `lib/lancio-reply.test.ts` (entrambi del B1: si aggiungono `describe`, si tocca UN `toEqual`)

**Interfaces:**
- Consumes: `parseLancioTag`, `stripLancioTags`, `type LancioTag`, `type ModoPostPitch` (Task 5); `parseLancioReply`, `type LancioReplyParsed` (B1 Task 5); `firstNameOf` (`lib/name.ts`); `formatRomeDateTime`, `romeNowContext` (`lib/rome-time.ts`); `getAnthropicClient`, `MARIO_MODEL`, `MEDIA_SENZA_TESTO`, `MarioTurn` (`lib/mario.ts`).
- Produces:
  ```ts
  export type LancioPromptInput = {
    fase: string | null; nome: string | null; eventoAt: string | null;
    /** Solo link_inviato: il link Zoom e l'ID riunione già estratto dal link (Task 2 `zoomMeetingId`). */
    zoomLink?: string | null; meetingId?: string | null;
    /** Solo post_pitch: notte/giorno (Task 5 `modoPostPitch`), quante risposte di riscaldamento
     *  sono già in `lancio_info`, il blocco ORE PRENOTABILI costruito dal codice (Task 5). */
    modo?: ModoPostPitch; risposteRaccolte?: number; bloccoSlot?: string | null;
  };
  export const DOMANDA_SCELTA_NOTTE = 'Preferisci che ti chiami un nostro consulente adesso, anche se è tardi, oppure fissiamo una call domani?';
  export const DOMANDA_SCELTA_GIORNO = 'Fissiamo una call oggi pomeriggio, oppure domani mattina?';
  export function buildLancioSystem(i: LancioPromptInput): string;   // switch su i.fase
  export type LancioReply = LancioReplyParsed & { lancioTag: LancioTag | null };
  export async function generateLancioReply(history: MarioTurn[], opts: LancioPromptInput & { now?: Date }): Promise<LancioReply>;
  ```
  La fase `attesa`/`posto_bloccato` produce ESATTAMENTE il prompt del B1 (i test del B1 restano verdi).

- [ ] **Step 1: Write the failing tests**

In coda a `lib/lancio-prompt.test.ts` (aggiungi `DOMANDA_SCELTA_NOTTE, DOMANDA_SCELTA_GIORNO` all'import):

```ts
describe('buildLancioSystem — fase link_inviato (assistenza al collegamento)', () => {
  const s = buildLancioSystem({ ...base, fase: 'link_inviato', zoomLink: 'https://us06web.zoom.us/j/89845223337', meetingId: '898 4522 3337' });

  it('dà l ID riunione così com è (i numeri del link) e dice che non serve nessun passcode', () => {
    expect(s).toContain('898 4522 3337');
    expect(s).toContain('https://us06web.zoom.us/j/89845223337');
    expect(s).toMatch(/NON serve nessun passcode/);
  });
  it('sa le tre mosse: ricliccare il link, app Zoom con l ID, browser', () => {
    expect(s).toMatch(/riclicc/i);
    expect(s).toMatch(/app Zoom/);
    expect(s).toMatch(/browser/);
  });
  it('zero pitch: niente call, prezzi, video, form, durata inventata', () => {
    expect(s).toMatch(/Non proporre MAI una chiamata, una call, un video, un modulo/);
    expect(s).toMatch(/prezzi non li dici MAI/);
    expect(s).not.toMatch(/jotform|noemi|un'ora e mezza/i);
  });
  it('tag: DOMANDA, NO e PASSAGGIO_UMANO; mai SI, CHIAMA_ORA, PRENOTA', () => {
    for (const t of ['[LANCIO:DOMANDA]', '[LANCIO:NO]', '[PASSAGGIO_UMANO]']) expect(s).toContain(t);
    for (const t of ['[LANCIO:SI]', '[LANCIO:CHIAMA_ORA]', '[LANCIO:PRENOTA']) expect(s).not.toContain(t);
  });
  it('senza meetingId non inventa un codice: rimanda ai numeri del link', () => {
    const s2 = buildLancioSystem({ ...base, fase: 'link_inviato', zoomLink: 'https://zoom.us/', meetingId: null });
    expect(s2).not.toContain('898 4522 3337');
    expect(s2).toMatch(/numeri che vede nel link/);
  });
});

describe('buildLancioSystem — fase post_pitch (riscaldamento e scelta)', () => {
  const BLOCCO = 'ORE PRENOTABILI (prova):\n- 2026-10-06T09:00:00+02:00 → martedì 6 ottobre alle 9:00 (domattina)';
  const pp = (over: Partial<Parameters<typeof buildLancioSystem>[0]>) =>
    buildLancioSystem({ ...base, fase: 'post_pitch', modo: 'notte', risposteRaccolte: 0, bloccoSlot: null, ...over });

  it('con 0 o 1 risposte fa UNA sola domanda di riscaldamento e non propone ancora la scelta', () => {
    const s = pp({ risposteRaccolte: 0 });
    expect(s).toContain('Risposte di riscaldamento già raccolte: 0 su 2');
    expect(s).toMatch(/Fai UNA sola domanda/);
    expect(s).toMatch(/cosa fa oggi/);
    expect(s).toMatch(/cosa l'ha colpita della live/);
    expect(s).not.toContain('Adesso è il momento della scelta');
    expect(pp({ risposteRaccolte: 1 })).toContain('1 su 2');
  });
  it('con 2 risposte pone la domanda della scelta, verbatim dalla spec §5.4', () => {
    const s = pp({ risposteRaccolte: 2 });
    expect(s).toContain('Adesso è il momento della scelta');
    expect(s).toContain(DOMANDA_SCELTA_NOTTE);
    expect(DOMANDA_SCELTA_NOTTE).toBe('Preferisci che ti chiami un nostro consulente adesso, anche se è tardi, oppure fissiamo una call domani?');
  });
  it('di notte esiste [LANCIO:CHIAMA_ORA]; di giorno no, e la domanda è quella diurna', () => {
    expect(pp({ risposteRaccolte: 2 })).toContain('[LANCIO:CHIAMA_ORA]');
    const g = pp({ risposteRaccolte: 2, modo: 'giorno' });
    expect(g).not.toContain('[LANCIO:CHIAMA_ORA]');
    expect(g).not.toContain('anche se è tardi');
    expect(g).toContain(DOMANDA_SCELTA_GIORNO);
    expect(g).toMatch(/Non offrire MAI "adesso"/);
  });
  it('il blocco degli slot entra così com è; senza blocco: [LANCIO:SLOTS] e mai un ora scritta', () => {
    expect(pp({ bloccoSlot: BLOCCO })).toContain(BLOCCO);
    const s = pp({ bloccoSlot: null });
    expect(s).toMatch(/Non hai ancora le ore/);
    expect(s).toContain('[LANCIO:SLOTS]');
    expect(s).not.toContain('ORE PRENOTABILI');
  });
  it('i tag della scelta + NO + DOMANDA + PASSAGGIO_UMANO; niente SI', () => {
    const s = pp({ risposteRaccolte: 2, bloccoSlot: BLOCCO });
    for (const t of ['[LANCIO:CHIAMA_ORA]', '[LANCIO:PRENOTA|', '[LANCIO:SLOTS]', '[LANCIO:NO]', '[LANCIO:DOMANDA]', '[PASSAGGIO_UMANO]']) expect(s).toContain(t);
    expect(s).not.toContain('[LANCIO:SI]');
  });
  it('il modello non scrive mai un ora né un nome: la conferma è del codice', () => {
    expect(pp({ risposteRaccolte: 2 })).toMatch(/non scrivere MAI tu un'ora, un giorno o il nome di chi chiama/);
  });
  it('prezzi mai, anche qui', () => {
    expect(pp({})).toMatch(/prezzi non li dici MAI/);
  });
  it('regressione B1: la fase attesa è quella di prima', () => {
    expect(buildLancioSystem(base)).toContain('[LANCIO:SI]');
    expect(buildLancioSystem(base)).not.toContain('[LANCIO:CHIAMA_ORA]');
    expect(buildLancioSystem(base)).not.toContain('ORE PRENOTABILI');
  });
});
```

In `lib/lancio-reply.test.ts`: nel primo test del B1 cambia l'atteso in
```ts
    expect(r).toEqual({ classe: 'domanda', passToHuman: false, visibleReply: 'È gratuita.', lancioTag: null });
```
e aggiungi in coda:

```ts
describe('generateLancioReply — i tag della scelta (B4)', () => {
  const opts = {
    fase: 'post_pitch', nome: 'Anna', eventoAt: '2026-10-05T21:00:00+02:00',
    modo: 'notte' as const, risposteRaccolte: 2, bloccoSlot: 'ORE PRENOTABILI (prova)',
  };

  it('[LANCIO:PRENOTA|iso] → lancioTag con l at, tag tolto dal testo, classe domanda', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Perfetto, alle 9! [LANCIO:PRENOTA|2026-10-06T09:00:00+02:00]' }] });
    const r = await generateLancioReply([{ role: 'user', content: 'alle 9' }], opts);
    expect(r.lancioTag).toEqual({ tag: 'PRENOTA', at: '2026-10-06T09:00:00+02:00' });
    expect(r.visibleReply).toBe('Perfetto, alle 9!');
    expect(r.classe).toBe('domanda');
  });

  it('[LANCIO:CHIAMA_ORA] e [lancio:slots] (anche minuscolo, e sparisce dal testo)', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ok [LANCIO:CHIAMA_ORA]' }] });
    expect((await generateLancioReply([{ role: 'user', content: 'adesso' }], opts)).lancioTag).toEqual({ tag: 'CHIAMA_ORA' });
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Vediamo le ore [lancio:slots]' }] });
    const r = await generateLancioReply([{ role: 'user', content: 'domani' }], opts);
    expect(r.lancioTag).toEqual({ tag: 'SLOTS' });
    expect(r.visibleReply).toBe('Vediamo le ore');
  });

  it('[LANCIO:NO] vale sia come classe no (B1) sia come tag NO (B4)', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Capisco. [LANCIO:NO]' }] });
    const r = await generateLancioReply([{ role: 'user', content: 'no grazie' }], opts);
    expect(r.classe).toBe('no');
    expect(r.lancioTag).toEqual({ tag: 'NO' });
    expect(r.visibleReply).toBe('Capisco.');
  });

  it('il system della fase post_pitch porta il blocco slot e non i tag di attesa', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok [LANCIO:DOMANDA]' }] });
    await generateLancioReply([{ role: 'user', content: 'ciao' }], opts);
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('ORE PRENOTABILI (prova)');
    expect(system).not.toContain('[LANCIO:SI]');
    expect(system).toMatch(/Adesso in Italia è/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run lib/lancio-prompt.test.ts lib/lancio-reply.test.ts`
Expected: FAIL — `DOMANDA_SCELTA_NOTTE` non esportata; in `link_inviato`/`post_pitch` `buildLancioSystem` produce il prompt di attesa; `lancioTag` è `undefined`.

- [ ] **Step 3: Riscrivi `lib/lancio-prompt.ts`**

Il ramo `attesa` è il testo del B1, spostato in `promptAttesa` senza cambiare una parola. Sostituisci il file per intero:

```ts
import { firstNameOf } from './name';
import { formatRomeDateTime } from './rome-time';
import type { ModoPostPitch } from './lancio-scelta';

/**
 * System prompt del lancio "Web Developer AI", SEPARATO da mario-prompt.ts (spec §5.2):
 * qui non esistono pitch, quote, call standard, video, form. Un prompt per fase:
 *  - attesa / posto_bloccato (B1): conferma dell'interesse e domande pratiche;
 *  - link_inviato (B4, spec §5.3): assistenza al collegamento, zero pitch;
 *  - post_pitch (B4, spec §5.4): due domande di riscaldamento e la scelta fra "adesso"
 *    e "una call", con le ore che gli passa il codice e mai scritte da lui.
 * Le frasi decisive (posto bloccato, congedo, conferme di chiamata e prenotazione) le
 * manda il codice, non il modello.
 */

export type LancioPromptInput = {
  fase: string | null;
  nome: string | null;
  eventoAt: string | null;
  /** Solo link_inviato: il link Zoom e l'ID riunione già letto dal link (`zoomMeetingId`). */
  zoomLink?: string | null;
  meetingId?: string | null;
  /** Solo post_pitch: notte/giorno (`modoPostPitch`), quante risposte di riscaldamento
   *  sono già in `lancio_info`, il blocco ORE PRENOTABILI costruito da `bloccoSlotPerPrompt`. */
  modo?: ModoPostPitch;
  risposteRaccolte?: number;
  bloccoSlot?: string | null;
};

/** La domanda della scelta, verbatim dalla spec §5.4 (di notte) e la sua versione diurna. */
export const DOMANDA_SCELTA_NOTTE =
  'Preferisci che ti chiami un nostro consulente adesso, anche se è tardi, oppure fissiamo una call domani?';
export const DOMANDA_SCELTA_GIORNO = 'Fissiamo una call oggi pomeriggio, oppure domani mattina?';

/** Quante risposte di riscaldamento prima della scelta (spec §5.4: "due domande"). */
export const RISPOSTE_RISCALDAMENTO = 2;

const QUANDO_DEFAULT = 'lunedì 5 ottobre alle 21:00';

function quandoLive(eventoAt: string | null): string {
  if (!eventoAt || Number.isNaN(Date.parse(eventoAt))) return QUANDO_DEFAULT;
  return formatRomeDateTime(eventoAt);
}

const IDENTITA = (conChi: string, contesto: string) =>
  `IDENTITÀ
Sei l'assistente virtuale di Fenice Academy (un'intelligenza artificiale: se te lo chiedono lo dici senza giri di parole). Scrivi su WhatsApp con ${conChi}, ${contesto}`;

const REGOLA_PREZZI =
  'la sera stessa presentiamo le opportunità dell\'accademia Fenice, ma i prezzi non li dici MAI, né cifre né fasce, nemmeno "circa".';

export function buildLancioSystem(i: LancioPromptInput): string {
  switch (i.fase) {
    case 'link_inviato':
      return promptAssistenza(i);
    case 'post_pitch':
      return promptPostPitch(i);
    default:
      return promptAttesa(i);
  }
}

/** Fase attesa / posto_bloccato: il prompt del B1, invariato. */
function promptAttesa(i: LancioPromptInput): string {
  const quando = quandoLive(i.eventoAt);
  const nome = firstNameOf(i.nome);
  const conChi = nome ? nome : 'una persona';
  const statoPosto =
    i.fase === 'posto_bloccato'
      ? 'Il lead ha GIÀ confermato: il suo posto è bloccato. Non chiederglielo di nuovo e non ripeterglielo se non te lo chiede.'
      : 'Il lead non ha ancora confermato di voler partecipare. Se dalla sua frase capisci che vuole esserci usa il tag [LANCIO:SI]; se capisci che non gli interessa usa [LANCIO:NO].';

  return `${IDENTITA(conChi, `che si è iscritta alla lista d'attesa della live "Web Developer AI" di Fenice Academy, che si tiene online su Zoom ${quando}.`)}

COSA DEVI FARE
Il tuo unico obiettivo adesso è confermare l'interesse per la live e rispondere alle domande pratiche. Nient'altro.
${statoPosto}

COSA SAI (e non una parola di più)
- La live è TOTALMENTE GRATUITA. Se chiedono se è a pagamento o quanto costa: l'evento è gratuito; ${REGOLA_PREZZI}
- Logistica: si tiene ${quando}, online su Zoom; il link per collegarsi arriva qui su WhatsApp il giorno stesso, poco prima dell'inizio. Basta un telefono o un computer con internet, non serve installare niente in anticipo.
- Fenice Academy è una scuola di formazione per le professioni digitali, con sede a Torino, attiva dal 2020.
- Su tutto il resto (contenuti, durata, sbocchi, docenti, iscrizione, garanzie, certificazioni, cosa succede dopo) rispondi che ne parliamo dopo la live: la live è fatta apposta per rispondere.

COME SCRIVI
- Una o due righe al massimo, tono cordiale e diretto, niente elenchi, niente emoji in serie.
- Non proporre MAI una chiamata, una call, un video, un modulo, un link o un appuntamento: prima della live non esiste nient'altro.
- Non inventare informazioni su Fenice Academy, sulla live o sui relatori.
- Se il lead chiede esplicitamente di parlare con una persona, rispondi in una riga che lo farai contattare e chiudi il messaggio con [PASSAGGIO_UMANO].

TAG TECNICI (il lead non li vede mai, vanno in fondo al messaggio)
- [LANCIO:SI] se la persona conferma che vuole partecipare (sì, ok, ci sono, interessato...).
- [LANCIO:NO] se dice che non le interessa, che vuole essere tolta dalla lista o che non vuole più messaggi.
- [LANCIO:DOMANDA] in tutti gli altri casi: hai risposto a una domanda o a un commento.
Esattamente UN tag [LANCIO:...] per messaggio, sempre. Quando usi [LANCIO:SI] o [LANCIO:NO] il testo che scrivi viene sostituito da una frase fissa: metti comunque una riga cortese, ma non promettere niente.`;
}

/** Fase link_inviato (spec §5.3): assistenza al collegamento, dall'invio del link a mezzanotte. */
function promptAssistenza(i: LancioPromptInput): string {
  const quando = quandoLive(i.eventoAt);
  const nome = firstNameOf(i.nome);
  const conChi = nome ? nome : 'una persona';
  const link = i.zoomLink?.trim() || null;
  const idRiunione = i.meetingId?.trim()
    ? `L'ID riunione è ${i.meetingId.trim()} (sono i numeri nel link).`
    : "L'ID riunione sono i numeri che vede nel link, subito dopo \"/j/\": non inventarne uno.";

  return `${IDENTITA(conChi, `che ha ricevuto poco fa, qui su WhatsApp, il link Zoom per la live "Web Developer AI" di Fenice Academy di ${quando}.`)}

COSA DEVI FARE
Solo assistenza per collegarsi alla live, in una o due righe. Nient'altro: niente presentazione del corso, niente proposte.

COSA SAI (e non una parola di più)
- Il link per collegarsi è ${link ? link : 'quello che ha appena ricevuto in questa chat'}: basta toccarlo.
- Se chiede il codice o l'ID della riunione: ${idRiunione} NON serve nessun passcode. Se Zoom glielo chiede, ha scritto male l'ID o sta usando un altro link: digli di ricliccare il link qui in chat.
- Se non riesce a collegarsi o "non si apre", tre mosse in quest'ordine: (1) ricliccare il link da questa chat; (2) se ha l'app Zoom, aprirla e inserire l'ID riunione; (3) altrimenti aprire il link nel browser e scegliere "partecipa dal browser". Serve solo internet, non serve un account Zoom.
- La live inizia ${quando}: conviene entrare qualche minuto prima; chi entra dopo trova la live già in corso. Sulla durata non fare promesse: di' che conviene tenersi libera la serata.
- Se non può esserci stasera o chiede la registrazione: non prometterla; di' che le scriviamo noi qui domani.
- La live è gratuita; ${REGOLA_PREZZI} Su contenuti, prezzi e cosa succede dopo: ne parliamo dopo la live.

COME SCRIVI
- Una o due righe, tono pratico e cordiale, niente elenchi, niente emoji in serie.
- Non proporre MAI una chiamata, una call, un video, un modulo, un altro link o un appuntamento: stasera esiste solo la live.
- Non inventare niente su Zoom, sulla live o sui relatori.
- Se il lead chiede esplicitamente di parlare con una persona, rispondi in una riga che lo farai contattare e chiudi con [PASSAGGIO_UMANO].

TAG TECNICI (il lead non li vede mai, vanno in fondo al messaggio)
- [LANCIO:NO] se dice che non vuole più messaggi o di essere tolto dalla lista.
- [LANCIO:DOMANDA] in tutti gli altri casi.
Esattamente UN tag [LANCIO:...] per messaggio, sempre.`;
}

/** Fase post_pitch (spec §5.4): riscaldamento, poi la scelta. Le ore le passa il codice. */
function promptPostPitch(i: LancioPromptInput): string {
  const quando = quandoLive(i.eventoAt);
  const nome = firstNameOf(i.nome);
  const conChi = nome ? nome : 'una persona';
  const modo: ModoPostPitch = i.modo ?? 'giorno';
  const n = Math.max(0, i.risposteRaccolte ?? 0);
  const blocco = i.bloccoSlot?.trim() || null;

  const doveSiamo =
    n < RISPOSTE_RISCALDAMENTO
      ? `Fai UNA sola domanda di riscaldamento, breve e naturale, e rispondi a quello che dice. Esempi: cosa fa oggi (studio, lavoro); cosa l'ha colpita della live. Una domanda alla volta, niente interrogatorio. Non proporre ancora la scelta, a meno che sia il lead a chiedere di essere chiamato o di fissare: in quel caso vai subito alla scelta.`
      : `Adesso è il momento della scelta. Se non l'hai ancora fatto, chiedi esattamente: "${modo === 'notte' ? DOMANDA_SCELTA_NOTTE : DOMANDA_SCELTA_GIORNO}". Poi leggi la risposta e usa il tag giusto.`;

  const regolaAdesso =
    modo === 'notte'
      ? '- "Adesso" (anche se è tardi): un consulente lo chiama fra pochi minuti → [LANCIO:CHIAMA_ORA].'
      : '- A quest\'ora non si chiama subito: si fissa una call. Non offrire MAI "adesso"; se lo chiede lui, digli che fissiamo l\'ora più vicina e usa [LANCIO:SLOTS].';

  const regolaOre = blocco
    ? '- "Una call" / "domani" / "oggi pomeriggio": serve un\'ora precisa, e le ore possibili sono SOLO quelle del blocco ORE PRENOTABILI qui sotto. Quando il lead ne sceglie una, copia la stringa ISO nel tag [LANCIO:PRENOTA|<ISO>]. Se dice "domani" senza un\'ora, o chiede quali ore ci sono, rispondi con [LANCIO:SLOTS] e basta: le ore le scrive il sistema, non tu.'
    : '- "Una call" / "domani" / "oggi pomeriggio": Non hai ancora le ore. Rispondi con [LANCIO:SLOTS] e basta: le ore le scrive il sistema. Non scrivere MAI tu un\'ora o un giorno.';

  return `${IDENTITA(conChi, `che ha appena seguito la live "Web Developer AI" di Fenice Academy (${quando}) e ha premuto il pulsante per saperne di più: è interessata al percorso.`)}

DOVE SIAMO
Risposte di riscaldamento già raccolte: ${n} su ${RISPOSTE_RISCALDAMENTO}.
${doveSiamo}

LA SCELTA (regole)
${regolaAdesso}
${regolaOre}
- Non vuole essere chiamato, non gli interessa, "ci penso" definitivo → [LANCIO:NO].
- Chiede esplicitamente di parlare con una persona → una riga cortese e [PASSAGGIO_UMANO].
- Tutto il resto (risposte al riscaldamento, domande sue, commenti) → [LANCIO:DOMANDA].
${blocco ? `\n${blocco}\n` : ''}
COSA SAI (e non una parola di più)
- La live era gratuita; il percorso "Web Developer AI" ha un costo, e ne parla il consulente nella call: ${REGOLA_PREZZI}
- Su contenuti, durata, sbocchi, garanzie, rate, certificazioni: "te lo spiega il consulente nella call", senza inventare.
- Fenice Academy è una scuola di formazione per le professioni digitali, con sede a Torino, attiva dal 2020.

COME SCRIVI
- Una o due righe, tono caldo e diretto, niente elenchi, niente emoji in serie.
- Non proporre MAI un video, un modulo, un link o un appuntamento diverso dalla call di cui sopra.
- Non inventare informazioni su Fenice Academy, sul percorso o sui consulenti.

TAG TECNICI (il lead non li vede mai, vanno in fondo al messaggio)
Esattamente UN tag per messaggio. Quando usi [LANCIO:CHIAMA_ORA], [LANCIO:PRENOTA|...] o [LANCIO:SLOTS] il testo che scrivi viene sostituito da una frase fissa: non scrivere MAI tu un'ora, un giorno o il nome di chi chiama.`;
}
```

- [ ] **Step 4: Estendi `lib/lancio-reply.ts`**

Sostituisci import, tipo di ritorno e la coda della funzione:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, MARIO_MODEL, MEDIA_SENZA_TESTO, type MarioTurn } from './mario';
import { buildLancioSystem, type LancioPromptInput } from './lancio-prompt';
import { parseLancioReply, type LancioReplyParsed } from './lancio-classifica';
import { parseLancioTag, stripLancioTags, type LancioTag } from './lancio-scelta';
import { romeNowContext } from './rome-time';

/** Il risultato del B1 più il tag della scelta (B4). `lancioTag` è null fuori dal post-pitch
 *  o quando il modello non ha scelto: chi chiama manda il testo e basta. */
export type LancioReply = LancioReplyParsed & { lancioTag: LancioTag | null };

/**
 * La risposta del modello nel flusso lancio. Stesso modello e stesso client di Mario,
 * prompt tutto suo per fase (`buildLancioSystem`). Le due regole sui turni vuoti sono le
 * stesse di `generateMarioReply` (un turno user vuoto rompe la richiesta con 400, un
 * turno assistant vuoto non ha nulla da dire).
 */
export async function generateLancioReply(
  history: MarioTurn[],
  opts: LancioPromptInput & { now?: Date },
): Promise<LancioReply> {
  const turni = history.flatMap((t) => {
    if (typeof t.content === 'string' && t.content.trim() !== '') return [t];
    if (t.role === 'user') return [{ role: 'user' as const, content: MEDIA_SENZA_TESTO }];
    return [];
  });
  const messages = turni.length > 0 ? turni : [{ role: 'user' as const, content: MEDIA_SENZA_TESTO }];
  const now = opts.now ?? new Date();
  const system = `${buildLancioSystem(opts)}\n\n${romeNowContext(now)}`;

  const response = await getAnthropicClient().messages.create({
    model: MARIO_MODEL,
    max_tokens: 400,
    thinking: { type: 'disabled' },
    system,
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
  // Il tag della scelta si legge dal testo grezzo PRIMA che `parseLancioReply` lo tolga
  // (il suo `ALTRI_TAG_RE` è case-sensitive: `stripLancioTags` copre anche `[lancio:slots]`).
  const parsed = parseLancioReply(raw);
  return { ...parsed, visibleReply: stripLancioTags(parsed.visibleReply), lancioTag: parseLancioTag(raw) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run lib/lancio-prompt.test.ts lib/lancio-reply.test.ts lib/lancio-turno.test.ts lib/lancio-classifica.test.ts && bun run typecheck`
Expected: PASS (i test del B1 restano verdi: il prompt di attesa è identico, `lancioTag` in più non rompe i `toMatchObject` del turno).

- [ ] **Step 6: Commit**

```bash
git add lib/lancio-prompt.ts lib/lancio-prompt.test.ts lib/lancio-reply.ts lib/lancio-reply.test.ts
git commit -m "feat(lancio): prompt di assistenza (link_inviato) e della scelta (post_pitch), tag [LANCIO:CHIAMA_ORA|PRENOTA|SLOTS] nel generatore"
```

---

### Task 7: Il turno di assistenza (`link_inviato`) — `lib/lancio-assistenza.ts`, con l'orologio forzabile e gli effetti condivisi

**Files:**
- Create: `lib/lancio-orologio.ts` — `adessoLancio()`
- Create: `lib/lancio-effetti.ts` — invio di una bolla, eventi, traccia `fenice_ai_reply`, congedo e passaggio umano condivisi fra i turni del B4 (il B1 li ha inline nel suo turno e non si tocca)
- Create: `lib/lancio-assistenza.ts` — `turnoAssistenza`
- Modify: `lib/lancio-turno.ts` (B1) — SOLO il tipo `TurnoLancioInput`: campi opzionali `lancioInfo`, `now`, `rows[].created_at` (lo `switch` arriva al Task 9)
- Test: `lib/lancio-orologio.test.ts`, `lib/lancio-assistenza.test.ts` (gli effetti si provano da qui)

**Interfaces:**
- Consumes: `puoRispondere` (Task 5); `zoomMeetingId` (Task 2); `generateLancioReply` (Task 6); `classificaLancio` (B1 Task 5); `impostaFaseLancio` (B1 Task 8); `TESTO_CONGEDO`, `TESTO_PASSAGGIO_UMANO` (B1 Task 4); `LancioSettings` (B1 Task 2); `sendFreeText` (`lib/twilio.ts`); `sendOutcome` (`lib/bot-outcome.ts`); `LancioInfo` (Task 4).
- Produces:
  ```ts
  // lib/lancio-orologio.ts
  export function adessoLancio(env?: NodeJS.ProcessEnv): Date;
  // lib/lancio-effetti.ts
  export const EVENTO_DEFAULT_ISO = '2026-10-05T21:00:00+02:00';
  export function eventoAtDa(settings: LancioSettings): Date;
  export type StatoTurno = 'active' | 'closed' | 'handed_off';
  export type ContestoTurno = { conversationId: number; phone: string; from: string; crmLeadId: string | null; fase: string | null };
  export function contestoDi(i: TurnoLancioInput): ContestoTurno;
  export function historyDi(rows: TurnoLancioInput['rows']): MarioTurn[];
  export async function inviaBollaLancio(supabase, c: ContestoTurno, body: string): Promise<void>;
  export async function eventoLancio(supabase, c: ContestoTurno, type: string, extra: Record<string, unknown>, message: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
  export async function tracciaTurnoLancio(supabase, c: ContestoTurno, azione: string, passToHuman?: boolean): Promise<void>;   // fenice_ai_reply { lancio: true }
  export async function silenzioLancio(supabase, c: ContestoTurno, motivo: string, definitivo: boolean): Promise<'active'>;   // definitivo ⇒ anche la traccia
  export async function congedoLancio(supabase, c: ContestoTurno, leadWords: string, nota: string): Promise<StatoTurno>;       // TESTO_CONGEDO, fase chiuso, DA_SCARTARE
  export async function passaggioUmanoLancio(supabase, c: ContestoTurno, testo: string, leadWords: string): Promise<'handed_off'>;
  // lib/lancio-assistenza.ts
  export async function turnoAssistenza(supabase, i: TurnoLancioInput, ctx: { settings: LancioSettings; now: Date }): Promise<StatoTurno>;
  // lib/lancio-turno.ts (tipo)
  export type TurnoLancioInput = { …del B1…; rows: { direction: string; body: string | null; template_sid: string | null; created_at?: string | null }[]; lancioInfo?: LancioInfo | null; now?: Date };
  ```

Regole del turno (spec §5.3 e brief del 14/09): risposta breve del modello dall'invio del link fino alle 23:59 di Roma del giorno dell'evento; un "no" netto è un congedo (fase `chiuso`, `DA_SCARTARE` "non interessato": così il follow-up del 6 non lo raggiunge); dopo mezzanotte silenzio **definitivo** tracciato (`lancio_silenzio` + `fenice_ai_reply`), perché il 6 risponde il follow-up del B5 e da lì Mario.

- [ ] **Step 1: Write the failing tests**

`lib/lancio-orologio.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { adessoLancio } from './lancio-orologio';

const FAKE = '2026-10-05T22:40:00+02:00';
const vicinoAdOra = (d: Date) => Math.abs(d.getTime() - Date.now()) < 5_000;

describe('adessoLancio — l orologio del turno', () => {
  it('senza LANCIO_FAKE_NOW è l ora vera', () => {
    expect(vicinoAdOra(adessoLancio({}))).toBe(true);
  });
  it('fuori produzione la finta vale', () => {
    expect(adessoLancio({ NODE_ENV: 'test', LANCIO_FAKE_NOW: FAKE }).toISOString()).toBe('2026-10-05T20:40:00.000Z');
  });
  it('in produzione la finta vale SOLO se armata col segreto del cron', () => {
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'production', LANCIO_FAKE_NOW: FAKE }))).toBe(true);
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'production', LANCIO_FAKE_NOW: FAKE, CRON_SECRET: 's', LANCIO_FAKE_NOW_ARMED: 'altro' }))).toBe(true);
    expect(adessoLancio({ NODE_ENV: 'production', LANCIO_FAKE_NOW: FAKE, CRON_SECRET: 's', LANCIO_FAKE_NOW_ARMED: 's' }).toISOString()).toBe('2026-10-05T20:40:00.000Z');
  });
  it('senza CRON_SECRET non c è niente con cui armarla', () => {
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'production', LANCIO_FAKE_NOW: FAKE, LANCIO_FAKE_NOW_ARMED: '' }))).toBe(true);
  });
  it('una finta illeggibile non ferma niente: ora vera', () => {
    expect(vicinoAdOra(adessoLancio({ NODE_ENV: 'test', LANCIO_FAKE_NOW: 'ieri sera' }))).toBe(true);
  });
});
```

`lib/lancio-assistenza.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_A', status: 'queued' })) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true })) }));
vi.mock('./lancio-db', () => ({ impostaFaseLancio: vi.fn(async () => undefined) }));

import { turnoAssistenza } from './lancio-assistenza';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { impostaFaseLancio } from './lancio-db';
import { TESTO_CONGEDO, TESTO_PASSAGGIO_UMANO } from './lancio-fase';
import type { LancioSettings } from './lancio-settings';

type Row = { direction: string; body: string | null; template_sid: string | null; created_at?: string | null };
const LINK: Row = { direction: 'out', body: 'Ciao Anna, ci siamo! ... https://us06web.zoom.us/j/89845223337', template_sid: 'HX_ZOOM', created_at: '2026-10-05T19:35:00+02:00' };
const inb = (body: string, at = '2026-10-05T21:30:00+02:00'): Row => ({ direction: 'in', body, template_sid: null, created_at: at });

function makeSupabase() {
  const calls = { convUpdates: [] as any[], events: [] as any[], messages: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return { update(p: any) { calls.convUpdates.push(p); const c: any = { eq: () => c, then: (r: any) => r({ data: null, error: null }) }; return c; } };
      }
      if (table === 'messages') return { insert(p: any) { calls.messages.push(p); return Promise.resolve({ data: null }); } };
      return { insert(p: any) { calls.events.push(p); return Promise.resolve({ data: null }); } };
    },
  };
  return { supabase, calls };
}

const SETTINGS: LancioSettings = { attivo: true, zoomLink: 'https://us06web.zoom.us/j/89845223337', videoLiveLink: null, offertaDelMeseLink: null, eventoAt: '2026-10-05T21:00:00+02:00' };
const NOTTE5 = new Date('2026-10-05T21:30:00+02:00');
const genera = vi.fn();
const base = (over: Record<string, unknown> = {}) => ({
  conversationId: 42, phone: '+393331234567', from: 'whatsapp:+390000000000', crmLeadId: 'crm-L1',
  fase: 'link_inviato', nome: 'Anna', rows: [LINK, inb('qual è il codice riunione?')], inboundBody: 'qual è il codice riunione?', genera, ...over,
}) as any;
const tipiEventi = (calls: { events: any[] }) => calls.events.map((e) => e.type);

beforeEach(() => { vi.clearAllMocks(); genera.mockReset(); });

describe('turnoAssistenza — nella finestra', () => {
  it('chiama il modello con la fase, il link e l ID riunione, manda UNA bolla, traccia il turno', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: "L'ID è 898 4522 3337, niente passcode.", lancioTag: null });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('active');
    expect(genera.mock.calls[0][0]).toEqual([{ role: 'assistant', content: LINK.body }, { role: 'user', content: 'qual è il codice riunione?' }]);
    expect(genera.mock.calls[0][1]).toMatchObject({ fase: 'link_inviato', nome: 'Anna', eventoAt: SETTINGS.eventoAt, zoomLink: SETTINGS.zoomLink, meetingId: '898 4522 3337', now: NOTTE5 });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0]).toMatchObject({ to: '+393331234567', from: 'whatsapp:+390000000000', body: "L'ID è 898 4522 3337, niente passcode." });
    expect(calls.messages[0]).toMatchObject({ conversation_id: 42, direction: 'out', sender: 'bot' });
    expect(calls.convUpdates.some((u) => 'last_message_at' in u)).toBe(true);
    expect(tipiEventi(calls)).toContain('lancio_assistenza');
    expect(calls.events.find((e) => e.type === 'fenice_ai_reply').payload).toMatchObject({ conversationId: 42, lancio: true, azione: 'assistenza' });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('senza link nelle impostazioni non inventa l ID: meetingId null', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Usa il link che hai ricevuto qui.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: { ...SETTINGS, zoomLink: null }, now: NOTTE5 });
    expect(genera.mock.calls[0][1]).toMatchObject({ zoomLink: null, meetingId: null });
  });

  it('alle 19:35, appena dopo il blast, risponde; alle 23:50 anche', async () => {
    genera.mockResolvedValue({ classe: 'domanda', passToHuman: false, visibleReply: 'Sì.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-05T19:35:00+02:00') });
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-05T23:50:00+02:00') });
    expect(sendFreeText).toHaveBeenCalledTimes(2);
  });

  it('un no netto: congedo fisso, fase chiuso, DA_SCARTARE "non interessato", closed, modello non chiamato', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('toglietemi dalla lista')], inboundBody: 'toglietemi dalla lista' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('closed');
    expect(genera).not.toHaveBeenCalled();
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'chiuso');
    expect(vi.mocked(sendOutcome).mock.calls[0].slice(1)).toEqual([42, expect.objectContaining({ outcome: 'DA_SCARTARE', discardReason: 'non interessato', leadWords: 'toglietemi dalla lista' })]);
    expect(tipiEventi(calls)).toContain('lancio_congedo');
  });

  it('il no lo può dire anche il modello con [LANCIO:NO]: stesso congedo', async () => {
    genera.mockResolvedValueOnce({ classe: 'no', passToHuman: false, visibleReply: 'Capisco.', lancioTag: { tag: 'NO' } });
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('lasciate perdere, ho cambiato idea')], inboundBody: 'lasciate perdere, ho cambiato idea' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('closed');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
  });

  it('CRM giù sul congedo: il testo è partito, la fase è chiuso, ma lo stato resta active (ritentabile)', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'http_500' });
    const { supabase } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('no')], inboundBody: 'no' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('active');
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });

  it('[PASSAGGIO_UMANO] → CONTATTO_UMANO con le parole del lead, handed_off_at, handed_off', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: true, visibleReply: '', lancioTag: null });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('voglio parlare con qualcuno')], inboundBody: 'voglio parlare con qualcuno' }), { settings: SETTINGS, now: NOTTE5 });
    expect(stato).toBe('handed_off');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_PASSAGGIO_UMANO);
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'CONTATTO_UMANO', note: 'voglio parlare con qualcuno' });
    expect(calls.convUpdates.some((u) => u.handed_off_at && u.handed_off_reason === 'voglio parlare con qualcuno')).toBe(true);
  });

  it('modello vuoto: silenzio risposta_vuota, tracciato, niente bolla', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: '', lancioTag: null });
    const { supabase, calls } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: NOTTE5 });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_silenzio').payload.motivo).toBe('risposta_vuota');
    expect(tipiEventi(calls)).toContain('fenice_ai_reply');
  });
});

describe('turnoAssistenza — dopo mezzanotte', () => {
  it('alle 00:10 del 6: nessun modello, nessuna bolla, silenzio DEFINITIVO tracciato (il 6 risponde il follow-up)', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoAssistenza(supabase, base({ rows: [LINK, inb('come rivedo la live?', '2026-10-06T00:10:00+02:00')], inboundBody: 'come rivedo la live?' }), { settings: SETTINGS, now: new Date('2026-10-06T00:10:00+02:00') });
    expect(stato).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_silenzio').payload.motivo).toBe('assistenza_finita');
    expect(tipiEventi(calls)).toContain('fenice_ai_reply');
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('alle 10:00 del 6 idem: la fase resta link_inviato per il cron del follow-up (B5)', async () => {
    const { supabase, calls } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: SETTINGS, now: new Date('2026-10-06T10:00:00+02:00') });
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_silenzio').payload.motivo).toBe('assistenza_finita');
  });

  it('senza eventoAt nelle impostazioni si usa il 5/10 alle 21', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Ok.', lancioTag: null });
    const { supabase } = makeSupabase();
    await turnoAssistenza(supabase, base(), { settings: { ...SETTINGS, eventoAt: null }, now: NOTTE5 });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run lib/lancio-orologio.test.ts lib/lancio-assistenza.test.ts`
Expected: FAIL — moduli assenti.

- [ ] **Step 3: `lib/lancio-orologio.ts`**

```ts
/**
 * L'ora "vera" di un turno del lancio. Tutte le regole di finestra (blast, assistenza,
 * post-pitch, ore proponibili) derivano da `lancio_evento_at` e da QUESTO istante: la
 * prova generale del B6 sposta l'orologio da qui, con `LANCIO_FAKE_NOW` (ISO con offset).
 *
 * In produzione la finta vale solo se `LANCIO_FAKE_NOW_ARMED` è uguale a `CRON_SECRET`:
 * una env dimenticata dopo una prova non può spostare l'ora a 3.000 lead la sera del 5.
 * Il cron del blast ha il suo `?now=` (già dietro l'auth del cron) e non passa da qui.
 */
export function adessoLancio(env: NodeJS.ProcessEnv = process.env): Date {
  const raw = env.LANCIO_FAKE_NOW?.trim();
  if (!raw) return new Date();
  const inProduzione = env.NODE_ENV === 'production';
  const armata = !!env.CRON_SECRET && env.LANCIO_FAKE_NOW_ARMED === env.CRON_SECRET;
  if (inProduzione && !armata) return new Date();
  const t = Date.parse(raw);
  return Number.isNaN(t) ? new Date() : new Date(t);
}
```

- [ ] **Step 4: Il tipo in `lib/lancio-turno.ts` (solo il tipo)**

In `TurnoLancioInput` del B1 cambia la riga di `rows` e aggiungi due campi (import `type LancioInfo` da `./lancio-crm`):

```ts
  rows: { direction: string; body: string | null; template_sid: string | null; created_at?: string | null }[];
  /** `conversations.lancio_info` letto dal claim: le risposte del post-pitch (B4). */
  lancioInfo?: LancioInfo | null;
  /** L'orologio del turno (B4): di default `adessoLancio()`. Iniettabile nei test. */
  now?: Date;
```

Nient'altro cambia qui fino al Task 9.

- [ ] **Step 5: `lib/lancio-effetti.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import type { MarioTurn } from './mario';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { impostaFaseLancio } from './lancio-db';
import { TESTO_CONGEDO, TESTO_PASSAGGIO_UMANO } from './lancio-fase';
import type { LancioSettings } from './lancio-settings';
import type { TurnoLancioInput } from './lancio-turno';

type Supa = ReturnType<typeof getSupabaseAdmin>;

// Gli effetti che i turni del B4 (assistenza, post-pitch, dopo la scelta) hanno in
// comune. Il turno del B1 (`eseguiTurnoLancio`, fasi attesa/posto_bloccato) ha le sue
// copie inline e non si tocca: qui si evita di scriverle una terza e una quarta volta.

/** L'evento se `lancio_evento_at` manca o è illeggibile: la data della spec. */
export const EVENTO_DEFAULT_ISO = '2026-10-05T21:00:00+02:00';

export function eventoAtDa(settings: LancioSettings): Date {
  const t = settings.eventoAt ? Date.parse(settings.eventoAt) : NaN;
  return new Date(Number.isNaN(t) ? Date.parse(EVENTO_DEFAULT_ISO) : t);
}

export type StatoTurno = 'active' | 'closed' | 'handed_off';
export type ContestoTurno = { conversationId: number; phone: string; from: string; crmLeadId: string | null; fase: string | null };

export function contestoDi(i: TurnoLancioInput): ContestoTurno {
  return { conversationId: i.conversationId, phone: i.phone, from: i.from, crmLeadId: i.crmLeadId, fase: i.fase };
}

export function historyDi(rows: TurnoLancioInput['rows']): MarioTurn[] {
  return rows.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body ?? '' }));
}

/** Una bolla sola, registrata in `messages` come le altre del bot. */
export async function inviaBollaLancio(supabase: Supa, c: ContestoTurno, body: string): Promise<void> {
  const sent = await sendFreeText({ to: c.phone, body, from: c.from });
  await supabase.from('messages').insert({
    conversation_id: c.conversationId, direction: 'out', body,
    twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
  });
  await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', c.conversationId);
}

export async function eventoLancio(
  supabase: Supa, c: ContestoTurno, type: string, extra: Record<string, unknown>, message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> {
  await supabase.from('event_log').insert({
    type, payload: { conversationId: c.conversationId, crmLeadId: c.crmLeadId, fase: c.fase, ...extra } as never, message, level,
  });
}

/**
 * La traccia che dice al re-drive di `bot-followups` "a questo inbound abbiamo già
 * risposto": senza, lo stesso turno ripartirebbe ogni ora (vedi `serveRedrive`).
 */
export async function tracciaTurnoLancio(supabase: Supa, c: ContestoTurno, azione: string, passToHuman = false): Promise<void> {
  await supabase.from('event_log').insert({
    type: 'fenice_ai_reply',
    payload: { conversationId: c.conversationId, phone: c.phone, lancio: true, fase: c.fase, azione, appointmentFixed: false, passToHuman } as never,
    message: `[lancio] turno su ${c.phone} (${c.fase}): ${azione}`,
    level: 'info',
  });
}

/**
 * Un turno senza risposta. `definitivo=true` scrive anche la traccia (nessuno risponderà
 * a questo inbound: dopo mezzanotte, dopo la scelta); `false` la omette apposta, così il
 * re-drive delle 08:30 fa rispondere (post-pitch fra le 03:00 e le 08:30).
 */
export async function silenzioLancio(supabase: Supa, c: ContestoTurno, motivo: string, definitivo: boolean): Promise<'active'> {
  await eventoLancio(supabase, c, 'lancio_silenzio', { motivo, definitivo }, `[lancio] conv ${c.conversationId}: nessuna risposta (${motivo})`);
  if (definitivo) await tracciaTurnoLancio(supabase, c, 'silenzio');
  return 'active';
}

/** Il no: testo fisso, fase `chiuso`, `DA_SCARTARE` al CRM. Come il congedo del B1. */
export async function congedoLancio(supabase: Supa, c: ContestoTurno, leadWords: string, nota: string): Promise<StatoTurno> {
  await inviaBollaLancio(supabase, c, TESTO_CONGEDO);
  await impostaFaseLancio(supabase, c.conversationId, 'chiuso');
  let stato: StatoTurno = 'closed';
  if (c.crmLeadId) {
    const esito = await sendOutcome(supabase, c.conversationId, { outcome: 'DA_SCARTARE', discardReason: 'non interessato', note: nota, leadWords });
    // CRM giù: il lead ha già letto il congedo e la fase è chiusa, ma lo stato resta
    // ritentabile — al prossimo inbound l'esito riparte.
    if (!(esito.sent || esito.error === 'note_duplicate')) stato = 'active';
  }
  await eventoLancio(supabase, c, 'lancio_congedo', { finalStatus: stato }, `[lancio] conv ${c.conversationId}: non interessato, congedato`);
  await tracciaTurnoLancio(supabase, c, 'congedo');
  return stato;
}

/** Ha chiesto una persona: `CONTATTO_UMANO` al CRM con le sue parole, chat a un umano. */
export async function passaggioUmanoLancio(supabase: Supa, c: ContestoTurno, testo: string, leadWords: string): Promise<'handed_off'> {
  await inviaBollaLancio(supabase, c, testo.trim() || TESTO_PASSAGGIO_UMANO);
  if (c.crmLeadId) {
    const esito = await sendOutcome(supabase, c.conversationId, { outcome: 'CONTATTO_UMANO', note: leadWords });
    if (!esito.sent) {
      await eventoLancio(supabase, c, 'contatto_umano_non_segnalato', { error: esito.error ?? null, status: esito.status ?? null },
        `[lancio] conv ${c.conversationId}: passaggio a una persona non segnalato al CRM`, 'warn');
    }
  }
  await supabase.from('conversations')
    .update({ handed_off_at: new Date().toISOString(), handed_off_reason: leadWords })
    .eq('id', c.conversationId);
  await tracciaTurnoLancio(supabase, c, 'passaggio_umano', true);
  return 'handed_off';
}
```

- [ ] **Step 6: `lib/lancio-assistenza.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import type { LancioSettings } from './lancio-settings';
import type { TurnoLancioInput } from './lancio-turno';
import { generateLancioReply } from './lancio-reply';
import { classificaLancio } from './lancio-classifica';
import { puoRispondere } from './lancio-scelta';
import { zoomMeetingId } from './lancio-zoom-blast';
import {
  contestoDi, historyDi, eventoAtDa, inviaBollaLancio, eventoLancio, tracciaTurnoLancio,
  silenzioLancio, congedoLancio, passaggioUmanoLancio, type StatoTurno,
} from './lancio-effetti';

type Supa = ReturnType<typeof getSupabaseAdmin>;

const NOTA_CONGEDO = 'Lancio Web Dev AI: ha ricevuto il link Zoom e ha detto di non essere interessato.';

/**
 * Fase `link_inviato` (spec §5.3): dal blast del link alle 23:59 del giorno dell'evento
 * il bot fa solo assistenza al collegamento — una bolla breve del modello, col prompt di
 * assistenza (ID riunione = i numeri nel link, niente passcode, app/browser/riclicca).
 * Zero pitch: la live è fatta per quello.
 *
 * Dopo mezzanotte la fase resta `link_inviato` (il cron del follow-up del B5 la cerca
 * così) ma qui non si risponde più: silenzio definitivo, tracciato, perché il 6 arriva
 * il follow-up e da lì risponde Mario. Un "no" netto è un congedo anche qui, così il
 * follow-up non raggiunge chi si è appena tirato fuori.
 */
export async function turnoAssistenza(
  supabase: Supa,
  i: TurnoLancioInput,
  ctx: { settings: LancioSettings; now: Date },
): Promise<StatoTurno> {
  const genera = i.genera ?? generateLancioReply;
  const c = contestoDi(i);
  const eventoAt = eventoAtDa(ctx.settings);

  if (!puoRispondere(ctx.now, eventoAt, 'link_inviato')) {
    return silenzioLancio(supabase, c, 'assistenza_finita', true);
  }
  if (classificaLancio(i.inboundBody) === 'no') {
    return congedoLancio(supabase, c, i.inboundBody, NOTA_CONGEDO);
  }

  const zoomLink = ctx.settings.zoomLink;
  const r = await genera(historyDi(i.rows), {
    fase: 'link_inviato', nome: i.nome, eventoAt: ctx.settings.eventoAt, now: ctx.now,
    zoomLink, meetingId: zoomLink ? zoomMeetingId(zoomLink) : null,
  });
  if (r.passToHuman) return passaggioUmanoLancio(supabase, c, r.visibleReply, i.inboundBody);
  if (r.classe === 'no') return congedoLancio(supabase, c, i.inboundBody, NOTA_CONGEDO);

  const testo = r.visibleReply.trim();
  if (!testo) return silenzioLancio(supabase, c, 'risposta_vuota', true);
  await inviaBollaLancio(supabase, c, testo);
  await eventoLancio(supabase, c, 'lancio_assistenza', {}, `[lancio] conv ${c.conversationId}: assistenza al collegamento`);
  await tracciaTurnoLancio(supabase, c, 'assistenza');
  return 'active';
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bunx vitest run lib/lancio-orologio.test.ts lib/lancio-assistenza.test.ts lib/lancio-turno.test.ts && bun run typecheck`
Expected: PASS. Se `typecheck` segnala un ciclo di tipi fra `lancio-effetti.ts` e `lancio-turno.ts`: è un import `type`-only, si cancella alla compilazione, non è un ciclo a runtime.

- [ ] **Step 8: Commit**

```bash
git add lib/lancio-orologio.ts lib/lancio-orologio.test.ts lib/lancio-effetti.ts lib/lancio-assistenza.ts lib/lancio-assistenza.test.ts lib/lancio-turno.ts
git commit -m "feat(lancio): turno di assistenza dopo il link Zoom (fino a mezzanotte), effetti condivisi e orologio forzabile"
```

---

### Task 8: Il turno della scelta (`post_pitch`) e il turno dopo la scelta (`scelta_fatta`) — `lib/lancio-post-pitch.ts`

**Files:**
- Create: `lib/lancio-post-pitch.ts`
- Test: `lib/lancio-post-pitch.test.ts`

**Interfaces:**
- Consumes: `lancioSlots`, `lancioBook`, `lancioCallNow`, `LancioInfo` (Task 4); tutto `lib/lancio-scelta.ts` (Task 5); `generateLancioReply` (Task 6); `RISPOSTE_RISCALDAMENTO` (Task 6); gli effetti di `lib/lancio-effetti.ts` (Task 7); `impostaFaseLancio` (B1 Task 8); `sendOutcome`, `sendCrmNota` (`lib/bot-outcome.ts`); `pushLeadEntrante` (B2, `lib/lead-entrante.ts`); `type Json` (`lib/supabase/types.ts`).
- Produces:
  ```ts
  export async function turnoPostPitch(supabase, i: TurnoLancioInput, ctx: { settings: LancioSettings; now: Date }): Promise<StatoTurno>;
  export async function turnoDopoScelta(supabase, i: TurnoLancioInput): Promise<StatoTurno>;
  export const NOTA_SCELTA = 'Lancio Web Dev AI: ha premuto il pulsante dopo la live.';
  export const PROVENIENZA_LANCIO = 'Lancio Web Dev AI';
  ```
  Eventi: `lancio_post_pitch_domanda`, `lancio_slots_mostrati`, `lancio_slots_non_letti` (warn), `lancio_slots_vuoti` (warn), `lancio_at_non_valido`, `lancio_scelta` (`tipo: 'chiama_ora' | 'prenota'`), `lancio_crm_errore` (error), `lancio_lead_senza_crm` (error), `lancio_congedo`, `lancio_dopo_scelta`, `lancio_silenzio`, `fenice_ai_reply` (`lancio: true`).

Regole del turno (spec §5.4, "regole dure nel codice"):
- **Finestra:** `puoRispondere(now, eventoAt, 'post_pitch')` falso ⇒ silenzio **temporaneo** (senza `fenice_ai_reply`: il re-drive delle 08:30 fa rispondere). `modo = modoPostPitch(now, eventoAt)`: di giorno `[LANCIO:CHIAMA_ORA]` non si esegue mai (si risponde con `TESTO_CHIAMATA_FUORI_ORARIO` + le ore), le ore proposte sono quelle di `oreProponibili` (che di giorno tiene la mattina del 6 solo se `at ≥ now+1h`) e `testoSlots` in modo `giorno` non la nomina.
- **`lancio_info`:** a ogni turno `raccogliRisposte(lancioInfo, [inboundBody])` (il marker del pulsante non entra); si salva su `conversations.lancio_info` (update diretto: la fase non cambia, `impostaFaseLancio` serve solo ai cambi di fase) e viaggia in `info: { risposte }` su `book` e `call-now`.
- **Ore:** si chiedono al CRM (`lancioSlots(giornoDopo)`) solo in fase di scelta (`risposte ≥ 2` o slot già mostrati) e quando un tag le richiede — una chiamata di rete al massimo per turno, dentro il drain il lead aspetta. CRM giù ⇒ `oreProponibili(null)` (pomeriggio e dopodomani restano) + `lancio_slots_non_letti`.
- **Tag:** `CHIAMA_ORA` → `lancioCallNow`; `PRENOTA|iso` → `validaAtLancio` poi `lancioBook`; `SLOTS` → `testoSlots`; `NO` → congedo post-pitch (`TESTO_CONGEDO_POST_PITCH`, fase `chiuso` con `lancio_info`, `DA_SCARTARE` "non interessato"); nessun tag → la risposta del modello (riscaldamento).
- **Esiti CRM:** `200` → conferma con testo fisso (`testoConfermaChiamata` / `testoConfermaPrenotazione`), `impostaFaseLancio(…, 'scelta_fatta', { lancio_info })`, `lancio_scelta`, stato `closed`; `409 ora_esaurita` → `testoOraEsaurita(hour, oreProponibili(slots aggiornati))`; `409 nessun_venditore` → `TESTO_NESSUN_VENDITORE` + `testoSlots` (propone domani); `422 fuori_regole` e `at` non valido → `testoAtNonValido` (chiede un'altra ora); `403`/`http`/`rete`/`not_configured` → `TESTO_ERRORE_CRM` + `lancio_crm_errore`, stato `active`.
- **`crm_lead_id` null:** prima di `book`/`call-now` si rilegge `conversations.crm_lead_id`; se è ancora null si richiama `pushLeadEntrante` (idempotente lato CRM: dedup per numero) con `provenienza='Lancio Web Dev AI'`, il primo inbound e il suo `created_at`; se non torna un `leadId` ⇒ `TESTO_ERRORE_CRM` + `lancio_lead_senza_crm`, nessuna scelta registrata.
- **Dopo la scelta** (fase `scelta_fatta`, stato `closed` riaperto dal webhook): al primo messaggio `TESTO_DOPO_SCELTA`, ai successivi silenzio definitivo; in ogni caso le parole del lead vanno al CRM come nota (`sendCrmNota`) perché le legga chi lo chiama.

- [ ] **Step 1: Write the failing tests**

`lib/lancio-post-pitch.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_P', status: 'queued' })) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true })), sendCrmNota: vi.fn(async () => ({ sent: true })) }));
vi.mock('./lancio-db', () => ({ impostaFaseLancio: vi.fn(async () => undefined) }));
vi.mock('./lancio-crm', () => ({ lancioSlots: vi.fn(), lancioBook: vi.fn(), lancioCallNow: vi.fn() }));
vi.mock('./lead-entrante', () => ({ pushLeadEntrante: vi.fn(async () => ({ ok: true, leadId: 'crm-NEW' })) }));

import { turnoPostPitch, turnoDopoScelta, NOTA_SCELTA } from './lancio-post-pitch';
import { sendFreeText } from './twilio';
import { sendOutcome, sendCrmNota } from './bot-outcome';
import { impostaFaseLancio } from './lancio-db';
import { lancioSlots, lancioBook, lancioCallNow, type LancioSlots } from './lancio-crm';
import { pushLeadEntrante } from './lead-entrante';
import {
  TESTO_NESSUN_VENDITORE, TESTO_CHIAMATA_FUORI_ORARIO, TESTO_ERRORE_CRM, TESTO_DOPO_SCELTA, TESTO_CONGEDO_POST_PITCH,
} from './lancio-scelta';
import type { LancioSettings } from './lancio-settings';

type Row = { direction: string; body: string | null; template_sid: string | null; created_at?: string | null };
const MARKER = 'Ho seguito la live Web Developer AI e voglio saperne di più 🚀';
const LINK: Row = { direction: 'out', body: 'Ciao Anna, ci siamo! https://us06web.zoom.us/j/89845223337', template_sid: 'HX_ZOOM', created_at: '2026-10-05T19:35:00+02:00' };
const PULSANTE: Row = { direction: 'in', body: MARKER, template_sid: null, created_at: '2026-10-05T22:38:00+02:00' };
const inb = (body: string, at = '2026-10-05T22:40:00+02:00'): Row => ({ direction: 'in', body, template_sid: null, created_at: at });
const out = (body: string): Row => ({ direction: 'out', body, template_sid: null, created_at: '2026-10-05T22:39:00+02:00' });

function makeSupabase(crmLeadIdDb: string | null = 'crm-L1') {
  const calls = { convUpdates: [] as any[], events: [] as any[], messages: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          update(p: any) { calls.convUpdates.push(p); const c: any = { eq: () => c, then: (r: any) => r({ data: null, error: null }) }; return c; },
          select() { const c: any = { eq: () => c, maybeSingle: async () => ({ data: { crm_lead_id: crmLeadIdDb } }) }; return c; },
        };
      }
      if (table === 'messages') return { insert(p: any) { calls.messages.push(p); return Promise.resolve({ data: null }); } };
      return { insert(p: any) { calls.events.push(p); return Promise.resolve({ data: null }); } };
    },
  };
  return { supabase, calls };
}

const SETTINGS: LancioSettings = { attivo: true, zoomLink: 'https://us06web.zoom.us/j/89845223337', videoLiveLink: null, offertaDelMeseLink: null, eventoAt: '2026-10-05T21:00:00+02:00' };
const NOTTE = new Date('2026-10-05T22:40:00+02:00');
const GIORNO6 = new Date('2026-10-06T10:00:00+02:00');
const SLOTS: LancioSlots = { date: '2026-10-06', mattina: [{ hour: 9, liberi: 1 }, { hour: 11, liberi: 2 }, { hour: 14, liberi: 1 }], pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] }, mattinaEsaurita: false };
const SLOT_TEXT_NOTTE = 'Per la call ho libero domattina alle 9, alle 11 o alle 14, oppure domani pomeriggio dalle 15 alle 20: che ora preferisci?';

const genera = vi.fn();
const modello = (over: Record<string, unknown>) => ({ classe: 'domanda', passToHuman: false, visibleReply: 'ok', lancioTag: null, ...over });
const base = (over: Record<string, unknown> = {}) => ({
  conversationId: 42, phone: '+393331234567', from: 'whatsapp:+390000000000', crmLeadId: 'crm-L1',
  fase: 'post_pitch', nome: 'Anna', rows: [LINK, PULSANTE], inboundBody: MARKER, lancioInfo: null, genera, ...over,
}) as any;
/** Una chat già riscaldata: due risposte in lancio_info, il lead ha appena risposto alla scelta. */
const scelta = (inbound: string, over: Record<string, unknown> = {}) => base({
  rows: [LINK, PULSANTE, out('Ciao Anna! Cosa fai oggi?'), inb('studio informatica'), out('E cosa ti ha colpito?'), inb('il progetto finale'), out('Preferisci adesso o domani?'), inb(inbound)],
  inboundBody: inbound, lancioInfo: { risposte: ['studio informatica', 'il progetto finale'] }, ...over,
});
const bolle = () => vi.mocked(sendFreeText).mock.calls.map((c) => c[0].body);
const eventi = (calls: { events: any[] }, type: string) => calls.events.filter((e) => e.type === type);
const ctx = (now: Date = NOTTE) => ({ settings: SETTINGS, now });

beforeEach(() => {
  vi.clearAllMocks();
  genera.mockReset();
  vi.mocked(lancioSlots).mockResolvedValue({ ok: true, slots: SLOTS });
  vi.mocked(lancioBook).mockReset();
  vi.mocked(lancioCallNow).mockReset();
  vi.mocked(pushLeadEntrante).mockResolvedValue({ ok: true, leadId: 'crm-NEW' });
  vi.mocked(sendOutcome).mockResolvedValue({ sent: true });
});

describe('turnoPostPitch — riscaldamento', () => {
  it('primo turno (il pulsante): niente slot, modello con 0 risposte in modo notte, UNA bolla, lancio_info senza il marker', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Ciao Anna! Cosa fai oggi nella vita?' }));
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, base(), ctx());
    expect(stato).toBe('active');
    expect(lancioSlots).not.toHaveBeenCalled();
    expect(genera.mock.calls[0][1]).toMatchObject({ fase: 'post_pitch', nome: 'Anna', modo: 'notte', risposteRaccolte: 0, bloccoSlot: null, now: NOTTE });
    expect(bolle()).toEqual(['Ciao Anna! Cosa fai oggi nella vita?']);
    expect(calls.convUpdates.find((u) => 'lancio_info' in u).lancio_info).toEqual({ risposte: [] });
    expect(eventi(calls, 'lancio_post_pitch_domanda')).toHaveLength(1);
    expect(eventi(calls, 'fenice_ai_reply')[0].payload).toMatchObject({ lancio: true, azione: 'post_pitch' });
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('alla seconda risposta le ore entrano nel prompt: slot chiesti al CRM per il giorno dopo, blocco con le ISO', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Preferisci adesso o domani?' }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, base({ rows: [LINK, PULSANTE, out('Cosa fai oggi?'), inb('studio informatica'), out('E cosa ti ha colpito?'), inb('il progetto finale')], inboundBody: 'il progetto finale', lancioInfo: { risposte: ['studio informatica'] } }), ctx());
    expect(lancioSlots).toHaveBeenCalledWith('2026-10-06');
    const opts = genera.mock.calls[0][1];
    expect(opts.risposteRaccolte).toBe(2);
    expect(opts.bloccoSlot).toContain('2026-10-06T09:00:00+02:00');
    expect(opts.bloccoSlot).toContain('2026-10-07T14:00:00+02:00');
    expect(calls.convUpdates.find((u) => 'lancio_info' in u).lancio_info).toEqual({ risposte: ['studio informatica', 'il progetto finale'] });
  });

  it('[PASSAGGIO_UMANO] → handed_off, con le risposte salvate', async () => {
    genera.mockResolvedValueOnce(modello({ passToHuman: true, visibleReply: 'Certo, ti faccio contattare.' }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, base({ inboundBody: 'voglio parlare con una persona', rows: [LINK, PULSANTE, inb('voglio parlare con una persona')] }), ctx())).toBe('handed_off');
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'CONTATTO_UMANO' });
    expect(calls.convUpdates.find((u) => 'lancio_info' in u).lancio_info).toEqual({ risposte: ['voglio parlare con una persona'] });
  });
});

describe('turnoPostPitch — [LANCIO:CHIAMA_ORA]', () => {
  it('di notte: call-now con leadId, info e nota; conferma fissa col nome; scelta_fatta con lancio_info; closed', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Perfetto!', lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, scelta('adesso'), ctx());
    expect(stato).toBe('closed');
    expect(lancioCallNow).toHaveBeenCalledWith({ leadId: 'crm-L1', info: { risposte: ['studio informatica', 'il progetto finale', 'adesso'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual(['Perfetto, ti chiama Luca tra pochissimo.']);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'scelta_fatta', { lancio_info: { risposte: ['studio informatica', 'il progetto finale', 'adesso'] } });
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'chiama_ora', venditore: { id: 'u7', nome: 'Luca' } });
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(1);
  });

  it('di giorno (dopo le 03:00) non si chiama: testo fisso + le ore, slot segnati come mostrati, active', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    const { supabase, calls } = makeSupabase();
    const stato = await turnoPostPitch(supabase, scelta('chiamami adesso'), ctx(GIORNO6));
    expect(stato).toBe('active');
    expect(lancioCallNow).not.toHaveBeenCalled();
    expect(bolle()[0]).toMatch(new RegExp(`^${TESTO_CHIAMATA_FUORI_ORARIO} Per la call ho oggi pomeriggio dalle 15 alle 20`));
    expect(bolle()[0]).not.toMatch(/alle 11/);
    expect(calls.convUpdates.find((u) => 'lancio_info' in u).lancio_info.slotsMostratiAt).toBe(GIORNO6.toISOString());
    expect(eventi(calls, 'lancio_slots_mostrati')).toHaveLength(1);
  });

  it('409 nessun_venditore: "tutti occupati, fissiamo domani?" + le ore, active', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, kind: 'nessun_venditore' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('adesso'), ctx())).toBe('active');
    expect(bolle()).toEqual([`${TESTO_NESSUN_VENDITORE} ${SLOT_TEXT_NOTTE}`]);
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('CRM in errore (rete/http): testo di errore, evento error, active, niente fase', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: false, kind: 'rete', error: 'ECONNRESET' });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('adesso'), ctx())).toBe('active');
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
    expect(eventi(calls, 'lancio_crm_errore')[0].level).toBe('error');
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });
});

describe('turnoPostPitch — [LANCIO:PRENOTA|iso]', () => {
  const AT9 = '2026-10-06T09:00:00+02:00';
  const prenota = (at: string) => modello({ lancioTag: { tag: 'PRENOTA', at } });

  it('ora valida: book con leadId, at, info e nota; conferma fissa con giorno, ora e venditore; scelta_fatta; closed', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'mattina', venditore: { id: 'u7', nome: 'Luca' } });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('domattina alle 9'), ctx())).toBe('closed');
    expect(lancioBook).toHaveBeenCalledWith({ leadId: 'crm-L1', at: AT9, info: { risposte: ['studio informatica', 'il progetto finale', 'domattina alle 9'] }, note: NOTA_SCELTA });
    expect(bolle()).toEqual(['Perfetto, ci sentiamo martedì 6 ottobre alle 9:00: ti chiama Luca. Tieni il telefono a portata di mano.']);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'scelta_fatta', expect.objectContaining({ lancio_info: expect.anything() }));
    expect(eventi(calls, 'lancio_scelta')[0].payload).toMatchObject({ tipo: 'prenota', at: AT9, kind: 'mattina' });
  });

  it('pomeriggio senza venditore: "un nostro consulente"', async () => {
    genera.mockResolvedValueOnce(prenota('2026-10-06T17:00:00+02:00'));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: true, kind: 'pomeriggio' });
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('alle 17'), ctx());
    expect(bolle()).toEqual(['Perfetto, ci sentiamo martedì 6 ottobre alle 17:00: ti chiama un nostro consulente. Tieni il telefono a portata di mano.']);
  });

  it('409 ora_esaurita: ripropone dagli slot AGGIORNATI del CRM, non da quelli letti prima', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, kind: 'ora_esaurita', slots: { date: '2026-10-06', mattina: [{ hour: 11, liberi: 1 }], pomeriggio: { aperto: true, ore: [15, 16, 17, 18, 19, 20] }, mattinaEsaurita: false } });
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('alle 9'), ctx())).toBe('active');
    expect(bolle()).toEqual(['Le 9 si sono appena riempite. Per la call ho libero domattina alle 11, oppure domani pomeriggio dalle 15 alle 20: che ora preferisci?']);
    expect(calls.convUpdates.find((u) => 'lancio_info' in u).lancio_info.slotsMostratiAt).toBe(NOTTE.toISOString());
    expect(impostaFaseLancio).not.toHaveBeenCalled();
  });

  it('409 nessun_venditore su book: propone domani con le ore', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, kind: 'nessun_venditore' });
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, scelta('alle 9'), ctx());
    expect(bolle()).toEqual([`${TESTO_NESSUN_VENDITORE} ${SLOT_TEXT_NOTTE}`]);
  });

  it('422 fuori_regole: chiede un altra ora con le ore', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, kind: 'fuori_regole' });
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('alle 9'), ctx());
    expect(bolle()).toEqual([`Quell'ora non riesco a fissarla. ${SLOT_TEXT_NOTTE}`]);
    expect(eventi(calls, 'lancio_at_non_valido')[0].payload).toMatchObject({ motivo: 'crm_fuori_regole' });
  });

  it('at fuori dalle regole dure (ora non tonda, giorno sbagliato, troppo vicino): niente book, si chiede un altra ora', async () => {
    const { supabase, calls } = makeSupabase();
    for (const at of ['2026-10-06T09:30:00+02:00', '2026-10-08T10:00:00+02:00', '2026-10-05T23:00:00+02:00']) {
      genera.mockResolvedValueOnce(prenota(at));
      await turnoPostPitch(supabase, scelta('boh'), ctx());
    }
    expect(lancioBook).not.toHaveBeenCalled();
    expect(bolle()).toHaveLength(3);
    for (const b of bolle()) expect(b).toMatch(/^Quell'ora non riesco a fissarla\. Per la call ho libero domattina/);
    expect(eventi(calls, 'lancio_at_non_valido').map((e) => e.payload.motivo)).toEqual(['ora_non_tonda', 'giorno_non_ammesso', 'giorno_non_ammesso']);
  });

  it('di giorno alle 10:00 le 9 sono andate (troppo vicino) e il testo non nomina la mattina', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('alle 9'), ctx(GIORNO6));
    expect(lancioBook).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_at_non_valido')[0].payload.motivo).toBe('troppo_vicino');
    expect(bolle()[0]).toContain('oggi pomeriggio dalle 15 alle 20');
    expect(bolle()[0]).not.toMatch(/alle 11/);
  });

  it('500 dal CRM: testo di errore, active', async () => {
    genera.mockResolvedValueOnce(prenota(AT9));
    vi.mocked(lancioBook).mockResolvedValueOnce({ ok: false, kind: 'http', status: 500, body: 'boom' });
    const { supabase } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('alle 9'), ctx())).toBe('active');
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
  });
});

describe('turnoPostPitch — [LANCIO:SLOTS], [LANCIO:NO], finestra', () => {
  it('SLOTS: le ore scritte dal codice, slotsMostratiAt salvato, evento', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: 'Vediamo le ore', lancioTag: { tag: 'SLOTS' } }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('domani'), ctx())).toBe('active');
    expect(bolle()).toEqual([SLOT_TEXT_NOTTE]);
    expect(calls.convUpdates.find((u) => 'lancio_info' in u).lancio_info).toEqual({ risposte: ['studio informatica', 'il progetto finale', 'domani'], slotsMostratiAt: NOTTE.toISOString() });
    expect(eventi(calls, 'lancio_slots_mostrati')[0].payload).toMatchObject({ mattina: [9, 11, 14], pomeriggio: [15, 16, 17, 18, 19, 20] });
  });

  it('SLOTS con il CRM giù: pomeriggio e dopodomani restano, mattina no, evento warn', async () => {
    vi.mocked(lancioSlots).mockResolvedValue({ ok: false, kind: 'rete', error: 'timeout' });
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('domani'), ctx());
    expect(bolle()[0]).toContain('Domattina è tutto pieno');
    expect(bolle()[0]).toContain('domani pomeriggio dalle 15 alle 20');
    expect(eventi(calls, 'lancio_slots_non_letti')[0].level).toBe('warn');
  });

  it('SLOTS alle 19:30 del 6 senza ore per oggi: propone solo il 7; nessuna ora in assoluto ⇒ nota al CRM', async () => {
    genera.mockResolvedValue(modello({ lancioTag: { tag: 'SLOTS' } }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, scelta('domani'), ctx(new Date('2026-10-06T19:30:00+02:00')));
    expect(bolle()[0]).toContain('Per oggi non ho più ore libere. Ho domani dalle 9 alle 14');
    expect(sendCrmNota).not.toHaveBeenCalled();
    await turnoPostPitch(supabase, scelta('domani'), ctx(new Date('2026-10-07T13:30:00+02:00')));
    expect(bolle()[1]).toMatch(/^Per questi due giorni non ho più ore libere/);
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(eventi(calls, 'lancio_slots_vuoti')).toHaveLength(1);
  });

  it('NO: congedo post-pitch, fase chiuso con lancio_info, DA_SCARTARE "non interessato", closed', async () => {
    genera.mockResolvedValueOnce(modello({ classe: 'no', visibleReply: 'Capisco.', lancioTag: { tag: 'NO' } }));
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('no, non mi interessa'), ctx())).toBe('closed');
    expect(bolle()).toEqual([TESTO_CONGEDO_POST_PITCH]);
    expect(impostaFaseLancio).toHaveBeenCalledWith(expect.anything(), 42, 'chiuso', { lancio_info: { risposte: ['studio informatica', 'il progetto finale', 'no, non mi interessa'] } });
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'DA_SCARTARE', discardReason: 'non interessato', leadWords: 'no, non mi interessa' });
    expect(eventi(calls, 'lancio_congedo')).toHaveLength(1);
  });

  it('fra le 03:00 e le 08:30 del 6: silenzio TEMPORANEO senza fenice_ai_reply (il re-drive delle 08:30 risponde)', async () => {
    const { supabase, calls } = makeSupabase();
    expect(await turnoPostPitch(supabase, scelta('ci sei?'), ctx(new Date('2026-10-06T05:00:00+02:00')))).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'fuori_orario', definitivo: false });
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(0);
  });

  it('alle 02:59 del 6 si risponde ancora (notte); alle 09:00 anche (giorno)', async () => {
    genera.mockResolvedValue(modello({ visibleReply: 'Ok' }));
    const { supabase } = makeSupabase();
    await turnoPostPitch(supabase, base(), ctx(new Date('2026-10-06T02:59:00+02:00')));
    expect(genera.mock.calls[0][1].modo).toBe('notte');
    await turnoPostPitch(supabase, base(), ctx(new Date('2026-10-06T09:00:00+02:00')));
    expect(genera.mock.calls[1][1].modo).toBe('giorno');
    expect(sendFreeText).toHaveBeenCalledTimes(2);
  });

  it('modello vuoto senza tag: silenzio definitivo', async () => {
    genera.mockResolvedValueOnce(modello({ visibleReply: '' }));
    const { supabase, calls } = makeSupabase();
    await turnoPostPitch(supabase, base(), ctx());
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'risposta_vuota', definitivo: true });
  });
});

describe('turnoPostPitch — numero sconosciuto senza crm_lead_id', () => {
  it('prima della scelta rilegge crm_lead_id, lo chiede al CRM con pushLeadEntrante e poi sceglie con quel leadId', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u1', nome: 'Sara' } });
    const { supabase } = makeSupabase(null);
    expect(await turnoPostPitch(supabase, scelta('adesso', { crmLeadId: null }), ctx())).toBe('closed');
    expect(pushLeadEntrante).toHaveBeenCalledWith(expect.anything(), {
      conversationId: 42, telefono: '+393331234567', nome: 'Anna', provenienza: 'Lancio Web Dev AI',
      primoMessaggio: MARKER, scrittoIl: '2026-10-05T22:38:00+02:00',
    });
    expect(lancioCallNow).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'crm-NEW' }));
    expect(bolle()).toEqual(['Perfetto, ti chiama Sara tra pochissimo.']);
  });

  it('se il push del webhook e arrivato nel frattempo (crm_lead_id a DB) non si rispinge', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'CHIAMA_ORA' } }));
    vi.mocked(lancioCallNow).mockResolvedValueOnce({ ok: true, venditore: { id: 'u1', nome: 'Sara' } });
    const { supabase } = makeSupabase('crm-DB');
    await turnoPostPitch(supabase, scelta('adesso', { crmLeadId: null }), ctx());
    expect(pushLeadEntrante).not.toHaveBeenCalled();
    expect(lancioCallNow).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'crm-DB' }));
  });

  it('push fallito: testo di errore, evento lancio_lead_senza_crm, nessuna scelta', async () => {
    genera.mockResolvedValueOnce(modello({ lancioTag: { tag: 'PRENOTA', at: '2026-10-06T09:00:00+02:00' } }));
    vi.mocked(pushLeadEntrante).mockResolvedValueOnce({ ok: false, motivo: 'http_500' });
    const { supabase, calls } = makeSupabase(null);
    expect(await turnoPostPitch(supabase, scelta('alle 9', { crmLeadId: null }), ctx())).toBe('active');
    expect(lancioBook).not.toHaveBeenCalled();
    expect(bolle()).toEqual([TESTO_ERRORE_CRM]);
    expect(eventi(calls, 'lancio_lead_senza_crm')[0].level).toBe('error');
  });
});

describe('turnoDopoScelta — fase scelta_fatta', () => {
  it('primo messaggio dopo la scelta: "Ricevuto" una volta, le parole al CRM come nota, closed', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', rows: [LINK, PULSANTE, out('Perfetto, ti chiama Luca tra pochissimo.'), inb('grazie, aspetto')], inboundBody: 'grazie, aspetto' }));
    expect(stato).toBe('closed');
    expect(bolle()).toEqual([TESTO_DOPO_SCELTA]);
    expect(vi.mocked(sendCrmNota).mock.calls[0].slice(1)).toEqual([42, expect.stringContaining('"grazie, aspetto"')]);
    expect(eventi(calls, 'lancio_dopo_scelta')).toHaveLength(1);
    expect(eventi(calls, 'fenice_ai_reply')).toHaveLength(1);
  });

  it('dal secondo in poi: silenzio definitivo, ma la nota al CRM parte comunque', async () => {
    const { supabase, calls } = makeSupabase();
    await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', rows: [LINK, PULSANTE, out('Perfetto...'), inb('grazie'), out(TESTO_DOPO_SCELTA), inb('alle 9 non posso più')], inboundBody: 'alle 9 non posso più' }));
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(sendCrmNota).toHaveBeenCalledTimes(1);
    expect(eventi(calls, 'lancio_silenzio')[0].payload).toMatchObject({ motivo: 'dopo_scelta', definitivo: true });
  });

  it('senza crm_lead_id niente nota, ma il "Ricevuto" sì', async () => {
    const { supabase } = makeSupabase(null);
    await turnoDopoScelta(supabase, base({ fase: 'scelta_fatta', crmLeadId: null, rows: [LINK, PULSANTE, out('Perfetto...'), inb('ok')], inboundBody: 'ok' }));
    expect(sendCrmNota).not.toHaveBeenCalled();
    expect(bolle()).toEqual([TESTO_DOPO_SCELTA]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run lib/lancio-post-pitch.test.ts`
Expected: FAIL — modulo assente.

- [ ] **Step 3: Write `lib/lancio-post-pitch.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import type { Json } from './supabase/types';
import type { LancioSettings } from './lancio-settings';
import type { TurnoLancioInput } from './lancio-turno';
import { generateLancioReply } from './lancio-reply';
import { RISPOSTE_RISCALDAMENTO } from './lancio-prompt';
import { impostaFaseLancio } from './lancio-db';
import { sendOutcome, sendCrmNota } from './bot-outcome';
import { pushLeadEntrante } from './lead-entrante';
import { lancioSlots, lancioBook, lancioCallNow, type LancioInfo, type LancioSlots } from './lancio-crm';
import {
  giorniLancio, modoPostPitch, puoRispondere, validaAtLancio, oreProponibili, testoSlots, bloccoSlotPerPrompt,
  testoConfermaChiamata, testoConfermaPrenotazione, testoOraEsaurita, testoAtNonValido, raccogliRisposte,
  TESTO_NESSUN_VENDITORE, TESTO_CHIAMATA_FUORI_ORARIO, TESTO_ERRORE_CRM, TESTO_DOPO_SCELTA, TESTO_CONGEDO_POST_PITCH,
  type OreProponibili, type GiorniLancio, type ModoPostPitch,
} from './lancio-scelta';
import {
  contestoDi, historyDi, eventoAtDa, inviaBollaLancio, eventoLancio, tracciaTurnoLancio, silenzioLancio,
  passaggioUmanoLancio, type StatoTurno, type ContestoTurno,
} from './lancio-effetti';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export const NOTA_SCELTA = 'Lancio Web Dev AI: ha premuto il pulsante dopo la live.';
export const PROVENIENZA_LANCIO = 'Lancio Web Dev AI';
const NOTA_CONGEDO = 'Lancio Web Dev AI: ha seguito la live ma non vuole una call.';
const NOTA_SENZA_ORE = 'Lancio Web Dev AI: vuole una call ma non ci sono più ore libere nei due giorni dopo la live.';

/**
 * Fase `post_pitch` (spec §5.4): il lead ha premuto il pulsante dopo la live. Due domande
 * di riscaldamento (le risposte finiscono in `lancio_info` e poi al venditore), poi la
 * scelta fra "adesso" e "una call". Il modello NON scrive mai un'ora: le ore le elenca il
 * codice nel prompt (blocco ORE PRENOTABILI, dal CRM), il modello le riporta in un tag e
 * il tag torna qui per le regole dure — date ammesse, ora tonda, `at ≥ now+1h`, chiamata
 * immediata solo di notte. Ogni conferma è un testo fisso.
 *
 * Un solo tag per turno e una sola chiamata al CRM per tag: il turno gira dentro il
 * drain, il lead sta aspettando la bolla.
 */
export async function turnoPostPitch(
  supabase: Supa,
  i: TurnoLancioInput,
  ctx: { settings: LancioSettings; now: Date },
): Promise<StatoTurno> {
  const genera = i.genera ?? generateLancioReply;
  const c = contestoDi(i);
  const now = ctx.now;
  const eventoAt = eventoAtDa(ctx.settings);
  const giorni = giorniLancio(eventoAt);
  const modo = modoPostPitch(now, eventoAt);

  // Fuori orario (03:00-08:30, dopo le 23:00): silenzio TEMPORANEO, senza traccia, così
  // il re-drive di bot-followups delle 08:30 rifà il turno e risponde.
  if (!puoRispondere(now, eventoAt, 'post_pitch')) return silenzioLancio(supabase, c, 'fuori_orario', false);

  // Le parole del lead, accumulate (il marker del pulsante no): sono le "info" per chi chiama.
  const info: LancioInfo = raccogliRisposte(i.lancioInfo ?? null, [i.inboundBody]);
  const faseScelta = info.risposte.length >= RISPOSTE_RISCALDAMENTO || !!info.slotsMostratiAt;

  const salvaInfo = async (dati: LancioInfo): Promise<void> => {
    await supabase.from('conversations').update({ lancio_info: dati as unknown as Json }).eq('id', c.conversationId);
  };

  // Le ore si leggono una volta per turno e solo quando servono.
  let ore: OreProponibili | null = null;
  const leggiOre = async (): Promise<OreProponibili> => {
    if (ore) return ore;
    const r = await lancioSlots(giorni.giornoDopo);
    if (!r.ok) {
      await eventoLancio(supabase, c, 'lancio_slots_non_letti', { kind: r.kind }, `[lancio] conv ${c.conversationId}: slot non letti dal CRM (${r.kind}), propongo pomeriggio e dopodomani`, 'warn');
    }
    ore = oreProponibili(r.ok ? r.slots : null, now, eventoAt);
    return ore;
  };

  /** Manda un testo con le ore (scritto dal codice) e segna che le ore sono state mostrate. */
  const mostraOre = async (componi: (o: OreProponibili, g: GiorniLancio, m: ModoPostPitch) => string = testoSlots): Promise<'active'> => {
    const o = await leggiOre();
    await inviaBollaLancio(supabase, c, componi(o, giorni, modo));
    await salvaInfo({ ...info, slotsMostratiAt: now.toISOString() });
    if (o.mattina.length === 0 && o.pomeriggio.length === 0 && o.dopodomani.length === 0) {
      // Il testo promette "lascio nota": la nota parte davvero, altrimenti nessuno lo richiama.
      if (c.crmLeadId) await sendCrmNota(supabase, c.conversationId, NOTA_SENZA_ORE);
      await eventoLancio(supabase, c, 'lancio_slots_vuoti', {}, `[lancio] conv ${c.conversationId}: nessuna ora libera nei due giorni, nota al CRM`, 'warn');
    }
    await eventoLancio(supabase, c, 'lancio_slots_mostrati', { mattina: o.mattina, pomeriggio: o.pomeriggio, dopodomani: o.dopodomani, modo }, `[lancio] conv ${c.conversationId}: ore proposte`);
    await tracciaTurnoLancio(supabase, c, 'slots');
    return 'active';
  };

  const erroreCrm = async (tipo: string, dettagli: Record<string, unknown>): Promise<'active'> => {
    await inviaBollaLancio(supabase, c, TESTO_ERRORE_CRM);
    await salvaInfo(info);
    await eventoLancio(supabase, c, tipo, dettagli, `[lancio] conv ${c.conversationId}: scelta non registrata (${tipo})`, 'error');
    await tracciaTurnoLancio(supabase, c, 'errore_crm');
    return 'active';
  };

  /** Il leadId per il CRM: quello della chat, rilettto ora, o chiesto al CRM se manca ancora. */
  const leadIdPerCrm = async (): Promise<string | null> => {
    const { data } = await supabase.from('conversations').select('crm_lead_id').eq('id', c.conversationId).maybeSingle();
    const attuale = (data as { crm_lead_id: string | null } | null)?.crm_lead_id ?? c.crmLeadId;
    if (attuale) return attuale;
    // Numero sconosciuto che ha premuto il pulsante: il push del webhook (B2) è
    // fire-and-forget e può non essere arrivato. Il CRM deduplica per numero: si rispinge.
    const primo = i.rows.find((m) => m.direction === 'in');
    const res = await pushLeadEntrante(supabase, {
      conversationId: c.conversationId, telefono: c.phone, nome: i.nome, provenienza: PROVENIENZA_LANCIO,
      primoMessaggio: primo?.body ?? null, scrittoIl: primo?.created_at ?? now.toISOString(),
    });
    return res.ok && res.leadId ? res.leadId : null;
  };

  const sceltaFatta = async (tipo: 'chiama_ora' | 'prenota', extra: Record<string, unknown>): Promise<'closed'> => {
    await impostaFaseLancio(supabase, c.conversationId, 'scelta_fatta', { lancio_info: info as unknown as Json });
    await eventoLancio(supabase, c, 'lancio_scelta', { tipo, ...extra }, `[lancio] conv ${c.conversationId}: scelta ${tipo}`);
    await tracciaTurnoLancio(supabase, c, `scelta_${tipo}`);
    return 'closed';
  };

  const bloccoSlot = faseScelta ? bloccoSlotPerPrompt(await leggiOre(), giorni, modo) : null;
  const r = await genera(historyDi(i.rows), {
    fase: 'post_pitch', nome: i.nome, eventoAt: ctx.settings.eventoAt, now,
    modo, risposteRaccolte: info.risposte.length, bloccoSlot,
  });

  if (r.passToHuman) {
    await salvaInfo(info);
    return passaggioUmanoLancio(supabase, c, r.visibleReply, i.inboundBody);
  }

  const tag = r.lancioTag;
  switch (tag?.tag) {
    case 'CHIAMA_ORA': {
      // Regola dura: la chiamata immediata esiste solo la notte del webinar.
      if (modo !== 'notte') return mostraOre((o, g, m) => `${TESTO_CHIAMATA_FUORI_ORARIO} ${testoSlots(o, g, m)}`);
      const leadId = await leadIdPerCrm();
      if (!leadId) return erroreCrm('lancio_lead_senza_crm', { tag: 'CHIAMA_ORA' });
      const esito = await lancioCallNow({ leadId, info: { risposte: info.risposte }, note: NOTA_SCELTA });
      if (esito.ok) {
        await inviaBollaLancio(supabase, c, testoConfermaChiamata(esito.venditore.nome));
        return sceltaFatta('chiama_ora', { venditore: esito.venditore });
      }
      if (esito.kind === 'nessun_venditore') return mostraOre((o, g, m) => `${TESTO_NESSUN_VENDITORE} ${testoSlots(o, g, m)}`);
      return erroreCrm('lancio_crm_errore', { tag: 'CHIAMA_ORA', ...esito });
    }
    case 'PRENOTA': {
      const v = validaAtLancio(tag.at, now, eventoAt);
      if (!v.ok) {
        await eventoLancio(supabase, c, 'lancio_at_non_valido', { at: tag.at, motivo: v.motivo }, `[lancio] conv ${c.conversationId}: ora ${tag.at} rifiutata (${v.motivo})`);
        return mostraOre(testoAtNonValido);
      }
      const leadId = await leadIdPerCrm();
      if (!leadId) return erroreCrm('lancio_lead_senza_crm', { tag: 'PRENOTA', at: tag.at });
      const esito = await lancioBook({ leadId, at: tag.at, info: { risposte: info.risposte }, note: NOTA_SCELTA });
      if (esito.ok) {
        await inviaBollaLancio(supabase, c, testoConfermaPrenotazione(esito.kind, tag.at, esito.venditore?.nome ?? null));
        return sceltaFatta('prenota', { at: tag.at, kind: esito.kind, venditore: esito.venditore ?? null, deduped: esito.deduped === true });
      }
      if (esito.kind === 'ora_esaurita') {
        // Le ore aggiornate sono nella risposta: si ripropone da quelle, non da quelle di prima.
        ore = oreProponibili(esito.slots as LancioSlots | null, now, eventoAt);
        return mostraOre((o, g, m) => testoOraEsaurita(v.hour, o, g, m));
      }
      if (esito.kind === 'nessun_venditore') return mostraOre((o, g, m) => `${TESTO_NESSUN_VENDITORE} ${testoSlots(o, g, m)}`);
      if (esito.kind === 'fuori_regole') {
        await eventoLancio(supabase, c, 'lancio_at_non_valido', { at: tag.at, motivo: 'crm_fuori_regole' }, `[lancio] conv ${c.conversationId}: il CRM rifiuta ${tag.at} (422)`, 'warn');
        return mostraOre(testoAtNonValido);
      }
      return erroreCrm('lancio_crm_errore', { tag: 'PRENOTA', at: tag.at, ...esito });
    }
    case 'SLOTS':
      return mostraOre();
    case 'NO': {
      await inviaBollaLancio(supabase, c, TESTO_CONGEDO_POST_PITCH);
      await impostaFaseLancio(supabase, c.conversationId, 'chiuso', { lancio_info: info as unknown as Json });
      let stato: StatoTurno = 'closed';
      if (c.crmLeadId) {
        const esito = await sendOutcome(supabase, c.conversationId, { outcome: 'DA_SCARTARE', discardReason: 'non interessato', note: NOTA_CONGEDO, leadWords: i.inboundBody });
        if (!(esito.sent || esito.error === 'note_duplicate')) stato = 'active';
      }
      await eventoLancio(supabase, c, 'lancio_congedo', { finalStatus: stato }, `[lancio] conv ${c.conversationId}: dopo la live non vuole una call`);
      await tracciaTurnoLancio(supabase, c, 'congedo');
      return stato;
    }
    default: {
      // Riscaldamento o risposta a una domanda: la bolla del modello, una sola.
      const testo = r.visibleReply.trim();
      await salvaInfo(info);
      if (!testo) return silenzioLancio(supabase, c, 'risposta_vuota', true);
      await inviaBollaLancio(supabase, c, testo);
      await eventoLancio(supabase, c, 'lancio_post_pitch_domanda', { risposte: info.risposte.length, faseScelta }, `[lancio] conv ${c.conversationId}: post-pitch, ${info.risposte.length} risposte`);
      await tracciaTurnoLancio(supabase, c, 'post_pitch');
      return 'active';
    }
  }
}

/**
 * Fase `scelta_fatta`: la conversazione è `closed`, il webhook la riapre a ogni inbound.
 * Si ringrazia una volta sola (`TESTO_DOPO_SCELTA`), poi silenzio definitivo; le parole
 * del lead vanno sempre al CRM come nota, perché "alle 9 non posso più" lo deve leggere
 * chi lo chiama, non il bot. Stato `closed`: la chat resta ferma finché non riscrive.
 */
export async function turnoDopoScelta(supabase: Supa, i: TurnoLancioInput): Promise<StatoTurno> {
  const c: ContestoTurno = contestoDi(i);
  const parole = i.inboundBody.trim();
  if (c.crmLeadId && parole) {
    const nota = await sendCrmNota(supabase, c.conversationId, `Lancio Web Dev AI, dopo la scelta il lead scrive: "${parole.slice(0, 300)}"`);
    if (!nota.sent) {
      await eventoLancio(supabase, c, 'lancio_nota_dopo_scelta_non_inviata', { error: nota.error ?? null, status: nota.status ?? null }, `[lancio] conv ${c.conversationId}: nota dopo la scelta non inviata al CRM`, 'warn');
    }
  }
  const giaDetto = i.rows.some((m) => m.direction === 'out' && (m.body ?? '').trim() === TESTO_DOPO_SCELTA);
  if (giaDetto) {
    await silenzioLancio(supabase, c, 'dopo_scelta', true);
    return 'closed';
  }
  await inviaBollaLancio(supabase, c, TESTO_DOPO_SCELTA);
  await eventoLancio(supabase, c, 'lancio_dopo_scelta', {}, `[lancio] conv ${c.conversationId}: ha scritto dopo la scelta, ringraziato`);
  await tracciaTurnoLancio(supabase, c, 'dopo_scelta');
  return 'closed';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run lib/lancio-post-pitch.test.ts lib/lancio-scelta.test.ts && bun run typecheck`
Expected: PASS. Se `typecheck` si lamenta di `lancio_info: dati as unknown as Json` è perché `types.ts` non ha la colonna (Task 0, Step 1). Se un atteso testuale differisce per la sola forma di `etichettaGiorno` (ICU), vale la regola del Task 5: si adegua l'atteso, non il testo.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-post-pitch.ts lib/lancio-post-pitch.test.ts
git commit -m "feat(lancio): turno post-pitch (riscaldamento, scelta, book/call-now col CRM, conferme fisse) e turno dopo la scelta"
```

---

### Task 9: Lo `switch` per fase in `eseguiTurnoLancio` e il drain che passa `lancio_info`

**Files:**
- Modify: `lib/lancio-turno.ts` (B1 Task 8) — lo `switch` in testa, import dei tre turni del B4 e di `adessoLancio`
- Modify: `lib/fenice-autoreply.ts` (B1 Task 8) — la select del claim legge `lancio_info`; il ramo lancio passa `lancioInfo`; `DrainMsgRow` porta `created_at`
- Test: `lib/lancio-turno.test.ts` (B1: si sostituisce UN test, se ne aggiungono tre), `lib/fenice-autoreply.test.ts` (B1: un `describe` in più)

**Interfaces:**
- Consumes: `turnoAssistenza` (Task 7); `turnoPostPitch`, `turnoDopoScelta` (Task 8); `adessoLancio` (Task 7); `LancioInfo` (Task 4).
- Produces: `eseguiTurnoLancio(supabase, i)` con la stessa firma del B1, che per `link_inviato` / `post_pitch` / `scelta_fatta` delega ai turni del B4 (passando `{ settings, now }`), e per tutto il resto fa il turno del B1 (`followup_inviato` resta `silenzio: fase_non_gestita` finché il B5 non aggiunge il suo ramo). Il drain non cambia forma: un solo ramo lancio, quello del B1.

- [ ] **Step 1: Write the failing tests**

In `lib/lancio-turno.test.ts`, sotto i `vi.mock` del B1 aggiungi:
```ts
vi.mock('./lancio-assistenza', () => ({ turnoAssistenza: vi.fn(async () => 'active') }));
vi.mock('./lancio-post-pitch', () => ({ turnoPostPitch: vi.fn(async () => 'closed'), turnoDopoScelta: vi.fn(async () => 'closed') }));
import { turnoAssistenza } from './lancio-assistenza';
import { turnoPostPitch, turnoDopoScelta } from './lancio-post-pitch';
```
Sostituisci per intero il `describe('eseguiTurnoLancio — fasi di B4/B5', …)` del B1 con:
```ts
describe('eseguiTurnoLancio — le fasi del B4 delegano ai loro turni', () => {
  const NOW = new Date('2026-10-05T22:40:00+02:00');

  it('link_inviato → turnoAssistenza con settings e now; il turno del B1 non parte', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ fase: 'link_inviato', rows: [WELCOME, inb('codice?')], inboundBody: 'codice?', now: NOW }));
    expect(stato).toBe('active');
    expect(turnoAssistenza).toHaveBeenCalledTimes(1);
    const [, input, ctx] = vi.mocked(turnoAssistenza).mock.calls[0];
    expect(input).toMatchObject({ conversationId: 42, fase: 'link_inviato', inboundBody: 'codice?' });
    expect(ctx).toMatchObject({ now: NOW, settings: expect.objectContaining({ eventoAt: '2026-10-05T21:00:00+02:00' }) });
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio')).toBe(false);
  });

  it('post_pitch → turnoPostPitch, con lancioInfo passato com è; lo stato è quello del turno', async () => {
    const { supabase } = makeSupabase();
    const info = { risposte: ['faccio il barista'] };
    const stato = await eseguiTurnoLancio(supabase, base({ fase: 'post_pitch', lancioInfo: info, rows: [WELCOME, inb('adesso')], inboundBody: 'adesso', now: NOW }));
    expect(stato).toBe('closed');
    expect(vi.mocked(turnoPostPitch).mock.calls[0][1]).toMatchObject({ fase: 'post_pitch', lancioInfo: info });
    expect(vi.mocked(turnoPostPitch).mock.calls[0][2]).toMatchObject({ now: NOW });
  });

  it('scelta_fatta → turnoDopoScelta', async () => {
    const { supabase } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'scelta_fatta', rows: [WELCOME, inb('grazie')], inboundBody: 'grazie' }));
    expect(turnoDopoScelta).toHaveBeenCalledTimes(1);
  });

  it('senza now in input l orologio è quello del turno (una Date), non undefined', async () => {
    const { supabase } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'link_inviato', rows: [WELCOME, inb('?')], inboundBody: '?' }));
    expect(vi.mocked(turnoAssistenza).mock.calls[0][2].now).toBeInstanceOf(Date);
  });

  it('followup_inviato resta del B5: silenzio fase_non_gestita, mai il pitch', async () => {
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'followup_inviato', rows: [WELCOME, inb('ok')], inboundBody: 'ok' }));
    expect(turnoAssistenza).not.toHaveBeenCalled();
    expect(turnoPostPitch).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'fase_non_gestita')).toBe(true);
  });
});
```

In `lib/fenice-autoreply.test.ts`, in coda al `describe('drainMarioReplies — aggancio del turno lancio', …)` del B1 aggiungi:
```ts
  it.each(['link_inviato', 'post_pitch', 'scelta_fatta'])('fase %s: il ramo lancio scavalca Mario e passa lancio_info e created_at', async (fase) => {
    const info = { risposte: ['studio informatica'], slotsMostratiAt: null };
    const { supabase, calls } = makeDrainSupabase(
      { id: 45, ai_started_at: '2026-09-20T09:00:00Z', crm_lead_id: 'crm-L5', gdo_agenda_at: null, gdo_video_url: null, gdo_video_sent_at: null,
        lancio_slug: 'webdev-2026-10', lancio_fase: fase, lancio_info: info, leads: { first_name: 'Anna' } } as any,
      [WELCOME, { ...SI, body: 'qual è il codice?' }],
    );
    await drainMarioReplies(supabase, 45, '+393331234567', () => 0);
    expect(generateMarioReply).not.toHaveBeenCalled();
    expect(eseguiTurnoLancio).toHaveBeenCalledTimes(1);
    const input = vi.mocked(eseguiTurnoLancio).mock.calls[0][1];
    expect(input).toMatchObject({ conversationId: 45, fase, lancioInfo: info, inboundBody: 'qual è il codice?' });
    expect(input.rows[1]).toMatchObject({ direction: 'in', created_at: SI.created_at });
    expect(calls.finalStatusWrites).toEqual(['active']);
  });
```
Nel tipo `ClaimedRow` del test aggiungi `lancio_info?: unknown;`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run lib/lancio-turno.test.ts lib/fenice-autoreply.test.ts`
Expected: FAIL — in `link_inviato` il turno del B1 scrive `lancio_silenzio: fase_non_gestita` invece di delegare; nel drain `lancioInfo` è `undefined`.

- [ ] **Step 3: Lo `switch` in `lib/lancio-turno.ts`**

Import in testa (accanto agli altri del B1):
```ts
import { turnoAssistenza } from './lancio-assistenza';
import { turnoPostPitch, turnoDopoScelta } from './lancio-post-pitch';
import { adessoLancio } from './lancio-orologio';
```
Nel corpo di `eseguiTurnoLancio`, subito dopo `const settings = i.settings ?? (await getLancioSettings(supabase));` e PRIMA di `let classe: ClasseLancio = classificaLancio(i.inboundBody);`:
```ts
  // Dal blast in poi ogni fase ha il suo turno (B4). L'orologio è uno solo per il
  // turno: da qui passano le regole di finestra e le ore proponibili.
  const now = i.now ?? adessoLancio();
  switch (i.fase) {
    case 'link_inviato':
      return turnoAssistenza(supabase, i, { settings, now });
    case 'post_pitch':
      return turnoPostPitch(supabase, i, { settings, now });
    case 'scelta_fatta':
      return turnoDopoScelta(supabase, i);
    default:
      break; // attesa / posto_bloccato: il turno del B1 qui sotto; followup_inviato: B5
  }
```
Il resto della funzione del B1 non cambia. Aggiorna il commento di testa della funzione: "Un turno della chat del lancio. Fasi attesa/posto_bloccato (spec §5.2) qui sotto; link_inviato, post_pitch e scelta_fatta (spec §5.3-5.4) nei moduli del B4."

- [ ] **Step 4: Il drain in `lib/fenice-autoreply.ts`**

1. `type DrainMsgRow = MsgRow & { template_sid: string | null };` → `type DrainMsgRow = MsgRow & { template_sid: string | null; created_at?: string | null };` (la select li legge già).
2. Nel `.select(...)` del claim, dopo `lancio_slug, lancio_fase,` (B1) aggiungi `lancio_info,`.
3. Il cast del B1 `const lancio = claimed as { lancio_slug?: string | null; lancio_fase?: string | null };` diventa
```ts
  const lancio = claimed as { lancio_slug?: string | null; lancio_fase?: string | null; lancio_info?: LancioInfo | null };
```
con `import type { LancioInfo } from './lancio-crm';` in testa.
4. Nella chiamata del B1 a `eseguiTurnoLancio(supabase, { … rows, inboundBody })` aggiungi `lancioInfo: lancio.lancio_info ?? null,`. Nient'altro: nessun secondo ramo, nessun `now` (lo decide il turno con `adessoLancio`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run lib/lancio-turno.test.ts lib/fenice-autoreply.test.ts lib/lancio-assistenza.test.ts lib/lancio-post-pitch.test.ts && bun run typecheck`
Expected: PASS. I test del B1 sul drain (attesa → `eseguiTurnoLancio`, chiuso → Mario) restano verdi.

- [ ] **Step 6: Commit**

```bash
git add lib/lancio-turno.ts lib/lancio-turno.test.ts lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(lancio): switch per fase nel turno lancio (assistenza, post-pitch, dopo la scelta), il drain passa lancio_info"
```

---

### Task 10: `.env.example`, suite completa, verifica dal vivo con numero di test e orologio forzato, push

**Files:**
- Modify: `.env.example` (in coda alla sezione del lancio messa dal B1)
- Nessun file di codice: questo task esegue e verifica.

**Interfaces:**
- Consumes: tutto quanto sopra; le env di produzione su Vercel; un numero WhatsApp di test (quello delle prove del B1) e un lead di test sul CRM.
- Produces: repo verde, env documentate, il flusso B4 provato dal vivo su un numero, push su `origin/main` (= deploy).

- [ ] **Step 1: `.env.example`**

Dopo le righe del B1 (`LANCIO_WELCOME_TEMPLATE_SID=`, `LANCIO_ZOOM_TEMPLATE_SID=`, `LANCIO_FOLLOWUP_TEMPLATE_SID=`, `LANCIO_APERTURE_MAX_PER_RUN=100`) aggiungi:
```
# B4 — blast del link Zoom (cron /api/cron/lancio-zoom, 19:30-20:45 del giorno dell'evento)
# Conversazioni per run (400 ogni 5' ≈ 3.000 in 40'). Il template va in LANCIO_ZOOM_TEMPLATE_SID.
LANCIO_BATCH_MAX=400
# Base delle rotte del lancio sul CRM (/slots, /book, /call-now). Vuota = produzione.
CRM_LANCIO_URL=
# Orologio forzato dei turni del lancio (assistenza, post-pitch), SOLO per la prova generale:
# ISO con offset, es. 2026-10-05T22:40:00+02:00. Fuori produzione basta LANCIO_FAKE_NOW;
# in produzione vale solo se LANCIO_FAKE_NOW_ARMED è uguale a CRON_SECRET. Toglierle dopo la prova.
LANCIO_FAKE_NOW=
LANCIO_FAKE_NOW_ARMED=
```
Se il B1 non ha messo `LANCIO_ZOOM_TEMPLATE_SID=` (Task 12 del B1), aggiungerlo qui sopra con il commento `# Content SID del template "Link Zoom" ({{1}}=nome, {{2}}=link)`.

- [ ] **Step 2: Suite completa, typecheck, lint**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: tutto verde. Se un test storico del drain fallisce perché il fake della `claimedRow` non ha `lancio_info`, si estende il fake (`lancio_info: null`), mai il codice. Se `vercel.json` ha una voce cron in più di quelle attese da un test esistente (`lib/cron-window.test.ts`), aggiornare l'atteso con la voce `/api/cron/lancio-zoom`.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(lancio): env del blast Zoom, del client CRM e dell'orologio forzato in .env.example"
```

- [ ] **Step 4: Prerequisiti della verifica dal vivo (da controllare, non da fare qui)**

1. B1 in produzione: migrazione applicata, `LANCIO_WELCOME_TEMPLATE_SID` e `LANCIO_ZOOM_TEMPLATE_SID` in env (se Meta li ha approvati MARKETING, anche in `UTILITY_ONLY_ALLOW`), `app_settings`: `lancio_attivo=true`, `lancio_zoom_link` e `lancio_evento_at='2026-10-05T21:00:00+02:00'` valorizzati.
2. B2 in produzione: il marker del pulsante porta la chat in `post_pitch` (`event_log.type='lancio_pulsante'`).
3. B3 sul CRM: le tre rotte `/api/bot/lancio/*` rispondono (anche solo `409` finché i turni sono vuoti: la prova vuole vedere i testi di ripiego). Un turno "giorno dopo" di prova per il 6/10 con almeno un venditore, se si vuole vedere la conferma con il nome.
4. Un numero WhatsApp di test già arruolato nel lancio (B1 Task 12, punto 4) in fase `posto_bloccato`, con il suo `conversationId` (`select id, lancio_fase, crm_lead_id from conversations where wa_number like '%<numero>%'`).

- [ ] **Step 5: Env di produzione**

```bash
npx vercel env add LANCIO_BATCH_MAX production      # 400
npx vercel env add CRM_LANCIO_URL production        # vuoto ⇒ default; oppure l'URL canonico
npx vercel env ls production | grep -i "LANCIO\|CRON_SECRET\|BOT_WEBHOOK"
```
`LANCIO_FAKE_NOW` e `LANCIO_FAKE_NOW_ARMED` NON si mettono adesso: arrivano allo Step 7 e si tolgono allo Step 9.

- [ ] **Step 6: Push (deploy) e blast di prova sul solo numero di test**

Il deploy parte al push. È sicuro anche prima del 5/10: le fasi del B4 si raggiungono solo col blast (cron a data fissa + `attivo`) o col marker del pulsante (testo non pubblico prima della live).
```bash
git fetch origin && git rev-list --count origin/main..main   # quanti commit partono
git push origin main
npx vercel ls --yes | head -3                                 # l'ultimo deploy deve essere Ready
```
Poi il blast di prova, SOLO su quella conversazione (`forza=1` senza `solo=` risponde 400 apposta):
```bash
curl -s "https://<prod>/api/cron/lancio-zoom?secret=$CRON_SECRET&forza=1&solo=<conversationId>&dry=1"   # atteso: { dry: true, candidati: 1 }
curl -s "https://<prod>/api/cron/lancio-zoom?secret=$CRON_SECRET&forza=1&solo=<conversationId>"         # atteso: { sent: 1 }
```
Verifica: il numero riceve il template "Ciao <Nome>, ci siamo! …", `conversations.lancio_fase='link_inviato'`, `lancio_link_inviato_at` valorizzato, `event_log` con `lancio_fase_cambiata` e `lancio_zoom_blast`. Rilanciare lo stesso comando: `{ sent: 0, candidati: 0 }` (idempotenza sulla query) — e se si azzera a mano `lancio_link_inviato_at`: `{ riparati: 1 }` senza secondo invio (idempotenza su `messages.template_sid`).

- [ ] **Step 7: Orologio forzato e assistenza (fase `link_inviato`)**

Armare l'orologio in produzione (vale solo per i turni B4, cioè solo per le chat in `link_inviato`/`post_pitch`: i lead veri sono in `attesa`/`posto_bloccato` e non lo vedono):
```bash
npx vercel env add LANCIO_FAKE_NOW production        # 2026-10-05T21:35:00+02:00
npx vercel env add LANCIO_FAKE_NOW_ARMED production  # lo stesso valore di CRON_SECRET
npx vercel redeploy --yes $(npx vercel ls --yes | awk 'NR==2{print $1}')   # o un deploy vuoto: le env si leggono al boot
```
Dal numero di test scrivere, uno alla volta, e leggere la risposta e `event_log` (`lancio_assistenza`, `fenice_ai_reply` con `lancio:true`):
1. "qual è il codice della riunione?" → una riga con `898 4522 3337` (i numeri del link) e "niente passcode".
2. "non si apre" → riclicca il link / app Zoom / browser. Nessun accenno a call, prezzi, video.
3. Cambiare `LANCIO_FAKE_NOW` a `2026-10-06T00:10:00+02:00` (redeploy) e scrivere "come rivedo la live?" → nessuna risposta, `lancio_silenzio` con `motivo='assistenza_finita'`, `fenice_ai_reply` presente; la fase resta `link_inviato`.

- [ ] **Step 8: Il pulsante e la scelta (fase `post_pitch`)**

`LANCIO_FAKE_NOW=2026-10-05T22:40:00+02:00` (redeploy). Dal numero di test:
1. Inviare il testo del pulsante "Ho seguito la live Web Developer AI e voglio saperne di più 🚀" → `lancio_pulsante` (B2), fase `post_pitch`, il bot fa la prima domanda di riscaldamento. `lancio_info` = `{ risposte: [] }`.
2. Rispondere ("faccio il barista") → seconda domanda; `lancio_info.risposte` ha 1 voce.
3. Rispondere ("il progetto finale") → la domanda della scelta, verbatim: "Preferisci che ti chiami un nostro consulente adesso, anche se è tardi, oppure fissiamo una call domani?". In `event_log` deve esserci la lettura degli slot (nessun `lancio_slots_non_letti` se il CRM risponde).
4. "domani" → le ore scritte dal codice ("Per la call ho libero domattina alle …, oppure domani pomeriggio dalle 15 alle 20: che ora preferisci?"), `lancio_slots_mostrati`, `lancio_info.slotsMostratiAt` valorizzato.
5. "alle 9" → `book` sul CRM: con un venditore in turno "Perfetto, ci sentiamo martedì 6 ottobre alle 9:00: ti chiama <Nome>. Tieni il telefono a portata di mano."; fase `scelta_fatta`, `ai_status='closed'`, `lancio_scelta` con `tipo='prenota'`; sul CRM il lead di test ha l'appuntamento. Senza turni: il testo di `ora_esaurita`/`nessun_venditore` e la fase resta `post_pitch`.
6. "grazie" → "Ricevuto, lo passo al consulente che ti chiama." e la nota al CRM; un secondo "ok" → silenzio.
7. Riportare la conversazione in `post_pitch` a mano (`update conversations set lancio_fase='post_pitch', lancio_info=null, ai_status='active' where id=<id>` + annullare l'appuntamento di prova sul CRM) e ripetere 1-3, poi "adesso" → `call-now`: "Perfetto, ti chiama <Nome> tra pochissimo." oppure "Stasera i consulenti sono tutti occupati: fissiamo domani? …" con `409`.
8. `LANCIO_FAKE_NOW=2026-10-06T10:00:00+02:00` (redeploy), stessa chat riportata in `post_pitch` con `lancio_info` a due risposte: "chiamami adesso" → "A quest'ora fissiamo direttamente la call. Per la call ho oggi pomeriggio dalle 15 alle 20: …" (niente `call-now`, niente ore di mattina nel testo).
9. `LANCIO_FAKE_NOW=2026-10-06T05:00:00+02:00` (redeploy): "ci sei?" → nessuna risposta, `lancio_silenzio` `fuori_orario` `definitivo:false`, NESSUN `fenice_ai_reply`; poi `LANCIO_FAKE_NOW=2026-10-06T09:00:00+02:00` e `GET /api/cron/bot-followups?secret=…` → il re-drive risponde (`action:'redrive'` nel report).

- [ ] **Step 9: Pulizia**

```bash
npx vercel env rm LANCIO_FAKE_NOW production --yes
npx vercel env rm LANCIO_FAKE_NOW_ARMED production --yes
npx vercel redeploy --yes $(npx vercel ls --yes | awk 'NR==2{print $1}')
```
Poi: la conversazione di test torna com'era (`lancio_fase='posto_bloccato'`, `lancio_link_inviato_at=null`, `lancio_info=null`, `ai_status='active'`; cancellare le righe `messages` del template Zoom di prova, altrimenti il blast vero del 5/10 la "ripara" senza mandarle il link), l'appuntamento di prova sul CRM annullato, il lead di test lasciato dov'era. Verificare con `select lancio_fase, lancio_link_inviato_at, lancio_info, ai_status from conversations where id=<id>`.

- [ ] **Step 10: Report finale**

Nel report di chiusura del blocco: esito dei punti 1-9 dello Step 8 (con i testi ricevuti), stato del re-drive (Task 0 Step 5), categoria Meta del template "Link Zoom" (UTILITY o MARKETING ⇒ `UTILITY_ONLY_ALLOW`), eventuali stub creati al Task 0 da riassorbire nel B1/B2, e i punti aperti della sezione "Self-review" qui sotto.

---

## Self-review (fatta in scrittura, 14/09/2026)

**1. Copertura della spec, punto per punto**

| Spec | Requisito | Task |
|---|---|---|
| §5.3 | Cron `/api/cron/lancio-zoom` ogni 5' 19:30-20:45 Rome, schedule UTC `*/5 17-18 5 10 *`, filtro sul minuto Rome, guardia `lancio_attivo` | Task 2 (`inFinestraBlast`, voce `vercel.json`), Task 3 (`settings.attivo`) |
| §5.3 | Fino a `LANCIO_BATCH_MAX` (400) conversazioni con `lancio_slug`, fase ∈ {attesa, posto_bloccato}, `lancio_link_inviato_at IS NULL`, per id | Task 2 (`batchMax`), Task 3 (query) |
| §5.3 | Template `LANCIO_ZOOM_TEMPLATE_SID` con `{nome, link}`, concorrenza 5 come `send-batch` | Task 1 (`runPool`), Task 3 |
| §5.3 | Idempotenza doppia (`lancio_link_inviato_at` + `template_sid` nei `messages`) | Task 3 (query + "riparati") |
| §5.3 | Chi non ha mai risposto riceve comunque il link; 63049 salta e riprova | Task 3 (nessun filtro su inbound; ramo `capped`) |
| §5.3 | Dopo il blast `lancio_fase='link_inviato'` | Task 3 (`impostaFaseLancio(..., 'link_inviato', { lancio_link_inviato_at })`) |
| §5.3 | Prompt assistenza fino a mezzanotte: codice riunione = 898 4522 3337 (numeri nel link), niente passcode; "non riesco a collegarmi" → app/browser/link ricliccato; tutto il resto breve; zero pitch | Task 6 (`promptAssistenza`), Task 2 (`zoomMeetingId`), Task 7 (`turnoAssistenza`, `puoRispondere` fino alle 23:59) |
| §5.4 | Inbound col marker porta `post_pitch` (numero noto o sconosciuto), adozione + push `lead-entrante`, `crm_lead_id` scritto prima di qualunque scelta | B2 (fuori perimetro) per il marker e il push; **Task 8** rilegge `crm_lead_id` e, se null, richiama `pushLeadEntrante` prima di `book`/`call-now` |
| §5.4 | Prompt `post_pitch`: due domande di riscaldamento poi la scelta verbatim "Preferisci che ti chiami un nostro consulente adesso, anche se è tardi, oppure fissiamo una call domani?" | Task 6 (`RISPOSTE_RISCALDAMENTO`, `DOMANDA_SCELTA_NOTTE`), Task 8 (`risposteRaccolte`) |
| §5.4 | Tag `[LANCIO:CHIAMA_ORA]`, `[LANCIO:PRENOTA\|iso]`, `[LANCIO:SLOTS]`; gli slot dal CRM mostrati "domattina ho libero alle 9, 11 e 14, oppure il pomeriggio dalle 15 alle 20" | Task 5 (`parseLancioTag`, `testoSlots`), Task 6 (parser in `generateLancioReply`), Task 8 (`mostraOre`) |
| §5.4 | `mattinaEsaurita` → solo il pomeriggio; se insiste sulla mattina → 7/10 mattina | Task 5 (`testoSlots` "Domattina è tutto pieno … Se puoi solo la mattina, ho mercoledì 7 ottobre dalle 9 alle 14"; `bloccoSlotPerPrompt` con le ISO del 7), Task 8 |
| §5.4 | Regole dure nel codice: date 6/10 (9-20) e 7/10 (9-14), ora tonda, il bot non inventa ore | Task 5 (`validaAtLancio`, `oreProponibili`), Task 8 (`PRENOTA` → `validaAtLancio` prima del `book`), Task 6 (il prompt vieta di scrivere ore) |
| §5.4 | `CHIAMA_ORA` → `call-now`; "Perfetto, ti chiama <nome> tra pochissimo."; `scelta_fatta` + `ai_status='closed'`; `409 nessun_venditore` → "stasera i consulenti sono tutti occupati, fissiamo domani?" e prosegue | Task 4 (`lancioCallNow`), Task 5 (`testoConfermaChiamata`, `TESTO_NESSUN_VENDITORE`), Task 8 |
| §5.4 | `PRENOTA` → `book`; 200 → conferma con giorno/ora e (mattina) nome venditore → `scelta_fatta`, `closed`; `409 ora_esaurita` → ripropone dagli slot aggiornati | Task 4 (`lancioBook`), Task 5 (`testoConfermaPrenotazione`, `testoOraEsaurita`), Task 8 |
| §5.4 | `lancio_info` (le risposte) in `info` su `book` e `call-now` | Task 5 (`raccogliRisposte`), Task 8 (`info: { risposte }`) |
| §5.4 | Finestra: inbound accettati la notte senza limiti d'orario; dopo le 03:00 fase invariata, risposte solo dalle 08:30, solo 6 pomeriggio o 7 (mattina del 6 solo se `at ≥ now+1h`) | Task 5 (`modoPostPitch`, `puoRispondere`, `oreProponibili`, `testoSlots` in modo giorno), Task 8 (`fuori_orario` temporaneo + regola su `CHIAMA_ORA`) |
| §6.2 | `POST /slots { date }` → `{ date, mattina, pomeriggio, mattinaEsaurita }` | Task 4 (`lancioSlots`, `leggiSlots`) |
| §6.2 | `POST /book { leadId, at, info?, note? }` → 200 `{ ok, kind, venditore?, deduped? }` / 409 `ora_esaurita`+`slots` / 422 `fuori_regole` / 403 | Task 4 (`lancioBook`, `erroreDaStatus`), Task 8 (un ramo per esito) |
| §6.2 | `POST /call-now { leadId, info?, note? }` → 200 `{ ok, venditore }` / 409 `nessun_venditore` | Task 4 (`lancioCallNow`), Task 8 |
| §6.2 | Tutte HMAC `x-bot-signature` | Task 4 (`signPayload(rawBody, BOT_WEBHOOK_SECRET)`) |
| §6.2 | `/api/bot/lead-entrante` con `provenienza='Lancio Web Dev AI'` | B2; Task 8 lo chiama con quel valore (`PROVENIENZA_LANCIO`) |
| §9 | Interruttori: cron a data fissa + `lancio_attivo` | Task 2, 3 |
| §9 (B6) | Orologio forzato via parametri dei cron / env | Task 3 (`?now=`, `?forza=1&solo=`), Task 7 (`adessoLancio`, `LANCIO_FAKE_NOW`), Task 10 |
| §10 | Numero a qualità LOW: lotti da 400, stop sul 63049 | Task 2, 3; nessun messaggio spontaneo nei turni (solo risposte a inbound) |

**Buchi di spec chiusi qui (decisioni da confermare con Bruno, scritte nel report):**
1. §5.3 non dice cosa fare con un "no" in `link_inviato`: qui è un congedo (`chiuso` + `DA_SCARTARE` "non interessato"), così il follow-up del 6 (B5, che cerca `link_inviato` con inbound) non raggiunge chi si è appena tirato fuori. Task 7.
2. §5.4 non dice cosa fare con un "no" dopo il pitch: stesso congedo con `TESTO_CONGEDO_POST_PITCH`, `chiuso` (che B5 non restituisce al pool) e `DA_SCARTARE`. Task 8.
3. §5.4 non dice cosa succede dopo `scelta_fatta` se il lead riscrive: un "Ricevuto" una volta, poi silenzio, e le sue parole al CRM come nota. Task 8 (`turnoDopoScelta`).
4. Brief del 14/09 (vince sul B4 originale): in `link_inviato` dopo la mezzanotte del giorno dell'evento nessuna assistenza il giorno dopo (silenzio tracciato fino al follow-up). Il Task 5 (`puoRispondere`) è stato allineato in scrittura.
5. §5.4 dice "dal 5/10 21:30"; il codice usa `lancio_evento_at` (21:00) come inizio della notte: chi preme il pulsante prima del pitch viene comunque servito. Nessuna data scritta a mano.
6. `?forza=1` sul blast vale solo con `?solo=<conversationId>`: un run forzato prima del 5/10 senza `solo` risponde 400 invece di mandare il link a tutti i lead in attesa. Task 3.
7. Nessuna ora libera in nessuno dei due giorni: il testo promette "lascio nota" e la nota parte davvero (`sendCrmNota`). Task 8.

**Punti scoperti che restano aperti (non risolvibili qui):**
- Il re-drive di `bot-followups` (che alle 08:30 fa rispondere agli inbound notturni del post-pitch) gira solo su conversazioni con `crm_lead_id` non nullo: un numero sconosciuto il cui push `lead-entrante` è fallito e che scrive fra le 03:00 e le 08:30 riceve risposta solo quando riscrive. Mitigazione già presente: il push del webhook (B2) di norma arriva; il Task 8 lo ritenta a ogni scelta.
- `lancio_info` porta fino a 6 risposte (Task 5), non "le due" della spec: al venditore arriva tutto quello che il lead ha scritto nel post-pitch, troncato a 300 caratteri l'una.

**2. Scan dei segnaposto:** nessun "TBD", "TODO", "implement later", "add error handling", "similar to Task N"; ogni step con codice ha il codice; ogni funzione consumata è definita in un task (o nella tabella "Interfacce del B1 assunte" con firma e task del B1 di origine). Il Task 0 crea stub SOLO copiando il codice canonico del B1, non ne inventa.

**3. Coerenza dei nomi (nota di riconciliazione e B1):**
- Fase: sempre `impostaFaseLancio(supabase, id, fase, campi?)` da `lib/lancio-db.ts` (Task 3, 7 via `congedoLancio`, 8); mai `setLancioFase`.
- Settings: sempre `getLancioSettings(supabase)` → `{ attivo, zoomLink, videoLiveLink, offertaDelMeseLink, eventoAt }` (Task 3 `settings.attivo/eventoAt/zoomLink`; Task 7-8 `ctx.settings.eventoAt/zoomLink`); mai le chiavi grezze fuori dai `missing` del log di configurazione.
- Modello: `generateLancioReply(history, opts)` in `lib/lancio-reply.ts` (Task 6 estende, Task 7-8 consumano tramite `i.genera ?? generateLancioReply`); nessun `lib/lancio-model.ts`.
- Turno: `eseguiTurnoLancio` in `lib/lancio-turno.ts` con lo `switch` (Task 9); i rami in `lib/lancio-assistenza.ts` (Task 7) e `lib/lancio-post-pitch.ts` (Task 8); nessun `lib/lancio-drain.ts` / `turnoLancio`; un solo ramo lancio nel drain (B1), che il Task 9 allarga di un campo.
- Tipi: `LancioInfo`, `LancioSlots`, `LancioKind` (Task 4) usati in Task 5, 8, 9; `OreProponibili`, `GiorniLancio`, `ModoPostPitch`, `LancioTag` (Task 5) usati in Task 6, 8; `LancioReply = LancioReplyParsed & { lancioTag }` (Task 6) è ciò che Task 7-8 leggono (`r.lancioTag`, `r.classe`, `r.passToHuman`, `r.visibleReply`); `StatoTurno`, `ContestoTurno` (Task 7) usati in Task 8-9; `TurnoLancioInput` (B1) allargato in Task 7 (tipo) e consumato in Task 7, 8, 9 con gli stessi campi (`lancioInfo`, `now`, `rows[].created_at`).
- Testi: `TESTO_CONGEDO`, `TESTO_PASSAGGIO_UMANO` dal B1 (`lib/lancio-fase.ts`); tutti gli altri testi fissi del B4 da `lib/lancio-scelta.ts` (Task 5), nessuno riscritto nei turni.
- Eventi: `fenice_ai_reply` con `lancio: true` in ogni turno che risponde o tace definitivamente (B1 e Task 7-8), mai nel silenzio temporaneo (`fuori_orario`).
