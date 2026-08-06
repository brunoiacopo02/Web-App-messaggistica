# Dichiarazione IA, stop alle date inventate e pacchetto post-fissaggio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** portare in produzione i tre blocchi decisi da Bruno il 06/08/2026 — varianti di apertura che dichiarano l'IA (obbligo AI Act art. 50, in vigore dal 2/8/2026), fine delle date di richiamo inventate, e il pacchetto di interventi che riduce le disdette dopo il fissaggio.

**Architecture:** tre branch sequenziali su `main` (`feat/aperture-dichiarate`, `fix/date-inventate`, `feat/pacchetto-post-fissaggio`), ognuno mergiato prima di aprire il successivo perché i blocchi 2 e 3 toccano entrambi `lib/mario-prompt.ts`. La logica nuova vive in funzioni pure nei moduli `lib/` esistenti (testabili senza DB né rete); le route cron e il drain le consumano. Nessuna riscrittura strutturale: si aggiungono varianti, guardie e colonne.

**Tech Stack:** Next.js 16.2.4 (App Router, route handlers in `app/api/**/route.ts`), TypeScript, Supabase (postgrest-js), Twilio Content API, Anthropic SDK (`claude-sonnet-4-6`), Vitest.

## Global Constraints

- **Migration PRIMA del deploy, sempre.** Nessun codice che legge o scrive una colonna nuova va in produzione prima che la colonna esista.
- **Il bot non inventa mai dati**: date, orari, disponibilità di calendario. Se non gliel'ha detto il lead, non esiste.
- **Solo tecniche di vendita oneste.** Niente manipolazione, niente pressione su un no vero, l'IA non si spaccia mai per umano.
- **Niente "se preferisci ti passo un operatore" nelle aperture** — decisione esplicita di Bruno (riempirebbe i GDO di richieste di passaggio a umano). Vale solo per il testo delle aperture: la regola già esistente nel prompt (rispondere onestamente a "sei un bot?") resta invariata.
- **`bot_outcome = 'APPUNTAMENTO'` è terminale**: nessun intervento di questo piano lo declassa mai. Le disdette restano note + marcatore su colonna dedicata.
- **Test verdi prima di ogni merge**: `npm test` (456+ test oggi), `npm run typecheck`, `npm run lint`.
- **Prima di toccare qualunque file Next.js** (`app/**/route.ts`): leggere `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`. Questa versione ha breaking change rispetto a quella che conosci.
- **Lingua del codice**: commenti, note ed eventi in italiano, come tutto il repo.

---

## File Structure

**Blocco 1 — varianti con dichiarazione**
- `lib/persona.ts` (modifica): `variantIndexFor` da 2 a 4 vie, `OPENING_TEXTS` con le 6 varianti nuove, nuovo export `OPENING_ENV_KEYS` (unica fonte di verità dei 12 nomi env, così nessun call-site può dimenticarne uno).
- `lib/fenice-autoreply.ts` (modifica, righe 88-100): `martaSidsFromEnv` consuma `OPENING_ENV_KEYS`.
- `app/api/cron/sequence-touches/route.ts` (modifica, righe ~131-133): stessa lista, stesso export.
- `scripts/create-marta-openings-dichiarate.mjs` (nuovo): script gemello di `create-marta-templates.mjs`, crea SOLO i 6 template nuovi.
- `scripts/ab-report.mjs` (modifica): 6 label nuove + confronto aggregato "dichiarate vs non dichiarate".

**Blocco 2 — stop alle date inventate**
- `lib/mario.ts` (modifica, `parseMarioReply`): l'argomento di `[ESITO:RICHIAMO|...]` che non è una data ISO valida diventa `note`, non `scheduledAt`.
- `lib/bot-outcome-rules.ts` (modifica): `checkDataRichiamo` + `buildRichiamoSenzaDataNote` (pure).
- `lib/bot-outcome.ts` (modifica): guardia prima del POST al CRM, ramo `richiamo senza data` → NOTA, conversazione lasciata aperta.
- `lib/fenice-autoreply.ts` (modifica): non chiude la conversazione quando `sendOutcome` chiede di tenerla aperta.
- `lib/mario-prompt.ts` (modifica): via ogni fallback che permette di dedurre una data.

**Blocco 3 — pacchetto post-fissaggio**
- `supabase/migrations/20260806000001_cancel_requested_at.sql` (nuovo) + `lib/supabase/types.ts` (modifica).
- `lib/bot-outcome-rules.ts` (modifica): `isRichiestaDisdetta` (pure).
- `lib/bot-outcome.ts` (modifica): scrive `cancel_requested_at` sui due rami che gestiscono un esito su appuntamento già fissato.
- `app/api/cron/precall-reminders/route.ts` e `app/api/cron/gdo-video-followups/route.ts` (modifica): filtro `.is('cancel_requested_at', null)`.
- `lib/fenice-autoreply.ts` (modifica): `isSoloPresaDAtto` (pure, nuova) + il video esce insieme alla risposta del modello.
- `lib/gdo-context-note.ts` (modifica): nota di contesto per il turno in cui il video sta uscendo.
- `lib/mario-prompt.ts` (modifica): niente bivio "sposto o annullo", rilanci sulla fermezza del no, slot uno alla volta in FASE 6.
- `lib/booking-slots.ts` (modifica): `bookingSlotsContext` propone prima il giorno 1.
- `lib/video-visto.ts` (nuovo): `confermaVideoVisto` — riconoscimento testuale del FATTO, rete di sicurezza indipendente dal tag.
- `lib/gdo-video-followup.ts` (modifica): un lead che ha risposto dopo il video non riceve più solleciti automatici.

---

# BLOCCO 1 — VARIANTI CON DICHIARAZIONE

**Branch:** `git checkout main && git pull && git checkout -b feat/aperture-dichiarate`

Le 6 varianti nuove sono cloni esatti della variante 1 di ciascun funnel, con la SOLA
presentazione cambiata. L'A/B isola così esattamente il costo della dichiarazione.

### Task 1: `lib/persona.ts` — quattro varianti per funnel

**Files:**
- Modify: `lib/persona.ts`
- Test: `lib/persona.test.ts`

**Interfaces:**
- Produces:
  - `export type OpeningVariant = 1 | 2 | 3 | 4`
  - `export function variantIndexFor(conversationId: number): OpeningVariant`
  - `export function openingEnvKey(funnel: FunnelKey, variant: OpeningVariant): string`
  - `export function openingBody(funnel: FunnelKey, variant: OpeningVariant, name?: string | null): string`
  - `export const OPENING_ENV_KEYS: readonly string[]` — i 12 nomi env in ordine C1..C4, T1..T4, J1..J4
- Consumes: `templateName` da `lib/name.ts` (già importato).

- [ ] **Step 1: Aggiornare i test esistenti che assumono 2 varianti**

In `lib/persona.test.ts` sostituire l'intero blocco `describe('variantIndexFor (parità di conversationId)', ...)` (righe ~34-45) con:

```ts
describe('variantIndexFor (4 vie sul resto modulo 4)', () => {
  it('resto 1 → variante 1', () => {
    expect(variantIndexFor(1)).toBe(1);
    expect(variantIndexFor(5)).toBe(1);
    expect(variantIndexFor(1001)).toBe(1);
  });
  it('resto 2 → variante 2', () => {
    expect(variantIndexFor(2)).toBe(2);
    expect(variantIndexFor(6)).toBe(2);
    expect(variantIndexFor(1002)).toBe(2);
  });
  it('resto 3 → variante 3', () => {
    expect(variantIndexFor(3)).toBe(3);
    expect(variantIndexFor(7)).toBe(3);
    expect(variantIndexFor(1003)).toBe(3);
  });
  it('multipli di 4 → variante 4, mai 0', () => {
    expect(variantIndexFor(4)).toBe(4);
    expect(variantIndexFor(0)).toBe(4);
    expect(variantIndexFor(1000)).toBe(4);
  });
  it('distribuisce in quattro gruppi uguali su 400 id consecutivi', () => {
    const conta = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<number, number>;
    for (let id = 1; id <= 400; id++) conta[variantIndexFor(id)]++;
    expect(conta).toEqual({ 1: 100, 2: 100, 3: 100, 4: 100 });
  });
  it('nessun id produce un valore fuori da 1..4', () => {
    for (let id = 0; id < 50; id++) expect([1, 2, 3, 4]).toContain(variantIndexFor(id));
  });
});
```

- [ ] **Step 2: Aggiungere i test di `openingEnvKey` e `openingBody` per le varianti 3 e 4**

Dentro il `describe('openingEnvKey', ...)` esistente aggiungere:

```ts
  it('varianti dichiarate 3 e 4 per ogni funnel', () => {
    expect(openingEnvKey('corso10', 3)).toBe('OPENING_SID_C3');
    expect(openingEnvKey('corso10', 4)).toBe('OPENING_SID_C4');
    expect(openingEnvKey('telegram', 3)).toBe('OPENING_SID_T3');
    expect(openingEnvKey('telegram', 4)).toBe('OPENING_SID_T4');
    expect(openingEnvKey('jobsim', 3)).toBe('OPENING_SID_J3');
    expect(openingEnvKey('jobsim', 4)).toBe('OPENING_SID_J4');
    expect(openingEnvKey('other', 3)).toBe('OPENING_SID_C3');
    expect(openingEnvKey('other', 4)).toBe('OPENING_SID_C4');
  });
```

In fondo al file aggiungere un `describe` nuovo:

```ts
describe('aperture con dichiarazione IA (AI Act art. 50)', () => {
  it('C3 — assistente digitale', () => {
    expect(openingBody('corso10', 3, 'Luca')).toBe(
      "Ciao Luca, sono Marta, l'assistente digitale di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?",
    );
  });
  it('C4 — digital assistant', () => {
    expect(openingBody('corso10', 4, 'Luca')).toBe(
      'Ciao Luca, sono Marta, digital assistant di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?',
    );
  });
  it('T3 — assistente digitale', () => {
    expect(openingBody('telegram', 3, 'Luca')).toBe(
      "Ciao Luca, sono Marta, l'assistente digitale di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?",
    );
  });
  it('T4 — digital assistant', () => {
    expect(openingBody('telegram', 4, 'Luca')).toBe(
      "Ciao Luca, sono Marta, digital assistant di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?",
    );
  });
  it('J3 — assistente digitale', () => {
    expect(openingBody('jobsim', 3, 'Luca')).toBe(
      "Ciao Luca, sono Marta, l'assistente digitale di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?",
    );
  });
  it('J4 — digital assistant', () => {
    expect(openingBody('jobsim', 4, 'Luca')).toBe(
      "Ciao Luca, sono Marta, digital assistant di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?",
    );
  });

  it('3 e 4 differiscono dalla variante 1 SOLO per la presentazione', () => {
    for (const f of ['corso10', 'telegram', 'jobsim'] as FunnelKey[]) {
      const v1 = openingBody(f, 1, 'Luca');
      const coda = v1.slice(v1.indexOf('Academy.'));
      expect(openingBody(f, 3, 'Luca').endsWith(coda)).toBe(true);
      expect(openingBody(f, 4, 'Luca').endsWith(coda)).toBe(true);
    }
  });

  it('la dichiarazione è esplicita e non ammicca a un umano', () => {
    for (const f of ['corso10', 'telegram', 'jobsim'] as FunnelKey[]) {
      expect(openingBody(f, 3, 'Luca')).toContain("l'assistente digitale di Fenice Academy");
      expect(openingBody(f, 4, 'Luca')).toContain('digital assistant di Fenice Academy');
    }
  });

  it('nessuna apertura propone il passaggio a un operatore', () => {
    for (const f of ['corso10', 'telegram', 'jobsim'] as FunnelKey[]) {
      for (const v of [1, 2, 3, 4] as const) {
        expect(openingBody(f, v, 'Luca')).not.toMatch(/operatore|collega in carne/i);
      }
    }
  });
});

describe('OPENING_ENV_KEYS', () => {
  it('elenca tutte e 12 le env delle aperture', () => {
    expect(OPENING_ENV_KEYS).toEqual([
      'OPENING_SID_C1', 'OPENING_SID_C2', 'OPENING_SID_C3', 'OPENING_SID_C4',
      'OPENING_SID_T1', 'OPENING_SID_T2', 'OPENING_SID_T3', 'OPENING_SID_T4',
      'OPENING_SID_J1', 'OPENING_SID_J2', 'OPENING_SID_J3', 'OPENING_SID_J4',
    ]);
  });
  it('coincide con quello che produce openingEnvKey', () => {
    const generate = (['corso10', 'telegram', 'jobsim'] as FunnelKey[]).flatMap((f) =>
      ([1, 2, 3, 4] as const).map((v) => openingEnvKey(f, v)),
    );
    expect([...OPENING_ENV_KEYS].sort()).toEqual([...generate].sort());
  });
});
```

Aggiungere `OPENING_ENV_KEYS` all'import in cima al file di test.

Nel `describe('openingBody — testi ESATTI della spec')` esistente, il test finale che
cicla sulle varianti (righe ~118-122) usa `[1, 2] as const`: sostituirlo con
`[1, 2, 3, 4] as const`.

- [ ] **Step 3: Eseguire i test e verificare che falliscano**

Run: `npm test -- lib/persona.test.ts`
Expected: FAIL — `variantIndexFor(3)` torna 1 invece di 3, `openingEnvKey(..., 3)` non compila / non esiste, `OPENING_ENV_KEYS` non esportato.

- [ ] **Step 4: Implementare in `lib/persona.ts`**

Sostituire `variantIndexFor` (righe 21-24) con:

```ts
/** Variante A/B di un'apertura. 1 e 2 sono le storiche; 3 e 4 dichiarano l'IA
 *  (AI Act art. 50) e sono cloni della 1 con la sola presentazione cambiata. */
export type OpeningVariant = 1 | 2 | 3 | 4;

/** Assegnazione A/B per resto modulo 4 del conversationId: 1→1, 2→2, 3→3, 0→4.
 *  Il resto 0 mappa sulla QUARTA variante, non sulla prima: con `r || 4` un id
 *  multiplo di 4 finirebbe silenziosamente nel gruppo sbagliato. */
export function variantIndexFor(conversationId: number): OpeningVariant {
  const r = ((conversationId % 4) + 4) % 4;
  return (r === 0 ? 4 : r) as OpeningVariant;
}
```

