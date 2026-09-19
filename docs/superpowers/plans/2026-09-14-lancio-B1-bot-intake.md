# Lancio Web Developer AI — Blocco B1 lato bot (intake, fase attesa/posto bloccato, esclusioni, badge) Implementation Plan

> ## ⚠️ SUPERATO IL 19/09/2026 — leggere prima di usare questo piano
>
> Il codice e gli esempi qui sotto sono quelli **come furono scritti allora** e si lasciano
> intatti perché questo è un piano eseguito, cioè un documento storico. Due regole delle
> restituzioni del lancio sono però cambiate dopo, e **vince quanto segue**:
>
> 1. **Le restituzioni partono il 7/10, non l'8.** Il 6 ottobre è tutto del bot (risposte e
>    follow-up); dal 7 si restituisce, così i GDO possono chiamare quei lead quel giorno
>    stesso. In codice: `restituzioniAttive` usa `>= dopodomani`, e `vercel.json` dice
>    `0 * 7-31 10 *`.
> 2. **L'attesa è di 24 ore, non 48, e si misura sull'ultimo messaggio in qualunque
>    direzione** (il follow-up mandato, o la risposta del lead se è arrivata dopo). Il
>    motivo `attesa_48h` si chiama ora `attesa_24h`. Chi è in conversazione viva resta al
>    bot (`ha_risposto`) e torna al pool più avanti, man mano che la chat si spegne — prima
>    un inbound dopo il follow-up lo tratteneva al bot per sempre.
>
> Fonte operativa aggiornata: `docs/lancio-webdev-runbook-b6.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il bot accetta dal CRM i lead della lista "Lancio Web Developer AI" con il campo `lancio`, manda loro il solo template di benvenuto, risponde nella fase `attesa` con un classificatore deterministico (sì → "posto bloccato", no → congedo + `DA_SCARTARE`, domanda → risposta secca del modello con prompt dedicato), e tiene queste conversazioni fuori da tutti gli automatismi di Mario (sequenza, nudge, classificazioni, promemoria, solleciti video), con badge e filtro "Lancio" nei pannelli.

**Architecture:** Sei colonne `lancio_*` su `conversations` e cinque chiavi `app_settings` (migrazione SQL applicata PRIMA del deploy). La logica di fase e di classificazione vive in moduli puri (`lib/lancio-fase.ts`, `lib/lancio-classifica.ts`) e il prompt in `lib/lancio-prompt.ts`, separato da `mario-prompt.ts`. L'I/O del turno sta in `lib/lancio-turno.ts`; `drainMarioReplies` lo aggancia con un solo `if` prima della logica di Mario. L'intake aggiunge un ramo in `enrollLeadIntoMario` che manda il template `LANCIO_WELCOME_TEMPLATE_SID` (differito fuori 07-23 o a `lancio_attivo=0`, ripreso dal cron dedicato `/api/cron/lancio-aperture`). I cron esistenti escludono le conversazioni con un lancio in corso tramite un filtro PostgREST unico (`FILTRO_FUORI_LANCIO`).

**Tech Stack:** Next.js 16 (App Router, `after()`), Supabase (PostgREST, `supabase-js`), Twilio WhatsApp Content API (template) + free-text, Anthropic SDK (`claude-sonnet-4-6`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md` — perimetro di questo piano: §3.2 (modello dati bot), §5.1 (intake lancio + esclusioni), §5.2 (fase `attesa` → `posto_bloccato`), §5.6 solo "badge/filtro Lancio nei pannelli /fenice e /chat", §9 riga B1 (bot).

## Global Constraints

- **Nomi ESATTI della spec, mai variati:** colonne `lancio_slug`, `lancio_fase`, `lancio_ingresso`, `lancio_link_inviato_at`, `lancio_followup_inviato_at`, `lancio_info`; slug `'webdev-2026-10'`; fasi `attesa | posto_bloccato | link_inviato | post_pitch | scelta_fatta | followup_inviato | restituito | chiuso`; ingresso `lista | pulsante_webinar`; chiavi `app_settings` `lancio_zoom_link`, `lancio_video_live_link`, `offerta_del_mese_link`, `lancio_evento_at`, `lancio_attivo`; eventi `event_log` `lancio_intake`, `lancio_posto_bloccato`; env `LANCIO_WELCOME_TEMPLATE_SID` (già in `.env.local`, da mettere anche su Vercel production).
- **Testo fisso del posto bloccato (spec §5.2, verbatim):** `Perfetto, il tuo posto è bloccato. Ti scrivo qui il 5 ottobre con il link per collegarti.`
- **Numero a qualità LOW: in questo blocco l'unico messaggio spontaneo è il benvenuto.** Nessun nudge, nessun touch, nessun promemoria, nessun sollecito verso una conversazione con `lancio_slug` valorizzato e fase non terminale. Il link Zoom (B4) e il follow-up (B5) NON sono in questo piano.
- **La migrazione si applica PRIMA del push su `origin/main`** (la produzione si aggiorna al push: memoria `project_deploy_push_non_automatico`). L'MCP Supabase vede solo il progetto CRM: per la messaggistica (`gosnmagiishkwuvmortj`) si usa il SQL Editor del dashboard via Chrome o la Management API con PAT (memoria `reference_supabase_ddl_senza_pat`). Il metodo è nel Task 1, Step 5.
- **`lib/supabase/types.ts` si aggiorna a mano** (come per `crm_lead_status`): `npm run supabase:gen-types` richiede il PAT.
- **Presidio categoria template (`lib/twilio.ts`, `UTILITY_ONLY=1`):** se Meta approva il benvenuto come MARKETING, il SID va in `UTILITY_ONLY_ALLOW` su Vercel, altrimenti `assertTemplateSendable` blocca l'invio e il lead resta muto (precedente del 24/08).
- **Nessun tag deve mai raggiungere il lead:** `[LANCIO:SI]`, `[LANCIO:DOMANDA]`, `[LANCIO:NO]` e `[PASSAGGIO_UMANO]` si rimuovono in `parseLancioReply`.
- **Mai riusare pezzi di `mario-prompt.ts` nel prompt lancio** (spec §5.2): niente pitch, prezzi, call, video, form.
- **Le risposte lancio partono come UNA bolla** (niente `splitMarioMessages`): il conteggio degli scambi di domande si legge dalle righe `messages` e una risposta spezzata in tre bolle conterebbe tre.
- **Ogni turno lancio scrive `fenice_ai_reply`** anche quando tace: è la traccia che ferma il re-drive di `bot-followups` (conv 3728, 32 ripetizioni).
- **Il campo `lancio` assente nel payload = flusso attuale, byte per byte invariato.**
- Test: `bun run test <file>` (= `vitest run <file>`); tutta la suite: `bun run test`. Typecheck: `bun run typecheck`.
- Ogni task finisce con un commit sul branch di lavoro; il push su `origin/main` è SOLO nel Task 12 dopo la migrazione applicata.

---

## File Structure

| File | Responsabilità |
|---|---|
| `supabase/migrations/20260914000001_lancio_webdev.sql` (nuovo) | Colonne `lancio_*`, indice parziale, seed delle 5 chiavi `app_settings` |
| `lib/supabase/types.ts` (modifica) | Tipi delle colonne nuove su `conversations` |
| `lib/lancio-settings.ts` (nuovo) | Lettura/scrittura delle chiavi `app_settings` del lancio, parser puro |
| `lib/bot-contract.ts` (modifica) | Campo opzionale `lancio` nel payload di intake (contratto v1.6) |
| `lib/lancio-fase.ts` (nuovo) | Costanti (slug, fasi, testi fissi), `lancioInCorso`, `FILTRO_FUORI_LANCIO`, `decideLancioTurno`, `contaScambiDomande`, `lancioFaseLabel`, `lancioBenvenutoText` |
| `lib/lancio-classifica.ts` (nuovo) | `classificaLancio` (regex) e `parseLancioReply` (tag del modello) |
| `lib/lancio-prompt.ts` (nuovo) | `buildLancioSystem` per fase |
| `lib/lancio-reply.ts` (nuovo) | `generateLancioReply`: chiamata al modello col prompt lancio |
| `lib/mario.ts` (modifica) | Esporta `getAnthropicClient` e `MEDIA_SENZA_TESTO` (2 righe) |
| `lib/lancio-db.ts` (nuovo) | `impostaFaseLancio`: update di fase + evento, usata da B1 e da B4/B5 |
| `lib/lancio-turno.ts` (nuovo) | `eseguiTurnoLancio`: I/O del turno (invio, esiti CRM, eventi) |
| `lib/fenice-autoreply.ts` (modifica) | Aggancio del turno lancio nel drain (≈10 righe) |
| `lib/fenice-enroll.ts` (modifica) | Ramo `enrollLancio` in `enrollLeadIntoMario` |
| `app/api/bot/intake/route.ts` (modifica) | Passa `lancio` all'enroll (1 riga) |
| `lib/lancio-aperture.ts` (nuovo) + `app/api/cron/lancio-aperture/route.ts` (nuovo) + `vercel.json` | Ripresa dei benvenuti differiti |
| `lib/bot-followups.ts`, `app/api/cron/{sequence-touches,bot-followups,precall-reminders,gdo-video-followups,riapri-mute}/route.ts` (modifica) | Esclusioni |
| `app/api/chat/conversations/route.ts`, `components/ConversationList.tsx`, `app/(chat)/chat/layout.tsx`, `app/(chat)/chat/[conversationId]/page.tsx` (modifica) | Badge + filtro Lancio in `/chat` |
| `app/(fenice)/fenice/conversazioni/page.tsx`, `.../_components/ConversationsPanel.tsx`, `app/(fenice)/fenice/live/page.tsx`, `.../_components/LivePanel.tsx` (modifica) | Badge + filtro Lancio in `/fenice` |
| `.env.example` (modifica) | Documenta `LANCIO_*_TEMPLATE_SID` |

---

### Task 1: Migrazione SQL, tipi Supabase, applicazione in produzione

**Files:**
- Create: `supabase/migrations/20260914000001_lancio_webdev.sql`
- Modify: `lib/supabase/types.ts:74-194` (blocco `conversations`: `Row`, `Insert`, `Update`)

**Interfaces:**
- Consumes: niente.
- Produces: colonne `conversations.lancio_slug text`, `lancio_fase text`, `lancio_ingresso text`, `lancio_link_inviato_at timestamptz`, `lancio_followup_inviato_at timestamptz`, `lancio_info jsonb`; righe `app_settings` con chiavi `lancio_attivo` (jsonb `false`), `lancio_zoom_link`, `lancio_video_live_link`, `offerta_del_mese_link`, `lancio_evento_at`; indice `conversations_lancio_idx`. Tipi TS: `Database['public']['Tables']['conversations']['Row']` con i sei campi (`string | null` / `Json | null`).

- [ ] **Step 1: Scrivi il file di migrazione**

Crea `supabase/migrations/20260914000001_lancio_webdev.sql`:

```sql
-- Lancio "Web Developer AI" (webinar del 5/10/2026), blocco B1 lato bot.
-- Spec: docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §3.2
--
-- Le conversazioni del lancio restano `ai_owner='mario'` (così i pannelli le vedono da
-- sole) ma vivono in un flusso a fasi tutto loro: `lancio_slug` dice che la chat e' del
-- lancio, `lancio_fase` a che punto e'. I cron di Mario (sequenza, nudge, promemoria,
-- solleciti) le escludono finche' la fase non e' terminale (`chiuso`/`restituito`).

alter table public.conversations
  add column if not exists lancio_slug text,
  add column if not exists lancio_fase text,
  add column if not exists lancio_ingresso text,
  add column if not exists lancio_link_inviato_at timestamptz,
  add column if not exists lancio_followup_inviato_at timestamptz,
  add column if not exists lancio_info jsonb;

comment on column public.conversations.lancio_slug is
  'Identificativo del lancio (es. webdev-2026-10). Valorizzato = la chat e'' del lancio, non del fissaggio di Mario.';
comment on column public.conversations.lancio_fase is
  'attesa | posto_bloccato | link_inviato | post_pitch | scelta_fatta | followup_inviato | restituito | chiuso';
comment on column public.conversations.lancio_ingresso is
  'lista (dalla lista AC 132) | pulsante_webinar (ha scritto lui dal pulsante della live)';
comment on column public.conversations.lancio_link_inviato_at is
  'Quando e'' partito il template col link Zoom (B4). Idempotenza del blast.';
comment on column public.conversations.lancio_followup_inviato_at is
  'Quando e'' partito il follow-up del 6/10 (B5). Base delle 48h di restituzione.';
comment on column public.conversations.lancio_info is
  'Risposte di riscaldamento raccolte la sera del 5 (B4), passate al venditore.';

-- I cron del lancio e i filtri dei pannelli cercano per slug e fase: parziale, resta
-- piccolo (le chat del lancio sono qualche migliaio su decine di migliaia).
create index if not exists conversations_lancio_idx
  on public.conversations (lancio_slug, lancio_fase)
  where lancio_slug is not null;

-- Chiavi impostazioni (§3.2). Valori iniziali, mai sovrascritti se gia'' presenti:
-- Bruno le cambia da /fenice (B5) senza deploy. `lancio_attivo` nasce spento.
insert into public.app_settings (key, value) values
  ('lancio_attivo', 'false'::jsonb),
  ('lancio_zoom_link', '"https://us06web.zoom.us/j/89845223337"'::jsonb),
  ('lancio_video_live_link', '""'::jsonb),
  ('offerta_del_mese_link', '""'::jsonb),
  ('lancio_evento_at', '"2026-10-05T21:00:00+02:00"'::jsonb)
on conflict (key) do nothing;
```

- [ ] **Step 2: Aggiorna i tipi a mano**

In `lib/supabase/types.ts`, nel blocco `conversations`:

Dentro `Row` (dopo `last_message_preview: string | null`, riga ~110):
```ts
          lancio_slug: string | null
          lancio_fase: string | null
          lancio_ingresso: string | null
          lancio_link_inviato_at: string | null
          lancio_followup_inviato_at: string | null
          lancio_info: Json | null
```

Dentro `Insert` (dopo `last_message_preview?: string | null`, riga ~150) e dentro `Update` (dopo `last_message_preview?: string | null`, riga ~190), lo stesso blocco con `?:`:
```ts
          lancio_slug?: string | null
          lancio_fase?: string | null
          lancio_ingresso?: string | null
          lancio_link_inviato_at?: string | null
          lancio_followup_inviato_at?: string | null
          lancio_info?: Json | null
```

Sotto il commento esistente `// NB: tabella aggiunta a mano (migration 20260827000001_crm_lead_status ...` aggiungi una riga:
```ts
      // Colonne `lancio_*` di conversations aggiunte a mano (migration 20260914000001_lancio_webdev).
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (nessun errore: le colonne nuove non sono ancora usate).

- [ ] **Step 4: Commit del file**

```bash
git add supabase/migrations/20260914000001_lancio_webdev.sql lib/supabase/types.ts
git commit -m "feat(lancio): migrazione colonne lancio_* e chiavi app_settings del lancio (B1)"
```

- [ ] **Step 5: Applica la migrazione in produzione (PRIMA del deploy del Task 12)**

Progetto Supabase **App Messaggistica** `gosnmagiishkwuvmortj`. L'MCP Supabase NON lo vede (vede solo il CRM). Due strade, in ordine:

1. **SQL Editor via Chrome** (funziona senza token, sessione già autenticata): apri `https://supabase.com/dashboard/project/gosnmagiishkwuvmortj/sql/new`; l'editor è Monaco: incolla con `window.monaco.editor.getModels()[0].setValue(<contenuto del file .sql>)` (evita auto-indent/auto-close), poi clic su **Run**.
2. **Management API con PAT**: `POST https://api.supabase.com/v1/projects/gosnmagiishkwuvmortj/database/query` con header `Authorization: Bearer $SUPABASE_ACCESS_TOKEN` e body `{"query": "<contenuto del file .sql>"}` (il PAT si crea su supabase.com/dashboard/account/tokens e si revoca dopo).

Verifica (stessa via) con:
```sql
select column_name, data_type from information_schema.columns
 where table_name = 'conversations' and column_name like 'lancio_%' order by column_name;
select key, value from app_settings where key in
 ('lancio_attivo','lancio_zoom_link','lancio_video_live_link','offerta_del_mese_link','lancio_evento_at');
select indexname from pg_indexes where indexname = 'conversations_lancio_idx';
```
Expected: 6 colonne, 5 chiavi (`lancio_attivo` = `false`), 1 indice.

---

### Task 2: Helper `app_settings` del lancio (`lib/lancio-settings.ts`)

**Files:**
- Create: `lib/lancio-settings.ts`
- Test: `lib/lancio-settings.test.ts`

**Interfaces:**
- Consumes: tabella `app_settings (key, value jsonb, updated_at)`; pattern di `lib/fenice-settings.ts`.
- Produces:
  - `LANCIO_SETTING_KEYS: readonly ['lancio_attivo','lancio_zoom_link','lancio_video_live_link','offerta_del_mese_link','lancio_evento_at']`, `type LancioSettingKey`.
  - `type LancioSettings = { attivo: boolean; zoomLink: string | null; videoLiveLink: string | null; offertaDelMeseLink: string | null; eventoAt: string | null }`.
  - `parseLancioSettings(rows: { key: string; value: unknown }[]): LancioSettings` (pura).
  - `isAttivo(value: unknown): boolean` (pura: `true`, `1`, `'1'`, `'true'`, `'on'` → true).
  - `getLancioSettings(supabase): Promise<LancioSettings>`.
  - `setLancioSetting(supabase, key: LancioSettingKey, value: string | boolean): Promise<void>` (la pagina impostazioni di B5 chiama questa).

- [ ] **Step 1: Write the failing test**

