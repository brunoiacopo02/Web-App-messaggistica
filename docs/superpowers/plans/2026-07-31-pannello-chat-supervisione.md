# Pannello chat di supervisione (`/chat`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un pannello `/chat` in sola lettura che mostra tutte le conversazioni del mondo Fenice (lead di Mario, lead GDO in modalità postino, campagne Fenice) con l'indicazione di chi ha scritto ogni messaggio, accessibile da un'utenza dedicata che non può vedere nient'altro.

**Architecture:** Ricalca il pannello `/campagne-chat` già in produzione: una quarta area in `lib/access.ts` con gate per path nel `proxy.ts` esistente, un route group `app/(chat)/` che riusa `ConversationList` e `MessageThread` tramite le prop che accettano già, e API `/api/chat/*` di sola lettura. Il perimetro (`ai_owner='mario'` OR campagna `owner='fenice'`) è definito in un solo modulo, `lib/chat-perimetro.ts`, che lista, dettaglio e API chiamano tutti. Una colonna nuova `messages.sender` registra chi ha prodotto ogni messaggio in uscita.

**Tech Stack:** Next.js (App Router, `dynamic = 'force-dynamic'`), TypeScript, Supabase (PostgREST + Auth + Realtime), Tailwind, shadcn/ui, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-pannello-chat-supervisione-design.md`

## Global Constraints

- **Sola lettura per costruzione.** Nessun `Composer` importato in `app/(chat)/`, nessun endpoint POST/PATCH/DELETE sotto `/api/chat/`. Non è un flag: è l'assenza del pezzo.
- **Il pannello non marca nulla come letto.** A differenza di `/inbox` e `/campagne-chat`, non tocca `messages.read_at` né `conversations.unread_count`.
- **Client di sessione, mai service-role.** Usa `getSupabaseServer()` (come `/campagne-chat`), mai il client admin che `/fenice` usa.
- **Nessun taglio della storia.** Nessun filtro su `ai_started_at`: i messaggi si mostrano dal primo.
- **Perimetro in un posto solo.** Ogni filtro sul perimetro passa da `lib/chat-perimetro.ts`. Vietato riscrivere il `.or()` a mano nei call site.
- **Utenza:** `fenice@academy.com`. Password richiesta `2134`, ma Supabase Auth impone un minimo di 6 caratteri: si usa **`fenice2134`**.
- **Copy in italiano**, come tutto il resto del pannello.
- Test: `npm test` (Vitest, file `lib/*.test.ts`). Tipi: `npm run typecheck`. Lint: `npm run lint`.
- Commit in italiano, imperativo, prefisso convenzionale (`feat:`, `test:`, `docs:`, `chore:`).

## File Structure

| File | Responsabilità |
|---|---|
| `lib/access.ts` *(modifica)* | mappa email → area; aggiunge l'area `chat` |
| `lib/access.test.ts` *(modifica)* | copertura della quarta area |
| `lib/chat-perimetro.ts` *(nuovo)* | definizione unica del perimetro + etichetta del mondo |
| `lib/chat-perimetro.test.ts` *(nuovo)* | test del perimetro |
| `lib/sender.ts` *(nuovo)* | tipo `Sender`, etichette in italiano, soglia della stima |
| `lib/sender.test.ts` *(nuovo)* | test delle etichette e della soglia |
| `supabase/migrations/20260731000001_messages_sender.sql` *(nuovo)* | colonna `sender` + backfill dello storico |
| `lib/supabase/types.ts` *(modifica)* | allinea il tipo `messages` alla colonna nuova |
| `app/api/chat/conversations/route.ts` *(nuovo)* | GET lista conversazioni del perimetro |
| `app/api/chat/conversations/[id]/messages/route.ts` *(nuovo)* | GET messaggi di una conversazione, con guardia |
| `app/(chat)/layout.tsx` *(nuovo)* | shell minima (header, logout), come `app/(campagne)/layout.tsx` |
| `app/(chat)/chat/layout.tsx` *(nuovo)* | lista conversazioni persistente |
| `app/(chat)/chat/page.tsx` *(nuovo)* | stato vuoto |
| `app/(chat)/chat/[conversationId]/page.tsx` *(nuovo)* | intestazione (mondo, esito bot) + thread |
| `components/MessageBubble.tsx` *(modifica)* | etichetta opzionale di chi ha scritto |
| `components/MessageThread.tsx` *(modifica)* | propaga `sender` e la prop `showSender` |
| `components/ConversationList.tsx` *(modifica)* | badge opzionale del mondo |
| ~13 punti d'invio *(modifica)* | valorizzano `sender` all'insert |

---

### Task 1: Area di accesso `chat`

**Files:**
- Modify: `lib/access.ts`
- Test: `lib/access.test.ts`

**Interfaces:**
- Consumes: niente (primo task).
- Produces: `Area` estesa con `'chat'`; `areaForEmail('fenice@academy.com') === 'chat'`; `canAccess` e `landingPath` che riconoscono `/chat`. Il `proxy.ts` esistente li usa già: **non va toccato**.

- [ ] **Step 1: Scrivere il test che fallisce**

In coda a `lib/access.test.ts`:

```ts
describe('area chat', () => {
  it('fenice@academy.com vede solo /chat', () => {
    expect(areaForEmail('fenice@academy.com')).toBe('chat');
    expect(canAccess('fenice@academy.com', '/chat')).toBe(true);
    expect(canAccess('fenice@academy.com', '/chat/42')).toBe(true);
    expect(canAccess('fenice@academy.com', '/api/chat/conversations')).toBe(true);
    expect(canAccess('fenice@academy.com', '/api/chat/conversations/42/messages')).toBe(true);
    expect(landingPath('fenice@academy.com')).toBe('/chat');
  });

  it('fenice@academy.com non vede il resto', () => {
    expect(canAccess('fenice@academy.com', '/inbox')).toBe(false);
    expect(canAccess('fenice@academy.com', '/fenice')).toBe(false);
    expect(canAccess('fenice@academy.com', '/campagne-chat')).toBe(false);
    expect(canAccess('fenice@academy.com', '/api/conversations')).toBe(false);
    expect(canAccess('fenice@academy.com', '/api/messages')).toBe(false);
    expect(canAccess('fenice@academy.com', '/campagne')).toBe(false);
  });

  it('blocca route sibling con prefisso simile', () => {
    expect(canAccess('fenice@academy.com', '/chat-admin')).toBe(false);
    expect(canAccess('fenice@academy.com', '/api/chatbot')).toBe(false);
  });

  it('le altre aree non vedono /chat, gli account all sì', () => {
    expect(canAccess('campagne@fenice.com', '/chat')).toBe(false);
    expect(canAccess('fenicebot@fenice.com', '/chat')).toBe(false);
    expect(canAccess('brunoiacopo02@gmail.com', '/chat')).toBe(true);
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/access.test.ts`
Expected: FAIL — `areaForEmail('fenice@academy.com')` restituisce `'all'`, non `'chat'`.

- [ ] **Step 3: Implementare**

In `lib/access.ts`:

```ts
export type Area = 'fenice' | 'campagne' | 'chat' | 'all';

const FENICE_ONLY = new Set(['fenicebot@fenice.com']);
const CAMPAGNE_ONLY = new Set(['campagne@fenice.com']);
const CHAT_ONLY = new Set(['fenice@academy.com']);

export function areaForEmail(email: string | null | undefined): Area {
  const e = email?.toLowerCase();
  if (e && FENICE_ONLY.has(e)) return 'fenice';
  if (e && CAMPAGNE_ONLY.has(e)) return 'campagne';
  if (e && CHAT_ONLY.has(e)) return 'chat';
  return 'all';
}
```

Dentro `canAccess`, subito dopo il ramo `campagne`:

```ts
  if (area === 'chat') {
    return path === '/chat' || path.startsWith('/chat/')
      || path === '/api/chat' || path.startsWith('/api/chat/');
  }
```

Dentro `landingPath`, prima del `return '/inbox'`:

```ts
  if (area === 'chat') return '/chat';
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `npm test -- lib/access.test.ts`
Expected: PASS, tutti i blocchi `describe` compresi quelli preesistenti.

- [ ] **Step 5: Commit**

```bash
git add lib/access.ts lib/access.test.ts
git commit -m "feat(chat): area di accesso dedicata per fenice@academy.com"
```

---

### Task 2: Perimetro e mondo della conversazione

**Files:**
- Create: `lib/chat-perimetro.ts`
- Test: `lib/chat-perimetro.test.ts`

**Interfaces:**
- Consumes: `getFeniceCampaignIds(client)` da `lib/campagne.ts` (già esistente, restituisce `Promise<number[]>`).
- Produces:
  - `soloMondoFenice(query: any, feniceIds: number[]): any`
  - `isConversazioneChat(client: SupabaseClient, conversationId: number): Promise<boolean>`
  - `type Mondo = 'GDO' | 'MARIO' | 'CAMPAGNA'`
  - `mondoDi(c: { gdo_agenda_at?: string | null; ai_owner?: string | null }): Mondo`

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `lib/chat-perimetro.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { soloMondoFenice, isConversazioneChat, mondoDi } from './chat-perimetro';

/** Finto query builder che registra le chiamate invece di parlare col DB. */
function fakeQuery() {
  const calls: { method: string; args: unknown[] }[] = [];
  const q: Record<string, unknown> = {};
  for (const m of ['or', 'eq', 'in']) {
    q[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return q; };
  }
  return { q, calls };
}

