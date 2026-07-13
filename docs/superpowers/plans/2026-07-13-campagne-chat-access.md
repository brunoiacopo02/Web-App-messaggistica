# Accesso "campagne" — chat campagne Fenice: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Login dedicato `campagne@fenice.com` che vede e risponde SOLO alle chat delle campagne Fenice (Black Summer, id 5, e future), con esclusione di quelle chat dall'inbox Serenamente.

**Architecture:** Colonna `campaigns.owner` distingue campagne Serenamente (1–4) da Fenice (5+). Nuova area di accesso `campagne` in `lib/access.ts` gated dal proxy esistente. Sezione UI `/campagne-chat` che riusa i componenti condivisi (ConversationList, MessageThread, Composer) parametrizzati sugli endpoint. API dedicate sotto `/api/campagne-chat/*` che riverificano server-side l'appartenenza a campagne Fenice; la logica di invio è estratta da `/api/messages` in una funzione condivisa.

**Tech Stack:** Next.js 16 App Router, Supabase (auth+db, progetto `gosnmagiishkwuvmortj`), Twilio, Vitest, shadcn/tailwind.

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-07-13-campagne-chat-access-design.md`.
- Typecheck: `npm run typecheck` (MAI `npx tsc`). Test: `npm run test` (vitest).
- Tutti i commenti/stringhe UI in italiano, coerenti con il codebase.
- NON toccare il comportamento di `/fenice` né dei cron `send-batch` (campagna in corso oggi).
- Le migrazioni si applicano al progetto Supabase `gosnmagiishkwuvmortj` via MCP `apply_migration` E si salvano in `supabase/migrations/`.
- ATTENZIONE trappola PostgREST: `.not('campaign_id','in',...)` esclude anche le righe con `campaign_id IS NULL` (semantica SQL di NOT IN con NULL). Per escludere le campagne Fenice mantenendo le conversazioni normali si usa SEMPRE `.or('campaign_id.is.null,campaign_id.not.in.(...)')`.

---

### Task 1: Migrazione `campaigns.owner`

**Files:**
- Create: `supabase/migrations/20260713000001_campaigns_owner.sql`

**Interfaces:**
- Produces: colonna `campaigns.owner text not null default 'serenamente'` con check `owner in ('serenamente','fenice')`; campagna 5 marcata `'fenice'`.

- [ ] **Step 1: Scrivi la migrazione**

```sql
-- Proprietario della campagna: separa i business Serenamente e Fenice Academy.
-- Le conversazioni delle campagne 'fenice' vivono solo in /campagne-chat.
alter table campaigns
  add column owner text not null default 'serenamente'
  check (owner in ('serenamente', 'fenice'));

update campaigns set owner = 'fenice' where id = 5;
```

- [ ] **Step 2: Applica al progetto**

Usa MCP `mcp__plugin_supabase_supabase__apply_migration` con `project_id: gosnmagiishkwuvmortj`, `name: campaigns_owner`, query = contenuto del file.

- [ ] **Step 3: Verifica**

Via MCP `execute_sql`: `select id, name, owner from campaigns order by id;`
Atteso: 1–4 `serenamente`, 5 `fenice`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260713000001_campaigns_owner.sql
git commit -m "feat(db): colonna campaigns.owner (serenamente|fenice), Black Summer marcata fenice"
```

---

### Task 2: Area di accesso `campagne` in `lib/access.ts`

**Files:**
- Modify: `lib/access.ts`
- Test: `lib/access.test.ts`

**Interfaces:**
- Produces: `Area = 'fenice' | 'campagne' | 'all'`; `areaForEmail('campagne@fenice.com') === 'campagne'`; `canAccess` per area campagne consente solo `/campagne-chat*` e `/api/campagne-chat*`; `landingPath` → `/campagne-chat`.

- [ ] **Step 1: Scrivi i test che falliscono** (aggiungi a `lib/access.test.ts`)

