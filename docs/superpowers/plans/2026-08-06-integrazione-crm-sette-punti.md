# Integrazione bot↔CRM — i sette punti del 06/08/2026

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chiudere i quattro punti del CRM che richiedono lavoro nostro (CONTATTO_UMANO, `/api/appointment-set`, `/api/bot/agenda-delivery`, note fattuali) e i tre di indagine (lead fermi, INTERROTTO prematuro, re-invio orario), senza toccare il prompt di vendita né la logica di conversazione.

**Architecture:** il confine col CRM resta dov'è: `lib/bot-contract.ts` definisce i payload, `lib/bot-outcome.ts` è l'unica porta in uscita verso `POST /api/bot/outcome`, i route in `app/api/` sono le porte in ingresso. Le decisioni restano in funzioni pure e testabili (`lib/bot-outcome-rules.ts`, `lib/sequence.ts`, `lib/appointment-set.ts`); i route e i cron fanno solo I/O.

**Tech Stack:** Next.js (App Router, `runtime = 'nodejs'`), TypeScript, Supabase (postgres + PostgREST), Vitest, HMAC condiviso `BOT_WEBHOOK_SECRET` via `lib/bot-hmac.ts`.

## Global Constraints

- **Prima di scrivere codice Next.js leggere `node_modules/next/dist/docs/`.** Questa versione di Next ha API e convenzioni diverse da quelle note.
- **Un branch per punto**, partendo sempre da `main` aggiornato. Nomi in `docs/superpowers/plans/` e nei task qui sotto.
- **Migration PRIMA del deploy del codice** che la usa. Vale per il Task 7.1 (`ai_redrive_at`).
- **TDD**: test rosso, poi implementazione, poi verde, poi commit. `npm test` verde per intero prima di ogni merge.
- **Lavoro in parallelo di un'altra sessione** sul branch `feat/pacchetto-post-fissaggio` (oggi a zero commit, allineato a `main`). Tocca `lib/bot-outcome.ts`, `lib/bot-contract.ts`, `lib/mario-prompt.ts`, i cron `precall-reminders` e `gdo-video-followups`, e aggiunge la colonna `conversations.cancel_requested_at` (oggi **non** esiste in produzione). Sovrapposizione certa su `bot-contract.ts` e `bot-outcome.ts`: le nostre modifiche lì sono **additive** (un valore in più nell'union, un ramo in più prima di `resolveOutcomeAction`) e vanno mergiate per prime quando possibile. Non toccare `lib/mario-prompt.ts` né i due cron citati.
- **Non toccare** il prompt di vendita (`lib/mario-prompt.ts`) né `lib/mario.ts`.
- Firma HMAC in ingresso: sempre `verifySignature(rawBody, req.headers.get('x-bot-signature'), secret)` sul corpo **grezzo**, come in `app/api/send-agenda/route.ts`.
- Le note al CRM sono lette dalle Conferme pochi minuti prima di chiamare il cliente: fatto concreto in testa, dati che lo rendono azionabile, parole del lead per il motivo. Mai parafrasi della conversazione.
- Testi utente e log in italiano, come tutto il resto del repo.

---

## Cosa hanno detto i dati (indagine già fatta, 06/08/2026)

Non ri-eseguire queste indagini: sono state fatte e i risultati sono qui. Servono a giustificare le scelte dei task.

**Punto 4 — i 338 lead fermi.** Incrociati i `lead_id` del CSV con `conversations.crm_lead_id`:

| n | causa | nostro? |
|---:|---|---|
| 211 | esito inviato e **accettato dal CRM con 2xx** (177 DA_SCARTARE, 26 RICHIAMO, 7 APPUNTAMENTO, 1 NON_RISPOSTO) | no |
| 110 | fisiologici: 57 dentro la sequenza mai risposto, 53 chat ancora viva | no |
| 10 | nessuna conversazione da noi: il lead non è mai arrivato al bot | **sì** |
| 6 | `handed_off`: passata a un umano, mai segnalata al CRM | **sì** (è il punto 1) |
| 1 | oltre la sequenza, la classificazione non è scattata | **sì** |

Sui 211: zero 403, zero errori di rete, `bot_outcome_sent` presente per tutti; e il loro `stato_crm` **coincide** col nostro esito (173 REJECTED su 177 DA_SCARTARE, 5 APPOINTMENT su 7 APPUNTAMENTO). La loro query "fermi senza esito" misura altro — probabilmente l'assegnazione del lead all'account bot, non l'esito.

**Punto 7 — il re-invio orario.** Firma trovata nell'`event_log`: gap **esattamente 1.00h**, la cadenza del cron `bot-followups` (`0 * * * *`). Meccanismo: il re-drive di `app/api/cron/bot-followups/route.ts:96` riparte ogni ora finché `lastIsUnansweredInbound` è vero. Quando un turno produce **solo tag e nessun testo visibile** non viene scritta nessuna riga outbound, quindi la condizione resta vera e lo stesso esito viene ri-emesso ogni ora per un massimo di 5 giorni (`REDRIVE_MAX_MS`). Caso conclamato: conv 3728 — 39 `fenice_ai_reply` a fronte di 14 outbound reali, 32 `bot_outcome_note_duplicate` a gap 1.0h. Il fix del 20/07 (`1409b2a`) chiudeva il ramo terminale APPUNTAMENTO, che nel cron sta **dopo** il re-drive: per questo era parziale. Stato residuo oggi: 21 conversazioni `active` con un `bot_outcome` già registrato (11 INTERROTTO, 8 NON_RISPOSTO, 2 RICHIAMO) e 2 conversazioni GDO ancora nel loop.

