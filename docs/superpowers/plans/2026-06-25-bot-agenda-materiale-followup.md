# Bot Mario — agenda 20:00 + materiale gratuito + follow-up 2h — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Far sì che Mario proponga l'agenda corretta dopo le 20:00, gestisca bene la richiesta di "materiale gratuito", e mandi un singolo follow-up free-text a ~2h a chi ha ricevuto l'agenda senza prenotare.

**Architecture:** Tre interventi indipendenti su un bot WhatsApp Next.js + Supabase + Twilio. (1) Funzione pura di calcolo slot con rollover a 20:00. (2) Modifica copy del prompt. (3) Nuovo modulo `lib/agenda-followup.ts` (decisione pura + orchestrazione) agganciato al cron orario esistente `bot-followups`.

**Tech Stack:** TypeScript, Next.js (App Router), Supabase JS, Twilio (`sendFreeText`), Vitest, `Intl.DateTimeFormat` per il fuso Europe/Rome.

## Global Constraints

- Fuso orario di riferimento sempre **Europe/Rome**; calcoli data immuni da DST (ancora UTC a mezzogiorno, come già in `lib/booking-slots.ts`).
- Email di supporto esatta: **`info@feniceacademysrl.com`**.
- Corso 10h gratuito = **solo orientativo**; i corsi professionali restano **a pagamento (1.000–3.000€)**. Mai far credere che i corsi a pagamento siano gratis (memoria progetto: no manipolazione / no impersonificazione umana).
- Follow-up: **un solo messaggio per lead**, free-text, solo dentro la finestra WhatsApp 24h e in orario **09:00–21:00 Rome**.
- Test runner: `npx vitest run <file>`. Typecheck: `npm run typecheck` (`tsc --noEmit`).
- Commit frequenti, uno per task. Co-author trailer come da convenzione repo.

---

### Task 1: Rollover agenda alle 20:00

**Files:**
- Modify: `lib/rome-time.ts` (aggiungi helper `romeHour`)
- Modify: `lib/booking-slots.ts:49-57` (`computeBookingDays`)
- Test: `lib/booking-slots.test.ts` (aggiorna il caso "tarda sera" + aggiungi confine 20:00)

**Interfaces:**
- Produces: `romeHour(date: Date): number` — ora locale 0–23 in Europe/Rome. Usato anche dal Task 4.
- `computeBookingDays(now: Date)` invariato come firma; cambia solo il comportamento dopo le 20:00.

- [ ] **Step 1: Scrivi il test che fallisce (helper + rollover)**

In `lib/booking-slots.test.ts`, **sostituisci** il test esistente "tarda sera resta sul giorno di Roma…" (righe ~29-32) con i nuovi casi e aggiungi un blocco per `romeHour`:

```ts
import { romeHour } from './rome-time';

describe('romeHour', () => {
  it('ritorna l\'ora locale Europe/Rome (DST estiva +02:00)', () => {
    expect(romeHour(new Date('2026-06-25T17:00:00Z'))).toBe(19);
    expect(romeHour(new Date('2026-06-25T18:00:00Z'))).toBe(20);
  });
});

describe('computeBookingDays rollover 20:00', () => {
  it('prima delle 20:00 NON scivola: giovedì 19:00 → ven e sab', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-25T17:00:00Z')); // Rome 19:00
    expect(day1.date).toBe('2026-06-26'); // venerdì
    expect(day2.date).toBe('2026-06-27'); // sabato
  });

  it('alle 20:00 scivola al giorno dopo: giovedì 20:00 → sab e lun (salta domenica)', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-25T18:00:00Z')); // Rome 20:00
    expect(day1.date).toBe('2026-06-27'); // sabato (anchor spostato a venerdì)
    expect(day2.date).toBe('2026-06-29'); // lunedì (salta domenica 28)
  });

  it('sabato sera dopo le 20 → lun e mar', () => {
    const { day1, day2 } = computeBookingDays(new Date('2026-06-27T18:00:00Z')); // Rome 20:00
    expect(day1.date).toBe('2026-06-29'); // lunedì
    expect(day2.date).toBe('2026-06-30'); // martedì
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run lib/booking-slots.test.ts`
Expected: FAIL — `romeHour` non esportato e i casi rollover non passano.