/** Finto client Supabase che restituisce una riga conversations fissa. */
function fakeClient(row: unknown) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row }) }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('soloMondoFenice', () => {
  it('con campagne fenice: un solo OR con mario e le campagne', () => {
    const { q, calls } = fakeQuery();
    soloMondoFenice(q, [7, 9]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('or');
    expect(calls[0].args[0]).toBe('ai_owner.eq.mario,campaign_id.in.(7,9)');
  });

  it('senza campagne fenice: solo mario, mai un IN vuoto', () => {
    const { q, calls } = fakeQuery();
    soloMondoFenice(q, []);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('eq');
    expect(calls[0].args).toEqual(['ai_owner', 'mario']);
    // `IN ()` è SQL invalido: non deve comparire in nessuna forma.
    expect(JSON.stringify(calls)).not.toContain('in.()');
  });
});

describe('isConversazioneChat', () => {
  it('dentro: lead di Mario', async () => {
    const c = fakeClient({ ai_owner: 'mario', campaign_id: null, campaign: null });
    expect(await isConversazioneChat(c, 1)).toBe(true);
  });

  it('dentro: lead GDO postino (è comunque ai_owner mario)', async () => {
    const c = fakeClient({ ai_owner: 'mario', campaign_id: 3, campaign: { owner: 'serenamente' } });
    expect(await isConversazioneChat(c, 1)).toBe(true);
  });

  it('dentro: conversazione di campagna fenice', async () => {
    const c = fakeClient({ ai_owner: null, campaign_id: 7, campaign: { owner: 'fenice' } });
    expect(await isConversazioneChat(c, 1)).toBe(true);
  });

  it('fuori: Serenamente senza campagna', async () => {
    const c = fakeClient({ ai_owner: null, campaign_id: null, campaign: null });
    expect(await isConversazioneChat(c, 1)).toBe(false);
  });

  it('fuori: campagna non fenice', async () => {
    const c = fakeClient({ ai_owner: null, campaign_id: 3, campaign: { owner: 'serenamente' } });
    expect(await isConversazioneChat(c, 1)).toBe(false);
  });

  it('fuori: conversazione inesistente', async () => {
    const c = fakeClient(null);
    expect(await isConversazioneChat(c, 999)).toBe(false);
  });
});

describe('mondoDi', () => {
  it('GDO vince su tutto', () => {
    expect(mondoDi({ gdo_agenda_at: '2026-07-31T10:00:00Z', ai_owner: 'mario' })).toBe('GDO');
  });
  it('Mario quando non è postino', () => {
    expect(mondoDi({ gdo_agenda_at: null, ai_owner: 'mario' })).toBe('MARIO');
  });
  it('Campagna quando il bot non la governa', () => {
    expect(mondoDi({ gdo_agenda_at: null, ai_owner: null })).toBe('CAMPAGNA');
  });
});
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/chat-perimetro.test.ts`
Expected: FAIL — `Cannot find module './chat-perimetro'`.

- [ ] **Step 3: Implementare**

Creare `lib/chat-perimetro.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Perimetro del pannello /chat: il mondo Fenice.
 *
 * Una conversazione entra se è governata dal bot (`ai_owner='mario'`, che copre
 * sia i lead di Mario sia i lead GDO in modalità postino) oppure se appartiene a
 * una campagna di proprietà Fenice. Resta fuori tutta Serenamente.
 */

export type Mondo = 'GDO' | 'MARIO' | 'CAMPAGNA';

/**
 * Restringe una query su `conversations` al perimetro.
 *
 * NB: con lista vuota `campaign_id.in.()` è SQL invalido, da cui il ramo esplicito.
 * È il gemello speculare della trappola di `excludeFeniceCampaigns` in lib/campagne.ts,
 * dove il problema era il NOT IN che scarta i NULL.
 */
// Il tipo del query builder supabase-js non si presta a un generic semplice:
// `any` mirato, coerente con lo stile di lib/campagne.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function soloMondoFenice(query: any, feniceIds: number[]): any {
  if (feniceIds.length === 0) return query.eq('ai_owner', 'mario');
  return query.or(`ai_owner.eq.mario,campaign_id.in.(${feniceIds.join(',')})`);
}

