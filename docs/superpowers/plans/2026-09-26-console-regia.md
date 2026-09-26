# Console "Regia" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una console unica `/console` per l'admin (grafica "Regia") con 9 viste chat, barra di regia del lancio, avvisi di sistema con pulsanti di rimedio e Assistente Claude, senza toccare le pagine esistenti.

**Architecture:** Nuovo route group `app/(console)` con CSS e primitivi propri scoped a `[data-console]`; logica pura in `lib/console/*` (testata con Vitest) e API sottili in `app/api/console/*`. Le capacità esistenti (pausa bot, invio, segna letta, cron, arretrati, resend-outcome, impostazioni lancio) si riusano chiamando le stesse rotte o le stesse funzioni `lib/`, mai duplicandone la logica.

**Tech Stack:** Next 16.2.4 (App Router, `proxy.ts`, `params` Promise), React 19.2, Tailwind v4 (solo per layout di utilità; i colori vengono dai token CSS), Supabase JS (niente Drizzle), `@anthropic-ai/sdk`, Vitest, bun. Nuove dipendenze: `virtua`, `nuqs`, `cmdk`.

**Spec:** `docs/superpowers/specs/2026-09-26-console-regia-design.md` · Mockup: `docs/design/console-regia-mockup.html` · Regole: `docs/design/direzione-console-anti-slop.md`

## Global Constraints

- Leggere `node_modules/next/dist/docs/` per ogni API Next usata (regola del repo, AGENTS.md).
- Comandi: `bun run test` (Vitest), `bunx vitest run <file>`, `bun run typecheck`, `bun run build`, `bun run check:slop`.
- Test accanto al modulo (`lib/console/viste.test.ts`, `app/api/console/viste/route.test.ts`).
- Nessuna migrazione DB. Registro azioni in `event_log` (`type='console_azione'`), avvisi risolti `type='console_avviso_risolto'`.
- Pagine e componenti esistenti NON si modificano (eccezioni ammesse: `lib/access.ts` e il suo test).
- Dentro `app/(console)` e `components/console` vietato importare `@/components/ui/*` e usare `bg-zinc-*`, `text-amber-*` o qualunque colore Tailwind: solo `var(--…)` dei token.
- Token, font e misure: quelli del mockup (`docs/design/console-regia-mockup.html` righe 30-329), scoped a `[data-console]` e `[data-console][data-theme="light"]`.
- Font: Schibsted Grotesk 400/500/600 (interfaccia), JetBrains Mono 400/500 (solo dati). Niente Geist/Inter/Bricolage nella console.
- Icone: solo `lucide-react`, `size={16}`, `strokeWidth={1.75}`. Vietate Sparkles, Zap, Rocket, Wand. Nessuna emoji nell'interfaccia.
- Niente `uppercase`/`tracking-wide*`, niente `transition-all`, `animate-pulse`, `animate-bounce`, `backdrop-blur`, `bg-gradient*`, `bg-clip-text`, `border-l-[2-9]`.
- Animazioni ≤ 200 ms, `cubic-bezier(0.23,1,0.32,1)`, solo `transform`/`opacity`; nessuna animazione su apertura chat, cambio vista, `j/k`, `Ctrl+K`; regola `prefers-reduced-motion`.
- `font-variant-numeric: tabular-nums` su contatori, orari, KPI.
- Microcopy in italiano, verbi sui bottoni, `…` sulle azioni che aprono altro; errori che dicono cosa è successo e come si recupera.
- Account console: `admin@fenice.com`, area `all`. Password mai nel repo.
- Modello Assistente: `claude-sonnet-5`.
- PostgREST taglia a 1.000 righe: ogni lettura che può superarle usa `fetchAllRows` (`lib/supabase/paginate.ts`) o un cursore; `in.()` mai con lista vuota; liste di id a blocchi da 200.
- Commit piccoli, messaggio in italiano stile repo (`feat(console): …`), chiusi con `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Lista vuota e `in.()`**: vista "Con errori" senza errori, ricerca senza risultati → lista vuota e contatore 0, mai "tutte le chat" né 500. Test in Task 5.
2. **Doppio clic su "Conferma"** di un'azione: la seconda richiesta non deve rieseguire (token di anteprima monouso). Test in Task 10.
3. **Chat con Mario attivo e bozza dell'Assistente**: `bozza_risposta` rifiutata se `ai_paused_at` è nullo; il composer resta bloccato. Test in Task 12.
4. **Lancio spento / `lancio_evento_at` assente**: la barra di regia mostra "Nessun lancio in corso", niente countdown `NaN`. Test in Task 8.
5. **Nome lungo, senza nome, anteprima con emoji del lead**: la riga non si rompe (ellissi, "Senza nome" + telefono). Test in Task 6 (`contestoRiga`/`nomeRiga`).

---

### Task 1: Accesso alla console e account admin

**Files:**
- Modify: `lib/access.ts`
- Modify: `lib/access.test.ts`
- Create: `scripts/crea-admin-console.ts`

**Interfaces:**
- Produces: `puoUsareConsole(email: string | null | undefined): boolean`; `landingPath()` torna `'/console'` per l'area `all`.

- [ ] **Step 1: Test che falliscono** — aggiungere in `lib/access.test.ts`:

```ts
import { puoUsareConsole, landingPath } from './access';

describe('console', () => {
  it('solo l\'area all usa la console', () => {
    expect(puoUsareConsole('admin@fenice.com')).toBe(true);
    expect(puoUsareConsole('fenice@academy.com')).toBe(false);
    expect(puoUsareConsole('campagne@fenice.com')).toBe(false);
    expect(puoUsareConsole('fenicebot@fenice.com')).toBe(false);
    expect(puoUsareConsole(null)).toBe(false);
  });
  it('l\'admin atterra sulla console', () => {
    expect(landingPath('admin@fenice.com')).toBe('/console');
    expect(landingPath('fenice@academy.com')).toBe('/chat');
  });
});
```
Aggiornare eventuali asserzioni esistenti che si aspettano `'/inbox'` per l'area `all` a `'/console'`.

- [ ] **Step 2:** `bunx vitest run lib/access.test.ts` → FAIL (`puoUsareConsole` non esiste).

- [ ] **Step 3: Implementazione** in `lib/access.ts`:

```ts
/** La console /console: solo l'area `all`. Un email assente non è mai admin. */
export function puoUsareConsole(email: string | null | undefined): boolean {
  if (!email) return false;
  return areaForEmail(email) === 'all';
}
```
e in `landingPath` sostituire `return '/inbox';` con `return '/console';`.

- [ ] **Step 4:** `bunx vitest run lib/access.test.ts` → PASS.

- [ ] **Step 5: Script account** `scripts/crea-admin-console.ts` (lanciato a mano dal controller, non in CI):

```ts
// Crea (o ritrova) l'account admin della console. Uso: bun scripts/crea-admin-console.ts <email> <file-password>
// La password si genera qui e si scrive SOLO nel file indicato (fuori dal repo).
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [email, out] = process.argv.slice(2);
if (!email || !out) throw new Error('uso: bun scripts/crea-admin-console.ts <email> <file>');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const password = randomBytes(12).toString('base64url');
const { data: lista } = await s.auth.admin.listUsers({ perPage: 1000 });
const esistente = lista?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
const r = esistente
  ? await s.auth.admin.updateUserById(esistente.id, { password })
  : await s.auth.admin.createUser({ email, password, email_confirm: true });
if (r.error) throw r.error;
writeFileSync(out, `Console Fenice\nURL: https://web-app-messaggistica.vercel.app/console\nEmail: ${email}\nPassword: ${password}\n`);
console.log(`ok: ${esistente ? 'password aggiornata' : 'account creato'} per ${email}; credenziali in ${out}`);
```

- [ ] **Step 6: Commit**

```bash
git add lib/access.ts lib/access.test.ts scripts/crea-admin-console.ts
git commit -m "feat(console): accesso riservato all'area admin e atterraggio su /console"
```

---

### Task 2: Guscio della console (token, font, layout, tema, scanner)

**Files:**
- Create: `app/(console)/console.css`
- Create: `app/(console)/layout.tsx`
- Create: `app/(console)/console/page.tsx` (provvisoria, sostituita in Task 6)
- Create: `components/console/Shell.tsx`, `components/console/TemaToggle.tsx`
- Create: `scripts/detect-slop.mjs` (copia di `C:/Users/bruno/Desktop/ui-riferimenti/avoid-ai-design/scripts/detect.mjs`, con commento di attribuzione MIT in testa)
- Modify: `package.json` (dipendenze + script `check:slop`)
- Test: `components/console/TemaToggle.test.tsx`

**Interfaces:**
- Produces: layout che avvolge ogni pagina sotto `/console` con `<div data-console data-theme="dark|light">`, variabili CSS del mockup, classi font `--f`/`--m` (via `next/font`), `NuqsAdapter`, `<Shell sidebar regia>` con tre slot: `regia` (in alto), `nav` (sinistra), `children`.
- Produces: `components/console/TemaToggle.tsx` export `TemaToggle` e hook `useTema(): ['dark'|'light', (t) => void]` (localStorage `console-tema`, try/catch).

- [ ] **Step 1: Dipendenze**

```bash
bun add virtua nuqs cmdk
```
In `package.json` script: `"check:slop": "node scripts/detect-slop.mjs app/(console) components/console --min=P1"`.

- [ ] **Step 2: Token** — `app/(console)/console.css`: copiare dal mockup le variabili di `:root`/tema scuro (righe ~36-58) sotto `[data-console]` e quelle del tema chiaro (righe ~62-73) sotto `[data-console][data-theme="light"]`; aggiungere:

```css
[data-console]{
  font-family: var(--font-console), sans-serif; font-size:13px; line-height:20px;
  color: var(--fg); background: var(--s1); color-scheme: dark;
  font-variant-numeric: tabular-nums; height: 100dvh; overflow: hidden;
  --m: var(--font-console-mono), monospace; --f: var(--font-console), sans-serif;
}
[data-console][data-theme="light"]{ color-scheme: light; }
[data-console] ::selection{ background: var(--ice-soft); color: var(--fg); }
[data-console] *{ scrollbar-color: var(--line) transparent; scrollbar-width: thin; }
[data-console] :focus-visible{ outline: 2px solid var(--ice); outline-offset: 1px; }
[data-console] .mono{ font-family: var(--m); font-size: 12px; }
@media (prefers-reduced-motion: reduce){ [data-console] *{ animation: none !important; transition: none !important; } }
```
Poi copiare, sotto il prefisso `[data-console]`, gli stili del mockup per: `.regia`, `.nv`, lista (`.row`, `.l1`, `.l2`, `.nm`, `.pv`, `.tm`, `.ctx`, `.av`, `.a1…a6`), thread (`.thread`, `.b.mario`, `.b.lead`, `.sys`, `.who-lbl`, `.typing`, `.win`), cabina (`.al-*`), `.btn`, `.btn.pri`, `.iconbtn`, `.kbd`. Le classi del mockup restano i nomi di riferimento dei componenti.

- [ ] **Step 3: Layout** — `app/(console)/layout.tsx`:

```tsx
import { Schibsted_Grotesk, JetBrains_Mono } from 'next/font/google';
import { redirect } from 'next/navigation';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { getSupabaseServer } from '@/lib/supabase/server';
import { puoUsareConsole } from '@/lib/access';
import { Shell } from '@/components/console/Shell';
import './console.css';

const sans = Schibsted_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-console' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-console-mono' });

export const metadata = { title: 'Regia · Fenice' };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const s = await getSupabaseServer();
  const { data: { user } } = await s.auth.getUser();
  if (!user) redirect('/login?from=/console');
  if (!puoUsareConsole(user.email)) redirect('/');
  return (
    <div data-console data-theme="dark" className={`${sans.variable} ${mono.variable}`}>
      <NuqsAdapter>
        <Shell email={user.email ?? ''}>{children}</Shell>
      </NuqsAdapter>
    </div>
  );
}
```
Verificare nel doc `node_modules/next/dist/docs/` che `next/font/google` con `variable` e `redirect` in un layout server siano l'API corrente.

- [ ] **Step 4: Shell** — `components/console/Shell.tsx` (`'use client'`): griglia `grid-template-rows: auto 1fr` (slot regia in alto, riempito in Task 8) e `grid-template-columns: 232px 1fr` (nav a sinistra, riempita in Task 6). All'avvio legge il tema con `useTema()` e lo scrive su `document.querySelector('[data-console]')?.setAttribute('data-theme', t)`. Contiene `<TemaToggle/>` in fondo alla nav e un contenitore `<div id="console-toasts" aria-live="polite">`.

- [ ] **Step 5: Test del tema** — `components/console/TemaToggle.test.tsx` (jsdom: `// @vitest-environment jsdom` in testa):

