# WhatsApp Lead Messaging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire una webapp Next.js che riceve nuovi lead da ActiveCampaign, invia template WhatsApp via Twilio, mostra le risposte in un'inbox stile WhatsApp con notifiche real-time, multi-campagna configurabile dalla UI, deploy su Vercel + Supabase.

**Architecture:** Monolite Next.js 16 (App Router). Backend = route handler in `app/api/*`. Frontend = React Server Components + client components con shadcn/ui. DB Postgres + Realtime + Auth su Supabase. Webhook idempotenti, validazione firma Twilio, secret token per AC.

**Tech Stack:** Next.js 16, TypeScript strict, Tailwind v4, shadcn/ui, Supabase (`@supabase/supabase-js` + `@supabase/ssr`), Twilio Node SDK, Zod, Vitest, Playwright, Bun.

**Riferimento spec:** `docs/superpowers/specs/2026-05-01-whatsapp-lead-design.md`

---

## File Structure

```
app/
  layout.tsx                                 # root, providers
  globals.css                                # tailwind v4 import
  page.tsx                                   # redirect → /dashboard or /login
  (auth)/
    login/page.tsx                           # form login
    login/actions.ts                         # server action signIn
  (app)/
    layout.tsx                               # sidebar, RealtimeProvider, sessione
    dashboard/page.tsx
    inbox/page.tsx                           # lista a sx
    inbox/[conversationId]/page.tsx         # thread a dx + composer
    campagne/page.tsx
    campagne/_components/CampaignDrawer.tsx
    log/page.tsx
  api/
    webhooks/activecampaign/route.ts
    webhooks/twilio/route.ts
    messages/route.ts
    messages/[id]/read/route.ts
    conversations/route.ts
    conversations/[id]/messages/route.ts
    campaigns/route.ts
    campaigns/[id]/route.ts
    stats/route.ts

components/
  ui/                                        # shadcn primitives
  Sidebar.tsx
  ConversationList.tsx
  ConversationListItem.tsx
  MessageThread.tsx
  MessageBubble.tsx
  DeliveryStatus.tsx
  PhoneAvatar.tsx
  Composer.tsx
  TemplateVariablesEditor.tsx
  StatCard.tsx
  RealtimeProvider.tsx
  ThemeToggle.tsx

lib/
  supabase/
    server.ts                                # SSR client (cookies)
    client.ts                                # browser client
    admin.ts                                 # service role (server only)
    middleware.ts                            # session refresh helper
    types.ts                                 # generated DB types
  twilio.ts                                  # sendTemplate, sendFreeText, validateSignature
  twilio.test.ts
  ac.ts                                      # parseAcPayload, isDedupHit
  ac.test.ts
  phone.ts                                   # toE164, isValidE164
  phone.test.ts
  campaigns.ts                               # findCampaignFor, renderTemplateVars
  campaigns.test.ts
  rate-limit.ts                              # IP rate limit base
  rate-limit.test.ts
  schemas.ts                                 # Zod schemas (campaign form, message body)
  utils.ts                                   # cn(), date helpers

middleware.ts                                # Next.js middleware (auth gate)

supabase/
  migrations/
    20260501000001_init_schema.sql
    20260501000002_rls_policies.sql
    20260501000003_indexes.sql
  config.toml                                # supabase CLI config (opzionale)

tests/
  e2e/inbox.spec.ts                          # Playwright happy path

.env.example
.env.local                                   # (ignorato da git)
.gitignore
package.json
tsconfig.json
next.config.ts
tailwind.config.ts                           # se serve estendere
postcss.config.mjs
vitest.config.ts
vitest.setup.ts
playwright.config.ts
README.md
components.json                              # shadcn config
```

---

## Phase 0 — Bootstrap progetto

### Task 0.1: Inizializzare Next.js + Bun

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `.gitignore`

- [ ] **Step 1: Verificare bun installato**

```bash
bun --version
```
Expected: stampa una versione (es. `1.x.x`). Se non installato, installa da https://bun.sh.

- [ ] **Step 2: Creare progetto Next.js**

Comando in `C:\Users\bruno\Desktop\Software Messaggistica` (cartella già esistente, non vuota perché contiene il `.docx` e `docs/`):

```bash
bun create next-app . --typescript --tailwind --app --turbopack --use-bun --eslint --import-alias "@/*" --no-src-dir --yes
```
Se chiede sovrascrittura per file esistenti (non dovrebbero essercene di name conflict), accettare per i nuovi e mantenere `docs/`, `specifiche_whatsapp_lead.docx`, `.claude/`.

- [ ] **Step 3: Verificare che il dev server parta**

```bash
bun dev
```
Expected: server in ascolto su `http://localhost:3000`, pagina default Next.js. Killare con Ctrl+C.

- [ ] **Step 4: Aggiungere `.gitignore` standard**

Append al `.gitignore` generato:
```
.env*.local
.env
!.env.example
.vercel
.supabase
.next
node_modules
coverage
playwright-report
test-results
```

- [ ] **Step 5: Commit**

Non committare ancora — `git init` viene fatto in Phase 14 quando creiamo la repo GitHub. Per ora i commit logici li faremo dopo `git init`. Procedere comunque marcando ogni step "commit" come "stage logico" finché non siamo in git: i commit veri si fanno in batch nel deploy phase.

> **NOTA**: per tutto il piano, dove si dice "commit" intendere "stage logicamente" finché Phase 14 non inizializza git. Da Phase 14 in poi i commit sono reali con `git commit -m`.

---

### Task 0.2: Installare dipendenze runtime e dev

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Dipendenze runtime**

```bash
bun add @supabase/supabase-js @supabase/ssr twilio zod date-fns recharts lucide-react clsx tailwind-merge class-variance-authority
```

- [ ] **Step 2: Dipendenze dev**

```bash
bun add -d vitest @vitest/coverage-v8 @types/node @testing-library/react @testing-library/jest-dom jsdom playwright @playwright/test prettier prettier-plugin-tailwindcss supabase
```

- [ ] **Step 3: Aggiornare `package.json` scripts**

Aggiungi nella sezione `scripts`:
```json
{
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "format": "prettier --write \"**/*.{ts,tsx,md,json}\"",
    "format:check": "prettier --check \"**/*.{ts,tsx,md,json}\"",
    "supabase:gen-types": "supabase gen types typescript --project-id $SUPABASE_PROJECT_ID > lib/supabase/types.ts"
  }
}
```

- [ ] **Step 4: Verifica typecheck**

```bash
bun typecheck
```
Expected: nessun errore (progetto vuoto a parte boilerplate Next.js).

---

### Task 0.3: Configurare Vitest

**Files:**
- Create: `vitest.config.ts`, `vitest.setup.ts`

- [ ] **Step 1: `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['node_modules/**', '.next/**', 'tests/e2e/**', '**/*.config.*'],
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
```