/** True se la conversazione è nel perimetro del pannello /chat. */
export async function isConversazioneChat(
  client: SupabaseClient,
  conversationId: number,
): Promise<boolean> {
  const { data } = await client
    .from('conversations')
    .select('ai_owner, campaign_id, campaign:campaigns(owner)')
    .eq('id', conversationId)
    .maybeSingle();
  const row = data as { ai_owner?: string | null; campaign?: { owner?: string } | null } | null;
  if (!row) return false;
  return row.ai_owner === 'mario' || row.campaign?.owner === 'fenice';
}

/**
 * A quale mondo appartiene la conversazione.
 * L'ordine conta: una chat GDO ha comunque `ai_owner='mario'` e può avere un
 * `campaign_id` fenice ereditato da una campagna precedente.
 */
export function mondoDi(c: { gdo_agenda_at?: string | null; ai_owner?: string | null }): Mondo {
  if (c.gdo_agenda_at) return 'GDO';
  if (c.ai_owner === 'mario') return 'MARIO';
  return 'CAMPAGNA';
}
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

Run: `npm test -- lib/chat-perimetro.test.ts`
Expected: PASS (14 test).

- [ ] **Step 5: Commit**

```bash
git add lib/chat-perimetro.ts lib/chat-perimetro.test.ts
git commit -m "feat(chat): perimetro del mondo Fenice in un modulo unico"
```

---

### Task 3: API lista conversazioni

**Files:**
- Create: `app/api/chat/conversations/route.ts`

**Interfaces:**
- Consumes: `soloMondoFenice`, `mondoDi` (Task 2); `getFeniceCampaignIds` da `lib/campagne.ts`.
- Produces: `GET /api/chat/conversations?filter=all|unread|recent&q=<testo>` → `{ data: Conv[] }`, dove ogni `Conv` ha i campi che `ConversationList` si aspetta (`id`, `last_message_at`, `unread_count`, `lead`, `preview`) **più** `mondo: 'GDO'|'MARIO'|'CAMPAGNA'`, consumato dal badge in Task 8.

- [ ] **Step 1: Scrivere la rotta**

Questa rotta è un assemblaggio senza logica propria (la logica testabile sta in `lib/chat-perimetro.ts`, già coperta in Task 2): il codebase non ha test sulle rotte `app/api/**` e questo task ne segue la convenzione. La verifica è tipi + build + prova manuale in Task 9.

Creare `app/api/chat/conversations/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getFeniceCampaignIds } from '@/lib/campagne';
import { soloMondoFenice, mondoDi } from '@/lib/chat-perimetro';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ConversationRow = {
  id: number;
  last_message_at: string | null;
  last_inbound_at: string | null;
  unread_count: number | null;
  campaign_id: number | null;
  last_message_preview: string | null;
  ai_owner: string | null;
  gdo_agenda_at: string | null;
  lead: { id: number; phone_e164: string | null; first_name: string | null; last_name: string | null } | null;
};

export async function GET(req: Request) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const filter = url.searchParams.get('filter'); // 'all'|'unread'|'recent'
  const search = url.searchParams.get('q')?.trim() ?? '';

  const feniceIds = await getFeniceCampaignIds(supabase);

  let query = supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, campaign_id, last_message_preview,
      ai_owner, gdo_agenda_at,
      lead:leads ( id, phone_e164, first_name, last_name )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);
  query = soloMondoFenice(query, feniceIds);

  if (filter === 'unread') query = query.gt('unread_count', 0);
  if (filter === 'recent') query = query.gte('last_message_at', new Date(Date.now() - 7 * 86400_000).toISOString());

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // La ricerca è client-side sul risultato, come in /api/conversations.
  const filtered = !search
    ? ((data ?? []) as unknown as ConversationRow[])
    : ((data ?? []) as unknown as ConversationRow[]).filter((c) => {
        const s = search.toLowerCase();
        return (c.lead?.first_name ?? '').toLowerCase().includes(s)
          || (c.lead?.last_name ?? '').toLowerCase().includes(s)
          || (c.lead?.phone_e164 ?? '').toLowerCase().includes(s);
      });

  const out = filtered.map((c) => ({
    ...c,
    preview: c.last_message_preview ?? undefined,
    mondo: mondoDi(c),
  }));
  return NextResponse.json({ data: out });
}
```

- [ ] **Step 2: Verificare tipi e lint**

