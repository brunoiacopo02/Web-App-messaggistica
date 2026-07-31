# Follow-up video e promemoria Noemi per i lead GDO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Che il lead di un GDO arrivi alla videocall avendo visto il video di preparazione e sapendo che Noemi lo chiamerà, senza martellarlo e senza scavalcare il commerciale che lo sta lavorando.

**Architecture:** Un cron nuovo e isolato decide, per ogni conversazione postino, se mandare il video (a chi non ha mai risposto), un sollecito scritto dal modello (dove la finestra 24h è aperta) o un sollecito template (dove è chiusa). La decisione è un modulo puro senza effetti. I promemoria dentro la chat non sono messaggi separati: si agganciano alla `contextNote` che `generateMarioReply` accetta già e che la modalità postino usa, così il modello li integra nel discorso.

**Tech Stack:** Next.js (App Router, route handler + Vercel cron), TypeScript, Supabase (PostgREST), Twilio Content API, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-gdo-video-followup-design.md`

**Fuori da questo piano:** le note al CRM (fase 3 della spec). La variante `outcome: 'NOTA'` non è mai stata esercitata in produzione e va provata con loro prima di costruirci sopra.

## Global Constraints

- **Due touch per lead, mai di più**, ancorati al giorno dell'agenda: 21:30 del giorno in cui il lead riceve l'agenda, 10:00 del giorno dopo.
- **Se si sta già parlando col lead, il sollecito automatico NON parte.** Il promemoria vive dentro la conversazione.
- **Mai scrivere a chi ha già confermato di aver visto il video.**
- **Fail-closed sui template**: se il SID della variante manca in env non si inventa niente — si logga `level: 'error'` e si salta. È la regola nata dall'errore del 30/07.
- **Tono di Noemi invariato**: nessuna minaccia. `mario-prompt.test.ts` lo presidia (`'Se ti scappa la chiamata non è un problema'`).
- **Durata della preselezione: 5-10 minuti**, mai "pochi minuti".
- Il bot **non tocca mai** `bot_outcome`, `bot_scheduled_at` né `ai_status` di un lead GDO: non è nostro.
- Copy e commenti in italiano. Commit in italiano, imperativo, prefisso convenzionale.
- Test: `npm test` (Vitest, file `lib/*.test.ts`). Tipi: `npm run typecheck`. Lint: `npm run lint`.

## File Structure

| File | Responsabilità |
|---|---|
| `supabase/migrations/20260801000001_gdo_video_followup.sql` *(nuovo)* | quattro colonne di stato |
| `lib/supabase/types.ts` *(modifica)* | allinea il tipo `conversations` |
| `lib/rome-time.ts` *(modifica)* | giorno e minuto di Roma, per ancorare gli slot |
| `lib/gdo-video-followup.ts` *(nuovo)* | decisione pura + mappa link→env del template video |
| `lib/gdo-video-followup.test.ts` *(nuovo)* | test della decisione |
| `lib/gdo-context-note.ts` *(nuovo)* | composizione delle note di contesto per il modello |
| `lib/gdo-context-note.test.ts` *(nuovo)* | test della composizione |
| `app/api/cron/gdo-video-followups/route.ts` *(nuovo)* | il cron: raccoglie, decide, invia |
| `vercel.json` *(modifica)* | schedule del cron |
| `lib/fenice-autoreply.ts` *(modifica)* | scrive `gdo_video_watched_at`, usa la nota composta, marca Noemi |
| `lib/mario-prompt.ts` *(modifica)* | durata della preselezione |
| `lib/mario-prompt.test.ts` *(modifica)* | asserzioni sulla durata |

---

### Task 1: Colonne di stato

**Files:**
- Create: `supabase/migrations/20260801000001_gdo_video_followup.sql`
- Modify: `lib/supabase/types.ts` (blocco `conversations`)

**Interfaces:**
- Consumes: niente.
- Produces: su `public.conversations` le colonne `gdo_video_watched_at timestamptz`, `gdo_video_followups_sent smallint not null default 0`, `gdo_noemi_reminded_at timestamptz`, `gdo_appuntamento_at timestamptz`. Tutti i task successivi le leggono e scrivono.

**Nota:** questo task crea solo il file. L'applicazione in produzione è il Task 8, e va fatta **prima** del deploy del codice — vedi la nota nel Task 8.

- [ ] **Step 1: Scrivere la migration**

Creare `supabase/migrations/20260801000001_gdo_video_followup.sql`:

```sql
-- Follow-up del video per i lead dei GDO.
--
-- Il flusso postino consegna agenda e video e poi si ferma: questi lead sono esclusi da
-- sequenza, follow-up agenda, watchdog e promemoria pre-call. Queste colonne reggono i
-- due soli solleciti previsti (21:30 del giorno dell'agenda, 10:00 del giorno dopo) e il
-- promemoria di Noemi, che si dà una volta sola.

alter table public.conversations
  add column if not exists gdo_video_watched_at timestamptz,
  add column if not exists gdo_video_followups_sent smallint not null default 0,
  add column if not exists gdo_noemi_reminded_at timestamptz,
  add column if not exists gdo_appuntamento_at timestamptz;

comment on column public.conversations.gdo_video_watched_at is
  'Quando il lead ha confermato di aver visto il video. Il segnale esisteva già (videoWatched del modello) ma finiva solo in event_log, che non è interrogabile per decidere.';
comment on column public.conversations.gdo_video_followups_sent is
  'Quanti solleciti video sono partiti: 0, 1 o 2. Mai di più.';
comment on column public.conversations.gdo_noemi_reminded_at is
  'Quando il bot ha spiegato la chiamata di Noemi. Valorizzato = non si ripete.';
comment on column public.conversations.gdo_appuntamento_at is
  'Data della videocall. Il payload del CRM oggi NON la manda (verificato il 31/07 su lib/bot-contract.ts): la colonna nasce vuota e si valorizza appena il campo arriva, per non richiedere una seconda migration.';
```

Nessun indice: il cron filtra su `gdo_agenda_at`, che ha già il suo indice parziale (migration `20260729000001`).

- [ ] **Step 2: Allineare i tipi generati**

In `lib/supabase/types.ts`, nel blocco `conversations`, aggiungere a `Row` le quattro colonne (`gdo_video_watched_at: string | null`, `gdo_video_followups_sent: number`, `gdo_noemi_reminded_at: string | null`, `gdo_appuntamento_at: string | null`) e le versioni opzionali a `Insert` e `Update`. Sopra il blocco, il commento:

```ts
      // NB: le colonne gdo_video_* e gdo_appuntamento_at (migration 20260801000001)
      // sono aggiunte a mano in attesa del prossimo `npm run supabase:gen-types`, che
      // le riprodurrà identiche. Stesso trattamento già dato a `messages.sender`.
```

- [ ] **Step 3: Verificare i tipi**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260801000001_gdo_video_followup.sql lib/supabase/types.ts
git commit -m "feat(gdo): colonne di stato per i solleciti video e il promemoria Noemi"
```

---

### Task 2: Persistere la conferma di visione

**Files:**
- Modify: `lib/fenice-autoreply.ts` (blocco `if (result.videoWatched)`, oggi alle righe 379-386)
- Test: `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Consumes: `conversations.gdo_video_watched_at` (Task 1).
- Produces: la colonna viene valorizzata quando il modello segnala `videoWatched`. Il Task 3 ci costruisce sopra la regola "chi ha visto il video non riceve solleciti".

**Perché:** oggi `videoWatched` scrive **solo** su `event_log`. Un log non si interroga per decidere se mandare un messaggio.

- [ ] **Step 1: Scrivere il test che fallisce**

`lib/fenice-autoreply.test.ts` ha già il fake `makeDrainSupabase(claimedRow, rows)` che restituisce `{ supabase, calls }` e traccia gli update su `conversations` in `calls.convUpdates`. Aggiungere in coda al `describe` che usa quel fake:

```ts
  it('la conferma di visione del video finisce anche su gdo_video_watched_at', async () => {
    const claimedRow: ClaimedRow = { id: 60, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'FATTO, visto tutto', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Perfetto, me lo segno.',
      appointmentFixed: false, passToHuman: false, videoWatched: true,
    });

    await drainMarioReplies(supabase, 60, '+391234567890', () => 0);

    expect(calls.convUpdates.some((u) => typeof u.gdo_video_watched_at === 'string')).toBe(true);
  });
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/fenice-autoreply.test.ts`
Expected: FAIL — nessun update contiene `gdo_video_watched_at`.

- [ ] **Step 3: Implementare**

Nel blocco `if (result.videoWatched)` di `lib/fenice-autoreply.ts`, prima dell'insert su `event_log`, aggiungere:

```ts
        // Il log non si interroga per decidere: la conferma serve al cron dei solleciti,
        // che deve smettere di scrivere a chi il video l'ha già visto.
        await supabase.from('conversations')
          .update({ gdo_video_watched_at: new Date().toISOString() })
          .eq('id', conversationId);
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `npm test -- lib/fenice-autoreply.test.ts`
Expected: PASS, compresi i test preesistenti.

- [ ] **Step 5: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(gdo): la conferma di visione del video diventa uno stato, non solo un log"
```

---

### Task 3: La decisione

**Files:**
- Modify: `lib/rome-time.ts`
- Create: `lib/gdo-video-followup.ts`
- Test: `lib/gdo-video-followup.test.ts`

**Interfaces:**
- Consumes: niente a runtime.
- Produces:
  - `romeDayKey(date: Date): string` → `'YYYY-MM-DD'` nel fuso di Roma
  - `romeMinute(date: Date): number`
  - `type GdoFollowupAction = 'video-template' | 'sollecito-libero' | 'sollecito-template' | 'none'`
  - `type GdoSlot = 'sera' | 'mattina'`
  - `decideGdoVideoFollowup(input: GdoFollowupInput): GdoFollowupAction`
  - `CONVERSAZIONE_VIVA_MS`, `FINESTRA_24H_MS`
  - `VIDEO_TEMPLATE_ENV_BY_LINK: Record<string, string>`
  
  Il Task 5 (cron) è l'unico consumatore.

- [ ] **Step 1: Aggiungere i due helper di Roma**

In coda a `lib/rome-time.ts`:

```ts
const romeDayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Giorno di calendario italiano, 'YYYY-MM-DD'. Serve ad ancorare gli slot dei
 *  solleciti al giorno in cui il lead ha ricevuto l'agenda, non alle ore trascorse. */