**Punto 3 — perché zero chiamate.** `handleGdoDeliveryUpdate` (`lib/send-agenda-gdo.ts:185`) è già scritta e già cablata nel webhook Twilio (`app/api/webhooks/twilio/route.ts:68`). Esce senza fare nulla alla riga 222 perché `CRM_AGENDA_DELIVERED_URL` **non è mai stata configurata** (assente da `.env.local`, che è la copia dell'ambiente Vercel). Non è codice mancante: è una env mai messa.

---

## File Structure

| file | responsabilità | task |
|---|---|---|
| `lib/bot-contract.ts` | `+CONTATTO_UMANO` nell'union e in `OUTCOMES`, fuori da `DATE_REQUIRED`, nota obbligatoria; `parseAppointmentSetPayload` | 1.1, 2.1 |
| `lib/bot-outcome-rules.ts` | `buildContattoUmanoNote`, riscrittura di `buildLockedNote` in formato fattuale, `buildBotRipresoNote` | 1.2, 5.1, 6.2 |
| `lib/bot-outcome.ts` | ramo CONTATTO_UMANO prima di `resolveOutcomeAction`; `sendCrmNota` esportata | 1.3, 6.2 |
| `lib/fenice-autoreply.ts` | invio del CONTATTO_UMANO dove oggi si imposta `handed_off` | 1.4 |
| `lib/appointment-set.ts` (nuovo) | `runAppointmentSet`: idempotenza, spostamenti, lead sconosciuto | 2.2 |
| `app/api/appointment-set/route.ts` (nuovo) | porta HTTP: rate limit, HMAC, parse, delega | 2.3 |
| `lib/send-agenda-gdo.ts` | URL di default per l'avviso di consegna | 3.1 |
| `lib/sequence.ts` | soglia e condizioni di `decideTrackB` per INTERROTTO | 6.1 |
| `app/api/webhooks/twilio/route.ts` | nota "il bot ha ripreso" alla riapertura di una chat già restituita | 6.2 |
| `supabase/migrations/20260806000001_ai_redrive_at.sql` (nuovo) | colonna che rende il re-drive non ripetibile | 7.1 |
| `app/api/cron/bot-followups/route.ts` | re-drive una volta sola per inbound; chiusura di ogni conversazione già esitata | 7.2, 7.3 |
| `scripts/` | sanatorie una-tantum (backfill CONTATTO_UMANO, agende consegnate, conversazioni appese) | 1.5, 3.2, 7.4 |
| `docs/crm/2026-08-06-risposta-lead-fermi.md` (nuovo) | il conteggio per causa da girare al CRM | 4.1 |

---

# Punto 1 — l'esito CONTATTO_UMANO

**Branch:** `feat/esito-contatto-umano` (da `main`)

Oggi il tag `[PASSAGGIO_UMANO]` imposta solo `ai_status='handed_off'` in locale (`lib/fenice-autoreply.ts:460`) e non manda niente al CRM: le richieste di parlare con una persona muoiono nel nostro database. Sono 6 casi solo nei 338 del CSV.

Contratto (in produzione lato CRM dal 05/08): `POST /api/bot/outcome`, stessa firma HMAC, `{ leadId, outcome: "CONTATTO_UMANO", note }`. `note` obbligatoria (senza → 400), deve contenere la richiesta concreta del lead **con le sue parole**. Non cambia stato, non riassegna, non tocca l'appuntamento. Ripetibile: se c'è già stata una notifica nelle 24h sullo stesso lead la risposta è `{ "ok": true, "notifySuppressed": true }` — non è un errore, non si ritenta. Risposta OK: `{ "ok": true, "noted": true }`.

### Task 1.1: il contratto accetta CONTATTO_UMANO

**Files:**
- Modify: `lib/bot-contract.ts:22,42-43,102-114`
- Test: `lib/bot-contract.test.ts`

**Interfaces:**
- Produces: `BotOutcome` include `'CONTATTO_UMANO'`; `validateOutcomeBody` lo accetta solo con `note` non vuota e **non** gli richiede `date`.

- [ ] **Step 1: Scrivi i test che falliscono**

In `lib/bot-contract.test.ts`, in coda:

```ts
describe('CONTATTO_UMANO', () => {
  it('è un esito valido con una nota', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'CONTATTO_UMANO', note: 'vuole parlare con una persona' }))
      .toEqual({ ok: true });
  });

  it('senza nota non parte: il CRM risponderebbe 400', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'CONTATTO_UMANO' }))
      .toEqual({ ok: false, reason: 'note_required' });
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'CONTATTO_UMANO', note: '   ' }))
      .toEqual({ ok: false, reason: 'note_required' });
  });

  it('NON richiede una data: non è un appuntamento, è una segnalazione', () => {
    expect(validateOutcomeBody({ leadId: 'u1', outcome: 'CONTATTO_UMANO', note: 'x' }))
      .toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/bot-contract.test.ts`
Expected: FAIL — `outcome` non è fra gli `OUTCOMES`, quindi `bad_request`.

- [ ] **Step 3: Implementa**

In `lib/bot-contract.ts`:

```ts
export type BotOutcome = 'APPUNTAMENTO' | 'DA_SCARTARE' | 'RICHIAMO' | 'NON_RISPOSTO' | 'INTERROTTO' | 'NOTA' | 'CONTATTO_UMANO';
```

```ts
const OUTCOMES: BotOutcome[] = ['APPUNTAMENTO', 'DA_SCARTARE', 'RICHIAMO', 'NON_RISPOSTO', 'INTERROTTO', 'NOTA', 'CONTATTO_UMANO'];
// CONTATTO_UMANO resta FUORI da DATE_REQUIRED: non è un appuntamento, è una
// segnalazione. Chiedere una data qui rimetterebbe il modello nella condizione di
// inventarne una (vedi il fix delle date di RICHIAMO del 06/08).
const DATE_REQUIRED: BotOutcome[] = ['APPUNTAMENTO', 'RICHIAMO'];
```

e in `validateOutcomeBody`, sostituendo il controllo sulla sola `NOTA`:

```ts
  // La nota È il contenuto per questi due esiti: senza, il CRM risponde 400.
  if ((b.outcome === 'NOTA' || b.outcome === 'CONTATTO_UMANO') && (!b.note || !b.note.trim())) {
    return { ok: false, reason: 'note_required' };
  }
```

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/bot-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/bot-contract.ts lib/bot-contract.test.ts
git commit -m "feat(crm): il contratto accetta l'esito CONTATTO_UMANO"
```

### Task 1.2: la nota riporta le parole del lead

**Files:**
- Modify: `lib/bot-outcome-rules.ts`
- Test: `lib/bot-outcome-rules.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces: `buildContattoUmanoNote(input: { leadWords?: string; motivo?: string }): string`.

Le Conferme devono capire in tre secondi **cosa** ha chiesto il lead. Il fatto in testa, poi le sue parole tra virgolette. Niente parafrasi.

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
import { buildContattoUmanoNote } from './bot-outcome-rules';

describe('buildContattoUmanoNote', () => {
  it('mette in testa il fatto e poi le parole del lead', () => {
    const n = buildContattoUmanoNote({ leadWords: 'posso parlare con un vostro operatore?' });
    expect(n).toContain('RICHIESTA DI PARLARE CON UNA PERSONA');
    expect(n).toContain('"posso parlare con un vostro operatore?"');
  });

  it('senza le parole del lead dice che la richiesta è esplicita, senza inventarne il contenuto', () => {
    const n = buildContattoUmanoNote({});
    expect(n).toContain('RICHIESTA DI PARLARE CON UNA PERSONA');
    expect(n).not.toContain('""');
    expect(n.trim().length).toBeGreaterThan(0);
  });

  it('taglia i messaggi fiume ma non a metà parola, e segnala il taglio', () => {
    const lungo = 'ho bisogno di parlare con qualcuno perché '.repeat(30);
    const n = buildContattoUmanoNote({ leadWords: lungo });
    expect(n.length).toBeLessThan(700);
    expect(n).toContain('…');
  });

  it('normalizza gli a-capo: la nota deve restare leggibile su una riga sul CRM', () => {
    const n = buildContattoUmanoNote({ leadWords: 'voglio\nparlare\ncon   qualcuno' });
    expect(n).toContain('"voglio parlare con qualcuno"');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/bot-outcome-rules.test.ts`
Expected: FAIL — `buildContattoUmanoNote is not a function`.

- [ ] **Step 3: Implementa**

In coda a `lib/bot-outcome-rules.ts`:

```ts
/** Oltre questa lunghezza la nota smette di essere leggibile al volo. */
const MAX_PAROLE_LEAD = 400;

/** Le parole del lead, pulite: a-capo e spazi doppi via, taglio su confine di parola. */
export function paroleDelLead(testo: string | undefined, max = MAX_PAROLE_LEAD): string | null {
  const pulito = (testo ?? '').replace(/\s+/g, ' ').trim();
  if (!pulito) return null;
  if (pulito.length <= max) return pulito;
  const tagliato = pulito.slice(0, max);
  const ultimo = tagliato.lastIndexOf(' ');
  return `${(ultimo > max * 0.6 ? tagliato.slice(0, ultimo) : tagliato).trimEnd()}…`;
}

/**
 * La nota del CONTATTO_UMANO. Il CRM la mostra alle Conferme poco prima di chiamare:
 * il fatto in testa, poi le parole del lead. La richiesta non si parafrasa mai — "vuole
 * assistenza" e "voglio disdire e parlare con un responsabile" non sono la stessa cosa.
 */
export function buildContattoUmanoNote(input: { leadWords?: string; motivo?: string }): string {
  const parole = paroleDelLead(input.leadWords);
  const motivo = input.motivo?.replace(/\s+/g, ' ').trim();
  const coda = parole
    ? ` Parole del lead: "${parole}".`
    : ' Il lead ha chiesto esplicitamente di parlare con una persona.';
  const contesto = motivo ? ` Contesto: ${motivo}.` : '';
  return `RICHIESTA DI PARLARE CON UNA PERSONA — il bot si è fatto da parte.${coda}${contesto}`;
}
```

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/bot-outcome-rules.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/bot-outcome-rules.ts lib/bot-outcome-rules.test.ts
git commit -m "feat(crm): la nota del contatto umano riporta le parole del lead"
```

### Task 1.3: `sendOutcome` sa spedire un CONTATTO_UMANO

**Files:**
- Modify: `lib/bot-outcome.ts:171-220`
- Test: `lib/bot-outcome.test.ts`

**Interfaces:**
- Consumes: `buildContattoUmanoNote` (Task 1.2), `BotOutcome` con `CONTATTO_UMANO` (Task 1.1).
- Produces: `sendOutcome(supabase, id, { outcome: 'CONTATTO_UMANO', note })` fa il POST e **non** scrive `bot_outcome`, `bot_outcome_at`, `bot_scheduled_at` né `ai_status`. Ritorna `{ sent, status?, error?, notifySuppressed?: true }`.

È una segnalazione, non un esito: deve passare **prima** di `resolveOutcomeAction`, altrimenti su un lead già APPUNTAMENTO diventerebbe una NOTA generica e la richiesta si perderebbe di nuovo.

- [ ] **Step 1: Scrivi i test che falliscono**

Usa il fake Supabase già presente nel file (stesso stile dei test di `richiamo_senza_data`).

```ts
describe('CONTATTO_UMANO', () => {
  it('fa il POST e non tocca nessuno stato locale', async () => {
    const { supabase, calls } = fakeSupabase({ crm_lead_id: 'lead-1', bot_outcome: null, bot_scheduled_at: null });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, noted: true }), { status: 200 }));
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'voglio parlare con una persona' });
    expect(res.sent).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.outcome).toBe('CONTATTO_UMANO');
    expect(body.date).toBeUndefined();
    expect(body.note).toContain('voglio parlare con una persona');
    expect(calls.conversationUpdates).toEqual([]);
  });

  it('su un lead già APPUNTAMENTO parte lo stesso come CONTATTO_UMANO, non come NOTA', async () => {
    const { supabase } = fakeSupabase({ crm_lead_id: 'lead-1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: '2026-08-07T18:00:00+02:00' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, noted: true }), { status: 200 }));
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'passatemi un responsabile' });
    expect(res.sent).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).outcome).toBe('CONTATTO_UMANO');
  });

  it('notifySuppressed non è un errore e non si ritenta', async () => {
    const { supabase, calls } = fakeSupabase({ crm_lead_id: 'lead-1', bot_outcome: null, bot_scheduled_at: null });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, notifySuppressed: true }), { status: 200 }));
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO', note: 'ancora io' });
    expect(res.sent).toBe(true);
    expect(res.notifySuppressed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls.eventTypes).toContain('bot_contatto_umano_soppresso');
  });

  it('senza nota non parte nessuna chiamata', async () => {
    const { supabase } = fakeSupabase({ crm_lead_id: 'lead-1', bot_outcome: null, bot_scheduled_at: null });
    const res = await sendOutcome(supabase, 1, { outcome: 'CONTATTO_UMANO' });
    expect(res.sent).toBe(false);
    expect(res.error).toBe('note_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/bot-outcome.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementa**

In `lib/bot-outcome.ts`, subito **dopo** il ramo `opts.noteOnly` e **prima** del controllo `checkDataRichiamo`:

```ts
  // CONTATTO_UMANO è una segnalazione, non un esito: non cambia stato, non
  // riassegna, non tocca l'appuntamento. Passa prima di resolveOutcomeAction
  // apposta — su un lead già APPUNTAMENTO diventerebbe una NOTA generica e la
  // richiesta di parlare con una persona si perderebbe un'altra volta.
  if (args.outcome === 'CONTATTO_UMANO') {
    return inviaContattoUmano(supabase, conversationId, crmLeadId, args, secret);
  }
```

e la funzione, sopra `sendOutcome`:

```ts
async function inviaContattoUmano(
  supabase: Supa,
  conversationId: number,
  crmLeadId: string,
  args: SendOutcomeArgs,
  secret: string,
): Promise<{ sent: boolean; status?: number; error?: string; notifySuppressed?: true }> {
  const note = buildContattoUmanoNote({ leadWords: args.note, motivo: args.discardReason });
  const body: BotOutcomeBody = { leadId: crmLeadId, outcome: 'CONTATTO_UMANO', note };
  const valid = validateOutcomeBody(body);
  if (!valid.ok) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, reason: valid.reason, outcome: 'CONTATTO_UMANO' } as never,
      message: `[bot-fissatore] contatto umano non valido per lead ${crmLeadId}: ${valid.reason}`,
      level: 'error',
    });
    return { sent: false, error: valid.reason };
  }

  const rawBody = JSON.stringify(body);
  const url = process.env.CRM_OUTCOME_URL ?? DEFAULT_CRM_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-signature': signPayload(rawBody, secret) },
      body: rawBody,
    });
    const testo = await res.text().catch(() => '');
    if (res.ok) {
      // Il CRM sopprime la notifica se ce n'è già stata una nelle 24h sullo stesso
      // lead. Non è un errore e non si ritenta: si registra e basta.
      let soppressa = false;
      try { soppressa = JSON.parse(testo)?.notifySuppressed === true; } catch { /* corpo non JSON: vale come notifica passata */ }
      await supabase.from('event_log').insert({
        type: soppressa ? 'bot_contatto_umano_soppresso' : 'bot_contatto_umano_inviato',
        payload: { conversationId, crmLeadId, note } as never,
        message: soppressa
          ? `[bot-fissatore] contatto umano già segnalato nelle ultime 24h per lead ${crmLeadId}: notifica soppressa dal CRM`
          : `[bot-fissatore] contatto umano segnalato al CRM per lead ${crmLeadId}`,
        level: 'info',
      });
      return soppressa ? { sent: true, status: res.status, notifySuppressed: true } : { sent: true, status: res.status };
    }
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, outcome: 'CONTATTO_UMANO', status: res.status, body: testo } as never,
      message: `[bot-fissatore] il CRM ha risposto ${res.status} al contatto umano per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, status: res.status, error: testo || `http_${res.status}` };
  } catch (e) {
    const errore = e instanceof Error ? e.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, outcome: 'CONTATTO_UMANO', error: errore } as never,
      message: `[bot-fissatore] segnalazione del contatto umano fallita (rete) per lead ${crmLeadId}`,
      level: 'error',
    });
    return { sent: false, error: errore };
  }
}
```

Aggiungi `buildContattoUmanoNote` all'import da `./bot-outcome-rules` e `notifySuppressed?: true` al tipo di ritorno di `sendOutcome`.

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/bot-outcome.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/bot-outcome.ts lib/bot-outcome.test.ts
git commit -m "feat(crm): sendOutcome segnala il contatto umano senza toccare lo stato"
```

### Task 1.4: il drain segnala il passaggio a una persona

**Files:**
- Modify: `lib/fenice-autoreply.ts:460`
- Test: `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Consumes: `sendOutcome` con `CONTATTO_UMANO` (Task 1.3).
- Produces: nessuna nuova API. Comportamento: quando `result.passToHuman` è vero e la conversazione è CRM-linked, parte il POST **prima** di impostare `handed_off`.

Le parole del lead sono **l'ultimo messaggio inbound della cronologia**, non una parafrasi del modello: `history` è già in scope nel drain e il suo ultimo turno `user` è esattamente ciò che il lead ha scritto.

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
it('passToHuman su lead CRM: segnala CONTATTO_UMANO al CRM con le parole del lead, poi handed_off', async () => {
  const { supabase, calls } = fakeDrain({ crmLeadId: 'lead-9' });
  gen.mockResolvedValueOnce({
    visibleReply: 'Certo, ti metto subito in contatto con un mio collega.',
    appointmentFixed: false, passToHuman: true, videoWatched: false,
  });
  await drainMarioReplies(supabase, 1, '+393330000000', () => 0);
  expect(calls.sendOutcome).toHaveLength(1);
  expect(calls.sendOutcome[0].args.outcome).toBe('CONTATTO_UMANO');
  expect(calls.sendOutcome[0].args.note).toContain('voglio parlare con una persona');
  expect(calls.finalStatusWrites).toEqual(['handed_off']);
});

it('passToHuman su lead NON CRM: nessuna chiamata al CRM, solo handed_off', async () => {
  const { supabase, calls } = fakeDrain({ crmLeadId: null });
  gen.mockResolvedValueOnce({
    visibleReply: 'Ti passo un collega.',
    appointmentFixed: false, passToHuman: true, videoWatched: false,
  });
  await drainMarioReplies(supabase, 1, '+393330000000', () => 0);
  expect(calls.sendOutcome).toHaveLength(0);
  expect(calls.finalStatusWrites).toEqual(['handed_off']);
});

it('un CRM che risponde male non blocca il passaggio all\'umano', async () => {
  const { supabase, calls } = fakeDrain({ crmLeadId: 'lead-9', sendOutcomeResult: { sent: false, error: 'http_500' } });
  gen.mockResolvedValueOnce({
    visibleReply: 'Ti passo un collega.',
    appointmentFixed: false, passToHuman: true, videoWatched: false,
  });
  await drainMarioReplies(supabase, 1, '+393330000000', () => 0);
  expect(calls.finalStatusWrites).toEqual(['handed_off']);
});
```

Il fake del drain deve avere fra i messaggi un inbound finale `voglio parlare con una persona`.

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: FAIL — `calls.sendOutcome` vuoto.

- [ ] **Step 3: Implementa**

In `lib/fenice-autoreply.ts`, sostituisci la riga 460:

```ts
      if (result.passToHuman) {
        // Il CRM ha un esito apposta: senza questa chiamata la richiesta di parlare
        // con una persona resta solo nel nostro database e nessuno la vede. Le parole
        // che mandiamo sono quelle del lead, prese dall'ultimo turno della cronologia:
        // una parafrasi del modello cambierebbe il senso della richiesta.
        if (crmLeadId) {
          const ultimoDelLead = [...history].reverse().find((t) => t.role === 'user')?.content;
          const esito = await sendOutcome(supabase, conversationId, {
            outcome: 'CONTATTO_UMANO',
            note: ultimoDelLead,
          });
          // Un CRM che non risponde non deve tenere il bot incollato a una chat che
          // deve prendere una persona: si registra e si va avanti.
          if (!esito.sent) {
            await supabase.from('event_log').insert({
              type: 'contatto_umano_non_segnalato',
              payload: { conversationId, crmLeadId, error: esito.error ?? null, status: esito.status ?? null } as never,
              message: `[bot-fissatore] conv ${conversationId}: passaggio a una persona non segnalato al CRM (${esito.error ?? esito.status})`,
              level: 'error',
            });
          }
        }
        finalStatus = 'handed_off';
        break;
      }