Run: `npm run typecheck && npm run lint`
Expected: nessun errore. `gdo_agenda_at` e `ai_owner` sono già nei tipi generati (migration 20260729000001), quindi non serve nessun cast.

- [ ] **Step 3: Commit**

```bash
git add app/api/chat/conversations/route.ts
git commit -m "feat(chat): API lista conversazioni del perimetro Fenice"
```

---

### Task 4: API messaggi di una conversazione

**Files:**
- Create: `app/api/chat/conversations/[id]/messages/route.ts`

**Interfaces:**
- Consumes: `isConversazioneChat` (Task 2).
- Produces: `GET /api/chat/conversations/:id/messages` → `{ data: Msg[] }` ordinati per `created_at` crescente, **senza** filtro su `ai_started_at`. Fuori perimetro: `403 {"error":"forbidden"}`. È il valore che `MessageThread` riceve via `apiBase="/api/chat/conversations"`.

- [ ] **Step 1: Scrivere la rotta**

Creare `app/api/chat/conversations/[id]/messages/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { isConversazioneChat } from '@/lib/chat-perimetro';

export const runtime = 'nodejs';

// Sola lettura: qui non esiste POST, e la conversazione non viene mai marcata come
// letta — chi supervisiona non deve alterare lo stato di chi lavora.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });

  const conversationId = parseInt(id, 10);
  if (Number.isNaN(conversationId)) return new NextResponse('bad request', { status: 400 });
  if (!(await isConversazioneChat(supabase, conversationId))) {
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

- [ ] **Step 2: Verificare tipi e lint**

Run: `npm run typecheck && npm run lint`
Expected: nessun errore.

- [ ] **Step 3: Commit**

```bash
git add "app/api/chat/conversations/[id]/messages/route.ts"
git commit -m "feat(chat): API messaggi con guardia di perimetro"
```

---

### Task 5: Shell e pagine `/chat`

**Files:**
- Create: `app/(chat)/layout.tsx`
- Create: `app/(chat)/chat/layout.tsx`
- Create: `app/(chat)/chat/page.tsx`
- Create: `app/(chat)/chat/[conversationId]/page.tsx`

**Interfaces:**
- Consumes: `soloMondoFenice`, `mondoDi` (Task 2); `getFeniceCampaignIds`; `ConversationList`, `MessageThread` (prop già esistenti).
- Produces: le rotte `/chat` e `/chat/:id`. L'intestazione della pagina di dettaglio verrà arricchita in Task 8 con esito del bot e badge del mondo; qui nasce con nome, telefono e thread.

- [ ] **Step 1: Creare la shell del route group**

`app/(chat)/layout.tsx` — copia strutturale di `app/(campagne)/layout.tsx`, cambia solo il titolo:

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { signOutAction } from '@/app/(auth)/login/actions';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Eye } from 'lucide-react';

export const dynamic = 'force-dynamic';

// Shell minima per l'utenza di supervisione: solo header, niente sidebar.
// L'accesso è già gestito dal proxy, qui non serve logica di redirect.
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 font-medium">
          <Eye className="size-5 text-amber-600" />
          Chat · sola lettura
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

- [ ] **Step 2: Creare la lista persistente**

`app/(chat)/chat/layout.tsx`:

```tsx
import { getSupabaseServer } from '@/lib/supabase/server';
import { ConversationList } from '@/components/ConversationList';
import { getFeniceCampaignIds } from '@/lib/campagne';
import { soloMondoFenice, mondoDi } from '@/lib/chat-perimetro';

export const dynamic = 'force-dynamic';

// La lista vive nel layout: resta montata navigando tra le chat, così il filtro
// selezionato non si resetta. Mirror di (campagne)/campagne-chat/layout.tsx.
export default async function ChatListLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getSupabaseServer();
  const feniceIds = await getFeniceCampaignIds(supabase);

  let query = supabase
    .from('conversations')
    .select(`
      id, last_message_at, last_inbound_at, unread_count, last_message_preview,
      ai_owner, gdo_agenda_at,
      lead:leads ( id, phone_e164, first_name, last_name )
    `)
    .order('last_message_at', { ascending: false })
    .limit(200);
  query = soloMondoFenice(query, feniceIds);
  const { data } = await query;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initial = (data ?? []).map((c: any) => ({
    ...c,
    preview: c.last_message_preview ?? undefined,
    mondo: mondoDi(c),
  }));

  return (
    <div className="flex h-full">
      <ConversationList
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        initial={initial as any}
        apiPath="/api/chat/conversations"
        basePath="/chat"
        channelName="chat-list"
      />
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Creare lo stato vuoto**

`app/(chat)/chat/page.tsx`:

```tsx
import { MessagesSquare } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default function ChatIndexPage() {
  return (
    <div className="hidden md:flex flex-1 items-center justify-center text-zinc-400">
      <div className="text-center">
        <MessagesSquare className="size-10 mx-auto mb-2" />
        <p>Seleziona una conversazione</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Creare la pagina di dettaglio**

`app/(chat)/chat/[conversationId]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';
import { MessageThread } from '@/components/MessageThread';
import { isConversazioneChat } from '@/lib/chat-perimetro';

export const dynamic = 'force-dynamic';

// Sola lettura: nessun Composer, e nessuna scrittura su read_at/unread_count.
export default async function ChatConversationPage({
  params,
}: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const id = parseInt(conversationId, 10);
  if (Number.isNaN(id)) notFound();

  const supabase = await getSupabaseServer();
  if (!(await isConversazioneChat(supabase, id))) notFound();

  const [convRes, msgsRes] = await Promise.all([
    supabase.from('conversations').select(`
      id, last_inbound_at, last_message_at, ai_owner, ai_status, gdo_agenda_at,
      bot_outcome, bot_scheduled_at,
      lead:leads(id, first_name, last_name, phone_e164)
    `).eq('id', id).single(),
    // Storia intera: nessun taglio a ai_started_at, a differenza di /fenice/conversazioni.
    supabase.from('messages').select('*').eq('conversation_id', id)
      .order('created_at', { ascending: true }).limit(500),
  ]);

  if (!convRes.data) notFound();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conv = convRes.data as any;
  const fullName = [conv.lead?.first_name, conv.lead?.last_name].filter(Boolean).join(' ')
    || conv.lead?.phone_e164 || 'Sconosciuto';

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <header className="border-b px-4 py-3">
        <div className="text-base font-medium">{fullName}</div>
        <div className="text-xs text-zinc-500">{conv.lead?.phone_e164}</div>
      </header>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} apiBase="/api/chat/conversations" />
    </div>
  );
}
```

- [ ] **Step 5: Verificare tipi, lint e build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: build completata, con le rotte `/chat` e `/chat/[conversationId]` nell'elenco.

- [ ] **Step 6: Commit**

```bash
git add "app/(chat)"
git commit -m "feat(chat): pannello /chat in sola lettura sul mondo Fenice"
```

---

### Task 6: Colonna `messages.sender` e backfill

**Files:**
- Create: `supabase/migrations/20260731000001_messages_sender.sql`
- Create: `lib/sender.ts`
- Test: `lib/sender.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces:
  - colonna `public.messages.sender text` (nullable), popolata sullo storico dal backfill;
  - `type Sender = 'bot' | 'automazione' | 'operatore'`;
  - `SENDER_STIMATO_PRIMA_DI: string` (ISO UTC);
  - `senderStimato(createdAt: string): boolean`;
  - `senderLabel(sender: string | null | undefined): string | null` → `'Mario' | 'Automazione' | 'Operatore' | null`.