```ts
describe('area campagne', () => {
  it('campagne vede solo /campagne-chat', () => {
    expect(areaForEmail('campagne@fenice.com')).toBe('campagne');
    expect(canAccess('campagne@fenice.com', '/campagne-chat')).toBe(true);
    expect(canAccess('campagne@fenice.com', '/campagne-chat/42')).toBe(true);
    expect(canAccess('campagne@fenice.com', '/api/campagne-chat/conversations')).toBe(true);
    expect(canAccess('campagne@fenice.com', '/inbox')).toBe(false);
    expect(canAccess('campagne@fenice.com', '/fenice')).toBe(false);
    expect(canAccess('campagne@fenice.com', '/api/conversations')).toBe(false);
    expect(canAccess('campagne@fenice.com', '/api/messages')).toBe(false);
    expect(canAccess('campagne@fenice.com', '/campagne')).toBe(false);
    expect(landingPath('campagne@fenice.com')).toBe('/campagne-chat');
  });
  it('fenicebot non vede /campagne-chat', () => {
    expect(canAccess('fenicebot@fenice.com', '/campagne-chat')).toBe(false);
  });
  it('gli account all vedono anche /campagne-chat', () => {
    expect(canAccess('brunoiacopo02@gmail.com', '/campagne-chat')).toBe(true);
  });
});
```

- [ ] **Step 2: Verifica che falliscano**: `npm run test -- lib/access.test.ts` → FAIL

- [ ] **Step 3: Implementa** — `lib/access.ts` diventa:

```ts
// Mappa email -> area consentita. Nessun ruolo nel DB (scelta: dati condivisi).
// 'fenice' = solo /fenice. 'campagne' = solo /campagne-chat. 'all' = tutto.
export type Area = 'fenice' | 'campagne' | 'all';

const FENICE_ONLY = new Set(['fenicebot@fenice.com']);
const CAMPAGNE_ONLY = new Set(['campagne@fenice.com']);

export function areaForEmail(email: string | null | undefined): Area {
  const e = email?.toLowerCase();
  if (e && FENICE_ONLY.has(e)) return 'fenice';
  if (e && CAMPAGNE_ONLY.has(e)) return 'campagne';
  return 'all';
}

/** True se l'utente può aprire il path dato. */
export function canAccess(email: string | null | undefined, path: string): boolean {
  const area = areaForEmail(email);
  if (area === 'all') return true;
  if (area === 'campagne') {
    return path === '/campagne-chat' || path.startsWith('/campagne-chat/')
      || path === '/api/campagne-chat' || path.startsWith('/api/campagne-chat/');
  }
  // fenice-only: solo /fenice (e relative API)
  return path === '/fenice' || path.startsWith('/fenice/')
    || path === '/api/fenice' || path.startsWith('/api/fenice/');
}

/** Dove mandare l'utente dopo il login. */
export function landingPath(email: string | null | undefined): string {
  const area = areaForEmail(email);
  if (area === 'fenice') return '/fenice';
  if (area === 'campagne') return '/campagne-chat';
  return '/inbox';
}
```

- [ ] **Step 4: Test verdi**: `npm run test -- lib/access.test.ts` → PASS (tutti, anche i preesistenti)

- [ ] **Step 5: Commit**

```bash
git add lib/access.ts lib/access.test.ts
git commit -m "feat(access): area 'campagne' per campagne@fenice.com, solo /campagne-chat"
```

---

### Task 3: Helper campagne Fenice + estrazione logica invio

**Files:**
- Create: `lib/campagne.ts`
- Create: `lib/conversation-send.ts`
- Modify: `app/api/messages/route.ts` (delega alla funzione estratta)

**Interfaces:**
- Produces:
  - `getFeniceCampaignIds(client: SupabaseClient): Promise<number[]>`
  - `isFeniceConversation(client: SupabaseClient, conversationId: number): Promise<boolean>`
  - `excludeFeniceCampaigns(query, feniceIds)` — applica `.or('campaign_id.is.null,campaign_id.not.in.(...)')`, no-op se lista vuota
  - `sendConversationMessage(input: SendMessageInput): Promise<NextResponse>` — l'INTERO corpo attuale del POST `/api/messages` dopo la validazione zod (lookup conversazione, finestra 24h, invio free/template, insert messages, update conversations, error handling identico)