export function romeDayKey(date: Date): string {
  return romeDayKeyFmt.format(date);
}

/** Minuti (0–59) di `date` nel fuso Europe/Rome. Il fuso non cambia i minuti, ma
 *  leggerli da qui tiene tutta la logica oraria in un posto solo. */
export function romeMinute(date: Date): number {
  return date.getUTCMinutes();
}

/** Giorni di calendario italiani fra due istanti. Le chiavi 'YYYY-MM-DD' si
 *  parsano a mezzanotte UTC, quindi la differenza è un intero esatto di giorni. */
export function romeDaysBetween(from: Date, to: Date): number {
  return Math.round((Date.parse(romeDayKey(to)) - Date.parse(romeDayKey(from))) / 86_400_000);
}
```

- [ ] **Step 2: Scrivere il test che fallisce**

Creare `lib/gdo-video-followup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decideGdoVideoFollowup, VIDEO_TEMPLATE_ENV_BY_LINK, type GdoFollowupInput } from './gdo-video-followup';
import { romeDaysBetween, romeDayKey } from './rome-time';

const H = 3600_000;
const ORA = Date.parse('2026-08-01T19:30:00Z'); // 21:30 italiane

/** Caso base: agenda oggi, lead che non ha mai risposto, slot serale. */
const base = (over: Partial<GdoFollowupInput> = {}): GdoFollowupInput => ({
  gdoAgendaAt: '2026-08-01T14:00:00Z',
  gdoVideoSentAt: null,
  gdoVideoWatchedAt: null,
  followupsSent: 0,
  appointmentAt: null,
  lastInboundAtMs: null,
  lastMessageIsInbound: false,
  nowMs: ORA,
  slot: 'sera',
  giorniDaAgenda: 0,
  romeHourAgenda: 16,
  ...over,
});

describe('decideGdoVideoFollowup — chi non ha mai risposto', () => {
  it('la sera dell\'agenda riceve il video via template', () => {
    expect(decideGdoVideoFollowup(base())).toBe('video-template');
  });

  it('il mattino dopo riceve il sollecito, fuori finestra quindi template', () => {
    expect(decideGdoVideoFollowup(base({
      slot: 'mattina', giorniDaAgenda: 1, followupsSent: 1,
      gdoVideoSentAt: '2026-08-01T19:30:00Z',
    }))).toBe('sollecito-template');
  });
});