```

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: PASS

- [ ] **Step 5: Prova di mutazione**

Togli temporaneamente `if (crmLeadId)` e il blocco `sendOutcome`, rilancia i test: i due nuovi devono fallire. Rimetti tutto.

- [ ] **Step 6: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(crm): la richiesta di parlare con una persona arriva al CRM"
```

### Task 1.5: sanatoria degli `handed_off` mai segnalati

**Files:**
- Create: `scripts/segnala-handed-off-arretrati.mjs`

Sono i 6 casi del CSV più tutti gli altri `handed_off` senza `bot_outcome`. Il CRM sopprime i doppioni nelle 24h, quindi lo script è ri-eseguibile senza danno.

- [ ] **Step 1: Scrivi lo script**

```js
// Segnala al CRM i passaggi a una persona mai comunicati (esito CONTATTO_UMANO).
// Il CRM sopprime i doppioni nelle 24h: lo script è ri-eseguibile.
// Uso: node --env-file=.env.local scripts/segnala-handed-off-arretrati.mjs [--esegui]
const ESEGUI = process.argv.includes('--esegui');
const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = process.env.NEXT_PUBLIC_APP_URL;
const CRON = process.env.CRON_SECRET;
if (!URL_BASE || !KEY || !APP || !CRON) throw new Error('env mancanti');

const q = async (p) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
};

const convs = await q(`conversations?select=id,crm_lead_id&ai_status=eq.handed_off&bot_outcome=is.null&crm_lead_id=not.is.null&order=id.asc&limit=1000`);
console.log(`conversazioni handed_off senza esito: ${convs.length}`);

for (const c of convs) {
  const m = await q(`messages?select=body,created_at&conversation_id=eq.${c.id}&direction=eq.in&order=created_at.desc&limit=1`);
  const parole = m[0]?.body ?? '';
  console.log(`conv ${c.id} lead ${c.crm_lead_id}: "${parole.replace(/\s+/g, ' ').slice(0, 80)}"`);
  if (!ESEGUI) continue;
  const r = await fetch(`${APP}/api/cron/resend-outcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${CRON}` },
    body: JSON.stringify({ conversationId: c.id, outcome: 'CONTATTO_UMANO', note: parole }),
  });
  console.log(`   → ${r.status} ${(await r.text()).slice(0, 120)}`);
}
if (!ESEGUI) console.log('\n(prova a vuoto: rilancia con --esegui per mandarli davvero)');
```

- [ ] **Step 2: Prova a vuoto**

Run: `node --env-file=.env.local scripts/segnala-handed-off-arretrati.mjs`
Expected: elenca le conversazioni e le parole del lead, senza chiamare il CRM.