- [ ] **Step 3: Aggiungi `romeHour` in `lib/rome-time.ts`**

In coda al file, aggiungi:

```ts
/** Ora locale (0–23) di `date` nel fuso Europe/Rome. */
export function romeHour(date: Date): number {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return parseInt(h, 10);
}
```

- [ ] **Step 4: Applica il rollover in `lib/booking-slots.ts`**

Cambia l'import in cima:

```ts
import { romeOffset, romeHour } from './rome-time';
```

Sostituisci `computeBookingDays` (righe 49-57) con:

```ts
/** I due (e soli due) giorni prenotabili a partire da `now`, domenica esclusa. */
export function computeBookingDays(now: Date): { day1: BookingDay; day2: BookingDay } {
  let today = romeYmd(now);
  // Dopo le 20:00 l'agenda del giorno corrente non è più prenotabile: entra in
  // vigore quella del giorno successivo. Anticipiamo l'anchor di un giorno.
  if (romeHour(now) >= 20) today = addDays(today, 1);
  const d1 = nextNonSunday(today);
  const d2 = nextNonSunday(d1);
  return {
    day1: { label: labelIt(d1), date: isoDate(d1) },
    day2: { label: labelIt(d2), date: isoDate(d2) },
  };
}
```

(`addDays` accetta un `Ymd` e ritorna un `Ymd`: `romeYmd(now)` è già un `Ymd`, quindi `addDays(today, 1)` è corretto.)

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `npx vitest run lib/booking-slots.test.ts`
Expected: PASS (tutti i casi, inclusi quelli pre-esistenti a ore 10:00).

- [ ] **Step 6: Commit**

```bash
git add lib/rome-time.ts lib/booking-slots.ts lib/booking-slots.test.ts
git commit -m "feat(bot): agenda ruota al giorno successivo dopo le 20:00 (fuso Rome)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Gestione "materiale gratuito" nel prompt

**Files:**
- Modify: `lib/mario-prompt.ts` (sezione `GESTIONE OBIEZIONI`, dopo la riga 242 `"Voglio parlare con una persona"`)

**Interfaces:** nessuna (solo copy del prompt). Nessun test automatico.

- [ ] **Step 1: Aggiungi la voce nella sezione GESTIONE OBIEZIONI**

In `lib/mario-prompt.ts`, subito **dopo** la riga:

```
"Voglio parlare con una persona" → "Certo, ti metto subito in contatto con un mio collega." Poi: [PASSAGGIO_UMANO]
```

inserisci un blocco vuoto e poi:

```
"Voglio del materiale gratuito / dov'è il corso gratis / mi avevate promesso qualcosa di gratis" → c'è un corso orientativo gratuito di 10 ore che spiega come funzionano le professioni digitali: arriva via email e si guarda da lì. Se non lo trova, può scrivere a info@feniceacademysrl.com e glielo rimandano. PRECISA che quel corso da 10h è solo orientativo: per capire davvero quale percorso fa per lui la cosa migliore è la call con un tutor, che lo orienta direttamente. Quindi NON fermarti al materiale: proponi comunque l'appuntamento. I corsi professionali veri e propri restano a pagamento (dai 1.000 ai 3.000 euro, rateizzabili): non spacciare mai i corsi a pagamento per gratuiti.
```

- [ ] **Step 2: Typecheck (il prompt è una stringa: verifica che il file compili)**

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 3: Verifica manuale del testo**

Rileggi il blocco aggiunto: deve contenere `info@feniceacademysrl.com`, l'invito a prendere comunque l'appuntamento, e il confine "corsi professionali a pagamento". Nessuna promessa falsa.

- [ ] **Step 4: Commit**

```bash
git add lib/mario-prompt.ts
git commit -m "feat(bot): Mario gestisce la richiesta di materiale gratuito (corso 10h orientativo) e prende comunque l'appuntamento

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Decisione pura del follow-up agenda

**Files:**
- Create: `lib/agenda-followup.ts` (parte pura)
- Test: `lib/agenda-followup.test.ts`

