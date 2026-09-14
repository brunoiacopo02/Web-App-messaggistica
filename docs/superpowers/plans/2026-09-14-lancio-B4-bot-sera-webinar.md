# Lancio Web Developer AI — B4: blast Zoom, assistenza e scelta della sera (bot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La sera del 5/10 il bot manda a tutti i lead del lancio il link Zoom a lotti (cron a data fissa), fa assistenza fino a mezzanotte, e dopo il pitch fa scegliere a chi ha premuto il pulsante fra "chiamata adesso" e "call domani", registrando la scelta sul CRM con le tre API `/api/bot/lancio/*`.

**Architecture:** Tre pezzi che condividono solo le colonne `lancio_*` e il prompt per fase del B1. (1) Un cron `/api/cron/lancio-zoom` che clona il modello di `send-batch` (lotti, `runPool` a concorrenza 5, idempotenza su `messages.template_sid`) più la doppia idempotenza su `lancio_link_inviato_at` e il filtro del minuto di Roma come `gdo-video-followups`. (2) Un client HTTP `lib/lancio-crm.ts` verso il CRM, firmato HMAC come `sendOutcome`, con timeout 8 s ed errori tipizzati. (3) Un ramo del drain (`turnoLancio` in `lib/lancio-drain.ts`) che, quando `lancio_fase` è valorizzata, sostituisce il turno di Mario con quello del lancio: le regole dure (date ammesse, ora tonda, `at ≥ now+1h`, finestra notturna) e tutti i testi di conferma vivono in `lib/lancio-scelta.ts`, modulo puro; il modello sceglie SOLO fra le ore che il codice gli elenca e le riporta in un tag.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase (postgrest-js), Twilio WhatsApp (Content API), Anthropic SDK (`claude-sonnet-4-6`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md` — §5.3 (blast Zoom e assistenza), §5.4 (sera del 5: pulsante e scelta), §6.2 (contratto delle tre rotte CRM), §9 (blocco B4), §10 (rischi: numero a qualità LOW).

## Global Constraints

- **Perimetro B4 e basta.** Il marker del pulsante `wa.me` e l'adozione dei numeri sconosciuti sono del B2: qui si assume che una conversazione arrivi in `lancio_fase='post_pitch'` con `crm_lead_id` valorizzato. Il follow-up del 6, il flusso standard con la live editata e le restituzioni sono del B5. L'intake, le fasi `attesa`/`posto_bloccato` e le esclusioni dai cron esistenti sono del B1.
- **Nessuna migrazione.** Le colonne `conversations.lancio_slug / lancio_fase / lancio_ingresso / lancio_link_inviato_at / lancio_info` e le chiavi `app_settings` (`lancio_zoom_link`, `lancio_attivo`, `lancio_evento_at`) sono del B1 (spec §3.2).
- **Numero a qualità LOW: nessun messaggio spontaneo** oltre al blast del link e alle risposte di conferma. Ogni messaggio del bot in questo blocco è o il template del blast o una risposta a un inbound del lead.
- **Le risposte di conferma sono testo fisso in codice.** Il modello non scrive mai un'ora: le ore che vede stanno in un blocco che il codice costruisce dalla risposta del CRM, e le riporta in un tag che il codice valida.
- **Regole dure nel codice, non nel prompt** (spec §5.4): date ammesse = giorno dopo il webinar (6/10, ore 9-20) e dopodomani (7/10, ore 9-14); ora tonda (minuti e secondi a zero, fuso Roma); `at ≥ now + 1h`; `[LANCIO:CHIAMA_ORA]` accettato solo nella finestra notturna (5/10 dalle 21:00 al 6/10 03:00). Le date NON si scrivono a mano: si derivano da `lancio_evento_at` (`2026-10-05T21:00:00+02:00`), così la prova generale del B6 può spostare l'orologio e l'evento.
- **Finestra `post_pitch`:** dal 5/10 21:00 (inizio evento) al 6/10 03:00 il bot risponde a qualsiasi ora; dopo le 03:00 la fase resta `post_pitch` ma il bot risponde solo dalle 08:30 alle 23:00 di Roma e propone solo il pomeriggio del 6 o il 7 (un'ora della mattina del 6 si accetta solo se `at ≥ now+1h`). Fase `link_inviato`: risposte dall'invio del link fino alla mezzanotte del 5; poi solo 08:30-23:00.
- **Cron:** schedule in `vercel.json` a data fissa in UTC (`*/5 17-18 5 10 *`); il route filtra sul minuto di Roma (19:30-20:45 del giorno dell'evento). Auth con `CRON_SECRET` (header `Authorization: Bearer` o `?secret=`) come tutti i cron. `maxDuration = 300`.
- **Tag del lancio:** `[LANCIO:CHIAMA_ORA]`, `[LANCIO:PRENOTA|<ISO con offset>]`, `[LANCIO:SLOTS]`, `[LANCIO:NO]`; resta `[PASSAGGIO_UMANO]`. I tag non arrivano MAI al lead: si tolgono dal testo visibile.
- **Chiamate al CRM** firmate con `signPayload(rawBody, BOT_WEBHOOK_SECRET)` in `x-bot-signature` (come `sendOutcome`). URL base `CRM_LANCIO_URL ?? 'https://crm-sales-fenice.vercel.app/api/bot/lancio'`. Timeout 8 s. Il CRM risponde < 3 s per contratto.
- **Env nuove:** `LANCIO_ZOOM_TEMPLATE_SID` (Content SID del template "Link Zoom", `{{1}}`=nome `{{2}}`=link), `LANCIO_BATCH_MAX` (default `400`), `CRM_LANCIO_URL` (opzionale). Esistenti riusate: `BOT_WEBHOOK_SECRET`, `CRON_SECRET`, `TWILIO_WHATSAPP_NUMBER_FENICE`, `UTILITY_ONLY`/`UTILITY_ONLY_ALLOW`.
- **Date reali:** 5/10/2026 è lunedì, 6/10 martedì, 7/10 mercoledì; fuso `+02:00` (l'ora legale finisce il 25/10). Le fixture dei test usano queste date con offset esplicito.
- **Comandi:** test `bunx vitest run <file>` (tutti: `bun run test`), typecheck `bun run typecheck`. Commit su `main` solo a task verde; il deploy parte al push, quindi **non si pusha** finché il B6 non dà l'ok (il cron è inerte fino a `lancio_attivo=1`, ma il ramo del drain no).
- Stile del repo: commenti in italiano che spiegano il PERCHÉ, `event_log` per ogni decisione non ovvia, mai lanciare da un ramo che ha già scritto al lead.

---

## Interfacce del B1 assunte (verificare al Task 0)

Il B1 è in lavorazione in parallelo. Questo piano consuma i nomi seguenti; se al momento dell'esecuzione un modulo non esiste, il Task 0 lo crea con il codice minimo indicato lì (stessa firma), e va segnalato nel report finale perché il B1 lo riassorba.

| Modulo | Firma consumata |
|---|---|
| `lib/lancio-fase.ts` | `type LancioFase = 'attesa' \| 'posto_bloccato' \| 'link_inviato' \| 'post_pitch' \| 'scelta_fatta' \| 'followup_inviato' \| 'restituito' \| 'chiuso'`; `setLancioFase(supabase, conversationId: number, fase: LancioFase, extra?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>` — scrive `lancio_fase` + le colonne in `extra`, logga `lancio_fase` su `event_log`. |
| `lib/lancio-settings.ts` | `type LancioSettings = { lancio_zoom_link: string \| null; lancio_attivo: boolean; lancio_evento_at: string \| null; lancio_video_live_link: string \| null; offerta_del_mese_link: string \| null }`; `getLancioSettings(supabase): Promise<LancioSettings>`. |
| `lib/lancio-prompt.ts` | `type LancioPromptCtx` (esteso qui) e `buildLancioSystem(fase: LancioFase, ctx: LancioPromptCtx): string`. Il B4 aggiunge i rami `link_inviato` e `post_pitch`. |
| `lib/lancio-classifica.ts` | non consumato dal B4 (serve alla fase `attesa`). |
| Colonne | `conversations.lancio_slug text`, `lancio_fase text`, `lancio_ingresso text`, `lancio_link_inviato_at timestamptz`, `lancio_info jsonb`. |
| Drain | Se il B1 ha già messo un ramo `if (lancio_fase)` in `drainMarioReplies`, il Task 9 lo estende invece di aggiungerne un secondo. |

Comportamento dei cron esistenti sui lead lancio (`sequence-touches`, `bot-followups` Track B, `precall-reminders`, `gdo-video-followups`): esclusi dal B1 (spec §5.1). **Attenzione:** il re-drive orario di `bot-followups` (`serveRedrive`) deve restare acceso sulle conversazioni lancio: è lui che alle 08:30 fa rispondere agli inbound arrivati fra le 03:00 e le 08:30. Va verificato al Task 0 e scritto nel report.

---

## File Structure

**Nuovi**
- `lib/run-pool.ts` — `runPool` estratto da `send-batch` (usato dal blast).
- `lib/lancio-zoom-blast.ts` — logica pura del blast: finestra 19:30-20:45 derivata da `lancio_evento_at`, ID riunione dal link, corpo di fallback, tetto del lotto.
- `app/api/cron/lancio-zoom/route.ts` — il cron del blast.
- `lib/lancio-crm.ts` — client HMAC verso `/api/bot/lancio/{slots,book,call-now}`.
- `lib/lancio-scelta.ts` — regole di orario e finestra, validazione di `at`, parsing dei tag `[LANCIO:*]`, ore proponibili, testi fissi (slot in italiano, conferme, errori).
- `lib/lancio-model.ts` — `generateLancioReply(history, system)`: chiamata al modello col system del lancio (mai quello di Mario).
- `lib/lancio-drain.ts` — `turnoLancio` (dispatcher per fase) + turni `link_inviato` e `scelta_fatta` + invio bolle.
- `lib/lancio-post-pitch.ts` — `turnoPostPitch`: le due domande, la scelta, le chiamate al CRM, le conferme.
- Test: `lib/run-pool.test.ts`, `lib/lancio-zoom-blast.test.ts`, `app/api/cron/lancio-zoom/route.test.ts`, `lib/lancio-crm.test.ts`, `lib/lancio-scelta.test.ts`, `lib/lancio-model.test.ts`, `lib/lancio-drain.test.ts`, `lib/lancio-post-pitch.test.ts`.

**Modificati**
- `app/api/cron/send-batch/route.ts` — importa `runPool` da `lib/run-pool.ts` (rimossa la copia privata).
- `vercel.json` — voce `/api/cron/lancio-zoom`.
- `lib/mario.ts` — esporta `normalizzaTurni` (estratto da `generateMarioReply`, nessun cambio di comportamento).
- `lib/lancio-prompt.ts` — rami `link_inviato` e `post_pitch` + campi di `LancioPromptCtx`.
- `lib/fenice-autoreply.ts` — il claim legge `lancio_fase`/`lancio_info`; il ramo lancio prima di `generateMarioReply`.
- `lib/fenice-autoreply.test.ts` — il ramo lancio scavalca Mario.
- `.env.example` — le tre env nuove.

---

### Task 0: Le interfacce del B1 esistono? (verifica, stub minimi solo se mancano)

**Files:**
- Verify/Create: `lib/lancio-fase.ts`, `lib/lancio-settings.ts`, `lib/lancio-prompt.ts`
- Verify: `lib/supabase/types.ts` (colonne `lancio_*` su `conversations`), `lib/fenice-autoreply.ts` (ramo lancio già presente?), `lib/bot-followups.ts` (re-drive acceso sui lancio)

**Interfaces:**
- Consumes: niente.
- Produces: `LancioFase`, `setLancioFase`, `LancioSettings`, `getLancioSettings`, `buildLancioSystem`, `LancioPromptCtx` con le firme della tabella sopra.

- [ ] **Step 1: Verifica cosa c'è**

Run: `ls lib/lancio-*.ts; grep -n "lancio_fase\|lancio_info\|lancio_link_inviato_at" lib/supabase/types.ts | head; grep -n "lancio" lib/fenice-autoreply.ts lib/bot-followups.ts app/api/cron/bot-followups/route.ts`
Expected: o i tre moduli esistono con le firme della tabella (→ salta agli Step 5-6), oppure mancano (→ Step 2-4). Se `types.ts` non ha le colonne, aggiungerle a mano nei tre blocchi `Row`/`Insert`/`Update` di `conversations` (come `ai_lock_at: string | null`) — la migrazione è del B1, ma il typecheck di questo piano ne ha bisogno.

- [ ] **Step 2: (solo se manca) `lib/lancio-fase.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/** Le fasi del lancio, nell'ordine in cui una conversazione le attraversa (spec §3.2). */
export type LancioFase =
  | 'attesa' | 'posto_bloccato' | 'link_inviato' | 'post_pitch'
  | 'scelta_fatta' | 'followup_inviato' | 'restituito' | 'chiuso';

/**
 * Cambia fase e, nello stesso update, le colonne di `extra` (es. `lancio_link_inviato_at`).
 * postgrest-js non rigetta mai la promise: l'errore torna come valore e va letto, o una
 * fase mai scritta passa per scritta e il cron dopo rimanda lo stesso messaggio.
 */
export async function setLancioFase(
  supabase: Supa,
  conversationId: number,
  fase: LancioFase,
  extra: Record<string, unknown> = {},
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('conversations')
    .update({ lancio_fase: fase, ...extra } as never)
    .eq('id', conversationId);
  if (error) {
    await supabase.from('event_log').insert({
      type: 'lancio_fase_non_scritta',
      payload: { conversationId, fase, extra, errore: error.message } as never,
      message: `[lancio] conv ${conversationId}: fase '${fase}' NON scritta — ${error.message}`,
      level: 'error',
    });
    return { ok: false, error: error.message };
  }
  await supabase.from('event_log').insert({
    type: 'lancio_fase',
    payload: { conversationId, fase, ...extra } as never,
    message: `[lancio] conv ${conversationId} → ${fase}`,
    level: 'info',
  });
  return { ok: true };
}
```

- [ ] **Step 3: (solo se manca) `lib/lancio-settings.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type LancioSettings = {
  lancio_zoom_link: string | null;
  lancio_attivo: boolean;
  lancio_evento_at: string | null;
  lancio_video_live_link: string | null;
  offerta_del_mese_link: string | null;
};

const CHIAVI = ['lancio_zoom_link', 'lancio_attivo', 'lancio_evento_at', 'lancio_video_live_link', 'offerta_del_mese_link'] as const;

/** Le impostazioni del lancio da `app_settings`, una query sola. Chiave assente ⇒ null/false. */
export async function getLancioSettings(supabase: Supa): Promise<LancioSettings> {
  const { data } = await supabase.from('app_settings').select('key, value').in('key', [...CHIAVI]);
  const mappa = new Map((data ?? []).map((r) => [r.key as string, r.value as unknown]));
  const testo = (k: string): string | null => {
    const v = mappa.get(k);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const attivo = mappa.get('lancio_attivo');
  return {
    lancio_zoom_link: testo('lancio_zoom_link'),
    lancio_attivo: attivo === true || attivo === 1 || attivo === '1' || attivo === 'true',
    lancio_evento_at: testo('lancio_evento_at'),
    lancio_video_live_link: testo('lancio_video_live_link'),
    offerta_del_mese_link: testo('offerta_del_mese_link'),
  };
}
```

- [ ] **Step 4: (solo se manca) `lib/lancio-prompt.ts` scheletro**

```ts
import type { LancioFase } from './lancio-fase';

/** Quello che il prompt di una fase deve sapere. I campi delle fasi del B4 (assistenza e
 *  post_pitch) si aggiungono al Task 6; qui il minimo perché il B1 compili. */
export type LancioPromptCtx = {
  nome: string | null;
  /** "lunedì 5 ottobre alle 21:00" */
  eventoLabel: string;
  oraRoma: string;
};

export function buildLancioSystem(fase: LancioFase, ctx: LancioPromptCtx): string {
  switch (fase) {
    default:
      throw new Error(`prompt lancio non definito per la fase '${fase}'`);
  }
}
```

- [ ] **Step 5: Verifica il re-drive sui lead lancio**

Leggi `app/api/cron/bot-followups/route.ts` e `lib/bot-followups.ts`: se il B1 ha escluso le conversazioni con `lancio_slug` dall'INTERO cron (non solo dai nudge Track B e dalla classificazione), il re-drive non scatterebbe e gli inbound notturni (03:00-08:30) resterebbero senza risposta. Scrivi l'esito nel report finale; se serve, la correzione è del B1 (una riga: il pre-filtro `serveCronologia` deve lasciar passare il caso re-drive anche con `lancio_slug`).

- [ ] **Step 6: Typecheck e commit (solo se hai creato qualcosa)**

Run: `bun run typecheck`
Expected: nessun errore.

```bash
git add lib/lancio-fase.ts lib/lancio-settings.ts lib/lancio-prompt.ts lib/supabase/types.ts
git commit -m "chore(lancio): interfacce minime del B1 per il B4 (fase, settings, prompt)"
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
- Consumes: `inFinestraBlast`, `zoomBlastBody`, `batchMax`, `LANCIO_BLAST_CONCURRENCY` (Task 2); `runPool` (Task 1); `getLancioSettings(supabase)` e `setLancioFase(supabase, id, 'link_inviato', { lancio_link_inviato_at })` (Task 0); `sendTemplate({ to, contentSid, variables, from })` e `getTemplateBody(sid)` da `lib/twilio.ts`; `renderBodyTemplate(body, vars)` da `lib/campaigns.ts`; `templateName(raw)` da `lib/name.ts`.
- Produces: `GET /api/cron/lancio-zoom` → `{ ok, skipped?, candidati, sent, riparati, capped, failed, report }`. Parametri: `?dry=1` (conta e basta), `?now=<ISO>` (orologio forzato per la prova generale del B6; vale solo con l'auth del cron).

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

const settings = {
  lancio_zoom_link: 'https://us06web.zoom.us/j/89845223337', lancio_attivo: true,
  lancio_evento_at: '2026-10-05T21:00:00+02:00', lancio_video_live_link: null, offerta_del_mese_link: null,
};
vi.mock('@/lib/lancio-settings', () => ({ getLancioSettings: async () => settings }));

const setLancioFase = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/lancio-fase', () => ({ setLancioFase: (...a: unknown[]) => setLancioFase(...a) }));

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
  settings.lancio_attivo = true;
  sendTemplate.mockReset().mockResolvedValue({ sid: 'SM1', status: 'queued' });
  setLancioFase.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/cron/lancio-zoom — cancelli', () => {
  it('senza segreto: 401', async () => {
    const res = await GET(new Request('https://x/api/cron/lancio-zoom') as never);
    expect(res.status).toBe(401);
  });
  it('lancio non attivo: nessuna query, nessun invio', async () => {
    settings.lancio_attivo = false;
    await expect((await chiama()).json()).resolves.toMatchObject({ skipped: 'lancio_non_attivo' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });
  it('fuori dalla finestra di Roma: skip', async () => {
    const res = await GET(new Request(url('2026-10-05T19:20:00+02:00')) as never);
    await expect(res.json()).resolves.toMatchObject({ skipped: 'fuori_finestra' });
    expect(sendTemplate).not.toHaveBeenCalled();
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
    expect(setLancioFase).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/lancio-zoom — invio', () => {
  it('manda il template con nome proprio e link, registra il messaggio e passa a link_inviato', async () => {
    await expect((await chiama()).json()).resolves.toMatchObject({ sent: 2, failed: 0, capped: 0 });
    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      to: '+39333000001', contentSid: SID, variables: { '1': 'Mario', '2': settings.lancio_zoom_link },
    }));
    const msg = inserimenti('messages');
    expect(msg).toHaveLength(2);
    expect(msg[0]).toMatchObject({ template_sid: SID, is_template: true, direction: 'out', sender: 'automazione' });
    expect(String(msg[0].body)).toContain('Ciao Mario, link: https://us06web.zoom.us/j/89845223337');
    expect(setLancioFase).toHaveBeenCalledWith(expect.anything(), 1, 'link_inviato', { lancio_link_inviato_at: expect.any(String) });
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
    expect(setLancioFase).toHaveBeenCalledWith(expect.anything(), 1, 'link_inviato', expect.anything());
  });
  it('63049: nessuna riga messages, fase invariata, si riprova al run dopo', async () => {
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('cap'), { code: 63049 }));
    await expect((await chiama()).json()).resolves.toMatchObject({ sent: 1, capped: 1 });
    expect(inserimenti('messages')).toHaveLength(1);
    expect(setLancioFase).toHaveBeenCalledTimes(1);
    expect(inserimenti('event_log').map((e) => e.type)).toContain('lancio_zoom_freq_capped');
  });
  it('altro errore Twilio: riga failed, send_error, fase invariata', async () => {
    sendTemplate.mockRejectedValueOnce(Object.assign(new Error('giu'), { code: 20429 }));
    await expect((await chiama()).json()).resolves.toMatchObject({ sent: 1, failed: 1 });
    expect(inserimenti('messages').some((m) => m.twilio_status === 'failed' && m.template_sid === SID)).toBe(true);
    expect(inserimenti('event_log').map((e) => e.type)).toContain('send_error');
    expect(setLancioFase).toHaveBeenCalledTimes(1);
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
import { setLancioFase } from '@/lib/lancio-fase';
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
  if (!settings.lancio_attivo) return NextResponse.json({ ok: true, skipped: 'lancio_non_attivo' });

  const eventoMs = settings.lancio_evento_at ? Date.parse(settings.lancio_evento_at) : NaN;
  if (Number.isNaN(eventoMs)) return configError(supabase, ['lancio_evento_at']);
  const now = orologio(req);
  if (!inFinestraBlast(now, new Date(eventoMs))) return NextResponse.json({ ok: true, skipped: 'fuori_finestra' });

  const sid = process.env.LANCIO_ZOOM_TEMPLATE_SID;
  const link = settings.lancio_zoom_link;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const missing = [
    !sid && 'LANCIO_ZOOM_TEMPLATE_SID',
    !link && 'lancio_zoom_link',
    !from && 'TWILIO_WHATSAPP_NUMBER_FENICE',
  ].filter((x): x is string => typeof x === 'string');
  if (missing.length > 0 || !sid || !link) return configError(supabase, missing);

  const dry = req.nextUrl.searchParams.get('dry') === '1';
  const max = batchMax(process.env.LANCIO_BATCH_MAX);

  const { data } = await supabase
    .from('conversations')
    .select('id, leads(phone_e164, first_name)')
    .not('lancio_slug', 'is', null)
    .in('lancio_fase', ['attesa', 'posto_bloccato'])
    .is('lancio_link_inviato_at', null)
    .order('id', { ascending: true })
    .limit(max);
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
      await setLancioFase(supabase, c.id, 'link_inviato', { lancio_link_inviato_at: inviatoAt });
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
      await setLancioFase(supabase, c.id, 'link_inviato', { lancio_link_inviato_at: new Date().toISOString() });
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
  it('link_inviato: dal blast a mezzanotte, poi solo 08:30-23:00', () => {
    expect(puoRispondere(t('2026-10-05T19:35:00+02:00'), EVENTO, 'link_inviato')).toBe(true);
    expect(puoRispondere(t('2026-10-05T23:50:00+02:00'), EVENTO, 'link_inviato')).toBe(true);
    expect(puoRispondere(t('2026-10-06T00:10:00+02:00'), EVENTO, 'link_inviato')).toBe(false);
    expect(puoRispondere(t('2026-10-06T10:00:00+02:00'), EVENTO, 'link_inviato')).toBe(true);
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
 * guardando la live o ha appena premuto il pulsante); fuori, solo 08:30-23:00 di Roma —
 * un inbound delle 04:00 lo riprende il re-drive di `bot-followups` alle 08:30.
 */
export function puoRispondere(now: Date, eventoAt: Date, fase: 'link_inviato' | 'post_pitch'): boolean {
  const { giornoDopo } = giorniLancio(eventoAt);
  const ms = now.getTime();
  const da = fase === 'link_inviato' ? eventoAt.getTime() - ASSISTENZA_DA_MIN_PRIMA * 60_000 : eventoAt.getTime();
  const a = fase === 'link_inviato' ? istante(giornoDopo, '00:00') : istante(giornoDopo, FINE_NOTTE_HHMM);
  if (ms >= da && ms < a) return true;
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