- [ ] **Step 3: Commit (l'esecuzione avviene dopo il deploy del Task 1.4)**

```bash
git add scripts/segnala-handed-off-arretrati.mjs
git commit -m "chore(crm): script per segnalare i passaggi a una persona arretrati"
```

- [ ] **Step 4: Suite completa e merge**

Run: `npm test && npx tsc --noEmit`
Expected: tutto verde. Poi merge su `main` e deploy; **dopo** il deploy, `node --env-file=.env.local scripts/segnala-handed-off-arretrati.mjs --esegui`.

---

# Punto 2 — l'endpoint `/api/appointment-set`

**Branch:** `feat/appointment-set` (da `main`)

Il CRM ci chiama a ogni appuntamento fissato o spostato per darci data e ora. Stessa firma HMAC di `/api/send-agenda`. **L'endpoint non esiste**: le loro chiamate falliscono in silenzio (404 di Vercel, nessuna traccia da noi).

Con la data vera `lib/gdo-video-followup.ts` smette di indovinare: oggi usa `ORA_AGENDA_TARDI = 18` come ripiego e tace del tutto se l'agenda arriva a sera. Loro dato: su 274 casi in 4 giorni, in 265 la data arriva **dopo** l'agenda, in media 65 secondi dopo — quindi l'endpoint deve gestire sia il primo set sia gli spostamenti successivi, idempotente sull'ultima data ricevuta.

**Niente migration:** `conversations.gdo_appuntamento_at` esiste già (migration `20260801000001`), creata vuota proprio in attesa di questo campo.

**Contratto lato nostro (deciso il 06/08, in assenza della loro specifica):** parser tollerante sui nomi dei campi, e log del corpo grezzo per tutto ciò che non riconosciamo — entro poche ore le loro chiamate vere ci dicono lo schema esatto. La data invece **deve** avere l'offset di fuso: un appuntamento sbagliato di due ore in silenzio è peggio di un 400 rumoroso, ed è la stessa regola che loro applicano a noi.

### Task 2.1: il parser del payload in arrivo

**Files:**
- Modify: `lib/bot-contract.ts`
- Test: `lib/bot-contract.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AppointmentSetPayload { leadId: string; appointmentAt: string }
  export function parseAppointmentSetPayload(raw: unknown):
    | { ok: true; value: AppointmentSetPayload }
    | { ok: false; reason: 'bad_request' | 'lead_mancante' | 'data_mancante' | 'data_senza_offset' };
  ```

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
import { parseAppointmentSetPayload } from './bot-contract';

describe('parseAppointmentSetPayload', () => {
  const DATA = '2026-08-07T18:00:00+02:00';

  it('la forma canonica', () => {
    expect(parseAppointmentSetPayload({ leadId: 'u1', appointmentAt: DATA }))
      .toEqual({ ok: true, value: { leadId: 'u1', appointmentAt: DATA } });
  });

  it('accetta gli alias del lead: non conosciamo ancora i loro nomi esatti', () => {
    for (const k of ['leadId', 'lead_id', 'crmLeadId', 'crm_lead_id']) {
      expect(parseAppointmentSetPayload({ [k]: 'u1', appointmentAt: DATA }))
        .toEqual({ ok: true, value: { leadId: 'u1', appointmentAt: DATA } });
    }
  });

  it('accetta gli alias della data', () => {
    for (const k of ['appointmentAt', 'appuntamentoAt', 'appointment_at', 'appuntamento_at', 'date', 'at']) {
      expect(parseAppointmentSetPayload({ leadId: 'u1', [k]: DATA }))
        .toEqual({ ok: true, value: { leadId: 'u1', appointmentAt: DATA } });
    }
  });

  it('una data senza offset di fuso non si indovina', () => {
    expect(parseAppointmentSetPayload({ leadId: 'u1', appointmentAt: '2026-08-07T18:00:00' }))
      .toEqual({ ok: false, reason: 'data_senza_offset' });
    expect(parseAppointmentSetPayload({ leadId: 'u1', appointmentAt: '07/08/2026 18:00' }))
      .toEqual({ ok: false, reason: 'data_senza_offset' });
  });

  it('distingue lead mancante da data mancante: il messaggio d\'errore deve dirglielo', () => {
    expect(parseAppointmentSetPayload({ appointmentAt: DATA })).toEqual({ ok: false, reason: 'lead_mancante' });
    expect(parseAppointmentSetPayload({ leadId: 'u1' })).toEqual({ ok: false, reason: 'data_mancante' });
  });

  it('corpo non-oggetto', () => {
    expect(parseAppointmentSetPayload(null)).toEqual({ ok: false, reason: 'bad_request' });
    expect(parseAppointmentSetPayload('ciao')).toEqual({ ok: false, reason: 'bad_request' });
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/bot-contract.test.ts`
Expected: FAIL — `parseAppointmentSetPayload is not a function`.

- [ ] **Step 3: Implementa**

In coda a `lib/bot-contract.ts`:

```ts
/** Data e ora della call comunicate dal CRM: primo fissaggio o spostamento. */
export interface AppointmentSetPayload {
  leadId: string;
  /** ISO 8601 con offset esplicito. */
  appointmentAt: string;
}

// Non abbiamo la loro specifica scritta: si accettano gli alias plausibili e si
// registra il grezzo di tutto il resto (vedi il route), così le loro chiamate vere
// ci dicono lo schema invece di farci aspettare un documento.
const ALIAS_LEAD = ['leadId', 'lead_id', 'crmLeadId', 'crm_lead_id'] as const;
const ALIAS_DATA = ['appointmentAt', 'appuntamentoAt', 'appointment_at', 'appuntamento_at', 'date', 'at', 'scheduledAt', 'scheduled_at'] as const;

const primaStringa = (o: Record<string, unknown>, chiavi: readonly string[]): string | null => {
  for (const k of chiavi) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

export function parseAppointmentSetPayload(
  raw: unknown,
): { ok: true; value: AppointmentSetPayload } | { ok: false; reason: 'bad_request' | 'lead_mancante' | 'data_mancante' | 'data_senza_offset' } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_request' };
  const o = raw as Record<string, unknown>;
  const leadId = primaStringa(o, ALIAS_LEAD);
  if (!leadId) return { ok: false, reason: 'lead_mancante' };
  const data = primaStringa(o, ALIAS_DATA);
  if (!data) return { ok: false, reason: 'data_mancante' };
  // Senza offset non sappiamo se le 18:00 sono italiane o UTC. Due ore di errore in
  // silenzio valgono meno di un 400 che si legge subito: è la stessa regola che il
  // loro endpoint applica alle date che mandiamo noi.
  if (!isoWithOffset(data)) return { ok: false, reason: 'data_senza_offset' };
  return { ok: true, value: { leadId, appointmentAt: data } };
}
```

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/bot-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/bot-contract.ts lib/bot-contract.test.ts
git commit -m "feat(crm): parser tollerante per la data dell'appuntamento in arrivo"
```

### Task 2.2: `runAppointmentSet` — primo set e spostamenti

**Files:**
- Create: `lib/appointment-set.ts`
- Test: `lib/appointment-set.test.ts`

**Interfaces:**
- Consumes: `AppointmentSetPayload` (Task 2.1).
- Produces:
  ```ts
  export type AppointmentSetEsito = 'registrato' | 'spostato' | 'invariato' | 'lead_sconosciuto';
  export async function runAppointmentSet(
    supabase: Supa, payload: AppointmentSetPayload,
  ): Promise<{ ok: boolean; esito: AppointmentSetEsito; conversationId?: number; precedente?: string | null }>
  ```

Scrive **solo** `gdo_appuntamento_at`. Non tocca `bot_scheduled_at`: quello è il registro del nostro esito, e riscriverlo interferirebbe con la logica del lead terminale (`resolveOutcomeAction`) e con le note di spostamento.

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
import { describe, it, expect } from 'vitest';
import { runAppointmentSet } from './appointment-set';

// fake Supabase minimo, stesso stile di lib/send-agenda-gdo.test.ts
function fake(conv: { id: number; gdo_appuntamento_at: string | null } | null) {
  const updates: Record<string, unknown>[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const supabase = {
    from(tabella: string) {
      if (tabella === 'event_log') {
        return { insert: async (r: { type: string; payload: Record<string, unknown> }) => { events.push(r); return { data: null }; } };
      }
      return {
        select: () => ({
          eq: () => ({
            order: () => ({ limit: async () => ({ data: conv ? [conv] : [] }) }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({ eq: async () => { updates.push(patch); return { data: null }; } }),
      };
    },
  } as never;
  return { supabase, updates, events };
}

const D1 = '2026-08-07T18:00:00+02:00';
const D2 = '2026-08-09T10:30:00+02:00';

describe('runAppointmentSet', () => {
  it('primo set: scrive la data', async () => {
    const { supabase, updates } = fake({ id: 7, gdo_appuntamento_at: null });
    const r = await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D1 });
    expect(r).toMatchObject({ ok: true, esito: 'registrato', conversationId: 7 });
    expect(updates).toEqual([{ gdo_appuntamento_at: D1 }]);
  });

  it('spostamento: sovrascrive con l\'ultima data ricevuta', async () => {
    const { supabase, updates, events } = fake({ id: 7, gdo_appuntamento_at: D1 });
    const r = await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D2 });
    expect(r).toMatchObject({ ok: true, esito: 'spostato', precedente: D1 });
    expect(updates).toEqual([{ gdo_appuntamento_at: D2 }]);
    expect(events.map((e) => e.type)).toContain('appuntamento_spostato');
  });

  it('stessa data ripetuta: idempotente, nessuna scrittura', async () => {
    const { supabase, updates } = fake({ id: 7, gdo_appuntamento_at: D1 });
    const r = await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D1 });
    expect(r).toMatchObject({ ok: true, esito: 'invariato' });
    expect(updates).toEqual([]);
  });

  it('stesso istante scritto diversamente vale come invariato', async () => {
    const { supabase, updates } = fake({ id: 7, gdo_appuntamento_at: '2026-08-07T16:00:00+00:00' });
    const r = await runAppointmentSet(supabase, { leadId: 'u1', appointmentAt: D1 });
    expect(r.esito).toBe('invariato');
    expect(updates).toEqual([]);
  });

  it('lead che non conosciamo: non è un errore, si registra e si risponde', async () => {
    const { supabase, events } = fake(null);
    const r = await runAppointmentSet(supabase, { leadId: 'ignoto', appointmentAt: D1 });
    expect(r).toMatchObject({ ok: true, esito: 'lead_sconosciuto' });
    expect(events.map((e) => e.type)).toContain('appuntamento_lead_sconosciuto');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/appointment-set.test.ts`
Expected: FAIL — il modulo non esiste.

- [ ] **Step 3: Implementa**

`lib/appointment-set.ts`:

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import type { AppointmentSetPayload } from './bot-contract';
import { sameInstant } from './rome-time';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type AppointmentSetEsito = 'registrato' | 'spostato' | 'invariato' | 'lead_sconosciuto';

/**
 * Il CRM ci comunica data e ora della call, al primo fissaggio e a ogni spostamento.
 * Sui loro dati la data arriva quasi sempre DOPO l'agenda (265 casi su 274, in media
 * 65 secondi dopo): il primo set e lo spostamento sono lo stesso gesto, e vince
 * sempre l'ultima data ricevuta.
 *
 * Scrive solo `gdo_appuntamento_at`. `bot_scheduled_at` resta il registro del NOSTRO
 * esito: riscriverlo qui cambierebbe il significato delle note di spostamento e la
 * logica del lead terminale.
 */
export async function runAppointmentSet(
  supabase: Supa,
  payload: AppointmentSetPayload,
): Promise<{ ok: boolean; esito: AppointmentSetEsito; conversationId?: number; precedente?: string | null }> {
  const { data } = await supabase
    .from('conversations')
    .select('id, gdo_appuntamento_at')
    .eq('crm_lead_id', payload.leadId)
    .order('id', { ascending: false })
    .limit(1);
  const conv = ((data ?? []) as unknown as { id: number; gdo_appuntamento_at: string | null }[])[0];

  if (!conv) {
    // Può succedere davvero: il GDO fissa un lead che il bot non ha mai avuto. Un 404
    // li manderebbe in ritentativo su una cosa che non cambierà.
    await supabase.from('event_log').insert({
      type: 'appuntamento_lead_sconosciuto',
      payload: { crmLeadId: payload.leadId, appointmentAt: payload.appointmentAt } as never,
      message: `[crm] data appuntamento per un lead che non abbiamo: ${payload.leadId}`,
      level: 'info',
    });
    return { ok: true, esito: 'lead_sconosciuto' };
  }

  const precedente = conv.gdo_appuntamento_at;
  // Confronto per istante, non per stringa: la stessa ora arriva da Postgres in UTC e
  // da loro nel fuso italiano, e due stringhe diverse sarebbero lo stesso momento.
  if (precedente && sameInstant(payload.appointmentAt, precedente)) {
    return { ok: true, esito: 'invariato', conversationId: conv.id, precedente };
  }

  await supabase
    .from('conversations')
    .update({ gdo_appuntamento_at: payload.appointmentAt })
    .eq('id', conv.id);

  if (precedente) {
    await supabase.from('event_log').insert({
      type: 'appuntamento_spostato',
      payload: { crmLeadId: payload.leadId, conversationId: conv.id, da: precedente, a: payload.appointmentAt } as never,
      message: `[crm] appuntamento del lead ${payload.leadId} spostato da ${precedente} a ${payload.appointmentAt}`,
      level: 'info',
    });
    return { ok: true, esito: 'spostato', conversationId: conv.id, precedente };
  }

  await supabase.from('event_log').insert({
    type: 'appuntamento_registrato',
    payload: { crmLeadId: payload.leadId, conversationId: conv.id, appointmentAt: payload.appointmentAt } as never,
    message: `[crm] data della call registrata per il lead ${payload.leadId}: ${payload.appointmentAt}`,
    level: 'info',
  });
  return { ok: true, esito: 'registrato', conversationId: conv.id, precedente: null };
}
```

Se `sameInstant` non è esportata da `lib/rome-time.ts` con questa firma, verificalo prima: è già usata così in `lib/bot-outcome-rules.ts:41`.

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/appointment-set.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/appointment-set.ts lib/appointment-set.test.ts
git commit -m "feat(crm): registriamo la data della call, primo set e spostamenti"
```

### Task 2.3: il route `POST /api/appointment-set`

**Files:**
- Create: `app/api/appointment-set/route.ts`
- Test: `app/api/appointment-set/route.test.ts`

**Interfaces:**
- Consumes: `parseAppointmentSetPayload` (2.1), `runAppointmentSet` (2.2), `verifySignature` (`lib/bot-hmac.ts`), `checkRateLimit` (`lib/rate-limit.ts`).

- [ ] **Step 1: Leggi la documentazione dei route handler**

Run: `ls node_modules/next/dist/docs/` e leggi la guida sui Route Handler prima di scrivere il file. Non dare per scontate le firme di `NextRequest`/`NextResponse` note da altre versioni.

- [ ] **Step 2: Scrivi i test che falliscono**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ getSupabaseAdmin: () => ({ from: () => ({}) }) }));
const runMock = vi.fn();
vi.mock('@/lib/appointment-set', () => ({ runAppointmentSet: (...a: unknown[]) => runMock(...a) }));

import { POST } from './route';
import { signPayload } from '@/lib/bot-hmac';

const SEGRETO = 'segreto-di-test';
const chiama = (body: string, firma?: string) =>
  POST(new Request('https://x/api/appointment-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(firma ? { 'x-bot-signature': firma } : {}) },
    body,
  }) as never);

beforeEach(() => {
  process.env.BOT_WEBHOOK_SECRET = SEGRETO;
  runMock.mockReset();
  runMock.mockResolvedValue({ ok: true, esito: 'registrato', conversationId: 7 });
});

it('firma sbagliata → 401 e nessuna scrittura', async () => {
  const body = JSON.stringify({ leadId: 'u1', appointmentAt: '2026-08-07T18:00:00+02:00' });
  const res = await chiama(body, 'firma-finta');
  expect(res.status).toBe(401);
  expect(runMock).not.toHaveBeenCalled();
});

it('firma buona → 200 con l\'esito', async () => {
  const body = JSON.stringify({ leadId: 'u1', appointmentAt: '2026-08-07T18:00:00+02:00' });
  const res = await chiama(body, signPayload(body, SEGRETO));
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ ok: true, esito: 'registrato' });
});

it('data senza offset → 400 con un messaggio che dice cosa correggere', async () => {
  const body = JSON.stringify({ leadId: 'u1', appointmentAt: '2026-08-07T18:00:00' });
  const res = await chiama(body, signPayload(body, SEGRETO));
  expect(res.status).toBe(400);
  const j = await res.json();
  expect(j.error).toBe('data_senza_offset');
  expect(j.message).toMatch(/offset/i);
});

it('payload che non riconosciamo → 400 e il grezzo finisce nell\'event_log', async () => {
  const body = JSON.stringify({ pippo: 1 });
  const res = await chiama(body, signPayload(body, SEGRETO));
  expect(res.status).toBe(400);
});
```

- [ ] **Step 3: Verifica che falliscano**

Run: `npx vitest run app/api/appointment-set/route.test.ts`
Expected: FAIL — il route non esiste.

- [ ] **Step 4: Implementa**

`app/api/appointment-set/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { parseAppointmentSetPayload } from '@/lib/bot-contract';
import { runAppointmentSet } from '@/lib/appointment-set';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Il CRM ci chiama a ogni appuntamento fissato o spostato. Prima del 06/08 questo
// endpoint non esisteva e le loro chiamate morivano in un 404 di Vercel: la colonna
// gdo_appuntamento_at è nata vuota a luglio proprio per questo.
//
// Non abbiamo la loro specifica scritta: il parser accetta gli alias plausibili dei
// nomi dei campi e ogni corpo non riconosciuto finisce intero nell'event_log. Il
// primo giorno di traffico vero vale più di un documento.

const MESSAGGIO: Record<string, string> = {
  lead_mancante: "Manca l'identificativo del lead (leadId).",
  data_mancante: "Manca la data dell'appuntamento (appointmentAt).",
  data_senza_offset: "La data deve essere ISO 8601 con offset di fuso, es. 2026-08-07T18:00:00+02:00. Senza offset non sappiamo se l'ora è italiana o UTC.",
  bad_request: 'Corpo della richiesta non valido: atteso un oggetto JSON.',
};

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`appuntamento:${ip}`, 120, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = parseAppointmentSetPayload(json);
  const supabase = getSupabaseAdmin();
  if (!parsed.ok) {
    // Il corpo grezzo è la cosa più preziosa che abbiamo finché non conosciamo il loro
    // schema: senza questa riga un campo con un nome diverso resterebbe invisibile.
    await supabase.from('event_log').insert({
      type: 'appuntamento_payload_ignoto',
      payload: { reason: parsed.reason, body: rawBody.slice(0, 2000) } as never,
      message: `[crm] payload di /api/appointment-set non riconosciuto (${parsed.reason})`,
      level: 'warn',
    });
    return NextResponse.json(
      { ok: false, error: parsed.reason, message: MESSAGGIO[parsed.reason] },
      { status: 400 },
    );
  }

  try {
    const res = await runAppointmentSet(supabase, parsed.value);
    return NextResponse.json(res);
  } catch (e) {
    const error = e instanceof Error ? e.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'appuntamento_errore',
      payload: { crmLeadId: parsed.value.leadId, error } as never,
      message: `[crm] registrazione della data fallita per il lead ${parsed.value.leadId}: ${error}`,
      level: 'error',
    });
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
```

- [ ] **Step 5: Verifica che passino**

Run: `npx vitest run app/api/appointment-set/route.test.ts`
Expected: PASS

- [ ] **Step 6: Suite completa, commit, merge**

```bash
npm test && npx tsc --noEmit
git add app/api/appointment-set
git commit -m "feat(crm): endpoint /api/appointment-set per la data della call"
```

- [ ] **Step 7: Dopo il deploy — guarda cosa arriva davvero**

Run (dopo qualche ora di traffico):
```bash
node --env-file=.env.local -e "const u=process.env.NEXT_PUBLIC_SUPABASE_URL,k=process.env.SUPABASE_SERVICE_ROLE_KEY;fetch(u+'/rest/v1/event_log?select=type,message,payload,created_at&type=in.(appuntamento_payload_ignoto,appuntamento_registrato,appuntamento_spostato,appuntamento_lead_sconosciuto)&order=created_at.desc&limit=30',{headers:{apikey:k,Authorization:'Bearer '+k}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,1)))"
```
Se compaiono righe `appuntamento_payload_ignoto`, leggi il `body` grezzo e allarga gli alias in `ALIAS_LEAD`/`ALIAS_DATA` (Task 2.1) — è per questo che ci sono.

---

# Punto 3 — chiamare `/api/bot/agenda-delivery`

**Branch:** `fix/agenda-delivery-mai-chiamato` (da `main`)

L'endpoint è online lato CRM dal 30 luglio e ha ricevuto **zero** chiamate; 63 agende su 316 restano "inviato" per sempre e il loro reinvio è bloccato.

**Il codice c'è già.** `handleGdoDeliveryUpdate` (`lib/send-agenda-gdo.ts:185`) aggiorna il nostro esito e avvisa il CRM, ed è già cablata nel webhook Twilio (`app/api/webhooks/twilio/route.ts:68`). Esce alla riga 222 senza chiamare nessuno perché `CRM_AGENDA_DELIVERED_URL` non è mai stata configurata su Vercel. La correzione è dare all'URL un default, esattamente come `CRM_OUTCOME_URL` ha `DEFAULT_CRM_URL`: una env dimenticata non deve poter zittire un canale.

### Task 3.1: l'URL dell'avviso ha un default

**Files:**
- Modify: `lib/send-agenda-gdo.ts:220-222`
- Test: `lib/send-agenda-gdo.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_CRM_AGENDA_DELIVERED_URL = 'https://crm-sales-fenice.vercel.app/api/bot/agenda-delivery'`.

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
import { DEFAULT_CRM_AGENDA_DELIVERED_URL } from './send-agenda-gdo';

it("senza CRM_AGENDA_DELIVERED_URL l'avviso parte lo stesso, sull'URL di default", async () => {
  delete process.env.CRM_AGENDA_DELIVERED_URL;
  process.env.BOT_WEBHOOK_SECRET = 'segreto';
  process.env.AGENDA_GDO_TEMPLATE_SID = 'HXagenda';
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const { supabase } = fakeConsegna({ conversationId: 7, crmLeadId: 'lead-1', esito: 'inviato', templateSid: 'HXagenda' });
  const r = await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' });
  expect(r).toEqual({ updated: true, notified: true });
  expect(fetchMock.mock.calls[0][0]).toBe(DEFAULT_CRM_AGENDA_DELIVERED_URL);
});

it('CRM_AGENDA_DELIVERED_URL, se c\'è, vince sul default', async () => {
  process.env.CRM_AGENDA_DELIVERED_URL = 'https://altro/endpoint';
  process.env.BOT_WEBHOOK_SECRET = 'segreto';
  process.env.AGENDA_GDO_TEMPLATE_SID = 'HXagenda';
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const { supabase } = fakeConsegna({ conversationId: 7, crmLeadId: 'lead-1', esito: 'inviato', templateSid: 'HXagenda' });
  await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' });
  expect(fetchMock.mock.calls[0][0]).toBe('https://altro/endpoint');
});

it("il corpo dell'avviso porta lead, esito e sid, firmato HMAC", async () => {
  delete process.env.CRM_AGENDA_DELIVERED_URL;
  process.env.BOT_WEBHOOK_SECRET = 'segreto';
  process.env.AGENDA_GDO_TEMPLATE_SID = 'HXagenda';
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const { supabase } = fakeConsegna({ conversationId: 7, crmLeadId: 'lead-1', esito: 'inviato', templateSid: 'HXagenda' });
  await handleGdoDeliveryUpdate(supabase, { sid: 'SM1', status: 'delivered' });
  const req = fetchMock.mock.calls[0][1];
  expect(JSON.parse(req.body)).toMatchObject({ leadId: 'lead-1', esito: 'consegnato', sid: 'SM1' });
  expect(req.headers['x-bot-signature']).toBeTruthy();
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/send-agenda-gdo.test.ts`
Expected: FAIL — oggi senza env la funzione ritorna `{ updated: true, notified: false }` e non chiama nessuno.

- [ ] **Step 3: Implementa**

In `lib/send-agenda-gdo.ts`, in cima:

```ts
/**
 * Dal 30/07 il CRM espone questo endpoint per sapere che un'agenda uscita come
 * "inviato" è poi stata consegnata: senza l'avviso, quel lead resta ambiguo da loro e
 * il reinvio è bloccato per sempre. Fino al 06/08 ha ricevuto zero chiamate perché
 * l'URL viveva solo in una env mai configurata su Vercel. Un default fa sì che una env
 * dimenticata non possa più zittire un canale — stessa scelta già fatta per
 * CRM_OUTCOME_URL in lib/bot-outcome.ts.
 */
export const DEFAULT_CRM_AGENDA_DELIVERED_URL = 'https://crm-sales-fenice.vercel.app/api/bot/agenda-delivery';
```

e nella funzione:

```ts
  const url = process.env.CRM_AGENDA_DELIVERED_URL ?? DEFAULT_CRM_AGENDA_DELIVERED_URL;
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret || !c.crm_lead_id) return { updated: true, notified: false };
```

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/send-agenda-gdo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/send-agenda-gdo.ts lib/send-agenda-gdo.test.ts
git commit -m "fix(gdo): l'avviso di consegna al CRM non dipende piu' da una env dimenticata"
```

### Task 3.2: recupero delle 63 agende ferme in "inviato"

**Files:**
- Create: `scripts/agende-consegnate-arretrate.mjs`

Le status callback di Twilio per quei messaggi sono già passate: lo stato reale è su `messages.twilio_status`, ma `gdo_agenda_esito` è rimasto a `inviato` perché al tempo l'avviso non partiva.

- [ ] **Step 1: Scrivi lo script**

```js
// Agende rimaste in "inviato" ma in realtà consegnate: allinea il nostro esito e
// avvisa il CRM, così il loro reinvio si sblocca.
// Uso: node --env-file=.env.local scripts/agende-consegnate-arretrate.mjs [--esegui]
const ESEGUI = process.argv.includes('--esegui');
const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEGRETO = process.env.BOT_WEBHOOK_SECRET;
const SID_AGENDA = process.env.AGENDA_GDO_TEMPLATE_SID;
const URL_CRM = process.env.CRM_AGENDA_DELIVERED_URL ?? 'https://crm-sales-fenice.vercel.app/api/bot/agenda-delivery';
if (!URL_BASE || !KEY || !SEGRETO || !SID_AGENDA) throw new Error('env mancanti');
const { createHmac } = await import('node:crypto');
const firma = (b) => createHmac('sha256', SEGRETO).update(b).digest('hex');

const q = async (p) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
};
const patch = async (p, body) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${p}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${r.status}: ${await r.text()}`);
};

const convs = await q(`conversations?select=id,crm_lead_id&gdo_agenda_esito=eq.inviato&crm_lead_id=not.is.null&limit=1000`);
console.log(`agende ferme in "inviato": ${convs.length}`);
let consegnate = 0;
for (const c of convs) {
  const m = await q(`messages?select=twilio_sid,twilio_status&conversation_id=eq.${c.id}&template_sid=eq.${SID_AGENDA}&order=created_at.desc&limit=1`);
  const riga = m[0];
  if (!riga || !['delivered', 'read'].includes(riga.twilio_status)) continue;
  consegnate++;
  console.log(`conv ${c.id} lead ${c.crm_lead_id}: ${riga.twilio_status} (sid ${riga.twilio_sid})`);
  if (!ESEGUI) continue;
  const body = JSON.stringify({ leadId: c.crm_lead_id, esito: 'consegnato', sid: riga.twilio_sid, at: new Date().toISOString() });
  const r = await fetch(URL_CRM, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-signature': firma(body) },
    body,
  });
  console.log(`   → CRM ${r.status} ${(await r.text()).slice(0, 120)}`);
  if (r.ok) await patch(`conversations?id=eq.${c.id}`, { gdo_agenda_esito: 'consegnato' });
}
console.log(`\nin realtà consegnate: ${consegnate} su ${convs.length}`);
if (!ESEGUI) console.log('(prova a vuoto: rilancia con --esegui)');
```

- [ ] **Step 2: Prova a vuoto**

Run: `node --env-file=.env.local scripts/agende-consegnate-arretrate.mjs`
Expected: il conteggio delle davvero-consegnate (atteso ~63), nessuna chiamata al CRM.

- [ ] **Step 3: Commit e merge**

```bash
npm test && npx tsc --noEmit
git add scripts/agende-consegnate-arretrate.mjs
git commit -m "chore(gdo): recupero delle agende rimaste in inviato"
```

- [ ] **Step 4: Dopo il deploy — esegui e verifica**

Run: `node --env-file=.env.local scripts/agende-consegnate-arretrate.mjs --esegui`
Poi chiedi al CRM di confermare che le chiamate su `/api/bot/agenda-delivery` sono passate da zero a un numero, e che il payload che mandiamo (`leadId`, `esito`, `sid`, `at`) è quello che si aspettano: è l'unico pezzo che non abbiamo potuto verificare contro la loro specifica.

---

# Punto 4 — i 338 lead fermi senza esito

**Branch:** `fix/lead-fermi-sanatoria` (da `main`)

Decisione presa: **report al CRM + sanatoria dei soli 17 casi che sono davvero nostri.** Non si re-inviano i 211 esiti già accettati: duplicherebbero il rumore sul loro cruscotto senza aggiungere informazione.

### Task 4.1: il conteggio per causa da girare al CRM

**Files:**
- Create: `docs/crm/2026-08-06-risposta-lead-fermi.md`

- [ ] **Step 1: Scrivi il documento**

Deve contenere, in questo ordine: la tabella delle cause (i numeri sono nella sezione "Cosa hanno detto i dati" di questo piano); il fatto che i 211 hanno tutti un `bot_outcome_sent` con risposta 2xx dal loro endpoint e che il loro `stato_crm` coincide (173 REJECTED su 177 DA_SCARTARE, 5 APPOINTMENT su 7 APPUNTAMENTO); la domanda diretta — *su quale criterio è costruita la lista "fermi senza esito"?*, perché non può essere l'assenza dell'esito; e la parte nostra che stiamo sanando (10 lead mai arrivati, 6 passaggi a una persona mai segnalati, 1 fuori sequenza).

Chiudi con la richiesta operativa: che ci mandino, per 5 di quei 211 lead a loro scelta, cosa vedono a schermo — è il modo più corto per capire se il disallineamento è nella loro query o nel significato che diamo alla parola "restituito".

- [ ] **Step 2: Commit**

```bash
git add docs/crm/2026-08-06-risposta-lead-fermi.md
git commit -m "docs(crm): conteggio per causa dei 338 lead fermi"
```

### Task 4.2: perché 10 lead non sono mai arrivati al bot

**Files:**
- Create: `scripts/indaga-lead-mai-arrivati.mjs`

- [ ] **Step 1: Scrivi lo script**

```js
// I lead che il CRM ci ha assegnato ma per cui non esiste nessuna conversazione:
// l'intake è arrivato? con che esito?
// Uso: node --env-file=.env.local scripts/indaga-lead-mai-arrivati.mjs <lead_id> [<lead_id>...]
const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = async (p) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
};
for (const id of process.argv.slice(2)) {
  const conv = await q(`conversations?select=id,ai_status,ai_started_at&crm_lead_id=eq.${id}`);
  const ev = await q(`event_log?select=type,message,level,created_at,payload&or=(payload->>crmLeadId.eq.${id},payload->>leadId.eq.${id})&order=created_at.asc&limit=50`);
  console.log(`\n=== ${id} — conversazioni: ${conv.length} ===`);
  for (const e of ev) console.log(`  ${e.created_at.slice(0, 19)} [${e.level}] ${e.type}: ${(e.message ?? '').slice(0, 140)}`);
  if (ev.length === 0) console.log('  NESSUN evento: l\'intake non è mai arrivato da noi.');
}
```

- [ ] **Step 2: Esegui sui 10 lead**

Prendi i 10 `lead_id` dal CSV che non hanno conversazione (quelli della riga "A" della classificazione) e lanciali. Due esiti possibili, entrambi azionabili:
- **nessun evento** → l'intake non ci è mai arrivato: è un problema loro, va nel documento del Task 4.1 con l'elenco dei 10 id.
- **evento `bot_intake_*` con errore** → è nostro: apri un task a parte, non allargare questo branch.

- [ ] **Step 3: Commit**

```bash
git add scripts/indaga-lead-mai-arrivati.mjs
git commit -m "chore(crm): script per capire dove si perdono i lead mai arrivati"
```

### Task 4.3: la regola perché la coda non si riformi

**Files:**
- Modify: `app/api/cron/bot-followups/route.ts` (blocco watchdog, dopo il 2d)
- Test: `lib/bot-followups.test.ts`

Un lead CRM, non GDO, con il primo outbound più vecchio di `SEQUENCE_END_DAYS + 2` giorni e senza `bot_outcome` è per definizione una coda che si sta formando: oggi nessuno se ne accorge finché non arriva un CSV dal CRM.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
import { serveAllarmeCodaFerma } from './bot-followups';

describe('serveAllarmeCodaFerma', () => {
  const D = 86400_000;
  const base = { nowMs: Date.parse('2026-08-06T12:00:00Z'), botOutcome: null, gdoPostino: false, giaAllertato: false };

  it('oltre la sequenza + 2 giorni senza esito: allarme', () => {
    expect(serveAllarmeCodaFerma({ ...base, primoOutboundMs: base.nowMs - 7 * D })).toBe(true);
  });

  it('dentro la finestra: niente allarme', () => {
    expect(serveAllarmeCodaFerma({ ...base, primoOutboundMs: base.nowMs - 3 * D })).toBe(false);
  });

  it('un esito c\'è: non è una coda', () => {
    expect(serveAllarmeCodaFerma({ ...base, primoOutboundMs: base.nowMs - 30 * D, botOutcome: 'DA_SCARTARE' })).toBe(false);
  });

  it('lead del GDO: l\'esito non è nostro da dare', () => {
    expect(serveAllarmeCodaFerma({ ...base, primoOutboundMs: base.nowMs - 30 * D, gdoPostino: true })).toBe(false);
  });

  it('già allertato: una volta sola per conversazione', () => {
    expect(serveAllarmeCodaFerma({ ...base, primoOutboundMs: base.nowMs - 30 * D, giaAllertato: true })).toBe(false);
  });

  it('mai partito nulla: non è questo il caso da coprire', () => {
    expect(serveAllarmeCodaFerma({ ...base, primoOutboundMs: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Verifica che fallisca**

Run: `npx vitest run lib/bot-followups.test.ts`
Expected: FAIL — `serveAllarmeCodaFerma is not a function`.

- [ ] **Step 3: Implementa**

In `lib/bot-followups.ts`:

```ts
import { SEQUENCE_END_DAYS } from './sequence';

/** Margine oltre la fine della sequenza prima di gridare: due giorni di cron. */
export const CODA_FERMA_MARGINE_D = 2;

/**
 * Un lead CRM che ha superato la sequenza senza produrre un esito è una coda che si
 * sta formando. Finora ce ne accorgevamo solo quando il CRM ci mandava un CSV; questo
 * lo dice il giorno stesso.
 */
export function serveAllarmeCodaFerma(input: {
  nowMs: number;
  primoOutboundMs: number | null;
  botOutcome: string | null;
  gdoPostino: boolean;
  giaAllertato: boolean;
}): boolean {
  if (input.gdoPostino) return false;
  if (input.botOutcome) return false;
  if (input.giaAllertato) return false;
  if (input.primoOutboundMs === null) return false;
  const limite = (SEQUENCE_END_DAYS + CODA_FERMA_MARGINE_D) * 86400_000;
  return input.nowMs - input.primoOutboundMs >= limite;
}
```

- [ ] **Step 4: Verifica che passi**

Run: `npx vitest run lib/bot-followups.test.ts`
Expected: PASS

- [ ] **Step 5: Cabla il cron**

In `app/api/cron/bot-followups/route.ts`, subito dopo il watchdog `booked` (2d) e prima della classificazione (3):

```ts
      // 2e. Coda che si forma: superata la sequenza senza esito. Alert una volta sola.
      const primoOutboundMs = rows.find((r) => r.direction === 'out')
        ? Date.parse(rows.find((r) => r.direction === 'out')!.created_at)
        : null;
      if (serveAllarmeCodaFerma({ nowMs: now, primoOutboundMs, botOutcome: c.bot_outcome, gdoPostino: c.gdo_agenda_at != null, giaAllertato: false })) {
        const { data: prior } = await supabase
          .from('event_log')
          .select('id')
          .eq('type', 'coda_ferma_senza_esito')
          .contains('payload', { conversationId: c.id })
          .limit(1);
        if (!prior || prior.length === 0) {
          await supabase.from('event_log').insert({
            type: 'coda_ferma_senza_esito',
            payload: { conversationId: c.id, crmLeadId: c.crm_lead_id } as never,
            message: `[bot-fissatore] conv ${c.id}: oltre la sequenza senza esito CRM, il lead sta invecchiando fermo al bot`,
            level: 'warn',
          });
          report.push({ id: c.id, action: 'coda_ferma_senza_esito' });
        }
      }
```

- [ ] **Step 6: Suite, commit, merge**

```bash
npm test && npx tsc --noEmit
git add lib/bot-followups.ts lib/bot-followups.test.ts app/api/cron/bot-followups/route.ts
git commit -m "feat(bot): un allarme quando un lead invecchia fermo senza esito"
```

---

# Punto 5 — note al CRM fattuali

**Branch:** `fix/note-crm-fattuali` (da `main`)

Dal 26/07 il CRM ha ricevuto 296 note su 142 lead: il canale funziona, il contenuto no. Le leggono le Conferme pochi minuti prima di chiamare il cliente. Serve il fatto concreto con i dati che lo rendono azionabile: se disdice **quando**, se sposta **a quando**, se ha un vincolo **quale**. Meno parafrasi della conversazione.

### Task 5.1: `buildLockedNote` in formato compatto e fattuale

**Files:**
- Modify: `lib/bot-outcome-rules.ts:19-65`
- Test: `lib/bot-outcome-rules.test.ts`

**Interfaces:**
- Consumes: `paroleDelLead` (Task 1.2 — **questo branch dipende dal merge del punto 1**; se il punto 1 non è ancora su `main`, sposta `paroleDelLead` in questo branch e risolvi il conflitto al merge).
- Produces: stessa firma `buildLockedNote(args, existingDate)`, testo diverso.

Formato: **ETICHETTA IN MAIUSCOLO** (il fatto, leggibile di sguardo) — poi i dati — poi le parole del lead.

- [ ] **Step 1: Riscrivi i test esistenti e aggiungi i nuovi**

I test attuali su `buildLockedNote` in `lib/bot-outcome-rules.test.ts` verificano i testi vecchi: vanno riscritti, non affiancati.

```ts
const DATA = '2026-08-07T18:00:00+02:00';

describe('buildLockedNote — il fatto in testa, poi i dati, poi le parole del lead', () => {
  it('disdetta: dice QUANDO era l\'appuntamento e il motivo con le parole del lead', () => {
    const n = buildLockedNote(
      { outcome: 'DA_SCARTARE', discardReason: 'ha trovato lavoro', note: 'ho iniziato a lavorare, lasciamo stare' },
      DATA,
    );
    expect(n.startsWith('DISDETTA —')).toBe(true);
    expect(n).toContain('07/08');
    expect(n).toContain('18:00');
    expect(n).toContain('"ho iniziato a lavorare, lasciamo stare"');
  });

  it('disdetta senza appuntamento in agenda: non inventa una data', () => {
    const n = buildLockedNote({ outcome: 'DA_SCARTARE', discardReason: 'non interessato' }, null);
    expect(n.startsWith('DISDETTA —')).toBe(true);
    expect(n).not.toMatch(/\d{2}\/\d{2}/);
  });

  it('spostamento con nuova data: dice DA quando A quando', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: '2026-08-09T10:30:00+02:00', note: 'giovedì non posso' }, DATA);
    expect(n.startsWith('SPOSTAMENTO CHIESTO —')).toBe(true);
    expect(n).toContain('07/08');
    expect(n).toContain('09/08');
    expect(n).toContain('10:30');
    expect(n).toContain('"giovedì non posso"');
  });

  it('spostamento senza nuova data: lo dice invece di ripetere quella in agenda', () => {
    const n = buildLockedNote({ outcome: 'RICHIAMO', date: DATA, note: 'devo spostare' }, DATA);
    expect(n.startsWith('SPOSTAMENTO CHIESTO —')).toBe(true);
    expect(n).toContain('nuova data non indicata');
  });

  it('riconferma', () => {
    const n = buildLockedNote({ outcome: 'APPUNTAMENTO', date: DATA }, DATA);
    expect(n.startsWith('RICONFERMA —')).toBe(true);
    expect(n).toContain('07/08');
  });

  it('richiesta di anticipare/posticipare via APPUNTAMENTO: da quando a quando', () => {
    const n = buildLockedNote({ outcome: 'APPUNTAMENTO', date: '2026-08-09T10:30:00+02:00' }, DATA);
    expect(n.startsWith('SPOSTAMENTO CHIESTO —')).toBe(true);
    expect(n).toContain('09/08');
  });

  it('silenzio dopo il fissaggio: dice che l\'appuntamento regge', () => {
    expect(buildLockedNote({ outcome: 'NON_RISPOSTO' }, DATA).startsWith('NESSUNA RISPOSTA —')).toBe(true);
    expect(buildLockedNote({ outcome: 'INTERROTTO' }, DATA).startsWith('CHAT INTERROTTA —')).toBe(true);
    expect(buildLockedNote({ outcome: 'INTERROTTO' }, DATA)).toContain('appuntamento confermato');
  });

  it('nessuna nota supera le due righe', () => {
    for (const o of ['DA_SCARTARE', 'RICHIAMO', 'INTERROTTO', 'NON_RISPOSTO', 'APPUNTAMENTO'] as const) {
      expect(buildLockedNote({ outcome: o, note: 'x'.repeat(50) }, DATA).length).toBeLessThan(400);
    }
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/bot-outcome-rules.test.ts`
Expected: FAIL sui testi nuovi.

- [ ] **Step 3: Implementa**

Sostituisci `buildLockedNote` in `lib/bot-outcome-rules.ts`:

```ts
/**
 * La nota che il CRM mostra alle Conferme pochi minuti prima della chiamata. Regola:
 * il fatto in maiuscolo, poi i dati che lo rendono azionabile (se disdice quando, se
 * sposta da quando a quando), poi le parole del lead per il motivo. Niente racconto
 * della conversazione: chi legge ha trenta secondi e il telefono in mano.
 */
export function buildLockedNote(args: OutcomeArgs, existingDate: string | null): string {
  const inAgenda = existingDate ? formatRomeDateTime(existingDate) : null;
  const parole = paroleDelLead(args.note);
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  const motivo = args.discardReason?.replace(/\s+/g, ' ').trim();
  // Il modello, quando il lead non indica una data, rimette nel tag quella
  // dell'appuntamento stesso: vale come "nessuna nuova data". Il confronto è per
  // istante perché existingDate arriva da Postgres in UTC e args.date dal tag nel fuso
  // locale imposto dal prompt — la stessa ora avrebbe due stringhe diverse.
  const nuova = args.date && !sameInstant(args.date, existingDate) ? formatRomeDateTime(args.date) : null;

  switch (args.outcome) {
    case 'DA_SCARTARE':
      return `DISDETTA — ${inAgenda ? `appuntamento del ${inAgenda} da annullare.` : 'nessun appuntamento in agenda.'}` +
        ` Motivo: ${motivo || 'non specificato'}.${citazione}`;

    case 'RICHIAMO':
      return `SPOSTAMENTO CHIESTO — ${nuova ? `da ${inAgenda ?? 'data non nota'} a ${nuova}.` : `nuova data non indicata dal lead${inAgenda ? `, in agenda resta ${inAgenda}` : ''}.`}` +
        ` Appuntamento non spostato da noi: confermare voi.${citazione}`;

    case 'APPUNTAMENTO':
      return nuova
        ? `SPOSTAMENTO CHIESTO — da ${inAgenda ?? 'data non nota'} a ${nuova}. Appuntamento non spostato da noi: confermare voi.${citazione}`
        : `RICONFERMA — il lead conferma l'appuntamento${inAgenda ? ` del ${inAgenda}` : ''}.${citazione}`;

    case 'INTERROTTO':
      return `CHAT INTERROTTA — il lead ha smesso di rispondere${inAgenda ? `, appuntamento confermato per il ${inAgenda}` : ', appuntamento confermato'}.${citazione}`;

    case 'NON_RISPOSTO':
      return `NESSUNA RISPOSTA — nessun riscontro dopo il fissaggio${inAgenda ? `, appuntamento confermato per il ${inAgenda}` : ', appuntamento confermato'}.${citazione}`;

    case 'NOTA':
    case 'CONTATTO_UMANO':
      // Non arrivano qui come esito IN INGRESSO: sono i due esiti prodotti in USCITA.
      // Il caso resta per l'esaustività dello switch.
      return `AGGIORNAMENTO — appuntamento${inAgenda ? ` del ${inAgenda}` : ''} confermato.${citazione}`;
  }
}
```

Verifica che `formatRomeDateTime` produca giorno e ora leggibili (`07/08 alle 18:00` o simile): se restituisce un formato lungo, i test sul contenuto `07/08` e `18:00` te lo diranno subito.

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/bot-outcome-rules.test.ts`
Expected: PASS

- [ ] **Step 5: Allinea la nota del richiamo senza data**

Stesso formato per `buildRichiamoSenzaDataNote`: etichetta in testa e parole del lead in coda.

```ts
export function buildRichiamoSenzaDataNote(input: { motivo: MotivoDataNonUsabile; leadWords?: string }): string {
  const parole = paroleDelLead(input.leadWords);
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  return `DA RICHIAMARE — giorno e ora da concordare (${DETTAGLIO_MOTIVO[input.motivo]}).${citazione}`;
}
```

Aggiorna `DETTAGLIO_MOTIVO` perché regga dentro la parentesi:

```ts
const DETTAGLIO_MOTIVO: Record<MotivoDataNonUsabile, string> = {
  assente: 'il lead non ha detto quando',
  illeggibile: 'quando indicato non è utilizzabile',
  passato: 'la data raccolta è nel passato',
  oltre_orizzonte: 'la data raccolta è troppo lontana per essere quella vera',
};
```

Aggiorna i test esistenti di `buildRichiamoSenzaDataNote` di conseguenza: nessuna data nel testo, questo non cambia.

- [ ] **Step 6: Guarda le note vere prima e dopo**

Run:
```bash
node --env-file=.env.local -e "const u=process.env.NEXT_PUBLIC_SUPABASE_URL,k=process.env.SUPABASE_SERVICE_ROLE_KEY;fetch(u+'/rest/v1/event_log?select=payload,created_at&type=in.(bot_outcome_locked,bot_note_sent)&order=created_at.desc&limit=15',{headers:{apikey:k,Authorization:'Bearer '+k}}).then(r=>r.json()).then(j=>j.forEach(e=>console.log('-',e.payload.note)))"
```
Leggile come se dovessi chiamare quel cliente fra due minuti. Se una non ti dice cosa fare, il formato non è ancora giusto.

- [ ] **Step 7: Suite, commit, merge**

```bash
npm test && npx tsc --noEmit
git add lib/bot-outcome-rules.ts lib/bot-outcome-rules.test.ts
git commit -m "fix(crm): note fattuali — il fatto, i dati, le parole del lead"
```

---

# Punto 6 — INTERROTTO solo quando abbiamo davvero smesso

**Branch:** `fix/interrotto-solo-a-fine-corsa` (da `main`)

Per il CRM INTERROTTO significa "ho chiuso, riprendetevelo" e fa ripartire il lead nel giro dei GDO umani. Caso Marina Destefanis: il 26/07 abbiamo mandato INTERROTTO, il CRM ha riassegnato a un GDO, il giorno dopo il bot ha ripreso la chat e ha fissato — nel frattempo un GDO l'aveva chiamata tre volte e poi scartata.

Decisione presa: **INTERROTTO parte solo a fine corsa** (silenzio oltre la resa **e** nessun invio ancora previsto), **e** se la chat riparte dopo una restituzione il CRM lo sa subito.

### Task 6.1: la soglia

**Files:**
- Modify: `lib/sequence.ts:19-20,124-140`
- Test: `lib/sequence.test.ts`

**Interfaces:**
- Produces: `TRACKB_GIVEUP_H = 288`; `decideTrackB` classifica solo se il nudge è stato usato o la sua finestra è passata.

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
describe('decideTrackB — la resa arriva solo a fine corsa', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  const h = (n: number) => now - n * 3600_000;

  it('a 120h non si classifica più: la chat può ancora ripartire', () => {
    expect(decideTrackB({ nowMs: now, lastInboundAtMs: h(120), nudgesSent: 1, sequenceEnabled: false }).kind).toBe('wait');
  });

  it('a 288h (12 giorni) si classifica', () => {
    expect(decideTrackB({ nowMs: now, lastInboundAtMs: h(288), nudgesSent: 1, sequenceEnabled: false }).kind).toBe('classify');
  });

  it('il nudge gratuito resta dov\'era: silenzio in [18,24)', () => {
    expect(decideTrackB({ nowMs: now, lastInboundAtMs: h(20), nudgesSent: 0, sequenceEnabled: true }).kind).toBe('nudge_free');
  });

  it('non si classifica mentre il nudge è ancora da mandare', () => {
    // finestra del nudge non ancora passata e nudge non speso: non abbiamo finito.
    expect(decideTrackB({ nowMs: now, lastInboundAtMs: h(20), nudgesSent: 0, sequenceEnabled: false }).kind).toBe('wait');
  });

  it('nudge mai mandato ma finestra passata da un pezzo: a fine corsa si classifica', () => {
    expect(decideTrackB({ nowMs: now, lastInboundAtMs: h(300), nudgesSent: 0, sequenceEnabled: false }).kind).toBe('classify');
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/sequence.test.ts`
Expected: FAIL — oggi a 120h classifica.

- [ ] **Step 3: Implementa**

In `lib/sequence.ts`:

```ts
// 06/08/2026 — la resa passa da 120h a 288h (12 giorni). Per il CRM INTERROTTO
// significa "riprendetevelo" e rimette il lead nel giro dei GDO umani: a 5 giorni la
// chat può ancora ripartire, e quando succede due canali lavorano lo stesso lead senza
// vedersi (caso Marina Destefanis del 26/07: riassegnata, tre chiamate a vuoto e
// scartata, mentre il bot il giorno dopo fissava).
export const TRACKB_GIVEUP_H = 288;
```

e in `decideTrackB`:

```ts
export function decideTrackB(input: {
  nowMs: number;
  lastInboundAtMs: number;
  nudgesSent: number;
  sequenceEnabled: boolean;
}): TrackBAction {
  const { nowMs, lastInboundAtMs, nudgesSent, sequenceEnabled } = input;
  const silH = (nowMs - lastInboundAtMs) / H;
  // "Abbiamo davvero smesso" vuol dire due cose insieme: silenzio oltre la resa E
  // nessun invio ancora previsto. Finché il nudge gratuito è da spendere e la sua
  // finestra non è passata, stiamo ancora lavorando il lead.
  const abbiamoFinito = nudgesSent >= 1 || silH >= NUDGE1_MAX_H;
  if (silH >= TRACKB_GIVEUP_H && abbiamoFinito) return { kind: 'classify' };
  if (!sequenceEnabled || !inSendWindow(nowMs)) return { kind: 'wait' };
  if (nudgesSent === 0 && silH >= NUDGE1_MIN_H && silH < NUDGE1_MAX_H) return { kind: 'nudge_free' };
  return { kind: 'wait' };
}
```

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/sequence.test.ts && npx vitest run lib/bot-followups.test.ts`
Expected: PASS. Il test `'24h di silenzio → none (niente piu INTERROTTO a 24h)'` in `bot-followups.test.ts` deve restare verde; se qualche test lì assumeva 120h, aggiornalo con un commento che spiega il perché.

- [ ] **Step 5: Commit**

```bash
git add lib/sequence.ts lib/sequence.test.ts lib/bot-followups.test.ts
git commit -m "fix(crm): INTERROTTO parte a 12 giorni e solo a sequenza finita"
```

### Task 6.2: se la chat riparte, il CRM lo sa subito

**Files:**
- Modify: `lib/bot-outcome.ts` (esporta `sendCrmNota`), `lib/bot-outcome-rules.ts` (`buildBotRipresoNote`), `app/api/webhooks/twilio/route.ts:177-186`
- Test: `lib/bot-outcome-rules.test.ts`, `lib/bot-outcome.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function buildBotRipresoNote(input: { esitoPrecedente: string; quandoIso: string }): string
  export async function sendCrmNota(supabase: Supa, conversationId: number, note: string): Promise<{ sent: boolean; status?: number; error?: string }>
  ```

`sendCrmNota` **non** passa da `resolveOutcomeAction`: è una nota diretta, e su un lead già APPUNTAMENTO la logica del lead terminale la trasformerebbe in un'altra cosa.

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
it('buildBotRipresoNote dice cosa era stato restituito e che il bot è tornato in campo', () => {
  const n = buildBotRipresoNote({ esitoPrecedente: 'INTERROTTO', quandoIso: '2026-08-06T12:00:00+02:00' });
  expect(n.startsWith('IL BOT HA RIPRESO LA CHAT —')).toBe(true);
  expect(n).toContain('INTERROTTO');
  expect(n).toContain('06/08');
  expect(n.toLowerCase()).toContain('non chiamatelo');
});
```

```ts
it('sendCrmNota manda una NOTA diretta anche su un lead già APPUNTAMENTO', async () => {
  const { supabase, calls } = fakeSupabase({ crm_lead_id: 'lead-1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: '2026-08-07T18:00:00+02:00' });
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const r = await sendCrmNota(supabase, 1, 'IL BOT HA RIPRESO LA CHAT — ...');
  expect(r.sent).toBe(true);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.outcome).toBe('NOTA');
  expect(body.note).toContain('IL BOT HA RIPRESO');
  expect(calls.conversationUpdates).toEqual([]);
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/bot-outcome-rules.test.ts lib/bot-outcome.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementa**

In `lib/bot-outcome-rules.ts`:

```ts
/**
 * Il lead era stato restituito al CRM e ha riscritto: da qui in poi due canali
 * lavorano la stessa persona senza vedersi, ed è esattamente com'è andata a Marina
 * Destefanis. La nota serve a fermare la telefonata del GDO, quindi lo dice in chiaro.
 */
export function buildBotRipresoNote(input: { esitoPrecedente: string; quandoIso: string }): string {
  return (
    `IL BOT HA RIPRESO LA CHAT — il lead ha riscritto il ${formatRomeDateTime(input.quandoIso)}, ` +
    `dopo che vi era stato restituito come ${input.esitoPrecedente}. ` +
    `Non chiamatelo a mano finché non vi arriva un nuovo esito dal bot.`
  );
}
```

In `lib/bot-outcome.ts`, esporta una nota diretta riusando `inviaNotaAlCrm`:

```ts
/**
 * Una NOTA diretta al CRM, senza passare da resolveOutcomeAction e senza toccare
 * nessuno stato locale. Serve per i fatti che non sono esiti (il bot che riprende una
 * chat restituita): la logica del lead terminale li trasformerebbe in altro.
 */
export async function sendCrmNota(
  supabase: Supa,
  conversationId: number,
  note: string,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return { sent: false, error: 'not_configured' };
  const { data: conv } = await supabase
    .from('conversations')
    .select('crm_lead_id')
    .eq('id', conversationId)
    .maybeSingle();
  const crmLeadId = (conv as { crm_lead_id: string | null } | null)?.crm_lead_id ?? null;
  if (!crmLeadId) return { sent: false, error: 'not_crm_lead' };
  return inviaNotaAlCrm(supabase, conversationId, crmLeadId, note, undefined, secret);
}
```

In `app/api/webhooks/twilio/route.ts`, aggiungi `bot_outcome` alla select e, dopo la riapertura:

```ts
      const { data: conv } = await supabase
        .from('conversations')
        .select('ai_owner, ai_status, ai_paused_at, crm_lead_id, bot_outcome')
        .eq('id', conversationId)
        .single();

      if (conv && shouldReopen({ aiOwner: conv.ai_owner, aiStatus: conv.ai_status, aiPausedAt: conv.ai_paused_at })) {
        await supabase.from('conversations').update({ ai_status: 'active' }).eq('id', conversationId);
        conv.ai_status = 'active';
        // Il lead era già stato restituito al CRM e ha riscritto: da adesso il bot e i
        // GDO lavorano la stessa persona. Avvisarli è l'unico modo perché non chiamino
        // a vuoto. Dopo la risposta a Twilio: la loro rete non deve rallentare il webhook.
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

Nota: si esclude APPUNTAMENTO perché lì il lead è già in agenda e la riapertura ha un suo canale (le note del lead terminale).

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/bot-outcome-rules.test.ts lib/bot-outcome.test.ts`
Expected: PASS

- [ ] **Step 5: Suite, commit, merge**

```bash
npm test && npx tsc --noEmit
git add lib/bot-outcome.ts lib/bot-outcome-rules.ts app/api/webhooks/twilio/route.ts lib/bot-outcome.test.ts lib/bot-outcome-rules.test.ts
git commit -m "feat(crm): se il bot riprende una chat restituita, il CRM lo sa subito"
```

---

# Punto 7 — il re-invio orario dello stesso APPUNTAMENTO

**Branch:** `fix/reinvio-orario-appuntamento` (da `main`)

Doveva chiudersi il 20/07 con `1409b2a`. Era parziale: quel fix chiude il ramo terminale APPUNTAMENTO (`app/api/cron/bot-followups/route.ts:142`), ma il **re-drive sta prima**, alla riga 96. Se l'ultimo messaggio è un inbound senza risposta, ogni ora il cron rilancia `drainMarioReplies`; e quando un turno produce solo tag e nessun testo visibile non viene scritta nessuna riga outbound, quindi la condizione resta vera e lo stesso esito riparte ogni ora fino a 5 giorni (`REDRIVE_MAX_MS`). Prova: conv 3728, 39 `fenice_ai_reply` contro 14 outbound reali, 32 `bot_outcome_note_duplicate` a gap 1.00h.

### Task 7.1: migration `ai_redrive_at` (PRIMA del deploy)

**Files:**
- Create: `supabase/migrations/20260806000001_ai_redrive_at.sql`
- Modify: `lib/supabase/types.ts` (blocco `conversations`: `Row`, `Insert`, `Update`)

- [ ] **Step 1: Scrivi la migration**

```sql
-- Il re-drive orario del cron bot-followups riparte finché l'ultimo messaggio è un
-- inbound senza risposta. Un turno che produce solo tag non scrive nessuna riga
-- outbound: la condizione resta vera e lo stesso esito riparte ogni ora (conv 3728,
-- 32 ripetizioni a gap 1.00h). Questa colonna ricorda fin dove siamo già arrivati.
alter table public.conversations
  add column if not exists ai_redrive_at timestamptz;

comment on column public.conversations.ai_redrive_at is
  'Istante dell''ultimo inbound per cui il cron ha già rilanciato il drain. Il re-drive riparte solo per un inbound più recente di questo: senza, un turno senza testo visibile lo farebbe ripetere ogni ora.';
```

- [ ] **Step 2: Applica la migration in produzione**

Via SQL Editor Supabase o Management API (l'MCP Supabase vede solo il progetto CRM, non questo — vedi `reference_supabase_ddl_senza_pat`). Verifica:

```bash
node --env-file=.env.local -e "const u=process.env.NEXT_PUBLIC_SUPABASE_URL,k=process.env.SUPABASE_SERVICE_ROLE_KEY;fetch(u+'/rest/v1/conversations?select=id,ai_redrive_at&limit=1',{headers:{apikey:k,Authorization:'Bearer '+k}}).then(r=>r.text()).then(console.log)"
```
Expected: JSON con il campo `ai_redrive_at`, non un errore `column ... does not exist`.

- [ ] **Step 3: Allinea i tipi**

In `lib/supabase/types.ts`, blocco `conversations`: `ai_redrive_at: string | null` in `Row`, `ai_redrive_at?: string | null` in `Insert` e `Update`. Il commento sopra il blocco già spiega perché i campi sono a mano.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260806000001_ai_redrive_at.sql lib/supabase/types.ts
git commit -m "feat(db): ai_redrive_at, la memoria del re-drive del cron"
```

### Task 7.2: il re-drive parte una volta sola per inbound

**Files:**
- Modify: `lib/fenice-autoreply.ts` (nuova funzione pura), `app/api/cron/bot-followups/route.ts:96-130`
- Test: `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Produces: `export function serveRedrive(input: { ultimoInboundMs: number; aiRedriveAt: string | null; nowMs: number; maxMs: number }): boolean`

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
import { serveRedrive } from './fenice-autoreply';

describe('serveRedrive', () => {
  const now = Date.parse('2026-08-06T12:00:00Z');
  const MAX = 5 * 86400_000;

  it('inbound nuovo mai re-drivato: si parte', () => {
    expect(serveRedrive({ ultimoInboundMs: now - 3600_000, aiRedriveAt: null, nowMs: now, maxMs: MAX })).toBe(true);
  });

  it('stesso inbound già re-drivato: non si ripete — è il loop orario di conv 3728', () => {
    const t = now - 3600_000;
    expect(serveRedrive({ ultimoInboundMs: t, aiRedriveAt: new Date(t).toISOString(), nowMs: now, maxMs: MAX })).toBe(false);
  });

  it('inbound più recente dell\'ultimo re-drive: si riparte', () => {
    expect(serveRedrive({ ultimoInboundMs: now - 600_000, aiRedriveAt: new Date(now - 3600_000).toISOString(), nowMs: now, maxMs: MAX })).toBe(true);
  });

  it('inbound più vecchio del tetto: il lead è perso, si va alla classificazione', () => {
    expect(serveRedrive({ ultimoInboundMs: now - 6 * 86400_000, aiRedriveAt: null, nowMs: now, maxMs: MAX })).toBe(false);
  });

  it('ai_redrive_at illeggibile non blocca il recupero', () => {
    expect(serveRedrive({ ultimoInboundMs: now - 3600_000, aiRedriveAt: 'boh', nowMs: now, maxMs: MAX })).toBe(true);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: FAIL — `serveRedrive is not a function`.

- [ ] **Step 3: Implementa**

In `lib/fenice-autoreply.ts`, vicino a `lastIsUnansweredInbound`:

```ts
/**
 * Il re-drive del cron è una rete di sicurezza, non un ciclo. Deve scattare una volta
 * per inbound rimasto senza risposta: se il turno non produce testo visibile non viene
 * scritta nessuna riga outbound, `lastIsUnansweredInbound` resta vero e senza questa
 * guardia lo stesso esito ripartirebbe ogni ora per cinque giorni (conv 3728).
 */
export function serveRedrive(input: {
  ultimoInboundMs: number;
  aiRedriveAt: string | null;
  nowMs: number;
  maxMs: number;
}): boolean {
  if (input.nowMs - input.ultimoInboundMs > input.maxMs) return false;
  if (!input.aiRedriveAt) return true;
  const gia = Date.parse(input.aiRedriveAt);
  // Un timestamp illeggibile non deve poter bloccare per sempre il recupero di una chat.
  if (Number.isNaN(gia)) return true;
  return input.ultimoInboundMs > gia;
}
```

Nel cron, sostituisci la condizione della riga 100 e segna il re-drive:

```ts
        if (serveRedrive({ ultimoInboundMs: lastPendingInboundAtMs, aiRedriveAt: c.ai_redrive_at ?? null, nowMs: now, maxMs: REDRIVE_MAX_MS })) {
          if (!phone) {
            report.push({ id: c.id, action: 'redrive', skipped: true, reason: 'no_from' });
            continue;
          }
          // ... lucchetto e reset legacy invariati ...

          // Si segna PRIMA del drain: se il drain esplode a metà, il giro dopo non
          // deve ripartire da capo su un inbound che abbiamo già lavorato.
          await supabase
            .from('conversations')
            .update({ ai_redrive_at: new Date(lastPendingInboundAtMs).toISOString() })
            .eq('id', c.id);

          await drainMarioReplies(supabase, c.id, phone, () => 0);
          report.push({ id: c.id, action: 'redrive' });
          continue;
        }
        // Inbound già re-drivato, o più vecchio del tetto: si prosegue verso la
        // classificazione invece di ri-rispondere.
```

Aggiungi `ai_redrive_at` alla `select` delle conversazioni (riga 59).

- [ ] **Step 4: Verifica che passino**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: PASS

- [ ] **Step 5: Prova di mutazione**

Fai tornare `serveRedrive` sempre `true`: il test "stesso inbound già re-drivato" deve fallire. Rimetti.

- [ ] **Step 6: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts app/api/cron/bot-followups/route.ts
git commit -m "fix(bot): il re-drive scatta una volta per inbound, non ogni ora"
```

### Task 7.3: una conversazione già esitata esce dal giro

**Files:**
- Modify: `app/api/cron/bot-followups/route.ts:140-152`
- Test: `lib/bot-followups.test.ts`

Oggi la guardia chiude solo i lead APPUNTAMENTO. Ma ci sono 21 conversazioni `active` con un `bot_outcome` già registrato (11 INTERROTTO, 8 NON_RISPOSTO, 2 RICHIAMO): ognuna, alla prossima classificazione, rispedisce lo stesso esito.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
it('una conversazione con un esito già dato non si riclassifica mai, qualunque sia l\'esito', () => {
  for (const o of ['APPUNTAMENTO', 'INTERROTTO', 'NON_RISPOSTO', 'DA_SCARTARE', 'RICHIAMO']) {
    expect(decideFollowupAction({
      nowMs: Date.parse('2026-08-06T12:00:00Z'),
      msgs: [],
      seqSids: [],
      hasInbound: true,
      lastInboundAtMs: Date.parse('2026-07-01T12:00:00Z'),
      botOutcome: o,
    })).toBe('none');
  }
});
```

- [ ] **Step 2: Verifica che fallisca**

Run: `npx vitest run lib/bot-followups.test.ts`
Expected: FAIL su INTERROTTO/NON_RISPOSTO/DA_SCARTARE/RICHIAMO.

- [ ] **Step 3: Implementa**

In `lib/bot-followups.ts`, sostituisci la guardia:

```ts
  // Un esito è già stato dato: mai riclassificare, qualunque esso sia. Una riga
  // riaperta dal webhook che porta ancora il suo esito rispedirebbe lo stesso POST a
  // ogni giro del cron (21 conversazioni trovate così il 06/08).
  if (input.botOutcome) return 'none';
```

E nel cron, generalizza la chiusura (riga 142):

```ts
      // 2b. Lead già esitato: mai riclassificare. La riga è stata riaperta dal webhook,
      // richiudila per farla uscire dal giro del cron.
      if (c.bot_outcome) {
        if (c.ai_status === 'active') {
          await supabase
            .from('conversations')
            .update({ ai_status: 'closed' })
            .eq('id', c.id)
            .eq('ai_status', 'active');
          report.push({ id: c.id, action: 'close_terminal', outcome: c.bot_outcome });
        }
        continue;
      }
```

Attenzione: questa guardia sta **dopo** il re-drive, e va bene così — un lead esitato che riscrive merita ancora una risposta, ed è il Task 6.2 ad avvisare il CRM.

- [ ] **Step 4: Verifica che passi**

Run: `npx vitest run lib/bot-followups.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/bot-followups.ts lib/bot-followups.test.ts app/api/cron/bot-followups/route.ts
git commit -m "fix(bot): nessun esito si rispedisce due volte"
```

### Task 7.4: verifica sul campo dopo il deploy

- [ ] **Step 1: Suite, merge, deploy**

```bash
npm test && npx tsc --noEmit
```
Migration del Task 7.1 già applicata? Se no, **fermati e applicala**: senza la colonna, il cron scrive su un campo che non esiste.

- [ ] **Step 2: Misura la sparizione del loop**

Run, 24h dopo il deploy:
```bash
node --env-file=.env.local -e "const u=process.env.NEXT_PUBLIC_SUPABASE_URL,k=process.env.SUPABASE_SERVICE_ROLE_KEY;const da=new Date(Date.now()-86400000).toISOString();fetch(u+'/rest/v1/event_log?select=type,payload,created_at&type=in.(bot_outcome_locked,bot_outcome_note_duplicate,bot_note_sent)&created_at=gte.'+da+'&order=created_at.asc&limit=2000',{headers:{apikey:k,Authorization:'Bearer '+k}}).then(r=>r.json()).then(j=>{const m=new Map();for(const e of j){const i=e.payload.conversationId;(m.get(i)??m.set(i,[]).get(i)).push(e.created_at)}const rip=[...m].filter(([,v])=>v.length>2);console.log('eventi 24h:',j.length,'— conversazioni con piu di 2 note ripetute:',rip.length);for(const [i,v] of rip.slice(0,10))console.log(' conv',i,v.length)})"
```
Baseline prima del fix: 147 `bot_outcome_note_duplicate` e 157 `bot_outcome_locked` in 14 giorni, con conv 3728 a 32 ripetizioni. Dopo, le ripetizioni a gap 1.00h devono sparire.

- [ ] **Step 3: Chiudi le 21 conversazioni appese**

Il cron le chiude da solo al primo giro dopo il deploy (Task 7.3). Verifica:
```bash
node --env-file=.env.local -e "const u=process.env.NEXT_PUBLIC_SUPABASE_URL,k=process.env.SUPABASE_SERVICE_ROLE_KEY;fetch(u+'/rest/v1/conversations?select=id,bot_outcome&ai_status=eq.active&bot_outcome=not.is.null&limit=100',{headers:{apikey:k,Authorization:'Bearer '+k}}).then(r=>r.json()).then(j=>console.log('ancora appese:',j.length,j.map(c=>c.id+':'+c.bot_outcome).join(', ')))"
```
Expected: 0 (baseline: 21).

---

# Nota informativa — i 403 (nessun lavoro nostro, solo misura)

Dal 05/08 un APPUNTAMENTO su un lead già restituito viene **accettato** invece che respinto con 403. Il payload non cambia, non c'è codice da scrivere. Il CRM vuole sapere di quanto scendono i 403.

- [ ] **Misura, sette giorni dopo il deploy**

Baseline dichiarata da loro: 46 su 413 in sette giorni. La nostra:

```bash
node --env-file=.env.local -e "const u=process.env.NEXT_PUBLIC_SUPABASE_URL,k=process.env.SUPABASE_SERVICE_ROLE_KEY;const da=new Date(Date.now()-7*86400000).toISOString();const g=p=>fetch(u+'/rest/v1/'+p,{headers:{apikey:k,Authorization:'Bearer '+k,Prefer:'count=exact',Range:'0-0'}}).then(r=>r.headers.get('content-range'));Promise.all([g('event_log?select=id&type=eq.bot_outcome_rejected&created_at=gte.'+da),g('event_log?select=id&type=in.(bot_outcome_sent,bot_outcome_rejected,bot_outcome_error)&created_at=gte.'+da)]).then(([r,t])=>console.log('403 (rejected):',r,'— tentativi totali:',t))"
```

Riporta al CRM il rapporto rifiutati/tentativi prima e dopo. Nota che `bot_outcome_error` include anche i 403 finiti nel ramo generico (li abbiamo visti nei log di luglio): contali guardando `payload.status`, non solo il tipo dell'evento.

---

## Ordine consigliato

1. **Punto 1** (CONTATTO_UMANO) — è il più urgente e sblocca `paroleDelLead` per il punto 5.
2. **Punto 3** (agenda-delivery) — una riga di codice, sblocca 63 agende.
3. **Punto 7** (re-invio orario) — migration prima del deploy; toglie rumore dai log e rende leggibili le misure degli altri punti.
4. **Punto 2** (appointment-set) — poi si osserva cosa arriva davvero e si allargano gli alias.
5. **Punto 5** (note fattuali) — dopo il punto 1.
6. **Punto 6** (INTERROTTO) — dopo il punto 7, così la nota "il bot ha ripreso" non finisce dentro un loop.
7. **Punto 4** (report e sanatorie) — le sanatorie vanno eseguite dopo il deploy dei punti 1 e 3.

## Coordinamento con l'altra sessione

`feat/pacchetto-post-fissaggio` tocca `lib/bot-outcome.ts`, `lib/bot-contract.ts`, `lib/mario-prompt.ts`, i cron `precall-reminders` e `gdo-video-followups`, e aggiunge `conversations.cancel_requested_at`. Sovrapposizione reale:

- **`lib/bot-contract.ts`** — noi aggiungiamo un valore all'union e una funzione in coda. Conflitto banale, risolvibile tenendo entrambe le modifiche.
- **`lib/bot-outcome.ts`** — noi aggiungiamo un ramo `CONTATTO_UMANO` prima di `checkDataRichiamo` e la funzione `sendCrmNota`. Se loro riscrivono la stessa zona, mergiare **prima** il punto 1: è più piccolo.
- **`lib/bot-outcome-rules.ts`** — riscriviamo `buildLockedNote`. Se anche loro la toccano per le disdette, il merge va fatto a mano leggendo i test di entrambi i lati: i testi delle note sono il contratto.
- Non toccare `lib/mario-prompt.ts`, `app/api/cron/precall-reminders/`, `app/api/cron/gdo-video-followups/`.
- `conversations.cancel_requested_at` **non esiste ancora in produzione** anche se compare in `lib/supabase/types.ts`: non usarla in nessuna query di questo piano.