**Nota:** questo task crea solo il file di migration. L'applicazione in produzione è il Task 9 — questo progetto applica il DDL dal SQL Editor del dashboard, vedi `docs/` e la memoria `reference_supabase_ddl_senza_pat`.

- [ ] **Step 1: Scrivere la migration**

Creare `supabase/migrations/20260731000001_messages_sender.sql`:

```sql
-- Attribuzione dei messaggi in uscita.
--
-- Fino a qui una risposta del bot e una scritta a mano da un operatore erano righe
-- identiche (direction='out', is_template=false, template_sid=null): il pannello di
-- supervisione /chat non poteva distinguerle. `sender` registra chi ha prodotto il testo.

alter table public.messages add column if not exists sender text;

comment on column public.messages.sender is
  'Chi ha prodotto il messaggio in uscita: bot (turno di Mario) | automazione (template programmato) | operatore (persona dalla UI). Nullo sugli inbound.';

-- Backfill dello storico. È una STIMA dichiarata, non un dato registrato: la UI marca
-- come "stimato" tutto ciò che precede l'applicazione di questa migration.

-- 1) i template sono sempre automazione
update public.messages
   set sender = 'automazione'
 where sender is null and direction = 'out' and is_template = true;

-- 2) testo libero in uscita dentro una chat governata dal bot: quasi sempre Mario
update public.messages m
   set sender = 'bot'
  from public.conversations c
 where m.conversation_id = c.id
   and m.sender is null
   and m.direction = 'out'
   and coalesce(m.is_template, false) = false
   and c.ai_owner = 'mario';

-- 3) tutto il resto in uscita: una persona dalla UI
update public.messages
   set sender = 'operatore'
 where sender is null and direction = 'out';
```

Nessun indice: non si filtra su questa colonna.

- [ ] **Step 2: Scrivere il test che fallisce**

Creare `lib/sender.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { senderLabel, senderStimato, SENDER_STIMATO_PRIMA_DI } from './sender';

describe('senderLabel', () => {
  it('traduce i tre valori', () => {
    expect(senderLabel('bot')).toBe('Mario');
    expect(senderLabel('automazione')).toBe('Automazione');
    expect(senderLabel('operatore')).toBe('Operatore');
  });
  it('niente etichetta per gli inbound e per i valori ignoti', () => {
    expect(senderLabel(null)).toBeNull();
    expect(senderLabel(undefined)).toBeNull();
    expect(senderLabel('marziano')).toBeNull();
  });
});

describe('senderStimato', () => {
  it('prima della soglia: stima', () => {
    expect(senderStimato('2026-07-01T10:00:00+00:00')).toBe(true);
  });
  it('dopo la soglia: dato certo', () => {
    expect(senderStimato('2026-12-31T10:00:00+00:00')).toBe(false);
  });
  it('la soglia è una ISO valida', () => {
    expect(Number.isNaN(Date.parse(SENDER_STIMATO_PRIMA_DI))).toBe(false);
  });
});
```

- [ ] **Step 3: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/sender.test.ts`
Expected: FAIL — `Cannot find module './sender'`.

- [ ] **Step 4: Implementare**

Creare `lib/sender.ts`:

```ts
/** Chi ha prodotto un messaggio in uscita. Gli inbound hanno `sender` nullo. */
export type Sender = 'bot' | 'automazione' | 'operatore';

/**
 * Soglia oltre la quale `sender` è un dato registrato all'invio.
 * Prima di questo istante viene dal backfill della migration 20260731000001:
 * è una deduzione (sbaglia sui messaggi scritti a mano dentro una chat di Mario).
 * Va allineata al momento reale di applicazione in produzione — vedi Task 9 del piano.
 */
export const SENDER_STIMATO_PRIMA_DI = '2026-07-31T00:00:00Z';

export function senderStimato(createdAt: string): boolean {
  return Date.parse(createdAt) < Date.parse(SENDER_STIMATO_PRIMA_DI);
}

const LABELS: Record<string, string> = {
  bot: 'Mario',
  automazione: 'Automazione',
  operatore: 'Operatore',
};

/** Etichetta in italiano, o null se non c'è niente da mostrare. */
export function senderLabel(sender: string | null | undefined): string | null {
  return (sender && LABELS[sender]) ?? null;
}
```

- [ ] **Step 5: Eseguire il test e verificare che passi**

Run: `npm test -- lib/sender.test.ts`
Expected: PASS (5 test).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260731000001_messages_sender.sql lib/sender.ts lib/sender.test.ts
git commit -m "feat(chat): colonna messages.sender con backfill dello storico"
```