- [ ] **Step 2: `vitest.setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 3: Test smoke**

Crea `lib/__smoke.test.ts` temporaneo:
```ts
import { describe, it, expect } from 'vitest';
describe('smoke', () => {
  it('runs', () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 4: Esegui**

```bash
bun test
```
Expected: 1 test passed.

- [ ] **Step 5: Cancella smoke**

```bash
rm lib/__smoke.test.ts
```

---

### Task 0.4: Inizializzare shadcn/ui

**Files:**
- Create: `components.json`, `lib/utils.ts`, `components/ui/*`

- [ ] **Step 1: Init shadcn**

```bash
bunx --bun shadcn@latest init
```
Risposte:
- Style: `Default`
- Base color: `Zinc`
- CSS variables: `Yes`

- [ ] **Step 2: Installare componenti base che useremo**

```bash
bunx --bun shadcn@latest add button input label textarea select dialog drawer dropdown-menu form sheet separator badge avatar card table tabs toast tooltip switch
```

- [ ] **Step 3: Verifica build**

```bash
bun run build
```
Expected: build completa senza errori.

---

## Phase 1 — Schema database (Supabase migrations)

### Task 1.1: Migrazione iniziale schema

**Files:**
- Create: `supabase/migrations/20260501000001_init_schema.sql`

- [ ] **Step 1: Scrivere il file SQL**

```sql
-- 5 tabelle del modello dati

create table if not exists campaigns (
  id                   bigint generated by default as identity primary key,
  name                 text not null,
  ac_list_match        text not null,
  twilio_template_sid  text not null,
  template_variables   jsonb not null default '[]'::jsonb,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists leads (
  id              bigint generated by default as identity primary key,
  phone_e164      text not null unique,
  first_name      text,
  last_name       text,
  email           text,
  ac_contact_id   text,
  created_at      timestamptz not null default now()
);

create table if not exists conversations (
  id              bigint generated by default as identity primary key,
  lead_id         bigint not null references leads(id) on delete cascade,
  campaign_id     bigint references campaigns(id) on delete set null,
  last_message_at timestamptz not null default now(),
  last_inbound_at timestamptz,
  unread_count    int not null default 0,
  created_at      timestamptz not null default now(),
  unique(lead_id)
);

create table if not exists messages (
  id                bigint generated by default as identity primary key,
  conversation_id   bigint not null references conversations(id) on delete cascade,
  direction         text not null check (direction in ('in','out')),
  body              text not null,
  twilio_sid        text unique,
  twilio_status     text,
  twilio_error_code int,
  template_sid      text,
  template_vars     jsonb,
  is_template       boolean not null default false,
  read_at           timestamptz,
  created_at        timestamptz not null default now()
);

create table if not exists event_log (
  id         bigint generated by default as identity primary key,
  type       text not null,
  payload    jsonb,
  message    text,
  level      text not null default 'info' check (level in ('info','warn','error')),
  created_at timestamptz not null default now()
);

-- Trigger per updated_at su campaigns
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger campaigns_set_updated_at
  before update on campaigns
  for each row execute function set_updated_at();
```

- [ ] **Step 2: Niente test ora — la migrazione si applicherà via MCP in Phase 14 quando il progetto Supabase esisterà**

Marca lo step come "scritto, in attesa di apply".

---

### Task 1.2: Migrazione RLS policies

**Files:**
- Create: `supabase/migrations/20260501000002_rls_policies.sql`

- [ ] **Step 1: Scrivere il file**

```sql
-- Abilita RLS su tutte le tabelle
alter table campaigns      enable row level security;
alter table leads          enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table event_log      enable row level security;

-- Policy: utenti authenticated possono fare tutto (single tenant V1)
-- Le route webhook usano service_role che bypassa RLS

create policy "auth_all_campaigns" on campaigns
  for all to authenticated using (true) with check (true);

create policy "auth_all_leads" on leads
  for all to authenticated using (true) with check (true);

create policy "auth_all_conversations" on conversations
  for all to authenticated using (true) with check (true);

create policy "auth_all_messages" on messages
  for all to authenticated using (true) with check (true);

create policy "auth_all_event_log" on event_log
  for all to authenticated using (true) with check (true);
```

---

### Task 1.3: Migrazione indici

**Files:**
- Create: `supabase/migrations/20260501000003_indexes.sql`

- [ ] **Step 1: Scrivere il file**

```sql
create index if not exists messages_conv_created_idx
  on messages(conversation_id, created_at desc);

create index if not exists conversations_last_msg_idx
  on conversations(last_message_at desc);

create index if not exists leads_phone_idx
  on leads(phone_e164);

create index if not exists event_log_recent_idx
  on event_log(created_at desc, level);

create index if not exists event_log_type_idx
  on event_log(type, created_at desc);

-- Index per dedup AC: cerca event_log per email/phone in finestra 5 min
create index if not exists event_log_ac_dedup_idx
  on event_log((payload->>'email'), (payload->>'phone'), created_at desc)
  where type = 'ac_webhook';
```

---

## Phase 2 — Supabase clients

### Task 2.1: Client SSR (server components, route handlers)

**Files:**
- Create: `lib/supabase/server.ts`

- [ ] **Step 1: Scrivere il file**

```ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from './types';

export async function getSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(toSet) {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            /* called from a server component — middleware handles refresh */
          }
        },
      },
    }
  );
}
```

---

### Task 2.2: Client browser (client components)

**Files:**
- Create: `lib/supabase/client.ts`

- [ ] **Step 1: Scrivere**

```ts
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './types';

export function getSupabaseBrowser() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

---

### Task 2.3: Client admin (service role, solo server)

**Files:**
- Create: `lib/supabase/admin.ts`

- [ ] **Step 1: Scrivere**

```ts
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

let _admin: ReturnType<typeof createClient<Database>> | null = null;

export function getSupabaseAdmin() {
  if (_admin) return _admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SERVICE_ROLE_KEY');
  }
  _admin = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _admin;
}
```

---

### Task 2.4: Helper sessione middleware

**Files:**
- Create: `lib/supabase/middleware.ts`

- [ ] **Step 1: Scrivere**

```ts
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './types';

export async function refreshSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(toSet) {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  return { response, user };
}
```

---

### Task 2.5: Stub `lib/supabase/types.ts`

**Files:**
- Create: `lib/supabase/types.ts`

- [ ] **Step 1: Stub iniziale**

(I tipi veri verranno generati da `supabase gen types` dopo la creazione del progetto. Stub vuoto per non bloccare la compilazione.)

```ts
// Generated by `bun supabase:gen-types` after project creation.
// Do not edit by hand.
export type Database = {
  public: {
    Tables: Record<string, { Row: any; Insert: any; Update: any; Relationships: [] }>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
```

---

## Phase 3 — Auth (middleware + login)

### Task 3.1: Middleware globale auth

**Files:**
- Create: `middleware.ts`

- [ ] **Step 1: Scrivere**

```ts
import { type NextRequest, NextResponse } from 'next/server';
import { refreshSession } from '@/lib/supabase/middleware';

const PUBLIC_PATHS = ['/login', '/api/webhooks'];

export async function middleware(request: NextRequest) {
  const { response, user } = await refreshSession(request);

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some(p => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('from', path);
    return NextResponse.redirect(url);
  }

  if (user && path === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/inbox';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
```

---

### Task 3.2: Pagina login + server action

**Files:**
- Create: `app/(auth)/login/page.tsx`, `app/(auth)/login/actions.ts`

- [ ] **Step 1: Server action `actions.ts`**

```ts
'use server';

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';

export async function signInAction(formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const from = String(formData.get('from') ?? '/inbox');

  if (!email || !password) {
    return { error: 'Inserisci email e password' };
  }

  const supabase = await getSupabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: 'Credenziali non valide' };
  }

  redirect(from);
}
```

- [ ] **Step 2: Pagina `page.tsx`**

```tsx
import { signInAction } from './actions';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const sp = await searchParams;
  return (
    <div className="flex min-h-svh items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center">Accedi</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={signInAction} className="flex flex-col gap-4">
            <input type="hidden" name="from" value={sp.from ?? '/inbox'} />
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required />
            </div>
            {sp.error && (
              <p className="text-sm text-red-600">{sp.error}</p>
            )}
            <Button type="submit" className="w-full">Entra</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Logout server action**

Aggiungi a `app/(auth)/login/actions.ts`:

```ts
export async function signOutAction() {
  const supabase = await getSupabaseServer();
  await supabase.auth.signOut();
  redirect('/login');
}
```

---

### Task 3.3: Redirect root → /inbox o /login

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Sovrascrivi**

```tsx
import { redirect } from 'next/navigation';
export default function Home() { redirect('/dashboard'); }
```

Il middleware si occupa del bounce su `/login` se non autenticato.

---

## Phase 4 — Library utilities (TDD)

### Task 4.1: `lib/phone.ts` — normalizzazione E.164

**Files:**
- Create: `lib/phone.ts`, `lib/phone.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { toE164, isValidE164 } from './phone';

describe('toE164', () => {
  it('aggiunge +39 a numero italiano senza prefisso', () => {
    expect(toE164('3331234567')).toBe('+393331234567');
    expect(toE164('333 123 4567')).toBe('+393331234567');
    expect(toE164('333-123-4567')).toBe('+393331234567');
  });

  it('mantiene il +39 se già presente', () => {
    expect(toE164('+393331234567')).toBe('+393331234567');
    expect(toE164('+39 333 123 4567')).toBe('+393331234567');
  });

  it('mantiene altri prefissi internazionali', () => {
    expect(toE164('+447911123456')).toBe('+447911123456');
    expect(toE164('+14155551234')).toBe('+14155551234');
  });

  it('gestisce 0039 trasformandolo in +39', () => {
    expect(toE164('00393331234567')).toBe('+393331234567');
  });

  it('rimuove caratteri di formattazione', () => {
    expect(toE164('(333) 123-4567')).toBe('+393331234567');
  });

  it('ritorna null per input invalidi', () => {
    expect(toE164('')).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('abc')).toBeNull();
    expect(toE164('123')).toBeNull(); // troppo corto
  });

  it('strip whatsapp: prefix Twilio', () => {
    expect(toE164('whatsapp:+393331234567')).toBe('+393331234567');
  });
});

describe('isValidE164', () => {
  it('accetta numeri E.164 validi', () => {
    expect(isValidE164('+393331234567')).toBe(true);
    expect(isValidE164('+14155551234')).toBe(true);
  });
  it('rifiuta non E.164', () => {
    expect(isValidE164('3331234567')).toBe(false);
    expect(isValidE164('+0123')).toBe(false);
    expect(isValidE164('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (fail expected)**

```bash
bun test lib/phone.test.ts
```
Expected: FAIL "Cannot find module './phone'"

- [ ] **Step 3: Implementazione `lib/phone.ts`**

```ts
const DEFAULT_COUNTRY_PREFIX = '+39';

export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;

  // strip whatsapp: prefix
  s = s.replace(/^whatsapp:/i, '');

  // 0039... -> +39...
  if (s.startsWith('00')) s = '+' + s.slice(2);

  // remove spaces, dashes, parentheses, dots
  s = s.replace(/[\s().\-]/g, '');

  // se inizia con + ma non è valido, fallisci
  if (s.startsWith('+')) {
    return isValidE164(s) ? s : null;
  }

  // aggiungi prefisso default
  // ma solo se è puramente numerico
  if (!/^\d+$/.test(s)) return null;

  // rimuovi eventuale 0 iniziale (es. 0333... -> 333...)
  s = s.replace(/^0+/, '');

  if (s.length < 9 || s.length > 12) return null;

  const candidate = DEFAULT_COUNTRY_PREFIX + s;
  return isValidE164(candidate) ? candidate : null;
}

export function isValidE164(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^\+[1-9]\d{7,14}$/.test(s);
}
```

- [ ] **Step 4: Run test (pass)**

```bash
bun test lib/phone.test.ts
```
Expected: tutti i test PASS.

- [ ] **Step 5: Commit (logico)**

`feat(lib): phone E.164 normalization with default +39`

---

### Task 4.2: `lib/ac.ts` — parse payload + dedup

**Files:**
- Create: `lib/ac.ts`, `lib/ac.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { parseAcPayload, type AcParsedLead } from './ac';

describe('parseAcPayload', () => {
  it('estrae i campi standard AC dal payload form-encoded', () => {
    const payload = {
      'contact[email]': 'mario@example.com',
      'contact[first_name]': 'Mario',
      'contact[last_name]': 'Rossi',
      'contact[phone]': '3331234567',
      'contact[id]': '12345',
      'list[name]': 'Webinar Marzo',
      'list[id]': '7',
    };
    const out = parseAcPayload(payload);
    expect(out).toEqual<AcParsedLead>({
      email: 'mario@example.com',
      firstName: 'Mario',
      lastName: 'Rossi',
      phone: '3331234567',
      acContactId: '12345',
      listName: 'Webinar Marzo',
      listId: '7',
    });
  });

  it('gestisce payload JSON nested (formato alternativo)', () => {
    const payload = {
      contact: { email: 'a@b.c', first_name: 'A', phone: '+393331234567' },
      list: { name: 'X' },
    };
    const out = parseAcPayload(payload);
    expect(out.email).toBe('a@b.c');
    expect(out.firstName).toBe('A');
    expect(out.phone).toBe('+393331234567');
    expect(out.listName).toBe('X');
  });

  it('campi mancanti diventano null', () => {
    const out = parseAcPayload({ 'contact[email]': 'x@y.z' });
    expect(out.email).toBe('x@y.z');
    expect(out.phone).toBeNull();
    expect(out.firstName).toBeNull();
    expect(out.listName).toBeNull();
  });
});
```

- [ ] **Step 2: Run (fail)**

```bash
bun test lib/ac.test.ts
```

- [ ] **Step 3: Implementazione `lib/ac.ts`**

```ts
export type AcParsedLead = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  acContactId: string | null;
  listName: string | null;
  listId: string | null;
};

type Bag = Record<string, unknown>;

function pick(b: Bag, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = b[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function nested(b: Bag, root: string, key: string): string | null {
  const r = b[root];
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const v = (r as Bag)[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

export function parseAcPayload(input: unknown): AcParsedLead {
  const b = (input ?? {}) as Bag;

  return {
    email:        pick(b, 'contact[email]', 'email')         ?? nested(b, 'contact', 'email'),
    firstName:    pick(b, 'contact[first_name]', 'first_name') ?? nested(b, 'contact', 'first_name'),
    lastName:     pick(b, 'contact[last_name]', 'last_name')  ?? nested(b, 'contact', 'last_name'),
    phone:        pick(b, 'contact[phone]', 'phone')         ?? nested(b, 'contact', 'phone'),
    acContactId:  pick(b, 'contact[id]', 'contact_id')       ?? nested(b, 'contact', 'id'),
    listName:     pick(b, 'list[name]', 'list_name')         ?? nested(b, 'list', 'name'),
    listId:       pick(b, 'list[id]', 'list_id')             ?? nested(b, 'list', 'id'),
  };
}

export const DEDUP_WINDOW_MINUTES = 5;
```

- [ ] **Step 4: Run (pass)**

```bash
bun test lib/ac.test.ts
```

- [ ] **Step 5: Commit logico**

---

### Task 4.3: `lib/campaigns.ts` — matching + render variabili template

**Files:**
- Create: `lib/campaigns.ts`, `lib/campaigns.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { matchCampaign, renderTemplateVariables, type CampaignRow } from './campaigns';
import type { AcParsedLead } from './ac';

const lead: AcParsedLead = {
  email: 'm@x.it',
  firstName: 'Mario',
  lastName: 'Rossi',
  phone: '+393331234567',
  acContactId: '1',
  listName: 'Webinar Marzo',
  listId: '7',
};

const campaigns: CampaignRow[] = [
  { id: 1, name: 'A', ac_list_match: 'Webinar Marzo', twilio_template_sid: 'HX1', template_variables: [], active: true },
  { id: 2, name: 'B', ac_list_match: '7',              twilio_template_sid: 'HX2', template_variables: [], active: true },
  { id: 3, name: 'C', ac_list_match: 'Inattivo',       twilio_template_sid: 'HX3', template_variables: [], active: false },
];

describe('matchCampaign', () => {
  it('trova match per listName', () => {
    expect(matchCampaign(campaigns, { ...lead, listId: null })?.id).toBe(1);
  });
  it('trova match per listId se listName non matcha', () => {
    expect(matchCampaign(campaigns, { ...lead, listName: 'altro' })?.id).toBe(2);
  });
  it('ignora campagne disattivate', () => {
    expect(matchCampaign(campaigns, { ...lead, listName: 'Inattivo', listId: null })).toBeNull();
  });
  it('ritorna null se nessun match', () => {
    expect(matchCampaign(campaigns, { ...lead, listName: 'X', listId: 'Y' })).toBeNull();
  });
});

describe('renderTemplateVariables', () => {
  it('mappa lead_field e static', () => {
    const vars = [
      { key: '1', source: 'lead_field', value: 'first_name' },
      { key: '2', source: 'static', value: 'Marzo 2026' },
      { key: '3', source: 'lead_field', value: 'last_name' },
    ] as const;
    const out = renderTemplateVariables(vars, lead);
    expect(out).toEqual({ '1': 'Mario', '2': 'Marzo 2026', '3': 'Rossi' });
  });

  it('lead_field mancante diventa stringa vuota', () => {
    const vars = [{ key: '1', source: 'lead_field' as const, value: 'first_name' }];
    const out = renderTemplateVariables(vars, { ...lead, firstName: null });
    expect(out).toEqual({ '1': '' });
  });

  it('mapping campi supportati', () => {
    const vars = [
      { key: '1', source: 'lead_field', value: 'email' },
      { key: '2', source: 'lead_field', value: 'phone' },
    ] as const;
    const out = renderTemplateVariables(vars, lead);
    expect(out).toEqual({ '1': 'm@x.it', '2': '+393331234567' });
  });
});
```

- [ ] **Step 2: Run (fail)**

- [ ] **Step 3: Implementazione**

```ts
import type { AcParsedLead } from './ac';

export type TemplateVariable =
  | { key: string; source: 'lead_field'; value: 'first_name' | 'last_name' | 'email' | 'phone' }
  | { key: string; source: 'static';     value: string };

export type CampaignRow = {
  id: number;
  name: string;
  ac_list_match: string;
  twilio_template_sid: string;
  template_variables: TemplateVariable[];
  active: boolean;
};

export function matchCampaign(
  campaigns: CampaignRow[],
  lead: Pick<AcParsedLead, 'listName' | 'listId'>,
): CampaignRow | null {
  const active = campaigns.filter(c => c.active);
  return (
    (lead.listName ? active.find(c => c.ac_list_match === lead.listName) : undefined) ??
    (lead.listId   ? active.find(c => c.ac_list_match === lead.listId)   : undefined) ??
    null
  );
}

const FIELD_MAP: Record<string, keyof AcParsedLead> = {
  first_name: 'firstName',
  last_name:  'lastName',
  email:      'email',
  phone:      'phone',
};

export function renderTemplateVariables(
  vars: readonly TemplateVariable[],
  lead: AcParsedLead,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars) {
    if (v.source === 'static') {
      out[v.key] = v.value;
    } else {
      const field = FIELD_MAP[v.value];
      const val = field ? lead[field] : null;
      out[v.key] = val ?? '';
    }
  }
  return out;
}
```

- [ ] **Step 4: Run (pass)**

- [ ] **Step 5: Commit logico**

---

### Task 4.4: `lib/twilio.ts` — wrapper invio + validazione firma

**Files:**
- Create: `lib/twilio.ts`, `lib/twilio.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('twilio', () => ({
  default: () => ({ messages: { create: messagesCreate } }),
  validateRequest: vi.fn(() => true),
}));

import { sendTemplate, sendFreeText, validateTwilioSignature } from './twilio';

beforeEach(() => {
  messagesCreate.mockReset();
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'tok_test';
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+10000000000';
  process.env.NEXT_PUBLIC_APP_URL = 'https://example.com';
});

describe('sendTemplate', () => {
  it('chiama Twilio con contentSid + variables + statusCallback', async () => {
    messagesCreate.mockResolvedValueOnce({ sid: 'SM123', status: 'queued' });

    const out = await sendTemplate({
      to: '+393331234567',
      contentSid: 'HX1',
      variables: { '1': 'Mario' },
    });

    expect(messagesCreate).toHaveBeenCalledWith({
      from: 'whatsapp:+10000000000',
      to: 'whatsapp:+393331234567',
      contentSid: 'HX1',
      contentVariables: JSON.stringify({ '1': 'Mario' }),
      statusCallback: 'https://example.com/api/webhooks/twilio',
    });
    expect(out).toEqual({ sid: 'SM123', status: 'queued' });
  });

  it('retry su 5xx fino a 2 volte', async () => {
    messagesCreate
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 502 })
      .mockResolvedValueOnce({ sid: 'SM_OK', status: 'queued' });

    const out = await sendTemplate({
      to: '+393331234567', contentSid: 'HX1', variables: {},
    }, { backoffMs: () => 0 });

    expect(messagesCreate).toHaveBeenCalledTimes(3);
    expect(out.sid).toBe('SM_OK');
  });

  it('non retry su 4xx', async () => {
    messagesCreate.mockRejectedValueOnce({ status: 400, code: 21211, message: 'Invalid To' });
    await expect(sendTemplate({
      to: '+393331234567', contentSid: 'HX1', variables: {},
    }, { backoffMs: () => 0 })).rejects.toMatchObject({ code: 21211 });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('sendFreeText', () => {
  it('invia body libero', async () => {
    messagesCreate.mockResolvedValueOnce({ sid: 'SM_F', status: 'queued' });
    const out = await sendFreeText({ to: '+393331234567', body: 'ciao' });
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      from: 'whatsapp:+10000000000',
      to: 'whatsapp:+393331234567',
      body: 'ciao',
    }));
    expect(out.sid).toBe('SM_F');
  });
});

describe('validateTwilioSignature', () => {
  it('ritorna true se TWILIO_VALIDATE_SIGNATURE=false', async () => {
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    const ok = await validateTwilioSignature({
      url: 'https://x', signature: '', params: {},
    });
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run (fail)**

- [ ] **Step 3: Implementazione**

```ts
import twilio, { validateRequest } from 'twilio';

type SendTemplateInput = {
  to: string;                     // E.164 senza prefix
  contentSid: string;
  variables: Record<string, string>;
};

type SendFreeTextInput = {
  to: string;
  body: string;
};

type SendOptions = {
  backoffMs?: (attempt: number) => number;
};

const defaultBackoff = (attempt: number) => (attempt === 1 ? 1000 : 4000);

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error('Missing Twilio credentials');
  return twilio(sid, tok);
}

function statusCallbackUrl() {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (!base) throw new Error('Missing NEXT_PUBLIC_APP_URL');
  return `${base}/api/webhooks/twilio`;
}

function fromNumber() {
  const n = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!n) throw new Error('Missing TWILIO_WHATSAPP_NUMBER');
  return n;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: SendOptions,
): Promise<T> {
  const backoff = opts.backoffMs ?? defaultBackoff;
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status ?? err?.statusCode;
      const isRetriable = !status || status >= 500;
      if (!isRetriable || attempt === 2) throw err;
      await new Promise(r => setTimeout(r, backoff(attempt + 1)));
    }
  }
  throw lastErr;
}

export async function sendTemplate(
  input: SendTemplateInput,
  opts: SendOptions = {},
) {
  const client = getClient();
  return withRetry(async () => {
    const msg = await client.messages.create({
      from: fromNumber(),
      to: `whatsapp:${input.to}`,
      contentSid: input.contentSid,
      contentVariables: JSON.stringify(input.variables),
      statusCallback: statusCallbackUrl(),
    });
    return { sid: msg.sid, status: msg.status };
  }, opts);
}

export async function sendFreeText(
  input: SendFreeTextInput,
  opts: SendOptions = {},
) {
  const client = getClient();
  return withRetry(async () => {
    const msg = await client.messages.create({
      from: fromNumber(),
      to: `whatsapp:${input.to}`,
      body: input.body,
      statusCallback: statusCallbackUrl(),
    });
    return { sid: msg.sid, status: msg.status };
  }, opts);
}

export type ValidateSigInput = {
  url: string;
  signature: string;
  params: Record<string, string>;
};

export async function validateTwilioSignature(input: ValidateSigInput): Promise<boolean> {
  if (process.env.TWILIO_VALIDATE_SIGNATURE === 'false') return true;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!tok) return false;
  return validateRequest(tok, input.signature, input.url, input.params);
}
```

- [ ] **Step 4: Run (pass)**

- [ ] **Step 5: Commit logico**

---

### Task 4.5: `lib/schemas.ts` — Zod schemas

**Files:**
- Create: `lib/schemas.ts`

- [ ] **Step 1: Scrivere**

```ts
import { z } from 'zod';

export const TemplateVarSchema = z.discriminatedUnion('source', [
  z.object({
    key: z.string().regex(/^\d+$/),
    source: z.literal('lead_field'),
    value: z.enum(['first_name', 'last_name', 'email', 'phone']),
  }),
  z.object({
    key: z.string().regex(/^\d+$/),
    source: z.literal('static'),
    value: z.string().min(1),
  }),
]);

export const CampaignSchema = z.object({
  name: z.string().min(1).max(200),
  ac_list_match: z.string().min(1).max(200),
  twilio_template_sid: z.string().regex(/^HX[a-zA-Z0-9]{32}$/, 'Formato Content SID non valido (HX...)'),
  template_variables: z.array(TemplateVarSchema).min(0).max(20),
  active: z.boolean().default(true),
});

export type CampaignInput = z.infer<typeof CampaignSchema>;

export const SendMessageSchema = z.discriminatedUnion('mode', [
  z.object({
    conversation_id: z.coerce.number().int().positive(),
    mode: z.literal('free'),
    body: z.string().min(1).max(4096),
  }),
  z.object({
    conversation_id: z.coerce.number().int().positive(),
    mode: z.literal('template'),
    template_id: z.coerce.number().int().positive(),
    vars: z.record(z.string(), z.string()).default({}),
  }),
]);

export type SendMessageInput = z.infer<typeof SendMessageSchema>;
```

---

### Task 4.6: `lib/utils.ts` — helper UI (cn, formatters)

**Files:**
- Create: `lib/utils.ts`

(shadcn ne ha già creato uno con `cn`. Estendere.)

- [ ] **Step 1: Sovrascrivere**

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNowStrict, isToday, isYesterday } from 'date-fns';
import { it } from 'date-fns/locale';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeShort(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'ieri';
  return format(d, 'd MMM', { locale: it });
}

export function formatDateGroup(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isToday(d)) return 'Oggi';
  if (isYesterday(d)) return 'Ieri';
  return format(d, 'd MMMM yyyy', { locale: it });
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return format(d, 'd MMM yyyy HH:mm', { locale: it });
}

export function timeAgo(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return formatDistanceToNowStrict(d, { addSuffix: true, locale: it });
}

export function isWindowOpen(lastInboundAt: string | null | undefined): boolean {
  if (!lastInboundAt) return false;
  const last = new Date(lastInboundAt).getTime();
  return Date.now() - last < 24 * 60 * 60 * 1000;
}

export function initials(firstName?: string | null, lastName?: string | null, fallback = '?'): string {
  const a = firstName?.trim().charAt(0) ?? '';
  const b = lastName?.trim().charAt(0) ?? '';
  const r = (a + b).toUpperCase();
  return r.length > 0 ? r : fallback;
}

const AVATAR_COLORS = [
  'bg-rose-500', 'bg-amber-500', 'bg-emerald-500',
  'bg-sky-500', 'bg-indigo-500', 'bg-fuchsia-500', 'bg-teal-500',
];
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
```

---

### Task 4.7: `lib/rate-limit.ts` — rate limit base in-memory (per IP)

**Files:**
- Create: `lib/rate-limit.ts`, `lib/rate-limit.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from 'vitest';
import { checkRateLimit, _resetRateLimitForTests } from './rate-limit';

describe('checkRateLimit', () => {
  it('permette 60 req/min poi blocca', () => {
    _resetRateLimitForTests();
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit('ip1', 60, 60_000).ok).toBe(true);
    }
    expect(checkRateLimit('ip1', 60, 60_000).ok).toBe(false);
  });

  it('chiavi diverse hanno conteggi separati', () => {
    _resetRateLimitForTests();
    expect(checkRateLimit('a', 1, 60_000).ok).toBe(true);
    expect(checkRateLimit('a', 1, 60_000).ok).toBe(false);
    expect(checkRateLimit('b', 1, 60_000).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run (fail)**

- [ ] **Step 3: Implementazione**

```ts
type Bucket = { count: number; resetAt: number };
const store = new Map<string, Bucket>();

export function checkRateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const b = store.get(key);
  if (!b || b.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }
  if (b.count >= max) return { ok: false, remaining: 0 };
  b.count += 1;
  return { ok: true, remaining: max - b.count };
}

export function _resetRateLimitForTests() {
  store.clear();
}
```

> **Nota**: in serverless le istanze sono effimere. Questo è un best-effort per fermare picchi di rumore, non sicurezza vera. Su Vercel più istanze = più contatori. V1 sufficiente.

- [ ] **Step 4: Run (pass)**

---

## Phase 5 — Webhook routes

### Task 5.1: Webhook ActiveCampaign

**Files:**
- Create: `app/api/webhooks/activecampaign/route.ts`

- [ ] **Step 1: Implementazione**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { parseAcPayload, DEDUP_WINDOW_MINUTES } from '@/lib/ac';
import { matchCampaign, renderTemplateVariables, type CampaignRow } from '@/lib/campaigns';
import { toE164 } from '@/lib/phone';
import { sendTemplate } from '@/lib/twilio';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try { return await req.json(); } catch { return {}; }
  }
  // form-encoded
  const text = await req.text();
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  params.forEach((v, k) => { out[k] = v; });
  return out;
}

export async function POST(req: NextRequest) {
  // Auth via secret in URL o header
  const expected = process.env.AC_WEBHOOK_SECRET;
  const provided =
    req.nextUrl.searchParams.get('secret') ??
    req.headers.get('x-ac-secret') ??
    '';
  if (!expected || provided !== expected) {
    return new NextResponse('forbidden', { status: 403 });
  }

  // Rate limit basico
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`ac:${ip}`, 60, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  const body = await readBody(req);
  const supabase = getSupabaseAdmin();
  const lead = parseAcPayload(body);

  // Log iniziale (servirà anche come storia per dedup)
  await supabase.from('event_log').insert({
    type: 'ac_webhook',
    payload: { email: lead.email, phone: lead.phone, listName: lead.listName, listId: lead.listId, raw: body },
    message: 'AC webhook received',
    level: 'info',
  });

  // Normalizza telefono
  const phone = toE164(lead.phone);
  if (!phone) {
    await supabase.from('event_log').insert({
      type: 'send_error',
      payload: { lead },
      message: 'Telefono mancante o non valido',
      level: 'warn',
    });
    return NextResponse.json({ ok: true, skipped: 'invalid_phone' });
  }

  // Dedup: cerca event_log type='ac_webhook' con stesso email|phone negli ultimi N min
  // Nota: questa è una count() approssimativa, usa l'index event_log_ac_dedup_idx
  const since = new Date(Date.now() - DEDUP_WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await supabase
    .from('event_log')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'ac_webhook')
    .gte('created_at', since)
    .or(`payload->>email.eq.${lead.email ?? '__none__'},payload->>phone.eq.${phone}`);

  if ((count ?? 0) > 1) {
    // > 1 perché l'INSERT sopra è già contato
    await supabase.from('event_log').insert({
      type: 'dedup_skip',
      payload: { email: lead.email, phone },
      message: 'Webhook duplicato entro finestra dedup',
      level: 'info',
    });
    return NextResponse.json({ ok: true, skipped: 'dedup' });
  }

  // Trova campagna matching
  const { data: campaignsData } = await supabase
    .from('campaigns').select('*').eq('active', true);
  const campaigns = (campaignsData ?? []) as CampaignRow[];
  const campaign = matchCampaign(campaigns, lead);
  if (!campaign) {
    await supabase.from('event_log').insert({
      type: 'config_error',
      payload: { listName: lead.listName, listId: lead.listId },
      message: 'Nessuna campagna attiva matcha questa lista AC',
      level: 'error',
    });
    return NextResponse.json({ ok: true, skipped: 'no_campaign' });
  }

  // Upsert lead
  const { data: leadRow, error: leadErr } = await supabase
    .from('leads')
    .upsert({
      phone_e164: phone,
      first_name: lead.firstName,
      last_name: lead.lastName,
      email: lead.email,
      ac_contact_id: lead.acContactId,
    }, { onConflict: 'phone_e164' })
    .select('id')
    .single();
  if (leadErr || !leadRow) {
    await supabase.from('event_log').insert({
      type: 'send_error', message: `Lead upsert fallito: ${leadErr?.message}`,
      payload: { phone, error: leadErr }, level: 'error',
    });
    return NextResponse.json({ ok: true, skipped: 'lead_upsert_failed' });
  }

  // Find or create conversation
  const { data: convExisting } = await supabase
    .from('conversations').select('id').eq('lead_id', leadRow.id).maybeSingle();
  let conversationId = convExisting?.id;
  if (!conversationId) {
    const { data: convNew, error: convErr } = await supabase
      .from('conversations')
      .insert({ lead_id: leadRow.id, campaign_id: campaign.id })
      .select('id').single();
    if (convErr || !convNew) {
      await supabase.from('event_log').insert({
        type: 'send_error', message: `Conv create fallito: ${convErr?.message}`,
        payload: { leadId: leadRow.id }, level: 'error',
      });
      return NextResponse.json({ ok: true, skipped: 'conv_create_failed' });
    }
    conversationId = convNew.id;
  }

  // Render variabili e invia template
  const vars = renderTemplateVariables(campaign.template_variables, lead);

  let sent: { sid: string; status: string } | null = null;
  try {
    sent = await sendTemplate({
      to: phone,
      contentSid: campaign.twilio_template_sid,
      variables: vars,
    });
  } catch (err: any) {
    await supabase.from('event_log').insert({
      type: 'send_error', message: `Twilio send fallito: ${err?.message ?? 'unknown'}`,
      payload: { phone, code: err?.code, status: err?.status }, level: 'error',
    });
    // Inseriamo comunque il messaggio come 'failed'
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: `[template] ${campaign.name}`,
      twilio_status: 'failed',
      twilio_error_code: err?.code ?? null,
      template_sid: campaign.twilio_template_sid,
      template_vars: vars,
      is_template: true,
    });
    return NextResponse.json({ ok: true, sent: false });
  }

  // Insert message + bump conversation
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    body: `[template] ${campaign.name}`,
    twilio_sid: sent.sid,
    twilio_status: sent.status,
    template_sid: campaign.twilio_template_sid,
    template_vars: vars,
    is_template: true,
  });

  await supabase.from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  return NextResponse.json({ ok: true, sent: true, sid: sent.sid });
}
```

- [ ] **Step 2: Smoke check tipi**

```bash
bun typecheck
```

- [ ] **Step 3: Commit logico**

---

### Task 5.2: Webhook Twilio

**Files:**
- Create: `app/api/webhooks/twilio/route.ts`

- [ ] **Step 1: Implementazione**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { validateTwilioSignature } from '@/lib/twilio';
import { toE164 } from '@/lib/phone';
import { checkRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function publicUrl(req: NextRequest): string {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  if (base) return `${base}${req.nextUrl.pathname}`;
  // fallback per dev
  const host = req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  return `${proto}://${host}${req.nextUrl.pathname}`;
}

export async function POST(req: NextRequest) {
  // Rate limit
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`tw:${ip}`, 120, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  // Twilio webhook è form-encoded
  const text = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { params[k] = v; });

  // Validazione firma
  const signature = req.headers.get('x-twilio-signature') ?? '';
  const ok = await validateTwilioSignature({
    url: publicUrl(req),
    signature,
    params,
  });
  if (!ok) return new NextResponse('forbidden', { status: 403 });

  const supabase = getSupabaseAdmin();

  // Status callback?
  if (params.MessageStatus && params.MessageSid) {
    await supabase
      .from('messages')
      .update({
        twilio_status: params.MessageStatus,
        twilio_error_code: params.ErrorCode ? parseInt(params.ErrorCode, 10) : null,
      })
      .eq('twilio_sid', params.MessageSid);

    await supabase.from('event_log').insert({
      type: 'twilio_status',
      payload: params,
      message: `Status ${params.MessageStatus} per ${params.MessageSid}`,
      level: params.MessageStatus === 'failed' || params.MessageStatus === 'undelivered' ? 'warn' : 'info',
    });
    return new NextResponse('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
  }

  // Inbound message
  if (params.MessageSid && params.From && params.Body !== undefined) {
    const phone = toE164(params.From);
    if (!phone) {
      await supabase.from('event_log').insert({
        type: 'twilio_inbound', payload: params,
        message: `From non parsabile: ${params.From}`, level: 'warn',
      });
      return new NextResponse('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
    }

    // Lead
    let leadId: number;
    const { data: leadExisting } = await supabase
      .from('leads').select('id').eq('phone_e164', phone).maybeSingle();
    if (leadExisting) {
      leadId = leadExisting.id;
    } else {
      const { data: leadNew, error: leadErr } = await supabase
        .from('leads').insert({ phone_e164: phone }).select('id').single();
      if (leadErr || !leadNew) {
        await supabase.from('event_log').insert({
          type: 'twilio_inbound', payload: { params, error: leadErr },
          message: 'Lead create fallito', level: 'error',
        });
        return new NextResponse('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      leadId = leadNew.id;
    }

    // Conversation
    let conversationId: number;
    const { data: convExisting } = await supabase
      .from('conversations').select('id').eq('lead_id', leadId).maybeSingle();
    if (convExisting) {
      conversationId = convExisting.id;
    } else {
      const { data: convNew, error: convErr } = await supabase
        .from('conversations').insert({ lead_id: leadId }).select('id').single();
      if (convErr || !convNew) {
        await supabase.from('event_log').insert({
          type: 'twilio_inbound', payload: { params, error: convErr },
          message: 'Conv create fallito', level: 'error',
        });
        return new NextResponse('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      conversationId = convNew.id;
    }

    // Insert messaggio (UNIQUE su twilio_sid → dedup retry)
    const { error: msgErr } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'in',
      body: params.Body,
      twilio_sid: params.MessageSid,
      twilio_status: 'received',
    });

    if (msgErr) {
      // Possibile duplicato (UNIQUE violation) → skip
      await supabase.from('event_log').insert({
        type: 'twilio_inbound', payload: { sid: params.MessageSid, error: msgErr },
        message: msgErr.code === '23505' ? 'Duplicato (UNIQUE)' : `Insert fallito: ${msgErr.message}`,
        level: msgErr.code === '23505' ? 'info' : 'error',
      });
      return new NextResponse('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
    }

    // Bump conversazione
    const now = new Date().toISOString();
    await supabase.rpc('increment_unread', { conv_id: conversationId }).then(() => {
      // se la function RPC non esiste, fallback: due query
    }).catch(async () => {
      const { data: cur } = await supabase
        .from('conversations').select('unread_count').eq('id', conversationId).single();
      await supabase.from('conversations').update({
        last_message_at: now,
        last_inbound_at: now,
        unread_count: (cur?.unread_count ?? 0) + 1,
      }).eq('id', conversationId);
    });

    // Per V1 facciamo direttamente le 2 query (no RPC)
    const { data: cur } = await supabase
      .from('conversations').select('unread_count').eq('id', conversationId).single();
    await supabase.from('conversations').update({
      last_message_at: now,
      last_inbound_at: now,
      unread_count: (cur?.unread_count ?? 0) + 1,
    }).eq('id', conversationId);

    await supabase.from('event_log').insert({
      type: 'twilio_inbound', payload: { sid: params.MessageSid, from: phone },
      message: `Inbound ricevuto da ${phone}`, level: 'info',
    });
  }

  return new NextResponse('<Response/>', { status: 200, headers: { 'content-type': 'text/xml' } });
}
```

> **Nota**: la sezione RPC `increment_unread` è un placeholder per ottimizzazione futura — il fallback fa 2 query, sufficiente per V1.

- [ ] **Step 2: Typecheck**

- [ ] **Step 3: Commit logico**

---

## Phase 6 — API routes (per UI)

### Task 6.1: GET /api/conversations (lista)

**Files:**
- Create: `app/api/conversations/route.ts`

- [ ] **Step 1: Implementazione**

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const filter = url.searchParams.get('filter'); // 'all'|'unread'|'recent'
  const search = url.searchParams.get('q')?.trim() ?? '';

  let query = supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, campaign_id,
      lead:leads ( id, phone_e164, first_name, last_name, email )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);

  if (filter === 'unread') query = query.gt('unread_count', 0);
  if (filter === 'recent') query = query.gte('last_message_at', new Date(Date.now() - 7 * 86400_000).toISOString());

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Filter client-side per search (su nome/numero)
  const filtered = !search
    ? data
    : (data ?? []).filter((c: any) => {
        const fn = (c.lead?.first_name ?? '').toLowerCase();
        const ln = (c.lead?.last_name ?? '').toLowerCase();
        const ph = (c.lead?.phone_e164 ?? '').toLowerCase();
        const s = search.toLowerCase();
        return fn.includes(s) || ln.includes(s) || ph.includes(s);
      });

  return NextResponse.json({ data: filtered });
}
```

---

### Task 6.2: GET /api/conversations/[id]/messages

**Files:**
- Create: `app/api/conversations/[id]/messages/route.ts`

- [ ] **Step 1: Implementazione**

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const conversationId = parseInt(id, 10);
  if (Number.isNaN(conversationId)) return new NextResponse('bad request', { status: 400 });

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}
```

---

### Task 6.3: POST /api/messages (operatore risponde)

**Files:**
- Create: `app/api/messages/route.ts`

- [ ] **Step 1: Implementazione**

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { SendMessageSchema } from '@/lib/schemas';
import { sendFreeText, sendTemplate } from '@/lib/twilio';
import { isWindowOpen } from '@/lib/utils';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const parsed = SendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;

  const admin = getSupabaseAdmin();
  const { data: conv } = await admin
    .from('conversations')
    .select('id, last_inbound_at, lead:leads(phone_e164)')
    .eq('id', input.conversation_id)
    .single();
  if (!conv) return NextResponse.json({ error: 'conversation not found' }, { status: 404 });

  const phone = (conv as any).lead?.phone_e164 as string | undefined;
  if (!phone) return NextResponse.json({ error: 'lead phone missing' }, { status: 422 });

  if (input.mode === 'free') {
    if (!isWindowOpen(conv.last_inbound_at)) {
      return NextResponse.json({ error: 'window_expired' }, { status: 422 });
    }
    let sent;
    try {
      sent = await sendFreeText({ to: phone, body: input.body });
    } catch (err: any) {
      await admin.from('event_log').insert({
        type: 'send_error', message: `UI free send fallito: ${err?.message}`,
        payload: { phone, code: err?.code }, level: 'error',
      });
      return NextResponse.json({ error: 'twilio_error', code: err?.code }, { status: 502 });
    }
    const { data: msg } = await admin.from('messages').insert({
      conversation_id: input.conversation_id,
      direction: 'out',
      body: input.body,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
    }).select('id').single();
    await admin.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', input.conversation_id);
    return NextResponse.json({ id: msg?.id, twilio_sid: sent.sid });
  }

  // template mode
  const { data: campaign } = await admin
    .from('campaigns')
    .select('twilio_template_sid, name, active')
    .eq('id', input.template_id)
    .single();
  if (!campaign || !campaign.active) {
    return NextResponse.json({ error: 'campaign_not_found_or_inactive' }, { status: 404 });
  }
  let sent;
  try {
    sent = await sendTemplate({
      to: phone,
      contentSid: campaign.twilio_template_sid,
      variables: input.vars,
    });
  } catch (err: any) {
    await admin.from('event_log').insert({
      type: 'send_error', message: `UI template send fallito: ${err?.message}`,
      payload: { phone, code: err?.code }, level: 'error',
    });
    return NextResponse.json({ error: 'twilio_error', code: err?.code }, { status: 502 });
  }
  const { data: msg } = await admin.from('messages').insert({
    conversation_id: input.conversation_id,
    direction: 'out',
    body: `[template] ${campaign.name}`,
    twilio_sid: sent.sid,
    twilio_status: sent.status,
    template_sid: campaign.twilio_template_sid,
    template_vars: input.vars,
    is_template: true,
  }).select('id').single();
  await admin.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', input.conversation_id);
  return NextResponse.json({ id: msg?.id, twilio_sid: sent.sid });
}
```

---

### Task 6.4: POST /api/messages/[id]/read e PATCH conversation read

**Files:**
- Create: `app/api/messages/[id]/read/route.ts`
- Create: `app/api/conversations/[id]/read/route.ts`

- [ ] **Step 1: Read singolo messaggio**

```ts
// app/api/messages/[id]/read/route.ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
export const runtime = 'nodejs';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  await supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('id', parseInt(id, 10)).is('read_at', null);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Read batch su conversazione (apri thread → segna tutto)**

```ts
// app/api/conversations/[id]/read/route.ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
export const runtime = 'nodejs';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const conversationId = parseInt(id, 10);
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const now = new Date().toISOString();
  await supabase.from('messages')
    .update({ read_at: now })
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .is('read_at', null);
  await supabase.from('conversations').update({ unread_count: 0 }).eq('id', conversationId);
  return NextResponse.json({ ok: true });
}
```

---

### Task 6.5: CRUD /api/campaigns

**Files:**
- Create: `app/api/campaigns/route.ts`, `app/api/campaigns/[id]/route.ts`

- [ ] **Step 1: GET + POST**

```ts
// app/api/campaigns/route.ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { CampaignSchema } from '@/lib/schemas';

export const runtime = 'nodejs';

export async function GET() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const { data, error } = await supabase
    .from('campaigns').select('*').order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = CampaignSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  const { data, error } = await supabase.from('campaigns').insert(parsed.data).select('*').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
```

- [ ] **Step 2: PATCH + DELETE su [id]**

```ts
// app/api/campaigns/[id]/route.ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { CampaignSchema } from '@/lib/schemas';

export const runtime = 'nodejs';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const body = await req.json().catch(() => ({}));
  const parsed = CampaignSchema.partial().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'validation', details: parsed.error.flatten() }, { status: 400 });
  const { data, error } = await supabase
    .from('campaigns').update(parsed.data).eq('id', parseInt(id, 10)).select('*').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  // Soft delete: active=false (preserva storico messaggi)
  const { error } = await supabase.from('campaigns').update({ active: false }).eq('id', parseInt(id, 10));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
```

---

### Task 6.6: GET /api/stats

**Files:**
- Create: `app/api/stats/route.ts`

- [ ] **Step 1: Implementazione**

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export async function GET() {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfDay); startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const [todayOut, totalOut, unread, lastError, dailySeries, latestInbound] = await Promise.all([
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'out').gte('created_at', startOfDay.toISOString()),
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'out'),
    supabase.from('conversations').select('unread_count').gt('unread_count', 0),
    supabase.from('event_log').select('*').eq('level', 'error').gte('created_at', new Date(Date.now() - 60 * 60_000).toISOString()).order('created_at', { ascending: false }).limit(1),
    supabase.from('messages').select('created_at').eq('direction', 'out').gte('created_at', new Date(Date.now() - 14 * 86400_000).toISOString()).order('created_at', { ascending: true }),
    supabase.from('messages').select(`
      id, body, created_at, conversation:conversations!inner(
        id, lead:leads(first_name, last_name, phone_e164)
      )
    `).eq('direction', 'in').order('created_at', { ascending: false }).limit(5),
  ]);

  // Daily series → conta per giorno (ultimi 14)
  const buckets: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  (dailySeries.data ?? []).forEach((m: any) => {
    const k = (new Date(m.created_at)).toISOString().slice(0, 10);
    if (k in buckets) buckets[k] += 1;
  });

  const unreadTotal = (unread.data ?? []).reduce((s, c: any) => s + (c.unread_count ?? 0), 0);

  return NextResponse.json({
    sentToday: todayOut.count ?? 0,
    sentTotal: totalOut.count ?? 0,
    unreadTotal,
    lastError: lastError.data?.[0] ?? null,
    daily: Object.entries(buckets).map(([date, count]) => ({ date, count })),
    latestInbound: latestInbound.data ?? [],
  });
}
```

---

## Phase 7 — UI: layout app + sidebar + theme

### Task 7.1: `app/(app)/layout.tsx` con Sidebar

**Files:**
- Create: `app/(app)/layout.tsx`, `components/Sidebar.tsx`, `components/ThemeToggle.tsx`

- [ ] **Step 1: `Sidebar.tsx`**

```tsx
'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { LayoutDashboard, Inbox, Megaphone, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inbox',     label: 'Inbox',     icon: Inbox, badgeKey: 'unread' as const },
  { href: '/campagne',  label: 'Campagne',  icon: Megaphone },
  { href: '/log',       label: 'Log',       icon: FileText },
];

export function Sidebar({ unreadCount, userEmail, onLogout }: {
  unreadCount: number;
  userEmail: string;
  onLogout: () => void;
}) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 border-r bg-zinc-50 dark:bg-zinc-900">
      <div className="p-4 font-semibold text-lg">WA Lead</div>
      <nav className="flex-1 px-2 space-y-1">
        {NAV.map(item => {
          const active = pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-md text-sm',
                active ? 'bg-zinc-200 dark:bg-zinc-800 font-medium' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
              )}>
              <Icon className="size-4" />
              <span>{item.label}</span>
              {item.badgeKey === 'unread' && unreadCount > 0 && (
                <Badge variant="destructive" className="ml-auto h-5 px-1.5 text-xs">{unreadCount}</Badge>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t text-xs text-zinc-500">
        <div className="truncate" title={userEmail}>{userEmail}</div>
        <button onClick={onLogout} className="mt-2 text-red-600 hover:underline">Esci</button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: `app/(app)/layout.tsx`**

```tsx
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Sidebar } from '@/components/Sidebar';
import { signOutAction } from '@/app/(auth)/login/actions';
import { RealtimeProvider } from '@/components/RealtimeProvider';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: convs } = await supabase
    .from('conversations').select('unread_count').gt('unread_count', 0);
  const unread = (convs ?? []).reduce((s, c: any) => s + (c.unread_count ?? 0), 0);

  return (
    <div className="flex h-svh">
      <Sidebar
        unreadCount={unread}
        userEmail={user.email ?? ''}
        onLogout={async () => { 'use server'; await signOutAction(); }}
      />
      <main className="flex-1 overflow-hidden">
        <RealtimeProvider>{children}</RealtimeProvider>
      </main>
    </div>
  );
}
```

> **Nota**: `onLogout` dentro client component non può essere passato come props con `use server` direttamente. Refactor: il bottone Esci nella Sidebar è una `<form action={signOutAction}>` con submit. Sostituire `onLogout` button con form. Vedere fix sotto.

- [ ] **Step 3: Fix logout via form action (sostituisci nella Sidebar)**

In `Sidebar.tsx` sostituire la sezione utente con:

```tsx
import { signOutAction } from '@/app/(auth)/login/actions';
// ...
<form action={signOutAction}>
  <button type="submit" className="mt-2 text-red-600 hover:underline">Esci</button>