**Interfaces:**
- Consumes: niente (funzioni pure).
- Produces:
  - `AGENDA_FOLLOWUP_DELAY_MS: number` (= 2h)
  - `decideAgendaFollowup(input): 'send' | 'none'` con
    `input: { agendaSentAtMs: number; nowMs: number; booked: boolean; followupAlreadySent: boolean; lastInboundAtMs: number | null; romeHour: number }`
  - `agendaFollowupText(firstName: string | null): string`

- [ ] **Step 1: Scrivi i test che falliscono**

Crea `lib/agenda-followup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decideAgendaFollowup, agendaFollowupText, AGENDA_FOLLOWUP_DELAY_MS } from './agenda-followup';

const H = 3600_000;
const base = {
  agendaSentAtMs: 0,
  nowMs: 3 * H,            // 3h dopo l'agenda
  booked: false,
  followupAlreadySent: false,
  lastInboundAtMs: 2.5 * H, // inbound recente → finestra 24h aperta
  romeHour: 15,             // orario buono
};

describe('decideAgendaFollowup', () => {
  it('manda quando: ≥2h, non preso, mai inviato, finestra aperta, orario ok', () => {
    expect(decideAgendaFollowup(base)).toBe('send');
  });
  it('niente se agenda inviata da meno di 2h', () => {
    expect(decideAgendaFollowup({ ...base, nowMs: 1 * H })).toBe('none');
  });
  it('niente se ha già preso l\'appuntamento', () => {
    expect(decideAgendaFollowup({ ...base, booked: true })).toBe('none');
  });
  it('niente se il follow-up è già stato inviato', () => {
    expect(decideAgendaFollowup({ ...base, followupAlreadySent: true })).toBe('none');
  });
  it('niente se non c\'è alcun inbound (finestra non apribile)', () => {
    expect(decideAgendaFollowup({ ...base, lastInboundAtMs: null })).toBe('none');
  });
  it('niente se l\'ultimo inbound è oltre 24h fa (finestra chiusa)', () => {
    expect(decideAgendaFollowup({ ...base, nowMs: 30 * H, lastInboundAtMs: 2.5 * H })).toBe('none');
  });
  it('niente di notte (prima delle 9)', () => {
    expect(decideAgendaFollowup({ ...base, romeHour: 7 })).toBe('none');
  });
  it('niente a tarda sera (dalle 21 in poi)', () => {
    expect(decideAgendaFollowup({ ...base, romeHour: 21 })).toBe('none');
  });
  it('la costante di ritardo è 2h', () => {
    expect(AGENDA_FOLLOWUP_DELAY_MS).toBe(2 * H);
  });
});

describe('agendaFollowupText', () => {
  it('interpola il nome del lead', () => {
    expect(agendaFollowupText('Luca')).toContain('Luca');
    expect(agendaFollowupText('Luca')).toContain('slot');
  });
  it('funziona anche senza nome', () => {
    const t = agendaFollowupText(null);
    expect(t.length).toBeGreaterThan(0);
    expect(t).not.toContain('null');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run lib/agenda-followup.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa la parte pura**

Crea `lib/agenda-followup.ts` con SOLO la parte pura (l'orchestrazione arriva nel Task 4):

```ts
const H = 3600_000;

/** Quanto deve essere vecchia l'agenda inviata perché parta il follow-up. */
export const AGENDA_FOLLOWUP_DELAY_MS = 2 * H;
/** Finestra di servizio WhatsApp: free-text lecito solo entro 24h dall'ultimo inbound. */
export const WINDOW_MS = 24 * H;
/** Fascia oraria (Rome) in cui è lecito inviare il follow-up. */
export const FOLLOWUP_HOUR_START = 9;
export const FOLLOWUP_HOUR_END = 21; // escluso: invia solo se ora < 21

export interface AgendaFollowupInput {
  agendaSentAtMs: number;
  nowMs: number;
  booked: boolean;
  followupAlreadySent: boolean;
  lastInboundAtMs: number | null;
  romeHour: number;
}

/** Decide se mandare il singolo follow-up agenda. Puro, niente effetti. */
export function decideAgendaFollowup(input: AgendaFollowupInput): 'send' | 'none' {
  if (input.booked) return 'none';
  if (input.followupAlreadySent) return 'none';
  if (input.nowMs - input.agendaSentAtMs < AGENDA_FOLLOWUP_DELAY_MS) return 'none';
  if (input.lastInboundAtMs === null) return 'none';
  if (input.nowMs - input.lastInboundAtMs >= WINDOW_MS) return 'none';
  if (input.romeHour < FOLLOWUP_HOUR_START || input.romeHour >= FOLLOWUP_HOUR_END) return 'none';
  return 'send';
}