```tsx
// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { useTema } from './TemaToggle';

it('parte scuro e ricorda la scelta', () => {
  localStorage.clear();
  const { result } = renderHook(() => useTema());
  expect(result.current[0]).toBe('dark');
  act(() => result.current[1]('light'));
  expect(localStorage.getItem('console-tema')).toBe('light');
});
it('regge un localStorage che lancia', () => {
  const orig = Storage.prototype.getItem;
  Storage.prototype.getItem = () => { throw new Error('bloccato'); };
  const { result } = renderHook(() => useTema());
  expect(result.current[0]).toBe('dark');
  Storage.prototype.getItem = orig;
});
```
Implementazione di `useTema`: `useState<'dark'|'light'>('dark')`, `useEffect` che legge localStorage in try/catch, setter che scrive in try/catch.

- [ ] **Step 6: Pagina provvisoria** `app/(console)/console/page.tsx` che rende `<p className="muted">Console in costruzione.</p>`.

- [ ] **Step 7: Verifica** — `bunx vitest run components/console/TemaToggle.test.tsx` PASS; `bun run typecheck` PASS; `bun run check:slop` esce 0.

- [ ] **Step 8: Commit** `feat(console): guscio Regia con token, font, tema e scanner anti-slop`.

---

### Task 3: Primitivi della console

**Files:**
- Create: `components/console/ui/Button.tsx`, `Input.tsx`, `Kbd.tsx`, `Tag.tsx`, `Avatar.tsx`, `Menu.tsx` (Radix dropdown), `Sheet.tsx` (Radix dialog laterale), `Dialog.tsx`, `Tooltip.tsx`, `Skeleton.tsx`, `Stato.tsx` (vuoto/errore), `toast.ts`
- Create: `lib/console/avatar.ts`
- Test: `lib/console/avatar.test.ts`, `components/console/ui/Stato.test.tsx`

**Interfaces:**
- Produces: `Button({ variante?: 'normale'|'primario'|'fantasma'|'pericolo', caricamento?: boolean, ...button })` (classi `.btn`, `.btn.pri`, `.btn.ghost`, `.btn.danger`; con `caricamento` disabilitato e testo invariato + `aria-busy`).
- Produces: `Tag({ tono: 'neutro'|'urgente'|'errore'|'attesa'|'ok'|'onda', children })` — un badge di solo testo.
- Produces: `Avatar({ nome: string | null, telefono?: string | null })` → iniziali o icona `Phone` se senza nome, colore `a1…a6` da `tintaAvatar`.
- Produces: `tintaAvatar(chiave: string): 1|2|3|4|5|6` e `iniziali(nome: string | null): string` in `lib/console/avatar.ts`.
- Produces: `Vuoto({ titolo, testo, azione? })`, `Errore({ titolo, testo, onRiprova })`, `SkeletonRighe({ righe, altezza })` (compare dopo 200 ms, resta almeno 400 ms).
- Produces: `toast.ok(testo)`, `toast.errore(testo)` (implementati con `sonner` già installato, montato nello Shell con classi dei token).

- [ ] **Step 1: Test** `lib/console/avatar.test.ts`:

```ts
import { tintaAvatar, iniziali } from './avatar';
it('tinta stabile e nel range', () => {
  expect(tintaAvatar('Giulia Ferraresi')).toBe(tintaAvatar('Giulia Ferraresi'));
  for (const n of ['a', 'Marco', '+39 347', '']) expect([1, 2, 3, 4, 5, 6]).toContain(tintaAvatar(n));
});
it('iniziali', () => {
  expect(iniziali('Giulia Ferraresi')).toBe('GF');
  expect(iniziali('  marco  ')).toBe('M');
  expect(iniziali('Anna Maria De Luca')).toBe('AL');
  expect(iniziali(null)).toBe('');
  expect(iniziali('😀 Sara')).toBe('S');
});
```

- [ ] **Step 2:** `bunx vitest run lib/console/avatar.test.ts` → FAIL.

- [ ] **Step 3: Implementazione**

```ts
export function tintaAvatar(chiave: string): 1 | 2 | 3 | 4 | 5 | 6 {
  let h = 0;
  for (const ch of chiave) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return ((h % 6) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
}
export function iniziali(nome: string | null): string {
  const parole = (nome ?? '').split(/\s+/).map((p) => p.replace(/[^\p{L}]/gu, '')).filter(Boolean);
  if (parole.length === 0) return '';
  const prima = parole[0][0];
  const ultima = parole.length > 1 ? parole[parole.length - 1][0] : '';
  return (prima + ultima).toUpperCase();
}
```

- [ ] **Step 4:** test PASS.

- [ ] **Step 5: Componenti.** Implementare i primitivi con le classi del mockup; `Menu`, `Sheet`, `Dialog`, `Tooltip` sui pacchetti Radix già in `package.json` (`@radix-ui/react-dropdown-menu`, `-dialog`, `-tooltip`), con ombra `var(--shadow)` e bordo `var(--line)`, raggio 8 px, apertura senza animazione (Dialog/Sheet: solo opacità 120 ms). `Stato.test.tsx` (jsdom) verifica che `Errore` renda titolo, testo e un bottone "Riprova" che chiama `onRiprova`, e che `SkeletonRighe` non renda nulla prima di 200 ms (usare `vi.useFakeTimers()`).

- [ ] **Step 6:** `bunx vitest run components/console/ui lib/console/avatar.test.ts` PASS; `bun run check:slop` 0.

- [ ] **Step 7: Commit** `feat(console): primitivi dell'interfaccia sui token Regia`.

---

### Task 4: Le viste (logica pura + query)

**Files:**
- Create: `lib/console/viste.ts`
- Test: `lib/console/viste.test.ts`

**Interfaces:**
- Consumes: `mondoDi` da `lib/chat-perimetro.ts`; `LANCIO_FASI` da `lib/lancio-fase.ts`.
- Produces:

```ts
export const VISTE = ['serve_te', 'non_lette', 'lancio', 'fissati_bot', 'gdo', 'mario', 'chiuse', 'campagne', 'errori'] as const;
export type Vista = (typeof VISTE)[number];
export const VISTA_META: Record<Vista, { etichetta: string; urgente: boolean; gruppo: 'priorita' | 'lancio' | 'mondi' | 'sistema' }>;
export type RigaVista = {
  id: number; ai_owner: string | null; ai_status: string | null; ai_paused_at: string | null;
  bot_outcome: string | null; gdo_agenda_at: string | null; gdo_video_sent_at: string | null;
  campaign_id: number | null; lancio_slug: string | null; lancio_fase: string | null;
  last_inbound_at: string | null; unread_count: number | null;
};
export type CtxVista = { now: Date; conErrori: ReadonlySet<number> };
export function isVista(x: unknown): x is Vista;
export function inVista(r: RigaVista, v: Vista, ctx: CtxVista): boolean;
export function applicaVista<Q>(q: Q, v: Vista, ctx: { now: Date; conErrori: readonly number[] }): Q | null; // null = risultato vuoto certo
export function contestoRiga(r: RigaVista, ctx: CtxVista): { testo: string; tono: 'urgente' | 'errore' | 'neutro' | 'onda' } | null;
export const ETICHETTA_FASE: Record<string, string>;
```

- [ ] **Step 1: Test** `lib/console/viste.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { inVista, applicaVista, contestoRiga, isVista, type RigaVista } from './viste';

const now = new Date('2026-10-05T19:00:00Z');
const base: RigaVista = {
  id: 1, ai_owner: 'mario', ai_status: 'active', ai_paused_at: null, bot_outcome: null,
  gdo_agenda_at: null, gdo_video_sent_at: null, campaign_id: null, lancio_slug: null,
  lancio_fase: null, last_inbound_at: '2026-10-05T18:00:00Z', unread_count: 0,
};
const ctx = { now, conErrori: new Set<number>() };

describe('inVista', () => {
  it('serve te: pausa manuale sempre, handed_off solo se recente', () => {
    expect(inVista({ ...base, ai_paused_at: '2026-09-01T00:00:00Z' }, 'serve_te', ctx)).toBe(true);
    expect(inVista({ ...base, ai_status: 'handed_off' }, 'serve_te', ctx)).toBe(true);
    expect(inVista({ ...base, ai_status: 'handed_off', last_inbound_at: '2026-09-20T00:00:00Z' }, 'serve_te', ctx)).toBe(false);
    expect(inVista({ ...base, bot_outcome: 'CONTATTO_UMANO' }, 'serve_te', ctx)).toBe(true);
  });
  it('non lette', () => {
    expect(inVista({ ...base, unread_count: 2 }, 'non_lette', ctx)).toBe(true);
    expect(inVista({ ...base, unread_count: null }, 'non_lette', ctx)).toBe(false);
  });
  it('lancio, fissati, gdo, campagne', () => {
    expect(inVista({ ...base, lancio_slug: 'webdev-2026-10' }, 'lancio', ctx)).toBe(true);
    expect(inVista({ ...base, bot_outcome: 'APPUNTAMENTO' }, 'fissati_bot', ctx)).toBe(true);
    expect(inVista({ ...base, gdo_agenda_at: '2026-10-01T00:00:00Z' }, 'gdo', ctx)).toBe(true);
    expect(inVista({ ...base, ai_owner: null, gdo_video_sent_at: '2026-10-01T00:00:00Z' }, 'gdo', ctx)).toBe(true);
    expect(inVista({ ...base, ai_owner: null, campaign_id: 7 }, 'campagne', ctx)).toBe(true);
    expect(inVista(base, 'campagne', ctx)).toBe(false);
  });
  it('mario in corso esclude esiti, gdo e fasi terminali', () => {
    expect(inVista(base, 'mario', ctx)).toBe(true);
    expect(inVista({ ...base, ai_status: null }, 'mario', ctx)).toBe(true);
    expect(inVista({ ...base, bot_outcome: 'RICHIAMO' }, 'mario', ctx)).toBe(false);
    expect(inVista({ ...base, ai_status: 'booked' }, 'mario', ctx)).toBe(false);
    expect(inVista({ ...base, gdo_agenda_at: 'x' }, 'mario', ctx)).toBe(false);
    expect(inVista({ ...base, lancio_fase: 'restituito' }, 'mario', ctx)).toBe(false);
  });
  it('chiuse', () => {
    expect(inVista({ ...base, ai_status: 'closed' }, 'chiuse', ctx)).toBe(true);
    expect(inVista({ ...base, lancio_fase: 'chiuso' }, 'chiuse', ctx)).toBe(true);
    expect(inVista({ ...base, bot_outcome: 'NON_RISPOSTO' }, 'chiuse', ctx)).toBe(true);
    expect(inVista({ ...base, bot_outcome: 'APPUNTAMENTO' }, 'chiuse', ctx)).toBe(false);
  });
  it('errori usa l\'insieme calcolato', () => {
    expect(inVista(base, 'errori', { now, conErrori: new Set([1]) })).toBe(true);
    expect(inVista(base, 'errori', ctx)).toBe(false);
  });
});

describe('applicaVista', () => {
  // Finto query builder che registra le chiamate.
  function fq() {
    const calls: string[] = [];
    const q: any = new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => { calls.push(`${k}(${a.map((x) => JSON.stringify(x)).join(',')})`); return q; } });
    return { q, calls };
  }
  it('errori vuoto = null (mai in.())', () => {
    const { q } = fq();
    expect(applicaVista(q, 'errori', { now, conErrori: [] })).toBeNull();
  });
  it('errori con id usa in', () => {
    const { q, calls } = fq();
    applicaVista(q, 'errori', { now, conErrori: [3, 4] });
    expect(calls).toContain('in("id",[3,4])');
  });
  it('non lette usa gt', () => {
    const { q, calls } = fq();
    applicaVista(q, 'non_lette', { now, conErrori: [] });
    expect(calls).toContain('gt("unread_count",0)');
  });
});

describe('contestoRiga', () => {
  it('una sola etichetta, priorita\' serve te > errore > fissato > fase', () => {
    expect(contestoRiga({ ...base, ai_status: 'handed_off', bot_outcome: 'APPUNTAMENTO' }, ctx)?.testo).toBe('Serve te');
    expect(contestoRiga(base, { now, conErrori: new Set([1]) })?.tono).toBe('errore');
    expect(contestoRiga({ ...base, bot_outcome: 'APPUNTAMENTO' }, ctx)?.testo).toBe('Fissato dal bot');
    expect(contestoRiga({ ...base, lancio_slug: 's', lancio_fase: 'posto_bloccato' }, ctx)?.testo).toBe('Posto bloccato');
    expect(contestoRiga({ ...base, gdo_agenda_at: 'x' }, ctx)?.testo).toBe('Lead GDO');
  });
  it('isVista', () => { expect(isVista('lancio')).toBe(true); expect(isVista('x')).toBe(false); });
});
```

- [ ] **Step 2:** `bunx vitest run lib/console/viste.test.ts` → FAIL.

- [ ] **Step 3: Implementazione** `lib/console/viste.ts`:

```ts
import { mondoDi } from '@/lib/chat-perimetro';

export const VISTE = ['serve_te', 'non_lette', 'lancio', 'fissati_bot', 'gdo', 'mario', 'chiuse', 'campagne', 'errori'] as const;
export type Vista = (typeof VISTE)[number];

export const VISTA_META: Record<Vista, { etichetta: string; urgente: boolean; gruppo: 'priorita' | 'lancio' | 'mondi' | 'sistema' }> = {
  serve_te: { etichetta: 'Serve te', urgente: true, gruppo: 'priorita' },
  non_lette: { etichetta: 'Non lette', urgente: false, gruppo: 'priorita' },
  errori: { etichetta: 'Con errori', urgente: true, gruppo: 'priorita' },
  lancio: { etichetta: 'Lancio', urgente: false, gruppo: 'lancio' },
  fissati_bot: { etichetta: 'Fissati dal bot', urgente: false, gruppo: 'mondi' },
  mario: { etichetta: 'Mario in corso', urgente: false, gruppo: 'mondi' },
  gdo: { etichetta: 'Lead dei GDO', urgente: false, gruppo: 'mondi' },
  campagne: { etichetta: 'Campagne', urgente: false, gruppo: 'mondi' },
  chiuse: { etichetta: 'Chiuse e restituite', urgente: false, gruppo: 'mondi' },
};

export const ETICHETTA_FASE: Record<string, string> = {
  attesa: 'In attesa', posto_bloccato: 'Posto bloccato', link_inviato: 'Link inviato',
  post_pitch: 'Dopo il pitch', scelta_fatta: 'Scelta fatta', followup_inviato: 'Follow-up inviato',
  restituito: 'Restituito', chiuso: 'Chiuso',
};

export type RigaVista = {
  id: number; ai_owner: string | null; ai_status: string | null; ai_paused_at: string | null;
  bot_outcome: string | null; gdo_agenda_at: string | null; gdo_video_sent_at: string | null;
  campaign_id: number | null; lancio_slug: string | null; lancio_fase: string | null;
  last_inbound_at: string | null; unread_count: number | null;
};
export type CtxVista = { now: Date; conErrori: ReadonlySet<number> };

const SETTE_GIORNI = 7 * 24 * 3600_000;
const ESITI_CHIUSI = ['DA_SCARTARE', 'NON_RISPOSTO', 'INTERROTTO', 'RICHIAMO'];
const FASI_TERMINALI = ['chiuso', 'restituito'];

export function isVista(x: unknown): x is Vista {
  return typeof x === 'string' && (VISTE as readonly string[]).includes(x);
}

const recente = (iso: string | null, now: Date) => !!iso && now.getTime() - Date.parse(iso) <= SETTE_GIORNI;

export function inVista(r: RigaVista, v: Vista, ctx: CtxVista): boolean {
  switch (v) {
    case 'serve_te':
      return r.ai_paused_at != null
        || ((r.ai_status === 'handed_off' || r.bot_outcome === 'CONTATTO_UMANO') && recente(r.last_inbound_at, ctx.now));
    case 'non_lette': return (r.unread_count ?? 0) > 0;
    case 'lancio': return r.lancio_slug != null;
    case 'fissati_bot': return r.bot_outcome === 'APPUNTAMENTO';
    case 'gdo': return mondoDi(r) === 'GDO';
    case 'campagne': return mondoDi(r) === 'CAMPAGNA';
    case 'mario':
      return r.ai_owner === 'mario' && r.gdo_agenda_at == null && r.bot_outcome == null
        && (r.ai_status == null || r.ai_status === 'active' || r.ai_status === 'replying')
        && (r.lancio_fase == null || !FASI_TERMINALI.includes(r.lancio_fase));
    case 'chiuse':
      return r.ai_status === 'closed' || (r.lancio_fase != null && FASI_TERMINALI.includes(r.lancio_fase))
        || (r.bot_outcome != null && ESITI_CHIUSI.includes(r.bot_outcome));
    case 'errori': return ctx.conErrori.has(r.id);
  }
}

// Il query builder di supabase-js non si presta a un generic stretto (vedi lib/chat-perimetro.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applicaVista<Q>(q: Q, v: Vista, ctx: { now: Date; conErrori: readonly number[] }): Q | null {
  const x = q as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const da7 = new Date(ctx.now.getTime() - SETTE_GIORNI).toISOString();
  switch (v) {
    case 'serve_te':
      return x.or(`ai_paused_at.not.is.null,and(ai_status.eq.handed_off,last_inbound_at.gte.${da7}),and(bot_outcome.eq.CONTATTO_UMANO,last_inbound_at.gte.${da7})`);
    case 'non_lette': return x.gt('unread_count', 0);
    case 'lancio': return x.not('lancio_slug', 'is', null);
    case 'fissati_bot': return x.eq('bot_outcome', 'APPUNTAMENTO');
    case 'gdo': return x.or('gdo_agenda_at.not.is.null,and(gdo_video_sent_at.not.is.null,ai_owner.is.null)');
    case 'campagne': return x.is('ai_owner', null).is('gdo_agenda_at', null).is('gdo_video_sent_at', null);
    case 'mario':
      return x.eq('ai_owner', 'mario').is('gdo_agenda_at', null).is('bot_outcome', null)
        .or('ai_status.is.null,ai_status.in.(active,replying)')
        .or('lancio_fase.is.null,lancio_fase.not.in.(chiuso,restituito)');
    case 'chiuse':
      return x.or(`ai_status.eq.closed,lancio_fase.in.(chiuso,restituito),bot_outcome.in.(${ESITI_CHIUSI.join(',')})`);
    case 'errori':
      return ctx.conErrori.length === 0 ? null : x.in('id', [...ctx.conErrori]);
  }
}

export function contestoRiga(r: RigaVista, ctx: CtxVista): { testo: string; tono: 'urgente' | 'errore' | 'neutro' | 'onda' } | null {
  if (inVista(r, 'serve_te', ctx)) return { testo: 'Serve te', tono: 'urgente' };
  if (ctx.conErrori.has(r.id)) return { testo: 'Invio non riuscito', tono: 'errore' };
  if (r.bot_outcome === 'APPUNTAMENTO') return { testo: 'Fissato dal bot', tono: 'neutro' };
  if (r.lancio_slug) return { testo: ETICHETTA_FASE[r.lancio_fase ?? ''] ?? 'Lancio', tono: 'onda' };
  const m = mondoDi(r);
  if (m === 'GDO') return { testo: 'Lead GDO', tono: 'neutro' };
  if (m === 'CAMPAGNA') return { testo: 'Campagna', tono: 'neutro' };
  if (inVista(r, 'mario', ctx)) return { testo: 'Mario in corso', tono: 'neutro' };
  return null;
}
```

- [ ] **Step 4:** test PASS. Se `applicaVista(q, 'errori', …)` con il finto builder registra `in("id",[3,4])`, ok.

- [ ] **Step 5: Commit** `feat(console): predicati delle nove viste, puri e in forma di query`.

---

### Task 5: API delle viste e della lista chat

**Files:**
- Create: `lib/console/viste-db.ts`
- Create: `app/api/console/viste/route.ts`, `app/api/console/chat/route.ts`
- Create: `lib/console/guardia.ts`
- Create: `scripts/verifica-viste.ts`
- Test: `lib/console/viste-db.test.ts`, `app/api/console/viste/route.test.ts`, `app/api/console/chat/route.test.ts`

**Interfaces:**
- Consumes: `VISTE`, `applicaVista`, `contestoRiga`, `RigaVista`, `isVista` (Task 4); `soloMondoFenice` (`lib/chat-perimetro.ts`); `getFeniceCampaignIds` (`lib/campagne.ts`); `fetchAllRows`.
- Produces:

```ts
// lib/console/guardia.ts
export async function richiediAdmin(): Promise<{ ok: true; email: string } | { ok: false; risposta: Response }>;
// 401 senza sessione, 403 {error:'solo_admin'} se !puoUsareConsole

// lib/console/viste-db.ts
export async function idsConErrori(s: Supa, now: Date): Promise<number[]>; // cache 15 s
export async function contaViste(s: Supa, now: Date): Promise<Record<Vista, number>>; // cache 15 s
export type RigaLista = { id: number; nome: string | null; telefono: string | null; ultimoAt: string | null;
  anteprima: string | null; nonLetti: number; contesto: ReturnType<typeof contestoRiga>; fase: string | null };
export async function paginaChat(s: Supa, p: { vista: Vista; fase?: string; soloNonLette?: boolean; q?: string; cursore?: string; now: Date }):
  Promise<{ righe: RigaLista[]; prossimo: string | null }>;
export function codificaCursore(at: string, id: number): string; export function leggiCursore(c: string): { at: string; id: number } | null;
```
- `GET /api/console/viste` → `{ conteggi: Record<Vista, number>, generatoAt }`.
- `GET /api/console/chat?vista=&fase=&solo=non_lette&q=&cursore=` → `{ righe: RigaLista[], prossimo: string | null }`; 400 su vista non valida.