describe('decideGdoVideoFollowup — chi ha risposto', () => {
  it('con finestra aperta il sollecito lo scrive il modello', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-08-01T15:00:00Z',
      lastInboundAtMs: ORA - 8 * H,
    }))).toBe('sollecito-libero');
  });

  it('con finestra chiusa si ricade sul template', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-07-31T15:00:00Z',
      lastInboundAtMs: ORA - 30 * H,
    }))).toBe('sollecito-template');
  });
});

describe('decideGdoVideoFollowup — quando tacere', () => {
  it('non è un lead postino', () => {
    expect(decideGdoVideoFollowup(base({ gdoAgendaAt: null }))).toBe('none');
  });

  it('ha già confermato di aver visto il video', () => {
    expect(decideGdoVideoFollowup(base({ gdoVideoWatchedAt: '2026-08-01T18:00:00Z' }))).toBe('none');
  });

  it('ha già ricevuto i due touch previsti', () => {
    expect(decideGdoVideoFollowup(base({ followupsSent: 2 }))).toBe('none');
  });

  it('lo slot serale non appartiene al giorno dell\'agenda', () => {
    expect(decideGdoVideoFollowup(base({ giorniDaAgenda: 1 }))).toBe('none');
  });

  it('lo slot del mattino vale solo il giorno dopo l\'agenda', () => {
    expect(decideGdoVideoFollowup(base({ slot: 'mattina', giorniDaAgenda: 0 }))).toBe('none');
    expect(decideGdoVideoFollowup(base({ slot: 'mattina', giorniDaAgenda: 2 }))).toBe('none');
  });

  it('la call è già passata', () => {
    expect(decideGdoVideoFollowup(base({ appointmentAt: '2026-08-01T16:00:00Z' }))).toBe('none');
  });

  it('agenda arrivata dopo le 18 e call ignota: niente sollecito serale', () => {
    // Ripiego finché il CRM non manda appointmentAt: una call fissata a ridosso
    // potrebbe essere già avvenuta.
    expect(decideGdoVideoFollowup(base({ romeHourAgenda: 19 }))).toBe('none');
    // Con la data vera e futura, invece, si procede.
    expect(decideGdoVideoFollowup(base({
      romeHourAgenda: 19, appointmentAt: '2026-08-03T09:00:00Z',
    }))).toBe('video-template');
  });

  it('si sta parlando col lead: il promemoria lo porta la chat', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-08-01T15:00:00Z', lastInboundAtMs: ORA - 2 * H,
    }))).toBe('none');
  });

  it('c\'è una sua domanda senza risposta: ci pensa il re-drive', () => {
    expect(decideGdoVideoFollowup(base({
      gdoVideoSentAt: '2026-08-01T15:00:00Z',
      lastInboundAtMs: ORA - 8 * H,
      lastMessageIsInbound: true,
    }))).toBe('none');
  });
});

describe('mappa dei template video', () => {
  it('copre tutte e cinque le varianti', () => {
    expect(Object.keys(VIDEO_TEMPLATE_ENV_BY_LINK)).toHaveLength(5);
    expect(Object.values(VIDEO_TEMPLATE_ENV_BY_LINK)).toContain('VIDEO_GDO_OFFERTA_SID');
  });
});

describe('romeDaysBetween', () => {
  it('conta i giorni di calendario, non le 24 ore', () => {
    // 23:30 e 00:30 italiane distano un'ora ma sono due giorni diversi.
    const sera = new Date('2026-08-01T21:30:00Z');
    const notte = new Date('2026-08-01T22:30:00Z');
    expect(romeDaysBetween(sera, notte)).toBe(1);
    expect(romeDayKey(sera)).toBe('2026-08-01');
  });
});
```

- [ ] **Step 3: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/gdo-video-followup.test.ts`
Expected: FAIL — `Cannot find module './gdo-video-followup'`.

- [ ] **Step 4: Implementare**

Creare `lib/gdo-video-followup.ts`:

```ts
import { BLACK_SUMMER_LINK } from './gdo-agenda';

/**
 * Solleciti del video ai lead dei GDO: due touch, ancorati al giorno in cui il lead
 * riceve l'agenda (21:30 quel giorno, 10:00 il giorno dopo). Qui la sola decisione,
 * senza effetti: il cron la usa e agisce.
 */

export type GdoFollowupAction = 'video-template' | 'sollecito-libero' | 'sollecito-template' | 'none';
export type GdoSlot = 'sera' | 'mattina';

/** Sotto questa soglia si sta parlando col lead: il promemoria lo porta la chat. */
export const CONVERSAZIONE_VIVA_MS = 6 * 3600_000;
/** Oltre questa, WhatsApp accetta solo template. */
export const FINESTRA_24H_MS = 24 * 3600_000;
/** Ripiego finché il CRM non manda la data della call. */
export const ORA_AGENDA_TARDI = 18;

export interface GdoFollowupInput {
  gdoAgendaAt: string | null;
  gdoVideoSentAt: string | null;
  gdoVideoWatchedAt: string | null;
  followupsSent: number;
  /** Data della call. Oggi il CRM non la manda: quasi sempre null. */
  appointmentAt: string | null;
  lastInboundAtMs: number | null;
  lastMessageIsInbound: boolean;
  nowMs: number;
  slot: GdoSlot;
  /** Giorni di calendario italiani fra l'agenda e adesso: 0 = stessa giornata. */
  giorniDaAgenda: number;
  /** Ora italiana in cui è arrivata l'agenda. */
  romeHourAgenda: number;
}

export function decideGdoVideoFollowup(i: GdoFollowupInput): GdoFollowupAction {
  if (!i.gdoAgendaAt) return 'none';

  // Gli slot appartengono a UNA agenda: la sera è quella stessa giornata, il mattino
  // è il giorno dopo. Un'agenda di tre giorni fa non ha più slot da servire.
  const giorniAttesi = i.slot === 'sera' ? 0 : 1;
  if (i.giorniDaAgenda !== giorniAttesi) return 'none';

  // Un sollecito dopo la call è solo danno.
  if (i.appointmentAt) {
    const at = Date.parse(i.appointmentAt);
    if (!Number.isNaN(at) && at <= i.nowMs) return 'none';
  } else if (i.slot === 'sera' && i.romeHourAgenda >= ORA_AGENDA_TARDI) {
    // Senza la data vera, un'agenda arrivata a sera è probabilmente una call a
    // ridosso — o già avvenuta. Si tace e si riprova il mattino dopo.
    return 'none';
  }

  if (i.gdoVideoWatchedAt) return 'none';
  if (i.followupsSent >= 2) return 'none';

  const daUltimoInbound = i.lastInboundAtMs === null ? null : i.nowMs - i.lastInboundAtMs;

  // Si sta parlando: un messaggio programmato addosso stona, e il promemoria arriva
  // comunque dentro la risposta del modello (lib/gdo-context-note.ts).
  if (daUltimoInbound !== null && daUltimoInbound < CONVERSAZIONE_VIVA_MS) return 'none';

  // Sua domanda senza risposta: ci pensa il re-drive di bot-followups. Due nostri
  // messaggi di fila sarebbero maleducati.
  if (i.lastMessageIsInbound) return 'none';

  if (!i.gdoVideoSentAt) return 'video-template';

  const finestraAperta = daUltimoInbound !== null && daUltimoInbound < FINESTRA_24H_MS;
  return finestraAperta ? 'sollecito-libero' : 'sollecito-template';
}

/**
 * Quale variabile d'ambiente contiene il template video per un dato link.
 * Fail-closed: un link non in mappa, o una env vuota, non produce nessun invio.
 */
export const VIDEO_TEMPLATE_ENV_BY_LINK: Record<string, string> = {
  'https://corso.feniceacademy.it/conferenza-bx': 'VIDEO_GDO_LAVORA_SID',
  'https://corso.feniceacademy.it/conferenza-axmsbn9r50': 'VIDEO_GDO_NONLAVORA_SID',
  'https://corso.feniceacademy.it/conferenza-dx': 'VIDEO_GDO_LAVORA_FAMIGLIA_SID',
  'https://corso.feniceacademy.it/conferenza-ex': 'VIDEO_GDO_NONLAVORA_FAMIGLIA_SID',
  [BLACK_SUMMER_LINK]: 'VIDEO_GDO_OFFERTA_SID',
};
```

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `npm test -- lib/gdo-video-followup.test.ts lib/rome-time.test.ts`
Expected: PASS. Se `lib/rome-time.test.ts` non esiste, esegui solo il primo.