/** Testo fisso del follow-up, in voce Mario. */
export function agendaFollowupText(firstName: string | null): string {
  const hi = firstName && firstName.trim() ? `Ciao ${firstName.trim()}` : 'Ciao';
  return `${hi} 🙂 ti avevo mandato gli orari per la videocall ma non ho ancora visto la conferma. Vuoi che ti tenga uno slot? Dimmi pure giorno e ora che preferisci.`;
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx vitest run lib/agenda-followup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agenda-followup.ts lib/agenda-followup.test.ts
git commit -m "feat(bot): decisione pura per il follow-up agenda a 2h (guardie 24h + orario)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Orchestrazione follow-up e aggancio al cron

**Files:**
- Modify: `lib/agenda-followup.ts` (aggiungi `runAgendaFollowups`)
- Modify: `app/api/cron/bot-followups/route.ts` (chiama `runAgendaFollowups`)

**Interfaces:**
- Consumes: `decideAgendaFollowup`, `agendaFollowupText`, `AGENDA_FOLLOWUP_DELAY_MS`, `WINDOW_MS` (Task 3); `romeHour` (Task 1); `sendFreeText` (`lib/twilio.ts`); `getSupabaseAdmin` (`lib/supabase/admin.ts`).
- Produces: `runAgendaFollowups(supabase, now?): Promise<{ sent: number; skipped: number }>`.

- [ ] **Step 1: Aggiungi l'orchestrazione in `lib/agenda-followup.ts`**

In cima al file aggiungi gli import:

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import { sendFreeText } from './twilio';
import { romeHour } from './rome-time';
```

In coda al file aggiungi:

```ts
type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Invia (idempotente) un singolo follow-up free-text ai lead che hanno ricevuto
 * l'agenda da >= 2h e non hanno ancora preso l'appuntamento. Rispetta finestra 24h
 * e fascia oraria. Marca `bot_followups_sent` per non ripetere.
 */
export async function runAgendaFollowups(
  supabase: Supa,
  now: Date = new Date(),
): Promise<{ sent: number; skipped: number }> {
  const agendaSid = process.env.AGENDA_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!agendaSid || !from) return { sent: 0, skipped: 0 };

  const nowMs = now.getTime();
  const twoHAgo = new Date(nowMs - AGENDA_FOLLOWUP_DELAY_MS).toISOString();
  const dayAgo = new Date(nowMs - WINDOW_MS).toISOString();

  // 1. Agende inviate con successo tra 24h e 2h fa (oltre 24h la finestra è chiusa).
  const { data: agendaMsgs } = await supabase
    .from('messages')
    .select('conversation_id, created_at')
    .eq('template_sid', agendaSid)
    .eq('direction', 'out')
    .eq('is_template', true)
    .not('twilio_status', 'in', '(failed,undelivered)')
    .lte('created_at', twoHAgo)
    .gte('created_at', dayAgo)
    .order('created_at', { ascending: false });

  const agendaAtByConv = new Map<string, number>();
  for (const m of (agendaMsgs ?? []) as { conversation_id: string; created_at: string }[]) {
    if (!agendaAtByConv.has(m.conversation_id)) {
      agendaAtByConv.set(m.conversation_id, Date.parse(m.created_at));
    }
  }
  const convIds = [...agendaAtByConv.keys()];
  if (convIds.length === 0) return { sent: 0, skipped: 0 };

  // 2. Stato delle conversazioni candidate.
  const { data: convs } = await supabase
    .from('conversations')
    .select('id, lead_id, ai_status, bot_outcome, bot_followups_sent')
    .in('id', convIds);

  const leadIds = [...new Set((convs ?? []).map((c) => c.lead_id))];
  const { data: leads } = await supabase
    .from('leads')
    .select('id, phone_e164, first_name')
    .in('id', leadIds);
  const leadById = new Map((leads ?? []).map((l) => [l.id, l]));

  const hour = romeHour(now);
  let sent = 0;
  let skipped = 0;

  for (const c of (convs ?? []) as any[]) {
    const agendaSentAtMs = agendaAtByConv.get(c.id);
    if (agendaSentAtMs === undefined) { skipped++; continue; }
    const lead = leadById.get(c.lead_id);
    const phone = lead?.phone_e164 as string | undefined;

    // Ultimo inbound del lead → finestra 24h.
    const { data: lastIn } = await supabase
      .from('messages')
      .select('created_at')
      .eq('conversation_id', c.id)
      .eq('direction', 'in')
      .order('created_at', { ascending: false })
      .limit(1);
    const lastInboundAtMs = lastIn && lastIn[0] ? Date.parse(lastIn[0].created_at) : null;

    const decision = decideAgendaFollowup({
      agendaSentAtMs,
      nowMs,
      booked: c.bot_outcome === 'APPUNTAMENTO' || c.ai_status === 'booked',
      followupAlreadySent: (c.bot_followups_sent ?? 0) >= 1,
      lastInboundAtMs,
      romeHour: hour,
    });

    if (decision === 'none' || !phone) { skipped++; continue; }

    const body = agendaFollowupText((lead?.first_name as string | null) ?? null);
    const msg = await sendFreeText({ to: phone, body, from });
    await supabase.from('messages').insert({
      conversation_id: c.id, direction: 'out', body,
      twilio_sid: msg.sid, twilio_status: msg.status,
    });
    await supabase.from('conversations')
      .update({ bot_followups_sent: (c.bot_followups_sent ?? 0) + 1, last_message_at: now.toISOString() })
      .eq('id', c.id);
    await supabase.from('event_log').insert({
      type: 'agenda_followup_sent',
      payload: { conversationId: c.id, phone } as never,
      message: `Follow-up agenda inviato a ${phone}`,
      level: 'info',
    });
    sent++;
  }

  return { sent, skipped };
}
```

- [ ] **Step 2: Aggancia al cron `bot-followups`**

In `app/api/cron/bot-followups/route.ts`, aggiungi l'import in cima:

```ts
import { runAgendaFollowups } from '@/lib/agenda-followup';
```

Subito **prima** dell'`event_log` finale `bot_followups_run` (riga ~107), aggiungi:

```ts
  // Follow-up agenda (singolo, idempotente) a chi ha ricevuto l'agenda e non ha preso.
  let agendaFollowup = { sent: 0, skipped: 0 };
  try {
    agendaFollowup = await runAgendaFollowups(supabase, new Date(now));
  } catch (e) {
    await supabase.from('event_log').insert({
      type: 'agenda_followup_error',
      payload: { error: e instanceof Error ? e.message : 'errore' } as never,
      message: `[bot-fissatore] errore follow-up agenda: ${e instanceof Error ? e.message : 'errore'}`,
      level: 'error',
    });
  }