Crea `lib/lancio-settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLancioSettings, isAttivo, LANCIO_SETTING_KEYS, LANCIO_SETTINGS_DEFAULT } from './lancio-settings';

describe('isAttivo — la chiave lancio_attivo si legge come 0/1 o booleano', () => {
  it('accende su true, 1, "1", "true", "on"', () => {
    for (const v of [true, 1, '1', 'true', 'on', ' TRUE ']) expect(isAttivo(v)).toBe(true);
  });
  it('spegne su tutto il resto, compresi null e stringa vuota', () => {
    for (const v of [false, 0, '0', 'false', 'off', '', null, undefined, {}]) expect(isAttivo(v)).toBe(false);
  });
});

describe('parseLancioSettings', () => {
  it('senza righe torna i default: spento e link vuoti', () => {
    expect(parseLancioSettings([])).toEqual(LANCIO_SETTINGS_DEFAULT);
  });

  it('legge le cinque chiavi', () => {
    const s = parseLancioSettings([
      { key: 'lancio_attivo', value: true },
      { key: 'lancio_zoom_link', value: 'https://us06web.zoom.us/j/89845223337' },
      { key: 'lancio_video_live_link', value: 'https://corso.feniceacademy.it/live-webdev' },
      { key: 'offerta_del_mese_link', value: 'https://corso.feniceacademy.it/offerta-webdev' },
      { key: 'lancio_evento_at', value: '2026-10-05T21:00:00+02:00' },
    ]);
    expect(s).toEqual({
      attivo: true,
      zoomLink: 'https://us06web.zoom.us/j/89845223337',
      videoLiveLink: 'https://corso.feniceacademy.it/live-webdev',
      offertaDelMeseLink: 'https://corso.feniceacademy.it/offerta-webdev',
      eventoAt: '2026-10-05T21:00:00+02:00',
    });
  });

  it('una stringa vuota o non stringa vale null: mai un link vuoto in un messaggio', () => {
    const s = parseLancioSettings([
      { key: 'lancio_video_live_link', value: '' },
      { key: 'offerta_del_mese_link', value: 42 },
      { key: 'lancio_evento_at', value: '  ' },
    ]);
    expect(s.videoLiveLink).toBeNull();
    expect(s.offertaDelMeseLink).toBeNull();
    expect(s.eventoAt).toBeNull();
  });

  it('chiavi estranee vengono ignorate', () => {
    expect(parseLancioSettings([{ key: 'fenice_ai_autoreply', value: true }]).attivo).toBe(false);
  });

  it('le chiavi sono esattamente quelle della spec §3.2', () => {
    expect([...LANCIO_SETTING_KEYS].sort()).toEqual([
      'lancio_attivo', 'lancio_evento_at', 'lancio_video_live_link', 'lancio_zoom_link', 'offerta_del_mese_link',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/lancio-settings.test.ts`
Expected: FAIL — `Cannot find module './lancio-settings'`.

- [ ] **Step 3: Write minimal implementation**

Crea `lib/lancio-settings.ts`:

```ts
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Le impostazioni del lancio (spec §3.2) vivono in `app_settings`, come
 * `fenice_ai_autoreply`: Bruno le cambia dal pannello (B5) senza deploy, e i link del
 * video della live e dell'offerta esistono solo dopo la sera del 5.
 *
 * `lancio_attivo` e' l'interruttore del blocco B1: spento, l'intake prende in carico il
 * lead ma non manda il benvenuto (lo riprende il cron `lancio-aperture` quando si
 * accende). E' l'unico modo di avere un kill-switch sull'outbound senza perdere lead.
 */
export const LANCIO_SETTING_KEYS = [
  'lancio_attivo',
  'lancio_zoom_link',
  'lancio_video_live_link',
  'offerta_del_mese_link',
  'lancio_evento_at',
] as const;
export type LancioSettingKey = (typeof LANCIO_SETTING_KEYS)[number];

export type LancioSettings = {
  attivo: boolean;
  zoomLink: string | null;
  videoLiveLink: string | null;
  offertaDelMeseLink: string | null;
  eventoAt: string | null;
};

export const LANCIO_SETTINGS_DEFAULT: LancioSettings = {
  attivo: false,
  zoomLink: null,
  videoLiveLink: null,
  offertaDelMeseLink: null,
  eventoAt: null,
};

/** La spec dice `0/1`; il pannello scrivera' un booleano. Si accettano entrambi. */
export function isAttivo(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return ['1', 'true', 'on'].includes(value.trim().toLowerCase());
  return false;
}

function stringaOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

export function parseLancioSettings(rows: { key: string; value: unknown }[]): LancioSettings {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    attivo: isAttivo(byKey.get('lancio_attivo')),
    zoomLink: stringaOrNull(byKey.get('lancio_zoom_link')),
    videoLiveLink: stringaOrNull(byKey.get('lancio_video_live_link')),
    offertaDelMeseLink: stringaOrNull(byKey.get('offerta_del_mese_link')),
    eventoAt: stringaOrNull(byKey.get('lancio_evento_at')),
  };
}

export async function getLancioSettings(supabase: Supa): Promise<LancioSettings> {
  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', [...LANCIO_SETTING_KEYS]);
  return parseLancioSettings((data ?? []) as { key: string; value: unknown }[]);
}

export async function setLancioSetting(
  supabase: Supa,
  key: LancioSettingKey,
  value: string | boolean,
): Promise<void> {
  await supabase
    .from('app_settings')
    .upsert({ key, value: value as never, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/lancio-settings.test.ts`
Expected: PASS (6 test).

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-settings.ts lib/lancio-settings.test.ts
git commit -m "feat(lancio): helper delle impostazioni app_settings del lancio"
```

---

### Task 3: Campo `lancio` nel contratto di intake (`lib/bot-contract.ts`)

**Files:**
- Modify: `lib/bot-contract.ts:1-16` (interfaccia `BotIntakePayload`), `:113-134` (`parseIntakePayload`)
- Test: `lib/bot-contract.test.ts`

**Interfaces:**
- Consumes: `parseIntakePayload(raw)` esistente.
- Produces: `type LancioIngresso = 'lista' | 'pulsante_webinar'`; `interface LancioIntake { slug: string; ingresso: LancioIngresso }`; `parseLancioField(raw: unknown): LancioIntake | null`; `BotIntakePayload.lancio?: LancioIntake | null` (valorizzato da `parseIntakePayload`).

- [ ] **Step 1: Write the failing test**

In `lib/bot-contract.test.ts`, aggiorna l'import e aggiungi in fondo:

```ts
import { parseLancioField } from './bot-contract';

