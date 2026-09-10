# Comportamento del bot — Lotto A (chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il bot dice al lead quando lo chiama Noemi calcolandolo dall'ora vera della call, passa davvero alle Conferme il secondo numero che il lead gli dà, e non fissa più appuntamenti fuori dalla finestra dei due giorni.

**Architecture:** Tre cambiamenti indipendenti che condividono solo il file del prompt. (1) Un blocco nuovo nel prompt su Noemi, più la stessa regola nella nota GDO, che oggi si calcola sull'invio dell'agenda invece che sull'ora dell'appuntamento. (2) Un tag locale `[NOTA|...]` che il bot emette quando il lead dà un secondo recapito, instradato sull'outcome `NOTA` del contratto CRM già vivo. (3) Un motivo nuovo (`fuori_finestra`) dentro `checkDataAppuntamento`, che è già il punto dove un appuntamento non fissabile diventa una nota invece che una riga in agenda.

**Tech Stack:** TypeScript, Next.js App Router, Vitest, Supabase.

**Spec:** `docs/superpowers/specs/2026-09-10-comportamento-bot-design.md`

## Global Constraints

- `lib/mario-prompt.ts` è una template literal e **un blocco su riga fisica unica arriva come UNA bolla WhatsApp**. `splitMarioMessages` spezza solo sui `\n` reali, e c'è un test a soglia di parole per riga: ogni riga nuova va tenuta corta o spezzata.
- I tag non devono **mai** essere visibili al lead: ogni tag nuovo va rimosso dal testo in `parseMarioReply` (`lib/mario.ts`).
- Date del DB `timestamptz` (UTC) vs date dei tag del modello (offset locale): mai confrontarle come stringhe.
- Le note leggibili da umani si scrivono in ora di Roma con `formatRomeDateTime`.
- **Noemi inizia alle 13:00.** Soglia unica per tutto il lotto: call `>= 13:00` → Noemi chiama lo stesso giorno qualche ora prima; call `< 13:00` → Noemi chiama il pomeriggio del giorno prima.
- L'insistenza del bot **non si tocca**: nessun task di questo piano riduce quante volte il bot riprova.
- La durata della call **non si tocca**: il prompt dice già "30/40 minuti" ed è giusto.
- Niente migration in questo lotto. Niente template Meta. Nessun allineamento CRM.
- Test: `npm test`. Typecheck: `npm run typecheck`.

---

### Task 1: La guardia sulla finestra dei due giorni

**Files:**
- Modify: `lib/bot-outcome-rules.ts:160-199` (tipo `MotivoAppuntamentoNonFissabile`, `checkDataAppuntamento`, `DETTAGLIO_APPUNTAMENTO`)
- Modify: `lib/bot-outcome.ts:445-449` (passare `now` e i giorni prenotabili alla guardia)
- Test: `lib/bot-outcome-rules.test.ts`

**Interfaces:**
- Consumes: `computeBookingDays(now: Date, ranges?: BlackoutRange[], pieni?: GiorniPieni): BookingDays` da `lib/booking-slots.ts`; `BookingDays` ha `day1: {label: string; date: string}` e `day2` uguale, dove `date` è `'YYYY-MM-DD'`.
- Produces: `checkDataAppuntamento` guadagna il motivo `'fuori_finestra'`. Nessun'altra firma cambia: resta `(date, nowMs, ranges) => AppuntamentoCheck`, i giorni si calcolano dentro da `nowMs`.

- [ ] **Step 1: Write the failing test**

In `lib/bot-outcome-rules.test.ts`, aggiungi in fondo:

```ts
describe('checkDataAppuntamento — finestra dei due giorni', () => {
  // Giovedì 10 settembre 2026, 09:00 Roma. Finestra attesa: venerdì 11 e sabato 12.
  const now = Date.parse('2026-09-10T09:00:00+02:00');

  it('accetta il primo giorno della finestra', () => {
    expect(checkDataAppuntamento('2026-09-11T15:00:00+02:00', now, [])).toEqual({ ok: true });
  });

  it('accetta il secondo giorno della finestra', () => {
    expect(checkDataAppuntamento('2026-09-12T15:00:00+02:00', now, [])).toEqual({ ok: true });
  });

  it('rifiuta un giorno oltre la finestra', () => {
    expect(checkDataAppuntamento('2026-09-14T15:00:00+02:00', now, [])).toEqual({
      ok: false,
      motivo: 'fuori_finestra',
    });
  });

  it('rifiuta oggi, che non è mai prenotabile', () => {
    expect(checkDataAppuntamento('2026-09-10T18:00:00+02:00', now, [])).toEqual({
      ok: false,
      motivo: 'fuori_finestra',
    });
  });

  it('la domenica resta domenica, non diventa fuori_finestra', () => {
    // Venerdì 11: la finestra è sabato 12 e lunedì 14, domenica 13 è saltata.
    const ven = Date.parse('2026-09-11T09:00:00+02:00');
    expect(checkDataAppuntamento('2026-09-13T15:00:00+02:00', ven, [])).toEqual({
      ok: false,
      motivo: 'domenica',
    });
  });

  it('la finestra scivola: da venerdì lunedì è dentro', () => {
    const ven = Date.parse('2026-09-11T09:00:00+02:00');
    expect(checkDataAppuntamento('2026-09-14T15:00:00+02:00', ven, [])).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/bot-outcome-rules.test.ts`
Expected: FAIL — i casi fuori finestra tornano `{ ok: true }` perché il motivo non esiste ancora.

- [ ] **Step 3: Write minimal implementation**