</form>
```

E rimuovere `onLogout` dai props. Aggiornare layout di conseguenza (rimuovere prop).

---

## Phase 8 — Pagina Dashboard

### Task 8.1: `app/(app)/dashboard/page.tsx` + StatCard

**Files:**
- Create: `app/(app)/dashboard/page.tsx`, `components/StatCard.tsx`

- [ ] **Step 1: `StatCard.tsx`**

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export function StatCard({ title, value, sub, href, accent }: {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  href?: string;
  accent?: 'green' | 'red' | 'default';
}) {
  const inner = (
    <Card className={cn(
      'transition hover:shadow-md',
      accent === 'green' && 'border-emerald-500/40',
      accent === 'red' && 'border-red-500/40',
    )}>
      <CardHeader className="pb-2"><CardTitle className="text-sm text-zinc-500">{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold">{value}</div>
        {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
```

- [ ] **Step 2: `dashboard/page.tsx`**

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { StatCard } from '@/components/StatCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatRelativeShort } from '@/lib/utils';
import Link from 'next/link';
import { DashboardChart } from './_components/DashboardChart';

export const dynamic = 'force-dynamic';

async function fetchStats() {
  // chiamata interna server-side via fetch evitata: usiamo direttamente Supabase
  const supabase = await getSupabaseServer();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);

  const [todayOut, totalOut, unreadConv, lastError, daily, latest] = await Promise.all([
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'out').gte('created_at', startOfDay.toISOString()),
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'out'),
    supabase.from('conversations').select('unread_count').gt('unread_count', 0),
    supabase.from('event_log').select('*').eq('level', 'error').gte('created_at', new Date(Date.now() - 3600_000).toISOString()).order('created_at', { ascending: false }).limit(1),
    supabase.from('messages').select('created_at').eq('direction', 'out').gte('created_at', new Date(Date.now() - 14 * 86400_000).toISOString()),
    supabase.from('messages').select(`
      id, body, created_at, conversation:conversations!inner(
        id, lead:leads(first_name, last_name, phone_e164)
      )
    `).eq('direction', 'in').order('created_at', { ascending: false }).limit(5),
  ]);

  const unreadTotal = (unreadConv.data ?? []).reduce((s, c: any) => s + (c.unread_count ?? 0), 0);

  const buckets: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    buckets[d.toISOString().slice(0, 10)] = 0;
  }
  (daily.data ?? []).forEach((m: any) => {
    const k = (new Date(m.created_at)).toISOString().slice(0, 10);
    if (k in buckets) buckets[k] += 1;
  });

  return {
    sentToday: todayOut.count ?? 0,
    sentTotal: totalOut.count ?? 0,
    unreadTotal,
    lastError: lastError.data?.[0] ?? null,
    daily: Object.entries(buckets).map(([date, count]) => ({ date, count })),
    latestInbound: latest.data ?? [],
  };
}

