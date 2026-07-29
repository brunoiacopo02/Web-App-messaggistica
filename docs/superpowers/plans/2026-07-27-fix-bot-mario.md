# Fix bot Mario — link, conferma, note CRM, lucchetto, promemoria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere sei difetti osservati sui dati di produzione del 25-27 luglio 2026: link video rotti, blocco di conferma troncato, note duplicate al CRM, lucchetto del bot su colonna dedicata, promemoria T−24h ridondante, promesse di telefonate che il bot non può mantenere.

**Architecture:** Ogni fix è una funzione pura nuova o modificata in `lib/`, testata con vitest, agganciata in un solo punto della pipeline esistente. Nessuna riscrittura: si aggiungono guardie deterministiche dove oggi ci si fida dell'output del modello. L'unica modifica di schema è una colonna `ai_lock_at` su `conversations`, che separa il lucchetto di concorrenza dallo stato di prodotto `ai_status`.

**Tech Stack:** Next.js (App Router), TypeScript, Supabase (PostgREST + migration SQL), Twilio WhatsApp, Anthropic SDK, vitest.

## Global Constraints

- Tutti i test sono vitest, co-locati come `lib/<modulo>.test.ts`, titoli in italiano che descrivono il comportamento di business.
- `npm test` deve restare verde: 367+ test. `npx tsc --noEmit` deve restare pulito.
- Nessun test sulle route API (il codebase non ne ha): la logica va estratta in funzioni pure in `lib/` e testata lì.
- Un commit per task, messaggio in italiano, minuscolo dopo il prefisso, nello stile dei commit esistenti (`fix(crm): ...`, `feat(reminder): ...`).
- Non toccare `.env.local` né creare file `.env`.
- Il branch di lavoro è `feat/fix-bot-luglio`, creato da `main` aggiornato.
- I quattro URL video ufficiali sono esattamente questi, mai riscriverli a mano:
  - `https://corso.feniceacademy.it/conferenza-bx` (lavora, senza famiglia)
  - `https://corso.feniceacademy.it/conferenza-axmsbn9r50` (non lavora, senza famiglia)
  - `https://corso.feniceacademy.it/conferenza-dx` (lavora, con famiglia)
  - `https://corso.feniceacademy.it/conferenza-ex` (non lavora, con famiglia)
- Il link JotForm ufficiale è `https://form.jotform.com/240755654585063`.
- `event_log` ha solo le colonne `id, type, level, message, payload, created_at`: non esiste `conversation_id`, l'id conversazione va sempre dentro `payload.conversationId`.
- `level` accetta solo `'info' | 'warn' | 'error'`.

---

### Task 1: Sanificazione dei link in uscita