- [ ] **Step 6: Commit**

```bash
git add lib/gdo-video-followup.ts lib/gdo-video-followup.test.ts lib/rome-time.ts
git commit -m "feat(gdo): la decisione dei solleciti video, ancorata al giorno dell'agenda"
```

---

### Task 4: Le note di contesto per il modello

**Files:**
- Create: `lib/gdo-context-note.ts`
- Test: `lib/gdo-context-note.test.ts`

**Interfaces:**
- Consumes: `GDO_CONTEXT_NOTE` da `lib/mario.ts` (già esistente, esportata).
- Produces:
  - `interface GdoNoteInput { gdoVideoSentAt: string | null; gdoVideoWatchedAt: string | null; gdoNoemiRemindedAt: string | null; followupsSent: number; videoAppenaConfermato: boolean }`
  - `gdoContextNote(input: GdoNoteInput): string` — la nota completa da passare a `generateMarioReply({ contextNote })`
  - `NOTA_VIDEO`, `NOTA_NOEMI` (le due stringhe, esportate per i test)
  - `serveNoemi(input: GdoNoteInput): boolean`

  Il Task 6 è l'unico consumatore.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `lib/gdo-context-note.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { gdoContextNote, serveNoemi, NOTA_VIDEO, NOTA_NOEMI, type GdoNoteInput } from './gdo-context-note';
import { GDO_CONTEXT_NOTE } from './mario';

const base = (over: Partial<GdoNoteInput> = {}): GdoNoteInput => ({
  gdoVideoSentAt: '2026-08-01T15:00:00Z',
  gdoVideoWatchedAt: null,
  gdoNoemiRemindedAt: null,
  followupsSent: 0,
  videoAppenaConfermato: false,
  ...over,
});

describe('gdoContextNote', () => {
  it('parte sempre dal contesto postino esistente', () => {
    expect(gdoContextNote(base())).toContain(GDO_CONTEXT_NOTE);
  });

  it('ricorda il video finché non è confermato', () => {
    expect(gdoContextNote(base())).toContain(NOTA_VIDEO);
  });

  it('non lo ricorda più una volta confermato', () => {
    expect(gdoContextNote(base({ gdoVideoWatchedAt: '2026-08-01T20:00:00Z' }))).not.toContain(NOTA_VIDEO);
  });

  it('non lo ricorda se il video non è ancora partito', () => {
    expect(gdoContextNote(base({ gdoVideoSentAt: null }))).not.toContain(NOTA_VIDEO);
  });
});

describe('serveNoemi', () => {
  it('quando il lead conferma di aver visto il video', () => {
    expect(serveNoemi(base({ videoAppenaConfermato: true }))).toBe(true);
  });

  it('quando risponde dopo che gli è arrivato un sollecito', () => {
    expect(serveNoemi(base({ followupsSent: 1 }))).toBe(true);
  });

  it('mai due volte', () => {
    expect(serveNoemi(base({ videoAppenaConfermato: true, gdoNoemiRemindedAt: '2026-08-01T20:00:00Z' }))).toBe(false);
  });

  it('non a chi non ha ancora fatto niente', () => {
    expect(serveNoemi(base())).toBe(false);
  });
});