---

### Task 7: Valorizzare `sender` a ogni invio

**Files:**
- Modify: `lib/supabase/types.ts` (blocco `messages`)
- Modify: `lib/fenice-autoreply.ts:240`, `:328`
- Modify: `lib/conversation-send.ts:42`, `:79`
- Modify: `lib/messaging.ts:68`, `:84`
- Modify: `lib/agenda-followup.ts:160`
- Modify: `app/api/cron/sequence-touches/route.ts:64`, `:89`, `:343`
- Modify: `app/api/cron/send-batch/route.ts:138`, `:161`
- Modify: `app/api/webhooks/activecampaign/route.ts:156`, `:170`
- Modify: `scripts/invio-agenda-gdo.mjs:232`
- Modify: `scripts/invio-video-agenda-gdo.mjs:228`
- Test: `lib/fenice-autoreply.test.ts` (esistente, estendere)

**Interfaces:**
- Consumes: `Sender` da `lib/sender.ts` (Task 6).
- Produces: ogni riga `messages` con `direction='out'` inserita da qui in avanti ha `sender` valorizzato. Gli inbound (`app/api/webhooks/twilio/route.ts:137`) restano a `null` e **non vanno toccati**.

**Regola di attribuzione:** `bot` = testo deciso e composto dal turno di Mario; `automazione` = template programmato, nessuna decisione presa sul momento; `operatore` = una persona l'ha scritto o scelto dalla UI.

- [ ] **Step 1: Allineare i tipi generati**

In `lib/supabase/types.ts`, trovare il blocco `messages` e aggiungere `sender: string | null` a `Row`, `Insert` (opzionale: `sender?: string | null`) e `Update` (opzionale). Aggiungere sopra il blocco:

```ts
      // NB: `sender` (migration 20260731000001) aggiunto a mano in attesa del prossimo
      // `npm run supabase:gen-types`, che lo riprodurrà identico. Preferito ai cast `as any`
      // sparsi sui 13 punti d'invio (il precedente di `campaigns.owner` è ciò che si evita).
```

- [ ] **Step 2: Scrivere il test che fallisce**

`lib/fenice-autoreply.test.ts` ha già il fake `makeDrainSupabase(claimedRow, rows)`, che restituisce `{ supabase, calls }` e traccia ogni insert su `messages` in `calls.messageInserts`. Aggiungere in coda al `describe('drainMarioReplies — guardia canSendOutcome dal vivo')` questo test, che riusa lo stesso stampo dei casi già presenti:

```ts
  it("la risposta di Mario viene registrata con sender 'bot'", async () => {
    const claimedRow: ClaimedRow = { id: 45, ai_started_at: null, crm_lead_id: 'crm1', bot_outcome: null };
    const rows: FakeMsgRow[] = [
      OPENING,
      { direction: 'in', body: 'mi interessa, come funziona?', template_sid: null, created_at: '2026-07-25T09:00:00Z' },
    ];
    const { supabase, calls } = makeDrainSupabase(claimedRow, rows);
    vi.mocked(generateMarioReply).mockResolvedValueOnce({
      visibleReply: 'Te lo spiego in due parole.',
      appointmentFixed: false, passToHuman: false, videoWatched: false,
    });

    await drainMarioReplies(supabase, 45, '+391234567890', () => 0);

    expect(calls.messageInserts.length).toBeGreaterThan(0);
    expect(calls.messageInserts.every((m) => m.sender === 'bot')).toBe(true);
  });
```

Se `generateMarioReply` richiede altri campi obbligatori nel valore mockato, copiarli da un caso vicino nello stesso file: l'unica asserzione che conta qui è quella su `sender`.

- [ ] **Step 3: Eseguire il test e verificare che fallisca**

Run: `npm test -- lib/fenice-autoreply.test.ts`
Expected: FAIL — `sender` è `undefined` sugli insert.

- [ ] **Step 4: Valorizzare `sender` nei punti d'invio dell'app**

In ciascun insert su `messages` elencato, aggiungere una sola proprietà all'oggetto inserito, secondo questa tabella:

| File:riga | Cosa fa | Valore |
|---|---|---|
| `lib/fenice-autoreply.ts:328` | risposta AI di Mario | `sender: 'bot',` |
| `lib/fenice-autoreply.ts:240` | video GDO al primo inbound | `sender: 'bot',` |
| `lib/conversation-send.ts:42` | testo libero dalla UI | `sender: 'operatore',` |
| `lib/conversation-send.ts:79` | template scelto dalla UI | `sender: 'operatore',` |
| `lib/messaging.ts:68` | `sendTemplateAndLog` | `sender: 'automazione',` |
| `lib/messaging.ts:84` | `sendTemplateAndLog` | `sender: 'automazione',` |
| `lib/agenda-followup.ts:160` | follow-up agenda | `sender: 'automazione',` |
| `app/api/cron/sequence-touches/route.ts:64` | touch di sequenza | `sender: 'automazione',` |
| `app/api/cron/sequence-touches/route.ts:89` | touch di sequenza | `sender: 'automazione',` |
| `app/api/cron/sequence-touches/route.ts:343` | touch di sequenza | `sender: 'automazione',` |
| `app/api/cron/send-batch/route.ts:138` | invio campagna | `sender: 'automazione',` |
| `app/api/cron/send-batch/route.ts:161` | invio campagna | `sender: 'automazione',` |
| `app/api/webhooks/activecampaign/route.ts:156` | invio da webhook AC | `sender: 'automazione',` |
| `app/api/webhooks/activecampaign/route.ts:170` | invio da webhook AC | `sender: 'automazione',` |

I numeri di riga vengono dallo stato del repo al 31/07/2026: verificare che la riga sia davvero un `.from('messages').insert({`. **Non toccare** `app/api/webhooks/twilio/route.ts:137` (inbound).

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `npm test`
Expected: PASS su tutta la suite (nessuna regressione: `sender` è additivo).

- [ ] **Step 6: Valorizzare `sender` negli script d'invio**