- [ ] **Step 1: Crea `lib/campagne.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

/** Id delle campagne di proprietà Fenice Academy (owner='fenice'). */
export async function getFeniceCampaignIds(client: SupabaseClient): Promise<number[]> {
  const { data } = await client.from('campaigns').select('id').eq('owner', 'fenice');
  return (data ?? []).map((c: { id: number }) => c.id);
}

/** True se la conversazione appartiene a una campagna Fenice. */
export async function isFeniceConversation(client: SupabaseClient, conversationId: number): Promise<boolean> {
  const { data } = await client
    .from('conversations')
    .select('campaign_id, campaign:campaigns(owner)')
    .eq('id', conversationId)
    .maybeSingle();
  return (data as { campaign?: { owner?: string } | null } | null)?.campaign?.owner === 'fenice';
}

/**
 * Esclude da una query PostgREST le conversazioni di campagne Fenice.
 * NB: NOT IN in SQL scarta anche i NULL, quindi serve l'OR esplicito con is.null.
 */
export function excludeFeniceCampaigns<T extends { or: (f: string) => T }>(query: T, feniceIds: number[]): T {
  if (feniceIds.length === 0) return query;
  return query.or(`campaign_id.is.null,campaign_id.not.in.(${feniceIds.join(',')})`);
}
```

- [ ] **Step 2: Crea `lib/conversation-send.ts`** spostandoci il corpo del POST di `app/api/messages/route.ts` dalle righe 24–95 (da `const admin = getSupabaseAdmin();` alla fine), invariato, come:

```ts
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendFreeText, sendTemplate, getTemplateBody } from '@/lib/twilio';
import { isWindowOpen } from '@/lib/utils';
import type { z } from 'zod';
import type { SendMessageSchema } from '@/lib/schemas';

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

/** Invia un messaggio (libero o template) in una conversazione. Logica unica per /api/messages e /api/campagne-chat/messages. */
export async function sendConversationMessage(input: SendMessageInput): Promise<NextResponse> {
  // ... corpo identico alle righe 24–95 attuali di app/api/messages/route.ts ...
}
```

(Copia il codice esistente 1:1 — niente riscritture. `app/api/messages/route.ts` resta con auth + parse zod e chiude con `return sendConversationMessage(parsed.data);`.)

- [ ] **Step 3: Typecheck + test**: `npm run typecheck` e `npm run test` → PASS

- [ ] **Step 4: Commit**

```bash
git add lib/campagne.ts lib/conversation-send.ts app/api/messages/route.ts
git commit -m "refactor(messages): estrae sendConversationMessage, helper campagne Fenice"
```

---

### Task 4: API `/api/campagne-chat/*`

**Files:**
- Create: `app/api/campagne-chat/conversations/route.ts`
- Create: `app/api/campagne-chat/conversations/[id]/messages/route.ts`
- Create: `app/api/campagne-chat/conversations/[id]/read/route.ts`
- Create: `app/api/campagne-chat/messages/route.ts`

**Interfaces:**
- Consumes: `getFeniceCampaignIds`, `isFeniceConversation`, `sendConversationMessage` (Task 3).
- Produces: stessi contratti JSON delle route gemelle `/api/conversations*` e `/api/messages` (la UI riusa i componenti condivisi cambiando solo il path).

- [ ] **Step 1: `conversations/route.ts`** — mirror di `app/api/conversations/route.ts` con filtro fenice al posto di `.is('ai_owner', null)`:

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getFeniceCampaignIds } from '@/lib/campagne';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const filter = url.searchParams.get('filter'); // 'all'|'unread'|'recent'
  const search = url.searchParams.get('q')?.trim() ?? '';

  const feniceIds = await getFeniceCampaignIds(supabase);
  if (feniceIds.length === 0) return NextResponse.json({ data: [] });

  let query = supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, campaign_id, last_message_preview,
      lead:leads ( id, phone_e164, first_name, last_name, email )
    `)
    .in('campaign_id', feniceIds)
    .order('last_message_at', { ascending: false })
    .limit(200);

  if (filter === 'unread') query = query.gt('unread_count', 0);
  if (filter === 'recent') query = query.gte('last_message_at', new Date(Date.now() - 7 * 86400_000).toISOString());

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const filtered = !search
    ? data
    : (data ?? []).filter((c: any) => {
        const fn = (c.lead?.first_name ?? '').toLowerCase();
        const ln = (c.lead?.last_name ?? '').toLowerCase();
        const ph = (c.lead?.phone_e164 ?? '').toLowerCase();
        const s = search.toLowerCase();
        return fn.includes(s) || ln.includes(s) || ph.includes(s);
      });

  const withPreview = (filtered ?? []).map((c: any) => ({ ...c, preview: c.last_message_preview ?? undefined }));
  return NextResponse.json({ data: withPreview });
}
```