describe('parseIntakePayload — campo lancio (contratto v1.6)', () => {
  const base = { leadId: 'u1', name: 'Anna', phone: '333 123 4567', email: null, funnel: 'Lancio Web Dev AI', companyId: 'fenice' };

  it('senza campo lancio il payload e'' quello di sempre: lancio null', () => {
    const r = parseIntakePayload(base);
    expect(r.ok && r.value.lancio).toBeNull();
  });

  it('con lancio valido lo porta dentro cosi'' com''e''', () => {
    const r = parseIntakePayload({ ...base, lancio: { slug: 'webdev-2026-10', ingresso: 'lista' } });
    expect(r.ok && r.value.lancio).toEqual({ slug: 'webdev-2026-10', ingresso: 'lista' });
  });

  it('pulsante_webinar e'' l''altro ingresso ammesso', () => {
    expect(parseLancioField({ slug: 'webdev-2026-10', ingresso: 'pulsante_webinar' }))
      .toEqual({ slug: 'webdev-2026-10', ingresso: 'pulsante_webinar' });
  });

  it('un ingresso sconosciuto ricade su lista: il lead va comunque arruolato', () => {
    expect(parseLancioField({ slug: 'webdev-2026-10', ingresso: 'boh' })?.ingresso).toBe('lista');
  });

  it('senza slug non e'' un lancio: null, e il resto del payload resta valido', () => {
    expect(parseLancioField({ ingresso: 'lista' })).toBeNull();
    expect(parseLancioField({ slug: '  ' })).toBeNull();
    expect(parseLancioField('webdev-2026-10')).toBeNull();
    expect(parseLancioField(null)).toBeNull();
    const r = parseIntakePayload({ ...base, lancio: 'spazzatura' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.lancio).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/bot-contract.test.ts`
Expected: FAIL — `parseLancioField` non esportata, `lancio` undefined invece di null.

- [ ] **Step 3: Write minimal implementation**

In `lib/bot-contract.ts`, dopo l'interfaccia `PreviousLead` (riga ~22) aggiungi:

```ts
/** Come e' arrivato il lead del lancio: dalla lista AC 132 o dal pulsante della live. */
export type LancioIngresso = 'lista' | 'pulsante_webinar';

/**
 * Contratto v1.6 (spec §6.1): il CRM marca i lead del lancio "Web Developer AI" con
 * questo campo. Assente ⇒ flusso di Mario di sempre, byte per byte. Presente ⇒ il bot
 * manda il benvenuto del lancio invece dell'apertura e la chat entra nel flusso a fasi
 * (`conversations.lancio_*`).
 */
export interface LancioIntake {
  slug: string;
  ingresso: LancioIngresso;
}

/**
 * Letto senza pretese, come `parsePreviousLeads`: un `lancio` malformato non deve mai
 * impedire l'arruolamento — al massimo il lead entra nel flusso normale (slug assente)
 * o con ingresso `lista` (ingresso sconosciuto).
 */
export function parseLancioField(raw: unknown): LancioIntake | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const slug = typeof o.slug === 'string' ? o.slug.trim() : '';
  if (!slug) return null;
  const ingresso: LancioIngresso = o.ingresso === 'pulsante_webinar' ? 'pulsante_webinar' : 'lista';
  return { slug, ingresso };
}
```

In `BotIntakePayload` aggiungi dopo `previousLeadIds?: PreviousLead[];`:
```ts
  /** Lead del lancio (contratto v1.6). Null/assente = flusso normale. */
  lancio?: LancioIntake | null;
```

In `parseIntakePayload`, nell'oggetto `value`, dopo `previousLeadIds: parsePreviousLeads(o.previousLeadIds),` aggiungi:
```ts
      lancio: parseLancioField(o.lancio),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/bot-contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bot-contract.ts lib/bot-contract.test.ts
git commit -m "feat(lancio): campo opzionale lancio nel contratto di intake (v1.6)"
```

---

### Task 4: Modulo puro delle fasi (`lib/lancio-fase.ts`)

**Files:**
- Create: `lib/lancio-fase.ts`
- Test: `lib/lancio-fase.test.ts`

**Interfaces:**
- Consumes: `templateName`, `firstNameOf` da `lib/name.ts`.
- Produces (tutto puro, usato da Task 5-11 e da B4/B5):
  - `LANCIO_SLUG = 'webdev-2026-10'`; `LANCIO_FASI` (tupla delle 8 fasi); `type LancioFase`; `isLancioFase(v): v is LancioFase`; `LANCIO_FASI_TERMINALI = ['chiuso','restituito']`; `LANCIO_FASI_B1 = ['attesa','posto_bloccato']`.
  - `lancioInCorso(c: { lancio_slug?: string|null; lancio_fase?: string|null }): boolean`.
  - `FILTRO_FUORI_LANCIO = 'lancio_slug.is.null,lancio_fase.in.(chiuso,restituito)'` — da passare a `.or(...)` di PostgREST.
  - `TESTO_POSTO_BLOCCATO`, `TESTO_CONGEDO`, `TESTO_CHIUSURA_DOMANDE`, `TESTO_PASSAGGIO_UMANO`, `MAX_SCAMBI_DOMANDE = 3`.
  - `type ClasseLancio = 'si' | 'no' | 'domanda' | 'incerto'`.
  - `type LancioAzione = { kind:'posto_bloccato'; testo } | { kind:'congedo'; testo } | { kind:'domanda'; chiudi: boolean } | { kind:'passaggio_umano' } | { kind:'silenzio'; motivo: 'gia_bloccato'|'domande_esaurite'|'fase_non_gestita'|'classe_incerta' }`.
  - `decideLancioTurno(i: { fase: string|null; classe: ClasseLancio; scambiDomande: number; passToHuman: boolean }): LancioAzione`.
  - `contaScambiDomande(rows: { direction: string; body: string | null; template_sid: string | null }[]): number`.
  - `lancioFaseLabel(fase: string | null): string` (etichette per i badge).
  - `lancioBenvenutoText(name?: string | null): string` (corpo del template 1, per la riga `messages`).

- [ ] **Step 1: Write the failing test**

Crea `lib/lancio-fase.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  LANCIO_SLUG, LANCIO_FASI, LANCIO_FASI_TERMINALI, FILTRO_FUORI_LANCIO, MAX_SCAMBI_DOMANDE,
  TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO,
  isLancioFase, lancioInCorso, decideLancioTurno, contaScambiDomande, lancioFaseLabel, lancioBenvenutoText,
} from './lancio-fase';

describe('costanti della spec §3.2 / §5.2', () => {
  it('slug e fasi con i nomi esatti', () => {
    expect(LANCIO_SLUG).toBe('webdev-2026-10');
    expect([...LANCIO_FASI]).toEqual([
      'attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato', 'restituito', 'chiuso',
    ]);
    expect(isLancioFase('attesa')).toBe(true);
    expect(isLancioFase('boh')).toBe(false);
  });

  it('il testo del posto bloccato e'' quello della spec, verbatim', () => {
    expect(TESTO_POSTO_BLOCCATO).toBe('Perfetto, il tuo posto è bloccato. Ti scrivo qui il 5 ottobre con il link per collegarti.');
  });

  it('i testi fissi non contengono link, prezzi o inviti a una call', () => {
    for (const t of [TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO]) {
      expect(t).not.toMatch(/https?:\/\//);
      expect(t).not.toMatch(/€|euro|call|videochiamata|appuntamento/i);
    }
  });
});

describe('lancioInCorso — quando la chat e'' del lancio e va tenuta fuori da Mario', () => {
  it('senza slug non e'' del lancio', () => {
    expect(lancioInCorso({ lancio_slug: null, lancio_fase: null })).toBe(false);
    expect(lancioInCorso({})).toBe(false);
  });
  it('con slug e fase non terminale e'' in corso', () => {
    for (const fase of ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato']) {
      expect(lancioInCorso({ lancio_slug: LANCIO_SLUG, lancio_fase: fase })).toBe(true);
    }
  });
  it('chiuso e restituito rendono la chat di nuovo di Mario (o del GDO)', () => {
    for (const fase of LANCIO_FASI_TERMINALI) {
      expect(lancioInCorso({ lancio_slug: LANCIO_SLUG, lancio_fase: fase })).toBe(false);
    }
  });
  it('il filtro PostgREST dice la stessa cosa al contrario', () => {
    expect(FILTRO_FUORI_LANCIO).toBe('lancio_slug.is.null,lancio_fase.in.(chiuso,restituito)');
  });
});

describe('decideLancioTurno — fase attesa', () => {
  const base = { fase: 'attesa', scambiDomande: 0, passToHuman: false } as const;

  it('si'' → posto bloccato col testo fisso', () => {
    expect(decideLancioTurno({ ...base, classe: 'si' })).toEqual({ kind: 'posto_bloccato', testo: TESTO_POSTO_BLOCCATO });
  });
  it('no → congedo col testo fisso', () => {
    expect(decideLancioTurno({ ...base, classe: 'no' })).toEqual({ kind: 'congedo', testo: TESTO_CONGEDO });
  });
  it('domanda → risponde il modello, senza chiudere', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda' })).toEqual({ kind: 'domanda', chiudi: false });
  });
  it('al terzo scambio di domande risponde e chiude con "ci sentiamo il 5"', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda', scambiDomande: MAX_SCAMBI_DOMANDE - 1 }))
      .toEqual({ kind: 'domanda', chiudi: true });
  });
  it('dopo tre scambi tace fino al link', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda', scambiDomande: MAX_SCAMBI_DOMANDE }))
      .toEqual({ kind: 'silenzio', motivo: 'domande_esaurite' });
  });
  it('incerto senza modello → silenzio, mai una risposta a caso', () => {
    expect(decideLancioTurno({ ...base, classe: 'incerto' })).toEqual({ kind: 'silenzio', motivo: 'classe_incerta' });
  });
  it('la richiesta di una persona vince su tutto', () => {
    expect(decideLancioTurno({ ...base, classe: 'si', passToHuman: true })).toEqual({ kind: 'passaggio_umano' });
  });
});

describe('decideLancioTurno — fase posto_bloccato', () => {
  const base = { fase: 'posto_bloccato', scambiDomande: 0, passToHuman: false } as const;
  it('un secondo si'' non riceve un secondo "posto bloccato"', () => {
    expect(decideLancioTurno({ ...base, classe: 'si' })).toEqual({ kind: 'silenzio', motivo: 'gia_bloccato' });
  });
  it('le domande si rispondono ancora, col solito tetto', () => {
    expect(decideLancioTurno({ ...base, classe: 'domanda' })).toEqual({ kind: 'domanda', chiudi: false });
    expect(decideLancioTurno({ ...base, classe: 'domanda', scambiDomande: 3 }).kind).toBe('silenzio');
  });
  it('un no dopo il posto bloccato e'' comunque un congedo', () => {
    expect(decideLancioTurno({ ...base, classe: 'no' }).kind).toBe('congedo');
  });
});

describe('decideLancioTurno — fasi che B1 non gestisce', () => {
  it('link_inviato, post_pitch ecc. sono di B4/B5: qui silenzio, mai il pitch di Mario', () => {
    for (const fase of ['link_inviato', 'post_pitch', 'scelta_fatta', 'followup_inviato']) {
      expect(decideLancioTurno({ fase, classe: 'domanda', scambiDomande: 0, passToHuman: false }))
        .toEqual({ kind: 'silenzio', motivo: 'fase_non_gestita' });
    }
  });
});

describe('contaScambiDomande — quante risposte a domande sono gia'' uscite', () => {
  const out = (body: string, template_sid: string | null = null) => ({ direction: 'out', body, template_sid });
  const inb = (body: string) => ({ direction: 'in', body, template_sid: null });

  it('il benvenuto (template) e i testi fissi non contano', () => {
    expect(contaScambiDomande([
      out('Ciao Anna, sono l\'assistente...', 'HX_WELCOME'),
      inb('si'),
      out(TESTO_POSTO_BLOCCATO),
    ])).toBe(0);
  });
  it('ogni risposta libera del bot vale uno scambio', () => {
    expect(contaScambiDomande([
      out('benvenuto', 'HX_WELCOME'),
      inb('e\' a pagamento?'), out('No, e\' gratuita.'),
      inb('a che ora?'), out('Alle 21, il link ti arriva qui.'),
    ])).toBe(2);
  });
  it('la risposta con la chiusura in coda conta uno, non due', () => {
    expect(contaScambiDomande([out(`Sì, su Zoom.\n${TESTO_CHIUSURA_DOMANDE}`)])).toBe(1);
  });
  it('body nullo (media) non conta', () => {
    expect(contaScambiDomande([{ direction: 'out', body: null, template_sid: null }])).toBe(0);
  });
});

describe('etichette e benvenuto', () => {
  it('lancioFaseLabel ha un''etichetta per ogni fase e un ripiego', () => {
    for (const f of LANCIO_FASI) expect(lancioFaseLabel(f)).not.toBe('');
    expect(lancioFaseLabel('attesa')).toBe('In attesa');
    expect(lancioFaseLabel('posto_bloccato')).toBe('Posto bloccato');
    expect(lancioFaseLabel(null)).toBe('Lancio');
  });
  it('lancioBenvenutoText usa il solo nome proprio e il vocativo neutro senza nome', () => {
    expect(lancioBenvenutoText('ANNA BIANCHI')).toMatch(/^Ciao Anna, sono l'assistente virtuale di Fenice Academy\./);
    expect(lancioBenvenutoText(null)).toMatch(/^Ciao a te, /);
    expect(lancioBenvenutoText('Anna')).toContain('per bloccare il posto.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/lancio-fase.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Write minimal implementation**

Crea `lib/lancio-fase.ts`:

```ts
import { templateName } from './name';

/**
 * Lancio "Web Developer AI" (webinar 5/10/2026): stato, fasi e decisioni del turno.
 * Modulo PURO: niente env, niente DB, niente rete. Le costanti sono quelle della spec
 * (docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §3.2, §5.2).
 */

export const LANCIO_SLUG = 'webdev-2026-10';

export const LANCIO_FASI = [
  'attesa', 'posto_bloccato', 'link_inviato', 'post_pitch',
  'scelta_fatta', 'followup_inviato', 'restituito', 'chiuso',
] as const;
export type LancioFase = (typeof LANCIO_FASI)[number];

export function isLancioFase(v: unknown): v is LancioFase {
  return typeof v === 'string' && (LANCIO_FASI as readonly string[]).includes(v);
}

/** Con queste fasi il lancio e' finito per quella chat: torna a Mario (o al GDO). */
export const LANCIO_FASI_TERMINALI: readonly LancioFase[] = ['chiuso', 'restituito'];

/** Le fasi che questo blocco (B1) sa gestire nel turno. Le altre arrivano con B4/B5. */
export const LANCIO_FASI_B1: readonly LancioFase[] = ['attesa', 'posto_bloccato'];

/** La chat e' del lancio e il lancio non e' finito: Mario e i suoi cron stanno fuori. */
export function lancioInCorso(c: { lancio_slug?: string | null; lancio_fase?: string | null }): boolean {
  if (!c.lancio_slug) return false;
  return !(LANCIO_FASI_TERMINALI as readonly string[]).includes(c.lancio_fase ?? '');
}

/**
 * Lo stesso criterio di `lancioInCorso`, al contrario e in sintassi PostgREST, per le
 * query dei cron: `query.or(FILTRO_FUORI_LANCIO)`. Piu' `.or()` sulla stessa query si
 * sommano in AND, quindi si puo' aggiungere a query che ne hanno gia' uno.
 */
export const FILTRO_FUORI_LANCIO = 'lancio_slug.is.null,lancio_fase.in.(chiuso,restituito)';

// Testi fissi (spec §5.2). Il primo e' verbatim dalla spec; gli altri seguono le stesse
// regole: niente link, niente prezzi, niente inviti a una call.
export const TESTO_POSTO_BLOCCATO =
  'Perfetto, il tuo posto è bloccato. Ti scrivo qui il 5 ottobre con il link per collegarti.';
export const TESTO_CONGEDO =
  'Va bene, grazie per avermelo detto: non ti scrivo più per questo evento. Buona giornata!';
export const TESTO_CHIUSURA_DOMANDE = 'Ci sentiamo il 5!';
export const TESTO_PASSAGGIO_UMANO = 'Certo, ti faccio contattare da una persona del team.';

/** Dopo tre scambi di domande il bot chiude e tace fino al link (spec §5.2). */
export const MAX_SCAMBI_DOMANDE = 3;

export type ClasseLancio = 'si' | 'no' | 'domanda' | 'incerto';

export type LancioAzione =
  | { kind: 'posto_bloccato'; testo: string }
  | { kind: 'congedo'; testo: string }
  | { kind: 'domanda'; chiudi: boolean }
  | { kind: 'passaggio_umano' }
  | { kind: 'silenzio'; motivo: 'gia_bloccato' | 'domande_esaurite' | 'fase_non_gestita' | 'classe_incerta' };

/**
 * Cosa fare in questo turno, data la fase e la classe del messaggio del lead.
 * `scambiDomande` = risposte a domande gia' uscite in questa chat (vedi
 * `contaScambiDomande`): alla terza si chiude, dalla quarta si tace.
 */
export function decideLancioTurno(i: {
  fase: string | null;
  classe: ClasseLancio;
  scambiDomande: number;
  passToHuman: boolean;
}): LancioAzione {
  if (i.passToHuman) return { kind: 'passaggio_umano' };
  if (!(LANCIO_FASI_B1 as readonly string[]).includes(i.fase ?? '')) {
    return { kind: 'silenzio', motivo: 'fase_non_gestita' };
  }
  if (i.classe === 'no') return { kind: 'congedo', testo: TESTO_CONGEDO };
  if (i.classe === 'si') {
    return i.fase === 'posto_bloccato'
      ? { kind: 'silenzio', motivo: 'gia_bloccato' }
      : { kind: 'posto_bloccato', testo: TESTO_POSTO_BLOCCATO };
  }
  if (i.classe === 'domanda') {
    if (i.scambiDomande >= MAX_SCAMBI_DOMANDE) return { kind: 'silenzio', motivo: 'domande_esaurite' };
    return { kind: 'domanda', chiudi: i.scambiDomande === MAX_SCAMBI_DOMANDE - 1 };
  }
  return { kind: 'silenzio', motivo: 'classe_incerta' };
}

const TESTI_FISSI = new Set([TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_PASSAGGIO_UMANO]);

/**
 * Le risposte a domande gia' uscite: gli outbound liberi (senza template) che non sono
 * uno dei testi fissi. Si legge dalle righe `messages` invece che da un contatore:
 * nessuna colonna in piu', e il conto resta giusto anche se un turno muore a meta'.
 * Per questo le risposte lancio partono come UNA bolla (mai `splitMarioMessages`).
 */
export function contaScambiDomande(
  rows: { direction: string; body: string | null; template_sid: string | null }[],
): number {
  return rows.filter((m) =>
    m.direction === 'out' && m.template_sid == null && !!m.body && !TESTI_FISSI.has(m.body.trim()),
  ).length;
}

const FASE_LABEL: Record<LancioFase, string> = {
  attesa: 'In attesa',
  posto_bloccato: 'Posto bloccato',
  link_inviato: 'Link inviato',
  post_pitch: 'Dopo il pitch',
  scelta_fatta: 'Scelta fatta',
  followup_inviato: 'Follow-up inviato',
  restituito: 'Restituito',
  chiuso: 'Chiuso',
};

/** Etichetta per i badge dei pannelli. */
export function lancioFaseLabel(fase: string | null): string {
  return isLancioFase(fase) ? FASE_LABEL[fase] : 'Lancio';
}

/** Corpo del template 1 (spec §7, testo approvato da Bruno il 14/09) con {{1}} risolto:
 *  e' quello che finisce nella riga `messages` per i pannelli. */
export function lancioBenvenutoText(name?: string | null): string {
  return (
    `Ciao ${templateName(name)}, sono l'assistente virtuale di Fenice Academy. Complimenti per esserti iscritto ` +
    "alla lista d'attesa dell'evento del 5 ottobre: ti invieremo il link per collegarti alla live " +
    'direttamente qui su WhatsApp il giorno stesso. Rispondi a questo messaggio se sei realmente ' +
    'interessato, per bloccare il posto.'
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/lancio-fase.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-fase.ts lib/lancio-fase.test.ts
git commit -m "feat(lancio): modulo puro delle fasi, testi fissi e decisione del turno"
```

---

### Task 5: Classificatore deterministico e parser dei tag (`lib/lancio-classifica.ts`)

**Files:**
- Create: `lib/lancio-classifica.ts`
- Test: `lib/lancio-classifica.test.ts`

**Interfaces:**
- Consumes: `ClasseLancio` da `lib/lancio-fase.ts`; `sanitizeOutbound` da `lib/outbound-sanitize.ts`.
- Produces: `classificaLancio(body: string | null | undefined): ClasseLancio` (regex, prima del modello); `type LancioReplyParsed = { classe: 'si' | 'no' | 'domanda'; passToHuman: boolean; visibleReply: string }`; `parseLancioReply(raw: string): LancioReplyParsed` (tag `[LANCIO:SI]`, `[LANCIO:DOMANDA]`, `[LANCIO:NO]`, `[PASSAGGIO_UMANO]`; senza tag ⇒ `domanda`).

- [ ] **Step 1: Write the failing test**

Crea `lib/lancio-classifica.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classificaLancio, parseLancioReply } from './lancio-classifica';

describe('classificaLancio — il si'' che blocca il posto', () => {
  it.each(['sì', 'si', 'Si!', 'ok', 'Ok grazie', 'certo', 'confermo', 'sono interessato', 'interessata', 'ci sono', 'ci sarò', 'va bene', 'perfetto', 'bloccami il posto', 'ci sto'])(
    '"%s" → si', (b) => expect(classificaLancio(b)).toBe('si'),
  );
  it('un si'' lungo piu'' di sei parole non e'' piu'' un si'' secco: decide il modello', () => {
    expect(classificaLancio('si ma non so se riesco quella sera perche lavoro fino tardi')).toBe('incerto');
  });
});

describe('classificaLancio — il no che congeda', () => {
  it.each(['no', 'No grazie', 'non mi interessa', 'non sono interessata', 'toglietemi dalla lista', 'cancellatemi', 'basta messaggi', 'STOP', 'non voglio più ricevere messaggi', 'lasciatemi in pace', 'numero sbagliato', 'non mi sono mai iscritto'])(
    '"%s" → no', (b) => expect(classificaLancio(b)).toBe('no'),
  );
  it('"non vedo l\'ora" NON e'' un no', () => {
    expect(classificaLancio("non vedo l'ora!")).not.toBe('no');
  });
});

describe('classificaLancio — la domanda', () => {
  it.each(['è a pagamento?', 'Quanto costa', 'a che ora inizia', 'come mi collego?', 'sì, ma è gratis?', 'serve installare zoom?', 'posso partecipare dal telefono'])(
    '"%s" → domanda', (b) => expect(classificaLancio(b)).toBe('domanda'),
  );
  it('un punto di domanda vince sul si'': "si ma quanto dura?" e'' una domanda', () => {
    expect(classificaLancio('si ma quanto dura?')).toBe('domanda');
  });
});

describe('classificaLancio — incerto va al modello', () => {
  it.each(['', '   ', 'boh', 'vediamo', 'ne parlo con mio marito', 'chi sei', 'ok ma poi come funziona per il resto'])(
    '"%s" → incerto o domanda, mai si''/no', (b) => expect(['incerto', 'domanda']).toContain(classificaLancio(b)),
  );
  it('media senza testo → incerto', () => {
    expect(classificaLancio(null)).toBe('incerto');
    expect(classificaLancio(undefined)).toBe('incerto');
  });
});

describe('parseLancioReply — i tag del modello', () => {
  it('[LANCIO:SI] → classe si, tag rimosso', () => {
    const r = parseLancioReply('Che bello! [LANCIO:SI]');
    expect(r.classe).toBe('si');
    expect(r.visibleReply).toBe('Che bello!');
  });
  it('[LANCIO:NO] → classe no', () => {
    expect(parseLancioReply('Capisco. [LANCIO:NO]').classe).toBe('no');
  });
  it('[LANCIO:DOMANDA] → classe domanda col testo visibile', () => {
    const r = parseLancioReply('È gratuita, tranquillo. [LANCIO:DOMANDA]');
    expect(r).toEqual({ classe: 'domanda', passToHuman: false, visibleReply: 'È gratuita, tranquillo.' });
  });
  it('senza tag → domanda: il modello ha risposto qualcosa, si manda', () => {
    expect(parseLancioReply('Alle 21, su Zoom.').classe).toBe('domanda');
  });
  it('[PASSAGGIO_UMANO] resta possibile e non finisce al lead', () => {
    const r = parseLancioReply('Certo, ti faccio contattare. [PASSAGGIO_UMANO] [LANCIO:DOMANDA]');
    expect(r.passToHuman).toBe(true);
    expect(r.visibleReply).toBe('Certo, ti faccio contattare.');
  });
  it('minuscole e tag in mezzo al testo: comunque puliti', () => {
    const r = parseLancioReply('[lancio:si] Perfetto, ci sei.');
    expect(r.classe).toBe('si');
    expect(r.visibleReply).toBe('Perfetto, ci sei.');
  });
  it('un tag di Mario finito per sbaglio nel testo non arriva al lead', () => {
    expect(parseLancioReply('Ok [ESITO:SCARTO|x] [LANCIO:NO]').visibleReply).toBe('Ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/lancio-classifica.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Write minimal implementation**

Crea `lib/lancio-classifica.ts`:

```ts
import type { ClasseLancio } from './lancio-fase';
import { sanitizeOutbound } from './outbound-sanitize';

/**
 * Classificazione deterministica del messaggio del lead nella fase di attesa (spec §5.2):
 * le regex decidono i casi netti, il modello (con i tag) decide il resto. L'ordine
 * conta: un no vince su tutto, un punto di domanda vince su un si'.
 */

function normalizza(body: string): string {
  return body
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}?']+/gu, ' ')
    .trim();
}

const NO_SECCO = /^(no|nope|nah|no grazie|no grazie!?)$/;
const NO_FRASI = new RegExp(
  '\\b(' +
    [
      'non (mi|ci) interessa', 'non sono interessat[oa]', "non e per me", 'non fa per me',
      'togli(mi|etemi|temi)', 'cancell(ami|atemi)', 'rimuov(imi|etemi)', 'elimin(ami|atemi)',
      'non (mi )?scriv(ere|ete|etemi|ermi)( piu)?', 'non voglio( piu)?( ricevere)?', 'basta( messaggi)?', 'stop',
      'lasciat?e?mi (in pace|stare)', 'lasciami (in pace|stare)', 'numero sbagliato', 'sbagliato numero',
      'non (mi sono|ho) (mai )?iscritt[oa]', 'disiscriv', 'annulla(re|te)? (l )?iscrizione',
    ].join('|') +
    ')\\b',
);

const SI_PAROLE = new RegExp(
  '\\b(' +
    [
      'si', 'ok', 'okay', 'okey', 'certo', 'certamente', 'confermo', 'confermato', 'interessat[oa]',
      'ci sono', 'ci saro', 'va bene', 'vabene', 'vabbene', 'perfetto', 'assolutamente', 'volentieri',
      'presente', 'bloccalo', 'blocca(mi)? il posto', 'prenotami', 'ci sto', 'sono dentro', "d'accordo", 'daccordo',
    ].join('|') +
    ')\\b',
);
const NEGAZIONE = /\b(non|nessun[oa]?|mai)\b/;
const MAX_PAROLE_SI = 6;

const DOMANDA_INIZIO = new RegExp(
  '^(' +
    [
      'quanto', 'quando', 'dove', 'come', 'cosa', 'che', 'chi', 'perche', 'quale', 'quali',
      'a che ora', 'e a pagamento', 'costa', 'prezzo', 'gratis', 'gratuito', 'link', 'zoom',
      'posso', 'si puo', 'serve', 'devo', 'bisogna', 'mi spieghi', 'mi dici',
    ].join('|') +
    ')\\b',
);

export function classificaLancio(body: string | null | undefined): ClasseLancio {
  const raw = (body ?? '').trim();
  if (!raw) return 'incerto';
  const t = normalizza(raw);
  if (!t) return 'incerto';

  if (NO_SECCO.test(t) || NO_FRASI.test(t)) return 'no';
  if (t.includes('?') || DOMANDA_INIZIO.test(t)) return 'domanda';

  const parole = t.split(/\s+/).filter(Boolean);
  if (parole.length <= MAX_PAROLE_SI && SI_PAROLE.test(t) && !NEGAZIONE.test(t)) return 'si';

  return 'incerto';
}

export type LancioReplyParsed = {
  classe: 'si' | 'no' | 'domanda';
  passToHuman: boolean;
  visibleReply: string;
};

const LANCIO_TAG_RE = /\[LANCIO:(SI|DOMANDA|NO)\]/i;
const LANCIO_TAG_ALL_RE = /\[LANCIO:(SI|DOMANDA|NO)\]/gi;
/** Qualsiasi altro tag tecnico fra parentesi quadre (anche uno di Mario uscito per
 *  sbaglio, es. `[ESITO:SCARTO|x]`: i due punti fanno parte del nome). */
const ALTRI_TAG_RE = /\[[A-Z_:]+(?:\|[^\]]*)?\]/g;

/**
 * Legge i tag del modello lancio e li toglie dal testo. Senza tag la classe e'
 * `domanda`: il modello ha comunque scritto una risposta, e si manda quella.
 */
export function parseLancioReply(raw: string): LancioReplyParsed {
  const m = raw.match(LANCIO_TAG_RE);
  const kind = m ? m[1].toUpperCase() : 'DOMANDA';
  const classe: LancioReplyParsed['classe'] = kind === 'SI' ? 'si' : kind === 'NO' ? 'no' : 'domanda';
  const passToHuman = raw.includes('[PASSAGGIO_UMANO]');
  const visibleReply = sanitizeOutbound(
    raw
      .replace(LANCIO_TAG_ALL_RE, '')
      .replace(/\[PASSAGGIO_UMANO\]/g, '')
      .replace(ALTRI_TAG_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
  return { classe, passToHuman, visibleReply };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/lancio-classifica.test.ts`
Expected: PASS. Se un caso `it.each` fallisce, aggiusta la regex corrispondente (non il test): i testi del test sono frasi vere che i lead scrivono.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-classifica.ts lib/lancio-classifica.test.ts
git commit -m "feat(lancio): classificatore regex si/no/domanda e parser dei tag [LANCIO:*]"
```

---

### Task 6: Prompt lancio e generatore (`lib/lancio-prompt.ts`, `lib/lancio-reply.ts`)

**Files:**
- Create: `lib/lancio-prompt.ts`, `lib/lancio-reply.ts`
- Modify: `lib/mario.ts:96-103` (esporta `getAnthropicClient`), `:117-120` (esporta `MEDIA_SENZA_TESTO`)
- Test: `lib/lancio-prompt.test.ts`, `lib/lancio-reply.test.ts`

**Interfaces:**
- Consumes: `formatRomeDateTime`, `romeNowContext` da `lib/rome-time.ts`; `firstNameOf` da `lib/name.ts`; `MARIO_MODEL`, `MarioTurn` da `lib/mario.ts`; `parseLancioReply` dal Task 5.
- Produces:
  - `type LancioPromptInput = { fase: string | null; nome: string | null; eventoAt: string | null }`; `buildLancioSystem(i: LancioPromptInput): string`.
  - `generateLancioReply(history: MarioTurn[], opts: LancioPromptInput & { now?: Date }): Promise<LancioReplyParsed>`.
  - In `lib/mario.ts`: `export function getAnthropicClient(): Anthropic`, `export const MEDIA_SENZA_TESTO`.
  - Per B4/B5: `buildLancioSystem` è il punto dove aggiungere le sezioni delle fasi `link_inviato` (assistenza) e `post_pitch` (scelta): un `switch` su `i.fase`.

- [ ] **Step 1: Write the failing tests**

Crea `lib/lancio-prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildLancioSystem } from './lancio-prompt';

const base = { fase: 'attesa', nome: 'ANNA BIANCHI', eventoAt: '2026-10-05T21:00:00+02:00' };

describe('buildLancioSystem — fase attesa', () => {
  const s = buildLancioSystem(base);

  it('si dichiara assistente virtuale (AI Act art. 50) e usa il solo nome proprio', () => {
    expect(s).toMatch(/assistente virtuale/i);
    expect(s).toContain('Anna');
    expect(s).not.toContain('BIANCHI');
  });
  it('dice data e ora della live in italiano', () => {
    expect(s).toContain('lunedì 5 ottobre alle 21:00');
  });
  it('gratuito, niente prezzi, "ne parliamo dopo la live"', () => {
    expect(s).toMatch(/gratuit/i);
    expect(s).toMatch(/prezzi non li dici mai/i);
    expect(s).toMatch(/ne parliamo dopo la live/i);
  });
  it('spiega i tre tag e il passaggio umano', () => {
    for (const tag of ['[LANCIO:SI]', '[LANCIO:NO]', '[LANCIO:DOMANDA]', '[PASSAGGIO_UMANO]']) expect(s).toContain(tag);
  });
  it('non contiene nulla del prompt di Mario: jotform, quote, call, video', () => {
    expect(s).not.toMatch(/jotform|1\.000|3\.000|noemi|conferenza-|form\.jotform/i);
    expect(s).toMatch(/Non proporre MAI una chiamata, una call, un video, un modulo/);
  });
});

describe('buildLancioSystem — fase posto_bloccato e ripieghi', () => {
  it('in posto_bloccato dice al modello che il posto e'' gia'' bloccato', () => {
    expect(buildLancioSystem({ ...base, fase: 'posto_bloccato' })).toMatch(/GIÀ confermato/);
    expect(buildLancioSystem(base)).not.toMatch(/GIÀ confermato/);
  });
  it('senza nome usabile non inventa un nome', () => {
    const s = buildLancioSystem({ ...base, nome: 'azienda srl' });
    expect(s).toContain('una persona');
  });
  it('senza data in impostazioni usa il 5 ottobre alle 21', () => {
    expect(buildLancioSystem({ ...base, eventoAt: null })).toContain('lunedì 5 ottobre alle 21:00');
    expect(buildLancioSystem({ ...base, eventoAt: 'boh' })).toContain('lunedì 5 ottobre alle 21:00');
  });
});
```

Crea `lib/lancio-reply.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn();
vi.mock('./mario', () => ({
  MARIO_MODEL: 'claude-sonnet-4-6',
  MEDIA_SENZA_TESTO: '[il lead ha inviato un contenuto senza testo]',
  getAnthropicClient: () => ({ messages: { create } }),
}));

import { generateLancioReply } from './lancio-reply';

beforeEach(() => { create.mockReset(); });

describe('generateLancioReply', () => {
  it('manda il system del lancio (non quello di Mario) e parsa i tag', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'È gratuita. [LANCIO:DOMANDA]' }] });
    const r = await generateLancioReply(
      [{ role: 'assistant', content: 'benvenuto' }, { role: 'user', content: 'costa?' }],
      { fase: 'attesa', nome: 'Anna', eventoAt: null, now: new Date('2026-09-20T10:00:00Z') },
    );
    expect(r).toEqual({ classe: 'domanda', passToHuman: false, visibleReply: 'È gratuita.' });
    const params = create.mock.calls[0][0];
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.system).toMatch(/assistente virtuale di Fenice Academy/);
    expect(params.system).not.toMatch(/jotform/i);
    expect(params.system).toMatch(/Adesso in Italia è/);
    expect(params.messages).toEqual([
      { role: 'assistant', content: 'benvenuto' }, { role: 'user', content: 'costa?' },
    ]);
  });

  it('un turno del lead senza testo diventa il segnaposto, mai una richiesta vuota', async () => {
    create.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Ciao! [LANCIO:DOMANDA]' }] });
    await generateLancioReply([{ role: 'user', content: '' }], { fase: 'attesa', nome: null, eventoAt: null });
    expect(create.mock.calls[0][0].messages).toEqual([{ role: 'user', content: '[il lead ha inviato un contenuto senza testo]' }]);
  });

  it('risposta senza blocco testo → domanda con testo vuoto (chi chiama decide di tacere)', async () => {
    create.mockResolvedValueOnce({ content: [] });
    const r = await generateLancioReply([{ role: 'user', content: 'ok?' }], { fase: 'attesa', nome: null, eventoAt: null });
    expect(r.visibleReply).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test lib/lancio-prompt.test.ts lib/lancio-reply.test.ts`
Expected: FAIL — moduli inesistenti.

- [ ] **Step 3: Write minimal implementation**

In `lib/mario.ts`: dopo la funzione `getClient` (riga ~103) aggiungi
```ts
/** Il client condiviso, per gli altri generatori (lancio) che usano lo stesso modello. */
export function getAnthropicClient(): Anthropic {
  return getClient();
}
```
e cambia `const MEDIA_SENZA_TESTO =` in `export const MEDIA_SENZA_TESTO =`.

Crea `lib/lancio-prompt.ts`:

```ts
import { firstNameOf } from './name';
import { formatRomeDateTime } from './rome-time';

/**
 * System prompt del lancio "Web Developer AI", SEPARATO da mario-prompt.ts (spec §5.2):
 * qui non esistono pitch, quote, call, video, form. Il modello risponde alle domande
 * pratiche e classifica il messaggio con un tag; le frasi decisive (posto bloccato,
 * congedo) le manda il codice, non il modello.
 */

export type LancioPromptInput = {
  fase: string | null;
  nome: string | null;
  eventoAt: string | null;
};

const QUANDO_DEFAULT = 'lunedì 5 ottobre alle 21:00';

function quandoLive(eventoAt: string | null): string {
  if (!eventoAt || Number.isNaN(Date.parse(eventoAt))) return QUANDO_DEFAULT;
  return formatRomeDateTime(eventoAt);
}

export function buildLancioSystem(i: LancioPromptInput): string {
  const quando = quandoLive(i.eventoAt);
  const nome = firstNameOf(i.nome);
  const conChi = nome ? nome : 'una persona';
  const statoPosto =
    i.fase === 'posto_bloccato'
      ? 'Il lead ha GIÀ confermato: il suo posto è bloccato. Non chiederglielo di nuovo e non ripeterglielo se non te lo chiede.'
      : 'Il lead non ha ancora confermato di voler partecipare. Se dalla sua frase capisci che vuole esserci usa il tag [LANCIO:SI]; se capisci che non gli interessa usa [LANCIO:NO].';

  return `IDENTITÀ
Sei l'assistente virtuale di Fenice Academy (un'intelligenza artificiale: se te lo chiedono lo dici senza giri di parole). Scrivi su WhatsApp con ${conChi}, che si è iscritta alla lista d'attesa della live "Web Developer AI" di Fenice Academy, che si tiene online su Zoom ${quando}.

COSA DEVI FARE
Il tuo unico obiettivo adesso è confermare l'interesse per la live e rispondere alle domande pratiche. Nient'altro.
${statoPosto}

COSA SAI (e non una parola di più)
- La live è TOTALMENTE GRATUITA. Se chiedono se è a pagamento o quanto costa: l'evento è gratuito; la sera stessa presentiamo le opportunità dell'accademia Fenice, ma i prezzi non li dici MAI, né cifre né fasce, nemmeno "circa".
- Logistica: si tiene ${quando}, online su Zoom; il link per collegarsi arriva qui su WhatsApp il giorno stesso, poco prima dell'inizio. Basta un telefono o un computer con internet, non serve installare niente in anticipo.
- Fenice Academy è una scuola di formazione per le professioni digitali, con sede a Torino, attiva dal 2020.
- Su tutto il resto (contenuti, durata, sbocchi, docenti, iscrizione, garanzie, certificazioni, cosa succede dopo) rispondi che ne parliamo dopo la live: la live è fatta apposta per rispondere.

COME SCRIVI
- Una o due righe al massimo, tono cordiale e diretto, niente elenchi, niente emoji in serie.
- Non proporre MAI una chiamata, una call, un video, un modulo, un link o un appuntamento: prima della live non esiste nient'altro.
- Non inventare informazioni su Fenice Academy, sulla live o sui relatori.
- Se il lead chiede esplicitamente di parlare con una persona, rispondi in una riga che lo farai contattare e chiudi il messaggio con [PASSAGGIO_UMANO].

TAG TECNICI (il lead non li vede mai, vanno in fondo al messaggio)
- [LANCIO:SI] se la persona conferma che vuole partecipare (sì, ok, ci sono, interessato...).
- [LANCIO:NO] se dice che non le interessa, che vuole essere tolta dalla lista o che non vuole più messaggi.
- [LANCIO:DOMANDA] in tutti gli altri casi: hai risposto a una domanda o a un commento.
Esattamente UN tag [LANCIO:...] per messaggio, sempre. Quando usi [LANCIO:SI] o [LANCIO:NO] il testo che scrivi viene sostituito da una frase fissa: metti comunque una riga cortese, ma non promettere niente.`;
}
```

Crea `lib/lancio-reply.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient, MARIO_MODEL, MEDIA_SENZA_TESTO, type MarioTurn } from './mario';
import { buildLancioSystem, type LancioPromptInput } from './lancio-prompt';
import { parseLancioReply, type LancioReplyParsed } from './lancio-classifica';
import { romeNowContext } from './rome-time';

/**
 * La risposta del modello nel flusso lancio. Stesso modello e stesso client di Mario,
 * prompt tutto suo. Nessun blocco slot, nessun `bookingDays`: qui non si fissa niente.
 * Le due regole sui turni vuoti sono le stesse di `generateMarioReply` (un turno user
 * vuoto rompe la richiesta con 400, un turno assistant vuoto non ha nulla da dire).
 */
export async function generateLancioReply(
  history: MarioTurn[],
  opts: LancioPromptInput & { now?: Date },
): Promise<LancioReplyParsed> {
  const turni = history.flatMap((t) => {
    if (typeof t.content === 'string' && t.content.trim() !== '') return [t];
    if (t.role === 'user') return [{ role: 'user' as const, content: MEDIA_SENZA_TESTO }];
    return [];
  });
  const messages = turni.length > 0 ? turni : [{ role: 'user' as const, content: MEDIA_SENZA_TESTO }];
  const now = opts.now ?? new Date();
  const system = `${buildLancioSystem(opts)}\n\n${romeNowContext(now)}`;

  const response = await getAnthropicClient().messages.create({
    model: MARIO_MODEL,
    max_tokens: 400,
    thinking: { type: 'disabled' },
    system,
    messages,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && 'text' in textBlock ? textBlock.text : '';
  return parseLancioReply(raw);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test lib/lancio-prompt.test.ts lib/lancio-reply.test.ts lib/mario.test.ts lib/mario-parse.test.ts`
Expected: PASS (i test di Mario restano verdi: solo due export in più).

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-prompt.ts lib/lancio-reply.ts lib/lancio-prompt.test.ts lib/lancio-reply.test.ts lib/mario.ts
git commit -m "feat(lancio): prompt della fase di attesa e generatore col modello, separati da Mario"
```

---

### Task 7: Intake lancio (`enrollLeadIntoMario` ramo lancio + route)

**Files:**
- Modify: `lib/fenice-enroll.ts:12-19` (`EnrollArgs`), `:29-37` (ingresso di `enrollLeadIntoMario`), nuova funzione `enrollLancio` in coda al file
- Modify: `app/api/bot/intake/route.ts:96-102` (chiamata a `enrollLeadIntoMario`)
- Test: `lib/fenice-enroll.test.ts`

**Interfaces:**
- Consumes: `LancioIntake` (Task 3); `getLancioSettings` (Task 2); `lancioBenvenutoText` (Task 4); `apertutaDaFermare`, `findOrCreateLeadConversation`, `sendTemplateAndLog`, `inOpeningWindow`, `templateName` esistenti.
- Produces: `EnrollArgs.lancio?: LancioIntake | null`. Con `lancio` valorizzato `enrollLeadIntoMario` ritorna la stessa forma di sempre (`{ ok, conversationId, sid?, error?, deferred?, duplicato? }`), scrive `lancio_slug`, `lancio_fase='attesa'`, `lancio_ingresso` e l'evento `event_log` `lancio_intake` (payload `{ phone, conversationId, crmLeadId, slug, ingresso, duplicato?, differita?: 'lancio_spento'|'fuori_fascia', sid?, ok?, error? }`). Env richiesta: `LANCIO_WELCOME_TEMPLATE_SID`.

- [ ] **Step 1: Write the failing test**

In `lib/fenice-enroll.test.ts`, sotto il `vi.mock('./messaging', ...)` aggiungi:

```ts
vi.mock('./lancio-settings', () => ({
  getLancioSettings: vi.fn(async () => ({ attivo: true, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: null })),
}));
import { getLancioSettings } from './lancio-settings';
import { lancioBenvenutoText } from './lancio-fase';
```

E in fondo al file:

```ts
describe('enrollLeadIntoMario — ramo lancio (B1)', () => {
  const LANCIO = { slug: 'webdev-2026-10', ingresso: 'lista' as const };
  const ARGS = { phone: '+393331234567', firstName: 'ANNA BIANCHI', crmLeadId: 'crm-L1', crmFunnel: 'Lancio Web Dev AI', lancio: LANCIO };

  beforeEach(() => {
    vi.setSystemTime(MEZZOGIORNO);
    vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', 'HX_LANCIO_WELCOME');
    vi.stubEnv('NEW_OPENING_ENABLED', '1'); // anche col flag A/B acceso il lancio non passa dalle aperture C/T/J
    vi.mocked(getLancioSettings).mockResolvedValue({ attivo: true, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: null });
  });

  it('manda il template di benvenuto del lancio, non un''apertura di Mario/Marta', async () => {
    const { supabase, calls } = makeSupabase();
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 42, sid: 'SM_TEST' });
    const call = vi.mocked(sendTemplateAndLog).mock.calls[0];
    expect(call.slice(1, 6)).toEqual([42, '+393331234567', 'HX_LANCIO_WELCOME', 'Lancio benvenuto', 'whatsapp:+390000000000']);
    expect(call[6]).toEqual({ '1': 'Anna' });
    expect(call[7]).toBe(lancioBenvenutoText('ANNA BIANCHI'));
    expect(calls.events.some((e) => e.type === 'opening_config_error')).toBe(false);
  });

  it('scrive lancio_slug, lancio_fase=attesa, lancio_ingresso e l''evento lancio_intake', async () => {
    const { supabase, calls } = makeSupabase();
    await enrollLeadIntoMario(supabase, ARGS);
    expect(calls.updates[0]).toMatchObject({
      ai_owner: 'mario', ai_status: 'active', crm_lead_id: 'crm-L1', crm_funnel: 'Lancio Web Dev AI',
      lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista',
    });
    const evt = calls.events.find((e) => e.type === 'lancio_intake');
    expect(evt).toBeTruthy();
    expect(evt.payload).toMatchObject({ crmLeadId: 'crm-L1', conversationId: 42, slug: 'webdev-2026-10', ingresso: 'lista', ok: true });
  });

  it('con lancio_attivo spento prende in carico ma NON manda: differita, la riprende il cron lancio', async () => {
    vi.mocked(getLancioSettings).mockResolvedValueOnce({ attivo: false, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: null });
    const { supabase, calls } = makeSupabase();
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 42, deferred: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.updates[0]).toMatchObject({ lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa' });
    expect(calls.events.find((e) => e.type === 'lancio_intake').payload.differita).toBe('lancio_spento');
    expect(calls.events.some((e) => e.type === 'fenice_enroll_deferred')).toBe(false);
  });

  it('nel cuore della notte e'' differita per fascia, come le aperture', async () => {
    vi.setSystemTime(NOTTE_FONDA);
    const { supabase, calls } = makeSupabase();
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.deferred).toBe(true);
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.events.find((e) => e.type === 'lancio_intake').payload.differita).toBe('fuori_fascia');
  });

  it('conversazione viva (ha scritto 3 giorni fa): niente secondo benvenuto, ma lancio_* valorizzati e duplicato:true', async () => {
    const treGiorniFa = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { supabase, calls } = makeSupabaseLeggibile({ crmLeadId: 'crm-VECCHIO', outboundRecenti: 0, lastInboundAt: treGiorniFa });
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res).toMatchObject({ ok: true, conversationId: 42, duplicato: true });
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
    expect(calls.updates[0]).toMatchObject({
      lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', lancio_ingresso: 'lista', crm_lead_id: 'crm-L1', ai_owner: 'mario',
    });
    expect('ai_started_at' in calls.updates[0]).toBe(false); // la cronologia della chat viva non si azzera
    expect(calls.events.find((e) => e.type === 'lancio_intake').payload).toMatchObject({ duplicato: true, motivo: 'conversazione_viva' });
  });

  it('template non configurato → errore esplicito, nessun invio', async () => {
    vi.stubEnv('LANCIO_WELCOME_TEMPLATE_SID', '');
    const { supabase } = makeSupabase();
    await expect(enrollLeadIntoMario(supabase, ARGS)).rejects.toThrow(/LANCIO_WELCOME_TEMPLATE_SID/);
    expect(sendTemplateAndLog).not.toHaveBeenCalled();
  });

  it('invio fallito → ok:false, event send_error e lancio_intake con l''errore', async () => {
    vi.mocked(sendTemplateAndLog).mockResolvedValueOnce({ ok: false, error: 'template bloccato: categoria MARKETING con UTILITY_ONLY attivo' });
    const { supabase, calls } = makeSupabase();
    const res = await enrollLeadIntoMario(supabase, ARGS);
    expect(res.ok).toBe(false);
    expect(calls.events.some((e) => e.type === 'send_error' && e.level === 'error')).toBe(true);
    expect(calls.events.find((e) => e.type === 'lancio_intake').payload.ok).toBe(false);
  });

  it('senza campo lancio il flusso di sempre non cambia (nessuna lettura delle impostazioni)', async () => {
    const { supabase } = makeSupabase();
    await enrollLeadIntoMario(supabase, { phone: '+393331234567', firstName: 'Anna', crmFunnel: 'CORSO 10 ORE' });
    expect(getLancioSettings).not.toHaveBeenCalled();
    expect(vi.mocked(sendTemplateAndLog).mock.calls[0][3]).not.toBe('HX_LANCIO_WELCOME');
  });
});
```

Nota: `makeSupabaseLeggibile` esiste già più in basso nel file; se il `describe` nuovo viene messo PRIMA della sua definizione va bene lo stesso (function hoisting). Il fake `makeSupabase` gestisce `update(...).eq(...)` come Promise: il secondo `update({ ai_status: 'active' }).eq(...).or(...)` del ramo duplicato richiede di aggiungere `or` allo stub: in `makeSupabase` e `makeSupabaseLeggibile` cambia `update(payload) { calls.updates.push(payload); return { eq() { return Promise.resolve({}); } }; }` in

```ts
update(payload: any) {
  calls.updates.push(payload);
  const chain: any = { eq: () => chain, or: () => chain, then: (r: any) => r({}) };
  return chain;
},
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/fenice-enroll.test.ts`
Expected: FAIL — il ramo lancio manda `HX_OPENING`/`OPENING_SID_C2` invece di `HX_LANCIO_WELCOME`, nessun `lancio_intake`.

- [ ] **Step 3: Write minimal implementation**

In `lib/fenice-enroll.ts`:

Import in testa:
```ts
import type { GdoVariant, LancioIntake } from './bot-contract';
import { getLancioSettings } from './lancio-settings';
import { lancioBenvenutoText } from './lancio-fase';
```
(sostituisce `import type { GdoVariant } from './bot-contract';`).

In `EnrollArgs` aggiungi:
```ts
  /** Lead del lancio (contratto v1.6): benvenuto del lancio al posto dell'apertura. */
  lancio?: LancioIntake | null;
```

Definisci il tipo di ritorno una volta (sopra `enrollLeadIntoMario`):
```ts
export type EnrollResult = {
  ok: boolean; conversationId: number; sid?: string; error?: string; deferred?: boolean; duplicato?: boolean;
};
```
e cambia la firma in `): Promise<EnrollResult> {`.

Come PRIMA riga del corpo di `enrollLeadIntoMario` (prima della lettura di `FENICE_OPENING_TEMPLATE_SID`):
```ts
  // Lead del lancio: un flusso a parte, con il suo template e le sue fasi. Sta prima di
  // tutto il resto perche' nessuna delle regole di Mario (A/B delle aperture, funnel
  // C/T/J, sequenza) deve poter toccare questi lead.
  if (args.lancio) return enrollLancio(supabase, { ...args, lancio: args.lancio });
```

In coda al file aggiungi:

```ts
/**
 * Arruolamento di un lead del lancio "Web Developer AI" (spec §5.1).
 *
 * Differenze dal flusso di Mario, tutte volute:
 * - il primo messaggio e' il template di benvenuto del lancio, l'UNICO messaggio
 *   preimpostato che questo blocco manda (il numero e' a qualita' LOW);
 * - la guardia anti-doppione viene PRIMA della finestra: una chat gia' viva non riceve
 *   un secondo benvenuto nemmeno differito, ma entra comunque nel flusso lancio
 *   (`lancio_*` valorizzati) e la cronologia non si azzera;
 * - fuori dalla fascia 07-23, o con `lancio_attivo` spento, il lead e' preso in carico
 *   senza outbound: lo riprende il cron `lancio-aperture`, NON `sequence-touches`
 *   (che queste chat le esclude).
 */
async function enrollLancio(
  supabase: Supa,
  args: EnrollArgs & { lancio: LancioIntake },
): Promise<EnrollResult> {
  const templateSid = process.env.LANCIO_WELCOME_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    throw new Error('LANCIO_WELCOME_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati');
  }

  const firstName = args.firstName ?? undefined;
  const { conversationId } = await findOrCreateLeadConversation(supabase, {
    phone: args.phone,
    firstName,
    lastName: args.lastName ?? undefined,
    email: args.email ?? undefined,
  });

  const lancioFields = {
    lancio_slug: args.lancio.slug,
    lancio_fase: 'attesa',
    lancio_ingresso: args.lancio.ingresso,
  };
  const base = { phone: args.phone, conversationId, crmLeadId: args.crmLeadId ?? null, slug: args.lancio.slug, ingresso: args.lancio.ingresso };
  const evento = (extra: Record<string, unknown>, message: string) =>
    supabase.from('event_log').insert({
      type: 'lancio_intake',
      payload: { ...base, ...extra } as never,
      message,
      level: 'info',
    });

  const guardia = args.crmLeadId ? await apertutaDaFermare(supabase, conversationId) : null;
  if (guardia) {
    await supabase.from('conversations')
      .update({ ...lancioFields, ai_owner: 'mario', crm_lead_id: args.crmLeadId ?? null, crm_funnel: args.crmFunnel ?? null })
      .eq('id', conversationId);
    // Una chat chiusa (o mai governata) torna attiva; una booked/handed_off resta a chi ce l'ha in mano.
    await supabase.from('conversations')
      .update({ ai_status: 'active' })
      .eq('id', conversationId)
      .or('ai_status.is.null,ai_status.eq.closed');
    await evento({ duplicato: true, motivo: guardia }, `[lancio] lead ${args.crmLeadId}: chat gia' viva (${guardia}), nessun benvenuto, entra nel flusso lancio`);
    return { ok: true, conversationId, duplicato: true };
  }

  const convUpdate = {
    ai_owner: 'mario',
    ai_status: 'active',
    ai_started_at: new Date().toISOString(),
    crm_lead_id: args.crmLeadId ?? null,
    crm_funnel: args.crmFunnel ?? null,
    ...lancioFields,
  };

  const settings = await getLancioSettings(supabase);
  const differita = !settings.attivo ? 'lancio_spento' : !inOpeningWindow(Date.now()) ? 'fuori_fascia' : null;
  if (differita) {
    await supabase.from('conversations').update(convUpdate).eq('id', conversationId);
    await evento({ differita }, `[lancio] lead ${args.crmLeadId ?? args.phone} preso in carico, benvenuto differito (${differita})`);
    return { ok: true, conversationId, deferred: true };
  }

  const res = await sendTemplateAndLog(
    supabase, conversationId, args.phone, templateSid, 'Lancio benvenuto', from,
    { '1': templateName(firstName) }, lancioBenvenutoText(firstName),
  );
  await supabase.from('conversations').update(convUpdate).eq('id', conversationId);

  if (!res.ok) {
    await supabase.from('event_log').insert({
      type: 'send_error',
      payload: { ...base, error: res.error } as never,
      message: `[lancio] benvenuto fallito per ${args.phone}: ${res.error}`,
      level: 'error',
    });
  }
  await evento(
    { sid: res.sid ?? null, ok: res.ok, error: res.error ?? null },
    res.ok ? `[lancio] benvenuto inviato a ${args.phone}` : `[lancio] benvenuto NON partito per ${args.phone}`,
  );
  return { ok: res.ok, conversationId, sid: res.sid, error: res.error };
}
```

In `app/api/bot/intake/route.ts`, nella chiamata a `enrollLeadIntoMario` (riga ~96) aggiungi la riga:
```ts
      lancio: p.lancio ?? null,
```
dopo `crmFunnel: p.funnel,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test lib/fenice-enroll.test.ts && bun run typecheck`
Expected: PASS su tutti i test (vecchi e nuovi), typecheck pulito.

- [ ] **Step 5: Commit**

```bash
git add lib/fenice-enroll.ts lib/fenice-enroll.test.ts app/api/bot/intake/route.ts
git commit -m "feat(lancio): intake con benvenuto del lancio, differita e chat viva senza secondo benvenuto"
```

---

### Task 8: Il turno lancio (`lib/lancio-db.ts`, `lib/lancio-turno.ts`) e l'aggancio nel drain

**Files:**
- Create: `lib/lancio-db.ts`, `lib/lancio-turno.ts`
- Modify: `lib/fenice-autoreply.ts:267-268` (select del claim), `:330-353` (lettura della riga), `:382-387` (subito dopo `inboundBody`/`videoGiaInviato`)
- Test: `lib/lancio-turno.test.ts`, `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Consumes: Task 4, 5, 6; `sendFreeText` (`lib/twilio.ts`); `sendOutcome` (`lib/bot-outcome.ts`); `getLancioSettings` (Task 2).
- Produces:
  - `impostaFaseLancio(supabase, conversationId: number, fase: LancioFase, campi?: { lancio_link_inviato_at?: string; lancio_followup_inviato_at?: string; lancio_info?: Json }): Promise<void>` — scrive la fase (+ campi) e l'evento `lancio_fase_cambiata` `{ conversationId, fase, ...campi }`. **B4 e B5 la usano per `link_inviato`, `post_pitch`, `scelta_fatta`, `followup_inviato`, `restituito`.**
  - `eseguiTurnoLancio(supabase, i: TurnoLancioInput): Promise<'active' | 'closed' | 'handed_off'>` con `TurnoLancioInput = { conversationId; phone; from; crmLeadId: string|null; fase: string|null; nome: string|null; rows: { direction; body; template_sid }[]; inboundBody: string; genera?: typeof generateLancioReply; settings?: LancioSettings }`.
  - Eventi: `lancio_posto_bloccato`, `lancio_congedo`, `lancio_domanda`, `lancio_silenzio`, `fenice_ai_reply` (con `lancio: true`).
  - Nel drain: `drainMarioReplies` legge `lancio_slug, lancio_fase` nel claim e, se `lancioInCorso`, delega il round a `eseguiTurnoLancio` ed esce dal loop.

- [ ] **Step 1: Write the failing tests**

Crea `lib/lancio-turno.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./twilio', () => ({ sendFreeText: vi.fn(async () => ({ sid: 'SM_L', status: 'queued' })) }));
vi.mock('./bot-outcome', () => ({ sendOutcome: vi.fn(async () => ({ sent: true })) }));
vi.mock('./lancio-settings', () => ({
  getLancioSettings: vi.fn(async () => ({ attivo: true, zoomLink: null, videoLiveLink: null, offertaDelMeseLink: null, eventoAt: '2026-10-05T21:00:00+02:00' })),
}));

import { eseguiTurnoLancio } from './lancio-turno';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { TESTO_POSTO_BLOCCATO, TESTO_CONGEDO, TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO } from './lancio-fase';

type Row = { direction: string; body: string | null; template_sid: string | null };
const WELCOME: Row = { direction: 'out', body: 'Ciao Anna, sono l\'assistente virtuale...', template_sid: 'HX_W' };
const inb = (body: string): Row => ({ direction: 'in', body, template_sid: null });
const outLibero = (body: string): Row => ({ direction: 'out', body, template_sid: null });

function makeSupabase() {
  const calls = { convUpdates: [] as any[], events: [] as any[], messages: [] as any[] };
  const supabase: any = {
    from(table: string) {
      if (table === 'conversations') {
        return { update(p: any) { calls.convUpdates.push(p); const c: any = { eq: () => c, then: (r: any) => r({ data: null, error: null }) }; return c; } };
      }
      if (table === 'messages') return { insert(p: any) { calls.messages.push(p); return Promise.resolve({ data: null }); } };
      return { insert(p: any) { calls.events.push(p); return Promise.resolve({ data: null }); } };
    },
  };
  return { supabase, calls };
}

const genera = vi.fn();
const base = (over: Partial<Parameters<typeof eseguiTurnoLancio>[1]> = {}) => ({
  conversationId: 42, phone: '+393331234567', from: 'whatsapp:+390000000000', crmLeadId: 'crm-L1',
  fase: 'attesa', nome: 'Anna', rows: [WELCOME, inb('si')], inboundBody: 'si', genera, ...over,
});

beforeEach(() => { vi.clearAllMocks(); genera.mockReset(); });

describe('eseguiTurnoLancio — si''', () => {
  it('manda il testo fisso, passa a posto_bloccato, scrive gli eventi; il modello non si chiama', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base());
    expect(stato).toBe('active');
    expect(genera).not.toHaveBeenCalled();
    expect(vi.mocked(sendFreeText).mock.calls[0][0]).toMatchObject({ to: '+393331234567', body: TESTO_POSTO_BLOCCATO });
    expect(calls.messages[0]).toMatchObject({ conversation_id: 42, direction: 'out', body: TESTO_POSTO_BLOCCATO, sender: 'bot' });
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'posto_bloccato')).toBe(true);
    expect(calls.events.some((e) => e.type === 'lancio_posto_bloccato')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply' && e.payload.lancio === true)).toBe(true);
    expect(sendOutcome).not.toHaveBeenCalled();
  });

  it('un secondo si'' in posto_bloccato: silenzio, ma la traccia fenice_ai_reply c''e'' (anti re-drive)', async () => {
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'posto_bloccato', rows: [WELCOME, inb('si'), outLibero(TESTO_POSTO_BLOCCATO), inb('ok')], inboundBody: 'ok' }));
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'gia_bloccato')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply')).toBe(true);
  });
});

describe('eseguiTurnoLancio — no', () => {
  it('congedo fisso, fase chiuso, DA_SCARTARE al CRM con discardReason "non interessato", stato closed', async () => {
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('non mi interessa')], inboundBody: 'non mi interessa' }));
    expect(stato).toBe('closed');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_CONGEDO);
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'chiuso')).toBe(true);
    expect(vi.mocked(sendOutcome).mock.calls[0].slice(1)).toEqual([42, expect.objectContaining({
      outcome: 'DA_SCARTARE', discardReason: 'non interessato', leadWords: 'non mi interessa',
    })]);
    expect(calls.events.some((e) => e.type === 'lancio_congedo')).toBe(true);
  });

  it('se il CRM non risponde la conversazione resta active (ritentabile), il congedo e'' comunque partito', async () => {
    vi.mocked(sendOutcome).mockResolvedValueOnce({ sent: false, error: 'http_500' });
    const { supabase } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('no')], inboundBody: 'no' }));
    expect(stato).toBe('active');
    expect(sendFreeText).toHaveBeenCalledTimes(1);
  });

  it('senza crmLeadId (arruolamento a mano) niente esito: chiude e basta', async () => {
    const { supabase } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ crmLeadId: null, rows: [WELCOME, inb('no')], inboundBody: 'no' }));
    expect(stato).toBe('closed');
    expect(sendOutcome).not.toHaveBeenCalled();
  });
});

describe('eseguiTurnoLancio — domanda', () => {
  it('chiama il modello con la fase e la data della live e manda UNA bolla col testo pulito', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'È gratuita.\nIl link ti arriva qui il 5.' });
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('è a pagamento?')], inboundBody: 'è a pagamento?' }));
    expect(genera).toHaveBeenCalledTimes(1);
    expect(genera.mock.calls[0][0]).toEqual([{ role: 'assistant', content: WELCOME.body }, { role: 'user', content: 'è a pagamento?' }]);
    expect(genera.mock.calls[0][1]).toMatchObject({ fase: 'attesa', nome: 'Anna', eventoAt: '2026-10-05T21:00:00+02:00' });
    expect(sendFreeText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('È gratuita.\nIl link ti arriva qui il 5.');
    expect(calls.events.some((e) => e.type === 'lancio_domanda')).toBe(true);
    expect(calls.convUpdates.some((u) => 'lancio_fase' in u)).toBe(false); // una domanda non cambia fase
  });

  it('un messaggio incerto va al modello, che con [LANCIO:SI] fa scattare il posto bloccato (testo fisso, non il suo)', async () => {
    genera.mockResolvedValueOnce({ classe: 'si', passToHuman: false, visibleReply: 'Che bello!' });
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('non vedo l\'ora')], inboundBody: "non vedo l'ora" }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_POSTO_BLOCCATO);
    expect(calls.convUpdates.some((u) => u.lancio_fase === 'posto_bloccato')).toBe(true);
  });

  it('alla terza risposta aggiunge "Ci sentiamo il 5!" nella stessa bolla', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: 'Sì, dal telefono va benissimo.' });
    const { supabase } = makeSupabase();
    const rows = [WELCOME, inb('costa?'), outLibero('No.'), inb('a che ora?'), outLibero('Alle 21.'), inb('posso dal telefono?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'posso dal telefono?' }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(`Sì, dal telefono va benissimo.\n${TESTO_CHIUSURA_DOMANDE}`);
  });

  it('dalla quarta domanda tace fino al link: niente modello, niente invio, traccia scritta', async () => {
    const { supabase, calls } = makeSupabase();
    const rows = [WELCOME, inb('a?'), outLibero('1'), inb('b?'), outLibero('2'), inb('c?'), outLibero(`3\n${TESTO_CHIUSURA_DOMANDE}`), inb('d?')];
    await eseguiTurnoLancio(supabase, base({ rows, inboundBody: 'd?' }));
    expect(genera).not.toHaveBeenCalled();
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'domande_esaurite')).toBe(true);
    expect(calls.events.some((e) => e.type === 'fenice_ai_reply')).toBe(true);
  });

  it('il modello risponde vuoto → silenzio registrato, non una bolla vuota', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: false, visibleReply: '' });
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('come?')], inboundBody: 'come?' }));
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'risposta_vuota')).toBe(true);
  });
});

describe('eseguiTurnoLancio — passaggio umano', () => {
  it('[PASSAGGIO_UMANO] → CONTATTO_UMANO al CRM con le parole del lead, handed_off', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: true, visibleReply: 'Certo, ti faccio contattare.' });
    const { supabase, calls } = makeSupabase();
    const stato = await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('voglio parlare con una persona')], inboundBody: 'voglio parlare con una persona' }));
    expect(stato).toBe('handed_off');
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe('Certo, ti faccio contattare.');
    expect(vi.mocked(sendOutcome).mock.calls[0][2]).toMatchObject({ outcome: 'CONTATTO_UMANO', note: 'voglio parlare con una persona' });
    expect(calls.convUpdates.some((u) => u.handed_off_at && u.handed_off_reason === 'voglio parlare con una persona')).toBe(true);
  });

  it('senza testo del modello usa la frase fissa di passaggio', async () => {
    genera.mockResolvedValueOnce({ classe: 'domanda', passToHuman: true, visibleReply: '' });
    const { supabase } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ rows: [WELCOME, inb('mi chiamate?')], inboundBody: 'mi chiamate?' }));
    expect(vi.mocked(sendFreeText).mock.calls[0][0].body).toBe(TESTO_PASSAGGIO_UMANO);
  });
});

describe('eseguiTurnoLancio — fasi di B4/B5', () => {
  it('link_inviato: silenzio con motivo fase_non_gestita, mai il pitch', async () => {
    const { supabase, calls } = makeSupabase();
    await eseguiTurnoLancio(supabase, base({ fase: 'link_inviato', rows: [WELCOME, inb('codice?')], inboundBody: 'codice?' }));
    expect(sendFreeText).not.toHaveBeenCalled();
    expect(genera).not.toHaveBeenCalled();
    expect(calls.events.some((e) => e.type === 'lancio_silenzio' && e.payload.motivo === 'fase_non_gestita')).toBe(true);
  });
});
```

In `lib/fenice-autoreply.test.ts`, sotto i `vi.mock` esistenti aggiungi:

```ts
vi.mock('./lancio-turno', () => ({ eseguiTurnoLancio: vi.fn(async () => 'active') }));
import { eseguiTurnoLancio } from './lancio-turno';
```

Nel tipo `ClaimedRow` (riga ~250) aggiungi `lancio_slug?: string | null; lancio_fase?: string | null;`. Poi in fondo al file:

```ts
describe('drainMarioReplies — aggancio del turno lancio', () => {
  const WELCOME: FakeMsgRow = { direction: 'out', body: 'benvenuto lancio', template_sid: 'HX_W', created_at: '2026-09-20T10:00:00Z' };
  const SI: FakeMsgRow = { direction: 'in', body: 'si', template_sid: null, created_at: '2026-09-20T10:05:00Z' };

  beforeEach(() => {
    vi.stubEnv('TWILIO_WHATSAPP_NUMBER_FENICE', 'whatsapp:+390000000000');
    vi.mocked(generateMarioReply).mockReset();
    vi.mocked(eseguiTurnoLancio).mockClear();
  });

  it('con un lancio in corso il round lo fa eseguiTurnoLancio: Mario non viene interpellato', async () => {
    const { supabase, calls } = makeDrainSupabase(
      { id: 42, ai_started_at: '2026-09-20T09:00:00Z', crm_lead_id: 'crm-L1', gdo_agenda_at: null, gdo_video_url: null, gdo_video_sent_at: null,
        lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa', leads: { first_name: 'Anna' } } as any,
      [WELCOME, SI],
    );
    await drainMarioReplies(supabase, 42, '+393331234567', () => 0);
    expect(eseguiTurnoLancio).toHaveBeenCalledTimes(1);
    expect(vi.mocked(eseguiTurnoLancio).mock.calls[0][1]).toMatchObject({
      conversationId: 42, phone: '+393331234567', crmLeadId: 'crm-L1', fase: 'attesa', nome: 'Anna', inboundBody: 'si',
    });
    expect(generateMarioReply).not.toHaveBeenCalled();
    expect(calls.finalStatusWrites).toEqual(['active']);
  });

  it('lo stato finale e'' quello che il turno lancio restituisce', async () => {
    vi.mocked(eseguiTurnoLancio).mockResolvedValueOnce('closed');
    const { supabase, calls } = makeDrainSupabase(
      { id: 43, ai_started_at: '2026-09-20T09:00:00Z', crm_lead_id: 'crm-L2', gdo_agenda_at: null, gdo_video_url: null, gdo_video_sent_at: null,
        lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa' } as any,
      [WELCOME, { ...SI, body: 'no' }],
    );
    await drainMarioReplies(supabase, 43, '+393331234567', () => 0);
    expect(calls.finalStatusWrites).toEqual(['closed']);
  });

  it('lancio chiuso: torna Mario di sempre', async () => {
    vi.mocked(generateMarioReply).mockResolvedValueOnce({ visibleReply: 'ciao', appointmentFixed: false, passToHuman: false, videoWatched: false } as any);
    const { supabase } = makeDrainSupabase(
      { id: 44, ai_started_at: '2026-09-20T09:00:00Z', crm_lead_id: 'crm-L3', gdo_agenda_at: null, gdo_video_url: null, gdo_video_sent_at: null,
        lancio_slug: 'webdev-2026-10', lancio_fase: 'chiuso' } as any,
      [WELCOME, SI],
    );
    await drainMarioReplies(supabase, 44, '+393331234567', () => 0);
    expect(eseguiTurnoLancio).not.toHaveBeenCalled();
    expect(generateMarioReply).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test lib/lancio-turno.test.ts lib/fenice-autoreply.test.ts`
Expected: FAIL — `./lancio-turno` inesistente; nel drain Mario viene chiamato anche col lancio in corso.

- [ ] **Step 3: Write minimal implementation**

Crea `lib/lancio-db.ts`:

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import type { Json } from './supabase/types';
import type { LancioFase } from './lancio-fase';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Cambio di fase di una chat del lancio: un update e una traccia. E' l'unico punto che
 * scrive `lancio_fase`, cosi' la storia di ogni chat si ricostruisce da `event_log`
 * (`lancio_fase_cambiata`) senza interpretare gli altri eventi. B4 (link, post_pitch,
 * scelta) e B5 (follow-up, restituzione) passano da qui.
 */
export async function impostaFaseLancio(
  supabase: Supa,
  conversationId: number,
  fase: LancioFase,
  campi: { lancio_link_inviato_at?: string; lancio_followup_inviato_at?: string; lancio_info?: Json } = {},
): Promise<void> {
  const { error } = await supabase
    .from('conversations')
    .update({ lancio_fase: fase, ...campi })
    .eq('id', conversationId);
  await supabase.from('event_log').insert({
    type: error ? 'lancio_fase_non_scritta' : 'lancio_fase_cambiata',
    payload: { conversationId, fase, ...campi, ...(error ? { errore: error.message } : {}) } as never,
    message: error
      ? `[lancio] conv ${conversationId}: fase ${fase} NON scritta — ${error.message}`
      : `[lancio] conv ${conversationId}: fase → ${fase}`,
    level: error ? 'error' : 'info',
  });
}
```

Crea `lib/lancio-turno.ts`:

```ts
import type { getSupabaseAdmin } from './supabase/admin';
import type { MarioTurn } from './mario';
import { sendFreeText } from './twilio';
import { sendOutcome } from './bot-outcome';
import { getLancioSettings, type LancioSettings } from './lancio-settings';
import { generateLancioReply } from './lancio-reply';
import { classificaLancio, type LancioReplyParsed } from './lancio-classifica';
import {
  contaScambiDomande, decideLancioTurno, MAX_SCAMBI_DOMANDE, TESTO_CHIUSURA_DOMANDE, TESTO_PASSAGGIO_UMANO,
  type ClasseLancio,
} from './lancio-fase';
import { impostaFaseLancio } from './lancio-db';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type TurnoLancioInput = {
  conversationId: number;
  phone: string;
  from: string;
  crmLeadId: string | null;
  fase: string | null;
  nome: string | null;
  rows: { direction: string; body: string | null; template_sid: string | null }[];
  inboundBody: string;
  /** Iniettabile nei test: di default il modello col prompt lancio. */
  genera?: typeof generateLancioReply;
  settings?: LancioSettings;
};

/**
 * Un turno della chat del lancio nella fase di attesa (spec §5.2). Chiamato dal drain
 * al posto di Mario quando `lancioInCorso` e' vero. Restituisce lo stato finale che il
 * drain scrive in `ai_status`.
 *
 * Ordine: classificazione deterministica; il modello solo se serve (domanda o incerto);
 * decisione pura (`decideLancioTurno`); effetti. Una bolla sola per turno, sempre la
 * traccia `fenice_ai_reply` — anche nel silenzio — perche' il re-drive di bot-followups
 * non rimetta in coda lo stesso inbound ogni ora.
 */
export async function eseguiTurnoLancio(supabase: Supa, i: TurnoLancioInput): Promise<'active' | 'closed' | 'handed_off'> {
  const genera = i.genera ?? generateLancioReply;
  const settings = i.settings ?? (await getLancioSettings(supabase));

  let classe: ClasseLancio = classificaLancio(i.inboundBody);
  let modello: LancioReplyParsed | null = null;
  const scambi = contaScambiDomande(i.rows);
  // Il modello si interpella solo se puo' ancora rispondere: dopo il terzo scambio si
  // tace, e chiedere una risposta per poi buttarla costa e basta.
  const serveModello = classe === 'incerto' || (classe === 'domanda' && scambi < MAX_SCAMBI_DOMANDE);
  if (serveModello) {
    const history: MarioTurn[] = i.rows.map((m) => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body ?? '' }));
    modello = await genera(history, { fase: i.fase, nome: i.nome, eventoAt: settings.eventoAt });
    if (classe === 'incerto') classe = modello.classe;
  }

  const azione = decideLancioTurno({ fase: i.fase, classe, scambiDomande: scambi, passToHuman: modello?.passToHuman ?? false });

  const invia = async (body: string): Promise<void> => {
    const sent = await sendFreeText({ to: i.phone, body, from: i.from });
    await supabase.from('messages').insert({
      conversation_id: i.conversationId, direction: 'out', body,
      twilio_sid: sent.sid, twilio_status: sent.status, sender: 'bot',
    });
    await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', i.conversationId);
  };
  const evento = async (type: string, extra: Record<string, unknown>, message: string, level: 'info' | 'warn' = 'info') => {
    await supabase.from('event_log').insert({
      type, payload: { conversationId: i.conversationId, crmLeadId: i.crmLeadId, fase: i.fase, classe, ...extra } as never, message, level,
    });
  };

  let finalStatus: 'active' | 'closed' | 'handed_off' = 'active';
  let motivoSilenzio: string | null = null;

  switch (azione.kind) {
    case 'posto_bloccato': {
      await invia(azione.testo);
      await impostaFaseLancio(supabase, i.conversationId, 'posto_bloccato');
      await evento('lancio_posto_bloccato', {}, `[lancio] conv ${i.conversationId}: posto bloccato`);
      break;
    }
    case 'congedo': {
      await invia(azione.testo);
      await impostaFaseLancio(supabase, i.conversationId, 'chiuso');
      if (i.crmLeadId) {
        const esito = await sendOutcome(supabase, i.conversationId, {
          outcome: 'DA_SCARTARE',
          discardReason: 'non interessato',
          note: "Lancio Web Dev AI: ha risposto no al benvenuto della lista d'attesa.",
          leadWords: i.inboundBody,
        });
        if (esito.sent || esito.error === 'note_duplicate') finalStatus = 'closed';
      } else {
        finalStatus = 'closed';
      }
      await evento('lancio_congedo', { finalStatus }, `[lancio] conv ${i.conversationId}: non interessato, congedato`);
      break;
    }
    case 'domanda': {
      const testo = (modello?.visibleReply ?? '').trim();
      if (!testo) {
        motivoSilenzio = 'risposta_vuota';
        break;
      }
      await invia(azione.chiudi ? `${testo}\n${TESTO_CHIUSURA_DOMANDE}` : testo);
      await evento('lancio_domanda', { scambio: scambi + 1, chiuso: azione.chiudi }, `[lancio] conv ${i.conversationId}: risposta a domanda ${scambi + 1}/3`);
      break;
    }
    case 'passaggio_umano': {
      await invia((modello?.visibleReply ?? '').trim() || TESTO_PASSAGGIO_UMANO);
      if (i.crmLeadId) {
        const esito = await sendOutcome(supabase, i.conversationId, { outcome: 'CONTATTO_UMANO', note: i.inboundBody });
        if (!esito.sent) {
          await evento('contatto_umano_non_segnalato', { error: esito.error ?? null, status: esito.status ?? null },
            `[lancio] conv ${i.conversationId}: passaggio a una persona non segnalato al CRM`, 'warn');
        }
      }
      await supabase.from('conversations')
        .update({ handed_off_at: new Date().toISOString(), handed_off_reason: i.inboundBody })
        .eq('id', i.conversationId);
      finalStatus = 'handed_off';
      break;
    }
    case 'silenzio': {
      motivoSilenzio = azione.motivo;
      break;
    }
  }

  if (motivoSilenzio) {
    await evento('lancio_silenzio', { motivo: motivoSilenzio }, `[lancio] conv ${i.conversationId}: nessuna risposta (${motivoSilenzio})`);
  }
  await supabase.from('event_log').insert({
    type: 'fenice_ai_reply',
    payload: { conversationId: i.conversationId, phone: i.phone, lancio: true, azione: azione.kind, appointmentFixed: false, passToHuman: azione.kind === 'passaggio_umano' } as never,
    message: `[lancio] turno su ${i.phone}: ${azione.kind}`,
    level: 'info',
  });
  return finalStatus;
}
```

In `lib/fenice-autoreply.ts`:

1. Import in testa: `import { lancioInCorso } from './lancio-fase';` e `import { eseguiTurnoLancio } from './lancio-turno';`
2. Nel `.select(...)` del claim (riga ~268) aggiungi `lancio_slug, lancio_fase,` dopo `gdo_appuntamento_at,`.
3. Dopo il blocco `const gdo = claimed as {...}` (riga ~341) aggiungi:
```ts
  // Chat del lancio Web Dev AI: il turno lo fa lib/lancio-turno, non Mario.
  const lancio = claimed as { lancio_slug?: string | null; lancio_fase?: string | null };
```
4. Subito dopo `const videoGiaInviato = ...` (riga ~387), prima di `inviaVideoGdo`, aggiungi:
```ts
      if (lancioInCorso(lancio)) {
        finalStatus = await eseguiTurnoLancio(supabase, {
          conversationId, phone, from, crmLeadId,
          fase: lancio.lancio_fase ?? null,
          nome: gdo.leads?.first_name ?? null,
          rows, inboundBody,
        });
        break;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test lib/lancio-turno.test.ts lib/fenice-autoreply.test.ts && bun run typecheck`
Expected: PASS; typecheck pulito (se `rows` non combacia col tipo di `TurnoLancioInput.rows` per `body: string` vs `string | null`, il tipo del turno accetta `string | null` e va bene).

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-db.ts lib/lancio-turno.ts lib/lancio-turno.test.ts lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "feat(lancio): turno della fase di attesa (posto bloccato, congedo, domande) agganciato al drain"
```

---

### Task 9: Cron dei benvenuti differiti (`/api/cron/lancio-aperture`)

**Files:**
- Create: `lib/lancio-aperture.ts`, `app/api/cron/lancio-aperture/route.ts`
- Modify: `vercel.json` (aggiunge un cron)
- Test: `lib/lancio-aperture.test.ts`

**Interfaces:**
- Consumes: `inOpeningWindow` (`lib/sequence.ts`), `getLancioSettings`, `lancioBenvenutoText`, `sendTemplate`/`getTemplateBody` (`lib/twilio.ts`), `templateName`.
- Produces: `decideAperturaLancio(i: { nowMs: number; attivo: boolean; fase: string | null; outboundPartiti: number; outboundFalliti: number }): 'invia' | 'attendi' | 'salta'`; `MAX_TENTATIVI_BENVENUTO = 2`. Route `GET /api/cron/lancio-aperture` (auth `CRON_SECRET` come gli altri), eventi `lancio_apertura_inviata`, `lancio_apertura_freq_capped`, `lancio_aperture_run`. Env opzionale `LANCIO_APERTURE_MAX_PER_RUN` (default 100).

- [ ] **Step 1: Write the failing test**

Crea `lib/lancio-aperture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decideAperturaLancio, MAX_TENTATIVI_BENVENUTO } from './lancio-aperture';

const GIORNO = Date.parse('2026-09-20T10:00:00Z'); // 12:00 Roma
const NOTTE = Date.parse('2026-09-20T01:00:00Z');  // 03:00 Roma
const base = { nowMs: GIORNO, attivo: true, fase: 'attesa', outboundPartiti: 0, outboundFalliti: 0 };

describe('decideAperturaLancio', () => {
  it('lead in attesa, nulla partito, lancio acceso, in fascia → invia', () => {
    expect(decideAperturaLancio(base)).toBe('invia');
  });
  it('fuori dalla fascia 07-23 aspetta', () => {
    expect(decideAperturaLancio({ ...base, nowMs: NOTTE })).toBe('attendi');
  });
  it('lancio spento aspetta: e'' il kill-switch, non una rinuncia', () => {
    expect(decideAperturaLancio({ ...base, attivo: false })).toBe('attendi');
  });
  it('un benvenuto gia'' partito (con SID) → salta', () => {
    expect(decideAperturaLancio({ ...base, outboundPartiti: 1 })).toBe('salta');
  });
  it('un invio fallito si ritenta, ma non all''infinito', () => {
    expect(decideAperturaLancio({ ...base, outboundFalliti: 1 })).toBe('invia');
    expect(decideAperturaLancio({ ...base, outboundFalliti: MAX_TENTATIVI_BENVENUTO })).toBe('salta');
  });
  it('fase diversa da attesa → salta (ha gia'' ricevuto qualcosa o e'' finita)', () => {
    for (const fase of ['posto_bloccato', 'chiuso', 'restituito', null]) {
      expect(decideAperturaLancio({ ...base, fase })).toBe('salta');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/lancio-aperture.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Write minimal implementation**

Crea `lib/lancio-aperture.ts`:

```ts
import { inOpeningWindow } from './sequence';

/** Oltre questi fallimenti non si insiste: il numero e' morto o il template e' bloccato. */
export const MAX_TENTATIVI_BENVENUTO = 2;

export type AperturaLancioAzione = 'invia' | 'attendi' | 'salta';

/**
 * Il benvenuto del lancio che non e' partito all'intake (fuori fascia o `lancio_attivo`
 * spento) lo manda questo cron, non `sequence-touches`. Puro: il route legge e agisce.
 *
 * "Partito" = un outbound con SID Twilio; un fallito (senza SID) si ritenta fino a
 * MAX_TENTATIVI_BENVENUTO. Un frequency cap Meta (63049) non lascia righe e si ritenta
 * al run dopo.
 */
export function decideAperturaLancio(i: {
  nowMs: number;
  attivo: boolean;
  fase: string | null;
  outboundPartiti: number;
  outboundFalliti: number;
}): AperturaLancioAzione {
  if (i.fase !== 'attesa') return 'salta';
  if (i.outboundPartiti > 0) return 'salta';
  if (i.outboundFalliti >= MAX_TENTATIVI_BENVENUTO) return 'salta';
  if (!i.attivo) return 'attendi';
  if (!inOpeningWindow(i.nowMs)) return 'attendi';
  return 'invia';
}
```

Crea `app/api/cron/lancio-aperture/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendTemplate } from '@/lib/twilio';
import { getLancioSettings } from '@/lib/lancio-settings';
import { decideAperturaLancio } from '@/lib/lancio-aperture';
import { lancioBenvenutoText } from '@/lib/lancio-fase';
import { templateName } from '@/lib/name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Benvenuti del lancio rimasti indietro (intake fuori fascia 07-23 o lancio spento).
// Queste chat sono ESCLUSE da sequence-touches (FILTRO_FUORI_LANCIO): senza questo cron
// resterebbero mute per sempre. Schedule in vercel.json: ogni 15' dalle 05 alle 21 UTC,
// il filtro sull'ora italiana lo fa `decideAperturaLancio` via `inOpeningWindow`.

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

type Conv = {
  id: number; ai_started_at: string | null; crm_lead_id: string | null; lancio_fase: string | null;
  leads: { phone_e164: string | null; first_name: string | null } | null;
};

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const supabase = getSupabaseAdmin();
  const templateSid = process.env.LANCIO_WELCOME_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    await supabase.from('event_log').insert({
      type: 'lancio_aperture_config_error',
      payload: { missing: [!templateSid ? 'LANCIO_WELCOME_TEMPLATE_SID' : null, !from ? 'TWILIO_WHATSAPP_NUMBER_FENICE' : null].filter(Boolean) } as never,
      message: '[lancio] env mancanti per i benvenuti differiti: run saltato',
      level: 'error',
    });
    return NextResponse.json({ ok: true, sent: 0, skipped: 'config' });
  }

  const settings = await getLancioSettings(supabase);
  const now = Date.now();
  const maxPerRun = Math.max(1, Number(process.env.LANCIO_APERTURE_MAX_PER_RUN) || 100);

  const { data } = await supabase
    .from('conversations')
    .select('id, ai_started_at, crm_lead_id, lancio_fase, leads(phone_e164, first_name)')
    .not('lancio_slug', 'is', null)
    .eq('lancio_fase', 'attesa')
    .eq('ai_status', 'active')
    .is('ai_paused_at', null)
    .order('id', { ascending: true })
    .limit(1000);
  const convs = (data ?? []) as unknown as Conv[];

  let sent = 0, attesi = 0, saltati = 0, capped = 0, falliti = 0;

  for (const c of convs) {
    if (sent >= maxPerRun) break;
    const phone = c.leads?.phone_e164 ?? null;
    if (!phone) { saltati++; continue; }
    try {
      // Buffer 5' come negli altri cron: l'enroll scrive il messaggio prima di ai_started_at.
      let q = supabase.from('messages').select('twilio_sid').eq('conversation_id', c.id).eq('direction', 'out').limit(50);
      if (c.ai_started_at) q = q.gte('created_at', new Date(Date.parse(c.ai_started_at) - 5 * 60_000).toISOString());
      const { data: outs } = await q;
      const righe = (outs ?? []) as { twilio_sid: string | null }[];
      const partiti = righe.filter((m) => !!m.twilio_sid).length;
      const fallitiConv = righe.length - partiti;

      const azione = decideAperturaLancio({ nowMs: now, attivo: settings.attivo, fase: c.lancio_fase, outboundPartiti: partiti, outboundFalliti: fallitiConv });
      if (azione === 'attendi') { attesi++; continue; }
      if (azione === 'salta') { saltati++; continue; }

      const nome = c.leads?.first_name ?? null;
      try {
        const res = await sendTemplate({ to: phone, contentSid: templateSid, variables: { '1': templateName(nome) }, from });
        await supabase.from('messages').insert({
          conversation_id: c.id, direction: 'out', body: lancioBenvenutoText(nome),
          twilio_sid: res.sid, twilio_status: res.status, template_sid: templateSid, is_template: true, sender: 'automazione',
        });
        await supabase.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', c.id);
        await supabase.from('event_log').insert({
          type: 'lancio_apertura_inviata',
          payload: { conversationId: c.id, crmLeadId: c.crm_lead_id, sid: res.sid } as never,
          message: `[lancio] benvenuto differito inviato a ${phone}`,
          level: 'info',
        });
        sent++;
      } catch (err) {
        const e = err as { message?: string; code?: number };
        if (e?.code === 63049) {
          // Frequency cap Meta: nessuna riga, si ritenta al run dopo (come la sequenza).
          capped++;
          await supabase.from('event_log').insert({
            type: 'lancio_apertura_freq_capped',
            payload: { conversationId: c.id } as never,
            message: `[lancio] frequency cap Meta su conv ${c.id}: benvenuto rimandato al prossimo run`,
            level: 'info',
          });
          continue;
        }
        falliti++;
        await supabase.from('messages').insert({
          conversation_id: c.id, direction: 'out', body: lancioBenvenutoText(nome),
          twilio_status: 'failed', twilio_error_code: e?.code ?? null, template_sid: templateSid, is_template: true, sender: 'automazione',
        });
        await supabase.from('event_log').insert({
          type: 'send_error',
          payload: { conversationId: c.id, crmLeadId: c.crm_lead_id, error: e?.message ?? 'errore' } as never,
          message: `[lancio] benvenuto differito fallito per ${phone}: ${e?.message ?? 'errore'}`,
          level: 'error',
        });
      }
    } catch (e) {
      await supabase.from('event_log').insert({
        type: 'lancio_aperture_error',
        payload: { conversationId: c.id, error: e instanceof Error ? e.message : 'errore' } as never,
        message: `[lancio] errore su conv ${c.id}: ${e instanceof Error ? e.message : 'errore'}`,
        level: 'error',
      });
    }
  }

  if (sent > 0 || falliti > 0 || capped > 0) {
    await supabase.from('event_log').insert({
      type: 'lancio_aperture_run',
      payload: { candidate: convs.length, sent, attesi, saltati, capped, falliti, attivo: settings.attivo } as never,
      message: `[lancio] benvenuti differiti: ${sent} inviati, ${attesi} in attesa, ${saltati} saltati, ${capped} cap, ${falliti} falliti`,
      level: falliti > 0 ? 'warn' : 'info',
    });
  }
  return NextResponse.json({ ok: true, candidate: convs.length, sent, attesi, saltati, capped, falliti, attivo: settings.attivo });
}
```

In `vercel.json`, dentro `"crons"`, aggiungi dopo la voce di `crm-lead-status`:
```json
    ,
    {
      "path": "/api/cron/lancio-aperture",
      "schedule": "*/15 5-21 * * *"
    }
```
(attenzione alla virgola: la voce precedente deve terminare con `},`).

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test lib/lancio-aperture.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-aperture.ts lib/lancio-aperture.test.ts app/api/cron/lancio-aperture/route.ts vercel.json
git commit -m "feat(lancio): cron dei benvenuti differiti, fuori da sequence-touches"
```

---

### Task 10: Esclusioni dai cron di Mario

**Files:**
- Modify: `lib/bot-followups.ts:13-21` (`CronConvRow`), `:67-95` (`serveCronologia`), `:107-154` (`decideFollowupAction`)
- Modify: `app/api/cron/bot-followups/route.ts:62` (select), `:158-163` (skip), `:231-242` (chiamata a `decideFollowupAction`)
- Modify: `app/api/cron/sequence-touches/route.ts:179-193` (query)
- Modify: `app/api/cron/precall-reminders/route.ts:68-80` (query)
- Modify: `app/api/cron/gdo-video-followups/route.ts:88-108` (query)
- Modify: `app/api/cron/riapri-mute/route.ts:46-52` (query)
- Test: `lib/bot-followups.test.ts`

**Interfaces:**
- Consumes: `lancioInCorso`, `FILTRO_FUORI_LANCIO` (Task 4).
- Produces: `CronConvRow.lancio_slug?: string | null; lancio_fase?: string | null`; `serveCronologia` torna `false` per un lancio in corso salvo il re-drive; `decideFollowupAction({ lancio?: boolean })` torna `'none'` col lancio in corso.

- [ ] **Step 1: Write the failing test**

In `lib/bot-followups.test.ts` aggiungi in fondo:

```ts
describe('lancio Web Dev AI — fuori dalle classificazioni, dentro il re-drive', () => {
  const lancio = { lancio_slug: 'webdev-2026-10', lancio_fase: 'attesa' };

  it('decideFollowupAction: mai NON_RISPOSTO/INTERROTTO/scarto su un lancio in corso', () => {
    expect(decide({ msgs: [out(14 * D, 'delivered')], lancio: true })).toBe('none');
    expect(decide({ msgs: [out(130 * H, 'delivered'), inb(125 * H)], hasInbound: true, lastInboundAtMs: NOW - 125 * H, lancio: true })).toBe('none');
    expect(decide({ msgs: [out(60 * H, 'failed'), out(30 * H, 'failed', SEQ_SIDS[0])], lancio: true })).toBe('none');
  });

  it('serveCronologia: il re-drive resta (ha scritto e nessuno ha risposto)', () => {
    const c: CronConvRow = {
      ai_status: 'active', ai_started_at: at(2 * D), last_message_at: at(H), last_inbound_at: at(H),
      bot_outcome: null, gdo_agenda_at: null, ...lancio,
    };
    expect(serveCronologia(c, NOW)).toBe(true);
  });

  it('serveCronologia: niente cronologia per classificare un lancio in corso, anche a 10 giorni', () => {
    const c: CronConvRow = {
      ai_status: 'active', ai_started_at: at(10 * D), last_message_at: at(10 * D), last_inbound_at: null,
      bot_outcome: null, gdo_agenda_at: null, ...lancio,
    };
    expect(serveCronologia(c, NOW)).toBe(false);
  });

  it('serveCronologia: lancio chiuso → regole di sempre', () => {
    const c: CronConvRow = {
      ai_status: 'active', ai_started_at: at(10 * D), last_message_at: at(10 * D), last_inbound_at: null,
      bot_outcome: null, gdo_agenda_at: null, lancio_slug: 'webdev-2026-10', lancio_fase: 'chiuso',
    };
    expect(serveCronologia(c, NOW)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/bot-followups.test.ts`
Expected: FAIL — `lancio` non è un input riconosciuto, `serveCronologia` torna `true` sul lancio a 10 giorni.

- [ ] **Step 3: Write minimal implementation**

In `lib/bot-followups.ts`:

Import: `import { lancioInCorso } from './lancio-fase';`

In `CronConvRow` aggiungi:
```ts
  lancio_slug?: string | null;
  lancio_fase?: string | null;
```

In `serveCronologia`, dopo il blocco `// 1. Re-drive ...` (`if (guidataDalBot && ultimoMessaggioEInbound(c)) return true;`) aggiungi:
```ts
  // 1b. Lancio Web Dev AI in corso: il re-drive sopra vale (il turno lo fa lib/lancio-turno),
  //     ma nessuna classificazione — questi lead escono dal bot solo con le restituzioni
  //     del lancio (B5), mai per silenzio prima dell'8/10 (spec A5).
  if (lancioInCorso(c)) return false;
```

In `decideFollowupAction`, nel tipo di input aggiungi `/** Chat del lancio con fase non terminale: mai classificare. */ lancio?: boolean;` e come prima riga del corpo:
```ts
  if (input.lancio === true) return 'none';
```

In `app/api/cron/bot-followups/route.ts`:
- import: `import { lancioInCorso } from '@/lib/lancio-fase';`
- nel `.select(...)` (riga 62) aggiungi `lancio_slug, lancio_fase,` dopo `gdo_agenda_at,`;
- dopo il blocco `2a` (`if (c.gdo_agenda_at) {...continue;}`) aggiungi:
```ts
      // 2a-bis. Lancio in corso: come il postino, niente watchdog ne' classificazioni.
      if (lancioInCorso(c)) {
        report.push({ id: c.id, action: 'lancio_skip', fase: c.lancio_fase });
        continue;
      }
```
- nella chiamata a `decideFollowupAction` aggiungi `lancio: lancioInCorso(c),` dopo `gdoPostino: ...`.

In `app/api/cron/sequence-touches/route.ts`: import `FILTRO_FUORI_LANCIO` da `@/lib/lancio-fase` e nella query (dopo `.is('ai_paused_at', null)`) aggiungi:
```ts
      // Lancio Web Dev AI: niente aperture, touch o nudge. Il benvenuto differito lo
      // manda /api/cron/lancio-aperture, il resto e' silenzio fino al 5/10 (spec §5.1).
      .or(FILTRO_FUORI_LANCIO)
```

In `app/api/cron/precall-reminders/route.ts`: stesso import; nella query dopo `.is('cancel_requested_at', null)` aggiungi `.or(FILTRO_FUORI_LANCIO)` con commento `// Lancio: gli appuntamenti del lancio li fissa il CRM (B3/B4), i promemoria non partono da qui.`

In `app/api/cron/gdo-video-followups/route.ts`: stesso import; nella query dopo `.is('cancel_requested_at', null)` aggiungi `.or(FILTRO_FUORI_LANCIO)` con commento `// Lancio in corso: nessun sollecito. Con lancio chiuso/restituito il lead GDO torna normale.`

In `app/api/cron/riapri-mute/route.ts`: stesso import; nella query dentro `fetchAllRows` dopo `.gte('ai_started_at', dal)` aggiungi `.or(FILTRO_FUORI_LANCIO)` con commento `// Le chat del lancio hanno il loro recupero (lancio-aperture): qui enrollLeadIntoMario manderebbe l'apertura di Mario.`

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test lib/bot-followups.test.ts lib/sequence.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/bot-followups.ts lib/bot-followups.test.ts app/api/cron/bot-followups/route.ts app/api/cron/sequence-touches/route.ts app/api/cron/precall-reminders/route.ts app/api/cron/gdo-video-followups/route.ts app/api/cron/riapri-mute/route.ts
git commit -m "feat(lancio): le chat del lancio restano fuori da sequenza, classificazioni, promemoria e solleciti"
```

---

### Task 11: Badge e filtro "Lancio" nei pannelli `/chat` e `/fenice`

**Files:**
- Modify: `app/api/chat/conversations/route.ts:9-20` (tipo riga), `:61-73` (query e filtro), `:78-82` (output)
- Modify: `app/(chat)/chat/layout.tsx:14-31` (select + `lancio`), `:35-41` (prop `conFiltroLancio`)
- Modify: `components/ConversationList.tsx:13-31` (tipi/stato), `:85-96` (bottoni), `:108-121` (badge)
- Modify: `app/(chat)/chat/[conversationId]/page.tsx:26-30` (select), `:65-80` (header)
- Modify: `app/(fenice)/fenice/conversazioni/page.tsx:14-28`, `app/(fenice)/fenice/conversazioni/_components/ConversationsPanel.tsx:11-18`, `:54-70`, `:123-147`
- Modify: `app/(fenice)/fenice/live/page.tsx:16-29`, `app/(fenice)/fenice/live/_components/LivePanel.tsx:12`, `:146-155`

**Interfaces:**
- Consumes: `lancioFaseLabel` (Task 4); `StatusPill` (`components/fenice/status.tsx`).
- Produces: `GET /api/chat/conversations?filter=lancio`; ogni riga di risposta ha `lancio: { slug: string; fase: string | null } | null`; `ConversationList` prop `conFiltroLancio?: boolean`; righe dei pannelli `/fenice` con `lancioFase: string | null`.

Nessun test automatico (componenti server/client senza test in repo): la verifica è il typecheck + controllo a occhio nello Step 3.

- [ ] **Step 1: `/api/chat/conversations` e layout**

In `app/api/chat/conversations/route.ts`:
- nel tipo `ConversationRow` aggiungi `lancio_slug: string | null; lancio_fase: string | null;`
- nel `.select(...)` aggiungi `lancio_slug, lancio_fase,` dopo `ai_owner, gdo_agenda_at, gdo_video_sent_at,`
- dopo `if (filter === 'recent') ...` aggiungi:
```ts
  // Lancio Web Dev AI: le Conferme cercano per numero, ma il filtro serve a vedere il
  // lotto intero (chi ha risposto, chi ha bloccato il posto) senza inventare un pannello.
  if (filter === 'lancio') query = query.not('lancio_slug', 'is', null);
```
- nel `map` finale aggiungi `lancio: c.lancio_slug ? { slug: c.lancio_slug, fase: c.lancio_fase } : null,` dopo `mondo: mondoDi(c),`.

In `app/(chat)/chat/layout.tsx`: nel `.select(...)` aggiungi `lancio_slug, lancio_fase,`; nel `map` aggiungi `lancio: c.lancio_slug ? { slug: c.lancio_slug, fase: c.lancio_fase } : null,`; al componente `<ConversationList ... />` aggiungi la prop `conFiltroLancio`.

- [ ] **Step 2: `ConversationList` e pagina della chat**

In `components/ConversationList.tsx`:
- import: `import { lancioFaseLabel } from '@/lib/lancio-fase';`
- nel tipo `Conv` aggiungi `lancio?: { slug: string; fase: string | null } | null;`
- firma: aggiungi `conFiltroLancio = false` alle props destrutturate e `conFiltroLancio?: boolean;` al tipo;
- stato: `const [filter, setFilter] = useState<'all' | 'unread' | 'recent' | 'lancio'>('all');`
- bottoni: sostituisci il blocco `{(['all', 'unread', 'recent'] as const).map(...)}` con:
```tsx
          {(['all', 'unread', 'recent', ...(conFiltroLancio ? (['lancio'] as const) : [])] as const).map((f) => (
            <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Tutte' : f === 'unread' ? 'Non lette' : f === 'recent' ? 'Ultimi 7gg' : 'Lancio'}
            </Button>
          ))}
```
- badge: subito prima di `{c.mondo && (` aggiungi:
```tsx
                    {c.lancio && (
                      <span
                        title={lancioFaseLabel(c.lancio.fase)}
                        className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
                      >
                        Lancio
                      </span>
                    )}
```

In `app/(chat)/chat/[conversationId]/page.tsx`:
- import: `import { lancioFaseLabel } from '@/lib/lancio-fase';`
- nel `.select(...)` aggiungi `lancio_slug, lancio_fase,` dopo `bot_outcome, bot_scheduled_at,`
- nell'header, dopo il blocco `{conv.ai_paused_at && (...)}` aggiungi:
```tsx
          {conv.lancio_slug && (
            <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
              Lancio · {lancioFaseLabel(conv.lancio_fase)}
            </span>
          )}
```

- [ ] **Step 3: Pannelli `/fenice`**

`app/(fenice)/fenice/conversazioni/page.tsx`: nel `.select(...)` aggiungi `lancio_slug, lancio_fase,`; nel `map` aggiungi `lancioFase: c.lancio_slug ? ((c.lancio_fase as string | null) ?? 'attesa') : null,`.

`app/(fenice)/fenice/conversazioni/_components/ConversationsPanel.tsx`:
- import: `import { ChatStatusPill, StatusPill } from '@/components/fenice/status';` (sostituisce l'import di `ChatStatusPill`) e `import { lancioFaseLabel } from '@/lib/lancio-fase';`
- tipo `Row`: aggiungi `lancioFase: string | null;`
- stato: `const [soloLancio, setSoloLancio] = useState(false);`
- filtro: dentro `rows.filter((r) => {` come prima riga `if (soloLancio && !r.lancioFase) return false;`
- sotto la barra di ricerca (dentro il `div` con `border-b`, dopo il `div.relative`) aggiungi:
```tsx
          <button
            type="button"
            onClick={() => setSoloLancio((v) => !v)}
            className={cn(
              'mt-2 w-full rounded-lg border px-2 py-1 text-xs font-semibold transition-colors',
              soloLancio ? 'border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200' : 'border-border/70 text-muted-foreground hover:bg-muted',
            )}
          >
            {soloLancio ? 'Solo lancio · attivo' : 'Solo lancio'}
          </button>
```
- nella riga della lista, accanto a `<ChatStatusPill status={r.status} />` (dentro lo stesso `div.flex`) aggiungi prima:
```tsx
                  {r.lancioFase && <StatusPill label={lancioFaseLabel(r.lancioFase)} tone="amber" dot={false} />}
```

`app/(fenice)/fenice/live/page.tsx`: nel `.select(...)` aggiungi `lancio_slug, lancio_fase,`; nel `map` aggiungi `lancioFase: c.lancio_slug ? ((c.lancio_fase as string | null) ?? 'attesa') : null,`.

`app/(fenice)/fenice/live/_components/LivePanel.tsx`:
- import: `import { ChatStatusPill, StatusPill } from '@/components/fenice/status';` e `import { lancioFaseLabel } from '@/lib/lancio-fase';`
- tipo `Row`: aggiungi `lancioFase: string | null;`
- nella cella dello stato (`<td className="px-5 py-3 text-right">`) sostituisci `<ChatStatusPill status={r.status} />` con:
```tsx
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {r.lancioFase && <StatusPill label={lancioFaseLabel(r.lancioFase)} tone="amber" dot={false} />}
                      <ChatStatusPill status={r.status} />
                    </span>
```

- [ ] **Step 4: Typecheck, lint e prova a occhio**

Run: `bun run typecheck && bun run lint`
Expected: puliti.

Run: `bun run dev` e apri `http://localhost:3000/chat` (utenza `fenice@academy.com`): il bottone "Lancio" compare, con zero conversazioni lancio la lista è vuota; `http://localhost:3000/fenice/conversazioni`: il toggle "Solo lancio" compare. Se hai una riga di prova, imposta a mano `lancio_slug='webdev-2026-10', lancio_fase='attesa'` su una conversazione di test via SQL Editor e verifica il badge "In attesa" e "Lancio" in entrambi i pannelli; poi ripristina a `null`.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/conversations/route.ts "app/(chat)/chat/layout.tsx" components/ConversationList.tsx "app/(chat)/chat/[conversationId]/page.tsx" "app/(fenice)/fenice/conversazioni/page.tsx" "app/(fenice)/fenice/conversazioni/_components/ConversationsPanel.tsx" "app/(fenice)/fenice/live/page.tsx" "app/(fenice)/fenice/live/_components/LivePanel.tsx"
git commit -m "feat(lancio): badge e filtro Lancio nei pannelli /chat e /fenice"
```

---

### Task 12: Documentazione del campo `lancio`, env, verifica finale e messa in produzione

**Files:**
- Modify: `.env.example` (in coda alla sezione Fenice)
- Nota: `docs/bot-fissatore-contract.md` **non esiste in questo repo**. Il contratto vive nel repo CRM (`C:\Users\bruno\Desktop\CRM GDO\docs\bot-fissatore-contract.md`, sezione "Direzione 1 — Body `BotIntakePayload`"). L'aggiornamento è compito del piano B1 lato CRM (stessa sessione coordinatrice): il testo da aggiungere è nello Step 1. Lato bot il campo è documentato nel JSDoc di `LancioIntake` (Task 3).

**Interfaces:**
- Consumes: tutto quanto sopra.
- Produces: repo verde, migrazione applicata, env in produzione, deploy, `lancio_attivo` acceso quando il CRM accende `LANCIO_WEBDEV_INTAKE`.

- [ ] **Step 1: Testo per il contratto (repo CRM, da consegnare alla sessione CRM)**

Da aggiungere in `docs/bot-fissatore-contract.md` del CRM, sotto `### Body — BotIntakePayload`, dopo il blocco `companyId`:

```md
### Campo `lancio` (nuovo in v1.6, 14/09/2026)

```ts
lancio?: { slug: string; ingresso: 'lista' | 'pulsante_webinar' }
```

Presente solo sui lead del lancio "Web Developer AI" (`launchBucket='LANCIO_WEBDEV_2026'`,
funnel `Lancio Web Dev AI`): `slug` vale `webdev-2026-10`, `ingresso` dice se il lead
viene dalla lista AC 132 o dal pulsante WhatsApp della live. Il bot:
- manda il **template di benvenuto del lancio** (non l'apertura di Mario) e mette la chat
  in fase `attesa`; fuori dalla fascia 07-23, o con `lancio_attivo=0` lato bot, risponde
  `apertura: 'differita'` e lo manda al primo run utile del suo cron;
- su una chat già viva risponde `duplicato: true` senza secondo benvenuto, ma la chat
  entra comunque nel flusso lancio;
- non applica a questi lead sequenza, nudge, promemoria pre-call, solleciti video, né le
  classificazioni automatiche (`NON_RISPOSTO`/`INTERROTTO`): fino alle restituzioni del
  lancio (dall'8/10) un lead del lancio non torna mai al CRM per silenzio.
- Esiti possibili in questa fase: `DA_SCARTARE` con `discardReason='non interessato'`
  (ha detto no al benvenuto) e `CONTATTO_UMANO` (ha chiesto una persona).

Campo assente ⇒ comportamento di sempre, invariato.
```

- [ ] **Step 2: `.env.example`**

In `.env.example`, dopo `FENICE_OPENING_TEMPLATE_SID=...` aggiungi:
```
# Lancio Web Developer AI (webinar 5/10/2026) — SID dei 3 template creati da
# scripts/create-lancio-templates.mjs. Se Meta li approva MARKETING vanno anche in UTILITY_ONLY_ALLOW.
LANCIO_WELCOME_TEMPLATE_SID=
LANCIO_ZOOM_TEMPLATE_SID=
LANCIO_FOLLOWUP_TEMPLATE_SID=
# Tetto per run del cron /api/cron/lancio-aperture (default 100)
LANCIO_APERTURE_MAX_PER_RUN=100
```

- [ ] **Step 3: Suite completa e typecheck**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: tutto verde. Se un test storico fallisce per la colonna `lancio_slug` nel select del claim (fake senza il campo), il fake va esteso con `lancio_slug: null, lancio_fase: null` nella `claimedRow`, mai il codice.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(lancio): env dei template del lancio in .env.example"
```

- [ ] **Step 5: Messa in produzione, nell'ordine**

1. **Migrazione applicata** (Task 1, Step 5) e verificata: senza, il primo intake con `lancio` fallisce sull'`update` di `lancio_slug` e l'endpoint risponde `accettato:false, motivo:'arruolamento_fallito'`.
2. **Env su Vercel production** (`npx vercel env add <NOME> production`, oppure dal dashboard): `LANCIO_WELCOME_TEMPLATE_SID` (valore in `.env.local`); se lo stato del template letto con `node --env-file=.env.local scripts/create-lancio-templates.mjs` dice categoria `MARKETING`, aggiungere il SID a `UTILITY_ONLY_ALLOW` (lista separata da virgole, valore esistente + `,HX...`). Verifica con `npx vercel env ls production`.
3. **Push**: `git fetch origin && git rev-list --count origin/main..main` per contare i commit, poi `git push origin main`. La produzione si aggiorna al push (memoria `project_deploy_push_non_automatico`). Verifica con `npx vercel ls --yes` che l'ultimo deploy sia `Ready`.
4. **Prova con un numero di test** (prima di accendere lato CRM): `curl -X POST https://<prod>/api/bot/intake` con un body firmato HMAC (`x-bot-signature`, vedi `lib/bot-hmac.ts`) contenente `lancio: { slug: 'webdev-2026-10', ingresso: 'lista' }` e un `companyId: 'fenice'`. Con `lancio_attivo=false` (default della migrazione) attesa risposta `{ ok:true, accettato:true, apertura:'differita' }` e la riga con `lancio_fase='attesa'`; poi:
   ```sql
   update app_settings set value = 'true'::jsonb, updated_at = now() where key = 'lancio_attivo';
   ```
   e chiamare `GET https://<prod>/api/cron/lancio-aperture?secret=$CRON_SECRET`: il benvenuto parte (`sent: 1`). Rispondere "sì" dal numero di test → "Perfetto, il tuo posto è bloccato…" e `lancio_fase='posto_bloccato'`; rispondere "è a pagamento?" → risposta secca del modello; controllare in `event_log` `lancio_intake`, `lancio_apertura_inviata`, `lancio_posto_bloccato`, `fenice_ai_reply` con `lancio:true`. Verificare che dopo un'ora `bot_followups_run` NON abbia ri-drivato quella chat (nessun secondo messaggio).
5. **Interruttore**: `lancio_attivo` resta `true` solo quando il CRM accende `LANCIO_WEBDEV_INTAKE=on` (§9). Per spegnere l'outbound in emergenza: `update app_settings set value='false'::jsonb where key='lancio_attivo'` (i lead nuovi restano presi in carico, i benvenuti si accumulano e partono alla riaccensione).

---

## Self-Review (fatta in scrittura)

**Spec coverage (perimetro B1 bot):**
- §3.2 colonne `lancio_*`, chiavi `app_settings`, evento `lancio_intake`/`lancio_posto_bloccato` → Task 1, 2, 7, 8. Gli eventi `lancio_link_inviato`, `lancio_pulsante`, `lancio_scelta`, `lancio_followup_inviato`, `lancio_restituito` sono di B4/B5 (fuori perimetro).
- §5.1 campo `lancio`, ramo enroll con `LANCIO_WELCOME_TEMPLATE_SID` e `{{1}}=nome`, finestra 07-23 con differita ripresa da cron dedicato, chat viva senza secondo benvenuto → Task 3, 7, 9. Esclusioni da `sequence-touches`, nudge Track B (che vivono in `sequence-touches`), classificazioni di `bot-followups`, `precall-reminders`, `gdo-video-followups` → Task 10 (in più `riapri-mute`, che avrebbe mandato l'apertura di Mario). `lead-analysis` e `crm-lead-status` non toccati.
- §5.2 classificatore regex + fallback modello con `[LANCIO:SI|DOMANDA|NO]`, testo fisso, `posto_bloccato`, congedo + `DA_SCARTARE` `non interessato`, prompt separato, regole gratuito/no prezzi/logistica/"dopo la live", 1 risposta per lotto (il drain accorpa e il turno manda una bolla), 3 scambi poi "ci sentiamo il 5!" e silenzio, `[PASSAGGIO_UMANO]` → Task 4, 5, 6, 8.
- §5.6 badge/filtro nei pannelli → Task 11.
- Contratto: nota nel Task 12 (il file vive nel CRM).

**Placeholder scan:** nessun TBD/TODO; ogni step di codice ha il codice.

**Type consistency:** `LancioIntake` (Task 3) usata in `EnrollArgs` (Task 7); `ClasseLancio`/`decideLancioTurno`/`contaScambiDomande` (Task 4) usate in Task 8; `LancioReplyParsed` (Task 5) restituita da `generateLancioReply` (Task 6) e consumata in Task 8; `impostaFaseLancio(supabase, id, fase, campi?)` (Task 8) firma unica; `FILTRO_FUORI_LANCIO`/`lancioInCorso` (Task 4) usate in Task 8, 10; `lancioFaseLabel` (Task 4) usata in Task 11; `getLancioSettings`/`LancioSettings` (Task 2) usate in Task 7, 8, 9.