In `scripts/invio-agenda-gdo.mjs:232` e `scripts/invio-video-agenda-gdo.mjs:228`, l'insert passa da `sb('messages', {...})`. Aggiungere all'oggetto del body:

```js
      sender: 'automazione',
```

- [ ] **Step 7: Verificare gli script a vuoto**

Run: `node scripts/invio-agenda-gdo.mjs --help 2>&1 | head -5` (oppure un dry run con una CSV già processata, che deve restituire `DA INVIARE: 0`)
Expected: nessun errore di sintassi; nessun invio.

- [ ] **Step 8: Verificare tipi e lint**

Run: `npm run typecheck && npm run lint`
Expected: nessun errore, nessun `as any` nuovo (i tipi sono stati allineati allo Step 1).

- [ ] **Step 9: Commit**

```bash
git add lib app/api scripts
git commit -m "feat(chat): ogni invio registra chi ha prodotto il messaggio"
```

---

### Task 8: Etichette nella UI

**Files:**
- Modify: `components/MessageBubble.tsx`
- Modify: `components/MessageThread.tsx`
- Modify: `components/ConversationList.tsx`
- Modify: `app/(chat)/chat/[conversationId]/page.tsx`

**Interfaces:**
- Consumes: `senderLabel`, `senderStimato` (Task 6); `mondoDi` e il campo `mondo` prodotto da Task 3/5; `ChatStatusPill`, `ReasonPill` da `components/fenice/status.tsx`; `segmentOf`, `fermaReason` da `lib/lead-segments.ts`.
- Produces: nessuna interfaccia nuova per altri task — è l'ultimo strato.

**Vincolo:** `MessageBubble`, `MessageThread` e `ConversationList` sono condivisi con `/inbox` e `/campagne-chat`. Ogni aggiunta è **opzionale e disattivata di default**: quei due pannelli non devono cambiare di una virgola.

- [ ] **Step 1: Etichetta di chi ha scritto nella bolla**

In `components/MessageBubble.tsx`, estendere il tipo `msg` con `sender?: string | null`, aggiungere la prop `showSender`, e importare gli helper:

```tsx
import { cn, formatRelativeShort } from '@/lib/utils';
import { DeliveryStatus } from './DeliveryStatus';
import { senderLabel, senderStimato } from '@/lib/sender';

export function MessageBubble({ msg, campaignName, showSender = false }: {
  msg: { id: number; direction: 'in' | 'out'; body: string; created_at: string;
    twilio_status?: string | null; twilio_error_code?: number | null; is_template?: boolean | null;
    sender?: string | null };
  campaignName?: string | null;
  showSender?: boolean;
}) {
  const out = msg.direction === 'out';
  const chi = showSender && out ? senderLabel(msg.sender) : null;
```

E dentro la bolla, subito prima della riga `<div className="whitespace-pre-wrap …">`:

```tsx
        {chi && (
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
            {chi}{senderStimato(msg.created_at) && ' · stimato'}
          </div>
        )}
```

- [ ] **Step 2: Propagare `sender` nel thread**

In `components/MessageThread.tsx`:

- estendere il tipo `Msg` con `sender?: string | null;`
- aggiungere la prop `showSender = false` alla firma e al tipo delle props (`showSender?: boolean`)
- passarla alla bolla: `<MessageBubble key={m.id} msg={m} campaignName={campaignNamesById[m.id]} showSender={showSender} />`

- [ ] **Step 3: Accendere l'etichetta solo in `/chat`**

In `app/(chat)/chat/[conversationId]/page.tsx`, aggiungere `showSender` al `MessageThread`:

```tsx
      <MessageThread conversationId={id} initial={(msgsRes.data ?? []) as any} campaignNamesById={{}} apiBase="/api/chat/conversations" showSender />
```

- [ ] **Step 4: Badge del mondo nella lista**

In `components/ConversationList.tsx`, estendere il tipo `Conv` con `mondo?: string;` e, nella riga della conversazione, aggiungere il badge accanto al nome. Sostituire il blocco:

```tsx
                <div className="flex justify-between items-baseline">
                  <span className="font-medium truncate">{name}</span>
                  <span className="text-xs text-zinc-500 shrink-0 ml-2">{formatRelativeShort(c.last_message_at)}</span>
                </div>
```

con:

```tsx
                <div className="flex justify-between items-baseline gap-2">
                  <span className="font-medium truncate">{name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    {/* Il badge compare solo dove l'API lo manda (pannello /chat): gli altri
                        pannelli non hanno `mondo` e restano identici a prima. */}
                    {c.mondo && (
                      <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                        {c.mondo === 'GDO' ? 'GDO' : c.mondo === 'MARIO' ? 'Mario' : 'Campagna'}
                      </span>
                    )}
                    <span className="text-xs text-zinc-500">{formatRelativeShort(c.last_message_at)}</span>
                  </span>
                </div>
```

- [ ] **Step 5: Mondo ed esito del bot nell'intestazione della chat**

In `app/(chat)/chat/[conversationId]/page.tsx`, aggiungere gli import:

```tsx
import { mondoDi } from '@/lib/chat-perimetro';
import { segmentOf, fermaReason } from '@/lib/lead-segments';
import { ChatStatusPill, ReasonPill, SegmentPill } from '@/components/fenice/status';
```

Prima del `return`, calcolare:

```tsx
  const now = new Date().toISOString();
  const seg = { bot_outcome: conv.bot_outcome, last_inbound_at: conv.last_inbound_at, ai_status: conv.ai_status };
  const mondo = mondoDi(conv);
  const appuntamento = conv.bot_scheduled_at
    ? new Date(conv.bot_scheduled_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
    : null;
```

E sostituire l'`<header>` con:

```tsx
      <header className="border-b px-4 py-3 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-medium">{fullName}</span>
          <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
            {mondo === 'GDO' ? 'GDO · postino' : mondo === 'MARIO' ? 'Mario' : 'Campagna'}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs text-zinc-500">
          <span>{conv.lead?.phone_e164}</span>
          <SegmentPill segment={segmentOf(seg, now)} />
          <ReasonPill reason={fermaReason(seg, now)} />
          <ChatStatusPill status={conv.ai_status} />
          {appuntamento && <span>Appuntamento: {appuntamento}</span>}
        </div>
      </header>
```