- [ ] **Step 2: `conversations/[id]/messages/route.ts`** — mirror della GET esistente + guardia fenice:

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { isFeniceConversation } from '@/lib/campagne';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const conversationId = parseInt(id, 10);
  if (Number.isNaN(conversationId)) return new NextResponse('bad request', { status: 400 });
  if (!(await isFeniceConversation(supabase, conversationId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

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

- [ ] **Step 3: `conversations/[id]/read/route.ts`** — mirror di `app/api/conversations/[id]/read/route.ts` con la stessa guardia `isFeniceConversation` (403 se falsa) prima degli update.

- [ ] **Step 4: `messages/route.ts`** — POST reply:

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { SendMessageSchema } from '@/lib/schemas';
import { isFeniceConversation } from '@/lib/campagne';
import { sendConversationMessage } from '@/lib/conversation-send';

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
  if (!(await isFeniceConversation(supabase, parsed.data.conversation_id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return sendConversationMessage(parsed.data);
}
```

- [ ] **Step 5: Typecheck**: `npm run typecheck` → PASS

- [ ] **Step 6: Commit**

```bash
git add app/api/campagne-chat
git commit -m "feat(api): route /api/campagne-chat scoperte sulle campagne Fenice"
```

---

### Task 5: Esclusione chat Fenice dall'inbox Serenamente

**Files:**
- Modify: `app/api/conversations/route.ts` (query list)
- Modify: `app/(app)/inbox/layout.tsx` (query server della lista)
- Modify: `app/(app)/inbox/[conversationId]/page.tsx` (guardia URL diretto)

**Interfaces:**
- Consumes: `getFeniceCampaignIds`, `excludeFeniceCampaigns` (Task 3).

- [ ] **Step 1: `app/api/conversations/route.ts`** — dopo la costruzione della query con `.is('ai_owner', null)`, aggiungi:

```ts
const feniceIds = await getFeniceCampaignIds(supabase);
query = excludeFeniceCampaigns(query, feniceIds);
```

(import da `@/lib/campagne`; la chiamata a `getFeniceCampaignIds` va PRIMA del `let query` oppure subito dopo, purché prima di `await query`.)

- [ ] **Step 2: `app/(app)/inbox/layout.tsx`** — stessa esclusione sulla query server:

```ts
import { getFeniceCampaignIds, excludeFeniceCampaigns } from '@/lib/campagne';
// ...
const feniceIds = await getFeniceCampaignIds(supabase);
let query = supabase
  .from('conversations')
  .select(/* select attuale invariato */)
  .is('ai_owner', null)
  .order('last_message_at', { ascending: false })
  .limit(200);
query = excludeFeniceCampaigns(query, feniceIds);
const { data } = await query;
```

- [ ] **Step 3: `app/(app)/inbox/[conversationId]/page.tsx`** — dopo la guardia Mario (riga `if (conv.ai_owner === 'mario') notFound();`), aggiungi la guardia gemella (le chat campagne Fenice si aprono da /campagne-chat):

```ts
if (conv.campaign_id != null) {
  const { data: camp } = await supabase.from('campaigns').select('owner').eq('id', conv.campaign_id).maybeSingle();
  if ((camp as any)?.owner === 'fenice') notFound();
}
```

(Aggiungi `campaign_id` al select della conversazione se non c'è già.)

- [ ] **Step 4: Typecheck + test**: `npm run typecheck` e `npm run test` → PASS

- [ ] **Step 5: Commit**

```bash
git add app/api/conversations/route.ts "app/(app)/inbox/layout.tsx" "app/(app)/inbox/[conversationId]/page.tsx"
git commit -m "feat(inbox): esclude le conversazioni delle campagne Fenice dal CRM Serenamente"
```

---

### Task 6: Parametrizzazione componenti condivisi

**Files:**
- Modify: `components/ConversationList.tsx`
- Modify: `components/MessageThread.tsx`
- Modify: `components/Composer.tsx`

**Interfaces:**
- Produces (tutte prop opzionali, default = comportamento attuale, zero modifiche ai call-site esistenti):
  - `ConversationList`: `apiPath?: string` (default `'/api/conversations'`), `basePath?: string` (default `'/inbox'`), `channelName?: string` (default `'inbox-list'`)
  - `MessageThread`: `apiBase?: string` (default `'/api/conversations'`) → fetch `` `${apiBase}/${conversationId}/messages` ``
  - `Composer`: `sendPath?: string` (default `'/api/messages'`)

- [ ] **Step 1: `ConversationList`** — aggiungi le tre prop; usa `apiPath` nella `new URL(...)` del refresh, `basePath` nell'`href` del Link (`` `${basePath}/${c.id}` ``), `channelName` in `sb.channel(...)`.

- [ ] **Step 2: `MessageThread`** — aggiungi `apiBase` e usalo nel `refetch`.

- [ ] **Step 3: `Composer`** — aggiungi `sendPath` e usalo nella `fetch`.

- [ ] **Step 4: Typecheck + test**: `npm run typecheck`, `npm run test` → PASS (nessun call-site esistente cambia)

- [ ] **Step 5: Commit**

```bash
git add components/ConversationList.tsx components/MessageThread.tsx components/Composer.tsx
git commit -m "refactor(components): endpoint e path parametrizzabili su lista/thread/composer"
```

---

### Task 7: UI `/campagne-chat`

**Files:**
- Create: `app/(campagne)/layout.tsx`
- Create: `app/(campagne)/campagne-chat/layout.tsx`
- Create: `app/(campagne)/campagne-chat/page.tsx`
- Create: `app/(campagne)/campagne-chat/[conversationId]/page.tsx`

**Interfaces:**
- Consumes: componenti parametrizzati (Task 6), helper (Task 3), API (Task 4), `signOutAction` da `@/app/(auth)/login/actions`.

- [ ] **Step 1: `app/(campagne)/layout.tsx`** — shell minima con header (mirror della struttura di `app/(app)/layout.tsx` e `app/(fenice)/layout.tsx` — leggili prima; NIENTE sidebar completa):

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { signOutAction } from '@/app/(auth)/login/actions';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MessagesSquare } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function CampagneLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <div className="flex flex-col h-dvh">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 font-medium">
          <MessagesSquare className="size-5 text-amber-600" />
          Chat campagne · Fenice Academy
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="truncate max-w-48" title={user?.email ?? ''}>{user?.email}</span>
          <ThemeToggle />
          <form action={signOutAction}>
            <button type="submit" className="text-red-600 hover:underline">Esci</button>
          </form>
        </div>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
```

(Adatta markup/classi al root layout reale: se `app/layout.tsx` impone wrapper, mantieni coerenza. Se `h-dvh` confligge, usa il pattern del layout (app).)

- [ ] **Step 2: `campagne-chat/layout.tsx`** — mirror di `app/(app)/inbox/layout.tsx` con filtro fenice e componenti parametrizzati:

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { ConversationList } from '@/components/ConversationList';
import { getFeniceCampaignIds } from '@/lib/campagne';

export const dynamic = 'force-dynamic';

export default async function CampagneChatLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const feniceIds = await getFeniceCampaignIds(supabase);
  const { data } = feniceIds.length === 0
    ? { data: [] as any[] }
    : await supabase
        .from('conversations')
        .select(`
          id, last_message_at, last_inbound_at, unread_count, last_message_preview,
          lead:leads ( id, phone_e164, first_name, last_name )
        `)
        .in('campaign_id', feniceIds)
        .order('last_message_at', { ascending: false })
        .limit(200);

  const initial = (data ?? []).map((c: any) => ({ ...c, preview: c.last_message_preview ?? undefined }));

  return (
    <div className="flex h-full">
      <ConversationList
        initial={initial as any}
        apiPath="/api/campagne-chat/conversations"
        basePath="/campagne-chat"
        channelName="campagne-list"
      />
      {children}
    </div>
  );
}
```

- [ ] **Step 3: `campagne-chat/page.tsx`** — empty state, mirror di `app/(app)/inbox/page.tsx` (icona + "Seleziona una conversazione").

- [ ] **Step 4: `campagne-chat/[conversationId]/page.tsx`** — mirror di `app/(app)/inbox/[conversationId]/page.tsx` con: guardia fenice al posto della guardia Mario, campagne del Composer solo fenice+attive, componenti puntati alle API campagne:

```tsx
import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MessageThread } from '@/components/MessageThread';
import { Composer } from '@/components/Composer';
import { isWindowOpen } from '@/lib/utils';
import { isFeniceConversation } from '@/lib/campagne';

export const dynamic = 'force-dynamic';

export default async function CampagneConversationPage({
  params,
}: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (Number.isNaN(id)) notFound();

  const supabase = await getSupabaseServer();
  if (!(await isFeniceConversation(supabase, id))) notFound();

  const [convRes, msgsRes, campsRes] = await Promise.all([
    supabase.from('conversations').select(`
      id, last_inbound_at, last_message_at,
      lead:leads(id, first_name, last_name, phone_e164, email)
    `).eq('id', id).single(),
    supabase.from('messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true }).limit(500),
    supabase.from('campaigns').select('*').eq('owner', 'fenice').order('name'),
  ]);

  if (!convRes.data) notFound();
  const conv = convRes.data as any;

  // Marca gli inbound come letti (come /inbox)
  await supabase.from('messages').update({ read_at: new Date().toISOString() })
    .eq('conversation_id', id).eq('direction', 'in').is('read_at', null);
  await supabase.from('conversations').update({ unread_count: 0 }).eq('id', id);

  const open = isWindowOpen(conv.last_inbound_at);
  const fullName = [conv.lead?.first_name, conv.lead?.last_name].filter(Boolean).join(' ') || conv.lead?.phone_e164 || 'Sconosciuto';

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <header className="border-b px-4 py-3">
        <div className="text-base font-medium">{fullName}</div>
        <div className="text-xs text-zinc-500">{conv.lead?.phone_e164}</div>
      </header>
      <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} apiBase="/api/campagne-chat/conversations" />
      <Composer conversationId={id} windowOpen={open} campaigns={(campsRes.data ?? []) as any} sendPath="/api/campagne-chat/messages" />
    </div>
  );
}
```

NB: il mark-as-read qui usa il client server con sessione utente — verifica che le policy permettano l'update come fa /inbox (stesso pattern, stesse policy). Se /inbox funziona, funziona anche qui.

- [ ] **Step 5: Typecheck + build**: `npm run typecheck` e `npm run build` → PASS

- [ ] **Step 6: Commit**

```bash
git add "app/(campagne)"
git commit -m "feat(ui): sezione /campagne-chat per le chat delle campagne Fenice"
```

---

### Task 8: Verifica finale, push e deploy

- [ ] **Step 1**: `npm run test` → tutti PASS; `npm run typecheck` → PASS; `npm run lint` → PASS (o solo warning preesistenti)
- [ ] **Step 2**: `git push origin main` → Vercel deploya
- [ ] **Step 3**: verifica deployment Ready (vercel inspect) e smoke: `GET /api/campagne-chat/conversations` senza sessione → 401; `/campagne-chat` senza sessione → redirect /login

---

### Task 9 (manuale, orchestratore): utenza e consegna

- [ ] Crea utente Supabase Auth `campagne@fenice.com` via Admin API (service role, `email_confirm: true`, password forte generata)
- [ ] Login di prova: atterra su /campagne-chat, non può aprire /inbox né /fenice
- [ ] Consegna credenziali all'utente in chat (mai committate)