```

E nel `return` finale includi il dato:

```ts
  return NextResponse.json({ ok: true, actions: report, agendaFollowup });
```

(`now` nel route è `Date.now()` numerico: `new Date(now)` lo riconverte in `Date` per `runAgendaFollowups`.)

- [ ] **Step 3: Typecheck + test esistenti**

Run: `npm run typecheck && npx vitest run lib/agenda-followup.test.ts lib/booking-slots.test.ts`
Expected: typecheck pulito, test verdi.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build OK.

- [ ] **Step 5: Commit**

```bash
git add lib/agenda-followup.ts app/api/cron/bot-followups/route.ts
git commit -m "feat(bot): invia un follow-up agenda a 2h via cron orario (idempotente, guardie 24h+orario)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Verifica backfill dei lead esistenti (read-only)**

Il follow-up è idempotente: al primo run orario dopo il deploy colpirà automaticamente i lead "agenda inviata >2h fa, non preso, mai sollecitato, finestra 24h aperta, orario 9–21". Verifica i candidati con questa query (via Supabase MCP `execute_sql`, project `gosnmagiishkwuvmortj`), **prima del deploy**, per sapere quanti sono e quali resteranno esclusi perché fuori finestra 24h:

```sql
with agenda as (
  select m.conversation_id, max(m.created_at) as agenda_at
  from messages m
  where m.is_template = true and m.direction = 'out'
    and m.twilio_status not in ('failed','undelivered')
    and m.template_sid = (select current_setting('app.agenda_sid', true)) -- oppure incolla il SID di AGENDA_TEMPLATE_SID
  group by m.conversation_id
)
select c.id, c.bot_outcome, c.bot_followups_sent, a.agenda_at,
       (select max(created_at) from messages where conversation_id = c.id and direction = 'in') as last_inbound
from agenda a
join conversations c on c.id = a.conversation_id
where coalesce(c.bot_outcome,'') <> 'APPUNTAMENTO'
  and coalesce(c.bot_followups_sent,0) = 0
  and a.agenda_at <= now() - interval '2 hours';
```

