# Funnel Professioni Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chi scrive al 3199 dal link "professione di X … scheda del corso" diventa un lead evergreen del funnel `PROFESSIONI`, Mario lo porta all'appuntamento e la scheda PDF del corso arriva dopo l'appuntamento (o prima, solo se il lead la pretende o rimanda per guardarla).

**Architecture:** un catalogo puro dei 6 corsi (`lib/professioni.ts`) usato da classificazione del primo messaggio, prompt, invio PDF e sollecito. Il bot salva `conversations.professione` e `scheda_inviata_at`; l'invio del PDF è un modulo a sé (`lib/scheda-invio.ts`) chiamato dal drain di Mario. Il CRM riceve `professione` opzionale nel push lead-entrante e la scrive come nota sulla timeline.

**Tech Stack:** bot = Next 16, bun, Vitest, Supabase JS, Twilio; CRM = Next 14, Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-funnel-professioni-design.md` (repo bot)

**Dove si lavora:** bot nel worktree `C:\Users\bruno\Desktop\Software-Messaggistica-professioni` (branch `feat/funnel-professioni`, da `origin/main`); CRM in `C:\Users\bruno\Desktop\CRM GDO` su `main`. Comandi bot: `bun run test <file>`, `bun run typecheck`, `bun run build`. Comandi CRM: `npx vitest run <file>`, `npx tsc --noEmit`, `npm run build`.

## Global Constraints

- Numero del funnel: `+393520413199`. Testo del link: `Ciao, sono interessato alla professione di <Nome> e vorrei ricevere la scheda del corso`.
- Marker del funnel: `/scheda del corso/i`, sul primo inbound O sul corrente. La frase del lancio ("professione dello Sviluppatore AI") NON deve diventare PROFESSIONI.
- Provenienza/funnel: la stringa esatta `PROFESSIONI`.
- Slug ammessi: `sviluppatore_web_ai`, `video_editor`, `project_manager`, `graphic_designer`, `copywriter`, `social_media_manager`.
- La scheda parte UNA volta per chat (`scheda_inviata_at`), dopo l'appuntamento insieme al video; prima solo via tag `[SCHEDA:<slug>]`.
- Il funnel CRM si decide solo all'adozione; una chat esistente non cambia funnel ma può ricevere `professione`.
- Sollecito: testo dedicato solo con `scheda_inviata_at` valorizzata e `bot_outcome !== 'APPUNTAMENTO'`; tempi/contatori di Track B invariati.
- Nessun ripiego su altro numero se l'invio del PDF fallisce: si logga `scheda_invio_fallito`.
- Deploy: CRM → migrazione bot → bot. Push su main = deploy (autorizzato), poi verifica deploy.
- Commit con `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. Lead che scrive dal link su una chat GIÀ aperta col bot (non adottabile): deve prendere `professione` senza cambiare funnel né rompere il flusso → test in Task 4.
2. Mario emette `[SCHEDA:<slug>]` con slug inventato o sbagliato: niente PDF, testo pulito, evento di log → test in Task 5 e Task 6.
3. Appuntamento fissato in una chat senza `professione` (lead normale): nessun PDF deve partire → test in Task 7.
4. Il modello riemette il tag d'appuntamento su una chat già fissata (video già inviato in passato): la scheda non deve ripartire → idempotenza su `scheda_inviata_at`, test in Task 6 e Task 7.
5. Payload CRM con `professione` sconosciuta o assente (bot vecchio): il lead si crea uguale, senza nota → test in Task 10.

---

### Task 1: Catalogo dei corsi e PDF pubblici (bot)

**Files:**
- Create: `lib/professioni.ts`, `lib/professioni.test.ts`
- Create: `public/schede/sviluppatore-web-ai.pdf`, `video-editor.pdf`, `project-manager.pdf`, `graphic-designer.pdf`, `copywriter.pdf`, `social-media-manager.pdf`

**Interfaces:**
- Produces: `type SlugProfessione`, `PROFESSIONI: readonly Professione[]`, `isMarkerProfessioni(t)`, `riconosciProfessione(t): SlugProfessione | null`, `isSlugProfessione(s)`, `nomeProfessione(slug)`, `urlScheda(slug, base?)`, `PROVENIENZA_PROFESSIONI = 'PROFESSIONI'`.

- [ ] **Step 1: copia i PDF**

```bash
cd "C:/Users/bruno/Desktop/Software-Messaggistica-professioni" && mkdir -p public/schede && D="C:/Users/bruno/Downloads"
cp "$D/Scheda del corso Sviluppatore Web AI.pdf" public/schede/sviluppatore-web-ai.pdf
cp "$D/scheda_del_corso_videoeditor_ (1).pdf" public/schede/video-editor.pdf
cp "$D/Corso_PM_compressed (1).pdf" public/schede/project-manager.pdf
cp "$D/Scheda_del_corso_GD (1).pdf" public/schede/graphic-designer.pdf
cp "$D/Scheda-del-corso-COPY_compressed (2).pdf" public/schede/copywriter.pdf
cp "$D/Scheda_del_corso_SMM (1).pdf" public/schede/social-media-manager.pdf
```