describe('contenuto del promemoria Noemi', () => {
  it('dice la durata vera, non "pochi minuti"', () => {
    expect(NOTA_NOEMI).toContain('5-10 minuti');
    expect(NOTA_NOEMI).not.toContain('pochi minuti');
  });

  it('dice che è il passaggio che conferma l\'appuntamento', () => {
    expect(NOTA_NOEMI).toContain("conferma l'appuntamento");
  });

  it('ammette che il collega gliene ha già parlato', () => {
    expect(NOTA_NOEMI).toContain('collega');
  });

  it('non minaccia il lead', () => {
    expect(NOTA_NOEMI).toContain('non è un problema');
  });

  it('compare nella nota solo quando serve', () => {
    expect(gdoContextNote(base({ videoAppenaConfermato: true }))).toContain(NOTA_NOEMI);
    expect(gdoContextNote(base())).not.toContain(NOTA_NOEMI);
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/gdo-context-note.test.ts`
Expected: FAIL — `Cannot find module './gdo-context-note'`.

- [ ] **Step 3: Implementare**

Creare `lib/gdo-context-note.ts`:

```ts
import { GDO_CONTEXT_NOTE } from './mario';

/**
 * Promemoria che il bot deve portarsi dentro la conversazione con un lead GDO.
 *
 * Non sono messaggi: sono istruzioni appese al system prompt, così il modello li
 * integra nel discorso invece di sparare un testo fisso addosso a chi magari sta
 * parlando d'altro. È la differenza fra un sollecito e una conversazione.
 */

export const NOTA_VIDEO =
  'PROMEMORIA VIDEO: il lead ha ricevuto il video da vedere prima della call ma non ha ' +
  'ancora confermato di averlo visto. Ricordaglielo in modo naturale: se c\'è un discorso ' +
  'aperto rispondi prima a quello e aggancia il video alla fine. Se glielo hai già chiesto ' +
  'in uno dei tuoi ultimi messaggi, per questo turno lascia perdere: non insistere.';

export const NOTA_NOEMI =
  'PROMEMORIA NOEMI: il lead non ha ancora sentito da te della chiamata di preselezione. ' +
  'Diglielo adesso, con parole tue e questa sostanza: gliene avrà già parlato il collega e ' +
  'tu glielo ripeti così non gli scappa; Noemi è la collega della preselezione e lo chiama ' +
  'da un cellulare prima della call; sono 5-10 minuti, perché serve tempo per capire bene ' +
  "la sua situazione; è il passaggio che conferma l'appuntamento, quindi tenga il telefono " +
  'a portata; se la chiamata gli scappa non è un problema, può richiamare su quel numero. ' +
  'Non farne un esame e non metterlo in soggezione.';

export interface GdoNoteInput {
  gdoVideoSentAt: string | null;
  gdoVideoWatchedAt: string | null;
  gdoNoemiRemindedAt: string | null;
  followupsSent: number;
  /** Il lead ha confermato la visione proprio in questo turno. */
  videoAppenaConfermato: boolean;
}

/**
 * Noemi si spiega quando il lead si fa vivo davvero: conferma di aver visto il video,
 * oppure risponde dopo che gli è arrivato almeno un sollecito. E una volta sola.
 */
export function serveNoemi(i: GdoNoteInput): boolean {
  if (i.gdoNoemiRemindedAt) return false;
  return i.videoAppenaConfermato || i.followupsSent > 0;
}

/** La nota completa da passare a `generateMarioReply({ contextNote })`. */
export function gdoContextNote(i: GdoNoteInput): string {
  const parti = [GDO_CONTEXT_NOTE];
  if (i.gdoVideoSentAt && !i.gdoVideoWatchedAt) parti.push(NOTA_VIDEO);
  if (serveNoemi(i)) parti.push(NOTA_NOEMI);
  return parti.join('\n\n');
}
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `npm test -- lib/gdo-context-note.test.ts`
Expected: PASS (13 test).

- [ ] **Step 5: Commit**

```bash
git add lib/gdo-context-note.ts lib/gdo-context-note.test.ts
git commit -m "feat(gdo): le note di contesto per il promemoria video e Noemi"
```

---

### Task 5: Il cron dei solleciti

**Files:**
- Create: `app/api/cron/gdo-video-followups/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `decideGdoVideoFollowup`, `VIDEO_TEMPLATE_ENV_BY_LINK`, `GdoSlot` (Task 3); `romeHour`, `romeMinute`, `romeDaysBetween` (Task 3); `gdoVideoText` da `lib/gdo-agenda.ts`; `sendTemplateAndLog(supabase, conversationId, phone, templateSid, label, from?, variables?, bodyOverride?)` da `lib/messaging.ts`; `sendFreeText({ to, body, from })` da `lib/twilio.ts`; `generateMarioReply(history, { personaName, contextNote })` da `lib/mario.ts`; `gdoContextNote` (Task 4); `templateName`/`firstNameOf` da `lib/name.ts`.
- Produces: gli invii veri e l'incremento di `gdo_video_followups_sent`. Nessun altro task ci costruisce sopra.

- [ ] **Step 1: Scrivere la rotta**

Il codebase non ha test sulle rotte `app/api/**` per scelta: tutta la logica decidibile vive in `lib/` ed è coperta dai Task 3 e 4. La verifica qui è tipi, build e la prova in produzione del Task 8.

Creare `app/api/cron/gdo-video-followups/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplateAndLog } from '@/lib/messaging';
import { sendFreeText } from '@/lib/twilio';
import { generateMarioReply, type MarioTurn } from '@/lib/mario';
import { gdoContextNote } from '@/lib/gdo-context-note';
import { gdoVideoText } from '@/lib/gdo-agenda';
import { decideGdoVideoFollowup, VIDEO_TEMPLATE_ENV_BY_LINK, type GdoSlot } from '@/lib/gdo-video-followup';
import { romeHour, romeMinute, romeDaysBetween } from '@/lib/rome-time';
import { templateName } from '@/lib/name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Solleciti del video ai lead dei GDO: due touch ancorati al giorno dell'agenda —
// 21:30 quel giorno, 10:00 il giorno dopo. Chi non ha mai risposto riceve il video
// (finestra chiusa ⇒ template); chi ha risposto riceve un sollecito, scritto dal
// modello se la finestra è aperta. Questa rotta NON tocca mai bot_outcome, ai_status
// né gli altri campi del lead: è di un GDO, non nostro.

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

/** Lo slot italiano di adesso, o null se non è né le 21:30 né le 10:00. */
function slotOf(now: Date): GdoSlot | null {
  const h = romeHour(now);
  const m = romeMinute(now);
  if (h === 21 && m === 30) return 'sera';
  if (h === 10 && m === 0) return 'mattina';
  return null;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  // Kill-switch, prima di toccare Supabase o Twilio.
  if (process.env.GDO_VIDEO_FOLLOWUPS_ENABLED !== '1') {
    return NextResponse.json({ ok: true, skipped: 'disabled' });
  }

  const now = new Date();
  const slot = slotOf(now);
  // Il cron gira a maglia larga (ogni mezz'ora) e agisce solo nei due slot: così il
  // cambio dell'ora legale non sposta gli orari italiani.
  if (!slot) return NextResponse.json({ ok: true, skipped: 'fuori slot' });

  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  const solleciteSid = process.env.SOLLECITO_VIDEO_GDO_SID;
  const supabase = getSupabaseAdmin();
  if (!from) {
    await supabase.from('event_log').insert({
      type: 'gdo_followup_config_error',
      payload: { missing: 'TWILIO_WHATSAPP_NUMBER_FENICE' } as never,
      message: '[gdo] numero mittente mancante: run saltato',
      level: 'error',
    });
    return NextResponse.json({ ok: true, sent: 0, skipped: 'config' });
  }

  // Gli slot utili sono solo quelli di oggi e ieri; qui si pesca con tre giorni di
  // margine (il fuso e i bordi di mezzanotte non devono tagliare fuori nessuno) e
  // decideGdoVideoFollowup scarta il resto con `giorniDaAgenda`.
  const da = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data } = await supabase
    .from('conversations')
    .select(`
      id, gdo_agenda_at, gdo_video_url, gdo_video_sent_at, gdo_video_watched_at,
      gdo_video_followups_sent, gdo_noemi_reminded_at, gdo_appuntamento_at, ai_started_at,
      leads(phone_e164, first_name)
    `)
    .not('gdo_agenda_at', 'is', null)
    .gte('gdo_agenda_at', da)
    .limit(500);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convs = (data ?? []) as any[];
  const report: Record<string, unknown>[] = [];
  let sent = 0;

  for (const c of convs) {
    try {
      const phone = c.leads?.phone_e164 as string | undefined;
      if (!phone) { report.push({ id: c.id, action: 'skip', reason: 'no_phone' }); continue; }

      const { data: msgs } = await supabase
        .from('messages')
        .select('direction, body, created_at')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: true })
        .limit(200);
      const rows = (msgs ?? []) as { direction: string; body: string; created_at: string }[];
      const inbound = rows.filter((m) => m.direction === 'in');
      const lastInboundAtMs = inbound.length ? Date.parse(inbound[inbound.length - 1].created_at) : null;
      const lastMessageIsInbound = rows.length > 0 && rows[rows.length - 1].direction === 'in';

      const agendaAt = new Date(c.gdo_agenda_at);
      const action = decideGdoVideoFollowup({
        gdoAgendaAt: c.gdo_agenda_at,
        gdoVideoSentAt: c.gdo_video_sent_at,
        gdoVideoWatchedAt: c.gdo_video_watched_at,
        followupsSent: c.gdo_video_followups_sent ?? 0,
        appointmentAt: c.gdo_appuntamento_at,
        lastInboundAtMs,
        lastMessageIsInbound,
        nowMs: now.getTime(),
        slot,
        giorniDaAgenda: romeDaysBetween(agendaAt, now),
        romeHourAgenda: romeHour(agendaAt),
      });

      if (action === 'none') { report.push({ id: c.id, action: 'none' }); continue; }

      const nome = c.leads?.first_name ?? null;
      let inviato = false;

      if (action === 'video-template') {
        const link = c.gdo_video_url as string | null;
        const envName = link ? VIDEO_TEMPLATE_ENV_BY_LINK[link] : undefined;
        const sid = envName ? process.env[envName] : undefined;
        if (!sid) {
          // Fail-closed: non si ripiega su un altro template e non si inventa un link.
          await supabase.from('event_log').insert({
            type: 'gdo_followup_template_missing',
            payload: { conversationId: c.id, link, envName } as never,
            message: `[gdo] conv ${c.id}: nessun template video per la variante, sollecito saltato`,
            level: 'error',
          });
          report.push({ id: c.id, action, skipped: 'no_template' });
          continue;
        }
        const res = await sendTemplateAndLog(
          supabase, c.id, phone, sid, 'video gdo', from,
          { 1: templateName(nome) },
          gdoVideoText(nome, link as string),
        );
        inviato = res.ok;
        if (res.ok) {
          await supabase.from('conversations')
            .update({ gdo_video_sent_at: new Date().toISOString() })
            .eq('id', c.id);
        }
      }

      if (action === 'sollecito-template') {
        if (!solleciteSid) {
          await supabase.from('event_log').insert({
            type: 'gdo_followup_template_missing',
            payload: { conversationId: c.id, envName: 'SOLLECITO_VIDEO_GDO_SID' } as never,
            message: `[gdo] conv ${c.id}: template del sollecito non configurato, sollecito saltato`,
            level: 'error',
          });
          report.push({ id: c.id, action, skipped: 'no_template' });
          continue;
        }
        const res = await sendTemplateAndLog(
          supabase, c.id, phone, solleciteSid, 'sollecito video gdo', from,
          { 1: templateName(nome) },
        );
        inviato = res.ok;
      }

      if (action === 'sollecito-libero') {
        // Il sollecito lo scrive il modello dentro il contesto della chat: se il lead
        // stava parlando d'altro, Marta risponde a quello e aggancia il video.
        const history: MarioTurn[] = rows
          .filter((m) => !c.ai_started_at || m.created_at >= c.ai_started_at)
          .map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));
        const result = await generateMarioReply(history, {
          personaName: 'Marta',
          contextNote: gdoContextNote({
            gdoVideoSentAt: c.gdo_video_sent_at,
            gdoVideoWatchedAt: c.gdo_video_watched_at,
            gdoNoemiRemindedAt: c.gdo_noemi_reminded_at,
            followupsSent: c.gdo_video_followups_sent ?? 0,
            videoAppenaConfermato: false,
          }),
        });
        const body = result.visibleReply?.trim();
        if (body) {
          const twilio = await sendFreeText({ to: phone, body, from });
          await supabase.from('messages').insert({
            conversation_id: c.id, direction: 'out', body,
            twilio_sid: twilio.sid, twilio_status: twilio.status,
            sender: 'bot',
          });
          await supabase.from('conversations')
            .update({ last_message_at: new Date().toISOString() })
            .eq('id', c.id);
          inviato = true;
        }
      }

      if (inviato) {
        sent++;
        await supabase.from('conversations')
          .update({ gdo_video_followups_sent: (c.gdo_video_followups_sent ?? 0) + 1 })
          .eq('id', c.id);
        await supabase.from('event_log').insert({
          type: 'gdo_video_followup_sent',
          payload: { conversationId: c.id, phone, slot, action } as never,
          message: `[gdo] ${action} inviato a ${phone} (slot ${slot})`,
          level: 'info',
        });
      }
      report.push({ id: c.id, action, inviato });
    } catch (err: unknown) {
      // Un lead che esplode non deve fermare il giro degli altri.
      const e = err as { message?: string };
      await supabase.from('event_log').insert({
        type: 'gdo_followup_error',
        payload: { conversationId: c.id } as never,
        message: `[gdo] conv ${c.id}: sollecito fallito — ${e?.message ?? 'errore ignoto'}`,
        level: 'error',
      });
      report.push({ id: c.id, action: 'error' });
    }
  }

  return NextResponse.json({ ok: true, slot, candidati: convs.length, sent, report });
}
```

- [ ] **Step 2: Aggiungere lo schedule**

In `vercel.json`, nell'array `crons`, aggiungere:

```json
    {
      "path": "/api/cron/gdo-video-followups",
      "schedule": "0,30 6-21 * * *"
    }