export default async function DashboardPage() {
  const stats = await fetchStats();
  const ok = !stats.lastError;
  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard title="Inviati oggi" value={stats.sentToday} />
        <StatCard title="Inviati totali" value={stats.sentTotal} />
        <StatCard title="Non lette" value={stats.unreadTotal} href="/inbox" accent="green" />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Stato sistema</CardTitle>
          <span className={`size-3 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
        </CardHeader>
        <CardContent>
          {ok
            ? <p className="text-sm text-zinc-500">Nessun errore nell'ultima ora.</p>
            : <p className="text-sm text-red-600">{stats.lastError?.message}</p>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Invii ultimi 14 giorni</CardTitle></CardHeader>
          <CardContent><DashboardChart data={stats.daily} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Ultime risposte</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {stats.latestInbound.length === 0 && <p className="text-sm text-zinc-500">Nessuna risposta ancora.</p>}
            {stats.latestInbound.map((m: any) => (
              <Link key={m.id} href={`/inbox/${m.conversation.id}`} className="block text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 p-2 rounded-md">
                <div className="flex justify-between">
                  <span className="font-medium truncate">
                    {m.conversation.lead?.first_name ?? m.conversation.lead?.phone_e164}
                  </span>
                  <span className="text-zinc-500 text-xs">{formatRelativeShort(m.created_at)}</span>
                </div>
                <div className="text-zinc-500 truncate">{m.body}</div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `_components/DashboardChart.tsx`**

```tsx
'use client';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export function DashboardChart({ data }: { data: { date: string; count: number }[] }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#25D366" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#25D366" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tickFormatter={(d) => d.slice(5)} fontSize={11} />
          <YAxis allowDecimals={false} fontSize={11} />
          <Tooltip />
          <Area type="monotone" dataKey="count" stroke="#25D366" fill="url(#grad)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

---

## Phase 9 — Pagina Inbox

### Task 9.1: Server page `/inbox` (lista) + selettore vuoto

**Files:**
- Create: `app/(app)/inbox/page.tsx`, `app/(app)/inbox/_components/InboxLayout.tsx`, `components/ConversationList.tsx`, `components/PhoneAvatar.tsx`

- [ ] **Step 1: `PhoneAvatar.tsx`**

```tsx
import { initials, avatarColor, cn } from '@/lib/utils';

export function PhoneAvatar({ firstName, lastName, phone, size = 'md' }: {
  firstName?: string | null; lastName?: string | null; phone: string;
  size?: 'sm' | 'md';
}) {
  const seed = (firstName ?? '') + (lastName ?? '') + phone;
  return (
    <div className={cn(
      'flex items-center justify-center rounded-full text-white font-medium shrink-0',
      avatarColor(seed),
      size === 'md' ? 'size-10 text-sm' : 'size-8 text-xs',
    )}>
      {initials(firstName, lastName, phone.slice(-2))}
    </div>
  );
}
```

- [ ] **Step 2: `ConversationList.tsx` (client)**

```tsx
'use client';
import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { cn, formatRelativeShort } from '@/lib/utils';
import { PhoneAvatar } from './PhoneAvatar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getSupabaseBrowser } from '@/lib/supabase/client';

type Conv = {
  id: number;
  last_message_at: string;
  unread_count: number;
  lead: { id: number; phone_e164: string; first_name: string | null; last_name: string | null } | null;
  preview?: string;
};

export function ConversationList({ initial }: { initial: Conv[] }) {
  const params = useParams<{ conversationId?: string }>();
  const [items, setItems] = useState<Conv[]>(initial);
  const [filter, setFilter] = useState<'all' | 'unread' | 'recent'>('all');
  const [q, setQ] = useState('');
  const [, startTransition] = useTransition();

  async function refresh() {
    const url = new URL('/api/conversations', window.location.origin);
    url.searchParams.set('filter', filter);
    if (q) url.searchParams.set('q', q);
    const res = await fetch(url);
    const json = await res.json();
    setItems(json.data ?? []);
  }

  useEffect(() => { startTransition(refresh); }, [filter, q]);

  // Realtime: refresha la lista quando cambiano conversations o messages
  useEffect(() => {
    const sb = getSupabaseBrowser();
    const ch = sb.channel('inbox-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, () => startTransition(refresh))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => startTransition(refresh))
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [filter, q]);

  return (
    <div className="flex flex-col h-full border-r w-full md:w-96 shrink-0">
      <div className="p-3 space-y-2 border-b">
        <Input placeholder="Cerca per nome o numero…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex gap-1">
          {(['all', 'unread', 'recent'] as const).map(f => (
            <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Tutte' : f === 'unread' ? 'Non lette' : 'Ultimi 7gg'}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 && <p className="p-4 text-sm text-zinc-500">Nessuna conversazione.</p>}
        {items.map(c => {
          const active = String(c.id) === params.conversationId;
          const name = c.lead
            ? [c.lead.first_name, c.lead.last_name].filter(Boolean).join(' ') || c.lead.phone_e164
            : 'Sconosciuto';
          return (
            <Link key={c.id} href={`/inbox/${c.id}`}
              className={cn('flex items-center gap-3 p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 border-b', active && 'bg-zinc-100 dark:bg-zinc-800')}>
              <PhoneAvatar firstName={c.lead?.first_name} lastName={c.lead?.last_name} phone={c.lead?.phone_e164 ?? ''} />
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline">
                  <span className="font-medium truncate">{name}</span>
                  <span className="text-xs text-zinc-500 shrink-0 ml-2">{formatRelativeShort(c.last_message_at)}</span>
                </div>
                <div className="flex justify-between items-center mt-0.5">
                  <span className="text-sm text-zinc-500 truncate">{c.preview ?? c.lead?.phone_e164}</span>
                  {c.unread_count > 0 && (
                    <Badge className="bg-emerald-500 hover:bg-emerald-500 h-5 px-1.5 text-xs">{c.unread_count}</Badge>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `app/(app)/inbox/page.tsx`**

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { ConversationList } from '@/components/ConversationList';
import { Inbox } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const supabase = await getSupabaseServer();
  const { data } = await supabase.from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count,
      lead:leads ( id, phone_e164, first_name, last_name )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);
  return (
    <div className="flex h-full">
      <ConversationList initial={(data ?? []) as any} />
      <div className="hidden md:flex flex-1 items-center justify-center text-zinc-400">
        <div className="text-center">
          <Inbox className="size-10 mx-auto mb-2" />
          <p>Seleziona una conversazione</p>
        </div>
      </div>
    </div>
  );
}
```

---

### Task 9.2: Pagina conversazione `[conversationId]/page.tsx`

**Files:**
- Create: `app/(app)/inbox/[conversationId]/page.tsx`, `components/MessageThread.tsx`, `components/MessageBubble.tsx`, `components/DeliveryStatus.tsx`, `components/Composer.tsx`

- [ ] **Step 1: `DeliveryStatus.tsx`**

```tsx
import { Check, CheckCheck, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

export function DeliveryStatus({ status, errorCode }: {
  status: string | null | undefined;
  errorCode: number | null | undefined;
}) {
  const Icon = (() => {
    switch (status) {
      case 'delivered': return CheckCheck;
      case 'read':      return CheckCheck;
      case 'sent':      return Check;
      case 'failed':
      case 'undelivered': return AlertTriangle;
      default: return Clock;
    }
  })();
  const color = status === 'read' ? 'text-blue-500'
    : status === 'failed' || status === 'undelivered' ? 'text-red-500'
    : 'text-zinc-400';
  const label = status ?? 'queued';
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px]" title={`${label}${errorCode ? ` (${errorCode})` : ''}`}>
      <Icon className={cn('size-3', color)} />
    </span>
  );
}
```

- [ ] **Step 2: `MessageBubble.tsx`**

```tsx
import { cn, formatRelativeShort } from '@/lib/utils';
import { DeliveryStatus } from './DeliveryStatus';

export function MessageBubble({ msg, campaignName }: {
  msg: { id: number; direction: 'in' | 'out'; body: string; created_at: string;
    twilio_status?: string | null; twilio_error_code?: number | null; is_template?: boolean | null };
  campaignName?: string | null;
}) {
  const out = msg.direction === 'out';
  return (
    <div className={cn('flex w-full', out ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[75%] rounded-2xl px-3 py-2 shadow-sm',
        out ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-zinc-100 dark:bg-zinc-800'
      )}>
        {msg.is_template && campaignName && (
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Template · {campaignName}</div>
        )}
        <div className="whitespace-pre-wrap break-words text-sm">{msg.body}</div>
        <div className="flex items-center gap-1 mt-1 justify-end text-[11px] text-zinc-500">
          <span>{formatRelativeShort(msg.created_at)}</span>
          {out && <DeliveryStatus status={msg.twilio_status} errorCode={msg.twilio_error_code} />}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: `MessageThread.tsx`**

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble';
import { formatDateGroup } from '@/lib/utils';
import { getSupabaseBrowser } from '@/lib/supabase/client';

type Msg = {
  id: number; conversation_id: number; direction: 'in' | 'out'; body: string; created_at: string;
  twilio_status: string | null; twilio_error_code: number | null; is_template: boolean | null;
};

function groupByDay(msgs: Msg[]): { day: string; items: Msg[] }[] {
  const groups: Record<string, Msg[]> = {};
  msgs.forEach(m => {
    const k = m.created_at.slice(0, 10);
    (groups[k] ??= []).push(m);
  });
  return Object.entries(groups).map(([k, items]) => ({ day: items[0].created_at, items }));
}

export function MessageThread({ conversationId, initial, campaignNamesById }: {
  conversationId: number;
  initial: Msg[];
  campaignNamesById: Record<number, string>;
}) {
  const [items, setItems] = useState<Msg[]>(initial);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [items.length]);

  // Realtime su nuovi messaggi nella conversazione
  useEffect(() => {
    const sb = getSupabaseBrowser();
    const ch = sb.channel(`thread-${conversationId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => setItems(prev => [...prev, payload.new as Msg]))
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => setItems(prev => prev.map(m => m.id === (payload.new as Msg).id ? (payload.new as Msg) : m)))
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [conversationId]);

  const groups = groupByDay(items);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      {groups.map((g, i) => (
        <div key={i} className="space-y-2">
          <div className="text-center"><span className="text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 rounded-full px-2 py-0.5">{formatDateGroup(g.day)}</span></div>
          {g.items.map(m => (
            <MessageBubble key={m.id} msg={m} campaignName={campaignNamesById[m.id] /* per V1 vuoto */} />
          ))}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 4: `Composer.tsx`**

```tsx
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';

type Campaign = { id: number; name: string; twilio_template_sid: string; template_variables: any[]; active: boolean };

export function Composer({ conversationId, windowOpen, campaigns }: {
  conversationId: number;
  windowOpen: boolean;
  campaigns: Campaign[];
}) {
  const [mode, setMode] = useState<'free' | 'template'>(windowOpen ? 'free' : 'template');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState<string>('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const { toast } = useToast?.() ?? { toast: (x: any) => alert(x.title ?? x) };

  const selectedTemplate = campaigns.find(c => String(c.id) === templateId);

  async function send() {
    setSending(true);
    try {
      const payload = mode === 'free'
        ? { conversation_id: conversationId, mode, body }
        : { conversation_id: conversationId, mode, template_id: parseInt(templateId, 10), vars };
      const res = await fetch('/api/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast({ title: 'Invio fallito', description: j.error ?? `HTTP ${res.status}` });
        return;
      }
      setBody(''); setVars({});
    } finally { setSending(false); }
  }

  if (!windowOpen) {
    return (
      <div className="border-t p-3 space-y-2">
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-700 text-yellow-900 dark:text-yellow-100 text-sm px-3 py-2 rounded-md">
          Sono passate più di 24 ore dall'ultima risposta. Puoi inviare solo template approvati.
        </div>
        <div className="flex gap-2">
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger className="w-64"><SelectValue placeholder="Scegli template" /></SelectTrigger>
            <SelectContent>
              {campaigns.filter(c => c.active).map(c => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedTemplate?.template_variables?.map((v: any) => (
            <input key={v.key}
              placeholder={v.source === 'lead_field' ? `{{${v.key}}} → ${v.value}` : `{{${v.key}}}`}
              className="flex-1 border rounded-md px-2 py-1 text-sm"
              value={vars[v.key] ?? (v.source === 'static' ? v.value : '')}
              onChange={(e) => setVars(prev => ({ ...prev, [v.key]: e.target.value }))}
            />
          ))}
          <Button onClick={send} disabled={!templateId || sending}>Invia</Button>
        </div>
      </div>
    );
  }

  return (
    <Tabs value={mode} onValueChange={(m) => setMode(m as any)} className="border-t">
      <div className="px-3 pt-2">
        <TabsList>
          <TabsTrigger value="free">Libero</TabsTrigger>
          <TabsTrigger value="template">Template</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="free" className="p-3">
        <div className="flex gap-2">
          <Textarea
            placeholder="Scrivi una risposta… (Cmd/Ctrl+Enter per inviare)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); }
            }}
            rows={2}
          />
          <Button onClick={send} disabled={!body.trim() || sending}>Invia</Button>
        </div>
        <div className="text-xs text-zinc-500 mt-1">{body.length}/4096</div>
      </TabsContent>
      <TabsContent value="template" className="p-3">
        <div className="flex gap-2 flex-wrap">
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger className="w-64"><SelectValue placeholder="Scegli template" /></SelectTrigger>
            <SelectContent>
              {campaigns.filter(c => c.active).map(c => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedTemplate?.template_variables?.map((v: any) => (
            <input key={v.key}
              placeholder={`{{${v.key}}}`}
              className="border rounded-md px-2 py-1 text-sm"
              value={vars[v.key] ?? (v.source === 'static' ? v.value : '')}
              onChange={(e) => setVars(prev => ({ ...prev, [v.key]: e.target.value }))}
            />
          ))}
          <Button onClick={send} disabled={!templateId || sending}>Invia</Button>
        </div>
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 5: `[conversationId]/page.tsx`**

```tsx
import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MessageThread } from '@/components/MessageThread';
import { Composer } from '@/components/Composer';
import { isWindowOpen } from '@/lib/utils';
import { ConversationList } from '@/components/ConversationList';

export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
}: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (Number.isNaN(id)) notFound();

  const supabase = await getSupabaseServer();

  const [convRes, msgsRes, campsRes, listRes] = await Promise.all([
    supabase.from('conversations').select(`
      id, last_inbound_at, last_message_at,
      lead:leads(id, first_name, last_name, phone_e164, email)
    `).eq('id', id).single(),
    supabase.from('messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true }).limit(500),
    supabase.from('campaigns').select('*').order('name'),
    supabase.from('conversations').select(`
      id, last_message_at, last_inbound_at, unread_count,
      lead:leads(id, phone_e164, first_name, last_name)
    `).order('last_message_at', { ascending: false }).limit(200),
  ]);

  if (!convRes.data) notFound();
  const conv = convRes.data as any;

  // Marca tutti gli inbound come letti (server side, fire and forget)
  await supabase.from('messages').update({ read_at: new Date().toISOString() })
    .eq('conversation_id', id).eq('direction', 'in').is('read_at', null);
  await supabase.from('conversations').update({ unread_count: 0 }).eq('id', id);

  const open = isWindowOpen(conv.last_inbound_at);
  const fullName = [conv.lead?.first_name, conv.lead?.last_name].filter(Boolean).join(' ') || conv.lead?.phone_e164 || 'Sconosciuto';

  return (
    <div className="flex h-full">
      <ConversationList initial={(listRes.data ?? []) as any} />
      <div className="flex-1 flex flex-col">
        <header className="border-b px-4 py-3">
          <div className="text-base font-medium">{fullName}</div>
          <div className="text-xs text-zinc-500">{conv.lead?.phone_e164}</div>
        </header>
        <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} />
        <Composer conversationId={id} windowOpen={open} campaigns={(campsRes.data ?? []) as any} />
      </div>
    </div>
  );
}
```

---

## Phase 10 — Pagina Campagne

### Task 10.1: Pagina `/campagne` + drawer crea/modifica

**Files:**
- Create: `app/(app)/campagne/page.tsx`, `app/(app)/campagne/_components/CampaignDrawer.tsx`, `components/TemplateVariablesEditor.tsx`

- [ ] **Step 1: `TemplateVariablesEditor.tsx`**

```tsx
'use client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { X, Plus } from 'lucide-react';

type Var = { key: string; source: 'lead_field' | 'static'; value: string };

export function TemplateVariablesEditor({ value, onChange }: {
  value: Var[]; onChange: (v: Var[]) => void;
}) {
  function update(i: number, patch: Partial<Var>) {
    const next = [...value];
    next[i] = { ...next[i], ...patch } as Var;
    onChange(next);
  }
  function add() {
    const nextKey = String(value.length + 1);
    onChange([...value, { key: nextKey, source: 'lead_field', value: 'first_name' }]);
  }
  function remove(i: number) {
    const next = value.filter((_, idx) => idx !== i).map((v, idx) => ({ ...v, key: String(idx + 1) }));
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {value.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-sm text-zinc-500 w-12 font-mono">{`{{${v.key}}}`}</span>
          <Select value={v.source} onValueChange={(s) => update(i, { source: s as any, value: s === 'lead_field' ? 'first_name' : '' })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="lead_field">Campo lead</SelectItem>
              <SelectItem value="static">Valore statico</SelectItem>
            </SelectContent>
          </Select>
          {v.source === 'lead_field' ? (
            <Select value={v.value} onValueChange={(val) => update(i, { value: val })}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="first_name">Nome</SelectItem>
                <SelectItem value="last_name">Cognome</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="phone">Telefono</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input className="w-64" value={v.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="Es. Webinar Marzo" />
          )}
          <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)}>
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="size-3 mr-1" /> Aggiungi variabile
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: `_components/CampaignDrawer.tsx`**

```tsx
'use client';
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, SheetFooter } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TemplateVariablesEditor } from '@/components/TemplateVariablesEditor';
import { useRouter } from 'next/navigation';

type Campaign = {
  id?: number; name: string; ac_list_match: string;
  twilio_template_sid: string; template_variables: any[]; active: boolean;
};

export function CampaignDrawer({ trigger, initial }: {
  trigger: React.ReactNode;
  initial?: Campaign;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [c, setC] = useState<Campaign>(initial ?? {
    name: '', ac_list_match: '', twilio_template_sid: '', template_variables: [], active: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    const url = c.id ? `/api/campaigns/${c.id}` : '/api/campaigns';
    const res = await fetch(url, {
      method: c.id ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: c.name, ac_list_match: c.ac_list_match,
        twilio_template_sid: c.twilio_template_sid,
        template_variables: c.template_variables, active: c.active,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.details ? JSON.stringify(j.details) : (j.error ?? 'Errore'));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader><SheetTitle>{c.id ? 'Modifica campagna' : 'Nuova campagna'}</SheetTitle></SheetHeader>
        <div className="space-y-4 mt-6 px-1">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="Es. Webinar Marzo" />
          </div>
          <div className="space-y-2">
            <Label>Lista AC trigger</Label>
            <Input value={c.ac_list_match} onChange={(e) => setC({ ...c, ac_list_match: e.target.value })} placeholder="Nome esatto della lista o ID" />
            <p className="text-xs text-zinc-500">Inserisci il nome esatto della lista o l'ID che AC passa nel webhook.</p>
          </div>
          <div className="space-y-2">
            <Label>Template Content SID</Label>
            <Input value={c.twilio_template_sid} onChange={(e) => setC({ ...c, twilio_template_sid: e.target.value })} placeholder="HX..." />
          </div>
          <div className="space-y-2">
            <Label>Variabili template</Label>
            <TemplateVariablesEditor
              value={c.template_variables ?? []}
              onChange={(vars) => setC({ ...c, template_variables: vars })} />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={c.active} onCheckedChange={(v) => setC({ ...c, active: v })} />
            <Label>Attiva</Label>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <SheetFooter className="mt-6">
          <Button onClick={save} disabled={busy}>{c.id ? 'Salva' : 'Crea'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 3: `campagne/page.tsx`**

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { CampaignDrawer } from './_components/CampaignDrawer';
import { Plus, Pencil } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function CampagnePage() {
  const supabase = await getSupabaseServer();
  const { data } = await supabase.from('campaigns').select('*').order('created_at', { ascending: false });
  const campaigns = data ?? [];

  return (
    <div className="p-6 space-y-4 overflow-auto h-full">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-semibold">Campagne</h1>
        <CampaignDrawer trigger={<Button><Plus className="size-4 mr-1" /> Nuova campagna</Button>} />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nome</TableHead>
            <TableHead>Lista AC</TableHead>
            <TableHead>Template SID</TableHead>
            <TableHead>Variabili</TableHead>
            <TableHead>Attiva</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {campaigns.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-center text-zinc-500">Nessuna campagna ancora.</TableCell></TableRow>
          )}
          {campaigns.map((c: any) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium">{c.name}</TableCell>
              <TableCell>{c.ac_list_match}</TableCell>
              <TableCell className="font-mono text-xs">{c.twilio_template_sid}</TableCell>
              <TableCell>{c.template_variables?.length ?? 0}</TableCell>
              <TableCell>{c.active ? <Badge>Attiva</Badge> : <Badge variant="outline">Disattivata</Badge>}</TableCell>
              <TableCell>
                <CampaignDrawer
                  initial={c}
                  trigger={<Button variant="ghost" size="icon"><Pencil className="size-4" /></Button>}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

---

## Phase 11 — Pagina Log

### Task 11.1: Pagina `/log` con tab Invii ed Eventi

**Files:**
- Create: `app/(app)/log/page.tsx`

- [ ] **Step 1: Implementazione**

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/utils';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function LogPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; status?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const tab = sp.tab ?? 'invii';
  const supabase = await getSupabaseServer();

  let messages: any[] = [];
  let events: any[] = [];

  if (tab === 'invii') {
    let q = supabase.from('messages').select(`
      id, body, twilio_status, twilio_error_code, created_at, conversation_id,
      conversation:conversations!inner( lead:leads(first_name, last_name, phone_e164), campaign:campaigns(name) )
    `).eq('direction', 'out').order('created_at', { ascending: false }).limit(50);
    if (sp.status) q = q.eq('twilio_status', sp.status);
    const { data } = await q;
    messages = data ?? [];
  } else {
    const { data } = await supabase.from('event_log').select('*').order('created_at', { ascending: false }).limit(200);
    events = data ?? [];
  }

  return (
    <div className="p-6 space-y-4 overflow-auto h-full">
      <h1 className="text-xl font-semibold">Log</h1>
      <Tabs defaultValue={tab}>
        <TabsList>
          <TabsTrigger value="invii" asChild><Link href="/log?tab=invii">Invii</Link></TabsTrigger>
          <TabsTrigger value="eventi" asChild><Link href="/log?tab=eventi">Eventi sistema</Link></TabsTrigger>
        </TabsList>

        <TabsContent value="invii">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Lead</TableHead><TableHead>Campagna</TableHead>
              <TableHead>Stato</TableHead><TableHead>Errore</TableHead>
              <TableHead>Inviato il</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {messages.map(m => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link className="hover:underline" href={`/inbox/${m.conversation_id}`}>
                      {[m.conversation?.lead?.first_name, m.conversation?.lead?.last_name].filter(Boolean).join(' ') || m.conversation?.lead?.phone_e164}
                    </Link>
                    <div className="text-xs text-zinc-500">{m.conversation?.lead?.phone_e164}</div>
                  </TableCell>
                  <TableCell>{m.conversation?.campaign?.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={m.twilio_status === 'failed' || m.twilio_status === 'undelivered' ? 'destructive' : 'outline'}>
                      {m.twilio_status ?? 'queued'}
                    </Badge>
                  </TableCell>
                  <TableCell>{m.twilio_error_code ?? '—'}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(m.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        <TabsContent value="eventi">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Tipo</TableHead><TableHead>Livello</TableHead>
              <TableHead>Messaggio</TableHead><TableHead>Data</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {events.map(e => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{e.type}</TableCell>
                  <TableCell><Badge variant={e.level === 'error' ? 'destructive' : e.level === 'warn' ? 'secondary' : 'outline'}>{e.level}</Badge></TableCell>
                  <TableCell className="text-sm">{e.message}</TableCell>
                  <TableCell className="text-xs">{formatDateTime(e.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

---

## Phase 12 — RealtimeProvider (notifiche, beep, badge)

### Task 12.1: `components/RealtimeProvider.tsx`

**Files:**
- Create: `components/RealtimeProvider.tsx`, `public/notify.mp3` (file audio breve)

- [ ] **Step 1: Trovare/produrre un file `notify.mp3` corto (~0.3s)**

Per V1: usare un file gratuito o generato. Mettere a `public/notify.mp3`. Se non disponibile in fase di sviluppo, lasciare il fetch silenzioso (try/catch sul play).

- [ ] **Step 2: Implementare il provider**

```tsx
'use client';
import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getSupabaseBrowser } from '@/lib/supabase/client';

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { audioRef.current = new Audio('/notify.mp3'); }, []);

  // Chiedi permesso Notification al primo accesso a /inbox
  useEffect(() => {
    if (pathname?.startsWith('/inbox') && 'Notification' in window && Notification.permission === 'default') {
      // chiedere su user gesture? Per semplicità lo facciamo on mount
      Notification.requestPermission();
    }
  }, [pathname]);

  // Subscription globale: nuovi inbound
  useEffect(() => {
    const sb = getSupabaseBrowser();
    const ch = sb.channel('global-inbound')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: 'direction=eq.in',
      }, (payload) => {
        const msg: any = payload.new;
        // Refresh layout (badge sidebar) e route corrente
        router.refresh();

        // Beep
        try { audioRef.current?.play().catch(() => {}); } catch {}

        // Notification API se non sto già guardando questa conversazione
        const inThisConv = pathname?.startsWith(`/inbox/${msg.conversation_id}`);
        if (!inThisConv && 'Notification' in window && Notification.permission === 'granted') {
          const n = new Notification('Nuova risposta WhatsApp', {
            body: msg.body?.slice(0, 120) ?? '',
            tag: `conv-${msg.conversation_id}`,
          });
          n.onclick = () => {
            window.focus();
            window.location.href = `/inbox/${msg.conversation_id}`;
          };
        }
      })
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [router, pathname]);

  return <>{children}</>;
}
```

---

## Phase 13 — E2E happy path (Playwright)

### Task 13.1: Configurare Playwright

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/inbox.spec.ts`