- [ ] **Step 2: test che fallisce** (`lib/professioni.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { isMarkerProfessioni, riconosciProfessione, isSlugProfessione, nomeProfessione, urlScheda, PROFESSIONI } from './professioni';

const frase = (n: string) => `Ciao, sono interessato alla professione di ${n} e vorrei ricevere la scheda del corso`;

describe('professioni', () => {
  it('riconosce le 6 frasi del link', () => {
    expect(riconosciProfessione(frase('Sviluppatore Web AI'))).toBe('sviluppatore_web_ai');
    expect(riconosciProfessione(frase('Video Editor'))).toBe('video_editor');
    expect(riconosciProfessione(frase('Project Manager'))).toBe('project_manager');
    expect(riconosciProfessione(frase('Graphic Designer'))).toBe('graphic_designer');
    expect(riconosciProfessione(frase('Copywriter'))).toBe('copywriter');
    expect(riconosciProfessione(frase('Social Media Manager'))).toBe('social_media_manager');
    for (const p of PROFESSIONI) expect(isMarkerProfessioni(frase(p.nome))).toBe(true);
  });
  it('tollera varianti', () => {
    expect(riconosciProfessione('vorrei la scheda del corso di montaggio video')).toBe('video_editor');
    expect(riconosciProfessione('web developer, mi mandi la scheda?')).toBe('sviluppatore_web_ai');
    expect(riconosciProfessione('mi interessa la grafica')).toBe('graphic_designer');
    expect(riconosciProfessione('SMM')).toBe('social_media_manager');
  });
  it('null quando non c\'e\' un corso', () => {
    expect(riconosciProfessione('vorrei ricevere la scheda del corso')).toBeNull();
    expect(riconosciProfessione(null)).toBeNull();
  });
  it('il link del lancio non e\' un marker professioni', () => {
    expect(isMarkerProfessioni('Ciao, ho visto la professione dello Sviluppatore AI e vorrei più informazioni')).toBe(false);
  });
  it('slug, nome, url', () => {
    expect(isSlugProfessione('copywriter')).toBe(true);
    expect(isSlugProfessione('pizzaiolo')).toBe(false);
    expect(nomeProfessione('project_manager')).toBe('Project Manager');
    expect(urlScheda('video_editor', 'https://x.app')).toBe('https://x.app/schede/video-editor.pdf');
  });
});
```

- [ ] **Step 3:** `bun run test lib/professioni.test.ts` → FAIL (modulo assente).
- [ ] **Step 4: implementazione** (`lib/professioni.ts`)

```ts
/**
 * Funnel Professioni (PO 14/10/2026, spec 2026-10-14-funnel-professioni-design.md): la
 * landing del marketing apre WhatsApp sul 3199 con "Ciao, sono interessato alla professione
 * di <Nome> e vorrei ricevere la scheda del corso". Unico catalogo dei sei corsi: lo usano
 * la classificazione del primo messaggio, la nota di Mario, l'invio del PDF e il sollecito.
 */
export const PROVENIENZA_PROFESSIONI = 'PROFESSIONI' as const;

export type SlugProfessione =
  | 'sviluppatore_web_ai' | 'video_editor' | 'project_manager'
  | 'graphic_designer' | 'copywriter' | 'social_media_manager';

export type Professione = { slug: SlugProfessione; nome: string; file: string; parole: RegExp };

// L'ordine conta: "social media manager" va provato prima di "project manager" e
// "sviluppatore" e' l'ultima spiaggia del web developer.
export const PROFESSIONI: readonly Professione[] = [
  { slug: 'social_media_manager', nome: 'Social Media Manager', file: 'social-media-manager.pdf', parole: /social\s*media\s*manager|\bsmm\b/i },
  { slug: 'project_manager', nome: 'Project Manager', file: 'project-manager.pdf', parole: /project\s*manager/i },
  { slug: 'video_editor', nome: 'Video Editor', file: 'video-editor.pdf', parole: /video\s*-?\s*editor|montaggio\s+video/i },
  { slug: 'graphic_designer', nome: 'Graphic Designer', file: 'graphic-designer.pdf', parole: /graphic\s*designer|\bgrafic[ao]\b/i },
  { slug: 'copywriter', nome: 'Copywriter', file: 'copywriter.pdf', parole: /copy\s*-?\s*writer/i },
  { slug: 'sviluppatore_web_ai', nome: 'Sviluppatore Web AI', file: 'sviluppatore-web-ai.pdf', parole: /sviluppatore\s+web|web\s*developer|\bsviluppatore\b/i },
];

const MARKER = /scheda del corso/i;

export function isMarkerProfessioni(t: string | null | undefined): boolean {
  return MARKER.test(t ?? '');
}

export function riconosciProfessione(t: string | null | undefined): SlugProfessione | null {
  const testo = t ?? '';
  return PROFESSIONI.find((p) => p.parole.test(testo))?.slug ?? null;
}

export function isSlugProfessione(s: string | null | undefined): s is SlugProfessione {
  return PROFESSIONI.some((p) => p.slug === s);
}

export function nomeProfessione(slug: SlugProfessione): string {
  return PROFESSIONI.find((p) => p.slug === slug)!.nome;
}

/** URL pubblico del PDF: servito da `public/schede/` del bot. */
export function urlScheda(slug: SlugProfessione, base: string | undefined = process.env.NEXT_PUBLIC_APP_URL): string {
  if (!base) throw new Error('Missing NEXT_PUBLIC_APP_URL');
  const file = PROFESSIONI.find((p) => p.slug === slug)!.file;
  return `${base.replace(/\/$/, '')}/schede/${file}`;
}
```

- [ ] **Step 5:** `bun run test lib/professioni.test.ts` → PASS.
- [ ] **Step 6: commit** `git add lib/professioni.ts lib/professioni.test.ts public/schede && git commit -m "feat(professioni): catalogo dei sei corsi e schede PDF pubbliche"`

### Task 2: Classificazione del primo messaggio (bot)

**Files:** Modify `lib/primo-messaggio.ts`, `lib/primo-messaggio.test.ts`

**Interfaces:**
- Consumes: `isMarkerProfessioni`, `riconosciProfessione`, `PROVENIENZA_PROFESSIONI`, `SlugProfessione` (Task 1).
- Produces: `ProvenienzaLeadEntrante` include `'PROFESSIONI'`; `EsitoPrimoMessaggio` include `{ tipo: 'professioni'; provenienza: 'PROFESSIONI'; professione: SlugProfessione | null }`.

- [ ] **Step 1: test** (in coda a `lib/primo-messaggio.test.ts`)

```ts
describe('funnel Professioni', () => {
  const link = 'Ciao, sono interessato alla professione di Video Editor e vorrei ricevere la scheda del corso';
  it('frase del link → professioni con lo slug', () => {
    expect(classificaPrimoMessaggio({ primoInbound: link, inboundCorrente: link }))
      .toEqual({ tipo: 'professioni', provenienza: 'PROFESSIONI', professione: 'video_editor' });
  });
  it('vale anche se la frase arriva dopo un "ciao"', () => {
    expect(classificaPrimoMessaggio({ primoInbound: 'ciao', inboundCorrente: link }).tipo).toBe('professioni');
  });
  it('senza corso riconosciuto → professione null', () => {
    expect(classificaPrimoMessaggio({ primoInbound: 'mi mandi la scheda del corso?', inboundCorrente: 'mi mandi la scheda del corso?' }))
      .toEqual({ tipo: 'professioni', provenienza: 'PROFESSIONI', professione: null });
  });
  it('il link del lancio resta lancio', () => {
    const l = 'Ciao, ho visto la professione dello Sviluppatore AI e vorrei più informazioni';
    expect(classificaPrimoMessaggio({ primoInbound: l, inboundCorrente: l }).tipo).toBe('lancio_link');
  });
  it('il pulsante del webinar vince sulle professioni', () => {
    expect(classificaPrimoMessaggio({ primoInbound: link, inboundCorrente: 'Ho seguito la live Web Developer AI' }).tipo).toBe('lancio_pulsante');
  });
  it('il riaggancio di Marta vale come per INBOUND', () => {
    expect(vaRiagganciato({ tipo: 'professioni', provenienza: 'PROFESSIONI', professione: null })).toBe(true);
  });
});
```

- [ ] **Step 2:** `bun run test lib/primo-messaggio.test.ts` → FAIL.
- [ ] **Step 3: implementazione** — in `lib/primo-messaggio.ts`:
  - import: `import { isMarkerProfessioni, riconosciProfessione, PROVENIENZA_PROFESSIONI, type SlugProfessione } from './professioni';`
  - tipi:
```ts
export type ProvenienzaLeadEntrante = 'TELEGRAM' | 'INBOUND' | typeof PROVENIENZA_LANCIO_WEBDEV | typeof PROVENIENZA_PROFESSIONI;

export type EsitoPrimoMessaggio =
  | { tipo: 'telegram'; provenienza: 'TELEGRAM' }
  | { tipo: 'inbound'; provenienza: 'INBOUND' }
  | { tipo: 'lancio_pulsante'; provenienza: typeof PROVENIENZA_LANCIO_WEBDEV }
  | { tipo: 'lancio_link'; provenienza: typeof PROVENIENZA_LANCIO_WEBDEV }
  | { tipo: 'professioni'; provenienza: typeof PROVENIENZA_PROFESSIONI; professione: SlugProfessione | null };
```
  - in `classificaPrimoMessaggio`, subito dopo il blocco del link Sviluppatore e prima di `isTelegram`:
```ts
  // Funnel Professioni (PO 14/10/2026): primo O corrente, come il link. Il corso si legge
  // dal messaggio che contiene la frase; senza corso riconosciuto Mario chiede quale.
  const frase = isMarkerProfessioni(input.inboundCorrente) ? input.inboundCorrente
    : isMarkerProfessioni(input.primoInbound) ? input.primoInbound : null;
  if (frase) {
    return { tipo: 'professioni', provenienza: PROVENIENZA_PROFESSIONI, professione: riconosciProfessione(frase) };
  }
```
  - aggiorna il commento di testa con la quinta porta.
- [ ] **Step 4:** `bun run test lib/primo-messaggio.test.ts && bun run typecheck` → PASS (correggi eventuali `switch` esaustivi su `esito.tipo` segnalati da tsc aggiungendo il caso `'professioni'` col comportamento di `'inbound'`).
- [ ] **Step 5: commit** `feat(professioni): il primo messaggio riconosce il funnel e il corso`

### Task 3: Colonne `professione` e `scheda_inviata_at` (bot)

**Files:** Create `supabase/migrations/20261014000001_professioni.sql`; Modify `lib/supabase/types.ts` (Row/Insert/Update di `conversations`).

- [ ] **Step 1: migrazione**

```sql
-- Funnel Professioni (PO 14/10/2026, spec 2026-10-14-funnel-professioni-design.md).
-- `professione`: slug del corso scelto sulla landing (lib/professioni.ts), scritto quando il
-- lead manda la frase "scheda del corso". `scheda_inviata_at`: lucchetto e idempotenza
-- dell'invio del PDF (una volta sola per chat). Nullable, nessun indice, nessun backfill.

alter table public.conversations
  add column if not exists professione text,
  add column if not exists scheda_inviata_at timestamptz;

comment on column public.conversations.professione is
  'Slug del corso del funnel Professioni (sviluppatore_web_ai, video_editor, project_manager, graphic_designer, copywriter, social_media_manager).';
comment on column public.conversations.scheda_inviata_at is
  'Quando e'' partita la scheda PDF del corso. Lucchetto compare-and-set di lib/scheda-invio.ts.';
```

- [ ] **Step 2: tipi** — in `lib/supabase/types.ts`, tabella `conversations`: aggiungi `professione: string | null` e `scheda_inviata_at: string | null` in `Row`, e `professione?: string | null`, `scheda_inviata_at?: string | null` in `Insert` e `Update`, in ordine alfabetico come le colonne vicine.
- [ ] **Step 3:** `bun run typecheck` → PASS.
- [ ] **Step 4: commit** `feat(professioni): colonne professione e scheda_inviata_at`

### Task 4: Adozione, colonna `professione` e push al CRM (bot)

**Files:** Modify `lib/lead-entrante.ts`, `app/api/webhooks/twilio/route.ts`, `app/api/cron/adotta-mai-risposti/route.ts`; Create `lib/professione-chat.ts`, `lib/professione-chat.test.ts`; Modify test esistente di `lib/lead-entrante` se presente (`lib/lead-entrante.test.ts`).

**Interfaces:**
- Consumes: Task 1–3.
- Produces: `PushLeadEntranteArgs.professione?: SlugProfessione | null` (nel body JSON solo se valorizzato); `segnaProfessione(supabase, conversationId, testo): Promise<SlugProfessione | null>`.

- [ ] **Step 1: test** (`lib/professione-chat.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest';
import { segnaProfessione } from './professione-chat';

function fakeSupa() {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
  const insert = vi.fn(async () => ({ error: null }));
  return { from: vi.fn((t: string) => (t === 'conversations' ? { update } : { insert })), update, insert };
}

describe('segnaProfessione', () => {
  it('scrive lo slug quando c\'e\' la frase e il corso', async () => {
    const s = fakeSupa();
    const r = await segnaProfessione(s as never, 7, 'Ciao, sono interessato alla professione di Copywriter e vorrei ricevere la scheda del corso');
    expect(r).toBe('copywriter');
    expect(s.update).toHaveBeenCalledWith({ professione: 'copywriter' });
  });
  it('non tocca niente senza la frase', async () => {
    const s = fakeSupa();
    expect(await segnaProfessione(s as never, 7, 'mi interessa il copywriter')).toBeNull();
    expect(s.update).not.toHaveBeenCalled();
  });
  it('frase senza corso: niente update', async () => {
    const s = fakeSupa();
    expect(await segnaProfessione(s as never, 7, 'la scheda del corso?')).toBeNull();
    expect(s.update).not.toHaveBeenCalled();
  });
});
```

E in `lib/lead-entrante.test.ts` (crealo se non c'è, mockando `fetch`): con `professione: 'video_editor'` il body JSON contiene `"professione":"video_editor"`; senza, la chiave non c'è.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pushLeadEntrante } from './lead-entrante';

const supa = { from: vi.fn(() => ({ update: () => ({ eq: async () => ({}) }), insert: async () => ({}) })) };
beforeEach(() => { process.env.BOT_WEBHOOK_SECRET = 's'; });

describe('pushLeadEntrante professione', () => {
  it('manda professione solo se valorizzata', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => { bodies.push(init.body); return new Response('{"ok":true,"leadId":"L"}'); }));
    const base = { conversationId: 1, telefono: '+393331112222', nome: null, provenienza: 'PROFESSIONI' as const, primoMessaggio: 'x', scrittoIl: '2026-10-14T10:00:00+02:00' };
    await pushLeadEntrante(supa as never, { ...base, professione: 'video_editor' });
    await pushLeadEntrante(supa as never, base);
    expect(JSON.parse(bodies[0]).professione).toBe('video_editor');
    expect('professione' in JSON.parse(bodies[1])).toBe(false);
  });
});
```

- [ ] **Step 2:** `bun run test lib/professione-chat.test.ts lib/lead-entrante.test.ts` → FAIL.
- [ ] **Step 3: implementazione**

`lib/professione-chat.ts`:
```ts
import type { getSupabaseAdmin } from './supabase/admin';
import { isMarkerProfessioni, riconosciProfessione, type SlugProfessione } from './professioni';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Il lead ha mandato la frase del funnel Professioni: si segna il corso sulla chat, che sia
 * appena adottata o gia' aperta da tempo (spec §1). Il funnel CRM non si tocca: quello si
 * decide solo all'adozione. Senza frase o senza corso riconosciuto non scrive niente.
 */