In `lib/bot-outcome-rules.ts`, aggiungi `'fuori_finestra'` al tipo `MotivoAppuntamentoNonFissabile`, importa `computeBookingDays` e `romeDayKey` (quest'ultimo è già importato), e inserisci il controllo in coda a `checkDataAppuntamento`, **dopo** quelli su domenica e giorno chiuso, così i motivi più specifici vincono:

```ts
import { computeBookingDays } from './booking-slots';

// ... dentro checkDataAppuntamento, dopo il check su fuori_fascia:

  // La finestra è "domani + dopodomani": un appuntamento fuori di lì l'agenda vera non
  // lo regge. La regola stava solo nel prompt e il modello la violava: 32 call su 251
  // fissate fuori finestra a settembre. Il calcolo è lo stesso che vede il modello nel
  // blocco SLOT APPUNTAMENTO DISPONIBILI, così guardia e prompt non possono divergere.
  const { day1, day2 } = computeBookingDays(new Date(nowMs), ranges);
  if (giorno !== day1.date && giorno !== day2.date) return { ok: false, motivo: 'fuori_finestra' };

  return { ok: true };
```

E il dettaglio leggibile in `DETTAGLIO_APPUNTAMENTO`:

```ts
  fuori_finestra: 'era fuori dai due giorni che possiamo proporre',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/bot-outcome-rules.test.ts`
Expected: PASS, e i test preesistenti del file restano verdi.

- [ ] **Step 5: Verifica che non abbia rotto il resto**

Run: `npm test && npm run typecheck`
Expected: tutto verde. Se qualche test di `lib/bot-outcome.test.ts` fallisce perché usava date lontane come "appuntamento valido", **aggiorna quelle date** portandole dentro la finestra relativa al `now` del test: la guardia nuova è il comportamento voluto, non una regressione.

- [ ] **Step 6: Commit**

```bash
git add lib/bot-outcome-rules.ts lib/bot-outcome.ts lib/bot-outcome-rules.test.ts lib/bot-outcome.test.ts
git commit -m "fix(bot): fuori dai due giorni non e' un appuntamento, e' una nota"
```

---

### Task 2: Il secondo numero del lead arriva alle Conferme

**Files:**
- Modify: `lib/mario.ts:23-65` (`MarioResult`, `parseMarioReply`)
- Modify: `lib/mario-prompt.ts:335` (la riga NON PRENDERE IMPEGNI PER CONTO DI ALTRI) e il glossario tag intorno a riga 346
- Modify: `lib/fenice-autoreply.ts` (dove si consuma `parseMarioReply`, per inviare la nota)
- Test: `lib/mario.test.ts`, `lib/mario-prompt.test.ts`

**Interfaces:**
- Consumes: `MarioResult` da Task 0 (esistente). `inviaNotaAlCrm(supabase, conversationId, crmLeadId, note, report, secret)` da `lib/bot-outcome.ts` — è la funzione che il ramo `locked` e la guardia appuntamento usano già.
- Produces: `MarioResult.notaCrm?: string`. Quando valorizzata, il chiamante invia una `NOTA` al CRM e **prosegue** la conversazione normalmente: non è un esito terminale.

- [ ] **Step 1: Write the failing test**

In `lib/mario.test.ts`:

```ts
describe('tag [NOTA|...]', () => {
  it('estrae il testo della nota e lo toglie dal messaggio visibile', () => {
    const r = parseMarioReply(
      'Perfetto, lo passo a chi ti chiama. [NOTA|Secondo recapito del lead: 3924538096]',
    );
    expect(r.notaCrm).toBe('Secondo recapito del lead: 3924538096');
    expect(r.visibleReply).toBe('Perfetto, lo passo a chi ti chiama.');
    expect(r.visibleReply).not.toContain('[NOTA');
  });

  it('senza il tag notaCrm resta undefined', () => {
    expect(parseMarioReply('Ciao!').notaCrm).toBeUndefined();
  });

  it('una nota non è un esito: non chiude la conversazione', () => {
    const r = parseMarioReply('Ok. [NOTA|Secondo recapito: 333111]');
    expect(r.outcome).toBeUndefined();
    expect(r.passToHuman).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/mario.test.ts`
Expected: FAIL — `notaCrm` non esiste su `MarioResult` (errore di tipo) e il tag resta nel testo visibile.

- [ ] **Step 3: Write minimal implementation**

In `lib/mario.ts`: aggiungi `notaCrm?: string;` a `MarioResult`, poi

```ts
const NOTA_RE = /\[NOTA\|([^\]]*)\]/i;
```

dentro `parseMarioReply`, prima del calcolo di `visibleReply`:

```ts
  const notaMatch = raw.match(NOTA_RE);
  const notaCrm = notaMatch ? (notaMatch[1] ?? '').trim() || undefined : undefined;
```

aggiungi `.replace(NOTA_RE, '')` alla catena che costruisce `visibleReply`, e `notaCrm` all'oggetto di ritorno.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/mario.test.ts`
Expected: PASS.

- [ ] **Step 5: Collega il tag all'invio della nota**

In `lib/fenice-autoreply.ts`, nel punto in cui il risultato di `parseMarioReply` viene consumato (cerca `passToHuman` per trovarlo), aggiungi **dopo** l'invio del messaggio al lead e **prima** della gestione degli esiti:

```ts
  // Il secondo recapito che il lead dà in chat moriva qui: il bot rispondeva "lo segno,
  // avviso Noemi" e non lo segnava nessuno. `NOTA` è il canale già vivo (lo stesso delle
  // disdette): non tocca lo stato del lead e notifica subito le Conferme.
  if (parsed.notaCrm && crmLeadId) {
    await inviaNotaAlCrm(supabase, conversationId, crmLeadId, parsed.notaCrm, undefined, process.env.BOT_WEBHOOK_SECRET);
  }
```

Se `inviaNotaAlCrm` non è esportata da `lib/bot-outcome.ts`, esportala.

- [ ] **Step 6: Aggiorna il prompt**

In `lib/mario-prompt.ts`, sostituisci nella riga NON PRENDERE IMPEGNI PER CONTO DI ALTRI la parte sul secondo numero (oggi rimbalza il lead) con:

```
SE IL LEAD TI DÀ UN SECONDO NUMERO di telefono, o un recapito diverso su cui farsi chiamare, quello lo puoi passare davvero: diglielo in una riga ("perfetto, lo passo a chi ti chiama") e chiudi il messaggio con [NOTA|Secondo recapito del lead: <numero>, sue parole: "<quello che ha scritto>"]. Non dire mai "lo dico a Noemi" o "glielo segno sulla scheda" senza il tag: senza tag non parte niente.
```

E nel glossario dei tag, dopo la riga di `[VIDEO_VISTO]`:

```
- Secondo recapito o informazione che deve arrivare a chi telefona: [NOTA|<testo>] — non è un esito, la conversazione va avanti come prima
```

- [ ] **Step 7: Test sul prompt**

In `lib/mario-prompt.test.ts`:

```ts
describe('secondo recapito del lead', () => {
  const p = buildMarioSystem('Marta');

  it('insegna il tag NOTA invece di rimbalzare il lead a Noemi', () => {
    expect(p).toContain('[NOTA|Secondo recapito del lead:');
    expect(p).not.toContain('diglielo a Noemi appena ti chiama');
  });
});
```

Run: `npm test && npm run typecheck`
Expected: tutto verde.

- [ ] **Step 8: Commit**

```bash
git add lib/mario.ts lib/mario.test.ts lib/mario-prompt.ts lib/mario-prompt.test.ts lib/fenice-autoreply.ts lib/bot-outcome.ts
git commit -m "feat(bot): il secondo numero del lead arriva davvero alle Conferme"
```

---

### Task 3: Quando chiama Noemi dipende dall'ora della call

**Files:**
- Modify: `lib/mario-prompt.ts` (nuovo blocco dopo riga 247, e il passaggio 2 della CONFERMA POST-APPUNTAMENTO a riga 258)
- Test: `lib/mario-prompt.test.ts`

**Interfaces:**
- Consumes: niente di nuovo. È un cambiamento di sole istruzioni.
- Produces: il blocco `CHI È NOEMI E QUANDO CHIAMA`, a cui il Task 4 fa riferimento per la nota GDO.

- [ ] **Step 1: Write the failing test**

In `lib/mario-prompt.test.ts`:

```ts
describe('CHI È NOEMI E QUANDO CHIAMA', () => {
  const p = buildMarioSystem('Marta');

  it('separa la preselezione dalla call col venditore', () => {
    expect(p).toContain('CHI È NOEMI E QUANDO CHIAMA');
    expect(p).toContain('Noemi fa la PRESELEZIONE, non la trattativa');
    expect(p).toContain('non chiamarla mai "la consulente" o "la tutor"');
  });

  it('lega l orario della chiamata all ora della call, con la soglia delle 13', () => {
    expect(p).toContain('call dalle 13:00 in poi');
    expect(p).toContain('call PRIMA DELLE 13:00');
    expect(p).toContain('il POMERIGGIO DEL GIORNO PRIMA');
  });

  it('vieta le frasi che fanno tenere il telefono nel momento sbagliato', () => {
    for (const frase of [
      'ti chiama poco prima',
      'ti chiama qualche minuto prima',
      'ti chiama la mattina stessa',
      'ti sta per chiamare',
    ]) {
      expect(p).toContain(frase);
    }
    expect(p).toContain('Queste frasi sono SBAGLIATE');
  });

  it('vieta di vendere la call come se fosse breve quanto Noemi', () => {
    expect(p).toContain('I 5-10 minuti sono di Noemi, non della call');
  });

  it('se giorno e ora non sono noti non si tira a indovinare', () => {
    expect(p).toContain('non tirare a indovinare');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/mario-prompt.test.ts`
Expected: FAIL — il blocco non esiste.

- [ ] **Step 3: Write minimal implementation**

In `lib/mario-prompt.ts`, subito **dopo** la riga che finisce con «non scriverlo mai da solo, senza altro testo visibile.» (riga ~247) e **prima** di `CONFERMA POST-APPUNTAMENTO`, inserisci — una riga fisica per capoverso, tenendole corte:

```
CHI È NOEMI E QUANDO CHIAMA
COSA FA: Noemi fa la PRESELEZIONE, non la trattativa. Sono 5-10 minuti al telefono per capire bene la situazione del lead, ed è il passaggio che conferma l'appuntamento. Non è lei che presenta percorsi, pacchetti e quote e non è lei che fa una proposta: quello succede dopo, nella videocall con il consulente. Quindi non chiamarla mai "la consulente" o "la tutor", e non dirgli che con lei vede prezzi, rate o preventivi.
I 5-10 minuti sono di Noemi, non della call. La call è di 30/40 minuti: non venderla mai dicendo che sono cinque minuti, e non usare la brevità di Noemi per far sembrare corto l'appuntamento.
QUANDO CHIAMA: non chiama all'ora della call e non chiama pochi minuti prima. Chiama con anticipo, e l'anticipo dipende da quando è la call.
call dalle 13:00 in poi: chiama lo stesso giorno, qualche ora prima. Per una call alle 15 chiama nel primo pomeriggio, per una alle 18 un paio d'ore prima.
call PRIMA DELLE 13:00: chiama SEMPRE il POMERIGGIO DEL GIORNO PRIMA. Mai la mattina stessa. A chi ha la call di mattina di' di tenere il telefono a portata dal pomeriggio precedente.
Dagli la finestra, non un orario al minuto: mai "ti chiama alle 14 in punto", perché diventa un secondo appuntamento che poi non torna.
Queste frasi sono SBAGLIATE e non le devi usare mai: "ti chiama poco prima", "ti chiama qualche minuto prima", "ti chiama 5 minuti prima", "ti chiama prima di collegarti", "ti chiama la mattina stessa", "ti chiama a momenti", "ti sta per chiamare". Chi le legge tiene il telefono nel momento sbagliato e la chiamata la perde.
Se non sai ancora giorno e ora della call, non tirare a indovinare: di' solo che lo chiama prima e aspetta che te li confermi.
```

Poi, nel passaggio 2 della CONFERMA POST-APPUNTAMENTO (riga ~258), togli «ti chiama prima della call» da «Noemi è la collega della preselezione, ti chiama prima della call da un cellulare» — che è falso per le call del mattino — lasciando «ti chiama da un cellulare», e aggiungi subito sotto al blocco delle quattro righe:

```
Dentro questo stesso messaggio digli anche QUANDO lo chiama, calcolandolo dal giorno e dall'ora che ti ha appena confermato lui e con la regola del blocco CHI È NOEMI E QUANDO CHIAMA. Es. per una call di venerdì alle 10: "ti chiama giovedì pomeriggio, non venerdì mattina".
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/mario-prompt.test.ts`
Expected: PASS. Il test che conta le parole per riga deve restare verde; se protesta, spezza la riga lunga in due righe fisiche.

- [ ] **Step 5: Verifica che il prompt Mario/Marta resti simmetrico**

Run: `npm test && npm run typecheck`
Expected: verde, incluso il test «cambia SOLO il nome».

- [ ] **Step 6: Commit**

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "fix(prompt): quando chiama Noemi dipende dall'ora della call"
```

---

### Task 4: La stessa regola nella nota che leggono i GDO

**Files:**
- Modify: `lib/gdo-context-note.ts`
- Test: `lib/gdo-context-note.test.ts`

**Interfaces:**
- Consumes: la soglia delle 13:00 fissata nel Task 3.
- Produces: `oraAppuntamento(botScheduledAt, gdoAppuntamentoAt): Date | null` e `quandoChiamaNoemi(quando: Date | null): string`, esportate da `lib/gdo-context-note.ts`. `GdoNoteInput` guadagna due campi opzionali: `botScheduledAt?: string | null` e `gdoAppuntamentoAt?: string | null`.

**Il difetto:** la costante `NOTA_NOEMI` (riga 17) dice «lo chiama da un cellulare **prima della call**» — una frase fissa, uguale per tutti. Per una call del mattino è falsa: Noemi inizia alle 13:00 e quella call la copre chiamando il pomeriggio prima. Per un lead GDO l'ora vera della call è la **più recente** fra `bot_scheduled_at` e `gdo_appuntamento_at`.

- [ ] **Step 1: Write the failing test**

In `lib/gdo-context-note.test.ts`, con la forma di `GdoNoteInput` già usata negli altri test del file (`gdoVideoSentAt`, `gdoVideoWatchedAt`, `gdoNoemiRemindedAt`, `followupsSent`, `videoAppenaConfermato`):

```ts
const baseNoemi = {
  gdoVideoSentAt: '2026-09-09T10:00:00Z',
  gdoVideoWatchedAt: '2026-09-09T11:00:00Z',
  gdoNoemiRemindedAt: null,
  followupsSent: 0,
  videoAppenaConfermato: true,
};

describe('nota Noemi: dipende dall ora dell appuntamento', () => {
  it('appuntamento di mattina: Noemi chiama il pomeriggio prima', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T10:00:00+02:00',
      gdoAppuntamentoAt: null,
    });
    expect(nota).toContain('il pomeriggio del giorno prima');
    expect(nota).not.toContain('la mattina stessa,');
  });

  it('appuntamento di pomeriggio: Noemi chiama lo stesso giorno', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T16:00:00+02:00',
      gdoAppuntamentoAt: null,
    });
    expect(nota).toContain('lo stesso giorno');
  });

  it('vince la data piu recente fra le due colonne', () => {
    const nota = gdoContextNote({
      ...baseNoemi,
      botScheduledAt: '2026-09-11T10:00:00+02:00',
      gdoAppuntamentoAt: '2026-09-12T16:00:00+02:00',
    });
    expect(nota).toContain('lo stesso giorno');
  });

  it('senza nessuna data non inventa un orario', () => {
    const nota = gdoContextNote({ ...baseNoemi, botScheduledAt: null, gdoAppuntamentoAt: null });
    expect(nota).not.toContain('il pomeriggio del giorno prima');
    expect(nota).not.toContain('lo stesso giorno');
    expect(nota).toContain('PROMEMORIA NOEMI');
  });
});