- [ ] **Step 1: Test di `viste-db`** con un finto client (stesso stile di `app/api/fenice/lancio-settings/route.test.ts`): 
  - `idsConErrori` riceve messaggi out delle ultime 48 h ordinati dal più recente: `[{conversation_id:1,twilio_status:'delivered'},{conversation_id:1,twilio_status:'failed'},{conversation_id:2,twilio_status:'undelivered'}]` → `[2]` (conta solo l'ULTIMO messaggio di ogni chat).
  - `codificaCursore('2026-10-05T19:00:00.000Z', 42)` e `leggiCursore` fanno andata e ritorno; `leggiCursore('spazzatura')` → `null`.
  - `paginaChat` con `vista:'errori'` e nessun errore → `{ righe: [], prossimo: null }` senza chiamare `.from('conversations')`.
  - `paginaChat` con `q` che non trova lead → `{ righe: [], prossimo: null }`.

- [ ] **Step 2:** FAIL.

- [ ] **Step 3: Implementazione `viste-db.ts`**:

```ts
import type { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { getFeniceCampaignIds } from '@/lib/campagne';
import { soloMondoFenice } from '@/lib/chat-perimetro';
import { VISTE, applicaVista, contestoRiga, type RigaVista, type Vista } from './viste';

type Supa = ReturnType<typeof getSupabaseAdmin>;
const TTL = 15_000;
const PER_PAGINA = 50;
const COLONNE = 'id, ai_owner, ai_status, ai_paused_at, bot_outcome, gdo_agenda_at, gdo_video_sent_at, campaign_id, lancio_slug, lancio_fase, last_inbound_at, unread_count, last_message_at, last_message_preview, lead:leads(first_name, last_name, phone_e164)';

let cacheErrori: { at: number; p: Promise<number[]> } | null = null;
export function idsConErrori(s: Supa, now: Date): Promise<number[]> {
  if (cacheErrori && now.getTime() - cacheErrori.at < TTL) return cacheErrori.p;
  const da = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const p = fetchAllRows<{ conversation_id: number; twilio_status: string | null }>((a, b) =>
    s.from('messages').select('conversation_id, twilio_status').eq('direction', 'out').gte('created_at', da)
      .order('created_at', { ascending: false }).range(a, b) as never, { max: 30_000 },
  ).then((righe) => {
    const visti = new Set<number>(); const ko: number[] = [];
    for (const m of righe) {
      if (visti.has(m.conversation_id)) continue;
      visti.add(m.conversation_id);
      if (m.twilio_status === 'failed' || m.twilio_status === 'undelivered') ko.push(m.conversation_id);
    }
    return ko;
  });
  cacheErrori = { at: now.getTime(), p };
  p.catch(() => { if (cacheErrori?.p === p) cacheErrori = null; });
  return p;
}

let cacheConteggi: { at: number; p: Promise<Record<Vista, number>> } | null = null;
export function contaViste(s: Supa, now: Date): Promise<Record<Vista, number>> {
  if (cacheConteggi && now.getTime() - cacheConteggi.at < TTL) return cacheConteggi.p;
  const p = (async () => {
    const [fenice, errori] = await Promise.all([getFeniceCampaignIds(s), idsConErrori(s, now)]);
    const coppie = await Promise.all(VISTE.map(async (v) => {
      const base = soloMondoFenice(s.from('conversations').select('id', { count: 'exact', head: true }), fenice);
      const q = applicaVista(base, v, { now, conErrori: errori });
      if (q === null) return [v, 0] as const;
      const { count, error } = await q;
      if (error) throw new Error(`${v}: ${error.message}`);
      return [v, count ?? 0] as const;
    }));
    return Object.fromEntries(coppie) as Record<Vista, number>;
  })();
  cacheConteggi = { at: now.getTime(), p };
  p.catch(() => { if (cacheConteggi?.p === p) cacheConteggi = null; });
  return p;
}

export function codificaCursore(at: string, id: number): string {
  return Buffer.from(`${at}|${id}`).toString('base64url');
}
export function leggiCursore(c: string): { at: string; id: number } | null {
  try {
    const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
    const n = Number(id);
    if (!at || !Number.isInteger(n) || Number.isNaN(Date.parse(at))) return null;
    return { at, id: n };
  } catch { return null; }
}
```
`paginaChat`: se `q` → risolvere i `lead_id` come `leadIdsPerRicerca` in `app/api/chat/conversations/route.ts` (copiare la funzione in `viste-db.ts` con lo stesso escape) e, se vuoti, tornare vuoto; costruire `soloMondoFenice(s.from('conversations').select(COLONNE), fenice)`, `applicaVista` (null → vuoto), `fase` → `.eq('lancio_fase', fase)`, `soloNonLette` → `.gt('unread_count', 0)`, `lead_id` → `.in('lead_id', ids)` a blocchi solo se ≤ 200 id (oltre: prendere i primi 200 e dirlo nel log), cursore → `.or(`last_message_at.lt.${at},and(last_message_at.eq.${at},id.lt.${id})`)`, ordine `last_message_at desc, id desc`, `.limit(PER_PAGINA + 1)`. `prossimo` = cursore dell'ultima riga se sono arrivate `PER_PAGINA + 1` righe. Mappare in `RigaLista` con `nome` = nome e cognome (vuoti → `null`), `contesto = contestoRiga(riga, { now, conErrori: new Set(errori) })`.

- [ ] **Step 4: Guardia e rotte.** `lib/console/guardia.ts`:

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { puoUsareConsole } from '@/lib/access';

export async function richiediAdmin(): Promise<{ ok: true; email: string } | { ok: false; risposta: Response }> {
  const s = await getSupabaseServer();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return { ok: false, risposta: new NextResponse('unauthorized', { status: 401 }) };
  if (!puoUsareConsole(user.email)) return { ok: false, risposta: NextResponse.json({ error: 'solo_admin' }, { status: 403 }) };
  return { ok: true, email: user.email! };
}
```
Rotte `viste` e `chat`: `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, prima `richiediAdmin()`, poi `getSupabaseAdmin()`; errori → `500 { error: 'lettura_fallita', dettaglio }`. `chat` valida `vista` con `isVista` (400 `{error:'vista_non_valida'}`), `fase` solo se in `LANCIO_FASI`.

- [ ] **Step 5: Route test** (mock di `@/lib/console/guardia` e `@/lib/console/viste-db`): 401 inoltrato, 403 inoltrato, 400 su `vista=xyz`, 200 con la forma attesa.

- [ ] **Step 6: Script di coerenza con la produzione (solo lettura)** `scripts/verifica-viste.ts`: legge con `fetchAllRows` tutte le conversazioni del perimetro (COLONNE di `RigaVista`), calcola i conteggi con `inVista` e li confronta con `contaViste`; stampa una tabella vista/pura/query/differenza ed esce 1 se una differenza ≠ 0. Lanciarlo con `bun --env-file=.env.local scripts/verifica-viste.ts`. Se "mario" o "gdo" differiscono, il problema sono gli `.or()` ripetuti: sostituirli con un solo `.or()` di clausole `and(...)` equivalenti e rilanciare finché è tutto 0.

- [ ] **Step 7:** `bunx vitest run lib/console app/api/console` PASS; script di verifica exit 0.

- [ ] **Step 8: Commit** `feat(console): contatori delle viste e lista chat paginata a cursore`.

---

### Task 6: Navigazione e lista chat

**Files:**
- Create: `components/console/Nav.tsx`, `components/console/ListaChat.tsx`, `components/console/RigaChat.tsx`, `components/console/useConteggi.ts`, `components/console/useTastiera.ts`, `components/console/useArrivi.ts`
- Create: `lib/console/riga.ts`
- Modify: `app/(console)/console/page.tsx`, `components/console/Shell.tsx`
- Test: `lib/console/riga.test.ts`, `components/console/useTastiera.test.tsx`

**Interfaces:**
- Consumes: `/api/console/viste`, `/api/console/chat`, `VISTA_META`, `ETICHETTA_FASE`, `RigaLista`, `Avatar`, `Tag`, `SkeletonRighe`, `Vuoto`, `Errore`.
- Produces: stato URL con nuqs: `vista` (default `non_lette`), `fase`, `solo` (`non_lette`|null), `q`, `chat` (id numerico). Hook `useTastiera({ onSu, onGiu, onApri, onEsc, onPalette, onScheda })`. Hook `useArrivi(onNuovoInbound: (conversationId: number) => void)` (una subscription Realtime `postgres_changes` INSERT su `messages` `direction=eq.in`, canale `console-inbound`, stesso schema di `components/RealtimeProvider.tsx`; nessun canale esistente modificato).
- Produces: `nomeRiga(r: { nome: string | null; telefono: string | null }): { principale: string; secondario: string | null }`, `prefissoAnteprima(anteprima: string | null): string` in `lib/console/riga.ts`.

- [ ] **Step 1: Test** `lib/console/riga.test.ts`:

```ts
import { nomeRiga, orarioRiga } from './riga';
it('senza nome mostra il telefono formattato', () => {
  expect(nomeRiga({ nome: null, telefono: '+393471182290' })).toEqual({ principale: '+39 347 118 2290', secondario: 'Senza nome' });
  expect(nomeRiga({ nome: 'Giulia Ferraresi', telefono: '+39333' }).principale).toBe('Giulia Ferraresi');
  expect(nomeRiga({ nome: null, telefono: null }).principale).toBe('Contatto sconosciuto');
});
it('orario: oggi HH:MM, ieri "Ieri", prima gg/mm', () => {
  const now = new Date('2026-10-05T19:30:00Z');
  expect(orarioRiga('2026-10-05T19:14:00Z', now)).toBe('21:14');
  expect(orarioRiga('2026-10-04T10:00:00Z', now)).toBe('Ieri');
  expect(orarioRiga('2026-09-28T10:00:00Z', now)).toBe('28/09');
  expect(orarioRiga(null, now)).toBe('');
});
```
Implementare con `Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', ... })`; telefono: `+39` + gruppi 3-3-4 per i numeri italiani a 12 cifre, altrimenti invariato.

- [ ] **Step 2:** FAIL → implementare → PASS.

- [ ] **Step 3: Nav** (mockup righe 483-512): gruppi "Priorità" (Serve te, Non lette, Con errori), "Lancio 5/10" (Lancio + sotto-fasi `attesa, posto_bloccato, link_inviato, post_pitch, scelta_fatta` con conteggio preso da `/api/console/regia` → `perFase`, Task 8; fino ad allora nascoste), "Mondi" (Fissati dal bot, Mario in corso, Lead dei GDO, Campagne, Chiuse e restituite), "Sistema" (Avvisi, Lancio, Assistente, Impostazioni, Analisi, Simulatore, Campagne, Log, Serenamente come link alle pagine dei Task 11-15). Contatori a destra in `tabular-nums`; solo `serve_te` ed `errori` con numero > 0 in `var(--red)`. Il nome dei gruppi è testo `var(--fg3)` a 12 px, niente maiuscolo. `useConteggi` fa polling ogni 10 s, sospeso con `document.visibilityState !== 'visible'`.

- [ ] **Step 4: ListaChat** (mockup righe 513-572): intestazione con titolo della vista + totale, interruttore "Solo non lette", ricerca (debounce 300 ms → `q`), lista con `VList` di `virtua` (altezza riga 56 px) che carica la pagina successiva quando mancano 10 righe alla fine. Riga: `Avatar`, nome (600 se `nonLetti > 0`, 500 altrimenti), orario, anteprima (`var(--fg2)` se non letta, `var(--fg3)` se letta) con ellissi, `contesto` come `Tag` (uno solo), contatore non letti. Selezionata = sfondo `var(--s4)`, hover `var(--s3)`. Clic → `chat=<id>`. Stati: `SkeletonRighe` in caricamento, `Vuoto` ("Nessuna chat in questa vista. Le nuove arrivano qui da sole."), `Errore` con Riprova.
  Aggiornamento: polling della prima pagina ogni 10 s (fonde per id senza perdere lo scroll) + `useArrivi` che rinfresca subito; l'unica animazione ammessa è l'evidenziazione di 600 ms della riga appena arrivata (solo `opacity` di uno sfondo).

- [ ] **Step 5: Tastiera** `useTastiera`: `j`/`ArrowDown` giù, `k`/`ArrowUp` su, `Enter` apre, `Escape` chiude, `Ctrl+K`/`Meta+K` palette, `]` scheda lead; ignora gli eventi quando il focus è in `input`, `textarea` o `[contenteditable]`. Test (jsdom) che `j` chiama `onGiu`, che dentro un `<input>` non chiama niente e che `Ctrl+K` chiama `onPalette`.

- [ ] **Step 6: Pagina** `app/(console)/console/page.tsx`: griglia `lista 360px | thread 1fr | cabina 320px` (la cabina e il thread arrivano in Task 7 e 11: per ora il pannello destro mostra `Vuoto` "Seleziona una chat").

- [ ] **Step 7:** test PASS, `bun run typecheck`, `bun run check:slop` 0. Avviare `bun dev` e controllare che `/console` risponda 200 dopo il login (verifica visiva completa in Task 16).

- [ ] **Step 8: Commit** `feat(console): navigazione con contatori e lista chat virtualizzata`.

---

### Task 7: Thread, composer e scheda lead

**Files:**
- Create: `app/api/console/chat/[id]/route.ts`
- Create: `components/console/Thread.tsx`, `components/console/Bolla.tsx`, `components/console/Composer.tsx`, `components/console/SchedaLead.tsx`
- Create: `lib/console/thread.ts`
- Test: `lib/console/thread.test.ts`, `app/api/console/chat/[id]/route.test.ts`

**Interfaces:**
- Consumes (API esistenti, non modificate): `GET /api/chat/conversations/[id]/messages` (messaggi, max 500), `POST /api/chat/conversations/[id]/read` (segna letta, solo `ai_owner='mario'`), `POST /api/chat/pause` `{ conversation_id, paused }`, `POST /api/chat/messages` `{ conversation_id, mode:'free', body }` (409 `bot_attivo`). `erroreTwilio(code)` da `lib/lancio-monitor.ts`. `convDaSegnareLetta` da `lib/segna-letta.ts`.
- Produces: `GET /api/console/chat/[id]` → `{ conv: { id, aiOwner, aiStatus, aiPausedAt, botOutcome, botScheduledAt, lancioFase, lancioSlug, waNumber, crmLeadId, aiSummary, handedOffReason, lastInboundAt, mondo }, lead: { id, nome, telefono }, crm: crm_lead_status | null, eventi: { at, tipo, testo, livello }[] }` (eventi: `event_log` con `payload->>conversationId = id`, ultimi 30 giorni, max 60, dal più recente; `testo` = `message`).
- Produces: `raggruppa(messaggi: Msg[]): Gruppo[]` e `finestra24h(lastInboundAt: string | null, now: Date): { aperta: boolean; chiudeAlle: string | null }` in `lib/console/thread.ts`, con `Msg = { id: number; direction: 'in' | 'out'; body: string; created_at: string; is_template: boolean; twilio_status: string | null; twilio_error_code: number | null; sender: string | null }` e `Gruppo = { tipo: 'giorno'; etichetta: string } | { tipo: 'blocco'; lato: 'lead' | 'bot'; autore: string; messaggi: Msg[] }`.

- [ ] **Step 1: Test** `lib/console/thread.test.ts`:

```ts
import { raggruppa, finestra24h } from './thread';
const m = (id: number, direction: 'in' | 'out', created_at: string, sender: string | null = null) =>
  ({ id, direction, body: 'x', created_at, is_template: false, twilio_status: 'delivered', twilio_error_code: null, sender });

it('separatori di giorno e blocchi consecutivi dello stesso lato', () => {
  const g = raggruppa([m(1, 'out', '2026-10-04T16:02:00Z'), m(2, 'in', '2026-10-05T18:47:00Z'), m(3, 'in', '2026-10-05T18:48:00Z'), m(4, 'out', '2026-10-05T18:49:00Z')], new Date('2026-10-05T19:00:00Z'));
  expect(g.map((x) => x.tipo === 'giorno' ? x.etichetta : `${x.lato}:${x.messaggi.length}`)).toEqual(['Ieri', 'bot:1', 'Oggi', 'lead:2', 'bot:1']);
});
it('autore del bot: Mario, o il GDO se sender lo dice', () => {
  const g = raggruppa([m(1, 'out', '2026-10-05T18:00:00Z', 'gdo:105')], new Date('2026-10-05T19:00:00Z'));
  expect((g[1] as { autore: string }).autore).toBe('GDO 105');
});
it('finestra 24h', () => {
  const now = new Date('2026-10-05T19:30:00Z');
  expect(finestra24h('2026-10-05T19:14:00Z', now)).toEqual({ aperta: true, chiudeAlle: 'domani 21:14' });
  expect(finestra24h('2026-10-03T10:00:00Z', now)).toEqual({ aperta: false, chiudeAlle: null });
  expect(finestra24h(null, now)).toEqual({ aperta: false, chiudeAlle: null });
});
```
Prima di implementare l'autore GDO leggere i valori reali di `messages.sender` (`bun --env-file=.env.local -e` con una select distinct su `sender` degli ultimi 7 giorni) e adattare la regola: `sender` che inizia con `gdo` → `GDO <numero>`; `null`/`mario`/`bot` → `Mario`; altro (email operatore) → la parte prima della `@`. Aggiornare il test con i valori reali trovati.

- [ ] **Step 2:** FAIL → implementare → PASS.

- [ ] **Step 3: Rotta dettaglio** con `richiediAdmin`, `params` Promise (`const { id } = await ctx.params`), 400 su id non numerico, 404 se la conversazione non esiste o non è nel perimetro (`isConversazioneChat` con il client admin). Route test: 401, 400, 404, forma della 200.

- [ ] **Step 4: Thread** (mockup righe 573-616): intestazione (Avatar, nome, telefono in mono, `Tag` di contesto, bottoni `Metti in pausa Mario` / `Ridai a Mario`, `Segna non letta` non c'è: la lettura segue le regole esistenti), elenco `raggruppa()` con bolle `.b.lead` / `.b.mario`, etichetta autore sul primo messaggio del blocco, orario + stato consegna (icona `Check`/`CheckCheck` 12 px; fallito: `AlertCircle` rosso + codice in mono + `erroreTwilio(code).nome` in tooltip), righe di sistema per gli eventi (`.sys`, testo 12 px) intercalate per orario. Scroll in fondo all'apertura (senza animazione). All'apertura e a ogni aggiornamento chiama la rotta `read` se `convDaSegnareLetta` lo dice. Polling 5 s dei messaggi della chat aperta.
- [ ] **Step 5: Composer**: se `aiPausedAt` nullo → testo "Mario gestisce questa chat." + bottone `Metti in pausa Mario per scrivere…`; se in pausa → textarea (`Ctrl+Invio` invia, `Invio` va a capo, dichiarato nel placeholder), `finestra24h` mostrata a destra ("Finestra 24h: chiude domani 21:14" o "Finestra chiusa: serve un template" e invio disabilitato), bottone `Invia` con stato di caricamento; 409 → toast "Mario è ancora attivo su questa chat: mettilo in pausa prima di scrivere."
- [ ] **Step 6: SchedaLead** (mockup righe 617-679, parte bassa): `dl` a due colonne con Telefono (mono + copia), ID lead, Numero WA (0047/3199 dalle ultime 4 cifre di `waNumber`), Mondo, Fase, Esito bot (+ data `botScheduledAt`), Stato CRM (`crm.status`, `conferme_outcome`, `sales_outcome`), Riassunto AI se presente, bottoni `Apri nel CRM` (link `https://crm-sales-fenice.vercel.app/?lead=<crmLeadId>` solo se `crmLeadId`), `Chiedi all'Assistente…` (apre il pannello del Task 13 con la domanda "Com'è andata la chat di <nome>?"), storico eventi compresso (ultimi 8, "Mostra tutti").
- [ ] **Step 7:** test PASS, typecheck, check:slop 0.
- [ ] **Step 8: Commit** `feat(console): thread con stati di consegna, composer a bot fermo e scheda lead`.

---

### Task 8: Barra di regia

**Files:**
- Create: `lib/console/regia.ts`, `app/api/console/regia/route.ts`, `components/console/BarraRegia.tsx`
- Test: `lib/console/regia.test.ts`, `app/api/console/regia/route.test.ts`

**Interfaces:**
- Consumes: `fotografia`, `consegne` (`lib/lancio-monitor-db.ts`), `calcolaContatori` (`lib/lancio-monitor.ts`), `fetchAllRows`.
- Produces:

```ts
export type VoceScaletta = { voce: 'link' | 'inizio' | 'pitch' | 'chiusura'; etichetta: string; at: string };
export function scalettaDa(eventoAt: string | null): VoceScaletta[]; // [] se null o non valida
export function statoOnda(now: Date, eventoAt: string | null): { stato: 'nessuno' | 'prima' | 'in_onda' | 'dopo'; secondi: number };
export function oraRoma(d: Date): number;
export function inizioGiornoRoma(now: Date): Date;
export function consegnePerOra(msg: { created_at: string; twilio_status: string | null }[]): { ora: number; inviati: number; consegnati: number; falliti: number }[]; // 24 voci, ora Europe/Rome
export type Regia = { attivo: boolean; stato: ReturnType<typeof statoOnda>; scaletta: VoceScaletta[];
  numeri: { iscritti: number; postoBloccato: number; linkInviati: number; consegnatiOggi: number; fallitiOggi: number };
  perFase: Record<string, number>; perOra: ReturnType<typeof consegnePerOra>; generatoAt: string };
```
- `GET /api/console/regia` → `Regia` (cache della fotografia già esistente; polling client 30 s).

- [ ] **Step 1: Test** `lib/console/regia.test.ts`:

```ts
import { scalettaDa, statoOnda, consegnePerOra, inizioGiornoRoma, oraRoma } from './regia';
const evento = '2026-10-05T21:00:00+02:00';
it('scaletta a partire dall\'evento', () => {
  expect(scalettaDa(evento).map((v) => [v.voce, oraRoma(new Date(v.at))])).toEqual([['link', 20], ['inizio', 21], ['pitch', 21], ['chiusura', 22]]);
  expect(scalettaDa(null)).toEqual([]);
  expect(scalettaDa('non-una-data')).toEqual([]);
});
it('stato onda', () => {
  expect(statoOnda(new Date('2026-10-05T18:00:00+02:00'), evento)).toEqual({ stato: 'prima', secondi: 3 * 3600 });
  expect(statoOnda(new Date('2026-10-05T21:14:32+02:00'), evento)).toEqual({ stato: 'in_onda', secondi: 14 * 60 + 32 });
  expect(statoOnda(new Date('2026-10-05T23:00:00+02:00'), evento).stato).toBe('dopo');
  expect(statoOnda(new Date(), null)).toEqual({ stato: 'nessuno', secondi: 0 });
});
it('giorno e ore a Roma, anche col cambio d\'ora', () => {
  expect(inizioGiornoRoma(new Date('2026-10-05T10:00:00Z')).toISOString()).toBe('2026-10-04T22:00:00.000Z');
  expect(inizioGiornoRoma(new Date('2026-11-05T10:00:00Z')).toISOString()).toBe('2026-11-04T23:00:00.000Z');
});
it('consegne per ora', () => {
  const r = consegnePerOra([
    { created_at: '2026-10-05T16:02:00Z', twilio_status: 'delivered' },
    { created_at: '2026-10-05T16:03:00Z', twilio_status: 'read' },
    { created_at: '2026-10-05T16:04:00Z', twilio_status: 'failed' },
    { created_at: '2026-10-05T16:05:00Z', twilio_status: 'sent' },
  ]);
  expect(r).toHaveLength(24);
  expect(r[18]).toEqual({ ora: 18, inviati: 4, consegnati: 2, falliti: 1 });
});
```

- [ ] **Step 2:** FAIL.

- [ ] **Step 3: Implementazione** (offset scaletta: link −5 min, inizio 0, pitch +40 min, chiusura +70 min; `in_onda` fra inizio e chiusura, `secondi` trascorsi; `prima` = secondi mancanti; `dopo` oltre la chiusura):

```ts
const MIN = 60_000;
const OFFSET: [VoceScaletta['voce'], string, number][] = [['link', 'Link', -5], ['inizio', 'Inizio', 0], ['pitch', 'Pitch', 40], ['chiusura', 'Chiusura', 70]];
const valida = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : null);

export function scalettaDa(eventoAt: string | null): VoceScaletta[] {
  const t = valida(eventoAt); if (t === null) return [];
  return OFFSET.map(([voce, etichetta, m]) => ({ voce, etichetta, at: new Date(t + m * MIN).toISOString() }));
}
export function statoOnda(now: Date, eventoAt: string | null) {
  const t = valida(eventoAt); if (t === null) return { stato: 'nessuno' as const, secondi: 0 };
  const n = now.getTime();
  if (n < t) return { stato: 'prima' as const, secondi: Math.round((t - n) / 1000) };
  if (n <= t + 70 * MIN) return { stato: 'in_onda' as const, secondi: Math.round((n - t) / 1000) };
  return { stato: 'dopo' as const, secondi: Math.round((n - t - 70 * MIN) / 1000) };
}
export function oraRoma(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(d));
}
export function inizioGiornoRoma(now: Date): Date {
  const giorno = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  for (const off of ['+02:00', '+01:00']) {
    const d = new Date(`${giorno}T00:00:00${off}`);
    if (oraRoma(d) === 0) return d;
  }
  return new Date(`${giorno}T00:00:00+01:00`);
}
const CONSEGNATO = new Set(['delivered', 'read']);
const FALLITO = new Set(['failed', 'undelivered']);
export function consegnePerOra(msg: { created_at: string; twilio_status: string | null }[]) {
  const out = Array.from({ length: 24 }, (_, ora) => ({ ora, inviati: 0, consegnati: 0, falliti: 0 }));
  for (const m of msg) {
    const o = out[oraRoma(new Date(m.created_at))];
    o.inviati++;
    if (CONSEGNATO.has(m.twilio_status ?? '')) o.consegnati++;
    else if (FALLITO.has(m.twilio_status ?? '')) o.falliti++;
  }
  return out;
}
```

- [ ] **Step 4:** PASS.

- [ ] **Step 5: Rotta** `GET /api/console/regia`: `richiediAdmin`; `foto = await fotografia(admin, now)`; `cons` in try/catch (null se fallisce); `contatori = calcolaContatori(foto.chats, foto.eventiContatori, cons?.consegne ?? null, foto.colonnaInizio)`; messaggi di oggi `fetchAllRows` su `messages` (`direction='out'`, `created_at >= inizioGiornoRoma(now)`, colonne `created_at, twilio_status`, `max: 50_000`). `numeri` = `{ iscritti: contatori.iscritti, postoBloccato: contatori.postoBloccato, linkInviati: contatori.linkZoomInviati, consegnatiOggi: somma consegnati, fallitiOggi: somma falliti }`. Route test: 401/403 e che con `settings.attivo=false` risponda `attivo:false`.
- [ ] **Step 6: Componente** (mockup righe 404-482): altezza 128 px; blocco luce (`stato='in_onda'` → quadratino `var(--ember)` + "In onda" + timecode `hh:mm:ss` che scorre ogni secondo lato client; `prima` → "Tra 23 ore 46 min" / "Tra 12:04" sotto l'ora; `dopo` → "Live finita"; `nessuno` o `attivo=false` → la barra diventa una riga da 36 px "Nessun lancio in corso · Impostazioni…"), scaletta con testina sull'ora corrente, 5 numeri (`fallitiOggi > 0` in `var(--red)` con link alla vista `errori`), grafico SVG 24 barre (`inviati` in `var(--bar)`, ora corrente `var(--bar-hi)`, `falliti` impilati in `var(--red)`), etichette 08/10/…/20. Montata nello slot `regia` dello Shell. Le sotto-fasi della Nav leggono `perFase` da qui (condividere lo stato con un piccolo context `RegiaProvider`).
- [ ] **Step 7:** typecheck, test, check:slop 0.
- [ ] **Step 8: Commit** `feat(console): barra di regia con luce in onda, scaletta e consegne ora per ora`.

---

### Task 9: Avvisi di sistema

**Files:**
- Create: `lib/console/avvisi.ts`, `lib/console/avvisi-db.ts`, `app/api/console/avvisi/route.ts`
- Test: `lib/console/avvisi.test.ts`, `app/api/console/avvisi/route.test.ts`

**Interfaces:**
- Consumes: `calcolaAvvisi`, `Avviso`, `Gravita`, `EventoMonitor`, `convIdDi` (`lib/lancio-monitor.ts`); `fotografia` (`lib/lancio-monitor-db.ts`).
- Produces:

```ts
export type AreaAvviso = 'lancio' | 'crm' | 'twilio' | 'cron' | 'bot' | 'gdo';
export type AzioneRef = { azione: IdAzione; params: Record<string, unknown>; etichetta: string };
export type AvvisoConsole = Avviso & { area: AreaAvviso; azioni: AzioneRef[]; primoAt: string | null; firma: string };
export const TIPI_SISTEMA: Record<string, { area: AreaAvviso; gravita: Gravita; titolo: string; significato: string; cosaFare: string }>;
export const CRON_SISTEMA: { cron: IdCron; tipoEvento: string; periodoMin: number; attivo: (now: Date) => boolean }[];
export function avvisiSistema(eventi: readonly EventoMonitor[], ultimiRun: Record<string, string | null>, now: Date): AvvisoConsole[];
export function azioniPer(a: Avviso): AzioneRef[];
export function areaDi(a: Avviso): AreaAvviso;
export function firmaAvviso(a: Pick<Avviso, 'id' | 'conteggio' | 'ultimoAt'>): string;
export function componiAvvisi(lancio: Avviso[], sistema: AvvisoConsole[], risolti: ReadonlyMap<string, string>): AvvisoConsole[];
```
(`IdAzione`, `IdCron` sono definiti in Task 10 in `lib/console/azioni-tipi.ts`; questo task crea quel file con i soli tipi:)

```ts
// lib/console/azioni-tipi.ts
export const ID_CRON = ['lancio-aperture', 'lancio-zoom', 'lancio-followup', 'lancio-restituzioni', 'riapri-mute', 'adotta-mai-risposti', 'bot-followups', 'crm-lead-status'] as const;
export type IdCron = (typeof ID_CRON)[number];
export const ID_AZIONI = ['rinvia_esiti_403', 'recupera_agende_consegnate', 'rinvia_esito', 'rilancia_cron', 'interruttore', 'pausa_mario', 'riprendi_mario'] as const;
export type IdAzione = (typeof ID_AZIONI)[number];
```

- [ ] **Step 1: Test** `lib/console/avvisi.test.ts`:

```ts
import { avvisiSistema, azioniPer, componiAvvisi, firmaAvviso, TIPI_SISTEMA } from './avvisi';
const now = new Date('2026-10-05T19:00:00Z');
const ev = (type: string, conv: number, at = '2026-10-05T18:30:00Z') => ({ id: Math.random(), type, created_at: at, level: 'error', message: '', payload: { conversationId: conv } });

it('raggruppa per tipo, conta le chat distinte, primo e ultimo', () => {
  const a = avvisiSistema([ev('gdo_agenda_error', 1, '2026-10-05T18:00:00Z'), ev('gdo_agenda_error', 1), ev('gdo_agenda_error', 2, '2026-10-05T18:40:00Z')], {}, now);
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ area: 'gdo', conteggio: 2, primoAt: '2026-10-05T18:00:00Z', ultimoAt: '2026-10-05T18:40:00Z' });
  expect(a[0].chat).toEqual([1, 2]);
});
it('tipi sconosciuti ignorati', () => {
  expect(avvisiSistema([ev('qualcosa_di_nuovo', 1)], {}, now)).toEqual([]);
});
it('cron fermo quando l\'ultimo giro e\' piu\' vecchio del doppio del periodo', () => {
  const a = avvisiSistema([], { 'bot-followups': '2026-10-05T16:00:00Z' }, now);
  expect(a.find((x) => x.id === 'cron_bot-followups')?.azioni[0]).toMatchObject({ azione: 'rilancia_cron', params: { cron: 'bot-followups' } });
  expect(avvisiSistema([], { 'bot-followups': '2026-10-05T18:10:00Z' }, now).find((x) => x.id === 'cron_bot-followups')).toBeUndefined();
});
it('azioni per gli avvisi del lancio', () => {
  const base = { gravita: 'critico' as const, titolo: '', significato: '', cosaFare: '', conteggio: 1, chat: [], ultimoAt: null };
  expect(azioniPer({ ...base, id: 'run_fermo_aperture' })[0]).toMatchObject({ azione: 'rilancia_cron', params: { cron: 'lancio-aperture' } });
  expect(azioniPer({ ...base, id: 'zoom_cron_fermo' })[0]).toMatchObject({ azione: 'rilancia_cron', params: { cron: 'lancio-zoom' } });
  expect(azioniPer({ ...base, id: 'lancio_spento' })[0]).toMatchObject({ azione: 'interruttore', params: { chiave: 'lancio_attivo', valore: true } });
  expect(azioniPer({ ...base, id: 'pulsante_spento' })[0]).toMatchObject({ azione: 'interruttore', params: { chiave: 'lancio_pulsante_attivo', valore: true } });
  expect(azioniPer({ ...base, id: 'crm' })[0]).toMatchObject({ azione: 'rinvia_esiti_403' });
  expect(azioniPer({ ...base, id: 'twilio_63016' })).toEqual([]);
});
it('i risolti restano nascosti finche\' la firma non cambia', () => {
  const s = avvisiSistema([ev('fenice_ai_error', 1)], {}, now);
  const f = firmaAvviso(s[0]);
  expect(componiAvvisi([], s, new Map([[s[0].id, f]]))).toEqual([]);
  expect(componiAvvisi([], s, new Map([[s[0].id, 'vecchia']]))).toHaveLength(1);
});
it('ogni tipo di sistema ha testi completi', () => {
  for (const [t, d] of Object.entries(TIPI_SISTEMA)) expect(d.titolo && d.significato && d.cosaFare, t).toBeTruthy();
});
```

- [ ] **Step 2:** FAIL.

- [ ] **Step 3: Implementazione.** `TIPI_SISTEMA` con queste chiavi e testi in italiano (titolo breve; significato = cosa è successo; cosaFare = cosa fare, con l'azione se c'è):
  - crm: `stale_booked_no_outcome`, `booked_without_outcome` (critico: "Appuntamento del bot mai arrivato al CRM"), `bot_outcome_senza_leadid` (attenzione), `contatto_umano_non_segnalato` (critico), `handed_off_non_registrato` (attenzione), `lead_entrante_push_error` (attenzione);
  - bot: `fenice_ai_error` (critico: "Mario non è riuscito a rispondere"), `fenice_ai_claim_error` (attenzione), `invio_template_fallito` (attenzione), `sequence_touch_error` (info);
  - gdo: `gdo_agenda_error` (critico: "Agenda del GDO non partita"), `gdo_followup_error` (attenzione).
  `CRON_SISTEMA = [{ cron: 'bot-followups', tipoEvento: 'bot_followups_run', periodoMin: 60, attivo: () => true }]` (è l'unico cron di sistema che scrive un evento di giro oltre a quelli del lancio, già coperti da `calcolaAvvisi` con `run_fermo_*`; `sequence_run` escluso perché i tocchi sono sospesi, vedi memoria "Follow-up sospesi"). Fermo = nessun giro o ultimo giro più vecchio di `2 × periodoMin` → avviso `id: 'cron_<cron>'`, area `cron`, gravità `critico`, azione `rilancia_cron`.
  `azioniPer`: `run_fermo_<c>` → `rilancia_cron { cron: 'lancio-<c>' }` (etichetta "Rilancia ora"); `zoom_cron_fermo`/`zoom_residui` → `rilancia_cron { cron: 'lancio-zoom' }`; `lancio_spento` → `interruttore { chiave:'lancio_attivo', valore:true }` ("Riaccendi il lancio"); `pulsante_spento` → `interruttore { chiave:'lancio_pulsante_attivo', valore:true }`; `crm` → `rinvia_esiti_403 {}` ("Rinvia gli esiti rifiutati"); `stale_booked_no_outcome`/`booked_without_outcome` → per ciascuna chat (max 20) `rinvia_esito { conversationId }`; tutto il resto `[]`. `areaDi`: `twilio_*` → twilio, `crm` → crm, `run_fermo_*`/`zoom_cron_fermo` → cron, altrimenti lancio. `firmaAvviso` = `${id}:${conteggio}:${ultimoAt}`. `componiAvvisi` concatena lancio (mappati con `areaDi`/`azioniPer`, `primoAt: null`) e sistema, toglie quelli con firma uguale in `risolti`, ordina per gravità (critico, attenzione, info) e poi per conteggio decrescente.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: `avvisi-db.ts`** `leggiAvvisi(s, now)`: in parallelo `fotografia(s, now)` → `calcolaAvvisi({...})` come in `app/api/fenice/lancio-monitor/route.ts`; eventi di `Object.keys(TIPI_SISTEMA)` delle ultime 24 h (`fetchAllRows`, `max: 20_000`); ultimo `bot_followups_run` (`order created_at desc limit 1`); risolti = `event_log` `type='console_avviso_risolto'` ultimi 7 giorni → mappa `payload.id → payload.firma` (vince il più recente). Rotta `GET /api/console/avvisi` → `{ avvisi: AvvisoConsole[], generatoAt }`; `POST /api/console/avvisi` `{ id, firma, nota }` (zod, nota ≤ 500) scrive `console_avviso_risolto` con `by` = email. Route test: 401/403, POST 400 senza id, POST ok scrive l'evento.
- [ ] **Step 6:** test, typecheck.
- [ ] **Step 7: Commit** `feat(console): avvisi di tutto il sistema con azioni collegate e "segna risolto"`.

---

### Task 10: Registro delle azioni (prova a vuoto → conferma → esito)

**Files:**
- Create: `lib/console/azioni.ts`, `app/api/console/azioni/anteprima/route.ts`, `app/api/console/azioni/esegui/route.ts`, `app/api/console/azioni/registro/route.ts`
- Test: `lib/console/azioni.test.ts`, `app/api/console/azioni/esegui/route.test.ts`

**Interfaces:**
- Consumes: `ID_AZIONI`, `ID_CRON`, `IdAzione`, `IdCron` (`lib/console/azioni-tipi.ts`, creato nel Task 9); `sendOutcome` (`lib/bot-outcome.ts`); `setLancioSetting`, `getLancioSettingValue`, `validateLancioSettingInput` (`lib/lancio-settings.ts`); `setAutoReply`, `getAutoReply` (`lib/fenice-settings.ts`); `isConversazioneChat` (`lib/chat-perimetro.ts`).
- Produces:

```ts
export type Anteprima = { azione: IdAzione; params: Record<string, unknown>; descrizione: string; conteggio: number | null; righe: string[]; avvertenza: string | null; token: string; scadeAt: string };
export type Esito = { ok: boolean; fatti: number; falliti: number; dettagli: string[]; messaggio: string };
export type Contesto = { s: Supa; origin: string; email: string; now: Date; fetch?: typeof fetch };
export const PARAMS: Record<IdAzione, z.ZodType>;
export async function anteprima(azione: IdAzione, params: unknown, ctx: Contesto): Promise<Anteprima>;
export async function esegui(token: string, ctx: Contesto): Promise<Esito>;
```
- Rotte: `POST /api/console/azioni/anteprima { azione, params }` → `Anteprima`; `POST /api/console/azioni/esegui { token, conferma: true }` → `Esito`; `GET /api/console/azioni/registro` → ultimi 100 `console_azione`.

Parametri (`PARAMS`, zod):
- `rinvia_esiti_403`: `{}`; `recupera_agende_consegnate`: `{}`
- `rinvia_esito`: `{ conversationId: number }`
- `rilancia_cron`: `{ cron: IdCron }`
- `interruttore`: `{ chiave: 'lancio_attivo' | 'lancio_pulsante_attivo' | 'fenice_ai_autoreply', valore: boolean }`
- `pausa_mario` / `riprendi_mario`: `{ conversationId: number }`

Comportamento per azione:
- `rinvia_esiti_403`: anteprima = `POST {origin}/api/cron/arretrati` con header `Authorization: Bearer ${CRON_SECRET}` e corpo `{ cosa: 'esiti-403', esegui: false, max: 1000 }`; conteggio = `candidate`, righe = `esempi` (max 10). Esegui = stesso con `esegui: true`; `fatti = inviate`, `falliti = fallite`.
- `recupera_agende_consegnate`: come sopra con `cosa: 'agenda-delivery'`; `fatti = avvisate`.
- `rinvia_esito`: anteprima legge la conversazione (`bot_outcome`, `bot_scheduled_at`, `ai_status`, `crm_lead_id`): esito = `bot_outcome` o, se `ai_status='booked'` e `bot_outcome` nullo, `APPUNTAMENTO` con `date = bot_scheduled_at`; se non si ricava un esito → anteprima con `avvertenza: 'Nessun esito da rinviare su questa chat'` e `conteggio: 0` (esegui poi rifiuta). Esegui = `sendOutcome(s, conversationId, { outcome, date })` + la stessa riga `admin_resend_outcome` scritta da `app/api/cron/resend-outcome/route.ts`.
- `rilancia_cron`: anteprima = descrizione fissa per cron (tabella `DESCRIZIONE_CRON` in italiano: cosa fa e se scrive ai lead) + ultimo evento `*_run` del cron se esiste; `avvertenza: 'Questo giro non ha una prova a vuoto: parte davvero.'` per i cron GET; per `riapri-mute` e `adotta-mai-risposti` la prova a vuoto è reale (`POST { esegui:false }`) e `avvertenza: 'Manda messaggi WhatsApp ai lead.'`. Esegui: GET (lancio-*, bot-followups, crm-lead-status) o POST `{ esegui: true }` (riapri-mute, adotta-mai-risposti) su `{origin}/api/cron/<cron>` con Bearer `CRON_SECRET`, timeout 280 s (`AbortController`); `Esito.messaggio` = sintesi del JSON di risposta.
- `interruttore`: anteprima = valore attuale → nuovo; esegui = `validateLancioSettingInput` + `setLancioSetting` + `event_log` `lancio_setting_cambiata` (stesso formato di `app/api/fenice/lancio-settings/route.ts`) oppure `setAutoReply` per `fenice_ai_autoreply` + evento `console_autoreply_cambiata`.
- `pausa_mario`/`riprendi_mario`: controllo `isConversazioneChat`, update `ai_paused_at` (ISO o null) + evento `bot_paused`/`bot_resumed` con lo stesso formato di `app/api/chat/pause/route.ts`.

Token: l'anteprima si salva in una mappa in memoria `token → { azione, params, conteggio, scadeAt, usato:false }` (token `randomUUID()`, validità 5 minuti). `esegui(token)`: token assente/scaduto → errore `anteprima_scaduta`; già usato → errore `gia_eseguita`; lo marca usato PRIMA di eseguire; per le azioni con conteggio rifà l'anteprima e, se il conteggio è cambiato di oltre il 20%, rifiuta con `conteggio_cambiato` e restituisce la nuova anteprima. Dopo l'esecuzione scrive `event_log` `{ type:'console_azione', level: ok?'info':'error', message: '[console] <azione> da <email>: <messaggio>', payload: { azione, params, anteprima: { conteggio, descrizione }, esito, by } }`.
Nota: la mappa in memoria vive nella singola istanza; se la conferma arriva su un'altra istanza Fluid il token non si trova e l'utente vede "Anteprima scaduta, rifalla" — comportamento sicuro e accettato.

- [ ] **Step 1: Test** `lib/console/azioni.test.ts` con finto `fetch` e finto client:

```ts
import { anteprima, esegui, _svuotaToken } from './azioni';
const chiamate: { url: string; init: RequestInit }[] = [];
const finto = (risposte: Record<string, unknown>) => (async (url: string, init: RequestInit) => {
  chiamate.push({ url, init });
  const corpo = JSON.parse(String(init.body ?? '{}'));
  return new Response(JSON.stringify(risposte[corpo.esegui ? 'si' : 'no']), { status: 200 });
}) as unknown as typeof fetch;
const eventi: unknown[] = [];
const s = { from: () => ({ insert: (r: unknown) => { eventi.push(r); return Promise.resolve({ error: null }); } }) } as never;
beforeEach(() => { chiamate.length = 0; eventi.length = 0; _svuotaToken(); process.env.CRON_SECRET = 'x'; });

it('l\'anteprima non esegue', async () => {
  const f = finto({ no: { ok: true, candidate: 38, esempi: ['conv 1'] }, si: { ok: true, inviate: 38, fallite: 0 } });
  const a = await anteprima('rinvia_esiti_403', {}, { s, origin: 'https://x', email: 'admin@fenice.com', now: new Date(), fetch: f });
  expect(a.conteggio).toBe(38);
  expect(JSON.parse(String(chiamate[0].init.body)).esegui).toBe(false);
  expect(eventi).toHaveLength(0);
});
it('esegui una volta sola e registra', async () => {
  const f = finto({ no: { ok: true, candidate: 38, esempi: [] }, si: { ok: true, inviate: 36, fallite: 2 } });
  const ctx = { s, origin: 'https://x', email: 'admin@fenice.com', now: new Date(), fetch: f };
  const a = await anteprima('rinvia_esiti_403', {}, ctx);
  const e = await esegui(a.token, ctx);
  expect(e).toMatchObject({ ok: true, fatti: 36, falliti: 2 });
  expect(eventi).toHaveLength(1);
  await expect(esegui(a.token, ctx)).rejects.toThrow('gia_eseguita');
});
it('token sconosciuto', async () => {
  await expect(esegui('nope', { s, origin: 'https://x', email: 'a', now: new Date() })).rejects.toThrow('anteprima_scaduta');
});
it('conteggio cambiato oltre il 20%', async () => {
  let giro = 0;
  const f = (async (_u: string, init: RequestInit) => {
    const c = JSON.parse(String(init.body)); giro++;
    return new Response(JSON.stringify(c.esegui ? { ok: true, inviate: 1, fallite: 0 } : { ok: true, candidate: giro === 1 ? 10 : 50, esempi: [] }));
  }) as unknown as typeof fetch;
  const ctx = { s, origin: 'https://x', email: 'a', now: new Date(), fetch: f };
  const a = await anteprima('rinvia_esiti_403', {}, ctx);
  await expect(esegui(a.token, ctx)).rejects.toThrow('conteggio_cambiato');
});
it('parametri non validi', async () => {
  await expect(anteprima('rilancia_cron', { cron: 'rm -rf' }, { s, origin: 'https://x', email: 'a', now: new Date() })).rejects.toThrow();
});
```
(`_svuotaToken` è un export per i test, come `_svuotaCacheMonitor`.)

- [ ] **Step 2:** FAIL → implementare `lib/console/azioni.ts` come descritto → PASS.
- [ ] **Step 3: Rotte** con `richiediAdmin`; `origin` = `new URL(req.url).origin`; `esegui` richiede `conferma === true` (400 altrimenti) e restituisce 409 con `{ errore, nuovaAnteprima? }` per `gia_eseguita`, `anteprima_scaduta`, `conteggio_cambiato`. `maxDuration = 300` sulla rotta `esegui`. Route test: 400 senza `conferma`, 409 su token già usato, 200 con esito.
- [ ] **Step 4:** test, typecheck.
- [ ] **Step 5: Commit** `feat(console): azioni di rimedio con prova a vuoto, conferma monouso e registro`.

---

### Task 11: Pagina Avvisi e cabina

**Files:**
- Create: `app/(console)/console/avvisi/page.tsx`, `components/console/Avvisi.tsx`, `components/console/RigaAvviso.tsx`, `components/console/FlussoAzione.tsx`, `components/console/RegistroAzioni.tsx`, `components/console/Cabina.tsx`
- Modify: `app/(console)/console/page.tsx` (cabina a destra: avvisi critici in alto + scheda lead)
- Test: `components/console/FlussoAzione.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/console/avvisi`, `POST /api/console/azioni/anteprima`, `POST /api/console/azioni/esegui`, `GET /api/console/azioni/registro`, `AvvisoConsole`, `AzioneRef`, `Anteprima`, `Esito`.
- Produces: `<FlussoAzione rif={AzioneRef} />` riusato anche dall'Assistente (Task 13) con stati `riposo → anteprima (caricamento) → pronta (mostra descrizione, conteggio, righe, avvertenza, bottoni "Conferma: <etichetta con numero>" e "Annulla") → esecuzione ("In corso…") → esito (testo fisso nella riga: "36 inviati, 2 falliti" + "Vedi dettagli") | errore (messaggio + "Rifai la prova")`.

- [ ] **Step 1: Test** (jsdom, `fetch` finto): clic su "Prova a vuoto" chiama solo `/anteprima`; il bottone di conferma contiene il conteggio ("Conferma: Rinvia 38"); clic su conferma chiama `/esegui` con `{ token, conferma: true }` e poi mostra "36 fatti, 2 falliti"; doppio clic rapido sulla conferma produce UNA sola chiamata a `/esegui` (bottone disabilitato durante l'esecuzione); 409 `conteggio_cambiato` mostra la nuova anteprima.
- [ ] **Step 2:** FAIL → implementare → PASS.
- [ ] **Step 3: Pagina Avvisi** (mockup cabina righe 617-679 in grande): testata con una riga di coppie etichetta/valore (aperti, critici, azioni oggi); gruppi per area in quest'ordine: critici prima; ogni riga = gravità (parola colorata + icona), titolo, significato, conteggio, prima/ultima occorrenza in mono, link "Vedi N chat" (`/console?vista=...&ids=` non esiste: usare `?chat=<primo id>` se 1 chat, altrimenti apertura di un Sheet con l'elenco delle chat coinvolte cliccabili), azioni (`FlussoAzione` per ogni `AzioneRef`), "Chiedi all'Assistente…", "Segna risolto…" (Dialog con nota). Tab "Registro azioni" con tabella 32 px: ora, azione, parametri, esito, chi. Sezione in fondo "Azioni manuali": un `FlussoAzione` per `rinvia_esiti_403`, `recupera_agende_consegnate` e `rilancia_cron` per ogni cron (select del cron). Polling 30 s. Stati vuoto ("Nessun avviso aperto. Qui compaiono gli errori del bot, dei cron e degli invii."), caricamento, errore.
- [ ] **Step 4: Cabina** nella pagina chat: i primi 3 avvisi critici/attenzione compatti (titolo + conteggio + azione primaria) con link "Tutti gli avvisi", sotto la `SchedaLead` della chat aperta.
- [ ] **Step 5:** test, typecheck, check:slop.
- [ ] **Step 6: Commit** `feat(console): pagina avvisi, cabina e flusso prova-conferma-esito`.

---

### Task 12: Assistente — strumenti e rotta

**Files:**
- Create: `lib/console/assistente-tools.ts`, `lib/console/assistente-prompt.ts`, `app/api/console/assistente/route.ts`
- Test: `lib/console/assistente-tools.test.ts`, `app/api/console/assistente/route.test.ts`

**Interfaces:**
- Consumes: `paginaChat`, `contaViste` (Task 5), `leggiAvvisi` (Task 9), `anteprima` non viene chiamata dall'Assistente; `erroreTwilio`; `fotografia`/`calcolaContatori`; `ID_AZIONI`, `PARAMS` (Task 10).
- Produces:

```ts
export const STRUMENTI: Anthropic.Tool[]; // definizioni JSON schema
export type RisultatoStrumento = { contenuto: string; citazioni: { tipo: 'chat' | 'avviso'; id: string | number; etichetta: string }[]; proposta?: AzioneRef; bozza?: { conversationId: number; testo: string } };
export async function eseguiStrumento(nome: string, input: unknown, ctx: { s: Supa; now: Date }): Promise<RisultatoStrumento>;
export function tronca(testo: string, max?: number): string; // default 2000
export const ASSISTENTE_MODEL = 'claude-sonnet-5';
export function systemPrompt(now: Date, lancio: { attivo: boolean; eventoAt: string | null }): string;
```
- `POST /api/console/assistente` body `{ messaggi: { ruolo: 'utente' | 'assistente'; testo: string }[] }` (max 20, testo ≤ 4.000) → `text/event-stream` con eventi JSON per riga `data:`: `{tipo:'strumento', nome, sintesi}` (es. "Letti 214 eventi di event_log, ultime 2 ore"), `{tipo:'testo', testo}`, `{tipo:'citazioni', citazioni}`, `{tipo:'proposta', proposta: AzioneRef}`, `{tipo:'bozza', bozza}`, `{tipo:'fine'}`, `{tipo:'errore', messaggio}`.

Strumenti:
- `cerca_lead { q: string }` → nuova funzione `cercaChat(s: Supa, q: string, now: Date): Promise<RigaLista[]>` in `lib/console/viste-db.ts` (riusa `leadIdsPerRicerca` + perimetro, nessuna vista, max 10 righe, ordine `last_message_at desc`); contenuto = una riga per chat `id · nome · telefono · anteprima · contesto`; citazioni `chat`. Aggiungere a `viste-db.test.ts`: `cercaChat` con `q` senza lead → `[]`.
- `leggi_chat { conversationId: number, ultimi?: number (≤ 40, default 20) }` → ultimi messaggi con mittente e ora + dati della scheda (fase, esito, stato CRM).
- `leggi_eventi { tipo?: string, conversationId?: number, ore?: number (≤ 72, default 6) }` → max 50 righe `ora · tipo · message`.
- `conta_viste {}` → `contaViste`.
- `elenca_avvisi {}` → `leggiAvvisi` (titolo, gravità, conteggio, cosaFare, id); citazioni `avviso`.
- `spiega_errore_twilio { code: number }` → `erroreTwilio`.
- `stato_lancio {}` → numeri della regia.
- `proponi_azione { azione: IdAzione, params: object, motivo: string }` → valida con `PARAMS[azione]`; NON chiama `anteprima`/`esegui`; restituisce `proposta: { azione, params, etichetta: motivo }` e contenuto "Proposta mostrata all'admin: la esegue solo lui dopo la prova a vuoto."
- `bozza_risposta { conversationId: number, testo: string }` → il modello scrive la bozza direttamente nell'input (dopo aver letto la chat con `leggi_chat`). Lo strumento legge `ai_paused_at`: se nullo restituisce il contenuto "Rifiutato: Mario è attivo su questa chat. Proponi prima pausa_mario." e nessuna bozza; altrimenti restituisce `bozza: { conversationId, testo }` e il contenuto "Bozza mostrata all'admin: la invia lui.". Non invia mai niente.
Tutti gli output passano da `tronca`.

Rotta: `richiediAdmin`; client `new Anthropic()` (usa `ANTHROPIC_API_KEY`); ciclo max 8 giri: `messages.create({ model: ASSISTENTE_MODEL, max_tokens: 2000, system, tools: STRUMENTI, messages })`; per ogni `tool_use` esegue `eseguiStrumento`, emette `strumento` (+ `proposta`/`bozza` se presenti), aggiunge `tool_result`; su `end_turn` emette il testo e `citazioni` raccolte, poi `fine`. Errori Anthropic/timeout (90 s complessivi) → evento `errore` con messaggio in italiano. `maxDuration = 120`. Il system prompt dice: sei l'assistente dell'admin della console Fenice; rispondi in italiano, breve; usa gli strumenti invece di supporre; cita chat e avvisi; non esegui mai azioni, le proponi con `proponi_azione` solo fra quelle elencate; per scrivere a un lead serve Mario in pausa; data e ora di Roma; stato del lancio.

- [ ] **Step 1: Test** `lib/console/assistente-tools.test.ts` (finto client e finti moduli `viste-db`/`avvisi-db` con `vi.mock`):
  - `proponi_azione` con parametri validi restituisce `proposta` e nessuna chiamata a `@/lib/console/azioni` (mock che fallisce se chiamato);
  - `proponi_azione` con `azione: 'cancella_tutto'` restituisce contenuto di errore e nessuna proposta;
  - `bozza_risposta` su chat con `ai_paused_at: null` → nessuna `bozza`, contenuto che inizia con "Rifiutato";
  - `bozza_risposta` su chat in pausa → `bozza.testo` uguale all'input;
  - `leggi_eventi` con `ore: 500` viene ridotto a 72;
  - `tronca('a'.repeat(3000))` è lungo 2000 e finisce con "…".
- [ ] **Step 2:** FAIL → implementare → PASS.
- [ ] **Step 3: Route test** con `vi.mock('@anthropic-ai/sdk')`: una risposta con `tool_use` `conta_viste` e poi `end_turn` produce gli eventi `strumento`, `testo`, `fine` nell'ordine; 401/403; 400 con `messaggi` vuoto; eccezione dell'SDK → evento `errore`.
- [ ] **Step 4:** test, typecheck.
- [ ] **Step 5: Commit** `feat(console): Assistente con strumenti di sola lettura, proposte e bozze a bot fermo`.

---

### Task 13: Assistente e palette nell'interfaccia

**Files:**
- Create: `components/console/Assistente.tsx`, `components/console/Palette.tsx`, `components/console/useAssistente.ts`
- Create: `app/(console)/console/assistente/page.tsx`
- Modify: `components/console/Shell.tsx` (monta Palette e pannello), `components/console/Composer.tsx` (accetta una bozza)
- Test: `components/console/useAssistente.test.ts`

**Interfaces:**
- Consumes: `POST /api/console/assistente` (SSE), `<FlussoAzione>` (Task 11), `useTastiera` (Task 6).
- Produces: context `AssistenteProvider` con `apri(domanda?: string)`, `chiudi()`; `useAssistente()` → `{ messaggi, invia(testo), inCorso, passi, errore }`; il Composer espone `impostaBozza(testo)` tramite context `ComposerBridge`.

- [ ] **Step 1: Test** `useAssistente` (fetch finto che restituisce uno stream con righe `data: {...}`): accumula i passi `strumento`, il testo e le citazioni; `errore` imposta lo stato di errore e lascia `inCorso=false`; una seconda `invia` mentre `inCorso` è ignorata.
- [ ] **Step 2:** FAIL → implementare (parser SSE su `ReadableStream` con `TextDecoder`, righe `data:`) → PASS.
- [ ] **Step 3: Pannello** (mockup "Schermata 2: Assistente", righe 680 in poi): Sheet a destra largo 440 px (su `/console/assistente` a tutta pagina); domanda in blocco `var(--s3)`; passi strumento come righe compatte richiudibili ("Letti 214 eventi…", query in mono); testo della risposta max 65 caratteri per riga; citazioni come link (chat → `?chat=id`, avviso → `/console/avvisi#id`); `proposta` resa con `<FlussoAzione>`; `bozza` resa con bottone "Metti nel composer" (solo se la chat è aperta). Mentre lavora: testo "Sto leggendo…" (nessuna animazione). Stato vuoto: 3 domande generate dai dati correnti (conteggi di `/api/console/viste` e primo avviso: es. "Perché 41 invii sono falliti?", "Chi scrive 'disdetta' oggi?", "Com'è messo il lancio?"). Errore: messaggio + "Riprova".
- [ ] **Step 4: Palette** con `cmdk` (`Command.Dialog`), 560 px, nessuna animazione d'apertura, gruppi: "Vai a" (le 9 viste, Avvisi, Lancio, Impostazioni…), "Chat" (ricerca con l'endpoint dedicato `GET /api/console/cerca?q=` → `{ righe: RigaLista[] }`, che chiama `cercaChat` del Task 12; crearlo in questo task, file `app/api/console/cerca/route.ts`, con `richiediAdmin` e route test 401/400 senza `q`/200), "Azioni sulla chat aperta" (pausa/riprendi → `FlussoAzione` con `pausa_mario`/`riprendi_mario`), "Assistente" ("Chiedi all'Assistente: <testo digitato>"). Scorciatoie mostrate con `Kbd`.
- [ ] **Step 5:** test, typecheck, check:slop.
- [ ] **Step 6: Commit** `feat(console): pannello Assistente, palette Ctrl+K e bozze nel composer`.

---

### Task 14: Sala del lancio

**Files:**
- Create: `app/(console)/console/lancio/page.tsx`, `components/console/SalaLancio.tsx`, `components/console/GraficoOre.tsx`
- Modify: `components/console/BarraRegia.tsx` (estrarre il grafico in `GraficoOre` riusabile)
- Test: `components/console/GraficoOre.test.tsx`

**Interfaces:**
- Consumes: `GET /api/console/regia` (`Regia`), `GET /api/console/avvisi` (filtrati `area === 'lancio' || id.startsWith('twilio_')`), `ETICHETTA_FASE`.
- Produces: pagina con: riga di numeri (iscritti, posto bloccato, link inviati, consegnati, falliti, restituiti) come coppie etichetta/valore; `GraficoOre` grande (altezza 180 px) con asse ore e annotazione dell'ora corrente; "Fin dove sono arrivati": barre orizzontali per fase (`perFase`) in `var(--bar)`, ognuna link alla vista `lancio` con `fase=`; avvisi del lancio con `FlussoAzione`; stato del lancio (attivo, pulsante, evento) con link a Impostazioni.

- [ ] **Step 1: Test** (jsdom): `GraficoOre` con 24 voci rende 24 `<rect>` di consegna e un `<rect>` di fallimento solo per le ore con `falliti > 0`; con tutte a zero rende il testo "Ancora nessun invio oggi".
- [ ] **Step 2:** FAIL → implementare → PASS.
- [ ] **Step 3:** pagina e stati (vuoto se `attivo=false`: "Nessun lancio attivo. Si accende da Impostazioni.").
- [ ] **Step 4:** test, typecheck, check:slop.
- [ ] **Step 5: Commit** `feat(console): sala del lancio con fasi, grafico ore e avvisi`.

---

### Task 15: Sezioni riportate nella console (Impostazioni, Analisi, Simulatore, Campagne, Log, Serenamente)

**Files:**
- Create: `app/(console)/console/impostazioni/page.tsx` + `components/console/sezioni/Impostazioni.tsx`
- Create: `app/(console)/console/analisi/page.tsx` + `components/console/sezioni/Analisi.tsx`
- Create: `app/(console)/console/simulatore/page.tsx` + `components/console/sezioni/Simulatore.tsx`
- Create: `app/(console)/console/campagne/page.tsx` + `components/console/sezioni/Campagne.tsx`
- Create: `app/(console)/console/log/page.tsx` + `components/console/sezioni/Log.tsx` + `app/api/console/log/route.ts`
- Create: `app/(console)/console/serenamente/page.tsx` + `components/console/sezioni/Serenamente.tsx`
- Test: `app/api/console/log/route.test.ts`, `components/console/sezioni/Impostazioni.test.tsx`

**Interfaces:**
- Consumes (API esistenti, invariate): `/api/fenice/lancio-settings` (GET/POST), `/api/fenice/autoreply`, `/api/fenice/segments`, `/api/fenice/report`, `/api/fenice/analysis`, `/api/fenice/sim`, `/api/campaigns` (+ `[id]`), `/api/conversations`, `/api/conversations/[id]/messages`, `/api/conversations/[id]/read`, `/api/messages`.
- Produces: `GET /api/console/log?tipo=&livello=&conv=&prima=` → max 100 righe di `event_log` (`id, type, level, message, created_at, payload`) a cursore su `created_at`.

Regola di porting per ogni sezione: leggere il componente vecchio (`app/(fenice)/fenice/impostazioni/_components/ImpostazioniLancioPanel.tsx`, `app/(fenice)/fenice/lead/_components/LeadPipeline.tsx`, `app/(fenice)/fenice/_components/Simulator.tsx`, `app/(app)/campagne/page.tsx` + `_components/CampaignDrawer.tsx`, `app/(app)/log/page.tsx`, `app/(app)/inbox/*` + `components/ConversationList.tsx` + `MessageThread.tsx` + `Composer.tsx`), riscrivere la sola presentazione con i primitivi `components/console/ui/*` e i token, tenere IDENTICHE le chiamate API, i payload e le validazioni, eliminare `StatCard`, `PageHeader` con kicker maiuscolo, `Sparkles`, aurora. Niente griglie di card: numeri come coppie etichetta/valore o tabelle 32 px.
- Impostazioni: interruttori (Switch Radix restilizzato) + campi; ogni cambio mostra valore prima → dopo e chiede conferma per `lancio_attivo` e `lancio_pulsante_attivo`; errore 500 della rotta mostrato come "Non salvato: …" (mai "Salvato").
- Analisi: tab Presi/Attive/Mai risposto/Ferme/Report/Analisi AI come segment control; tabelle 32 px; analisi AI come testo + BarList SVG propria delle obiezioni.
- Simulatore: thread con le stesse bolle del Task 7.
- Campagne: tabella + Sheet di creazione (stessi campi del drawer vecchio).
- Log: tabella 32 px con filtri tipo/livello/conversazione, righe espandibili con payload JSON in mono.
- Serenamente: lista + thread + composer riusando `RigaChat`, `Bolla`, stile Task 6-7, ma con le API `/api/conversations*` e `/api/messages` (qui la lettura azzera come nell'inbox vecchia).

- [ ] **Step 1: Test** `app/api/console/log/route.test.ts`: 401/403; `livello=error` filtra; `prima=<iso>` pagina; limite 100.
- [ ] **Step 2: Test** `Impostazioni.test.tsx` (fetch finto): spegnere `lancio_attivo` apre la conferma e, confermato, chiama POST `/api/fenice/lancio-settings` con `{ key:'lancio_attivo', value:false }`; una risposta 500 mostra "Non salvato".
- [ ] **Step 3:** FAIL → implementare le sei sezioni → PASS.
- [ ] **Step 4:** typecheck, check:slop.
- [ ] **Step 5: Commit** (uno per sezione va bene) `feat(console): impostazioni, analisi, simulatore, campagne, log e Serenamente nella Regia`.

---

### Task 16: Revisione visiva, accessibilità e build

**Files:**
- Create: `scripts/screenshot-console.ts`
- Modify: file della console secondo i ritrovamenti

**Interfaces:**
- Consumes: tutto il resto; credenziali da `CONSOLE_EMAIL`/`CONSOLE_PASSWORD` (env, lette dal file creato dal Task 1, MAI nel repo).

- [ ] **Step 1: Script** Playwright (già in devDependencies): avvia contro `http://localhost:3000`, fa login dalla pagina `/login`, poi per ogni pagina (`/console?vista=` di ciascuna delle 9 viste con una chat aperta, `/console/avvisi`, `/console/lancio`, `/console/assistente`, `/console/impostazioni`, `/console/analisi`, `/console/simulatore`, `/console/campagne`, `/console/log`, `/console/serenamente`) salva screenshot in `.screens/` (in `.gitignore`) a 1440×900 e 1280×800, tema scuro e chiaro. Stampa gli errori della console del browser e le risposte ≥ 400.
- [ ] **Step 2:** `bun run build` e `bun start` (o `bun dev`), poi `CONSOLE_EMAIL=… CONSOLE_PASSWORD=… bun scripts/screenshot-console.ts`. Zero errori JS, zero 5xx.
- [ ] **Step 3: Revisione** di ogni screenshot contro `docs/design/direzione-console-anti-slop.md` sezione 4 (squint test, scala di grigi, stati, densità: almeno 12 chat visibili a 1440×900, nessun testo tagliato, nessun overflow orizzontale) e contro il mockup. Correggere e rifare gli screenshot finché è tutto a posto.
- [ ] **Step 4: Tastiera**: giro completo senza mouse (`j/k`, `Invio`, `Esc`, `Ctrl+K`, `]`, Tab su tutti i controlli con focus visibile).
- [ ] **Step 5:** `bun run typecheck`, `bun run test` (tutta la suite, non solo la console), `bun run lint`, `bun run check:slop`, `bun run build` verdi.
- [ ] **Step 6: Commit** `fix(console): revisione visiva e da tastiera`.

---

### Task 17: Rilascio

- [ ] **Step 1:** `git fetch origin && git merge origin/main` sul branch; risolvere conflitti; rifare Step 5 del Task 16.
- [ ] **Step 2:** merge in `main` e `git push origin main` (deploy Vercel automatico). Verificare con `mcp__vercel__list_deployments` (progetto `prj_gTbiVq5BX65pievRkpM7PHOFkVNL`, team `team_HQ6j7kWTKLK8Hw4Kfv2iElcj`) che lo stato sia READY.
- [ ] **Step 3:** creare/aggiornare l'account: `bun --env-file=.env.local scripts/crea-admin-console.ts admin@fenice.com "C:/Users/bruno/Desktop/credenziali-console-admin.txt"`.
- [ ] **Step 4:** smoke test in produzione: `scripts/screenshot-console.ts` con `BASE_URL=https://web-app-messaggistica.vercel.app` su `/console`, `/console/avvisi`, `/console/lancio`; controllare che le pagine vecchie (`/chat`, `/fenice/lancio`, `/inbox`) rispondano ancora.
- [ ] **Step 5:** nessuna azione di rimedio eseguita in produzione durante lo smoke test (solo "Prova a vuoto").