export async function segnaProfessione(supabase: Supa, conversationId: number, testo: string | null | undefined): Promise<SlugProfessione | null> {
  if (!isMarkerProfessioni(testo)) return null;
  const slug = riconosciProfessione(testo);
  if (!slug) return null;
  const { error } = await supabase.from('conversations').update({ professione: slug }).eq('id', conversationId);
  if (error) {
    await supabase.from('event_log').insert({
      type: 'professione_non_scritta',
      payload: { conversationId, slug, errore: error.message } as never,
      message: `[professioni] conv ${conversationId}: corso ${slug} NON scritto — ${error.message}`,
      level: 'warn',
    });
    return null;
  }
  await supabase.from('event_log').insert({
    type: 'professione_segnata',
    payload: { conversationId, slug } as never,
    message: `[professioni] conv ${conversationId}: interessato a ${slug}`,
    level: 'info',
  });
  return slug;
}
```

`lib/lead-entrante.ts`: aggiungi a `PushLeadEntranteArgs` `professione?: SlugProfessione | null;` (import type da `./professioni`), a `LeadEntranteBody` `professione?: string;`, e nel body `...(args.professione ? { professione: args.professione } : {}),`.

`app/api/webhooks/twilio/route.ts`:
- nel ramo adozione riuscita, nel `pushLeadEntrante(...)` aggiungi `professione: esito.tipo === 'professioni' ? esito.professione : null,`;
- subito DOPO il blocco del link Sviluppatore (prima di `segnalaRispostaDopoTerzoNr`), aggiungi:
```ts
      // Funnel Professioni (PO 14/10/2026): la frase "scheda del corso" segna il corso sulla
      // chat, adottata adesso o gia' aperta. Serve alla nota di Mario e all'invio del PDF.
      if (conv && !markerPulsante) {
        const slug = await segnaProfessione(supabase, conversationId, messageBody);
        if (slug) conv.professione = slug;
      }
