# Fenice "Mario" AI Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a siloed `/fenice` section (login `fenicebot@fenice.com`) with a shared "Mario" Claude engine: a web simulator (phase 1) and real-WhatsApp auto-reply for enrolled leads behind a global switch (phase 2).

**Architecture:** A pure Mario engine (`lib/mario.ts`) wraps the Anthropic SDK and is reused by both a stateless simulator API and the existing Twilio inbound webhook. Access control is an email→area map enforced in `proxy.ts` + layouts. Live state lives in two new `conversations` columns plus a tiny `app_settings` toggle. Data stays in the existing tables; the Fenice context is distinguished by the WhatsApp number it arrives on.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts` middleware), Supabase (auth + Postgres), Twilio WhatsApp, `@anthropic-ai/sdk` (model `claude-sonnet-4-6`), Vitest.

**Conventions to follow (read before coding):**
- API routes mirror `app/api/send-agenda/route.ts`: `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';`.
- Tests mirror `lib/twilio.test.ts` (Vitest, `vi.mock`, Italian `it(...)` descriptions).
- This repo's middleware file is `proxy.ts` (Next 16 rename) — **not** `middleware.ts`.
- Run tests with `bun run test` (vitest). Type-check with `bun run typecheck`.

---

### Task 1: Add the Anthropic SDK and env scaffolding

**Files:**
- Modify: `package.json` (dependency added by installer)
- Modify: `.env.example`

- [ ] **Step 1: Install the official SDK**

Run: `bun add @anthropic-ai/sdk`
Expected: `@anthropic-ai/sdk` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Add the new env vars to `.env.example`**

Append this block to `.env.example` (after the `# App` section):