- [ ] **Step 6: Verificare che gli altri pannelli non cambino**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: tutto verde. `showSender` e `mondo` sono opzionali con default spento: `/inbox` e `/campagne-chat` non passano né l'uno né l'altro.

- [ ] **Step 7: Commit**

```bash
git add components "app/(chat)"
git commit -m "feat(chat): etichette di chi ha scritto, mondo della chat ed esito del bot"
```

---

### Task 9: Go-live

**Files:**
- Modify: `lib/sender.ts` (allineamento della soglia)

**Interfaces:**
- Consumes: tutto quanto sopra.
- Produces: pannello funzionante in produzione con l'utenza dedicata.

**Nota per chi esegue:** questo task tocca la produzione. I passi che richiedono credenziali (dashboard Supabase, Vercel) vanno eseguiti con Bruno o riportati a lui se bloccati — non inventare valori.

**Precondizione esplicita — ordine obbligato:** la migration `20260731000001_messages_sender.sql`
va applicata **PRIMA** del deploy del codice di questo branch, mai dopo. Se il codice arriva
prima della colonna, ogni insert su `messages` che valorizza `sender` (i ~13 punti d'invio del
Task 7) viene rifiutato da PostgREST con `PGRST204` ("column 'sender' does not exist"). Nessun
call site controlla l'errore dell'insert dei messaggi: il messaggio WhatsApp **parte comunque**
(la chiamata a Twilio avviene prima e non dipende dall'insert), ma la riga in `messages` non
viene mai scritta — un buco silenzioso nella cronologia, non un errore visibile. Per questo
Step 1 (migration) deve restare Step 1 e completarsi con successo prima di procedere a Step 5
(merge e deploy): non invertire l'ordine per convenienza.

Come conseguenza, se per qualunque motivo il deploy arriva prima della migration (o i due sono
comunque separati nel tempo, come qui), **dopo** il deploy vanno **ri-eseguite le tre UPDATE del
backfill** dello Step 1 (quelle nella migration, sezione "Backfill dello storico"). Sono
idempotenti (`where sender is null`), quindi rilanciarle non duplica né sovrascrive nulla: sono
lo strumento per recuperare gli outbound finiti nella finestra fra l'applicazione della
migration e il deploy del codice, che altrimenti resterebbero con `sender` nullo.

- [ ] **Step 1: Applicare la migration in produzione**

Progetto Supabase: `gosnmagiishkwuvmortj` ("App Messaggistica"). Il PAT non è disponibile: si applica il DDL dal SQL Editor del dashboard via Chrome, come per la migration GDO — procedura in `reference_supabase_ddl_senza_pat` (memoria) e precedente del 29/07. Incollare ed eseguire il contenuto di `supabase/migrations/20260731000001_messages_sender.sql`.

- [ ] **Step 2: Verificare il backfill**

Nel SQL Editor:

```sql
select sender, count(*) from public.messages where direction = 'out' group by sender;
select count(*) from public.messages where direction = 'out' and sender is null;
```

Expected: nessuna riga in uscita con `sender` nullo; le tre categorie popolate.

- [ ] **Step 3: Allineare la soglia della stima**

Leggere il momento reale di applicazione:

```sql
select now() at time zone 'utc';
```

Aggiornare `SENDER_STIMATO_PRIMA_DI` in `lib/sender.ts` con quel valore in formato ISO UTC (es. `'2026-07-31T16:42:00Z'`), poi:

```bash
npm test -- lib/sender.test.ts
git add lib/sender.ts
git commit -m "chore(chat): soglia della stima allineata all'applicazione della migration"
```

- [ ] **Step 4: Creare l'utenza**

Creare `fenice@academy.com` su Supabase Auth con password `fenice2134` e `email_confirm: true` (Admin API con il service role key già in `.env.local`, oppure dashboard → Authentication → Add user → Auto Confirm User).

Se Bruno preferisce un'altra password, usare quella: il vincolo è solo il minimo di 6 caratteri.

- [ ] **Step 5: Merge e deploy**

```bash
npm test && npm run typecheck && npm run build
git checkout main && git merge --no-ff <branch> -m "Merge feat/pannello-chat: supervisione in sola lettura sulle chat Fenice"
git push origin main
```

Attendere il deploy Vercel (stato `Ready`).

- [ ] **Step 6: Verifica in produzione**

1. Login con `fenice@academy.com` → deve atterrare su `/chat`.
2. La lista mostra chat con badge `Mario`, `GDO` e `Campagna`; **nessuna** chat Serenamente.
3. Aprire una chat GDO: il video Black Summer risulta `Mario`, l'agenda `Automazione`.
4. La chat non ha campo di scrittura.
5. Aprire a mano `/inbox`, `/fenice`, `/campagne-chat` → rimbalzo su `/chat`; `GET /api/conversations` → 403.
6. Con la tua utenza, aprire `/inbox` e `/campagne-chat` → identici a prima, nessun badge, nessuna etichetta.
7. Recuperare l'id di una conversazione Serenamente e aprire `/chat/<id>` → 404.

- [ ] **Step 7: Aggiornare la memoria di progetto**

Scrivere il nuovo file memoria `project_pannello_chat.md` (stato live, utenza, perimetro, limite RLS noto) e aggiungere la riga in `MEMORY.md`.

---

## Fuori scope (dalla spec, da non implementare)

- Esporre `conversations.bot_report` (il ragionamento strutturato di Mario): lavoro a sé.
- Qualsiasi capacità di scrittura, pausa del bot o presa in carico da `/chat`.
- RLS per ruolo: l'isolamento resta per path, come già per `campagne@fenice.com`.
- Il bug preesistente per cui un lead GDO con `campaign_id` fenice compare anche in `/campagne-chat` col composer attivo.