```
  (aggiungi `professione` al tipo/select di `conv` in quel file se tsc lo chiede).

`app/api/cron/adotta-mai-risposti/route.ts`: nel `pushLeadEntrante` aggiungi `professione: esito.tipo === 'professioni' ? esito.professione : null,` e, subito prima, `if (esito.tipo === 'professioni') await segnaProfessione(admin, c.id, primoRiga?.body);`.

- [ ] **Step 4:** `bun run test lib/professione-chat.test.ts lib/lead-entrante.test.ts && bun run test app/api && bun run typecheck` → PASS.
- [ ] **Step 5: commit** `feat(professioni): la chat segna il corso e il push al CRM lo porta`

### Task 5: Tag `[SCHEDA:<slug>]` nel parser di Mario (bot)

**Files:** Modify `lib/mario.ts`, `lib/mario-parse.test.ts`

**Interfaces:** Produces `MarioResult.schedaRichiesta?: SlugProfessione` e `MarioResult.schedaNonValida?: string`.

- [ ] **Step 1: test** (in `lib/mario-parse.test.ts`)

```ts
describe('[SCHEDA]', () => {
  it('slug valido: tolto dal testo e restituito', () => {
    const r = parseMarioReply('Ecco qua\n[SCHEDA:video_editor]');
    expect(r.schedaRichiesta).toBe('video_editor');
    expect(r.visibleReply).toBe('Ecco qua');
  });
  it('slug inventato: tolto dal testo, segnalato, niente scheda', () => {
    const r = parseMarioReply('Te la mando [SCHEDA:pizzaiolo]');
    expect(r.schedaRichiesta).toBeUndefined();
    expect(r.schedaNonValida).toBe('pizzaiolo');
    expect(r.visibleReply).toBe('Te la mando');
  });
  it('senza tag nessun campo', () => {
    expect(parseMarioReply('ciao').schedaRichiesta).toBeUndefined();
  });
});
```

- [ ] **Step 2:** `bun run test lib/mario-parse.test.ts` → FAIL.
- [ ] **Step 3: implementazione** in `lib/mario.ts`: import `isSlugProfessione, type SlugProfessione` da `./professioni`; aggiungi i due campi al tipo `MarioResult` con doc; poi

```ts
const SCHEDA_RE = /\[SCHEDA:([^\]]*)\]/gi;
```
in `parseMarioReply`:
```ts
  const schedaArg = [...raw.matchAll(SCHEDA_RE)].map((m) => (m[1] ?? '').trim().toLowerCase())[0];
  const schedaRichiesta = schedaArg && isSlugProfessione(schedaArg) ? schedaArg : undefined;
  const schedaNonValida = schedaArg && !schedaRichiesta ? schedaArg : undefined;
```
aggiungi `.replace(SCHEDA_RE, '')` alla catena del `visibleReply` e `schedaRichiesta, schedaNonValida` all'oggetto restituito.
- [ ] **Step 4:** `bun run test lib/mario-parse.test.ts lib/mario.test.ts` → PASS.
- [ ] **Step 5: commit** `feat(professioni): Mario puo' chiedere l'invio della scheda col tag [SCHEDA]`

### Task 6: Invio del PDF (bot)

**Files:** Modify `lib/twilio.ts` (`SendFreeTextInput.mediaUrl?: string[]`); Create `lib/scheda-invio.ts`, `lib/scheda-invio.test.ts`

**Interfaces:**
- Produces: `inviaScheda(supabase, { conversationId, phone, from, slug, momento: 'pre_appuntamento' | 'post_appuntamento' }): Promise<'inviata' | 'gia_inviata' | 'fallita'>`; `testoScheda(slug): string`.

- [ ] **Step 1: test** (`lib/scheda-invio.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM1', status: 'queued' })) }));
import { sendFreeText } from './twilio';
import { inviaScheda, testoScheda } from './scheda-invio';