- [ ] **Step 1: `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

- [ ] **Step 2: `tests/e2e/inbox.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

const EMAIL = process.env.E2E_EMAIL!;
const PASSWORD = process.env.E2E_PASSWORD!;

test('login → inbox → vedo lista', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entra' }).click();
  await expect(page).toHaveURL(/\/inbox/);
  await expect(page.getByText('Seleziona una conversazione')).toBeVisible();
});
```

> **Nota**: questo test richiede un utente test creato in Supabase Auth. Eseguirlo solo dopo Phase 14 quando avremo le credenziali.

---

## Phase 14 — Bootstrap infrastruttura & deploy

> **DA QUI IN POI** sono gli step che richiedono interazione con servizi esterni. Anche qui userò MCP/CLI/API per ridurre al minimo le azioni manuali dell'utente. L'utente farà SOLO i 6 step elencati nella spec sezione 12.1.

### Task 14.1: Inizializzare git + repo GitHub

**Files:** repo intera

- [ ] **Step 1: `git init` + `.gitignore` finale**

```bash
git init -b main
git add .
```

- [ ] **Step 2: Verifica utente git globale**

```bash
git config --global user.name
git config --global user.email
```
Se vuoti, chiedere all'utente di settarli prima del primo commit.

- [ ] **Step 3: Primo commit**

```bash
git commit -m "feat: initial scaffold (Next.js + Supabase + Twilio)"
```

- [ ] **Step 4: 🟡 [USER ACTION] Crea repo GitHub vuota**

Chiedi all'utente: "Crea una repo GitHub vuota (privata) con il nome che preferisci, e dimmi l'URL."

- [ ] **Step 5: Aggiungi remote e push**

```bash
git remote add origin <URL_FORNITO_DALL_UTENTE>
git push -u origin main
```

---

### Task 14.2: Creare progetto Supabase (azione utente) + apply migrations (Claude)

- [ ] **Step 1: 🟡 [USER ACTION] Crea progetto Supabase**

Chiedi: "Crea un progetto Supabase (free tier va bene), regione `eu-central-1` o `eu-west-1`. Dammi: project URL, project ref, anon key, service role key."

- [ ] **Step 2: Verificare/Autenticare MCP Supabase**

```
mcp__plugin_supabase_supabase__authenticate
```
Se serve, completare con `complete_authentication`.

- [ ] **Step 3: Applicare migrations via MCP**

```
mcp__supabase__apply_migration   (ripetere per ogni file in supabase/migrations/, in ordine)
```
Verifica con:
```
mcp__supabase__execute_sql  →  select tablename from pg_tables where schemaname='public';
```
Expected: campaigns, leads, conversations, messages, event_log presenti.

- [ ] **Step 4: Generare types TypeScript**

```bash
SUPABASE_PROJECT_ID=<project_ref> bun supabase:gen-types
```
Sovrascrive `lib/supabase/types.ts`. Commit.

- [ ] **Step 5: Creare utente admin via SQL/admin API**

```
mcp__supabase__execute_sql  → 
  select auth.admin_create_user(...)  -- oppure usare admin API client side via service role