Il 27/07 il modello ha emesso `https://corso.feniceacademy.it/conferenza-ax msbn9r50` (spazio dentro l'URL) e il lead ha ricevuto un link morto. Gli URL noti sono cinque e non cambiano: si riparano deterministicamente prima dell'invio, invece di sperare che il modello li scriva bene.

**Files:**
- Create: `lib/outbound-sanitize.ts`
- Create: `lib/outbound-sanitize.test.ts`
- Modify: `lib/mario.ts:44-49` (dentro `parseMarioReply`, dove oggi si tolgono i tag)

**Interfaces:**
- Produces: `KNOWN_LINKS: readonly string[]`, `sanitizeOutbound(text: string): string`, `unknownFeniceLinks(text: string): string[]`
- Consumes: niente da altri task.

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `lib/outbound-sanitize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeOutbound, unknownFeniceLinks, KNOWN_LINKS } from './outbound-sanitize';

describe('sanitizeOutbound: ripara i link noti spezzati dal modello', () => {
  it('richiude uno spazio dentro l URL del video lungo', () => {
    const t = 'Quando riesci a vederlo? 👉 https://corso.feniceacademy.it/conferenza-ax msbn9r50';
    expect(sanitizeOutbound(t)).toBe('Quando riesci a vederlo? 👉 https://corso.feniceacademy.it/conferenza-axmsbn9r50');
  });

  it('richiude piu spazi e tab dentro lo stesso URL', () => {
    const t = 'https://corso.feniceacademy.it/conferenza-ax\tmsbn9r 50 ecco';
    expect(sanitizeOutbound(t)).toBe('https://corso.feniceacademy.it/conferenza-axmsbn9r50 ecco');
  });

  it('ripara anche il link JotForm', () => {
    const t = 'Clicca qui 👉 https://form.jotform.com/2407556 54585063';
    expect(sanitizeOutbound(t)).toBe('Clicca qui 👉 https://form.jotform.com/240755654585063');
  });

  it('non tocca gli URL gia corretti', () => {
    for (const link of KNOWN_LINKS) {
      expect(sanitizeOutbound(`ecco ${link} ok`)).toBe(`ecco ${link} ok`);
    }
  });

  it('non unisce due bolle diverse: non attraversa gli a-capo', () => {
    const t = 'https://corso.feniceacademy.it/conferenza-\nbx';
    expect(sanitizeOutbound(t)).toBe('https://corso.feniceacademy.it/conferenza-\nbx');
  });

  it('lascia intatto un testo senza link', () => {
    expect(sanitizeOutbound('Perfetto, a domani 😊')).toBe('Perfetto, a domani 😊');
  });

  it('non confonde due URL noti diversi sulla stessa riga', () => {
    const t = 'video https://corso.feniceacademy.it/conferenza-dx e form https://form.jotform.com/240755654585063';
    expect(sanitizeOutbound(t)).toBe(t);
  });
});

describe('unknownFeniceLinks: segnala i link Fenice non riconosciuti', () => {
  it('elenca un URL conferenza fuori dalla lista ufficiale', () => {
    const t = 'guarda https://corso.feniceacademy.it/conferenza-zz9 qui';
    expect(unknownFeniceLinks(t)).toEqual(['https://corso.feniceacademy.it/conferenza-zz9']);
  });

  it('non segnala nulla quando gli URL sono quelli ufficiali', () => {
    expect(unknownFeniceLinks('https://corso.feniceacademy.it/conferenza-bx')).toEqual([]);
  });

  it('non segnala nulla dopo la sanificazione di un URL spezzato', () => {
    const t = sanitizeOutbound('https://corso.feniceacademy.it/conferenza-ax msbn9r50');
    expect(unknownFeniceLinks(t)).toEqual([]);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run lib/outbound-sanitize.test.ts`
Expected: FAIL — `Failed to resolve import "./outbound-sanitize"`.

- [ ] **Step 3: Implementa il modulo**

Crea `lib/outbound-sanitize.ts`:

```ts
// Modulo puro e client-safe: nessun import da supabase/twilio (lo usa anche il simulatore).

/** Gli unici link che il bot deve mai mandare. Ordine: piu lungo prima, cosi
 * un URL non viene riparato usando il prefisso di un altro. */
export const KNOWN_LINKS = [
  'https://corso.feniceacademy.it/conferenza-axmsbn9r50',
  'https://corso.feniceacademy.it/conferenza-bx',
  'https://corso.feniceacademy.it/conferenza-dx',
  'https://corso.feniceacademy.it/conferenza-ex',
  'https://form.jotform.com/240755654585063',
] as const;

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Per ogni link noto, una regex che tollera spazi e tab (mai a-capo: non
 * dobbiamo mai fondere due bolle) tra un carattere e l'altro. */
const REPAIR = KNOWN_LINKS.map((link) => ({
  link,
  re: new RegExp(link.split('').map(escapeRe).join('[ \\t]*'), 'g'),
}));

/** Rimette a posto i link noti che il modello ha spezzato con spazi o tab. */
export function sanitizeOutbound(text: string): string {
  let out = text;
  for (const { link, re } of REPAIR) out = out.replace(re, link);
  return out;
}

const FENICE_LINK_RE = /https:\/\/corso\.feniceacademy\.it\/\S+/g;

/** URL del dominio dei video che non sono nella lista ufficiale: vanno loggati,
 * significa che il modello si e inventato un link. */
export function unknownFeniceLinks(text: string): string[] {
  const found = text.match(FENICE_LINK_RE) ?? [];
  return found.filter((u) => !(KNOWN_LINKS as readonly string[]).includes(u));
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run lib/outbound-sanitize.test.ts`
Expected: PASS, 10 test verdi.

Se il test "non unisce due bolle diverse" fallisce, la regex sta usando `\s` invece di `[ \t]`: correggila, non cambiare il test.

- [ ] **Step 5: Aggancia la sanificazione in `parseMarioReply`**

In `lib/mario.ts`, aggiungi l'import in testa al file:

```ts
import { sanitizeOutbound } from './outbound-sanitize';
```

e avvolgi il testo visibile già ripulito dai tag (righe 44-49). Il risultato finale della catena `.replace(...).trim()` va passato dentro `sanitizeOutbound`:

```ts
  const visibleReply = sanitizeOutbound(
    raw
      .replace(ESITO_RE, '')
      .replace(/\[APPUNTAMENTO_FISSATO\]/g, '')
      .replace(/\[PASSAGGIO_UMANO\]/g, '')
      .replace(/\[VIDEO_VISTO\]/g, '')
      .trim(),
  );
```

Questo è il punto giusto perché è l'unico attraversato sia dal webhook di produzione sia dal simulatore.

- [ ] **Step 6: Aggiungi il test di integrazione su `parseMarioReply`**

In coda a `lib/mario.test.ts`, dentro il `describe` di `parseMarioReply`:

```ts
  it('ripara il link video spezzato prima di consegnare il testo visibile', () => {
    const r = parseMarioReply('Eccolo https://corso.feniceacademy.it/conferenza-ax msbn9r50 [APPUNTAMENTO_FISSATO]');
    expect(r.visibleReply).toContain('https://corso.feniceacademy.it/conferenza-axmsbn9r50');
    expect(r.visibleReply).not.toContain('conferenza-ax msbn9r50');
    expect(r.appointmentFixed).toBe(true);
  });
```

- [ ] **Step 7: Esegui la suite completa**

Run: `npm test`
Expected: tutti verdi. Poi `npx tsc --noEmit`: nessun errore.

- [ ] **Step 8: Commit**

```bash
git add lib/outbound-sanitize.ts lib/outbound-sanitize.test.ts lib/mario.ts lib/mario.test.ts
git commit -m "fix(bot): i link noti non escono mai spezzati da uno spazio"
```

---

### Task 2: Il blocco di conferma non può uscire monco

Il 26/07 sera (conversazione 3303) il blocco post-appuntamento è uscito con 3 bolle su 4: mancava del tutto il passaggio "poi scrivimi FATTO" e il link video è arrivato nudo, senza il testo che lo accompagna. Il gate è l'output del modello: va reso deterministico. Quando manca il link non lo inventiamo — non sappiamo quale dei quattro sia — ma lo segnaliamo.

**Files:**
- Create: `lib/confirmation-block.ts`
- Create: `lib/confirmation-block.test.ts`
- Modify: `lib/fenice-autoreply.ts` (subito dopo `splitMarioMessages`, riga ~195)

**Interfaces:**
- Consumes: `KNOWN_LINKS` da `lib/outbound-sanitize.ts` (Task 1).
- Produces: `ensureConfirmationBlock(parts: string[]): { parts: string[]; added: string[]; missingVideoLink: boolean }`, `STEP4_TEXT: string`, `VIDEO_PITCH_TEXT: string`.

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `lib/confirmation-block.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ensureConfirmationBlock, STEP4_TEXT, VIDEO_PITCH_TEXT } from './confirmation-block';

const step1 = 'Perfetto, allora ci siamo. Confermami tu giorno e ora della call come li hai scelti, così sono sicura che siamo allineati';
const step2 = 'Noemi è la collega della preselezione, ti chiama prima della call da un cellulare: è il passaggio che conferma l\'appuntamento, quindi tieni il telefono a portata';
const step3 = `Qui dentro ci sono le professioni, i pacchetti e le quote di investimento. Sono 20 minuti. https://corso.feniceacademy.it/conferenza-dx`;

describe('ensureConfirmationBlock: il blocco post-appuntamento esce sempre completo', () => {
  it('lascia intatto un blocco gia completo', () => {
    const r = ensureConfirmationBlock([step1, step2, step3, STEP4_TEXT]);
    expect(r.parts).toEqual([step1, step2, step3, STEP4_TEXT]);
    expect(r.added).toEqual([]);
    expect(r.missingVideoLink).toBe(false);
  });

  it('aggiunge il passaggio FATTO quando manca', () => {
    const r = ensureConfirmationBlock([step1, step2, step3]);
    expect(r.parts).toEqual([step1, step2, step3, STEP4_TEXT]);
    expect(r.added).toEqual(['step4']);
  });

  it('aggiunge il testo del video quando esce solo il link nudo', () => {
    const r = ensureConfirmationBlock([step1, step2, 'https://corso.feniceacademy.it/conferenza-dx', STEP4_TEXT]);
    expect(r.parts[2]).toBe(`${VIDEO_PITCH_TEXT} https://corso.feniceacademy.it/conferenza-dx`);
    expect(r.added).toEqual(['videoPitch']);
    expect(r.missingVideoLink).toBe(false);
  });

  it('segnala il link video mancante senza inventarne uno', () => {
    const r = ensureConfirmationBlock([step1, step2]);
    expect(r.missingVideoLink).toBe(true);
    expect(r.parts.join(' ')).not.toContain('conferenza-');
    expect(r.parts).toContain(STEP4_TEXT);
  });

  it('riconosce il passaggio FATTO anche se il modello lo ha riformulato', () => {
    const variante = 'poi scrivimi FATTO qui sotto quando l\'hai guardato';
    const r = ensureConfirmationBlock([step1, step2, step3, variante]);
    expect(r.added).toEqual([]);
    expect(r.parts).toHaveLength(4);
  });

  it('non duplica il passaggio FATTO quando e gia presente in altra forma', () => {
    const r = ensureConfirmationBlock([step1, step2, step3, 'scrivimi FATTO quando l\'hai visto così lo segno']);
    expect(r.parts.filter((p) => /FATTO/i.test(p))).toHaveLength(1);
  });

  it('aggiunge sia testo video sia FATTO quando mancano entrambi', () => {
    const r = ensureConfirmationBlock([step1, step2, 'https://corso.feniceacademy.it/conferenza-bx']);
    expect(r.added).toEqual(['videoPitch', 'step4']);
    expect(r.parts).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run lib/confirmation-block.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa il modulo**

Crea `lib/confirmation-block.ts`:

```ts
import { KNOWN_LINKS } from './outbound-sanitize';

/** Copy canonica dei passaggi che non dipendono dalla situazione del lead.
 * Deve restare identica a quella in lib/mario-prompt.ts. */
export const STEP4_TEXT = 'poi scrivimi FATTO qui quando l\'hai visto, così lo segno';
export const VIDEO_PITCH_TEXT =
  'Qui dentro ci sono le professioni, i pacchetti e le quote di investimento. Sono 20 minuti e servono perché in call partiamo dal tuo caso invece che dalle basi. Quando riesci a vederlo, stasera o domani?';

const VIDEO_LINKS = (KNOWN_LINKS as readonly string[]).filter((l) => l.includes('conferenza-'));

const hasVideoLink = (p: string) => VIDEO_LINKS.some((l) => p.includes(l));
const isStep4 = (p: string) => /\bFATTO\b/.test(p);
/** Il link e "nudo" se nella sua bolla non c'e nient'altro di sostanziale. */
const isBareLink = (p: string) => {
  const senzaLink = VIDEO_LINKS.reduce((acc, l) => acc.split(l).join(''), p).replace(/[\s👉]/g, '');
  return senzaLink.length < 12;
};

/**
 * Garantisce che il blocco di conferma post-appuntamento arrivi completo:
 * il link video accompagnato dal suo testo, e il passaggio FATTO in coda.
 * Non inventa mai il link: se manca lo segnala e basta.
 */
export function ensureConfirmationBlock(
  parts: string[],
): { parts: string[]; added: string[]; missingVideoLink: boolean } {
  const out = [...parts];
  const added: string[] = [];

  const videoIdx = out.findIndex(hasVideoLink);
  if (videoIdx >= 0 && isBareLink(out[videoIdx])) {
    out[videoIdx] = `${VIDEO_PITCH_TEXT} ${out[videoIdx].trim()}`;
    added.push('videoPitch');
  }

  if (!out.some(isStep4)) {
    out.push(STEP4_TEXT);
    added.push('step4');
  }

  return { parts: out, added, missingVideoLink: videoIdx < 0 };
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run lib/confirmation-block.test.ts`
Expected: PASS, 7 test verdi.

- [ ] **Step 5: Aggancia in `drainMarioReplies`**

In `lib/fenice-autoreply.ts`, aggiungi in testa:

```ts
import { ensureConfirmationBlock } from './confirmation-block';
```

Alla riga ~195, dove oggi c'è `const parts = splitMarioMessages(result.visibleReply);`, sostituisci con:

```ts
  let parts = splitMarioMessages(result.visibleReply);
  if (result.appointmentFixed) {
    const block = ensureConfirmationBlock(parts);
    parts = block.parts;
    if (block.added.length > 0 || block.missingVideoLink) {
      await supabase.from('event_log').insert({
        type: 'confirmation_block_patched',
        payload: { conversationId, added: block.added, missingVideoLink: block.missingVideoLink } as never,
        message: `[bot-fissatore] blocco conferma incompleto sulla conversazione ${conversationId}: aggiunti [${block.added.join(', ')}]${block.missingVideoLink ? ', link video assente' : ''}`,
        level: block.missingVideoLink ? 'warn' : 'info',
      });
    }
  }
```

Verifica che nel punto di aggancio esistano già in scope le variabili `supabase`, `conversationId` e `result`: se hanno altro nome in quel file, usa i nomi reali, non rinominare nulla.

- [ ] **Step 6: Esegui la suite completa**

Run: `npm test` — tutti verdi. Poi `npx tsc --noEmit`.

Se `parts` era dichiarato `const` e altri punti del file lo assumono immutabile, il cambio a `let` è comunque corretto: verifica solo che non ci siano riassegnazioni concorrenti più in basso.

- [ ] **Step 7: Commit**

```bash
git add lib/confirmation-block.ts lib/confirmation-block.test.ts lib/fenice-autoreply.ts
git commit -m "fix(conferme): il blocco post-appuntamento non esce mai monco"
```

---

### Task 3: Niente note duplicate al CRM

Dal 25/07 il CRM ha ricevuto 22 note dal bot su 7 lead: tre identiche in due minuti sullo stesso lead (spostamento al 28 alle 17), e una identica ripetuta a 53 minuti di distanza. Ogni ripetizione è rumore per il commerciale. Una nota identica alla precedente sulla stessa conversazione non aggiunge nulla: non va inviata.

**Files:**
- Create: `lib/note-dedup.ts`
- Create: `lib/note-dedup.test.ts`
- Modify: `lib/bot-outcome.ts` (ramo `locked`, prima del POST alla riga ~86)

**Interfaces:**
- Produces: `noteFingerprint(note: string): string`
- Consumes: `action.note` da `resolveOutcomeAction` (`lib/bot-outcome-rules.ts`).

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `lib/note-dedup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { noteFingerprint } from './note-dedup';

describe('noteFingerprint: due note equivalenti hanno la stessa impronta', () => {
  it('ignora spazi doppi e spazi ai bordi', () => {
    expect(noteFingerprint('  Il lead  vuole annullare ')).toBe(noteFingerprint('Il lead vuole annullare'));
  });

  it('ignora le differenze di maiuscole', () => {
    expect(noteFingerprint('Il Lead Vuole Annullare')).toBe(noteFingerprint('il lead vuole annullare'));
  });

  it('distingue note con contenuto diverso', () => {
    const a = noteFingerprint('Il lead ha chiesto di spostare a martedì 28 luglio alle 17:00.');
    const b = noteFingerprint('Il lead ha chiesto di spostare a martedì 28 luglio alle 15:00.');
    expect(a).not.toBe(b);
  });

  it('e stabile fra chiamate diverse', () => {
    const n = 'Il lead vuole annullare l\'appuntamento (fissato per lunedì 27 luglio alle 13:00).';
    expect(noteFingerprint(n)).toBe(noteFingerprint(n));
  });

  it('gestisce la nota vuota senza esplodere', () => {
    expect(typeof noteFingerprint('')).toBe('string');
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run lib/note-dedup.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementa il modulo**

Crea `lib/note-dedup.ts`:

```ts
import { createHash } from 'node:crypto';

/** Impronta stabile di una nota CRM: serve a riconoscere che stiamo per
 * rimandare esattamente la stessa nota gia inviata su questa conversazione. */
export function noteFingerprint(note: string): string {
  const normalizzata = note.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalizzata).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run lib/note-dedup.test.ts`
Expected: PASS, 5 test verdi.

- [ ] **Step 5: Aggancia la guardia in `sendOutcome`**

In `lib/bot-outcome.ts` aggiungi l'import:

```ts
import { noteFingerprint } from './note-dedup';
```

Subito dopo il blocco `if (interim && action.kind !== 'normal') { ... }` (riga ~57) e prima della costruzione di `body`, inserisci:

```ts
  // Una nota identica a una gia inviata su questa conversazione non aggiunge
  // informazione: il commerciale la vedrebbe solo duplicata sul CRM.
  if (action.kind === 'locked') {
    const fp = noteFingerprint(action.note);
    const { data: gia } = await supabase
      .from('event_log')
      .select('id')
      .eq('type', 'bot_outcome_locked')
      .eq('payload->>conversationId', String(conversationId))
      .eq('payload->>noteFingerprint', fp)
      .limit(1);
    if ((gia ?? []).length > 0) {
      return { sent: false, error: 'note_duplicate' };
    }
  }
```

Poi, nell'insert di `event_log` del ramo locked (riga ~127), aggiungi il campo `noteFingerprint` al payload, mantenendo tutti quelli esistenti:

```ts
          payload: { conversationId, crmLeadId, attemptedOutcome: args.outcome, keptOutcome: 'APPUNTAMENTO', sentAs: 'NOTA', note: action.note, noteFingerprint: noteFingerprint(action.note) } as never,
```

Nota: il filtro `.eq('payload->>conversationId', String(conversationId))` funziona su PostgREST perché `payload` è `jsonb` e l'operatore `->>` restituisce testo — per questo il confronto è con una stringa.

- [ ] **Step 6: Aggiungi i test su `sendOutcome`**

In `lib/bot-outcome.test.ts`, il fake Supabase esistente (righe ~7-23) va esteso perché la nuova guardia fa una `select` su `event_log` con tre `.eq()` concatenati e un `.limit(1)`. Estendi lo stub in modo che:
- `from('event_log').select(...)` restituisca un oggetto chainable con `eq()` che ritorna se stesso e `limit()` che risolve `{ data: eventLogHits }`, dove `eventLogHits` è un parametro del helper (default `[]`);
- gli insert su `event_log` continuino ad accumularsi nell'array `events` come oggi.

Poi aggiungi:

```ts
  it('non rimanda al CRM una nota identica gia inviata', async () => {
    // helper esistente, con la select su event_log che trova un precedente
    const supa = makeSupabase({ botOutcome: 'APPUNTAMENTO', eventLogHits: [{ id: 1 }] });
    const r = await sendOutcome(supa, 42, { outcome: 'DA_SCARTARE', discardReason: 'non ha budget' });
    expect(r).toEqual({ sent: false, error: 'note_duplicate' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invia la nota quando non ce n e una identica', async () => {
    const supa = makeSupabase({ botOutcome: 'APPUNTAMENTO', eventLogHits: [] });
    const r = await sendOutcome(supa, 42, { outcome: 'DA_SCARTARE', discardReason: 'non ha budget' });
    expect(r.sent).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.outcome).toBe('NOTA');
  });

  it('registra l impronta della nota nell evento locked', async () => {
    const supa = makeSupabase({ botOutcome: 'APPUNTAMENTO', eventLogHits: [] });
    await sendOutcome(supa, 42, { outcome: 'DA_SCARTARE', discardReason: 'non ha budget' });
    const locked = supa.calls.events.find((e: { type: string }) => e.type === 'bot_outcome_locked');
    expect(locked.payload.noteFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
```

Adatta i nomi (`makeSupabase`, `fetchMock`, `supa.calls.events`) a quelli realmente usati nel file: non rinominare le utility esistenti.

- [ ] **Step 7: Esegui la suite completa**

Run: `npm test` — tutti verdi, inclusi i test preesistenti di `bot-outcome.test.ts`. Poi `npx tsc --noEmit`.

- [ ] **Step 8: Commit**

```bash
git add lib/note-dedup.ts lib/note-dedup.test.ts lib/bot-outcome.ts lib/bot-outcome.test.ts
git commit -m "fix(crm): una nota identica non viene rimandata due volte"
```

---

### Task 4: Il lucchetto su colonna dedicata

Oggi il lucchetto di concorrenza è il valore `'replying'` dentro `ai_status`, cioè la stessa colonna che descrive lo stato di prodotto della conversazione. Questo doppio uso è la radice di più problemi noti: una conversazione `booked` non può essere presa in carico perché il claim CAS pretende `ai_status = 'active'`, il lucchetto non ha un istante di presa (la staleness si deduce dall'ultimo inbound), e il reset di un lucchetto orfano riporta a `'active'` rimettendo la conversazione nel giro di classificazione del cron.

Questo task sposta il lucchetto su `ai_lock_at` e **non cambia la semantica di `ai_status`**: chi poteva essere autorisposto prima lo può dopo, né più né meno. Le regole di riapertura decise il 25/07 (`booked` non si riapre) restano intatte.

**Files:**
- Create: `supabase/migrations/20260727000001_ai_lock_at.sql`
- Modify: `lib/fenice-autoreply.ts` (claim ~149-156, release ~271-273, `isOrphanedReplyingLock` ~104-119)
- Modify: `lib/fenice-autoreply.test.ts`
- Modify: `app/api/cron/bot-followups/route.ts:102-110` (reset del lucchetto orfano)
- Modify: `lib/supabase/types.ts` (riga della tabella `conversations`)

**Interfaces:**
- Produces: `LOCK_TTL_MS: number`, `isLockStale(lockAt: string | null, nowMs: number, ttlMs?: number): boolean`
- Consumes: niente dai task precedenti.

- [ ] **Step 1: Scrivi la migration**

Crea `supabase/migrations/20260727000001_ai_lock_at.sql`:

```sql
-- Lucchetto di concorrenza del bot su colonna dedicata: ai_status torna a
-- descrivere solo lo stato di prodotto della conversazione.
alter table conversations add column if not exists ai_lock_at timestamptz;

create index if not exists conversations_ai_lock_at_idx
  on conversations(ai_lock_at)
  where ai_lock_at is not null;
```

- [ ] **Step 2: Scrivi il test che fallisce**

In `lib/fenice-autoreply.test.ts`, accanto ai test delle altre funzioni pure:

```ts
describe('isLockStale: un lucchetto vecchio non blocca il bot per sempre', () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);

  it('nessun lucchetto: non e stale, e proprio libero', () => {
    expect(isLockStale(null, now)).toBe(false);
  });

  it('lucchetto preso adesso: non e stale', () => {
    expect(isLockStale(new Date(now - 1000).toISOString(), now)).toBe(false);
  });

  it('lucchetto di 9 minuti fa: non e ancora stale', () => {
    expect(isLockStale(new Date(now - 9 * 60_000).toISOString(), now)).toBe(false);
  });

  it('lucchetto di 11 minuti fa: e stale e va forzato', () => {
    expect(isLockStale(new Date(now - 11 * 60_000).toISOString(), now)).toBe(true);
  });

  it('rispetta un TTL passato esplicitamente', () => {
    expect(isLockStale(new Date(now - 2 * 60_000).toISOString(), now, 60_000)).toBe(true);
  });

  it('una data illeggibile e trattata come stale, non come lucchetto eterno', () => {
    expect(isLockStale('non-una-data', now)).toBe(true);
  });
});
```

Aggiungi `isLockStale` e `LOCK_TTL_MS` all'import da `./fenice-autoreply` in testa al file di test.

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: FAIL — `isLockStale is not a function`.

- [ ] **Step 4: Implementa la funzione pura**

In `lib/fenice-autoreply.ts`, accanto a `REPLYING_ORPHAN_MS` (riga ~104):

```ts
/** Dopo questo tempo un lucchetto e considerato abbandonato (processo morto). */
export const LOCK_TTL_MS = 10 * 60_000;

/** True se il lucchetto va forzato: assente no, illeggibile si (meglio
 * riprovare che restare bloccati per sempre su un valore corrotto). */
export function isLockStale(lockAt: string | null, nowMs: number, ttlMs: number = LOCK_TTL_MS): boolean {
  if (lockAt === null) return false;
  const t = Date.parse(lockAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t >= ttlMs;
}
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `npx vitest run lib/fenice-autoreply.test.ts`
Expected: PASS sui 6 nuovi test; i preesistenti restano verdi.

- [ ] **Step 6: Sposta il claim sul nuovo lucchetto**

In `lib/fenice-autoreply.ts`, il claim CAS attuale (righe ~149-156) prende `ai_status: 'replying'` filtrando su `ai_status = 'active'`. Sostituiscilo con un claim su `ai_lock_at`, mantenendo il filtro di ammissibilità su `ai_status`:

```ts
  const nowIso = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
  const { data: claimed } = await supabase
    .from('conversations')
    .update({ ai_lock_at: nowIso })
    .eq('id', conversationId)
    .eq('ai_status', 'active')
    .or(`ai_lock_at.is.null,ai_lock_at.lt.${staleCutoff}`)
    .select('id, ai_status, crm_lead_id, bot_outcome, lead_id')
    .single();
  if (!claimed) return;
```

Mantieni esattamente le colonne che la `select` già chiedeva prima: se l'elenco qui sopra non coincide con quello reale nel file, vince quello reale.

- [ ] **Step 7: Rilascia il lucchetto nel `finally`**

Nel blocco `finally` (righe ~271-273) dove oggi si riscrive `ai_status: finalStatus`, aggiungi il rilascio nello stesso update:

```ts
    await supabase
      .from('conversations')
      .update({ ai_status: finalStatus, ai_lock_at: null })
      .eq('id', conversationId);
```

Importante: `finalStatus` non deve mai più valere `'replying'`. Cerca nel file ogni assegnazione di `'replying'` e rimuovila; se `'replying'` compare in una lista di stati ammessi (per esempio in `shouldAutoReply`), **lasciala**: in produzione esistono righe ferme su quel valore e devono restare gestibili.

- [ ] **Step 8: Aggiorna il reset del lucchetto orfano nel cron**

In `app/api/cron/bot-followups/route.ts:102-110`, il reset oggi fa un CAS su `ai_status = 'replying'` riportando a `'active'`. Sostituisci la condizione con il nuovo lucchetto, senza toccare `ai_status`:

```ts
      if (isLockStale(c.ai_lock_at ?? null, now)) {
        await supabase
          .from('conversations')
          .update({ ai_lock_at: null })
          .eq('id', c.id)
          .lt('ai_lock_at', new Date(now - LOCK_TTL_MS).toISOString());
      }
```

Aggiungi `ai_lock_at` alla `select` delle conversazioni (riga ~57) e importa `isLockStale, LOCK_TTL_MS` da `@/lib/fenice-autoreply`.

Lascia in piedi il reset legacy su `'replying'` che già esiste: serve a recuperare le righe rimaste appese al vecchio meccanismo. Vanno bene entrambi nello stesso giro.

- [ ] **Step 9: Aggiorna i tipi Supabase**

In `lib/supabase/types.ts`, nella tabella `conversations`, aggiungi `ai_lock_at: string | null` in `Row`, `ai_lock_at?: string | null` in `Insert` e in `Update`, in ordine alfabetico fra le altre colonne `ai_*`.

- [ ] **Step 10: Applica la migration**

La migration va applicata al progetto Supabase di produzione dell'app di messaggistica (NON quello del CRM). Applicala e verifica che la colonna esista:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'conversations' and column_name = 'ai_lock_at';
```

Expected: una riga, `timestamptz`.

Se non hai accesso diretto, fermati qui e segnala: il codice dei passi 6-8 non deve essere committato prima che la colonna esista in produzione, altrimenti ogni claim fallisce e il bot smette di rispondere.

- [ ] **Step 11: Esegui la suite completa**

Run: `npm test` — tutti verdi. Poi `npx tsc --noEmit`.

I due test d'integrazione su `drainMarioReplies` (`lib/fenice-autoreply.test.ts:214-266`) usano un fake Supabase che simula il claim: vanno adattati al nuovo update (`ai_lock_at` invece di `ai_status: 'replying'`) e allo stub di `.or()`. Se `.or()` non esiste nello stub chainable, aggiungilo restituendo `this`.

- [ ] **Step 12: Commit**

```bash
git add supabase/migrations/20260727000001_ai_lock_at.sql lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts app/api/cron/bot-followups/route.ts lib/supabase/types.ts
git commit -m "refactor(bot): il lucchetto vive su ai_lock_at, ai_status torna stato di prodotto"
```

---

### Task 5: Mario non promette telefonate che non può fare

Il 27/07 una lead ha scritto "se vuole mi chiami ora" e Mario ha risposto **"Certo, ti chiamo subito!"**. Mario è un'IA su WhatsApp: non può telefonare. La lead è rimasta ad aspettare una chiamata mai promessa da nessun umano. Vale la stessa regola per cui l'IA non si spaccia per una persona: non deve promettere azioni che non è in grado di compiere.

**Files:**
- Modify: `lib/mario-prompt.ts` (blocco REGOLE ASSOLUTE, intorno alla riga 128)
- Modify: `lib/mario-prompt.test.ts`

- [ ] **Step 1: Scrivi il test che fallisce**

In `lib/mario-prompt.test.ts`, in coda:

```ts
describe('niente promesse di telefonate: Mario non puo chiamare nessuno', () => {
  const p = buildMarioSystem('Marta');

  it('il prompt vieta esplicitamente di promettere una chiamata propria', () => {
    expect(p).toMatch(/non (puoi|devi) mai (promettere|dire).{0,60}(chiam)/i);
  });

  it('indica l alternativa corretta: fa richiamare una collega', () => {
    expect(p).toContain('ti faccio richiamare da una collega');
  });

  it('la regola sta nelle REGOLE ASSOLUTE, non in una fase specifica', () => {
    const regole = p.slice(p.indexOf('REGOLE ASSOLUTE'), p.indexOf('FASE 1'));
    expect(regole).toMatch(/chiamare|telefon/i);
  });
});
```

Verifica come il file di test costruisce il prompt: se l'helper non è `buildMarioSystem('Marta')`, usa quello reale. Se il marcatore `FASE 1` non esiste con quel testo esatto, usa il primo marcatore di sezione che segue le regole assolute.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run lib/mario-prompt.test.ts`
Expected: FAIL sui tre nuovi test.

- [ ] **Step 3: Aggiungi la regola al prompt**

In `lib/mario-prompt.ts`, dentro il blocco delle REGOLE ASSOLUTE, aggiungi una regola numerata coerente con la numerazione già presente:

```
N. MAI PROMETTERE UNA TELEFONATA TUA: scrivi solo su WhatsApp, non puoi chiamare nessuno. Se il lead ti chiede di essere chiamato, non dire mai "ti chiamo" o "ti chiamo subito": rispondi che ti fai sentire qui e che, se preferisce parlare a voce, "ti faccio richiamare da una collega". Vale anche quando il lead è arrabbiato o ha fretta.
```

Sostituisci `N.` con il numero successivo a quelli già presenti, e verifica che le regole seguenti non vadano rinumerate (se sono numerate, rinumerale tutte in modo coerente).

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run lib/mario-prompt.test.ts`
Expected: PASS. Attenzione ai test preesistenti che contano le regole o verificano la lunghezza del prompt: se qualcuno fallisce, aggiornalo con il nuovo conteggio, non indebolire l'asserzione.

- [ ] **Step 5: Esegui la suite completa e committa**

Run: `npm test` e `npx tsc --noEmit`.

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "fix(bot): Mario non promette telefonate che non puo fare"
```

---

### Task 6: Il promemoria T−24h non chiede del video a chi l'ha già visto

Il template `fenice_reminder_24h_v1` dice: *"Ciao {{1}}, ti ricordo la videocall di {{2}}. Hai già visto il video che ti ho mandato? Fammi sapere qui, così arriviamo pronti."* Il 26/07 è partito verso una lead che alle 10:39 aveva scritto di aver già visto il video, e lei se n'è accorta: *"mi sembrava di avervi già risposto stamattina"*. Il promemoria in sé è giusto, è la domanda sul video a essere fuori luogo.

Il segnale `[VIDEO_VISTO]` non basta da solo: in quel caso il modello non l'ha emesso perché la conferma era annegata in un messaggio lungo e polemico. Serve un secondo segnale, più grossolano ma affidabile: **il lead ha scritto qualcosa dopo che gli è stato mandato il link del video**. In entrambi i casi la domanda sul video è da togliere.

Questo richiede un secondo template approvato da Meta. Il codice va scritto e testato ora, e resta inerte finché il SID non è configurato: senza `REMINDER_24H_NOVIDEO_TEMPLATE_SID` si usa il template attuale, esattamente come oggi.

**Files:**
- Create: `scripts/create-reminder-novideo-template.mjs`
- Modify: `lib/precall-reminders.ts`
- Modify: `lib/precall-reminders.test.ts`
- Modify: `app/api/cron/precall-reminders/route.ts`

**Interfaces:**
- Produces: `pickReminder24Template(input: { hasVideoWatchedEvent: boolean; inboundAfterVideoMs: number | null; novideoSid: string | null; defaultSid: string }): string`
- Consumes: niente dai task precedenti.

- [ ] **Step 1: Scrivi il test che fallisce**

In `lib/precall-reminders.test.ts`, in coda:

```ts
describe('pickReminder24Template: a chi ha gia visto il video non si richiede del video', () => {
  const base = { hasVideoWatchedEvent: false, inboundAfterVideoMs: null, novideoSid: 'HXnovideo', defaultSid: 'HXdefault' };
  const pick = (over: Partial<typeof base> = {}) => pickReminder24Template({ ...base, ...over });

  it('usa il template standard quando non sappiamo nulla', () => {
    expect(pick()).toBe('HXdefault');
  });

  it('usa il template senza domanda quando il tag VIDEO_VISTO e stato registrato', () => {
    expect(pick({ hasVideoWatchedEvent: true })).toBe('HXnovideo');
  });

  it('usa il template senza domanda quando il lead ha scritto dopo il link del video', () => {
    expect(pick({ inboundAfterVideoMs: Date.UTC(2026, 6, 26, 8, 39) })).toBe('HXnovideo');
  });

  it('torna al template standard se il SID senza domanda non e configurato', () => {
    expect(pick({ hasVideoWatchedEvent: true, novideoSid: null })).toBe('HXdefault');
  });

  it('il template standard resta quello di default anche con entrambi i segnali assenti', () => {
    expect(pick({ hasVideoWatchedEvent: false, inboundAfterVideoMs: null })).toBe('HXdefault');
  });
});
```

Aggiungi `pickReminder24Template` all'import da `./precall-reminders`.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run lib/precall-reminders.test.ts`
Expected: FAIL — `pickReminder24Template is not a function`.

- [ ] **Step 3: Implementa la funzione pura**

In coda a `lib/precall-reminders.ts`:

```ts
/** Il promemoria a 24h chiede "hai visto il video?". Se il lead l'ha gia visto,
 * o comunque ha scritto qualcosa dopo aver ricevuto il link, quella domanda e
 * rumore: si usa la variante senza domanda, quando e configurata. */
export function pickReminder24Template(input: {
  hasVideoWatchedEvent: boolean;
  inboundAfterVideoMs: number | null;
  novideoSid: string | null;
  defaultSid: string;
}): string {
  const giaVisto = input.hasVideoWatchedEvent || input.inboundAfterVideoMs !== null;
  if (giaVisto && input.novideoSid) return input.novideoSid;
  return input.defaultSid;
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run lib/precall-reminders.test.ts`
Expected: PASS, 5 nuovi test verdi, i 13 preesistenti invariati.

- [ ] **Step 5: Aggancia nel cron**

In `app/api/cron/precall-reminders/route.ts`, dove oggi si sceglie `sid24`:
1. leggi `const novideoSid = process.env.REMINDER_24H_NOVIDEO_TEMPLATE_SID ?? null;` accanto agli altri SID (riga ~36), **senza** aggiungerlo alla lista dei SID obbligatori: la sua assenza non deve bloccare il cron;
2. per la conversazione in esame, prima di inviare un `r24`, ricava i due segnali:

```ts
      const { data: vw } = await supabase
        .from('event_log')
        .select('id')
        .eq('type', 'video_watched')
        .eq('payload->>conversationId', String(conv.id))
        .limit(1);

      const { data: videoMsg } = await supabase
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conv.id)
        .eq('direction', 'out')
        .ilike('body', '%corso.feniceacademy.it/conferenza-%')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let inboundAfterVideoMs: number | null = null;
      if (videoMsg?.created_at) {
        const { data: dopo } = await supabase
          .from('messages')
          .select('created_at')
          .eq('conversation_id', conv.id)
          .eq('direction', 'in')
          .gt('created_at', videoMsg.created_at)
          .limit(1)
          .maybeSingle();
        if (dopo?.created_at) inboundAfterVideoMs = Date.parse(dopo.created_at);
      }

      const sid = kind === 'r24'
        ? pickReminder24Template({
            hasVideoWatchedEvent: (vw ?? []).length > 0,
            inboundAfterVideoMs,
            novideoSid,
            defaultSid: sid24,
          })
        : sid3;
```

3. usa `sid` al posto del SID scelto in precedenza nella chiamata a `sendTemplateAndLog`.

Attenzione: la logica di idempotenza esistente riconosce "promemoria già inviato" confrontando `messages.template_sid` con `sid24`/`sid3`. Con due possibili SID per l'R24, quel confronto deve accettare **entrambi**: cerca il punto che marca l'R24 come già inviato (righe ~81 e ~112-113) e fai in modo che consideri inviato l'R24 se esiste un messaggio con `template_sid` uguale a `sid24` **oppure** a `novideoSid`. Se questo passaggio non viene fatto, un lead può ricevere due promemoria a 24h.

- [ ] **Step 6: Scrivi lo script del template**

Crea `scripts/create-reminder-novideo-template.mjs` copiando la struttura di `scripts/create-reminder-templates.mjs` (stesse credenziali Twilio da env, stessa chiamata di creazione + submit per approvazione), con un solo template:

- nome: `fenice_reminder_24h_novideo_v1`
- categoria: `UTILITY` (come gli altri due promemoria: non consuma budget MARKETING)
- lingua: `it`
- body: `Ciao {{1}}, ti ricordo la videocall di {{2}}. Se ti serve qualcosa prima, scrivimi pure qui.`
- due variabili di esempio coerenti con i template esistenti (`{{1}}` nome, `{{2}}` giorno e ora).

Non eseguire lo script in questo task: va lanciato da chi ha le credenziali Twilio, e l'approvazione Meta richiede tempo.

- [ ] **Step 7: Esegui la suite completa**

Run: `npm test` e `npx tsc --noEmit`.

- [ ] **Step 8: Commit**

```bash
git add lib/precall-reminders.ts lib/precall-reminders.test.ts app/api/cron/precall-reminders/route.ts scripts/create-reminder-novideo-template.mjs
git commit -m "fix(reminder): niente domanda sul video a chi lo ha gia visto"
```

---

## Note di chiusura per chi esegue

- I task 1, 2, 3, 5 sono indipendenti e possono essere lavorati in qualsiasi ordine.
- Il task 4 tocca il cuore della concorrenza del bot: va fatto da solo, e il codice non va committato prima che la colonna `ai_lock_at` esista in produzione (Step 10).
- Il task 6 resta inerte finché Meta non approva il nuovo template: è previsto e corretto.
- Dopo l'ultimo task, prima del merge: `npm test`, `npx tsc --noEmit`, e una rilettura del diff completo con `git diff main...HEAD`.