function supa(claimRows: unknown[]) {
  const inserts: Array<[string, unknown]> = [];
  const updates: unknown[] = [];
  const chain = {
    update: (v: unknown) => { updates.push(v); return chain; },
    eq: () => chain, is: () => chain,
    select: async () => ({ data: claimRows, error: null }),
  };
  return {
    inserts, updates,
    from: (t: string) => (t === 'conversations' ? chain : { insert: async (v: unknown) => { inserts.push([t, v]); return { error: null }; } }),
  };
}

beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://bot.app'; vi.mocked(sendFreeText).mockClear(); });

describe('inviaScheda', () => {
  it('prima volta: manda il PDF e registra messaggio ed evento', async () => {
    const s = supa([{ id: 1 }]);
    const r = await inviaScheda(s as never, { conversationId: 1, phone: '+39333', from: 'whatsapp:+393520413199', slug: 'copywriter', momento: 'post_appuntamento' });
    expect(r).toBe('inviata');
    expect(sendFreeText).toHaveBeenCalledWith({ to: '+39333', from: 'whatsapp:+393520413199', body: testoScheda('copywriter'), mediaUrl: ['https://bot.app/schede/copywriter.pdf'] });
    expect(s.inserts.map(([t]) => t)).toEqual(['messages', 'event_log']);
  });
  it('gia\' inviata: niente invio', async () => {
    const s = supa([]);
    expect(await inviaScheda(s as never, { conversationId: 1, phone: '+39333', from: 'x', slug: 'copywriter', momento: 'post_appuntamento' })).toBe('gia_inviata');
    expect(sendFreeText).not.toHaveBeenCalled();
  });
  it('Twilio fallisce: rilascia il lucchetto e logga', async () => {
    vi.mocked(sendFreeText).mockRejectedValueOnce(new Error('boom'));
    const s = supa([{ id: 1 }]);
    expect(await inviaScheda(s as never, { conversationId: 1, phone: '+39333', from: 'x', slug: 'copywriter', momento: 'pre_appuntamento' })).toBe('fallita');
    expect(s.updates).toContainEqual({ scheda_inviata_at: null });
    expect(s.inserts.some(([t, v]) => t === 'event_log' && (v as { type: string }).type === 'scheda_invio_fallito')).toBe(true);
  });
});
```

- [ ] **Step 2:** `bun run test lib/scheda-invio.test.ts` → FAIL.
- [ ] **Step 3: implementazione**

`lib/twilio.ts`: in `SendFreeTextInput` aggiungi `mediaUrl?: string[];` e in `messages.create` `...(input.mediaUrl?.length ? { mediaUrl: input.mediaUrl } : {}),`.

`lib/scheda-invio.ts`:
```ts
import type { getSupabaseAdmin } from './supabase/admin';
import { sendFreeText } from './twilio';
import { nomeProfessione, urlScheda, type SlugProfessione } from './professioni';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export function testoScheda(slug: SlugProfessione): string {
  return `Ecco la scheda del corso di ${nomeProfessione(slug)} 👇`;
}

/**
 * Manda la scheda PDF del corso, una volta sola per chat (spec §3). Il lucchetto e' un
 * compare-and-set su `scheda_inviata_at`: due drain in volo non la mandano due volte. Se
 * Twilio fallisce il lucchetto si rilascia (la prossima occasione ci riprova) e si logga;
 * nessun ripiego su un altro numero.
 */
export async function inviaScheda(
  supabase: Supa,
  i: { conversationId: number; phone: string; from: string; slug: SlugProfessione; momento: 'pre_appuntamento' | 'post_appuntamento' },
): Promise<'inviata' | 'gia_inviata' | 'fallita'> {
  const adesso = new Date().toISOString();
  const { data: prese } = await supabase.from('conversations')
    .update({ scheda_inviata_at: adesso })
    .eq('id', i.conversationId).is('scheda_inviata_at', null).select('id');
  if (!prese || prese.length === 0) return 'gia_inviata';

  const body = testoScheda(i.slug);
  try {
    const sent = await sendFreeText({ to: i.phone, from: i.from, body, mediaUrl: [urlScheda(i.slug)] });
    await supabase.from('messages').insert({
      conversation_id: i.conversationId, direction: 'out', body,
      twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
    });
    await supabase.from('event_log').insert({
      type: 'scheda_inviata',
      payload: { conversationId: i.conversationId, slug: i.slug, momento: i.momento } as never,
      message: `[professioni] conv ${i.conversationId}: scheda ${i.slug} inviata (${i.momento})`,
      level: 'info',
    });
    return 'inviata';
  } catch (e) {
    await supabase.from('conversations').update({ scheda_inviata_at: null }).eq('id', i.conversationId);
    const errore = e instanceof Error ? e.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'scheda_invio_fallito',
      payload: { conversationId: i.conversationId, slug: i.slug, momento: i.momento, errore } as never,
      message: `[professioni] conv ${i.conversationId}: scheda ${i.slug} NON inviata — ${errore}`,
      level: 'error',
    });
    return 'fallita';
  }
}
```
- [ ] **Step 4:** `bun run test lib/scheda-invio.test.ts lib/twilio.test.ts` (se esiste) `&& bun run typecheck` → PASS.
- [ ] **Step 5: commit** `feat(professioni): invio della scheda PDF una volta sola per chat`

### Task 7: Mario nel funnel — nota di contesto e invii nel drain (bot)

**Files:** Create `lib/professioni-nota.ts`, `lib/professioni-nota.test.ts`; Modify `lib/fenice-autoreply.ts`

**Interfaces:**
- Consumes: Task 1, 5, 6.
- Produces: `professioniContextNote(slug: SlugProfessione | null): string`; `schedaDaInviare(i: { professione: string | null; schedaInviataAt: string | null; schedaRichiesta?: SlugProfessione; appuntamentoConVideoOra: boolean }): { slug: SlugProfessione; momento: 'pre_appuntamento' | 'post_appuntamento' } | null`.

- [ ] **Step 1: test** (`lib/professioni-nota.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { professioniContextNote, schedaDaInviare } from './professioni-nota';