Cambiare la firma di `openingEnvKey`:

```ts
export function openingEnvKey(funnel: FunnelKey, variant: OpeningVariant): string {
  return `OPENING_SID_${FUNNEL_LETTER[funnel]}${variant}`;
}

/** I nomi env di TUTTE le aperture, in un posto solo: `martaSidsFromEnv` e il cron
 *  della sequenza li leggono da qui, così una variante nuova non può restare fuori
 *  da una delle due liste (era una lista copiata a mano in tre punti). */
export const OPENING_ENV_KEYS: readonly string[] = (['C', 'T', 'J'] as const).flatMap((l) =>
  ([1, 2, 3, 4] as const).map((v) => `OPENING_SID_${l}${v}`),
);
```

Cambiare il tipo di `OPENING_TEXTS` e aggiungere le 6 varianti (i testi sono ESATTI,
copiarli senza riformattare):

```ts
const OPENING_TEXTS: Record<'C' | 'T' | 'J', Record<OpeningVariant, (n: string) => string>> = {
  C: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy: il corso di 10 ore è gratuito davvero, l'accesso ti arriva via email. Tu che obiettivo hai: un'entrata extra o un nuovo lavoro da remoto?`,
    3: (n) =>
      `Ciao ${n}, sono Marta, l'assistente digitale di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?`,
    4: (n) =>
      `Ciao ${n}, sono Marta, digital assistant di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?`,
  },
  T: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy: l'ingresso nel canale Telegram è in arrivo via email. Curiosità: hai già una professione digitale in mente o vuoi capire quale fa per te?`,
    3: (n) =>
      `Ciao ${n}, sono Marta, l'assistente digitale di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?`,
    4: (n) =>
      `Ciao ${n}, sono Marta, digital assistant di Fenice Academy. L'accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?`,
  },
  J: {
    1: (n) =>
      `Ciao ${n}, sono Marta di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?`,
    2: (n) =>
      `Ciao ${n}, Marta di Fenice Academy. Prima che il simulatore delle professioni digitali ti dia il verdetto: una professione in mente ce l'hai già o parti da zero?`,
    3: (n) =>
      `Ciao ${n}, sono Marta, l'assistente digitale di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?`,
    4: (n) =>
      `Ciao ${n}, sono Marta, digital assistant di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a cambiare lavoro?`,
  },
};
```

Aggiornare la firma di `openingBody`:

```ts
export function openingBody(funnel: FunnelKey, variant: OpeningVariant, name?: string | null): string {
```

Aggiornare il commento di testa del file: la spec dei testi 1-2 resta
`docs/superpowers/specs/2026-07-24-apertura-marta-ab-design.md`; le varianti 3-4 vengono
da questo piano.

- [ ] **Step 5: Eseguire i test**

Run: `npm test -- lib/persona.test.ts`
Expected: PASS. Poi `npm run typecheck` — deve passare: `fenice-enroll.ts` e
`sequence-touches/route.ts` passano già il risultato di `variantIndexFor` a
`openingEnvKey`/`openingBody`, quindi il tipo allargato si propaga da solo.

- [ ] **Step 6: Commit**

```bash
git add lib/persona.ts lib/persona.test.ts
git commit -m "feat(aperture): 4 varianti per funnel, le nuove dichiarano l'IA"
```

### Task 2: i SID nuovi riconosciuti come aperture Marta

Se i 6 SID non entrano nelle liste che derivano la persona, una conversazione aperta con
C3/C4/T3/T4/J3/J4 verrebbe proseguita da "Mario": il lead vedrebbe cambiare nome
all'interlocutore fra il primo e il secondo messaggio.

**Files:**
- Modify: `lib/fenice-autoreply.ts:88-100`
- Modify: `app/api/cron/sequence-touches/route.ts:~131-133`
- Test: `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Consumes: `OPENING_ENV_KEYS` da `lib/persona.ts` (Task 1).
- Produces: nessuna firma nuova — `martaSidsFromEnv(env?)` resta identica.

- [ ] **Step 1: Scrivere il test che fallisce**

In `lib/fenice-autoreply.test.ts`, dentro (o accanto a) il describe di
`martaSidsFromEnv`, aggiungere:

```ts
describe('martaSidsFromEnv — aperture dichiarate', () => {
  it('riconosce tutti e 12 i SID di apertura', () => {
    const env = Object.fromEntries(
      OPENING_ENV_KEYS.map((k, i) => [k, `SID_${i}`]),
    ) as NodeJS.ProcessEnv;
    const sids = martaSidsFromEnv(env);
    for (let i = 0; i < OPENING_ENV_KEYS.length; i++) expect(sids.has(`SID_${i}`)).toBe(true);
    expect(sids.size).toBe(12);
  });

  it('una conversazione aperta con C3 prosegue come Marta', () => {
    const env = { OPENING_SID_C3: 'HXdichiarata' } as NodeJS.ProcessEnv;
    const sids = martaSidsFromEnv(env);
    expect(
      personaForConversation(
        [{ direction: 'out', template_sid: 'HXdichiarata' }, { direction: 'in', template_sid: null }],
        sids,
      ),
    ).toBe('marta');
  });

  it('env assenti ⇒ set vuoto (nessuna regressione)', () => {
    expect(martaSidsFromEnv({} as NodeJS.ProcessEnv).size).toBe(0);
  });
});
```

Aggiungere gli import necessari in cima al file di test:
`import { OPENING_ENV_KEYS, personaForConversation } from './persona';`
(se `personaForConversation` è già importato, non duplicarlo).

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/fenice-autoreply.test.ts -t "aperture dichiarate"`
Expected: FAIL — `sids.size` è 2 (solo C1/C2 fra i 12), C3 non riconosciuto.

- [ ] **Step 3: Implementare**

In `lib/fenice-autoreply.ts` aggiungere `OPENING_ENV_KEYS` all'import da `./persona`
(riga 12) e sostituire il corpo di `martaSidsFromEnv` (righe 90-100):

```ts
export function martaSidsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const keys = [
    ...OPENING_ENV_KEYS,
    'MARTA_SEQ_TEMPLATE_SID_1', 'MARTA_SEQ_TEMPLATE_SID_2',
    'MARTA_SEQ_TEMPLATE_SID_3', 'MARTA_SEQ_TEMPLATE_SID_4',
    'MARTA_REENGAGE_TEMPLATE_SID',
  ];
  return new Set(keys.map((k) => env[k]).filter((v): v is string => !!v));
}
```

In `app/api/cron/sequence-touches/route.ts` sostituire (righe ~131-133):

```ts
  const martaOpeningSids = ['C1', 'C2', 'T1', 'T2', 'J1', 'J2'].map(
    (k) => process.env[`OPENING_SID_${k}`],
  );
```

con:

```ts
  const martaOpeningSids = OPENING_ENV_KEYS.map((k) => process.env[k]);
```

e aggiungere `OPENING_ENV_KEYS` all'import da `@/lib/persona` (righe 20-24).

- [ ] **Step 4: Eseguire i test**

Run: `npm test && npm run typecheck && npm run lint`
Expected: tutto verde.

- [ ] **Step 5: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts app/api/cron/sequence-touches/route.ts
git commit -m "feat(aperture): i SID delle varianti dichiarate contano come aperture Marta"
```

### Task 3: script Twilio gemello + report A/B

**Files:**
- Create: `scripts/create-marta-openings-dichiarate.mjs`
- Modify: `scripts/ab-report.mjs`

**Interfaces:**
- Nessuna: sono script standalone, non importati dall'app. Non hanno test unitari (fanno
  solo I/O verso Twilio e Supabase); la verifica è l'esecuzione manuale descritta sotto.

- [ ] **Step 1: Creare lo script dei template**

Uno script NUOVO e non un'estensione di `create-marta-templates.mjs`: rieseguire quello
esistente ricreerebbe da capo gli 11 template già approvati, con nomi duplicati su Meta.

Create `scripts/create-marta-openings-dichiarate.mjs`:

```js
// Crea i 6 template di apertura che DICHIARANO l'IA (AI Act art. 50, in vigore dal
// 2/8/2026) via Twilio Content API e li sottomette all'approvazione WhatsApp.
// Gemello di create-marta-templates.mjs: quello crea gli 11 template storici, questo
// SOLO i sei nuovi — rieseguire il primo duplicherebbe roba già approvata.
// Uso: node scripts/create-marta-openings-dichiarate.mjs
//      (richiede TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in env)
// I SID stampati vanno messi in env come OPENING_SID_C3/C4/T3/T4/J3/J4.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

// Cloni delle varianti 1, con la SOLA presentazione cambiata: l'A/B isola così
// esattamente il costo della dichiarazione. Testi allineati a lib/persona.ts.
const TEMPLATES = [
  { key: 'OPENING_SID_C3', name: 'fenice_open_c3_marta_ia_v1', body: 'Ciao {{1}}, sono Marta, l’assistente digitale di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?' },
  { key: 'OPENING_SID_C4', name: 'fenice_open_c4_marta_ia_v1', body: 'Ciao {{1}}, sono Marta, digital assistant di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?' },
  { key: 'OPENING_SID_T3', name: 'fenice_open_t3_marta_ia_v1', body: 'Ciao {{1}}, sono Marta, l’assistente digitale di Fenice Academy. L’accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un’entrata extra o cambiare proprio lavoro?' },
  { key: 'OPENING_SID_T4', name: 'fenice_open_t4_marta_ia_v1', body: 'Ciao {{1}}, sono Marta, digital assistant di Fenice Academy. L’accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un’entrata extra o cambiare proprio lavoro?' },
  { key: 'OPENING_SID_J3', name: 'fenice_open_j3_marta_ia_v1', body: 'Ciao {{1}}, sono Marta, l’assistente digitale di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un’entrata extra o a cambiare lavoro?' },
  { key: 'OPENING_SID_J4', name: 'fenice_open_j4_marta_ia_v1', body: 'Ciao {{1}}, sono Marta, digital assistant di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un’entrata extra o a cambiare lavoro?' },
];

for (const t of TEMPLATES) {
  const createRes = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      friendly_name: t.name,
      language: 'it',
      variables: { '1': 'Nome' },
      types: { 'twilio/text': { body: t.body } },
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    console.error(t.name, 'CREATE FAILED', createRes.status, JSON.stringify(created).slice(0, 300));
    continue;
  }
  const approvalRes = await fetch(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: t.name, category: 'MARKETING' }),
  });
  const approval = await approvalRes.json();
  console.log(`${t.key}=${created.sid}`, '| approval:', approvalRes.ok ? (approval.whatsapp?.status ?? 'submitted') : 'FAILED ' + JSON.stringify(approval).slice(0, 200));
}
console.log('\nStato approvazioni: node scripts/check-sequence-templates.mjs');
```

Nota sugli apostrofi: nei body dei template si usa `’` (tipografico) come negli 11
template già approvati, mentre `lib/persona.ts` usa `'` dritto come i suoi vicini. È la
convenzione già in vigore nel repo e non cambia il testo che il lead vede.

- [ ] **Step 2: Verificare che lo script sia sintatticamente valido senza chiamare Twilio**

Run: `node --check scripts/create-marta-openings-dichiarate.mjs`
Expected: nessun output, exit 0.

- [ ] **Step 3: Aggiungere le 6 label a `scripts/ab-report.mjs`**

Sostituire la costante `OPENINGS` (righe 21-29) con:

```js
const OPENINGS = [
  { label: 'legacy-mario', env: 'FENICE_OPENING_TEMPLATE_SID', legacy: true },
  { label: 'C1', env: 'OPENING_SID_C1' },
  { label: 'C2', env: 'OPENING_SID_C2' },
  { label: 'C3', env: 'OPENING_SID_C3', dichiarata: true },
  { label: 'C4', env: 'OPENING_SID_C4', dichiarata: true },
  { label: 'T1', env: 'OPENING_SID_T1' },
  { label: 'T2', env: 'OPENING_SID_T2' },
  { label: 'T3', env: 'OPENING_SID_T3', dichiarata: true },
  { label: 'T4', env: 'OPENING_SID_T4', dichiarata: true },
  { label: 'J1', env: 'OPENING_SID_J1' },
  { label: 'J2', env: 'OPENING_SID_J2' },
  { label: 'J3', env: 'OPENING_SID_J3', dichiarata: true },
  { label: 'J4', env: 'OPENING_SID_J4', dichiarata: true },
];
```

Nel blocco di aggregazione (righe 113-122) aggiungere due totali. Sostituire:

```js
const total = emptyStats();
const legacyTot = emptyStats();
const newTot = emptyStats();
for (const o of active) {
  const s = bySid.get(process.env[o.env]);
  rows.push(row(o.label, s));
  addInto(total, s);
  addInto(o.legacy ? legacyTot : newTot, s);
}
```

con:

```js
const total = emptyStats();
const legacyTot = emptyStats();
const newTot = emptyStats();
// Il confronto che serve per l'AI Act: stessa apertura, sola presentazione diversa.
const dichiarateTot = emptyStats();
const nonDichiarateTot = emptyStats();
for (const o of active) {
  const s = bySid.get(process.env[o.env]);
  rows.push(row(o.label, s));
  addInto(total, s);
  addInto(o.legacy ? legacyTot : newTot, s);
  if (!o.legacy) addInto(o.dichiarata ? dichiarateTot : nonDichiarateTot, s);
}
```

In fondo al file, dopo le due righe di confronto esistenti, aggiungere:

```js
console.log('\nCosto della dichiarazione IA (solo aperture Marta):');
console.log('  risposta <=72h: non dichiarate ' + pct(nonDichiarateTot.replied72, nonDichiarateTot.n) + ` (${nonDichiarateTot.replied72}/${nonDichiarateTot.n})` +
  ' vs dichiarate ' + pct(dichiarateTot.replied72, dichiarateTot.n) + ` (${dichiarateTot.replied72}/${dichiarateTot.n})`);
console.log('  appuntamenti:   non dichiarate ' + pct(nonDichiarateTot.appuntamento, nonDichiarateTot.n) + ` (${nonDichiarateTot.appuntamento}/${nonDichiarateTot.n})` +
  ' vs dichiarate ' + pct(dichiarateTot.appuntamento, dichiarateTot.n) + ` (${dichiarateTot.appuntamento}/${dichiarateTot.n})`);
```