```

Ogni mezz'ora fra le 06:00 e le 21:30 UTC: copre le 21:30 e le 10:00 italiane sia con l'ora legale (UTC+2) sia con quella solare (UTC+1). La rotta esce subito quando non è uno dei due slot.

- [ ] **Step 3: Verificare tipi, lint e build**

Run: `npm run typecheck && npx eslint app/api/cron/gdo-video-followups && npm run build`
Expected: nessun errore; la rotta compare fra quelle generate.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/gdo-video-followups/route.ts vercel.json
git commit -m "feat(gdo): cron dei solleciti video, due touch ancorati al giorno dell'agenda"
```

---

### Task 6: I promemoria dentro la chat

**Files:**
- Modify: `lib/fenice-autoreply.ts` (la `select` del claim, la chiamata a `generateMarioReply`, il dopo-invio)
- Test: `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Consumes: `gdoContextNote`, `serveNoemi` (Task 4); le colonne del Task 1.
- Produces: ogni risposta del bot a un lead GDO porta i promemoria pendenti, e `gdo_noemi_reminded_at` si valorizza quando il promemoria di Noemi è davvero uscito.

- [ ] **Step 1: Scrivere il test che fallisce**

In `lib/fenice-autoreply.test.ts`, in coda al `describe` che usa `makeDrainSupabase`:

```ts
  it('marca gdo_noemi_reminded_at solo se la risposta nomina davvero Noemi', async () => {
    const claimedRow: ClaimedRow = {
      id: 61, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
    };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'sì l\'ho visto', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Perfetto. Ti ricordo che prima della call ti chiama Noemi, sono 5-10 minuti.',
      appointmentFixed: false, passToHuman: false, videoWatched: true,
    });

    await drainMarioReplies(supabase, 61, '+391234567890', () => 0);

    expect(calls.convUpdates.some((u) => typeof u.gdo_noemi_reminded_at === 'string')).toBe(true);
  });

  it('non marca Noemi se il modello non l\'ha nominata', async () => {
    const claimedRow: ClaimedRow = {
      id: 62, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null,
      gdo_agenda_at: '2026-08-01T14:00:00Z', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx',
      gdo_video_sent_at: '2026-08-01T15:00:00Z',
    };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'ok grazie', template_sid: null, created_at: '2026-08-01T18:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Figurati, a presto.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 62, '+391234567890', () => 0);

    expect(calls.convUpdates.some((u) => 'gdo_noemi_reminded_at' in u)).toBe(false);
  });