describe('professioniContextNote', () => {
  it('nomina il corso, la regola della scheda dopo l\'appuntamento e il tag', () => {
    const n = professioniContextNote('video_editor');
    expect(n).toContain('Video Editor');
    expect(n).toContain('[SCHEDA:video_editor]');
    expect(n).toMatch(/dopo/i);
  });
  it('senza corso chiede quale e mostra gli slug', () => {
    expect(professioniContextNote(null)).toContain('social_media_manager');
  });
});

describe('schedaDaInviare', () => {
  const base = { professione: 'copywriter', schedaInviataAt: null, appuntamentoConVideoOra: false };
  it('tag del modello → pre_appuntamento', () => {
    expect(schedaDaInviare({ ...base, schedaRichiesta: 'copywriter' })).toEqual({ slug: 'copywriter', momento: 'pre_appuntamento' });
  });
  it('video dell\'appuntamento uscito ora → post_appuntamento', () => {
    expect(schedaDaInviare({ ...base, appuntamentoConVideoOra: true })).toEqual({ slug: 'copywriter', momento: 'post_appuntamento' });
  });
  it('gia\' inviata → null', () => {
    expect(schedaDaInviare({ ...base, schedaInviataAt: '2026-10-14T10:00:00Z', appuntamentoConVideoOra: true })).toBeNull();
  });
  it('lead normale senza professione → null anche con appuntamento', () => {
    expect(schedaDaInviare({ ...base, professione: null, appuntamentoConVideoOra: true })).toBeNull();
  });
  it('professione salvata non valida → null', () => {
    expect(schedaDaInviare({ ...base, professione: 'boh', appuntamentoConVideoOra: true })).toBeNull();
  });
});
```

- [ ] **Step 2:** `bun run test lib/professioni-nota.test.ts` → FAIL.
- [ ] **Step 3: implementazione** (`lib/professioni-nota.ts`)

```ts
import { PROFESSIONI, isSlugProfessione, nomeProfessione, type SlugProfessione } from './professioni';

/**
 * Nota di contesto per chi arriva dal funnel Professioni (spec §2). Sta nella parte
 * variabile del prompt: il manuale di Mario resta identico e la cache non si rompe.
 */
export function professioniContextNote(slug: SlugProfessione | null): string {
  const corso = slug
    ? `Il corso che ha scelto e' ${nomeProfessione(slug)}.`
    : `Non sappiamo ancora quale corso: chiediglielo (falso bivio se e' indeciso). Slug possibili: ${PROFESSIONI.map((p) => p.slug).join(', ')}.`;
  const tag = slug ? `[SCHEDA:${slug}]` : '[SCHEDA:<slug>]';
  return [
    'CONTESTO FUNNEL PROFESSIONI: questo lead ci ha scritto per primo dalla pagina delle professioni e ha chiesto la scheda del corso.',
    corso,
    "APERTURA: digli che gli mandi volentieri la scheda del corso e che prima gli fai qualche domanda per capire cosa gli serve. Poi segui il flusso normale (situazione, famiglia, motivazioni, pitch con i prezzi, call, Noemi).",
    "LA SCHEDA ARRIVA DOPO L'APPUNTAMENTO: quando ha fissato, la scheda gli arriva in automatico insieme al video. Non mandarla prima e non promettere che arriva subito.",
    `SE INSISTE per averla prima di fissare (es. "mi avevate detto che me la mandavate"): mandala insieme al pitch, prezzi compresi, e nello stesso messaggio proponi comunque la call. Per mandarla scrivi in fondo al messaggio il tag ${tag}.`,
    `SE RIMANDA LA CALL PER GUARDARE PRIMA LA SCHEDA: mandala col tag ${tag} e prendi un impegno sul quando: deve averla vista entro domani, ci vogliono due minuti. Il quando lo dice lui (regola "PRIMA GUARDO IL CORSO").`,
    `Il tag ${tag} lo usi al massimo una volta: se la scheda e' gia' partita non rimandarla.`,
  ].join('\n');
}

export function schedaDaInviare(i: {
  professione: string | null;
  schedaInviataAt: string | null;
  schedaRichiesta?: SlugProfessione;
  appuntamentoConVideoOra: boolean;
}): { slug: SlugProfessione; momento: 'pre_appuntamento' | 'post_appuntamento' } | null {
  if (i.schedaInviataAt) return null;
  if (i.appuntamentoConVideoOra && isSlugProfessione(i.professione)) return { slug: i.professione, momento: 'post_appuntamento' };
  if (i.schedaRichiesta) return { slug: i.schedaRichiesta, momento: 'pre_appuntamento' };
  return null;
}
```

- [ ] **Step 4: integrazione in `lib/fenice-autoreply.ts`**
  1. Nella `.select(...)` del claim di `drainMarioReplies` aggiungi `professione, scheda_inviata_at` e tienili in variabili locali (`let schedaInviataAt = claimed.scheda_inviata_at as string | null; const professione = claimed.professione as string | null;`).
  2. Dopo `notaStudente`, prima di `generateMarioReply`:
```ts
      // Funnel Professioni (PO 14/10/2026): fuori dal lancio e dal postino, la chat col corso
      // segnato riceve la sua nota (si somma alla dichiarazione IA del primo contatto).
      const notaProfessioni = !postino && !lancio.lancio_slug && professione !== null
        ? [professioniContextNote(isSlugProfessione(professione) ? professione : null), notaPrimo].filter(Boolean).join('\n\n')
        : null;
```
     e nella catena del `contextNote` inserisci `: notaProfessioni ? { contextNote: notaProfessioni }` subito dopo il ramo `notaStudente`.
  3. Dopo il ciclo `for` che manda `parts` (e dopo l'aggiornamento di `last_message_at`):
```ts
      // Scheda del corso (spec §3): dopo l'appuntamento esce col video, prima solo se Mario
      // l'ha chiesta col tag. `inviaScheda` e' idempotente sulla colonna.
      if (result.schedaNonValida) {
        await supabase.from('event_log').insert({
          type: 'scheda_slug_non_valido',
          payload: { conversationId, slug: result.schedaNonValida } as never,
          message: `[professioni] conv ${conversationId}: Mario ha chiesto la scheda "${result.schedaNonValida}" che non esiste`,
          level: 'warn',
        });
      }
      const scheda = schedaDaInviare({
        professione,
        schedaInviataAt,
        schedaRichiesta: result.schedaRichiesta,
        appuntamentoConVideoOra: result.appointmentFixed && !videoGiaInviato && parts.some((p) => containsVideoLink(p, linkExtra)),
      });
      if (scheda) {
        const esitoScheda = await inviaScheda(supabase, { conversationId, phone, from, ...scheda });
        if (esitoScheda === 'inviata') schedaInviataAt = new Date().toISOString();
      }