describe('oraAppuntamento', () => {
  it('torna null quando non c e nessuna data valida', () => {
    expect(oraAppuntamento(null, null)).toBeNull();
    expect(oraAppuntamento('non-una-data', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/gdo-context-note.test.ts`
Expected: FAIL — `oraAppuntamento` non esiste e `GdoNoteInput` non accetta i due campi nuovi.

- [ ] **Step 3: Write minimal implementation**

In `lib/gdo-context-note.ts`, importa `romeHour` da `./rome-time` e aggiungi:

```ts
/** Noemi inizia alle 13:00: una call del mattino la copre chiamando il pomeriggio prima. */
const NOEMI_ORA_INIZIO = 13;

/** L'ora vera della call: per un lead GDO può stare su due colonne, vince la più recente. */
export function oraAppuntamento(
  botScheduledAt: string | null | undefined,
  gdoAppuntamentoAt: string | null | undefined,
): Date | null {
  const ts = [botScheduledAt, gdoAppuntamentoAt]
    .filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)))
    .map((v) => Date.parse(v));
  return ts.length ? new Date(Math.max(...ts)) : null;
}

/** La riga su quando chiama Noemi, vuota se non sappiamo quando è la call. */
export function quandoChiamaNoemi(quando: Date | null): string {
  if (!quando) return '';
  return romeHour(quando) < NOEMI_ORA_INIZIO
    ? ' Digli QUANDO lo chiama: il pomeriggio del giorno prima della call, non la mattina stessa, quindi tenga il telefono a portata già dal pomeriggio precedente.'
    : ' Digli QUANDO lo chiama: lo stesso giorno della call, qualche ora prima. Dagli la finestra, mai un orario al minuto.';
}
```

Togli da `NOTA_NOEMI` le parole `'da un cellulare prima della call; '` sostituendole con `'da un cellulare; '` (la frase fissa è quella falsa per le call del mattino), aggiungi i due campi a `GdoNoteInput`:

```ts
  /** Ora della call fissata dal bot. Serve a dire quando chiama Noemi. */
  botScheduledAt?: string | null;
  /** Ora della call fissata dal GDO al telefono. Vince la più recente delle due. */
  gdoAppuntamentoAt?: string | null;
```

e in `gdoContextNote`, dove oggi fa `parti.push(NOTA_NOEMI)`, scrivi:

```ts
  if (serveNoemi(i)) {
    parti.push(NOTA_NOEMI + quandoChiamaNoemi(oraAppuntamento(i.botScheduledAt, i.gdoAppuntamentoAt)));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/gdo-context-note.test.ts`
Expected: PASS. Se un test preesistente confrontava `NOTA_NOEMI` con l'uguaglianza esatta, aggiornalo: la frase fissa è cambiata di proposito.

- [ ] **Step 5: Passa le due colonne dai tre chiamanti**

I chiamanti di `gdoContextNote` sono `lib/fenice-autoreply.ts:451`, `lib/fenice-autoreply.ts:493` e `app/api/cron/gdo-video-followups/route.ts:262`. In tutti e tre aggiungi al literal:

```ts
                botScheduledAt: conv.bot_scheduled_at ?? null,
                gdoAppuntamentoAt: conv.gdo_appuntamento_at ?? null,
```

usando il nome della variabile di riga già presente in quel punto (`conv`, `row` o simile). **Verifica che la select che carica quella riga chieda le due colonne**: se non ci sono, aggiungile alla `.select(...)`, altrimenti arrivano `undefined` e la nota resta muta senza che nessun test se ne accorga.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: verde.

- [ ] **Step 7: Commit**

```bash
git add lib/gdo-context-note.ts lib/gdo-context-note.test.ts
git commit -m "fix(gdo): la nota su Noemi si calcola dall'ora dell'appuntamento"
```

---

### Task 5: Il bot insiste dentro la finestra e non la scavalca

**Files:**
- Modify: `lib/mario-prompt.ts:218-232` (GIORNI E ORARI, SE IL LEAD NON PUÒ)
- Test: `lib/mario-prompt.test.ts`

**Interfaces:**
- Consumes: la guardia del Task 1 — il prompt e la guardia devono dire la stessa cosa, altrimenti il bot promette al lead un giorno che poi diventa una nota.
- Produces: niente per i task successivi. Il ricontatto vero è il Lotto B.

- [ ] **Step 1: Write the failing test**

```ts
describe('fuori finestra non si fissa', () => {
  const p = buildMarioSystem('Marta');

  it('dice che fuori dai due giorni non si fissa, mai', () => {
    expect(p).toContain('Fuori da quei due giorni NON si fissa, mai');
  });

  it('chiede di insistere dentro la finestra prima di mollare', () => {
    expect(p).toContain('cerca il buco dentro quei due giorni');
  });

  it('vieta di confermare un giorno fuori finestra anche se lo propone il lead', () => {
    expect(p).toContain('anche se è il lead a proportelo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/mario-prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In coda alla riga `GIORNI E ORARI` (218), aggiungi come riga fisica nuova:

```
Fuori da quei due giorni NON si fissa, mai, e non fa differenza chi ha proposto il giorno: anche se è il lead a proportelo, un giorno fuori finestra non lo confermi e non lo metti nel tag. Un appuntamento che l'agenda non regge è un appuntamento che non esiste, e il lead resta ad aspettare una call che non c'è.
```

E in coda a `SE IL LEAD NON PUÒ` (232), dopo «Solo se davvero non c'è verso, passa al secondo giorno»:

```
Se non va bene neanche il secondo giorno, non cedere subito: cerca il buco dentro quei due giorni, un orario scomodo, presto la mattina o tardi la sera fino alle 21. Sono 30/40 minuti per una cosa che può cambiargli il lavoro, il tempo si trova quasi sempre.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test && npm run typecheck`
Expected: verde.

- [ ] **Step 5: Commit**

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "fix(prompt): la finestra dei due giorni non si scavalca, si lavora dentro"
```

---

### Task 6: Verifica finale contro i casi reali di settembre

**Files:**
- Nessuna modifica. È un cancello di verifica prima del merge.

- [ ] **Step 1: Suite completa**

Run: `npm test && npm run typecheck && npm run lint`
Expected: tutto verde.

- [ ] **Step 2: Controlla i casi che hanno motivato il lavoro**

Verifica a mano, leggendo il prompt generato, che:
- conv 8348 non sarebbe più possibile: per una call alle 10:00 il prompt impone «il pomeriggio del giorno prima» e vieta «a momenti».
- conv 9595 (*"anche solo 10 minuti in call"*) è coperta dalla riga «I 5-10 minuti sono di Noemi, non della call».
- una call proposta a 4 giorni di distanza non passa più la guardia del Task 1.

- [ ] **Step 3: Commit del riepilogo nella spec**

Aggiungi in fondo alla spec una riga con la data di completamento del lotto A e l'hash dei commit, poi:

```bash
git add docs/superpowers/specs/2026-09-10-comportamento-bot-design.md
git commit -m "docs: lotto A completato"
```

---

## Cosa NON fa questo piano

Il ricontatto vero fuori finestra (la promessa mantenuta, il giorno calcolato, il template Meta, la migration, l'allineamento col CRM) è il **Lotto B** e ha un piano suo. Finché il Lotto B non è live, un lead che non può nei due giorni resta gestito come oggi: `[ESITO:RICHIAMO|...]` al CRM. Il prompt del Task 5 **non** deve promettere un ricontatto che ancora non esiste.