```
In alternativa via admin REST API:
```bash
curl -X POST 'https://<ref>.supabase.co/auth/v1/admin/users' \
  -H "apikey: <SERVICE_ROLE_KEY>" \
  -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"email":"<email>","password":"<password>","email_confirm":true}'
```
Chiedi all'utente quale email/password vuole come account admin.

---

### Task 14.3: Creare progetto Vercel (azione utente) + env vars (Claude)

- [ ] **Step 1: 🟡 [USER ACTION] Login Vercel + crea progetto**

Chiedi: "Vai su vercel.com → Add New → Project → seleziona la repo GitHub appena creata. Conferma framework Next.js. Non deployare ancora (ignora gli errori sulle env mancanti). Dammi: project name."

- [ ] **Step 2: Verificare/Autenticare MCP Vercel**

```
mcp__plugin_vercel_vercel__authenticate
```

- [ ] **Step 3: Generare `AC_WEBHOOK_SECRET`**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
Salva il valore.

- [ ] **Step 4: Settare env vars su Vercel via `vercel` CLI**

```bash
bunx vercel link --yes
bunx vercel env add NEXT_PUBLIC_SUPABASE_URL production
# (incolla il valore quando chiesto, ripetere per Preview e Development)
```
Variabili da aggiungere (production + preview + development):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_NUMBER`
- `TWILIO_VALIDATE_SIGNATURE` (=`true`, in dev `false`)
- `AC_WEBHOOK_SECRET` (generato sopra)
- `NEXT_PUBLIC_APP_URL` (es. `https://<project>.vercel.app`)