```
  4. Import: `professioniContextNote, schedaDaInviare` da `./professioni-nota`, `isSlugProfessione` da `./professioni`, `inviaScheda` da `./scheda-invio`.
- [ ] **Step 5: test di integrazione** in `lib/fenice-autoreply.test.ts`, seguendo lo stile dei test esistenti del drain (mock di `./twilio` e del modello): (a) chat con `professione='copywriter'`, modello che risponde con blocco appuntamento + link `https://corso.feniceacademy.it/conferenza-bx` → `sendFreeText` chiamato anche con `mediaUrl: [.../schede/copywriter.pdf]`; (b) stessa risposta su chat con `professione=null` → nessuna chiamata con `mediaUrl`; (c) risposta con `[SCHEDA:copywriter]` senza appuntamento → PDF inviato e tag assente dal testo inviato.
- [ ] **Step 6:** `bun run test lib/professioni-nota.test.ts lib/fenice-autoreply.test.ts && bun run typecheck` → PASS.
- [ ] **Step 7: commit** `feat(professioni): Mario conosce il funnel e la scheda parte col video`

### Task 8: Scheda Sviluppatore Web AI nel prompt di Mario (bot)

**Files:** Modify `lib/mario-prompt.ts` (blocco `WEB DEVELOPER` nella sezione `I CORSI, SCHEDE DETTAGLIATE`), `lib/mario-prompt.test.ts`

- [ ] **Step 1: test** (in `lib/mario-prompt.test.ts`)

```ts
it('la scheda del web developer e\' quella Sviluppatore Web AI', () => {
  const p = buildMarioSystem('Mario');
  expect(p).toContain('SVILUPPATORE WEB AI');
  expect(p).toContain('Vincenzo Filangeri');
  expect(p).not.toContain('Zanarella');
});
```
- [ ] **Step 2:** `bun run test lib/mario-prompt.test.ts` → FAIL.
- [ ] **Step 3:** sostituisci l'intero blocco da `WEB DEVELOPER` fino alla riga `Sbocchi: frontend developer, …` con:

```
SVILUPPATORE WEB AI
Lo Sviluppatore Web AI progetta, realizza e pubblica siti e applicazioni web, dall'interfaccia fino al server e al database. Usa l'intelligenza artificiale ogni giorno per scrivere codice, risolvere errori e velocizzare lo sviluppo, ma verifica ogni risultato e resta responsabile della qualità del codice.
Docente: Vincenzo Filangeri (sviluppatore full stack da 5 anni, progetti per aziende ed e-commerce tra cui PepsiCo e Calzedonia, laurea in Ingegneria Informatica e magistrale in intelligenza artificiale, formazione internazionale al MIT di Boston).
Cosa si impara: setup e fondamenti dell'AI, VS Code, GitHub e Copilot, prompt e contesto, HTML, CSS, Flexbox e Grid, responsive design, JavaScript con l'AI, DOM, API REST, Node.js ed Express, database SQL, un progetto full stack completo, Git, pubblicazione con Vercel e dominio personalizzato, uso sicuro dell'AI (privacy, segreti, licenze).
Sbocchi: sviluppatore web junior, frontend o full stack developer junior, freelance che realizza siti e applicazioni per aziende e professionisti.
```
  Se altri punti del prompt nominano "web developer" come nome del corso, lasciali: il nome commerciale resta riconoscibile.
- [ ] **Step 4:** `bun run test lib/mario-prompt.test.ts` → PASS (aggiorna eventuali snapshot che contengono il vecchio blocco).
- [ ] **Step 5: commit** `fix(mario): scheda del corso Sviluppatore Web AI aggiornata`

### Task 9: Sollecito dedicato entro 24 ore (bot)

**Files:** Modify `lib/sequence.ts`, `lib/sequence.test.ts`, `app/api/cron/sequence-touches/route.ts`

**Interfaces:** Produces `pickNudgeTextScheda(firstName: string | null, slug: SlugProfessione): string`; `usaNudgeScheda(c: { scheda_inviata_at: string | null; bot_outcome: string | null; professione: string | null }): SlugProfessione | null`.

- [ ] **Step 1: test** (in `lib/sequence.test.ts`)

```ts
import { pickNudgeTextScheda, usaNudgeScheda } from './sequence';
describe('nudge scheda', () => {
  it('testo col nome e il corso, forma neutra (non si indovina il genere)', () => {
    expect(pickNudgeTextScheda('Anna', 'copywriter'))
      .toBe("Anna, hai dato un'occhiata alla scheda di Copywriter? Ci vogliono due minuti. Così fissiamo la call e ne parliamo con calma");
    expect(pickNudgeTextScheda(null, 'video_editor'))
      .toBe("Hai dato un'occhiata alla scheda di Video Editor? Ci vogliono due minuti. Così fissiamo la call e ne parliamo con calma");
  });
  it('solo con scheda inviata e senza appuntamento', () => {
    expect(usaNudgeScheda({ scheda_inviata_at: 'x', bot_outcome: null, professione: 'copywriter' })).toBe('copywriter');
    expect(usaNudgeScheda({ scheda_inviata_at: 'x', bot_outcome: 'APPUNTAMENTO', professione: 'copywriter' })).toBeNull();
    expect(usaNudgeScheda({ scheda_inviata_at: null, bot_outcome: null, professione: 'copywriter' })).toBeNull();
  });
});
```
- [ ] **Step 2:** `bun run test lib/sequence.test.ts` → FAIL.
- [ ] **Step 3: implementazione** in `lib/sequence.ts` (riusa `firstNameOf` già presente):

```ts
import { isSlugProfessione, nomeProfessione, type SlugProfessione } from './professioni';

/** Funnel Professioni (spec §4): chi ha avuto la scheda e non ha fissato riceve questo. */
export function pickNudgeTextScheda(firstName: string | null, slug: SlugProfessione): string {
  const clean = firstNameOf(firstName);
  const domanda = `dato un'occhiata alla scheda di ${nomeProfessione(slug)}? Ci vogliono due minuti. Così fissiamo la call e ne parliamo con calma`;
  return clean ? `${clean}, hai ${domanda}` : `Hai ${domanda}`;
}

export function usaNudgeScheda(c: { scheda_inviata_at: string | null; bot_outcome: string | null; professione: string | null }): SlugProfessione | null {
  if (!c.scheda_inviata_at || c.bot_outcome === 'APPUNTAMENTO') return null;
  return isSlugProfessione(c.professione) ? c.professione : null;
}
```
  In `app/api/cron/sequence-touches/route.ts`: aggiungi `professione, scheda_inviata_at` alla `.select(...)` della riga 188 e sostituisci `const body = pickNudgeText(c.id, firstName, PERSONA_NAME[persona]);` con:
```ts
      const slugScheda = usaNudgeScheda(c as { scheda_inviata_at: string | null; bot_outcome: string | null; professione: string | null });
      const body = slugScheda ? pickNudgeTextScheda(firstName, slugScheda) : pickNudgeText(c.id, firstName, PERSONA_NAME[persona]);