- [ ] **Step 4: Verificare**

Run: `node --check scripts/ab-report.mjs && npm test && npm run lint`
Expected: tutto verde. (Lo script legge il DB: con le env di produzione a disposizione
si può lanciare `node scripts/ab-report.mjs` — le sei nuove label compariranno come
"saltata (OPENING_SID_C3 non in env)" finché i SID non sono configurati, ed è il
comportamento atteso.)

- [ ] **Step 5: Commit**

```bash
git add scripts/create-marta-openings-dichiarate.mjs scripts/ab-report.mjs
git commit -m "feat(aperture): script template dichiarati + confronto A/B sulla dichiarazione"
```

### Task 4: chiusura del Blocco 1

- [ ] **Step 1: Suite completa**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: tutto verde.

- [ ] **Step 2: Merge su main**

```bash
git checkout main
git merge --no-ff feat/aperture-dichiarate -m "merge feat/aperture-dichiarate: il bot si dichiara IA in apertura (AI Act art. 50)"
```

- [ ] **Step 3: Consegnare a Bruno il passo manuale**

Il deploy NON attiva niente da solo: le varianti 3 e 4 partono solo quando le env
`OPENING_SID_C3/C4/T3/T4/J3/J4` sono valorizzate su Vercel. Sequenza da comunicare:
1. `node scripts/create-marta-openings-dichiarate.mjs` con le credenziali Twilio;
2. attesa approvazione Meta (`node scripts/check-sequence-templates.mjs`);
3. le sei env su Vercel (production);
4. da quel momento un quarto dei lead nuovi riceve C3, un quarto C4.

Finché le env mancano, `fenice-enroll.ts` logga `opening_config_error` e ricade
sull'apertura legacy: nessun lead resta senza apertura.

---

# BLOCCO 2 — STOP ALLE DATE INVENTATE

**Branch:** `git checkout main && git checkout -b fix/date-inventate`

Il problema misurato: su 26 esiti RICHIAMO, 22 hanno un'ora tonda che nessun lead ha mai
detto (09:00 ×9, 10:00 ×6, 12:00 ×4, 15:00 ×3) e uno ha una data nel passato
(27/01/2026, conv 3369). La causa non è un bug: è che `bot-contract.ts` esige una data
ISO per RICHIAMO e il prompt autorizza a dedurla ("la data ISO se te l'ha data,
ALTRIMENTI la data dell'appuntamento"). Su "ci risentiamo a settembre" il modello non ha
nessun modo legale di dire "settembre, giorno da definire" — quindi inventa.

Si interviene su tre livelli: si dà al modello un modo legale di dire "non so quando"
(il tag accetta le parole del lead), gli si toglie il permesso di dedurre (prompt), e si
mette una rete sotto (guardia di plausibilità prima del POST al CRM).

### Task 5: il tag RICHIAMO accetta le parole del lead

**Files:**
- Modify: `lib/mario.ts` (`parseMarioReply`)
- Test: `lib/mario-parse.test.ts`

**Interfaces:**
- Consumes: `isoWithOffset` da `lib/bot-contract.ts` (già esistente, esportata).
- Produces: `parseMarioReply` invariata nella firma. Cambia il contenuto di
  `MarioResult` per RICHIAMO: `scheduledAt` valorizzato SOLO se l'argomento è una data
  ISO 8601 con fuso; altrimenti l'argomento finisce in `note` e `scheduledAt` resta
  `undefined`.

- [ ] **Step 1: Scrivere i test che falliscono**

In `lib/mario-parse.test.ts` aggiungere:

```ts
describe('[ESITO:RICHIAMO] — data solo se il lead l\'ha detta', () => {
  it('data ISO valida → scheduledAt, niente note', () => {
    const r = parseMarioReply('ok ci sentiamo allora [ESITO:RICHIAMO|2026-09-01T10:00:00+02:00]');
    expect(r.outcome).toBe('RICHIAMO');
    expect(r.scheduledAt).toBe('2026-09-01T10:00:00+02:00');
    expect(r.note).toBeUndefined();
  });

  it('parole del lead al posto della data → note, scheduledAt vuoto', () => {
    const r = parseMarioReply('va bene dai [ESITO:RICHIAMO|a settembre, giorno da definire]');
    expect(r.outcome).toBe('RICHIAMO');
    expect(r.scheduledAt).toBeUndefined();
    expect(r.note).toBe('a settembre, giorno da definire');
  });

  it('una data senza fuso non è una data: finisce nelle parole', () => {
    const r = parseMarioReply('[ESITO:RICHIAMO|2026-09-01 10:00]');
    expect(r.scheduledAt).toBeUndefined();
    expect(r.note).toBe('2026-09-01 10:00');
  });

  it('argomento vuoto: né data né note', () => {
    const r = parseMarioReply('[ESITO:RICHIAMO|]');
    expect(r.outcome).toBe('RICHIAMO');
    expect(r.scheduledAt).toBeUndefined();
    expect(r.note).toBeUndefined();
  });

  it('il tag resta invisibile al lead', () => {
    const r = parseMarioReply('ci risentiamo a settembre allora [ESITO:RICHIAMO|a settembre]');
    expect(r.visibleReply).not.toContain('ESITO');
    expect(r.visibleReply).toContain('ci risentiamo a settembre');
  });

  it('APPUNTAMENTO non cambia comportamento', () => {
    const r = parseMarioReply('[ESITO:APPUNTAMENTO|2026-08-07T15:00:00+02:00]');
    expect(r.outcome).toBe('APPUNTAMENTO');
    expect(r.scheduledAt).toBe('2026-08-07T15:00:00+02:00');
    expect(r.appointmentFixed).toBe(true);
  });
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `npm test -- lib/mario-parse.test.ts -t "data solo se il lead"`
Expected: FAIL — oggi `scheduledAt` vale `'a settembre, giorno da definire'` e `note`
è `undefined`.

- [ ] **Step 3: Implementare in `lib/mario.ts`**

Aggiungere l'import in cima:

```ts
import { isoWithOffset } from './bot-contract';
```

Sostituire il ramo RICHIAMO dentro `parseMarioReply` (riga 40):

```ts
    else if (kind === 'RICHIAMO') {
      outcome = 'RICHIAMO';
      // Il modello può mettere qui una data SOLO se gliel'ha detta il lead; quando il
      // lead dice "a settembre" mette le sue parole. Un argomento che non è una data
      // ISO con fuso NON diventa un istante: sarebbe un'ora inventata, ed è esattamente
      // quello che per mesi è finito in agenda ai commerciali (22 richiami su 26 su
      // un'ora tonda che nessuno aveva detto).
      if (arg && isoWithOffset(arg)) scheduledAt = arg;
      else note = arg || undefined;
    }
```

- [ ] **Step 4: Eseguire i test**

Run: `npm test -- lib/mario-parse.test.ts && npm test`
Expected: PASS. Attenzione: qualche test esistente potrebbe assumere che l'argomento
finisca sempre in `scheduledAt` — se fallisce, va aggiornato all'aspettativa nuova, non
aggirato.

- [ ] **Step 5: Commit**

```bash
git add lib/mario.ts lib/mario-parse.test.ts
git commit -m "fix(bot): il tag RICHIAMO accetta le parole del lead invece di una data finta"
```

### Task 6: guardia di plausibilità prima del POST al CRM

**Files:**
- Modify: `lib/bot-outcome-rules.ts`
- Test: `lib/bot-outcome-rules.test.ts`

**Interfaces:**
- Produces:
  - `export const RICHIAMO_ORIZZONTE_MS: number`
  - `export type MotivoDataNonUsabile = 'assente' | 'illeggibile' | 'passato' | 'oltre_orizzonte'`
  - `export type RichiamoCheck = { ok: true } | { ok: false; motivo: MotivoDataNonUsabile }`
  - `export function checkDataRichiamo(date: string | undefined, nowMs: number): RichiamoCheck`
  - `export function buildRichiamoSenzaDataNote(input: { motivo: MotivoDataNonUsabile; leadWords?: string }): string`

- [ ] **Step 1: Scrivere i test che falliscono**

In `lib/bot-outcome-rules.test.ts` aggiungere:

```ts
describe('checkDataRichiamo', () => {
  const now = Date.parse('2026-08-06T12:00:00+02:00');

  it('data futura entro l\'orizzonte → ok', () => {
    expect(checkDataRichiamo('2026-08-20T10:00:00+02:00', now)).toEqual({ ok: true });
    expect(checkDataRichiamo('2026-09-01T10:00:00+02:00', now)).toEqual({ ok: true });
  });

  it('data assente → assente', () => {
    expect(checkDataRichiamo(undefined, now)).toEqual({ ok: false, motivo: 'assente' });
    expect(checkDataRichiamo('', now)).toEqual({ ok: false, motivo: 'assente' });
  });

  it('data illeggibile → illeggibile', () => {
    expect(checkDataRichiamo('a settembre', now)).toEqual({ ok: false, motivo: 'illeggibile' });
    expect(checkDataRichiamo('2026-13-45T99:00:00+02:00', now)).toEqual({ ok: false, motivo: 'illeggibile' });
  });

  it('data nel passato → passato (caso reale conv 3369: 27/01/2026)', () => {
    expect(checkDataRichiamo('2026-01-27T09:00:00+01:00', now)).toEqual({ ok: false, motivo: 'passato' });
    expect(checkDataRichiamo('2026-08-06T11:59:00+02:00', now)).toEqual({ ok: false, motivo: 'passato' });
  });

  it('oltre ~6 mesi → oltre_orizzonte', () => {
    expect(checkDataRichiamo('2028-08-06T10:00:00+02:00', now)).toEqual({ ok: false, motivo: 'oltre_orizzonte' });
    expect(checkDataRichiamo('2027-08-06T10:00:00+02:00', now)).toEqual({ ok: false, motivo: 'oltre_orizzonte' });
  });

  it('il confine dell\'orizzonte è incluso', () => {
    const limite = new Date(now + RICHIAMO_ORIZZONTE_MS).toISOString();
    expect(checkDataRichiamo(limite, now)).toEqual({ ok: true });
    const oltre = new Date(now + RICHIAMO_ORIZZONTE_MS + 60_000).toISOString();
    expect(checkDataRichiamo(oltre, now)).toEqual({ ok: false, motivo: 'oltre_orizzonte' });
  });
});

describe('buildRichiamoSenzaDataNote', () => {
  it('riporta le parole letterali del lead', () => {
    const n = buildRichiamoSenzaDataNote({ motivo: 'illeggibile', leadWords: 'ci risentiamo a settembre' });
    expect(n).toContain('"ci risentiamo a settembre"');
    expect(n).toContain('da concordare');
  });

  it('senza parole del lead resta una nota sensata', () => {
    const n = buildRichiamoSenzaDataNote({ motivo: 'assente' });
    expect(n).toContain('non ha indicato quando');
    expect(n).not.toContain('""');
  });

  it('distingue la data nel passato da quella assente', () => {
    expect(buildRichiamoSenzaDataNote({ motivo: 'passato' })).toContain('nel passato');
    expect(buildRichiamoSenzaDataNote({ motivo: 'oltre_orizzonte' })).toContain('troppo lontana');
  });

  it('non contiene mai una data: è proprio quella che non ci fidiamo a mandare', () => {
    for (const motivo of ['assente', 'illeggibile', 'passato', 'oltre_orizzonte'] as const) {
      expect(buildRichiamoSenzaDataNote({ motivo, leadWords: 'boh' })).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});
```

Aggiungere gli import in cima al file di test:
`checkDataRichiamo, buildRichiamoSenzaDataNote, RICHIAMO_ORIZZONTE_MS`.

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `npm test -- lib/bot-outcome-rules.test.ts`
Expected: FAIL — le funzioni non esistono.

- [ ] **Step 3: Implementare in `lib/bot-outcome-rules.ts`**

Aggiungere in fondo al file:

```ts
/**
 * Oltre questo orizzonte una data di richiamo non è più un appuntamento telefonico: è
 * un numero che il modello ha tirato fuori da "più avanti". ~6 mesi.
 */
export const RICHIAMO_ORIZZONTE_MS = 183 * 24 * 3600_000;

export type MotivoDataNonUsabile = 'assente' | 'illeggibile' | 'passato' | 'oltre_orizzonte';
export type RichiamoCheck = { ok: true } | { ok: false; motivo: MotivoDataNonUsabile };

/**
 * La data di un RICHIAMO è utilizzabile? `isoWithOffset` valida il FORMATO; qui si
 * guarda la plausibilità, che è la cosa che mancava: una data nel passato o a due anni
 * da oggi passa il formato e finisce in agenda a un commerciale.
 */
export function checkDataRichiamo(date: string | undefined, nowMs: number): RichiamoCheck {
  if (!date || !date.trim()) return { ok: false, motivo: 'assente' };
  const t = Date.parse(date);
  if (Number.isNaN(t)) return { ok: false, motivo: 'illeggibile' };
  if (t < nowMs) return { ok: false, motivo: 'passato' };
  if (t - nowMs > RICHIAMO_ORIZZONTE_MS) return { ok: false, motivo: 'oltre_orizzonte' };
  return { ok: true };
}

const DETTAGLIO_MOTIVO: Record<MotivoDataNonUsabile, string> = {
  assente: 'ma non ha indicato quando',
  illeggibile: 'ma non ha indicato quando in modo utilizzabile',
  passato: 'ma la data raccolta è nel passato e non è utilizzabile',
  oltre_orizzonte: 'ma la data raccolta è troppo lontana per essere quella vera',
};

/**
 * La nota che parte al posto di un RICHIAMO con una data che non ci fidiamo a mandare.
 * Nessuna data dentro, di proposito: si riportano le parole del lead e si dice
 * esplicitamente che giorno e ora sono da concordare. La data scartata viaggia
 * nell'event_log, dove serve a noi e non confonde il commerciale.
 */
export function buildRichiamoSenzaDataNote(input: {
  motivo: MotivoDataNonUsabile;
  leadWords?: string;
}): string {
  const parole = input.leadWords?.trim();
  const citazione = parole ? ` Parole del lead: "${parole}".` : '';
  return (
    `Il lead ha chiesto di essere ricontattato ${DETTAGLIO_MOTIVO[input.motivo]}. ` +
    `Da richiamare, giorno e ora da concordare.${citazione}`
  );
}
```

- [ ] **Step 4: Eseguire i test**

Run: `npm test -- lib/bot-outcome-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bot-outcome-rules.ts lib/bot-outcome-rules.test.ts
git commit -m "feat(bot): guardia di plausibilita sulla data di RICHIAMO"
```

### Task 7: la guardia entra in `sendOutcome`

**Files:**
- Modify: `lib/bot-outcome.ts`
- Modify: `lib/fenice-autoreply.ts` (il drain non deve chiudere la conversazione)
- Test: `lib/bot-outcome.test.ts`

**Interfaces:**
- Consumes: `checkDataRichiamo`, `buildRichiamoSenzaDataNote` (Task 6).
- Produces: il tipo di ritorno di `sendOutcome` guadagna un campo opzionale:
  `Promise<{ sent: boolean; status?: number; error?: string; keepOpen?: true }>`.
  `keepOpen: true` significa "il CRM è stato informato, ma la conversazione NON è
  esitata: chi chiama non deve chiuderla".

- [ ] **Step 1: Scrivere i test che falliscono**

In `lib/bot-outcome.test.ts`, usando l'helper `makeSupabase(convRow, opts)` già presente
nel file (torna `{ supabase, calls }` con `calls.updates` e `calls.events`; `fetch` è
già stubbato globalmente nel `beforeEach`), aggiungere:

```ts
describe('sendOutcome — RICHIAMO con data non utilizzabile', () => {
  const attivo = { crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null };
  const bodyInviato = () => JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);

  it('parte come NOTA con le parole del lead, mai come RICHIAMO con data', async () => {
    const { supabase } = makeSupabase(attivo);
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', note: 'ci risentiamo a settembre' });

    const body = bodyInviato();
    expect(body.outcome).toBe('NOTA');
    expect(body.date).toBeUndefined();
    expect(body.note).toContain('"ci risentiamo a settembre"');
    expect(res.sent).toBe(true);
    expect(res.keepOpen).toBe(true);
  });

  it('una data nel passato non arriva mai al CRM (caso conv 3369)', async () => {
    const { supabase } = makeSupabase(attivo);
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-01-27T09:00:00+01:00' });
    const body = bodyInviato();
    expect(body.outcome).toBe('NOTA');
    expect(JSON.stringify(body)).not.toContain('2026-01-27');
  });

  it('una data a due anni non arriva mai al CRM', async () => {
    const { supabase } = makeSupabase(attivo);
    const fra2anni = new Date(Date.now() + 730 * 86400_000).toISOString();
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: fra2anni });
    expect(bodyInviato().outcome).toBe('NOTA');
  });

  it('non tocca bot_outcome né ai_status: la conversazione resta lavorabile', async () => {
    const { supabase, calls } = makeSupabase(attivo);
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', note: 'più avanti' });
    for (const u of calls.updates) {
      expect(u).not.toHaveProperty('bot_outcome');
      expect(u).not.toHaveProperty('ai_status');
    }
  });

  it('una data valida detta dal lead passa intatta come RICHIAMO', async () => {
    const { supabase } = makeSupabase(attivo);
    const fra7giorni = new Date(Date.now() + 7 * 86400_000).toISOString();
    const res = await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: fra7giorni });
    const body = bodyInviato();
    expect(body.outcome).toBe('RICHIAMO');
    expect(body.date).toBe(fra7giorni);
    expect(res.keepOpen).toBeUndefined();
  });

  it('registra l\'evento con la data scartata, per poterla ritrovare', async () => {
    const { supabase, calls } = makeSupabase(attivo);
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', date: '2026-01-27T09:00:00+01:00' });
    const ev = calls.events.find((e: any) => e.type === 'richiamo_senza_data');
    expect(ev).toBeTruthy();
    expect(ev.payload.dataScartata).toBe('2026-01-27T09:00:00+01:00');
    expect(ev.payload.motivo).toBe('passato');
  });
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `npm test -- lib/bot-outcome.test.ts -t "data non utilizzabile"`
Expected: FAIL — oggi il body parte con `outcome: 'RICHIAMO'` e `date` valorizzata.

- [ ] **Step 3: Implementare in `lib/bot-outcome.ts`**

Estendere l'import da `./bot-outcome-rules` (riga 4):

```ts
import {
  buildLockedNote,
  buildRichiamoSenzaDataNote,
  checkDataRichiamo,
  resolveOutcomeAction,
} from './bot-outcome-rules';
```

Cambiare la firma di ritorno di `sendOutcome`:

```ts
export async function sendOutcome(
  supabase: Supa,
  conversationId: number,
  args: SendOutcomeArgs,
  opts: SendOutcomeOpts = {},
): Promise<{ sent: boolean; status?: number; error?: string; keepOpen?: true }> {
```

Subito dopo il controllo `if (opts.noteOnly === true) { ... }` (riga 149-151), aggiungere
il ramo nuovo:

```ts
  // Un RICHIAMO senza una data che regga non è un richiamo: è un'ora inventata che
  // finisce in agenda a un commerciale. Al CRM va una nota con le parole del lead, e
  // la conversazione resta aperta — il bot deve poter ancora chiedere quando.
  const dataCheck = args.outcome === 'RICHIAMO' ? checkDataRichiamo(args.date, Date.now()) : { ok: true as const };
  if (!dataCheck.ok) {
    const note = buildRichiamoSenzaDataNote({ motivo: dataCheck.motivo, leadWords: args.note });
    await supabase.from('event_log').insert({
      type: 'richiamo_senza_data',
      payload: { conversationId, crmLeadId, motivo: dataCheck.motivo, dataScartata: args.date ?? null, note } as never,
      message: `[bot-fissatore] RICHIAMO senza data utilizzabile (${dataCheck.motivo}) per lead ${crmLeadId}: inviato come nota`,
      level: 'warn',
    });
    const esito = await inviaNotaAlCrm(supabase, conversationId, crmLeadId, note, args.report, secret);
    return { ...esito, keepOpen: true };
  }
```

Serve un piccolo helper condiviso: il POST di una NOTA al CRM esiste già dentro
`sendCrmNoteOnly` ma è intrecciato con la dedup e con i log del canale GDO. Estrarre la
parte di rete in una funzione locale (sopra `sendCrmNoteOnly`) e farla usare da entrambi:

```ts
/** POST di una NOTA al CRM. Solo rete e log: nessuna decisione, nessuno stato locale. */
async function inviaNotaAlCrm(
  supabase: Supa,
  conversationId: number,
  crmLeadId: string,
  note: string,
  report: BotReport | undefined,
  secret: string,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  const body: BotOutcomeBody = { leadId: crmLeadId, outcome: 'NOTA', note, ...(report ? { report } : {}) };
  const valid = validateOutcomeBody(body);
  if (!valid.ok) {
    await supabase.from('event_log').insert({
      type: 'bot_outcome_error',
      payload: { conversationId, crmLeadId, reason: valid.reason } as never,
      message: `[bot-fissatore] nota non valida per lead ${crmLeadId}: ${valid.reason}`,
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
    if (res.ok) return { sent: true, status: res.status };
    const text = await res.text().catch(() => '');
    return { sent: false, status: res.status, error: text || `http_${res.status}` };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : 'errore' };
  }
}
```

Non riscrivere `sendCrmNoteOnly` in questo task: lascialo com'è (i suoi log GDO sono
specifici). L'helper serve al ramo nuovo.