In alternativa: `vercel env pull .env.local` e poi `vercel env add` da CLI batch.

- [ ] **Step 5: Triggera deploy production**

```bash
git commit --allow-empty -m "chore: trigger first deploy"
git push
```
Monitor con `mcp__vercel__list_deployments` e `mcp__vercel__get_deployment`.

---

### Task 14.4: Configurare webhook Twilio (Claude via API)

- [ ] **Step 1: 🟡 [USER ACTION] Dammi credenziali Twilio**

Chiedi: "Dammi: Account SID, Auth Token, numero WhatsApp Business approvato Meta (formato `whatsapp:+...`), Content SID dei template approvati con descrizione delle loro variabili."

- [ ] **Step 2: Configurare Inbound webhook sul numero WA via API Twilio**

Identifica il SID del numero WA:
```bash
curl -u $TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json" | jq
```
Setta SmsUrl e StatusCallback:
```bash
curl -u $TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN \
  -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/<NUMBER_SID>.json" \
  --data-urlencode "SmsUrl=https://<your-vercel-url>/api/webhooks/twilio" \
  --data-urlencode "SmsMethod=POST" \
  --data-urlencode "StatusCallback=https://<your-vercel-url>/api/webhooks/twilio"
```

> **Nota**: se il numero è dentro un Messaging Service, l'endpoint giusto cambia. Verifica prima con la GET sopra. Se in Messaging Service:
```bash
curl -u $TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN \
  -X POST "https://messaging.twilio.com/v1/Services/<SERVICE_SID>" \
  --data-urlencode "InboundRequestUrl=https://<your-vercel-url>/api/webhooks/twilio" \
  --data-urlencode "StatusCallback=https://<your-vercel-url>/api/webhooks/twilio"
```