```
- [ ] **Step 4:** `bun run test lib/sequence.test.ts app/api/cron && bun run typecheck && bun run test && bun run build` → tutto PASS.
- [ ] **Step 5: commit** `feat(professioni): sollecito dedicato a chi ha la scheda e non ha fissato`

### Task 10: CRM — `professione` nel lead entrante e funnel fisso

**Files (repo CRM):** Modify `src/lib/bot-fissatore/leadEntranti.ts`, `src/lib/bot-fissatore/leadEntranti.test.ts`, `src/lib/kpi/marketingFunnels.ts`, `src/app/actions/panoramicaActions.ts`

**Interfaces:** `LeadEntranteRaw.professione?: string | null`; `LeadEntranteNormalizzato.professione: string | null` (nome leggibile del corso o null); metadata IMPORTED con `note: 'Interessato a: <Nome>'`.

- [ ] **Step 1: test** (in `leadEntranti.test.ts`, seguendo i test esistenti di `normalizzaLeadEntrante`/`eventiNuovoLead`)

```ts
describe('funnel Professioni', () => {
  const raw = { telefono: '+393331112222', provenienza: 'PROFESSIONI', primoMessaggio: 'x', scrittoIl: '2026-10-14T10:00:00+02:00', conversationId: 5 };
  it('funnel PROFESSIONI e corso leggibile', () => {
    const r = normalizzaLeadEntrante({ ...raw, professione: 'video_editor' });
    expect(r.ok && r.lead.funnel).toBe('PROFESSIONI');
    expect(r.ok && r.lead.professione).toBe('Video Editor');
  });
  it('slug sconosciuto o assente → null, il lead resta valido', () => {
    const a = normalizzaLeadEntrante({ ...raw, professione: 'pizzaiolo' });
    const b = normalizzaLeadEntrante(raw);
    expect(a.ok && a.lead.professione).toBeNull();
    expect(b.ok && b.lead.professione).toBeNull();
  });
  it('la nota sulla timeline', () => {
    const r = normalizzaLeadEntrante({ ...raw, professione: 'copywriter' });
    if (!r.ok) throw new Error('atteso ok');
    const v = valoriNuovoLead(r.lead, 'bot', new Date(), 'id1');
    expect(eventiNuovoLead(r.lead, v)[0].metadata.note).toBe('Interessato a: Copywriter');
  });
});
```
- [ ] **Step 2:** `npx vitest run src/lib/bot-fissatore/leadEntranti.test.ts` → FAIL.
- [ ] **Step 3: implementazione**
  - in `leadEntranti.ts`:
```ts
/** Funnel Professioni (bot, 14/10/2026): slug del corso → nome sulla timeline. */
const PROFESSIONI_NOMI: Record<string, string> = {
    sviluppatore_web_ai: 'Sviluppatore Web AI',
    video_editor: 'Video Editor',
    project_manager: 'Project Manager',
    graphic_designer: 'Graphic Designer',
    copywriter: 'Copywriter',
    social_media_manager: 'Social Media Manager',
};
```
    `LeadEntranteRaw`: `professione?: string | null;` · `LeadEntranteNormalizzato`: `professione: string | null;` · in `normalizzaLeadEntrante`: `const professione = typeof raw.professione === 'string' ? PROFESSIONI_NOMI[raw.professione.trim().toLowerCase()] ?? null : null;` e `professione,` nell'oggetto `lead` · in `eventiNuovoLead`, metadata dell'evento IMPORTED: `...(lead.professione ? { note: \`Interessato a: ${lead.professione}\` } : {}),`.
  - Correggi gli altri costruttori di `LeadEntranteNormalizzato` segnalati da tsc (test/fixture) aggiungendo `professione: null`.
  - `src/lib/kpi/marketingFunnels.ts`: aggiungi `'PROFESSIONI',` in coda a `PINNED_FUNNELS`.
  - `src/app/actions/panoramicaActions.ts:1228`: aggiungi `'PROFESSIONI'` in coda a `CANONICAL_ORDER`.
- [ ] **Step 4:** `npx vitest run src/lib/bot-fissatore src/lib/kpi && npx tsc --noEmit && npm run build` → PASS.
- [ ] **Step 5: commit** (repo CRM, su main) `feat(professioni): il lead entrante porta il corso scelto e il funnel PROFESSIONI e' fisso in Panoramica`

### Task 11: Rilascio, prova e link

- [ ] **Step 1: CRM** — `git push origin main` dal repo CRM; verifica deploy Ready (Vercel MCP `list_deployments` sul progetto CRM) e che `/api/bot/lead-entrante` senza firma risponda 401.
- [ ] **Step 2: migrazione bot** — applica `supabase/migrations/20261014000001_professioni.sql` col tool `mcp__supabase-bot__apply_migration` (name `professioni`); verifica con `select column_name from information_schema.columns where table_name='conversations' and column_name in ('professione','scheda_inviata_at')` → 2 righe.
- [ ] **Step 3: bot** — merge di `feat/funnel-professioni` in `main` del bot (fast-forward su `origin/main` aggiornato) e `git push origin main`; verifica deploy Ready e che `https://web-app-messaggistica.vercel.app/schede/copywriter.pdf` risponda 200 `application/pdf`.
- [ ] **Step 4: prova reale** — chiedi a Bruno di scrivere da un suo numero il link del Copywriter. Verifica: `conversations.professione='copywriter'`, `crm_funnel='PROFESSIONI'`, evento `lead_entrante_push`, lead nel CRM con funnel `PROFESSIONI` e nota "Interessato a: Copywriter", risposta di Mario con l'apertura della nota. Fino all'appuntamento la scheda non deve partire.
- [ ] **Step 5: i 6 link per il marketing** — genera con
```bash
python -I -c "import urllib.parse as u;[print(f'{n}: https://wa.me/393520413199?text='+u.quote(f'Ciao, sono interessato alla professione di {n} e vorrei ricevere la scheda del corso')) for n in ['Sviluppatore Web AI','Video Editor','Project Manager','Graphic Designer','Copywriter','Social Media Manager']]"
```
  e consegnali a Bruno in un unico messaggio pronto da inoltrare.
- [ ] **Step 6: memoria** — aggiorna `project_3199_solo_inbound_funnel_professioni.md` con commit, stato LIVE e link.