```

Il fake `makeDrainSupabase` restituisce `claimedRow` così com'è dal claim: i campi GDO aggiunti sopra ci arrivano senza modifiche al fake. Se il tipo `ClaimedRow` nel file di test non li dichiara, aggiungili come opzionali.

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/fenice-autoreply.test.ts`
Expected: FAIL — nessun update contiene `gdo_noemi_reminded_at`.

- [ ] **Step 3: Ampliare la select del claim**

In `lib/fenice-autoreply.ts`, nella `.select(...)` del claim (oggi riga 190), aggiungere i tre campi:

```ts
    .select('id, ai_started_at, crm_lead_id, gdo_agenda_at, gdo_video_url, gdo_video_sent_at, gdo_video_watched_at, gdo_video_followups_sent, gdo_noemi_reminded_at, leads(first_name)')
```

E nel tipo locale `gdo` subito sotto, aggiungere `gdo_video_watched_at?: string | null; gdo_video_followups_sent?: number | null; gdo_noemi_reminded_at?: string | null;`, con le rispettive costanti locali.

- [ ] **Step 4: Comporre la nota e marcare Noemi**

Sostituire l'attuale

```ts
        ...(postino ? { contextNote: GDO_CONTEXT_NOTE } : {}),
```

con

```ts
        // I promemoria pendenti (video non confermato, Noemi non ancora spiegata)
        // viaggiano dentro il contesto: il modello li integra nel discorso invece di
        // farli arrivare come un messaggio programmato addosso.
        ...(postino
          ? {
              contextNote: gdoContextNote({
                gdoVideoSentAt: gdoVideoSentAt,
                gdoVideoWatchedAt: gdoVideoWatchedAt,
                gdoNoemiRemindedAt: gdoNoemiRemindedAt,
                followupsSent: gdoFollowupsSent,
                videoAppenaConfermato: false,
              }),
            }
          : {}),
```

Aggiornare gli import: `import { gdoContextNote } from './gdo-context-note';` e togliere `GDO_CONTEXT_NOTE` dagli import di `./mario` se non più usato.

Poi, **dopo** l'invio della risposta (nello stesso punto in cui oggi si gestisce `result.videoWatched`), aggiungere:

```ts
      // Si segna il promemoria solo se è davvero uscito: iniettare la nota non
      // garantisce che il modello l'abbia detto, e segnarlo a vuoto significherebbe
      // non ripeterlo mai più.
      if (postino && !gdoNoemiRemindedAt && /\bNoemi\b/i.test(result.visibleReply ?? '')) {
        gdoNoemiRemindedAt = new Date().toISOString();
        await supabase.from('conversations')
          .update({ gdo_noemi_reminded_at: gdoNoemiRemindedAt })
          .eq('id', conversationId);
      }
```

Le variabili `gdoVideoWatchedAt`, `gdoFollowupsSent` e `gdoNoemiRemindedAt` vanno dichiarate `let` accanto a `gdoVideoSentAt`, così il turno successivo dentro lo stesso drain vede il valore aggiornato.

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `npm test`
Expected: PASS su tutta la suite. `showSender` e le altre modifiche recenti non sono toccate.

- [ ] **Step 6: Verificare tipi e lint**

Run: `npm run typecheck && npx eslint lib/fenice-autoreply.ts`
Expected: nessun errore nuovo.

- [ ] **Step 7: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(gdo): i promemoria del video e di Noemi viaggiano dentro la chat"
```

---

### Task 7: La durata vera della preselezione

**Files:**
- Modify: `lib/mario-prompt.ts`
- Test: `lib/mario-prompt.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces: nessuna interfaccia — è una correzione di copy che vale per **tutti** i lead, non solo i GDO.

**Perché:** oggi il prompt dice *"per una preselezione di pochi minuti"*. Se ne servono 5-10 il lead si organizza male e la preselezione si fa di corsa. Una sola versione della stessa cosa, ovunque.

- [ ] **Step 1: Scrivere il test che fallisce**

In `lib/mario-prompt.test.ts`, dentro `describe('conferme: anticipo e micro-impegni', ...)`:

```ts
  it('dice quanto dura davvero la preselezione', () => {
    expect(p).toContain('5-10 minuti');
    expect(p).not.toContain('preselezione di pochi minuti');
  });
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/mario-prompt.test.ts`
Expected: FAIL — il prompt contiene ancora "preselezione di pochi minuti".

- [ ] **Step 3: Correggere l'anticipo**

In `lib/mario-prompt.ts`, nel blocco che oggi recita `Prima della call ti chiama Noemi, una collega, per una preselezione di pochi minuti.`, sostituire con:

```
Prima della call ti chiama Noemi, una collega, per una preselezione di 5-10 minuti.
```

- [ ] **Step 4: Correggere il passaggio 2 del blocco conferma**

Nel passaggio 2 (`"Noemi è la collega della preselezione, ti chiama prima della call da un cellulare: …`), inserire la durata mantenendo **una riga per bolla e il limite di parole per riga già presidiato dai test**:

```
2. "Noemi è la collega della preselezione, ti chiama prima della call da un cellulare:
sono 5-10 minuti per capire bene la tua situazione.
È il passaggio che conferma l'appuntamento, quindi tieni il telefono a portata.
Se ti scappa la chiamata non è un problema, richiamala pure su quel numero"
```

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `npm test -- lib/mario-prompt.test.ts lib/confirmation-block.test.ts`
Expected: PASS. Se il test sul limite di parole per riga fallisce, **accorcia le righe** — non alzare il limite: quelle righe diventano bolle WhatsApp separate e devono restare corte.

- [ ] **Step 6: Eseguire tutta la suite**

Run: `npm test`
Expected: PASS. `lib/confirmation-block.test.ts` confronta stringhe del blocco conferma: se una asserzione cita il passaggio 2, aggiornala al testo nuovo.

- [ ] **Step 7: Commit**

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts lib/confirmation-block.test.ts
git commit -m "fix(bot): la preselezione di Noemi dura 5-10 minuti, non pochi minuti"
```

---

### Task 8: Go-live

**Files:**
- nessuna modifica di codice prevista

**Interfaces:**
- Consumes: tutto quanto sopra.
- Produces: il meccanismo attivo in produzione.

**Nota per chi esegue:** questo task tocca la produzione. I passi con credenziali (dashboard Supabase, Vercel) vanno fatti con Bruno o riportati a lui se bloccati — non inventare valori.

**ORDINE OBBLIGATORIO: la migration PRIMA del deploy.** Il codice legge e scrive colonne nuove; se il deploy le precede, PostgREST rifiuta le query e i solleciti falliscono in silenzio. È la stessa regola imparata con `messages.sender` il 31/07.

- [ ] **Step 1: Applicare la migration**

Progetto Supabase `gosnmagiishkwuvmortj` ("App Messaggistica"), SQL Editor del dashboard via Chrome (il PAT non è disponibile — vedi la memoria `reference_supabase_ddl_senza_pat`). Incollare ed eseguire `supabase/migrations/20260801000001_gdo_video_followup.sql`.

- [ ] **Step 2: Verificare le colonne**

```sql
select count(*) as postino,
       count(gdo_video_watched_at) as con_visione,
       sum(gdo_video_followups_sent) as solleciti
  from public.conversations
 where gdo_agenda_at is not null;
```

Expected: la query risponde, `solleciti` è 0.

- [ ] **Step 3: Verificare l'approvazione dei template del sollecito**

I due gemelli sono stati sottomessi il 31/07: `HX3e54993f4e225ac290c9ba3676ebe367` e `HXf0fd2cf65ddbf7a84ef19b01fd789fbf`. Controllare quale è passato:

```bash
node --env-file=.env.local scripts/lib/template-guard.mjs
```

Se lo script non li elenca, interrogare la Content API di Twilio per i due SID e leggere `status` **e** `category`: serve `approved` + `UTILITY`. Nessuno dei due approvato ⇒ si va live lo stesso: il cron logga `gdo_followup_template_missing` e salta solo il sollecito fuori finestra, tutto il resto funziona.

- [ ] **Step 4: Configurare le env su Vercel**

- `SOLLECITO_VIDEO_GDO_SID` = il SID approvato dello step 3
- `GDO_VIDEO_FOLLOWUPS_ENABLED` = `1`

Verificare che i cinque `VIDEO_GDO_*_SID` siano già presenti (lo erano dal 29/07). Aggiungere le stesse variabili in `.env.local` per coerenza.

- [ ] **Step 5: Merge e deploy**

```bash
npm test && npm run typecheck && npm run build
git checkout main && git merge --no-ff feat/gdo-video-followup -m "Merge feat/gdo-video-followup: solleciti del video e promemoria Noemi per i lead GDO"
git push origin main
```

Attendere il deploy Vercel.

- [ ] **Step 6: Prova a secco del cron**

```bash
curl -s "https://web-app-messaggistica.vercel.app/api/cron/gdo-video-followups?secret=$CRON_SECRET" | head -c 400
```

Fuori dai due slot deve rispondere `{"ok":true,"skipped":"fuori slot"}`. È la prova che la rotta è viva e che il filtro orario funziona.

- [ ] **Step 7: Sorvegliare il primo slot vero**

Alle 21:30 italiane, controllare:

```sql
select type, count(*), max(created_at)
  from public.event_log
 where created_at > now() - interval '30 minutes'
   and type like 'gdo_%'
 group by type;
```

Expected: `gdo_video_followup_sent` con un conteggio plausibile, zero `gdo_followup_error`. Se compare `gdo_followup_template_missing`, leggere il payload: dice quale variante non ha il SID.

- [ ] **Step 8: Aggiornare la memoria di progetto**

Aggiornare `project_send_agenda_gdo.md` con lo stato dei solleciti e scrivere che il canale CRM è **acceso dal 31/07** (22 agende ricevute). Aggiungere la riga in `MEMORY.md` se serve un file nuovo.

---

## Da chiedere al CRM (non blocca)

Il payload `SendAgendaPayload` non contiene la data della call. Chiedere di aggiungere `appointmentAt` (ce l'hanno, sta nei CSV): senza, la regola "non scrivere a chi ha già fatto la call" gira sul ripiego dell'ora dell'agenda. Appena il campo arriva, si valorizza `gdo_appuntamento_at` in `enrollGdoLeadAsPostino` e la regola diventa esatta — la colonna è già lì.

## Fuori scope (fase 3 della spec)

Le note alle conferme: `outcome: 'NOTA'` non è mai stata esercitata (`bot_note_sent` ha zero occorrenze da sempre) e va provata col CRM prima di costruirci sopra.