Nota: i lead il cui `last_inbound` è oltre 24h fa NON riceveranno il free-text (finestra chiusa) — è il comportamento voluto (servirebbe un template, fuori scope). Annota quanti sono esclusi.

---

### Task 5: Analisi perdite al pitch + obiezioni (deliverable, Fase 2)

> Task **read-only**, nessuna modifica di codice o prompt. Produce un report che alimenterà un piano separato di tuning del prompt (Fase 3). Può essere eseguito come task a sé (anche subagent in parallelo).

**Files:**
- Create: `docs/superpowers/specs/2026-06-25-analisi-perdite-pitch.md`

- [ ] **Step 1: Estrai il dataset da Supabase**

Via `execute_sql` (project `gosnmagiishkwuvmortj`), estrai le conversazioni Mario arrivate al pitch e non convertite. Heuristica "arrivato al pitch": presenza di un outbound che cita i prezzi (`body ilike '%1.000%' or body ilike '%3.000%' or body ilike '%rate%'`) oppure esito non positivo. Esempio:

```sql
select c.id, c.crm_funnel, c.bot_outcome, c.ai_status,
       count(m.*) filter (where m.direction='in') as msg_in,
       count(m.*) filter (where m.direction='out') as msg_out
from conversations c
join messages m on m.conversation_id = c.id
where c.ai_owner = 'mario'
  and coalesce(c.bot_outcome,'') <> 'APPUNTAMENTO'
  and exists (
    select 1 from messages mm
    where mm.conversation_id = c.id and mm.direction='out'
      and (mm.body ilike '%1.000%' or mm.body ilike '%3.000%' or mm.body ilike '%rate%')
  )
group by c.id
order by c.id;
```

- [ ] **Step 2: Leggi i transcript a blocchi con subagent in parallelo**

Per ogni conversazione, carica i messaggi ordinati (`select direction, body, created_at from messages where conversation_id = X order by created_at`). Dispaccia subagent (Explore/general-purpose) su blocchi di N conversazioni; ogni subagent estrae per chat: (a) il turno in cui muore dopo il pitch, (b) l'obiezione esatta, (c) la risposta di Mario, (d) perché fallisce.

- [ ] **Step 3: Aggrega in pattern**

Raccogli i risultati e raggruppa: top obiezioni per frequenza, pattern di fallimento (es. pitch troppo brusco, prezzo detto troppo presto, risposta obiezione che chiude invece di esplorare, INTERROTTO usato male).

- [ ] **Step 4: Scrivi il report**

Crea `docs/superpowers/specs/2026-06-25-analisi-perdite-pitch.md` con: metodo, numeri, top obiezioni, pattern di fallimento, e **raccomandazioni puntuali** di modifica al prompt (citando righe di `lib/mario-prompt.ts`). Committalo.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-25-analisi-perdite-pitch.md
git commit -m "docs(bot): analisi perdite al pitch e gestione obiezioni con raccomandazioni prompt

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Note di chiusura

- Fase 1 = Task 1–4 (codice). Fase 2 = Task 5 (analisi). Fase 3 (tuning prompt guidato dall'analisi) sarà un piano separato.
- Dopo Fase 1, integrare il branch `feat/bot-agenda-materiale-followup` (merge/PR) e lasciar girare il cron orario per il backfill.
- Pre-deploy: confermare che gli outbound WhatsApp vengano effettivamente consegnati (storia blocco numero Meta in memoria); l'utente riferisce che le agende sono arrivate, quindi atteso OK.