- [ ] **Step 4: Il drain non chiude la conversazione**

In `lib/fenice-autoreply.ts`, riga ~452, sostituire:

```ts
          if (!postino && (sent.sent || sent.error === 'note_duplicate')) finalStatus = 'closed';
```

con:

```ts
          // `keepOpen`: il CRM è stato informato con una nota (RICHIAMO senza una data
          // utilizzabile) ma la conversazione NON è esitata — il bot deve poter ancora
          // chiedere al lead quando gli va bene, invece di sparire.
          if (!postino && !sent.keepOpen && (sent.sent || sent.error === 'note_duplicate')) {
            finalStatus = 'closed';
          }
          break;
```

Attenzione: il `break` esistente subito sotto va tenuto (nel caso `keepOpen` il turno
è comunque finito: il messaggio al lead è già partito).

- [ ] **Step 5: Eseguire i test**

Run: `npm test && npm run typecheck && npm run lint`
Expected: tutto verde.

- [ ] **Step 6: Commit**

```bash
git add lib/bot-outcome.ts lib/bot-outcome.test.ts lib/fenice-autoreply.ts
git commit -m "fix(bot): un richiamo senza data vera parte come nota, non come appuntamento inventato"
```

### Task 8: il prompt non deduce più le date

**Files:**
- Modify: `lib/mario-prompt.ts`
- Test: `lib/mario-prompt.test.ts`

**Interfaces:** nessuna firma cambia. `buildMarioSystem(personaName)` resta identica.

- [ ] **Step 1: Scrivere i test che falliscono**

In `lib/mario-prompt.test.ts` aggiungere:

```ts
describe('date del richiamo — mai dedotte', () => {
  const p = buildMarioSystem('Marta');

  it('non autorizza più a usare la data dell\'appuntamento come ripiego', () => {
    expect(p).not.toContain('altrimenti la data dell\'appuntamento');
  });

  it('vieta esplicitamente di inventare giorno e ora', () => {
    expect(p).toContain('MAI INVENTARE UNA DATA');
  });

  it('dice di chiedere giorno e fascia oraria quando il lead non li dice', () => {
    expect(p).toMatch(/chiedigli.*che giorno/i);
  });

  it('permette di mettere nel tag le parole del lead al posto della data', () => {
    expect(p).toContain('le sue parole testuali');
  });

  it('senza una data detta dal lead la conversazione resta aperta', () => {
    expect(p).toContain('non emettere nessun tag');
  });
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `npm test -- lib/mario-prompt.test.ts -t "mai dedotte"`
Expected: FAIL.

- [ ] **Step 3: Implementare in `lib/mario-prompt.ts`**

Sostituire la riga del tag RICHIAMO nella sezione finale dei tag (riga 308):

```
- Vuole essere richiamato in un momento preciso: [ESITO:RICHIAMO|<data ISO 8601 con fuso>]
```

con:

```
- Vuole essere richiamato: [ESITO:RICHIAMO|<la data ISO 8601 con fuso SOLO se te l'ha detta lui, altrimenti le sue parole testuali sul quando, es. "a settembre">]
```

Sostituire il blocco "Regole sui tag" (riga 311) con:

```
Regole sui tag: usa SEMPRE la data assoluta con fuso orario (mai "domani"); calcola la data dall'ora attuale che ti viene fornita; un solo tag per messaggio; il tag va alla fine, dopo il testo normale.
MAI INVENTARE UNA DATA. Giorno e ora di un richiamo li dice il lead, non li scegli tu: niente ore tonde di comodo, niente data dell'appuntamento riciclata, niente date dedotte da "a settembre" o "tra un mese". Se il lead vuole rimandare senza dirti quando, chiedigli tu che giorno e che fascia oraria gli vanno bene, con una domanda sola. Finché non te l'ha detto non emettere nessun tag: la conversazione resta aperta e ci riprovi al messaggio dopo. Se invece te l'ha detto a modo suo e non riesci a ricavarne una data precisa ("a settembre", "dopo le ferie"), metti nel tag le sue parole testuali invece di una data: è ammesso, inventare no.
```

Nella sezione "SE L'APPUNTAMENTO È GIÀ FISSATO" (riga 262) sostituire:

```
[ESITO:RICHIAMO|<data ISO se te l'ha data, altrimenti la data dell'appuntamento>]
```

con:

```
[ESITO:RICHIAMO|<data ISO se te l'ha data, altrimenti le sue parole testuali sul quando>]
```

Nella sezione ECCEZIONE finale (riga 313), sostituire l'ultima frase:

```
Qui la regola "nel dubbio NON chiudere" NON vale: l'appuntamento è già fissato, quindi chiudi comunque con un tag.
```

con:

```
Qui la regola "nel dubbio NON chiudere" NON vale: l'appuntamento è già fissato, quindi quando ti fermi chiudi comunque con un tag. Il tag però esce quando ti fermi, non prima: finché stai ancora gestendo l'obiezione o hai appena chiesto quando gli verrebbe meglio, aspetta la sua risposta.
```

- [ ] **Step 4: Eseguire i test**

Run: `npm test -- lib/mario-prompt.test.ts && npm test`
Expected: PASS. Il test invariante "cambia SOLO il nome" deve restare verde: non
introdurre mai le stringhe "Mario"/"Marta" nel testo nuovo.

- [ ] **Step 5: Commit**

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "fix(prompt): via il permesso di dedurre una data di richiamo"
```

### Task 9: chiusura del Blocco 2

- [ ] **Step 1: Suite completa**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

- [ ] **Step 2: Merge**

```bash
git checkout main
git merge --no-ff fix/date-inventate -m "merge fix/date-inventate: il bot non manda piu' al CRM date che nessuno ha detto"
```

---

# BLOCCO 3 — PACCHETTO POST-FISSAGGIO

**Branch:** `git checkout main && git checkout -b feat/pacchetto-post-fissaggio`

### Task 10: marcatore di disdetta (migration + colonna)

Oggi `precall-reminders` seleziona su `bot_outcome = 'APPUNTAMENTO'` e basta. Siccome
l'appuntamento è terminale e la disdetta resta solo una nota, il promemoria parte lo
stesso: 10 casi su 23 misurati, con lead che rispondono "avevo chiesto di rimandare".
Serve un marcatore che spenga gli automatismi SENZA declassare `bot_outcome`.

**Files:**
- Create: `supabase/migrations/20260806000001_cancel_requested_at.sql`
- Modify: `lib/supabase/types.ts`
- Modify: `lib/bot-outcome-rules.ts`
- Modify: `lib/bot-outcome.ts`
- Test: `lib/bot-outcome-rules.test.ts`, `lib/bot-outcome.test.ts`

**Interfaces:**
- Produces: `export function isRichiestaDisdetta(outcome: BotOutcome): boolean` — vero
  per `'DA_SCARTARE'` e `'RICHIAMO'`, cioè i due esiti che su un appuntamento già
  fissato significano "voglio annullare" o "voglio spostare".
- Produces: colonna `conversations.cancel_requested_at timestamptz`.

- [ ] **Step 1: Scrivere la migration**

Create `supabase/migrations/20260806000001_cancel_requested_at.sql`:

```sql
-- Marcatore di disdetta: valorizzato quando un lead con appuntamento GIÀ fissato
-- chiede di annullare o spostare. Serve a spegnere gli automatismi (promemoria
-- pre-call, solleciti video ai lead GDO), che oggi partono lo stesso perché
-- bot_outcome resta 'APPUNTAMENTO' e la disdetta è solo una nota al CRM:
-- 10 casi su 23 misurati il 04/08/2026, con lead che rispondono "avevo chiesto di
-- rimandare".
--
-- Colonna dedicata e NON un valore di bot_outcome: l'appuntamento resta terminale,
-- non si declassa mai (vedi resolveOutcomeAction). Qui si registra solo che il lead
-- l'ha chiesto — se poi il commerciale lo sistema, l'appuntamento è sempre quello.
alter table conversations add column if not exists cancel_requested_at timestamptz;

create index if not exists conversations_cancel_requested_at_idx
  on conversations(cancel_requested_at)
  where cancel_requested_at is not null;
```

- [ ] **Step 2: Applicare la migration in produzione PRIMA di qualunque deploy**

L'MCP Supabase di questa macchina vede solo il progetto CRM: per il progetto della
messaggistica si usa la Management API (come per `ai_lock_at` il 27/07 e per la
migration di `send-agenda` il 29/07), oppure il SQL Editor via Chrome.

Eseguire lo SQL sopra sul progetto di produzione e verificare:

```sql
select column_name, data_type
from information_schema.columns
where table_name = 'conversations' and column_name = 'cancel_requested_at';
```

Expected: una riga, `timestamptz`. **Se questo passo non riesce, fermarsi e chiedere a
Bruno le credenziali: il codice dei task successivi non va in produzione senza la
colonna.**

- [ ] **Step 3: Aggiungere la colonna ai tipi Supabase**

In `lib/supabase/types.ts`, nella tabella `conversations`, aggiungere in ordine
alfabetico (subito dopo `bot_scheduled_at` se presente, comunque nel blocco `c`):
- in `Row`: `cancel_requested_at: string | null`
- in `Insert`: `cancel_requested_at?: string | null`
- in `Update`: `cancel_requested_at?: string | null`

- [ ] **Step 4: Scrivere il test di `isRichiestaDisdetta`**

In `lib/bot-outcome-rules.test.ts`:

```ts
describe('isRichiestaDisdetta', () => {
  it('annullare e spostare sono richieste di disdetta', () => {
    expect(isRichiestaDisdetta('DA_SCARTARE')).toBe(true);
    expect(isRichiestaDisdetta('RICHIAMO')).toBe(true);
  });
  it('tutto il resto no: il lead non ha chiesto niente', () => {
    expect(isRichiestaDisdetta('INTERROTTO')).toBe(false);
    expect(isRichiestaDisdetta('NON_RISPOSTO')).toBe(false);
    expect(isRichiestaDisdetta('APPUNTAMENTO')).toBe(false);
    expect(isRichiestaDisdetta('NOTA')).toBe(false);
  });
});
```

- [ ] **Step 5: Scrivere i test di `sendOutcome`**

In `lib/bot-outcome.test.ts`, sempre con `makeSupabase` e con
`eventoLockedGiaScritto` (l'helper già presente che produce l'evento di una nota
identica già inviata):

```ts
describe('sendOutcome — cancel_requested_at', () => {
  const fissato = { crm_lead_id: 'crm1', bot_outcome: 'APPUNTAMENTO', bot_scheduled_at: DATE };
  const marcature = (calls: any) => calls.updates.filter((u: any) => 'cancel_requested_at' in u);

  it('un SCARTO su appuntamento fissato marca la disdetta senza declassare', async () => {
    const { supabase, calls } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'non ce la faccio piu' });

    expect(marcature(calls)).toHaveLength(1);
    expect(typeof marcature(calls)[0].cancel_requested_at).toBe('string');
    for (const u of calls.updates) expect(u.bot_outcome).toBeUndefined();
    expect(calls.events.some((e: any) => e.type === 'cancel_requested')).toBe(true);
  });

  it('un RICHIAMO su appuntamento fissato marca la disdetta', async () => {
    const { supabase, calls } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'RICHIAMO', note: 'la prossima settimana' });
    expect(marcature(calls)).toHaveLength(1);
  });

  it('un INTERROTTO NON è una disdetta: il lead non ha chiesto niente', async () => {
    const { supabase, calls } = makeSupabase(fissato);
    await sendOutcome(supabase, 1, { outcome: 'INTERROTTO' });
    expect(marcature(calls)).toHaveLength(0);
  });

  it('su una conversazione senza appuntamento non si marca niente', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'crm1', bot_outcome: null, bot_scheduled_at: null });
    await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'non mi interessa' });
    expect(marcature(calls)).toHaveLength(0);
  });

  it('anche quando la nota è un duplicato, la disdetta resta marcata', async () => {
    const args = { outcome: 'DA_SCARTARE' as const, discardReason: 'non ce la faccio piu' };
    const precedente = await eventoLockedGiaScritto(fissato, 1, args);
    const { supabase, calls } = makeSupabase(fissato, { eventLogRows: [precedente] });

    const res = await sendOutcome(supabase, 1, args);

    expect(res.error).toBe('note_duplicate');
    expect(marcature(calls)).toHaveLength(1);
  });

  it('un lead del GDO che disdice marca la disdetta (canale solo-nota)', async () => {
    const { supabase, calls } = makeSupabase({ crm_lead_id: 'gdo1', bot_outcome: null, bot_scheduled_at: null });
    await sendOutcome(supabase, 1, { outcome: 'DA_SCARTARE', discardReason: 'annullo tutto' }, { noteOnly: true });
    expect(marcature(calls)).toHaveLength(1);
  });
});
```

Nota: `eventoLockedGiaScritto` fa girare `sendOutcome` una prima volta, quindi produce
anche una marcatura "di riscaldamento" su un fake diverso — le asserzioni sopra guardano
solo `calls` del secondo fake, che è quello sotto test.

- [ ] **Step 6: Eseguire e verificare il fallimento**

Run: `npm test -- lib/bot-outcome-rules.test.ts lib/bot-outcome.test.ts`
Expected: FAIL — `isRichiestaDisdetta` non esiste, nessuna update scrive la colonna.

- [ ] **Step 7: Implementare**

In `lib/bot-outcome-rules.ts` aggiungere:

```ts
/**
 * Questo esito, su un lead con l'appuntamento GIÀ fissato, è una richiesta di
 * disdetta o di spostamento? Serve a spegnere gli automatismi (promemoria, solleciti)
 * senza toccare `bot_outcome`, che resta terminale.
 * INTERROTTO e NON_RISPOSTO no: lì il lead non ha chiesto niente, è sparito.
 */
export function isRichiestaDisdetta(outcome: BotOutcome): boolean {
  return outcome === 'DA_SCARTARE' || outcome === 'RICHIAMO';
}
```

In `lib/bot-outcome.ts`:

1. Aggiungere `isRichiestaDisdetta` all'import da `./bot-outcome-rules`.
2. Definire una funzione locale sopra `sendOutcome`:

```ts
/** Segna che il lead ha chiesto di annullare o spostare. Non tocca bot_outcome: è un
 *  marcatore, non un declassamento. Spegne promemoria pre-call e solleciti GDO. */
async function marcaDisdetta(supabase: Supa, conversationId: number, crmLeadId: string, outcome: BotOutcome): Promise<void> {
  const at = new Date().toISOString();
  await supabase.from('conversations').update({ cancel_requested_at: at }).eq('id', conversationId);
  await supabase.from('event_log').insert({
    type: 'cancel_requested',
    payload: { conversationId, crmLeadId, outcome, at } as never,
    message: `[bot-fissatore] il lead ${crmLeadId} ha chiesto di annullare/spostare: automatismi spenti su questa chat`,
    level: 'info',
  });
}
```

3. Dentro `sendCrmNoteOnly`, subito dopo `const note = buildLockedNote(...)` e PRIMA del
   controllo di duplicato:

```ts
  if (isRichiestaDisdetta(args.outcome)) await marcaDisdetta(supabase, conversationId, crmLeadId, args.outcome);
```

4. Dentro `sendOutcome`, subito dopo `const action = resolveOutcomeAction(...)`:

```ts
  // L'appuntamento resta terminale (action 'locked'), ma la richiesta di spostarlo o
  // annullarlo va registrata: è il segnale che spegne promemoria e solleciti. Si marca
  // prima della dedup, altrimenti una nota già inviata farebbe perdere il marcatore.
  if (action.kind === 'locked' && isRichiestaDisdetta(args.outcome)) {
    await marcaDisdetta(supabase, conversationId, crmLeadId, args.outcome);
  }
```

Nota: `sendCrmNoteOnly` viene chiamata prima di `resolveOutcomeAction`, quindi i due
punti non si sovrappongono mai.

- [ ] **Step 8: Eseguire i test**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260806000001_cancel_requested_at.sql lib/supabase/types.ts lib/bot-outcome-rules.ts lib/bot-outcome-rules.test.ts lib/bot-outcome.ts lib/bot-outcome.test.ts
git commit -m "feat(bot): marcatore di disdetta, senza declassare l'appuntamento"
```

### Task 11: gli automatismi si spengono dopo una disdetta

**Files:**
- Modify: `app/api/cron/precall-reminders/route.ts`
- Modify: `app/api/cron/gdo-video-followups/route.ts`

**Interfaces:** consumano la colonna `cancel_requested_at` (Task 10). Nessuna firma nuova.

- [ ] **Step 1: Leggere la guida delle route handler**

Read: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
Questa versione di Next ha breaking change: verificare che `runtime`, `dynamic` e
`maxDuration` già presenti restino la forma corretta prima di toccare i file.

- [ ] **Step 2: Aggiungere il filtro in `precall-reminders`**

Nella query delle conversazioni (righe 68-76), subito dopo `.is('ai_paused_at', null)`:

```ts
    // Il lead ha chiesto di annullare o spostare: un "ti ricordo la call di domani"
    // dopo che gli abbiamo detto "me lo segno" è la cosa che ha prodotto le risposte
    // peggiori ("avevo chiesto di rimandare"). 10 casi su 23 misurati il 04/08/2026.
    .is('cancel_requested_at', null)
```

- [ ] **Step 3: Aggiungere il filtro in `gdo-video-followups`**

Nella query (righe ~88-105), subito dopo `.is('ai_paused_at', null)`:

```ts
    // Disdetta chiesta: sollecitare il video di una call che il lead vuole spostare è
    // solo danno.
    .is('cancel_requested_at', null)
```

- [ ] **Step 4: Verificare**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: verde. (Le due route non hanno test unitari — sono I/O puro su Supabase; il
`build` verifica che compilino e i test delle funzioni pure che consumano restano verdi.)

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/precall-reminders/route.ts app/api/cron/gdo-video-followups/route.ts
git commit -m "fix(cron): niente promemoria ne' solleciti dopo una richiesta di disdetta"
```

### Task 12: il video non parte più al posto della risposta

Oggi `shouldSendGdoVideo` manda il video al primo inbound qualunque cosa dica, poi fa
`continue`: l'ultimo messaggio diventa outbound, `nextUnansweredInboundIndex` torna -1 e
il modello non risponde MAI a quel messaggio. 6 casi misurati, 4 mai risposti (conv 3647,
3661, 3676, 3704). Se il lead scriveva "posso spostare?", quella domanda è morta lì.

**Files:**
- Modify: `lib/fenice-autoreply.ts`
- Modify: `lib/gdo-context-note.ts`
- Test: `lib/fenice-autoreply.test.ts`, `lib/gdo-context-note.test.ts`

**Interfaces:**
- Produces: `export function isSoloPresaDAtto(body: string | null | undefined): boolean`
  in `lib/fenice-autoreply.ts` — vero solo per una presa d'atto senza contenuto
  ("ok", "grazie", "va bene"); falso per tutto il resto, domande e obiezioni comprese.
- Produces: `GdoNoteInput` guadagna `videoInUscita?: boolean`; `gdoContextNote` con quel
  flag usa `GDO_CONTEXT_NOTE_VIDEO_IN_USCITA` come base e non emette `NOTA_VIDEO`.
- Produces: `export const GDO_CONTEXT_NOTE_VIDEO_IN_USCITA: string` in
  `lib/gdo-context-note.ts`.

- [ ] **Step 1: Scrivere i test di `isSoloPresaDAtto`**

Aggiungere `isSoloPresaDAtto` all'import da `./fenice-autoreply` in cima al file di test
(riga 2, la lista è già lunga: si accoda). Poi, in `lib/fenice-autoreply.test.ts`:

```ts
describe('isSoloPresaDAtto', () => {
  it('le prese d\'atto secche sono tali', () => {
    for (const t of ['ok', 'OK', 'ok!', 'va bene', 'perfetto', 'grazie', 'grazie mille', 'ricevuto', 'certo', 'si', 'sì', 'ciao', 'buongiorno', '👍']) {
      expect(isSoloPresaDAtto(t)).toBe(true);
    }
  });

  it('una domanda non è mai una presa d\'atto', () => {
    for (const t of ['ok?', 'ma quando?', 'e la call?', 'ok ma a che ora è?']) {
      expect(isSoloPresaDAtto(t)).toBe(false);
    }
  });

  it('una richiesta di spostare non è mai una presa d\'atto', () => {
    for (const t of [
      'scusa ma devo spostare',
      'non ce la faccio più, annulliamo',
      'possiamo rimandare a settimana prossima',
      'guarda mi è uscito un imprevisto di lavoro',
    ]) {
      expect(isSoloPresaDAtto(t)).toBe(false);
    }
  });

  it('un messaggio con contenuto vero non è una presa d\'atto', () => {
    expect(isSoloPresaDAtto('ok va bene grazie mille per tutto quanto')).toBe(false);
  });

  it('un messaggio vuoto o un media senza testo: nessuna domanda a cui rispondere', () => {
    expect(isSoloPresaDAtto('')).toBe(true);
    expect(isSoloPresaDAtto('   ')).toBe(true);
    expect(isSoloPresaDAtto(null)).toBe(true);
  });
});
```

- [ ] **Step 2: Scrivere i test della nota di contesto**

In `lib/gdo-context-note.test.ts`:

```ts
describe('gdoContextNote — il video sta uscendo adesso', () => {
  const base = { gdoVideoSentAt: null, gdoVideoWatchedAt: null, gdoNoemiRemindedAt: null, followupsSent: 0, videoAppenaConfermato: false };

  it('con videoInUscita non dice al modello che il video è già stato mandato', () => {
    const n = gdoContextNote({ ...base, videoInUscita: true });
    expect(n).toContain('IL VIDEO ESCE ORA');
    expect(n).not.toContain('e il video da vedere prima della call');
  });

  it('con videoInUscita non chiede anche il promemoria video: sarebbe un doppione', () => {
    const n = gdoContextNote({ ...base, gdoVideoSentAt: '2026-08-06T10:00:00Z', videoInUscita: true });
    expect(n).not.toContain(NOTA_VIDEO);
  });

  it('vieta al modello di scrivere lui il link', () => {
    expect(gdoContextNote({ ...base, videoInUscita: true })).toMatch(/non mandare nessun link/i);
  });

  it('senza il flag il comportamento è quello di oggi', () => {
    const n = gdoContextNote({ ...base, gdoVideoSentAt: '2026-08-06T10:00:00Z' });
    expect(n).toContain(NOTA_VIDEO);
    expect(n).not.toContain('IL VIDEO ESCE ORA');
  });
});
```

- [ ] **Step 3: Eseguire e verificare il fallimento**

Run: `npm test -- lib/fenice-autoreply.test.ts lib/gdo-context-note.test.ts`
Expected: FAIL — `isSoloPresaDAtto` e `videoInUscita` non esistono.

- [ ] **Step 4: Implementare `isSoloPresaDAtto`**

In `lib/fenice-autoreply.ts`, sotto `shouldSendGdoVideo`:

```ts
/** Parole che da sole non chiedono niente: una presa d'atto, non un messaggio. */
const PRESE_DATTO = new Set([
  'ok', 'okay', 'oki', 'okey', 'va', 'bene', 'vabene', 'vabbene', 'vabbe', 'perfetto',
  'ottimo', 'grazie', 'mille', 'graz', 'si', 'certo', 'ricevuto', 'daccordo', 'accordo',
  'ciao', 'salve', 'buongiorno', 'buonasera', 'buonpomeriggio', 'ok👍', 'd',
]);

/**
 * Pure: questo messaggio del lead è solo una presa d'atto?
 *
 * Serve a decidere se il video del GDO può essere l'UNICA risposta a quel messaggio.
 * Fail-safe verso il "no": nel dubbio risponde il modello, perché il costo di
 * sbagliare in quella direzione è un messaggio in più, mentre nell'altra è una domanda
 * del lead che non riceve MAI risposta (conv 3647, 3661, 3676, 3704).
 */
export function isSoloPresaDAtto(body: string | null | undefined): boolean {
  const raw = (body ?? '').trim();
  if (!raw) return true; // media senza testo: non c'è nessuna domanda a cui rispondere
  if (raw.includes('?')) return false;
  const parole = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parole.length === 0) return true; // solo emoji o punteggiatura
  if (parole.length > 4) return false;
  return parole.every((p) => PRESE_DATTO.has(p));
}
```

- [ ] **Step 5: Implementare la nota di contesto**

In `lib/gdo-context-note.ts` aggiungere la costante e il flag:

```ts
/**
 * Variante di GDO_CONTEXT_NOTE per il turno in cui il video sta uscendo INSIEME alla
 * risposta del modello: qui il video non è ancora arrivato al lead, quindi la frase
 * "te l'ho già mandato" sarebbe falsa e il modello la ripeterebbe al lead.
 */
export const GDO_CONTEXT_NOTE_VIDEO_IN_USCITA =
  "CONTESTO DI QUESTA CONVERSAZIONE: l'appuntamento di questo lead è GIÀ FISSATO — l'ha preso " +
  'un tuo collega al telefono, e tu gli hai già mandato il link per scegliere giorno e ora. ' +
  'Applica la sezione "SE L\'APPUNTAMENTO È GIÀ FISSATO": non ripartire col pitch e non ' +
  'riproporre la call. Il collega non si nomina mai. ' +
  'IL VIDEO ESCE ORA: subito dopo il tuo messaggio, in automatico, al lead arriva il link del ' +
  'video da vedere prima della call. Non scriverlo tu, non mandare nessun link e non dire che ' +
  "gliel'hai già mandato: rispondi a quello che ti ha appena scritto e basta.";
```

Aggiungere il campo a `GdoNoteInput`:

```ts
  /** Il video sta partendo insieme a questa risposta (primo turno del lead GDO). */
  videoInUscita?: boolean;
```

Sostituire `gdoContextNote`:

```ts
export function gdoContextNote(i: GdoNoteInput): string {
  const parti = [i.videoInUscita ? GDO_CONTEXT_NOTE_VIDEO_IN_USCITA : GDO_CONTEXT_NOTE];
  // Il promemoria "ricordagli il video" non ha senso nel turno in cui il video esce.
  if (!i.videoInUscita && i.gdoVideoSentAt && !i.gdoVideoWatchedAt) parti.push(NOTA_VIDEO);
  if (serveNoemi(i)) parti.push(NOTA_NOEMI);
  return parti.join('\n\n');
}
```

- [ ] **Step 6: Cablare il drain**

In `lib/fenice-autoreply.ts`, dentro il ciclo `for (let round...)`, sostituire il blocco
del video (righe 259-282) con:

```ts
      // Il messaggio del lead a cui stiamo rispondendo in questo giro.
      const inboundIdx = nextUnansweredInboundIndex(rows);
      const inboundBody = inboundIdx >= 0 ? (rows[inboundIdx].body ?? '') : '';

      /** Manda il video del GDO come bolla a sé e ne registra l'invio. */
      const inviaVideoGdo = async (): Promise<void> => {
        const body = gdoVideoText(gdo.leads?.first_name ?? null, gdoVideoUrl as string);
        const sent = await sendFreeText({ to: phone, body, from });
        await supabase.from('messages').insert({
          conversation_id: conversationId, direction: 'out', body,
          twilio_sid: sent.sid, twilio_status: sent.status,
          sender: 'bot',
        });
        const sentAt = new Date().toISOString();
        await supabase.from('conversations')
          .update({ gdo_video_sent_at: sentAt, last_message_at: sentAt })
          .eq('id', conversationId);
        await supabase.from('event_log').insert({
          type: 'gdo_video_sent',
          payload: { conversationId, phone, crmLeadId, video: gdoVideoUrl } as never,
          message: `[gdo] video inviato a ${phone} dopo la risposta del lead`,
          level: 'info',
        });
        gdoVideoSentAt = sentAt;
      };

      const videoDaMandare = shouldSendGdoVideo({ gdoAgendaAt, gdoVideoUrl, gdoVideoSentAt });
      // Il video può essere l'UNICA risposta solo se il lead non ha chiesto niente. Se
      // ha fatto una domanda o un'obiezione, il modello risponde e il video esce
      // insieme: prima il video partiva al posto della risposta, l'ultimo messaggio
      // diventava outbound e quella domanda non riceveva risposta mai più.
      const videoDaSolo = videoDaMandare && isSoloPresaDAtto(inboundBody);
      const videoInsiemeAllaRisposta = videoDaMandare && !videoDaSolo;

      if (videoDaSolo) {
        await inviaVideoGdo();
        continue; // eventuali altri messaggi del lead li gestisce il round successivo
      }
```

Nella chiamata a `generateMarioReply` (righe 309-325), passare il flag nella nota:

```ts
        ...(postino
          ? {
              contextNote: gdoContextNote({
                gdoVideoSentAt: gdoVideoSentAt,
                gdoVideoWatchedAt: gdoVideoWatchedAt,
                gdoNoemiRemindedAt: gdoNoemiRemindedAt,
                followupsSent: gdoFollowupsSent,
                videoAppenaConfermato: false,
                videoInUscita: videoInsiemeAllaRisposta,
              }),
            }
          : {}),
```

Fare lo stesso nella rigenerazione per Noemi (righe 346-355): aggiungere
`videoInUscita: videoInsiemeAllaRisposta`.

Subito dopo `let parts = splitMarioMessages(visibleReply);` (riga 371) aggiungere:

```ts
      // Il video esce in coda alla risposta, come ultima bolla: prima si risponde a
      // quello che il lead ha chiesto, poi gli si dà il video.
      if (videoInsiemeAllaRisposta) {
        parts = [...parts, gdoVideoText(gdo.leads?.first_name ?? null, gdoVideoUrl as string)];
      }
```

E dopo il ciclo di invio delle bolle (dopo il blocco `if (parts.length > 0) { ... }`,
riga ~419) registrare l'invio del video:

```ts
      if (videoInsiemeAllaRisposta) {
        const sentAt = new Date().toISOString();
        await supabase.from('conversations')
          .update({ gdo_video_sent_at: sentAt })
          .eq('id', conversationId);
        await supabase.from('event_log').insert({
          type: 'gdo_video_sent',
          payload: { conversationId, phone, crmLeadId, video: gdoVideoUrl, conRisposta: true } as never,
          message: `[gdo] video inviato a ${phone} insieme alla risposta del modello`,
          level: 'info',
        });
        gdoVideoSentAt = sentAt;
      }
```

- [ ] **Step 7: Scrivere il test di integrazione del drain**

Dentro il `describe('drainMarioReplies — modalità postino (lead dei GDO)')` già
esistente (così si riusano `VIDEO`, `AGENDA`, `postino` e i suoi `beforeEach`),
aggiungere:

```ts
  it('se il lead chiede di spostare, il modello risponde E il video esce in coda', async () => {
    const DISDETTA: FakeMsgRow = {
      direction: 'in', body: 'scusa ma mi è uscito un imprevisto, possiamo spostare?',
      template_sid: null, created_at: '2026-07-29T10:02:00Z',
    };
    const { supabase, calls } = makeDrainSupabase(postino(), [AGENDA, DISDETTA]);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'eh ci sta, capita\nsentiti intanto con Noemi, sono cinque minuti',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    // Il lead riceve una risposta alla SUA domanda: prima moriva lì (conv 3647, 3661, 3676, 3704).
    expect(generateMarioReply).toHaveBeenCalledTimes(1);
    const corpi = calls.messageInserts.map((m: any) => m.body);
    expect(corpi.some((b: string) => b.includes('Noemi'))).toBe(true);
    // Il video esce comunque, come ultima bolla.
    expect(corpi.at(-1)).toContain(VIDEO);
    expect(calls.convUpdates.some((u: any) => u.gdo_video_sent_at)).toBe(true);
    expect(calls.events.some((e: any) => e.type === 'gdo_video_sent')).toBe(true);
  });

  it('la nota di contesto dice al modello che il video sta uscendo adesso', async () => {
    const DOMANDA: FakeMsgRow = {
      direction: 'in', body: 'ma quanto dura la call?', template_sid: null, created_at: '2026-07-29T10:02:00Z',
    };
    const { supabase } = makeDrainSupabase(postino(), [AGENDA, DOMANDA]);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'trenta quaranta minuti',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    const nota = vi.mocked(generateMarioReply).mock.calls[0][1]?.contextNote ?? '';
    expect(nota).toContain('IL VIDEO ESCE ORA');
    expect(nota).not.toContain(NOTA_VIDEO);
  });

  it('una presa d\'atto secca continua a ricevere solo il video', async () => {
    const { supabase, calls } = makeDrainSupabase(postino(), [AGENDA, RISPOSTA]);

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(generateMarioReply).not.toHaveBeenCalled();
    expect(calls.messageInserts).toHaveLength(1);
    expect(calls.messageInserts[0].body).toContain(VIDEO);
  });

  it('video già inviato: nessuna bolla col link in coda alla risposta', async () => {
    const rows: FakeMsgRow[] = [
      AGENDA, RISPOSTA,
      { direction: 'out', body: `ecco il video ${VIDEO}`, template_sid: null, created_at: '2026-07-29T10:03:00Z' },
      { direction: 'in', body: 'posso spostare?', template_sid: null, created_at: '2026-07-29T10:10:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z' }), rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'eh ci sta, sentiti con Noemi',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(calls.messageInserts).toHaveLength(1);
    expect(calls.messageInserts[0].body).not.toContain(VIDEO);
  });
```

`RISPOSTA` (il messaggio `'ok'`) e `NOTA_VIDEO` sono già definiti/importati nel file.

- [ ] **Step 8: Eseguire i test**

Run: `npm test && npm run typecheck && npm run lint`
Expected: verde.

- [ ] **Step 9: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts lib/gdo-context-note.ts lib/gdo-context-note.test.ts
git commit -m "fix(gdo): il video esce insieme alla risposta, non al posto suo"
```

### Task 13: niente bivio "sposto o annullo", rilanci sulla fermezza del no

**Files:**
- Modify: `lib/mario-prompt.ts` (sezione "SE L'APPUNTAMENTO È GIÀ FISSATO")
- Test: `lib/mario-prompt.test.ts`

**Interfaces:** nessuna firma cambia.

- [ ] **Step 1: Scrivere i test che falliscono**

In `lib/mario-prompt.test.ts`:

```ts
describe('appuntamento già fissato — gestione della disdetta', () => {
  const p = buildMarioSystem('Marta');

  it('vieta il bivio "sposto o annullo"', () => {
    expect(p).toContain('non mettergli MAI davanti il bivio');
    expect(p).toMatch(/non proporgli tu di annullare/i);
  });

  it('riporta alla chiamata di Noemi come passaggio che conferma', () => {
    expect(p).toMatch(/sentiti con Noemi/i);
    expect(p).toContain('è il passaggio che conferma');
  });

  it('non promette più che "ti ricontatta una collega"', () => {
    expect(p).not.toContain('ti ricontatta una collega');
  });

  it('i rilanci dipendono dalla fermezza del no, non dal motivo', () => {
    expect(p).toContain('QUANTE VOLTE RIPROVARE');
    expect(p).toMatch(/quanto è fermo il no/i);
    expect(p).toMatch(/una seconda volta/i);
  });

  it('nel dubbio si ferma', () => {
    expect(p).toMatch(/nel dubbio fermati/i);
  });

  it('chiede il motivo, con una domanda sola', () => {
    expect(p).toMatch(/chiedi cosa è successo/i);
    expect(p).toMatch(/una domanda sola/i);
  });

  it('non riprende a proporre orari: non li gestisce lui', () => {
    expect(p).toContain('giorno e ora non li gestisci tu');
  });
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `npm test -- lib/mario-prompt.test.ts -t "gestione della disdetta"`
Expected: FAIL.

- [ ] **Step 3: Implementare**

Sostituire l'INTERO paragrafo "SE L'APPUNTAMENTO È GIÀ FISSATO" (riga 262, il blocco fra
i due `---`) con:

```
SE L'APPUNTAMENTO È GIÀ FISSATO (hai già mandato Noemi e il video): non ripartire col pitch e non riproporre la call. Se il lead conferma di aver visto il video (es. "fatto", "visto", "l'ho guardato"), ringrazia in una riga e chiudi il messaggio con [VIDEO_VISTO]. Se fa una domanda sul percorso, rispondi breve e rimanda alla call.

SE VUOLE SPOSTARE O DISDIRE: non mettergli MAI davanti il bivio "lo spostiamo o lo annulliamo", non fargli scegliere fra le due e non proporgli tu di annullare: sono due strade che finiscono male tutte e due. E non riproporre orari, giorno e ora non li gestisci tu.
Prima capisci: chiedi cosa è successo, con una domanda sola e senza fargli il terzo grado. Quasi sempre chi scrive vuole solo spostare, non mollare.
Poi gestisci quello che ti dice come gestiresti qualunque altra obiezione, e riporta il discorso alla chiamata di Noemi: sono 5-10 minuti al telefono, è lì che si sistemano gli incastri, ed è il passaggio che conferma l'appuntamento. Es. "guarda, intanto sentiti con Noemi, sono cinque minuti e con lei sistemi anche l'orario".
QUANTE VOLTE RIPROVARE: non è una regola fissa, la decidi tu guardando quanto è fermo il no. Se ribadisce ma senza convinzione assoluta (tentenna, si spiega, ti lascia uno spiraglio, dice "per ora", "più avanti", "ci devo pensare"), puoi riprovare una seconda volta e basta. Se il no è fermo e netto (te lo ripete senza cedere, si secca, ti dice di lasciar perdere), fermati subito: accetti, gli dici che ti dispiace, non insisti di un millimetro. Nel dubbio fermati: insistere su un no vero è la cosa che ci ha fatto più danno, ci siamo sentiti dire "il tira e molla non mi piace" e "avete esagerato".
Quando ti fermi, chiudi il messaggio con [ESITO:SCARTO|<motivo con le parole del lead>] se rinuncia del tutto, oppure [ESITO:RICHIAMO|<data ISO se te l'ha data, altrimenti le sue parole testuali sul quando>] se vuole solo spostare. L'appuntamento resta comunque fissato: il tuo esito diventa solo una nota per i colleghi.
```

Nota: questo sostituisce anche la modifica del Task 8 alla stessa riga — il testo qui
sopra la incorpora già.

- [ ] **Step 4: Eseguire i test**

Run: `npm test -- lib/mario-prompt.test.ts && npm test`
Expected: PASS, compresi i test del Task 8 (`non contiene "altrimenti la data
dell'appuntamento"`) e l'invariante "cambia SOLO il nome".

- [ ] **Step 5: Commit**

```bash
git add lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "feat(prompt): niente bivio sposto-o-annullo, i rilanci seguono la fermezza del no"
```

### Task 14: slot uno alla volta

L'attesa mediana fra fissaggio e call è 44 ore e il 39% supera le 48h: è la causa numero
uno delle disdette ("imprevisto di lavoro", 28% dei motivi). Il giorno 1 va proposto
sempre per primo, il giorno 2 solo se il lead proprio non riesce.

**Files:**
- Modify: `lib/booking-slots.ts`
- Modify: `lib/mario-prompt.ts` (FASE 6)
- Test: `lib/booking-slots.test.ts`, `lib/mario-prompt.test.ts`

**Interfaces:** `computeBookingDays` e `bookingSlotsContext(now: Date): string` restano
invariate nella firma. Cambia solo il TESTO prodotto da `bookingSlotsContext`: entrambe
le date restano legali per il tag, ma la proposta al lead parte sempre da `day1`.

- [ ] **Step 1: Scrivere i test che falliscono**

In `lib/booking-slots.test.ts`:

```ts
describe('bookingSlotsContext — un giorno alla volta', () => {
  const now = new Date('2026-08-06T10:00:00+02:00');
  const ctx = bookingSlotsContext(now);
  const { day1, day2 } = computeBookingDays(now);

  it('dice di proporre per primo il giorno dopo', () => {
    expect(ctx).toContain('PROPONI SEMPRE PRIMA');
    expect(ctx.indexOf(day1.label)).toBeLessThan(ctx.indexOf(day2.label));
  });

  it('il secondo giorno si nomina solo se il lead non riesce', () => {
    expect(ctx).toMatch(/SOLO se il lead proprio non riesce/i);
    expect(ctx).toMatch(/non nominare l'altro/i);
  });

  it('spiega perché: la call vicina è quella che il lead non salta', () => {
    expect(ctx).toMatch(/più è vicina.*meno/i);
  });

  it('entrambe le date restano legali per il tag', () => {
    expect(ctx).toContain(day1.date);
    expect(ctx).toContain(day2.date);
  });

  it('le fasce orarie non cambiano', () => {
    expect(ctx).toContain('dalle 15:00 alle 21:00');
    expect(ctx).toContain('dalle 09:00 alle 21:00');
  });

  it('la domenica resta esclusa', () => {
    expect(ctx).toContain('la domenica non è mai disponibile');
  });
});
```

In `lib/mario-prompt.test.ts`:

```ts
describe('FASE 6 — un giorno alla volta', () => {
  const p = buildMarioSystem('Marta');

  it('propone un solo giorno per volta, partendo dal primo', () => {
    expect(p).toContain('Proponi UN GIORNO ALLA VOLTA');
    expect(p).toMatch(/parti sempre dal primo/i);
  });

  it('non propone più i due giorni insieme', () => {
    expect(p).not.toContain('Proponi tu i due giorni');
    expect(p).not.toContain('oppure [secondo giorno]');
  });

  it('prima cerca un orario dentro il primo giorno', () => {
    expect(p).toMatch(/prima prova a trovargli un orario dentro quel giorno/i);
  });
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `npm test -- lib/booking-slots.test.ts lib/mario-prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementare `bookingSlotsContext`**

Sostituire il corpo (righe 63-73 di `lib/booking-slots.ts`):

```ts
/** Blocco da iniettare nel prompt: gli unici slot in cui Mario può fissare.
 *  I giorni si propongono UNO ALLA VOLTA, partendo dal primo: l'attesa mediana fra
 *  fissaggio e call è 44 ore e il 39% supera le 48h — più la call è lontana, più
 *  l'imprevisto di lavoro se la mangia (28% dei motivi di disdetta). */
export function bookingSlotsContext(now: Date): string {
  const { day1, day2 } = computeBookingDays(now);
  const off = romeOffset(now);
  return [
    'SLOT APPUNTAMENTO DISPONIBILI (la domenica non è mai disponibile, fuso Europe/Rome):',
    `- PROPONI SEMPRE PRIMA questo: ${day1.label}, dalle 15:00 alle 21:00 (ultimo slot alle 21:00)`,
    `- SOLO se il lead proprio non riesce nel giorno sopra: ${day2.label}, dalle 09:00 alle 21:00 (ultimo slot alle 21:00)`,
    `Proponi UN GIORNO ALLA VOLTA: parti da ${day1.label} e non nominare l'altro. Il secondo giorno esiste solo dopo che il lead ti ha detto che il primo non gli va bene, e prima di passarci prova a trovargli un orario dentro il primo. Più è vicina la call, meno probabilità c'è che gli capiti un imprevisto e la salti.`,
    `Puoi fissare l'appuntamento SOLO in uno di questi due giorni e dentro queste fasce orarie. Nessun altro giorno o orario è ammesso.`,
    `Nel tag [ESITO:APPUNTAMENTO|...] usa la data ISO 8601 del giorno scelto (${day1.date} oppure ${day2.date}) con l'ora concordata e fuso ${off}.`,
  ].join('\n');
}
```

- [ ] **Step 4: Implementare FASE 6 nel prompt**

In `lib/mario-prompt.ts` sostituire il paragrafo "GIORNI E ORARI" (riga 218):

```
GIORNI E ORARI: puoi fissare SOLO nei due giorni indicati nel blocco SLOT APPUNTAMENTO DISPONIBILI (lo trovi in fondo a questo prompt), dentro quelle fasce orarie. La domenica non esiste come opzione, non proporla mai. Proponi UN GIORNO ALLA VOLTA e parti sempre dal primo: es. "guarda, [primo giorno] ho disponibilità dal pomeriggio in poi, che ora ti viene comoda?". Il secondo giorno non lo nomini finché il lead non ti dice che il primo non gli va bene: due opzioni insieme allungano l'attesa, e più la call è lontana più è facile che gli capiti un imprevisto e la salti.
```

e il paragrafo "SE IL LEAD NON PUÒ" (riga 220):

```
SE IL LEAD NON PUÒ nel giorno che gli hai proposto: prima prova a trovargli un orario dentro quel giorno, non cedere subito passando al giorno dopo. Fagli capire con garbo che sono solo 30/40 minuti per risolvere il SUO problema, quindi il tempo si trova. Es. "eh ma guarda sono 30/40 minuti in tutto, anche a fine giornata, per una cosa che può cambiarti il lavoro il tempo lo troviamo dai". Proponi l'orario più comodo dentro le fasce permesse (presto la mattina o tardi la sera, fino alle 21). Solo se davvero non c'è verso, passa al secondo giorno. E se non va bene neanche quello, NON proporre altri giorni o orari fuori dalle fasce: gestiscilo come un richiamo.
```

- [ ] **Step 5: Eseguire i test**

Run: `npm test && npm run typecheck && npm run lint`
Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add lib/booking-slots.ts lib/booking-slots.test.ts lib/mario-prompt.ts lib/mario-prompt.test.ts
git commit -m "feat(bot): si propone prima il giorno dopo, il secondo solo se serve"
```

### Task 15: il FATTO riconosciuto anche senza tag

`gdo_video_watched_at` dipende dal tag `[VIDEO_VISTO]` che il modello si dimentica nel
40% dei casi: 40 lead scrivono FATTO/visto, solo 24 finiscono in colonna. Serve una rete
di sicurezza lato codice, indipendente dal tag.

**Files:**
- Create: `lib/video-visto.ts`
- Create: `lib/video-visto.test.ts`
- Modify: `lib/fenice-autoreply.ts`

**Interfaces:**
- Produces: `export function confermaVideoVisto(body: string | null | undefined): boolean`

- [ ] **Step 1: Scrivere i test**

Create `lib/video-visto.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { confermaVideoVisto } from './video-visto';

describe('confermaVideoVisto', () => {
  it('riconosce le conferme secche', () => {
    for (const t of ['FATTO', 'fatto', 'fatto!', 'visto', 'l\'ho visto', 'guardato', 'l\'ho guardato tutto', 'video visto', 'ho finito di vederlo', 'fatto tutto grazie']) {
      expect(confermaVideoVisto(t)).toBe(true);
    }
  });

  it('non scambia una promessa per una conferma', () => {
    for (const t of [
      'non l\'ho ancora visto',
      'devo ancora guardarlo',
      'lo guardo stasera',
      'lo vedo domani',
      'appena posso lo guardo',
      'quando lo devo vedere?',
      'non ho fatto in tempo',
    ]) {
      expect(confermaVideoVisto(t)).toBe(false);
    }
  });

  it('non scambia altro per una conferma', () => {
    for (const t of ['ok', 'grazie', 'ma quanto dura?', 'ho fatto un altro corso', '']) {
      expect(confermaVideoVisto(t)).toBe(false);
    }
  });

  it('regge null e undefined', () => {
    expect(confermaVideoVisto(null)).toBe(false);
    expect(confermaVideoVisto(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `npm test -- lib/video-visto.test.ts`
Expected: FAIL — il modulo non esiste.

- [ ] **Step 3: Implementare**

Create `lib/video-visto.ts`:

```ts
/**
 * Riconoscimento testuale del "FATTO": il lead dice di aver visto il video pre-call.
 *
 * È una RETE DI SICUREZZA, non il canale principale: la conferma vera resta il tag
 * [VIDEO_VISTO] emesso dal modello. Il modello però se lo dimentica nel 40% dei casi
 * (40 lead scrivono FATTO/visto, solo 24 finiscono in colonna), e ogni conferma persa
 * è un lead che continua a ricevere solleciti dopo aver fatto quello che gli era stato
 * chiesto.
 *
 * Tarata verso il falso negativo: perdere una conferma costa un promemoria di troppo,
 * scambiare "lo guardo stasera" per una conferma costa il promemoria che serviva.
 */

/** Il lead sta parlando al futuro o sta negando: qualunque conferma qui non vale. */
const RINVIO_O_NEGAZIONE =
  /\b(non|nn|manco|devo|dovrei|dovro|appena|quando|ancora|stasera|domani|dopo|tardi|piu tardi|stanotte|domattina|guardero|vedro|provo|provero|riesco|riesco a|lo guardo|lo vedo|la guardo)\b/;

/** Le forme con cui in chat si dice "l'ho visto". */
const CONFERME = [
  /\bfatto\b/,
  /\bvisto\b/,
  /\bvista\b/,
  /\bguardat[oa]\b/,
  /\bfinito\b/,
];

export function confermaVideoVisto(body: string | null | undefined): boolean {
  const t = (body ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!t) return false;
  if (RINVIO_O_NEGAZIONE.test(t)) return false;
  return CONFERME.some((re) => re.test(t));
}
```

- [ ] **Step 4: Eseguire i test**

Run: `npm test -- lib/video-visto.test.ts`
Expected: PASS. Se `'ho fatto un altro corso'` passa come conferma, restringere
`\bfatto\b` invece di allargare la lista dei rinvii: quella frase non deve mai contare.
Se serve, aggiungere alla guardia `/\b(corso|corsi|altro|altra)\b/`.

- [ ] **Step 5: Cablare il drain**

In `lib/fenice-autoreply.ts` aggiungere l'import:

```ts
import { confermaVideoVisto } from './video-visto';
```

Il flag `videoGiaInviato` oggi si calcola alla riga 393, dopo la generazione: spostarne
il calcolo subito dopo `const inboundBody = ...` (Task 12) e riusarlo:

```ts
      // Un link del video già uscito in questa chat: serve sia alla patch del blocco
      // conferma, sia alla rete di sicurezza sul FATTO qui sotto.
      const videoGiaInviato = rows.some((m) => m.direction === 'out' && containsVideoLink(m.body));
```

(togliendo la dichiarazione duplicata alla riga 393 e lasciando invariato l'uso in
`if (result.appointmentFixed && !videoGiaInviato)`).

Sostituire la riga 339 (`if (result.videoWatched) watchedAt = ...`) con:

```ts
      // Rete di sicurezza: il tag [VIDEO_VISTO] il modello se lo dimentica nel 40% dei
      // casi. Se il video è già uscito e il lead scrive "fatto"/"visto", vale come
      // conferma anche senza tag — altrimenti continua a ricevere solleciti dopo aver
      // fatto quello che gli avevamo chiesto.
      const videoLinkInviato = videoGiaInviato || !!gdoVideoSentAt;
      const videoConfermato =
        result.videoWatched ||
        (videoLinkInviato && !gdoVideoWatchedAt && confermaVideoVisto(inboundBody));
      if (videoConfermato) watchedAt = new Date().toISOString();
```

Sostituire poi tutte le occorrenze successive di `result.videoWatched` dentro il ciclo
con `videoConfermato`:
- riga ~344: `if (postino && videoConfermato && !gdoNoemiRemindedAt && ...)`
- riga ~459: `if (videoConfermato && watchedAt) { ... }`

Nel log `video_watched` aggiungere al payload da quale canale è arrivata la conferma:

```ts
          payload: { conversationId, crmLeadId, daTag: result.videoWatched } as never,
```

- [ ] **Step 6: Test del drain**

Dentro lo stesso `describe('drainMarioReplies — modalità postino (lead dei GDO)')`
aggiungere:

```ts
  // Il modello si dimentica [VIDEO_VISTO] nel 40% dei casi: qui non lo emette mai.
  const senzaTag = (visibleReply: string) => ({
    visibleReply, appointmentFixed: false, passToHuman: false, videoWatched: false,
  });
  const VIDEO_USCITO: FakeMsgRow = {
    direction: 'out', body: `ecco il video ${VIDEO}`, template_sid: null, created_at: '2026-07-29T10:03:00Z',
  };
  const dopoIlVideo = (body: string): FakeMsgRow => ({
    direction: 'in', body, template_sid: null, created_at: '2026-07-29T18:00:00Z',
  });

  it('"fatto" vale come conferma anche senza il tag del modello', async () => {
    const { supabase, calls } = makeDrainSupabase(
      postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z' }),
      [AGENDA, RISPOSTA, VIDEO_USCITO, dopoIlVideo('fatto')],
    );
    // Il turno può rigenerare per infilare il promemoria di Noemi: due risposte pronte.
    vi.mocked(generateMarioReply).mockResolvedValue(senzaTag('perfetto, allora ci siamo'));

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(calls.convUpdates.some((u: any) => typeof u.gdo_video_watched_at === 'string')).toBe(true);
    const ev = calls.events.find((e: any) => e.type === 'video_watched');
    expect(ev).toBeTruthy();
    expect(ev.payload.daTag).toBe(false);
  });

  it('"lo guardo stasera" non è una conferma', async () => {
    const { supabase, calls } = makeDrainSupabase(
      postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z' }),
      [AGENDA, RISPOSTA, VIDEO_USCITO, dopoIlVideo('lo guardo stasera')],
    );
    vi.mocked(generateMarioReply).mockResolvedValue(senzaTag('ok perfetto'));

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(calls.convUpdates.some((u: any) => 'gdo_video_watched_at' in u)).toBe(false);
  });

  it('senza nessun video mai uscito, "fatto" non conferma niente', async () => {
    const { supabase, calls } = makeDrainSupabase(
      postino({ gdo_video_url: null }),
      [AGENDA, dopoIlVideo('fatto')],
    );
    vi.mocked(generateMarioReply).mockResolvedValue(senzaTag('dimmi pure'));

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    expect(calls.convUpdates.some((u: any) => 'gdo_video_watched_at' in u)).toBe(false);
  });

  it('il tag del modello resta la via principale e continua a funzionare', async () => {
    const { supabase, calls } = makeDrainSupabase(
      postino({ gdo_video_sent_at: '2026-07-29T10:03:00Z' }),
      [AGENDA, RISPOSTA, VIDEO_USCITO, dopoIlVideo('👍')],
    );
    vi.mocked(generateMarioReply).mockResolvedValue({
      visibleReply: 'grande', appointmentFixed: false, passToHuman: false, videoWatched: true,
    });

    await drainMarioReplies(supabase, 90, '+391234567890', () => 0);

    const ev = calls.events.find((e: any) => e.type === 'video_watched');
    expect(ev.payload.daTag).toBe(true);
  });
```

Attenzione al `mockResolvedValue` (senza `Once`): la conferma del video può innescare la
rigenerazione per il promemoria di Noemi, che chiama `generateMarioReply` una seconda
volta.

- [ ] **Step 7: Eseguire i test**

Run: `npm test && npm run typecheck && npm run lint`

- [ ] **Step 8: Commit**

```bash
git add lib/video-visto.ts lib/video-visto.test.ts lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(bot): il FATTO scritto dal lead vale anche senza il tag del modello"
```

### Task 16: chi ha risposto non riceve più solleciti automatici

Decisione di Bruno (06/08): basta che il lead risponda qualcosa dopo il blocco
Noemi+video perché smetta di essere trattato da lead freddo; da lì in poi il bot si
regola in base a COSA ha risposto, e il promemoria viaggia dentro la risposta del
modello (`NOTA_VIDEO`), non come messaggio programmato addosso. Dato di supporto: fra i
lead GDO che hanno risposto almeno una volta, chi riceve 2 solleciti disdice al 22,4%
contro il 7,6% di chi non ne riceve.

**Files:**
- Modify: `lib/gdo-video-followup.ts`
- Modify: `app/api/cron/gdo-video-followups/route.ts`
- Test: `lib/gdo-video-followup.test.ts`

**Interfaces:**
- `GdoFollowupInput` guadagna `haRispostoDopoVideo: boolean` (campo OBBLIGATORIO: un
  default silenzioso a `false` nasconderebbe un call-site non aggiornato).
- `decideGdoVideoFollowup` invariata nella firma.

- [ ] **Step 1: Scrivere i test che falliscono**

In `lib/gdo-video-followup.test.ts`, accanto ai casi esistenti:

```ts
describe('decideGdoVideoFollowup — chi ha risposto non è più un lead freddo', () => {
  const base = {
    gdoAgendaAt: '2026-08-06T09:00:00+02:00',
    gdoVideoSentAt: '2026-08-06T09:30:00+02:00',
    gdoVideoWatchedAt: null,
    followupsSent: 0,
    appointmentAt: null,
    lastInboundAtMs: Date.parse('2026-08-06T09:20:00+02:00'), // vecchio: fuori dalle 6h
    lastMessageIsInbound: false,
    nowMs: Date.parse('2026-08-06T21:35:00+02:00'),
    slot: 'sera' as const,
    giorniDaAgenda: 0,
    romeHourAgenda: 9,
    haRispostoDopoVideo: false,
  };

  it('senza risposta dopo il video il sollecito parte come oggi', () => {
    expect(decideGdoVideoFollowup(base)).not.toBe('none');
  });

  it('se ha risposto dopo il video, nessun sollecito automatico', () => {
    expect(decideGdoVideoFollowup({ ...base, haRispostoDopoVideo: true })).toBe('none');
  });

  it('vale anche per il secondo slot, quello del mattino', () => {
    expect(decideGdoVideoFollowup({
      ...base,
      haRispostoDopoVideo: true,
      followupsSent: 1,
      slot: 'mattina',
      giorniDaAgenda: 1,
      nowMs: Date.parse('2026-08-07T10:05:00+02:00'),
    })).toBe('none');
  });

  it('chi non ha MAI ricevuto il video lo riceve comunque', () => {
    expect(decideGdoVideoFollowup({
      ...base,
      gdoVideoSentAt: null,
      haRispostoDopoVideo: false,
    })).toBe('video-template');
  });

  it('il tetto storico dei due touch resta', () => {
    expect(decideGdoVideoFollowup({ ...base, followupsSent: 2 })).toBe('none');
  });
});
```

- [ ] **Step 2: Eseguire e verificare il fallimento**

Run: `npm test -- lib/gdo-video-followup.test.ts`
Expected: FAIL — il campo non esiste (errore di tipo) e il caso "ha risposto" torna un
sollecito.

- [ ] **Step 3: Implementare**

In `lib/gdo-video-followup.ts` aggiungere il campo a `GdoFollowupInput`:

```ts
  /** Il lead ha scritto qualcosa DOPO che gli è arrivato il video. */
  haRispostoDopoVideo: boolean;
```

e in `decideGdoVideoFollowup`, subito dopo `if (i.gdoVideoWatchedAt) return 'none';`:

```ts
  // Ha risposto dopo il video: da qui in poi non è più un lead freddo da sbloccare con
  // un messaggio programmato, è una conversazione. Il promemoria del video viaggia
  // dentro la risposta del modello (NOTA_VIDEO), che si adatta a quello che ha detto.
  // Fra i lead GDO che hanno risposto almeno una volta, chi riceve 2 solleciti disdice
  // al 22,4% contro il 7,6% di chi non ne riceve (misura del 04/08/2026).
  if (i.haRispostoDopoVideo) return 'none';
```

- [ ] **Step 4: Cablare il cron**

In `app/api/cron/gdo-video-followups/route.ts`, dopo il calcolo di `lastInboundAtMs`
(riga ~140):

```ts
      // "Ha risposto dopo il video": un inbound successivo all'invio del video. La
      // soglia di "lead confermato" decisa il 06/08 è questa — qualsiasi risposta,
      // non il FATTO.
      const videoSentMs = c.gdo_video_sent_at ? Date.parse(c.gdo_video_sent_at) : NaN;
      const haRispostoDopoVideo =
        !Number.isNaN(videoSentMs) &&
        inbound.some((m) => Date.parse(m.created_at) > videoSentMs);
```

e passarlo nella chiamata a `decideGdoVideoFollowup`:

```ts
        haRispostoDopoVideo,
```

- [ ] **Step 5: Eseguire i test**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: verde. Se altri call-site di `decideGdoVideoFollowup` non compilano, il campo
obbligatorio ha fatto il suo lavoro: aggiungerlo, non renderlo opzionale.

- [ ] **Step 6: Commit**

```bash
git add lib/gdo-video-followup.ts lib/gdo-video-followup.test.ts app/api/cron/gdo-video-followups/route.ts
git commit -m "feat(gdo): chi risponde dopo il video non riceve piu' solleciti automatici"
```

### Task 17: chiusura del Blocco 3

- [ ] **Step 1: Suite completa**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: tutto verde, nessun test saltato.

- [ ] **Step 2: Verificare che la migration sia applicata in produzione**

```sql
select column_name from information_schema.columns
where table_name = 'conversations' and column_name = 'cancel_requested_at';
```
Expected: una riga. **Senza questa riga NON si merga**: `sendOutcome` scriverebbe su una
colonna inesistente a ogni disdetta.

- [ ] **Step 3: Merge**

```bash
git checkout main
git merge --no-ff feat/pacchetto-post-fissaggio -m "merge feat/pacchetto-post-fissaggio: automatismi spenti dopo la disdetta, video con la risposta, slot uno alla volta"
```

---

## Verifica finale (dopo i tre merge)

- [ ] `npm test && npm run typecheck && npm run lint && npm run build` su `main`.
- [ ] Colonna `cancel_requested_at` presente in produzione.
- [ ] Nessuna env nuova è richiesta perché il deploy funzioni: le sei
      `OPENING_SID_C3/C4/T3/T4/J3/J4` restano assenti finché Bruno non crea e configura i
      template, e la loro assenza fa ricadere l'apertura su quella legacy con un
      `opening_config_error` a log.
- [ ] Cose che restano in mano a Bruno, da riepilogare a fine lavoro:
      1. lanciare `scripts/create-marta-openings-dichiarate.mjs`, aspettare
         l'approvazione Meta, mettere i 6 SID su Vercel — è quello che fa partire
         davvero la conformità all'art. 50 e la sua misura;
      2. dopo ~2 settimane, `node scripts/ab-report.mjs` per leggere il costo reale
         della dichiarazione sulla risposta e sul fissaggio.