```
# Anthropic (Mario AI agent)
ANTHROPIC_API_KEY=

# Fenice (Mario) WhatsApp
TWILIO_WHATSAPP_NUMBER_FENICE=whatsapp:+393520413199
FENICE_OPENING_TEMPLATE_SID=HXa2da97153df29161cc4151a83b809e1e
```

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock .env.example
git commit -m "chore(fenice): add @anthropic-ai/sdk + Fenice/Anthropic env vars"
```

---

### Task 2: Mario system prompt

**Files:**
- Create: `lib/mario-prompt.ts`

- [ ] **Step 1: Create the prompt module**

Create `lib/mario-prompt.ts` exporting the system prompt verbatim from `mario_bot.py` (the `SYSTEM_PROMPT` string, lines 5–234 of that file). Use a backtick template literal. Structure:

```typescript
// System prompt per l'agente "Mario" di Fenice Academy.
// Portato 1:1 da mario_bot.py. Tenere isolato per arricchirlo coi documenti di vendita.
export const MARIO_SYSTEM_PROMPT = `IDENTITÀ
Sei Mario, consulente di Fenice Academy, una scuola di formazione per le professioni digitali. Stai scrivendo su WhatsApp con un lead che ha mostrato interesse per le professioni digitali. Il tuo obiettivo finale è fissare un appuntamento tramite questo link: https://form.jotform.com/240755654585063

---

FENICE ACADEMY — TUTTO QUELLO CHE DEVI SAPERE
... (full text from mario_bot.py SYSTEM_PROMPT, unchanged) ...
— Se il lead dice che non è interessato, rispetta la sua decisione e usa [PASSAGGIO_UMANO]`;
```

Copy the complete text between the triple-quotes in `mario_bot.py` (start `IDENTITÀ`, end `...usa [PASSAGGIO_UMANO]`). The literal contains no backticks or `${`, so no escaping is needed — verify this after pasting.

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add lib/mario-prompt.ts
git commit -m "feat(fenice): Mario system prompt module"
```

---

### Task 3: Mario engine (tag parsing + Claude call)

**Files:**
- Create: `lib/mario.ts`
- Test: `lib/mario.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/mario.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: messagesCreate };
  },
}));

import { parseMarioReply, generateMarioReply } from './mario';

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});

describe('parseMarioReply', () => {
  it('rimuove i tag e ritorna i flag', () => {
    const r = parseMarioReply('Perfetto! [APPUNTAMENTO_FISSATO] a presto');
    expect(r.appointmentFixed).toBe(true);
    expect(r.passToHuman).toBe(false);
    expect(r.visibleReply).toBe('Perfetto!  a presto');
  });

  it('rileva il passaggio umano', () => {
    const r = parseMarioReply('Ti passo un collega [PASSAGGIO_UMANO]');
    expect(r.passToHuman).toBe(true);
    expect(r.visibleReply).toBe('Ti passo un collega');
  });

  it('testo normale: nessun flag', () => {
    const r = parseMarioReply('Ciao, come stai?');
    expect(r).toEqual({ visibleReply: 'Ciao, come stai?', appointmentFixed: false, passToHuman: false });
  });
});

describe('generateMarioReply', () => {
  it('chiama Claude con system prompt + history e ritorna il testo pulito', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao! Sono Mario 😊' }] });
    const out = await generateMarioReply([{ role: 'user', content: 'ciao' }]);
    expect(out.visibleReply).toBe('Ciao! Sono Mario 😊');
    const arg = messagesCreate.mock.calls[0][0];
    expect(arg.model).toBe('claude-sonnet-4-6');
    expect(arg.messages).toEqual([{ role: 'user', content: 'ciao' }]);
    expect(typeof arg.system).toBe('string');
  });

  it('history vuota: usa il seed di apertura', async () => {
    messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao!' }] });
    await generateMarioReply([]);
    expect(messagesCreate.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'Inizia la conversazione presentandoti.' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test lib/mario.test.ts`
Expected: FAIL — `parseMarioReply`/`generateMarioReply` not exported (module not found).

- [ ] **Step 3: Implement `lib/mario.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { MARIO_SYSTEM_PROMPT } from './mario-prompt';

export const MARIO_MODEL = 'claude-sonnet-4-6';

export type MarioTurn = { role: 'user' | 'assistant'; content: string };
export type MarioResult = {
  visibleReply: string;
  appointmentFixed: boolean;
  passToHuman: boolean;
};

/** Rileva i tag speciali, li rimuove dal testo visibile e ritorna i flag. */
export function parseMarioReply(raw: string): MarioResult {
  const appointmentFixed = raw.includes('[APPUNTAMENTO_FISSATO]');
  const passToHuman = raw.includes('[PASSAGGIO_UMANO]');
  const visibleReply = raw
    .replace(/\[APPUNTAMENTO_FISSATO\]/g, '')
    .replace(/\[PASSAGGIO_UMANO\]/g, '')
    .trim();
  return { visibleReply, appointmentFixed, passToHuman };
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Genera la prossima risposta di Mario data la cronologia (user/assistant). */
export async function generateMarioReply(history: MarioTurn[]): Promise<MarioResult> {
  const messages =
    history.length > 0
      ? history
      : [{ role: 'user' as const, content: 'Inizia la conversazione presentandoti.' }];

  const response = await getClient().messages.create({
    model: MARIO_MODEL,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    system: MARIO_SYSTEM_PROMPT,
    messages,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
  return parseMarioReply(raw);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test lib/mario.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mario.ts lib/mario.test.ts
git commit -m "feat(fenice): Mario engine — tag parsing + Claude call"
```

---

### Task 4: Twilio `from`-number override

**Files:**
- Modify: `lib/twilio.ts:3-13` (input types), `lib/twilio.ts:59-90` (send functions)
- Test: `lib/twilio.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `lib/twilio.test.ts` inside the existing file (after the `sendFreeText` describe block):

```typescript
describe('from override', () => {
  it('sendTemplate usa il from passato', async () => {
    messagesCreate.mockResolvedValueOnce({ sid: 'SM_O', status: 'queued' });
    await sendTemplate({
      to: '+393331234567', contentSid: 'HX1', variables: {}, from: 'whatsapp:+393520413199',
    });
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      from: 'whatsapp:+393520413199',
    }));
  });

  it('sendFreeText usa il from passato', async () => {
    messagesCreate.mockResolvedValueOnce({ sid: 'SM_O2', status: 'queued' });
    await sendFreeText({ to: '+393331234567', body: 'ciao', from: 'whatsapp:+393520413199' });
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      from: 'whatsapp:+393520413199',
    }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test lib/twilio.test.ts`
Expected: FAIL — `from` not yet a valid field / not passed through.

- [ ] **Step 3: Implement the override**

In `lib/twilio.ts`, add `from?: string;` to both input types:

```typescript
type SendTemplateInput = {
  to: string;
  contentSid: string;
  variables: Record<string, string>;
  from?: string;
};

type SendFreeTextInput = {
  to: string;
  body: string;
  from?: string;
};
```

In `sendTemplate`, change the `create` call's `from`:

```typescript
const msg = await client.messages.create({
  from: input.from ?? fromNumber(),
  to: `whatsapp:${input.to}`,
  contentSid: input.contentSid,
  contentVariables: JSON.stringify(input.variables),
  statusCallback: statusCallbackUrl(),
});
```

In `sendFreeText`, change the `from`:

```typescript
const msg = await client.messages.create({
  from: input.from ?? fromNumber(),
  to: `whatsapp:${input.to}`,
  body: input.body,
  statusCallback: statusCallbackUrl(),
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test lib/twilio.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/twilio.ts lib/twilio.test.ts
git commit -m "feat(twilio): optional from-number override (per Fenice sender)"
```

---

### Task 5: DB migration — `ai_owner`/`ai_status` + `app_settings`

**Files:**
- Create: `supabase/migrations/20260616000005_fenice_ai.sql`
- Modify: `lib/supabase/types.ts`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260616000005_fenice_ai.sql`:

```sql
-- Stato AI sulle conversazioni (Mario) + interruttore globale auto-risposta.

alter table conversations
  add column if not exists ai_owner  text,                -- null = umano | 'mario'
  add column if not exists ai_status text;                -- null | 'active' | 'handed_off' | 'booked'

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value)
  values ('fenice_ai_autoreply', 'false'::jsonb)
  on conflict (key) do nothing;
```

- [ ] **Step 2: Apply the migration**

Run via the Supabase MCP `apply_migration` tool (name `fenice_ai`, the SQL above), or `supabase db push` if using the CLI.
Expected: migration applies; `conversations` has `ai_owner`/`ai_status`; `app_settings` exists with the `fenice_ai_autoreply=false` row.

- [ ] **Step 3: Update generated types**

In `lib/supabase/types.ts`, add the two columns to the `conversations` table's `Row`, `Insert`, and `Update` shapes:

```typescript
ai_owner: string | null;
ai_status: string | null;
```

(In `Insert`/`Update` make them optional: `ai_owner?: string | null;`.) Then add an `app_settings` table entry mirroring the existing table shapes:

```typescript
app_settings: {
  Row: { key: string; value: Json; updated_at: string };
  Insert: { key: string; value: Json; updated_at?: string };
  Update: { key?: string; value?: Json; updated_at?: string };
  Relationships: [];
};
```

Prefer regenerating: `bun run supabase:gen-types` (requires `SUPABASE_PROJECT_ID`). If that's unavailable, hand-edit as above.

- [ ] **Step 4: Type-check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260616000005_fenice_ai.sql lib/supabase/types.ts
git commit -m "feat(fenice): DB — conversations.ai_owner/ai_status + app_settings toggle"
```

---

### Task 6: Access map + routing/layout gates

**Files:**
- Create: `lib/access.ts`
- Test: `lib/access.test.ts`
- Modify: `proxy.ts`
- Modify: `app/(auth)/login/actions.ts:6-23`

- [ ] **Step 1: Write the failing test**

Create `lib/access.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { areaForEmail, canAccess, landingPath } from './access';

describe('access map', () => {
  it('fenicebot vede solo fenice', () => {
    expect(areaForEmail('fenicebot@fenice.com')).toBe('fenice');
    expect(canAccess('fenicebot@fenice.com', '/fenice')).toBe(true);
    expect(canAccess('fenicebot@fenice.com', '/inbox')).toBe(false);
    expect(landingPath('fenicebot@fenice.com')).toBe('/fenice');
  });

  it('utente normale vede CRM + fenice', () => {
    expect(areaForEmail('brunoiacopo02@gmail.com')).toBe('all');
    expect(canAccess('brunoiacopo02@gmail.com', '/inbox')).toBe(true);
    expect(canAccess('brunoiacopo02@gmail.com', '/fenice')).toBe(true);
    expect(landingPath('brunoiacopo02@gmail.com')).toBe('/inbox');
  });

  it('email sconosciuta: default CRM', () => {
    expect(areaForEmail('x@y.com')).toBe('all');
    expect(canAccess('x@y.com', '/fenice')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test lib/access.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/access.ts`**

```typescript
// Mappa email -> area consentita. Nessun ruolo nel DB (scelta: dati condivisi).
// 'fenice' = solo /fenice. 'all' = CRM completo + /fenice.
export type Area = 'fenice' | 'all';

const FENICE_ONLY = new Set(['fenicebot@fenice.com']);

export function areaForEmail(email: string | null | undefined): Area {
  if (email && FENICE_ONLY.has(email.toLowerCase())) return 'fenice';
  return 'all';
}

/** True se l'utente può aprire il path dato. */
export function canAccess(email: string | null | undefined, path: string): boolean {
  if (areaForEmail(email) === 'all') return true;
  // fenice-only: solo /fenice (e relative API)
  return path.startsWith('/fenice') || path.startsWith('/api/fenice');
}

/** Dove mandare l'utente dopo il login. */
export function landingPath(email: string | null | undefined): string {
  return areaForEmail(email) === 'fenice' ? '/fenice' : '/inbox';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test lib/access.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Enforce in `proxy.ts`**

Replace the body of `proxy.ts`'s `proxy()` with the version below (adds `/fenice` + `/api/fenice` handling and area redirects). Note `refreshSession` returns `{ response, user }`; `user.email` is available.

```typescript
import { type NextRequest, NextResponse } from 'next/server';
import { refreshSession } from '@/lib/supabase/middleware';
import { canAccess, landingPath } from '@/lib/access';

const PUBLIC_PATHS = ['/login', '/api/webhooks', '/api/cron', '/api/send-agenda', '/api/send-template'];

export async function proxy(request: NextRequest) {
  const { response, user } = await refreshSession(request);
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('from', path);
    return NextResponse.redirect(url);
  }

  if (user && path === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = landingPath(user.email);
    return NextResponse.redirect(url);
  }

  // Gate per area: un utente fenice-only fuori da /fenice -> torna a /fenice
  if (user && !isPublic && !canAccess(user.email, path)) {
    const url = request.nextUrl.clone();
    url.pathname = landingPath(user.email);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
```

- [ ] **Step 6: Redirect after login by area**

In `app/(auth)/login/actions.ts`, the action currently redirects to `from`. Keep `from` for deep links but fall back to the area landing page. Replace the success redirect (line 22 `redirect(from);`) with area-aware logic:

```typescript
  // ...after successful signInWithPassword...
  const { data: { user } } = await supabase.auth.getUser();
  const dest = from && from !== '/inbox' ? from : landingPath(user?.email);
  redirect(dest);
```

Add the import at the top: `import { landingPath } from '@/lib/access';`. (The `from` hidden field still defaults to `/inbox`; this makes a fenicebot login land on `/fenice` instead.)

- [ ] **Step 7: Type-check + full test run**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/access.ts lib/access.test.ts proxy.ts "app/(auth)/login/actions.ts"
git commit -m "feat(fenice): email->area access map + proxy/login gating"
```

---

### Task 7: Fenice layout + sidebar (siloed nav)

**Files:**
- Create: `app/(fenice)/layout.tsx`
- Create: `components/FeniceSidebar.tsx`

- [ ] **Step 1: Create the Fenice sidebar**

Create `components/FeniceSidebar.tsx` (mirror `components/Sidebar.tsx`, minimal nav, no CRM links):

```tsx
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Bot, Radio } from 'lucide-react';
import { signOutAction } from '@/app/(auth)/login/actions';
import { ThemeToggle } from '@/components/ThemeToggle';

const NAV = [
  { href: '/fenice', label: 'Simulatore', icon: Bot, exact: true },
  { href: '/fenice/live', label: 'Live', icon: Radio },
];

export function FeniceSidebar({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 border-r bg-zinc-50 dark:bg-zinc-900">
      <div className="p-4 font-semibold text-lg">Fenice · Mario</div>
      <nav className="flex-1 px-2 space-y-1">
        {NAV.map((item) => {
          const active = item.exact ? pathname === item.href : pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-md text-sm',
                active ? 'bg-zinc-200 dark:bg-zinc-800 font-medium' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t text-xs text-zinc-500 space-y-2">
        <div className="truncate" title={userEmail}>{userEmail}</div>
        <form action={signOutAction}>
          <button type="submit" className="text-red-600 hover:underline">Esci</button>
        </form>
        <ThemeToggle />
      </div>
    </aside>
  );
}
```

(If `Bot`/`Radio` are missing from the installed `lucide-react`, substitute any two exported icons, e.g. `MessageSquare`, `Send`.)

- [ ] **Step 2: Create the Fenice layout (server-side gate)**

Create `app/(fenice)/layout.tsx` (mirror `app/(app)/layout.tsx`, but gate with the access map and use `FeniceSidebar`):

```tsx
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { FeniceSidebar } from '@/components/FeniceSidebar';

export default async function FeniceLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="flex h-svh">
      <FeniceSidebar userEmail={user.email ?? ''} />
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: PASS (pages added next task; layout compiles standalone).

- [ ] **Step 4: Commit**

```bash
git add "app/(fenice)/layout.tsx" components/FeniceSidebar.tsx
git commit -m "feat(fenice): siloed layout + sidebar"
```

---

### Task 8: Simulator API (stateless, no DB)

**Files:**
- Create: `app/api/fenice/sim/route.ts`

- [ ] **Step 1: Implement the route**

Create `app/api/fenice/sim/route.ts`. It requires an authenticated session (any logged-in user reaching `/api/fenice/*` is allowed per `canAccess`), takes the running history client-side, and returns Mario's next turn. No Twilio, no DB writes.

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { generateMarioReply, type MarioTurn } from '@/lib/mario';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  let body: { history?: MarioTurn[] } = {};
  try {
    body = (await req.json()) as { history?: MarioTurn[] };
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON non valido' }, { status: 400 });
  }

  const history = Array.isArray(body.history) ? body.history : [];
  // sanity: solo turni user/assistant con content stringa
  const clean = history
    .filter((t) => (t?.role === 'user' || t?.role === 'assistant') && typeof t?.content === 'string')
    .map((t) => ({ role: t.role, content: t.content }));

  try {
    const result = await generateMarioReply(clean);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'errore Claude';
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/fenice/sim/route.ts
git commit -m "feat(fenice): stateless simulator API (/api/fenice/sim)"
```

---

### Task 9: Simulator UI (chat page)

**Files:**
- Create: `app/(fenice)/fenice/page.tsx`
- Create: `app/(fenice)/fenice/_components/Simulator.tsx`

- [ ] **Step 1: Create the page (server)**

Create `app/(fenice)/fenice/page.tsx`:

```tsx
import { Simulator } from './_components/Simulator';

export default function FenicePage() {
  return (
    <div className="h-full flex flex-col">
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Simulatore — Mario</h1>
        <p className="text-sm text-zinc-500">Scrivi come se fossi il lead. Mario risponde. Niente WhatsApp reale.</p>
      </header>
      <Simulator />
    </div>
  );
}
```

- [ ] **Step 2: Create the client chat component**

Create `app/(fenice)/fenice/_components/Simulator.tsx`. Holds history in React state, posts to `/api/fenice/sim`, shows badges when tags fire. On mount it requests Mario's opening message (empty history).

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

type Turn = { role: 'user' | 'assistant'; content: string };

export function Simulator() {
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appointment, setAppointment] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const started = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function ask(next: Turn[]) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/fenice/sim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ history: next }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Errore');
      setHistory([...next, { role: 'assistant', content: data.visibleReply }]);
      if (data.appointmentFixed) setAppointment(true);
      if (data.passToHuman) setHandoff(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Errore');
    } finally {
      setLoading(false);
    }
  }

  // Apertura di Mario al primo mount
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void ask([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history, loading]);

  function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...history, { role: 'user' as const, content: text }];
    setHistory(next);
    setInput('');
    void ask(next);
  }

  function reset() {
    setHistory([]); setAppointment(false); setHandoff(false); setError(null);
    started.current = true;
    void ask([]);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {history.map((t, i) => (
          <div key={i} className={cn('flex', t.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className={cn(
              'max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap',
              t.role === 'user' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800',
            )}>
              {t.content}
            </div>
          </div>
        ))}
        {loading && <div className="text-xs text-zinc-400">Mario sta scrivendo…</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="border-t px-6 py-3 space-y-2">
        <div className="flex gap-2">
          {appointment && <Badge className="bg-emerald-600">✅ Appuntamento fissato</Badge>}
          {handoff && <Badge variant="destructive">🔔 Passaggio a operatore</Badge>}
        </div>
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Scrivi come lead…"
            disabled={loading}
          />
          <Button onClick={send} disabled={loading || !input.trim()}>Invia</Button>
          <Button variant="outline" onClick={reset} disabled={loading}>Reset</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check + run dev sanity**

Run: `bun run typecheck`
Expected: PASS. (Manual: `bun run dev`, log in as `fenicebot@fenice.com`, land on `/fenice`, confirm Mario opens and replies.)

- [ ] **Step 4: Commit**

```bash
git add "app/(fenice)/fenice/page.tsx" "app/(fenice)/fenice/_components/Simulator.tsx"
git commit -m "feat(fenice): simulator chat UI"
```

---

### Task 10: Settings helper (global auto-reply toggle)

**Files:**
- Create: `lib/fenice-settings.ts`

- [ ] **Step 1: Implement the helper**

Create `lib/fenice-settings.ts` with read/write helpers over `app_settings` using the admin client (server-only).

```typescript
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;
const KEY = 'fenice_ai_autoreply';

export async function getAutoReply(supabase: Supa): Promise<boolean> {
  const { data } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
  return data?.value === true;
}

export async function setAutoReply(supabase: Supa, on: boolean): Promise<void> {
  await supabase.from('app_settings')
    .upsert({ key: KEY, value: on as never, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/fenice-settings.ts
git commit -m "feat(fenice): app_settings auto-reply toggle helper"
```

---

### Task 11: Enroll API + toggle API

**Files:**
- Create: `app/api/fenice/enroll/route.ts`
- Create: `app/api/fenice/autoreply/route.ts`
- Modify: `lib/messaging.ts` (add optional `from` to `sendTemplateAndLog`)

- [ ] **Step 1: Thread `from` through `sendTemplateAndLog`**

In `lib/messaging.ts`, add a 6th optional param `from?: string` to `sendTemplateAndLog` and pass it into `sendTemplate`:

```typescript
export async function sendTemplateAndLog(
  supabase: Supa,
  conversationId: number,
  phone: string,
  templateSid: string,
  label: string,
  from?: string,
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const tplBody = (await getTemplateBody(templateSid)) ?? `[template] ${label}`;
  try {
    const sent = await sendTemplate({ to: phone, contentSid: templateSid, variables: {}, from });
    // ...rest unchanged...
```

(Existing callers omit `from` and keep the default sender — no behavior change.)

- [ ] **Step 2: Implement enroll route**

Create `app/api/fenice/enroll/route.ts`. Requires an authed session; sends the Fenice opening template from the Fenice number and marks the conversation `ai_owner='mario', ai_status='active'`.

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';
import { findOrCreateLeadConversation, sendTemplateAndLog } from '@/lib/messaging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const phone = toE164((body.phone ?? null) as string | null);
  if (!phone) return NextResponse.json({ ok: false, error: 'telefono non valido' }, { status: 400 });

  const templateSid = process.env.FENICE_OPENING_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    return NextResponse.json({ ok: false, error: 'FENICE_OPENING_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati' }, { status: 500 });
  }

  const supabase = getSupabaseAdmin();
  const { conversationId } = await findOrCreateLeadConversation(supabase, {
    phone,
    firstName: (body.firstName ?? body.first_name) as string | undefined,
  });

  const res = await sendTemplateAndLog(supabase, conversationId, phone, templateSid, 'Fenice apertura', from);

  await supabase.from('conversations')
    .update({ ai_owner: 'mario', ai_status: 'active' })
    .eq('id', conversationId);

  await supabase.from('event_log').insert({
    type: res.ok ? 'fenice_enroll' : 'send_error',
    payload: { phone, conversationId, sid: res.sid, error: res.error } as never,
    message: res.ok ? `Lead arruolato (Mario): ${phone}` : `Arruolamento fallito ${phone}: ${res.error}`,
    level: res.ok ? 'info' : 'error',
  });

  return NextResponse.json({ ok: res.ok, conversationId, sid: res.sid, error: res.error });
}
```

- [ ] **Step 3: Implement toggle route**

Create `app/api/fenice/autoreply/route.ts` (GET reads, POST sets):

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAutoReply, setAutoReply } from '@/lib/fenice-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

export async function GET() {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });
  const on = await getAutoReply(getSupabaseAdmin());
  return NextResponse.json({ on });
}

export async function POST(req: NextRequest) {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { on?: boolean };
  await setAutoReply(getSupabaseAdmin(), body.on === true);
  return NextResponse.json({ ok: true, on: body.on === true });
}
```

- [ ] **Step 4: Type-check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/messaging.ts app/api/fenice/enroll/route.ts app/api/fenice/autoreply/route.ts
git commit -m "feat(fenice): enroll lead + auto-reply toggle APIs"
```

---

### Task 12: Live page (enroll form + toggle + enrolled list)

**Files:**
- Create: `app/(fenice)/fenice/live/page.tsx`
- Create: `app/(fenice)/fenice/live/_components/LivePanel.tsx`

- [ ] **Step 1: Create the page (server) — load enrolled conversations**

Create `app/(fenice)/fenice/live/page.tsx`:

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAutoReply } from '@/lib/fenice-settings';
import { LivePanel } from './_components/LivePanel';

export const dynamic = 'force-dynamic';

export default async function FeniceLivePage() {
  const supabase = await getSupabaseServer();
  await supabase.auth.getUser();

  const admin = getSupabaseAdmin();
  const autoReply = await getAutoReply(admin);
  const { data: convs } = await admin
    .from('conversations')
    .select('id, ai_status, last_message_at, leads(phone_e164, first_name)')
    .eq('ai_owner', 'mario')
    .order('last_message_at', { ascending: false })
    .limit(100);

  const rows = (convs ?? []).map((c: any) => ({
    id: c.id,
    status: c.ai_status as string | null,
    phone: c.leads?.phone_e164 ?? '',
    name: c.leads?.first_name ?? '',
    lastMessageAt: c.last_message_at as string,
  }));

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-lg font-semibold mb-4">Live — Mario su WhatsApp</h1>
      <LivePanel initialAutoReply={autoReply} initialRows={rows} />
    </div>
  );
}
```

- [ ] **Step 2: Create the client panel**

Create `app/(fenice)/fenice/live/_components/LivePanel.tsx` with: a toggle (calls `/api/fenice/autoreply`), an enroll form (phone + name → `/api/fenice/enroll`), and a table of enrolled conversations with status.

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';

type Row = { id: number; status: string | null; phone: string; name: string; lastMessageAt: string };

export function LivePanel({ initialAutoReply, initialRows }: { initialAutoReply: boolean; initialRows: Row[] }) {
  const router = useRouter();
  const [autoReply, setAutoReply] = useState(initialAutoReply);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function toggle(on: boolean) {
    setAutoReply(on);
    await fetch('/api/fenice/autoreply', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }),
    });
  }

  async function enroll() {
    if (!phone.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/fenice/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), firstName: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Errore');
      setMsg(`Template inviato a ${phone}. Mario gestirà le risposte.`);
      setPhone(''); setName('');
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Errore');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Switch checked={autoReply} onCheckedChange={toggle} />
        <div>
          <div className="font-medium">Auto-risposta WhatsApp {autoReply ? 'ATTIVA' : 'spenta'}</div>
          <div className="text-sm text-zinc-500">Mario risponde solo ai lead arruolati qui sotto.</div>
        </div>
      </div>

      <div className="rounded-lg border p-4 space-y-3">
        <div className="font-medium">Avvia un lead</div>
        <div className="flex gap-2">
          <Input placeholder="+39…" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input placeholder="Nome (opzionale)" value={name} onChange={(e) => setName(e.target.value)} />
          <Button onClick={enroll} disabled={busy || !phone.trim()}>Invia apertura</Button>
        </div>
        {msg && <div className="text-sm text-zinc-600 dark:text-zinc-300">{msg}</div>}
      </div>

      <div className="rounded-lg border">
        <div className="px-4 py-2 font-medium border-b">Lead gestiti da Mario</div>
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr><th className="px-4 py-2">Telefono</th><th className="px-4 py-2">Nome</th><th className="px-4 py-2">Stato</th></tr>
          </thead>
          <tbody>
            {initialRows.length === 0 && (
              <tr><td className="px-4 py-3 text-zinc-400" colSpan={3}>Nessun lead arruolato.</td></tr>
            )}
            {initialRows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-4 py-2">{r.phone}</td>
                <td className="px-4 py-2">{r.name}</td>
                <td className="px-4 py-2">
                  {r.status === 'booked' && <Badge className="bg-emerald-600">appuntamento</Badge>}
                  {r.status === 'handed_off' && <Badge variant="destructive">a operatore</Badge>}
                  {(!r.status || r.status === 'active') && <Badge variant="secondary">attivo</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

(`Switch` exists — `@radix-ui/react-switch` is a dependency. If `components/ui/switch` is absent, run `bunx shadcn@latest add switch`.)

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "app/(fenice)/fenice/live/page.tsx" "app/(fenice)/fenice/live/_components/LivePanel.tsx"
git commit -m "feat(fenice): live page — enroll form, auto-reply toggle, enrolled list"
```

---

### Task 13: Webhook auto-reply (Mario answers enrolled leads)

**Files:**
- Create: `lib/fenice-autoreply.ts`
- Test: `lib/fenice-autoreply.test.ts`
- Modify: `app/api/webhooks/twilio/route.ts` (call the helper after inbound insert)

- [ ] **Step 1: Write the failing test for the gate**

Create `lib/fenice-autoreply.test.ts`. The gate is the risky part — test that auto-reply fires only when all conditions hold.

```typescript
import { describe, it, expect } from 'vitest';
import { shouldAutoReply } from './fenice-autoreply';

describe('shouldAutoReply', () => {
  const ok = {
    toMatchesFenice: true, autoReplyOn: true, aiOwner: 'mario', aiStatus: 'active',
  };
  it('vero quando tutte le condizioni valgono', () => {
    expect(shouldAutoReply(ok)).toBe(true);
  });
  it('falso se il numero non è Fenice', () => {
    expect(shouldAutoReply({ ...ok, toMatchesFenice: false })).toBe(false);
  });
  it('falso se lo switch è spento', () => {
    expect(shouldAutoReply({ ...ok, autoReplyOn: false })).toBe(false);
  });
  it('falso se non è gestita da Mario', () => {
    expect(shouldAutoReply({ ...ok, aiOwner: null })).toBe(false);
  });
  it('falso se handed_off o booked', () => {
    expect(shouldAutoReply({ ...ok, aiStatus: 'handed_off' })).toBe(false);
    expect(shouldAutoReply({ ...ok, aiStatus: 'booked' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test lib/fenice-autoreply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/fenice-autoreply.ts`**

```typescript
import type { getSupabaseAdmin } from './supabase/admin';
import { generateMarioReply, type MarioTurn } from './mario';
import { sendFreeText } from './twilio';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type AutoReplyGate = {
  toMatchesFenice: boolean;
  autoReplyOn: boolean;
  aiOwner: string | null;
  aiStatus: string | null;
};

/** Pure: decide se Mario deve rispondere in automatico a questo inbound. */
export function shouldAutoReply(g: AutoReplyGate): boolean {
  return g.toMatchesFenice && g.autoReplyOn && g.aiOwner === 'mario' && g.aiStatus === 'active';
}

/**
 * Best-effort: ricostruisce la cronologia, chiama Mario, invia la risposta dal numero
 * Fenice e aggiorna lo stato sui tag. Non lancia: logga gli errori in event_log.
 */
export async function runMarioAutoReply(
  supabase: Supa,
  conversationId: number,
  phone: string,
): Promise<void> {
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!from) {
    await supabase.from('event_log').insert({
      type: 'fenice_ai_error', payload: { conversationId } as never,
      message: 'TWILIO_WHATSAPP_NUMBER_FENICE non configurato', level: 'error',
    });
    return;
  }

  try {
    const { data: msgs } = await supabase
      .from('messages')
      .select('direction, body, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100);

    const history: MarioTurn[] = (msgs ?? []).map((m: any) => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.body,
    }));

    const result = await generateMarioReply(history);

    if (result.visibleReply) {
      const sent = await sendFreeText({ to: phone, body: result.visibleReply, from });
      await supabase.from('messages').insert({
        conversation_id: conversationId, direction: 'out', body: result.visibleReply,
        twilio_sid: sent.sid, twilio_status: sent.status,
      });
      await supabase.from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', conversationId);
    }

    if (result.passToHuman) {
      await supabase.from('conversations').update({ ai_status: 'handed_off' }).eq('id', conversationId);
    } else if (result.appointmentFixed) {
      await supabase.from('conversations').update({ ai_status: 'booked' }).eq('id', conversationId);
    }

    await supabase.from('event_log').insert({
      type: 'fenice_ai_reply',
      payload: { conversationId, phone, appointmentFixed: result.appointmentFixed, passToHuman: result.passToHuman } as never,
      message: `Mario ha risposto a ${phone}`, level: 'info',
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : 'errore';
    await supabase.from('event_log').insert({
      type: 'fenice_ai_error', payload: { conversationId, phone, error: m } as never,
      message: `Auto-risposta Mario fallita per ${phone}: ${m}`, level: 'error',
    });
  }
}
```

- [ ] **Step 4: Run to verify gate test passes**

Run: `bun run test lib/fenice-autoreply.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into the Twilio webhook**

In `app/api/webhooks/twilio/route.ts`, after the inbound message is successfully inserted and the conversation is bumped (after line 144, before the final `return`), add the auto-reply gate. Imports at top:

```typescript
import { getAutoReply } from '@/lib/fenice-settings';
import { shouldAutoReply, runMarioAutoReply } from '@/lib/fenice-autoreply';
```

Then, inside the inbound `if` block, after the `event_log` insert for the received inbound:

```typescript
    // Auto-risposta Mario (solo numero Fenice + lead arruolato + switch ON)
    const feniceNumber = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
    const toMatchesFenice = !!feniceNumber && (params.To ?? '') === feniceNumber;
    if (toMatchesFenice) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('ai_owner, ai_status')
        .eq('id', conversationId)
        .single();
      const autoReplyOn = await getAutoReply(supabase);
      if (shouldAutoReply({
        toMatchesFenice,
        autoReplyOn,
        aiOwner: conv?.ai_owner ?? null,
        aiStatus: conv?.ai_status ?? null,
      })) {
        await runMarioAutoReply(supabase, conversationId, phone);
      }
    }
```

Note: `params.To` for WhatsApp inbound is `whatsapp:+393520413199`, matching the env value. The whole block is best-effort — `runMarioAutoReply` never throws — so the webhook still returns `200` to Twilio.

- [ ] **Step 6: Type-check + full test run**

Run: `bun run typecheck && bun run test`
Expected: PASS (all suites).

- [ ] **Step 7: Commit**

```bash
git add lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts app/api/webhooks/twilio/route.ts
git commit -m "feat(fenice): Mario auto-reply on enrolled Fenice WhatsApp inbound"
```

---

### Task 14: Configure env in Vercel + manual end-to-end verification

**Files:** none (deployment/ops).

- [ ] **Step 1: Set production env vars**

Add to Vercel (via `vercel env` or the dashboard / MCP): `ANTHROPIC_API_KEY` (a freshly rotated key — the one shared in chat is compromised), `TWILIO_WHATSAPP_NUMBER_FENICE=whatsapp:+393520413199`, `FENICE_OPENING_TEMPLATE_SID=HXa2da97153df29161cc4151a83b809e1e`.

- [ ] **Step 2: Create the Supabase auth user**

Create `fenicebot@fenice.com` with the provisional password in Supabase Auth (dashboard or admin API). Note it as a temporary password to change.

- [ ] **Step 3: Verify the simulator (no real sends)**

Deploy, log in as `fenicebot@fenice.com`. Confirm: lands on `/fenice`; cannot reach `/inbox` (redirects back); Mario opens and qualifies through a short scripted conversation; the appointment badge appears when you type `Noemi` at the end of the flow.

- [ ] **Step 4: Verify live (one real number)**

Confirm the Fenice number's Twilio inbound webhook points at `/api/webhooks/twilio`. With auto-reply ON, enroll your own phone via the Live page; reply on WhatsApp; confirm Mario answers from the Fenice number and the enrolled row shows `attivo`. Drive to handoff/booking and confirm the status updates and auto-reply stops.

- [ ] **Step 5: Commit any config notes**

If a `README`/docs note is warranted (env vars, fenicebot account), add it and commit:

```bash
git add README.md
git commit -m "docs(fenice): env + fenicebot setup notes"
```

---

## Notes for the implementer

- **Model:** `claude-sonnet-4-6` (the user's existing tested script + the cost-effective fit for high-volume lead chat). It's isolated as `MARIO_MODEL` in `lib/mario.ts` for trivial swapping. Thinking is disabled for low-latency chat replies. `@anthropic-ai/sdk` `messages.create` per the Anthropic TS reference.
- **24h window:** Mario replies via `sendFreeText`, valid only inside WhatsApp's 24h customer-care window. Enrollment opens with a template (allowed anytime); as long as the lead keeps replying, the window stays open. Re-engaging a cold lead later would need a template — out of scope for v1 (see spec).
- **Data isolation:** intentionally shared tables; the CRM inbox (admin account) will also show Fenice conversations. That matches the approved design.
- **Security:** rotate the Anthropic key; all secrets via env only.
```