- [ ] **Step 3: Test ping**

Manda un messaggio WhatsApp dal proprio telefono al numero business. Verifica in Vercel logs (`bunx vercel logs <deployment>` o MCP) che il webhook arrivi e venga processato. Apri `/log` nella webapp tab "Eventi sistema": deve apparire un record `twilio_inbound`.

---

### Task 14.5: Configurare webhook ActiveCampaign (USER ACTION inevitabile)

- [ ] **Step 1: 🟡 [USER ACTION] Dammi credenziali AC**

Chiedi: "Dammi: API key (Settings → Developer), URL account (es. `nomeaccount.api-us1.com`), nome esatto della/e lista/e che fanno da trigger."

- [ ] **Step 2: 🟡 [USER ACTION] Configura Automation in AC**

Forniscigli istruzioni precise:

> 1. Vai in AC → Automations → New automation → Start from scratch
> 2. Trigger: "Subscribes to a list" → seleziona la lista → "Once" o "Multiple times" come preferisci
> 3. Aggiungi azione → "Webhook" → URL: `https://<your-vercel-url>/api/webhooks/activecampaign?secret=<AC_WEBHOOK_SECRET>` (te lo invio ora)
> 4. Active → Save

Forniscigli **chiaramente** l'URL completo da copiare.

- [ ] **Step 3: Test end-to-end**

Iscrivi un lead di test alla lista AC. Verifica:
1. `/log` tab "Eventi sistema" → record `ac_webhook` ricevuto
2. `/log` tab "Invii" → riga con stato `queued` poi `sent`/`delivered`
3. Telefono di test riceve il messaggio WhatsApp con il template
4. Risponde dal telefono → `/inbox` mostra la conversazione + bolla in entrata
5. Notifica desktop appare (se permesso concesso)
6. Rispondi dalla webapp con un messaggio libero → riceve sul telefono
7. Aspetta >24h o falsifica `last_inbound_at` → composer mostra dropdown template

---

### Task 14.6: Crea README

**Files:** `README.md`

- [ ] **Step 1: Scrivere README**

Includere:
- Cos'è il progetto (1 paragrafo + link a spec)
- Stack
- Setup locale (clone, bun install, .env.local con env minime, ngrok per webhook in dev)
- Deploy (è già configurato, push to main → Vercel)
- Configurazione webhook AC (testo step-by-step)
- Configurazione webhook Twilio (link API + comando curl pronto)
- Aggiungere un nuovo utente alla webapp (Supabase dashboard → Authentication → Users → Add user)
- Aggiungere una nuova campagna (UI /campagne)
- Test del flusso completo
- Variabili d'ambiente (lista da `.env.example`)
- Nota GDPR (dati personali, contattare via SQL per export/cancellazione)

---

## Self-Review (eseguito post-scrittura)

### Spec coverage

- ✅ Webhook AC → invio template Twilio: Phase 5.1
- ✅ Webhook Twilio inbound + status: Phase 5.2
- ✅ Inbox stile WhatsApp two-pane: Phase 9
- ✅ Multi-campagna configurabile UI: Phase 10
- ✅ Auth Supabase: Phase 3
- ✅ Notifiche real-time (badge + beep + Notification): Phase 12
- ✅ Dashboard: Phase 8
- ✅ Log invii + log eventi: Phase 11
- ✅ Stack Next.js + Supabase + Tailwind + shadcn: Phase 0
- ✅ Schema dati 5 tabelle + RLS + indici: Phase 1
- ✅ Lib utilities (phone, ac, twilio, campaigns) con TDD: Phase 4
- ✅ API REST per UI (conversations, messages, campaigns, stats): Phase 6
- ✅ Sicurezza (Twilio sig, AC secret, RLS, rate limit): Phases 4.7, 5.1, 5.2, 8 (RLS migration)
- ✅ Error handling esplicito: ovunque (`event_log` + return 200 da webhook)
- ✅ Testing (Vitest unit + Playwright happy path): Phase 4 + Phase 13
- ✅ Deploy & configurazione: Phase 14
- ✅ README + istruzioni: Phase 14.6
- ✅ Divisione responsabilità (azioni utente minime): Phase 14 con marker 🟡

### Placeholder scan
Eseguito. L'unico "placeholder" è `lib/supabase/types.ts` stub iniziale, esplicitamente da rigenerare in Phase 14.2 step 4.

### Type consistency
- `CampaignRow.template_variables` definito come `TemplateVariable[]` in `lib/campaigns.ts`, coerente con schema DB JSONB e Zod schema.
- `SendMessageInput` discriminated union su `mode`: usato coerentemente in `app/api/messages/route.ts`.
- `AcParsedLead`: stesso shape in `lib/ac.ts` e usato in `lib/campaigns.ts` (`Pick`).

### Scope check
Plan singolo per V1. Gli unici punti deferred (`/inbox` v2: tag, blocco lead, note) sono esplicitamente fuori scope nella spec. OK come singolo plan.

---

## Execution Handoff

Plan completo salvato in `docs/superpowers/plans/2026-05-01-whatsapp-lead-messaging.md`.

Due opzioni di esecuzione:

**1. Subagent-Driven (consigliata)** — dispatch di un subagent fresco per task, review tra un task e l'altro, iterazione rapida e contesto pulito.

**2. Inline Execution** — eseguo i task in questa stessa sessione con checkpoint per la review in batch.

**Quale preferisci?**
