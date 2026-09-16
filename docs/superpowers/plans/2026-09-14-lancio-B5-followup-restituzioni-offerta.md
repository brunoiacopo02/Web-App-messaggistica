# Lancio Web Developer AI — Blocco B5: follow-up del 6, restituzioni, offerta del mese — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dopo il webinar, il bot manda il follow-up del 6/10 a chi ha interagito, riporta chi risponde nel flusso Mario standard con il video della live editata, restituisce al CRM chi tace, e il CRM rimette quei lead nel pool di `/import`; in più il video "offerta del mese" dell'agenda GDO diventa un link configurabile da `/fenice` e la spunta in `AgendaButton` diventa un pulsante evidente.

**Architecture:** Due cron a data fissa nel bot (`lancio-followup`, `lancio-restituzioni`) con la logica di selezione in moduli puri testati (`lib/lancio-followup.ts`, `lib/lancio-restituzioni.ts`); le impostazioni del lancio vivono in `app_settings` dietro `lib/lancio-settings.ts` e alimentano `videoLinkForVariant`, il cron dei solleciti video e il drain di Mario (`contextNote` con il link della live). Nel CRM, `/api/bot/outcome` riconosce i lead `LANCIO_WEBDEV_2026` assegnati al bot e, invece del round robin, li rimette nel pool con un modulo puro di regole (`lancioReturnRules.ts`) e uno di scrittura (`lancioReturn.ts`).

**Tech Stack:** Bot = Next.js 16 App Router, Supabase (postgrest-js), Twilio Content API, Vitest (`npx vitest run <file>`), `npx tsc --noEmit`, cron in `vercel.json`. CRM = Next.js 16, Drizzle ORM, `node --import tsx --test <file>` (`node:test` + `node:assert/strict`), `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md` (stessa copia nei due repo). Sezioni di questo blocco: §3.2, §4.6, §4.7, §5.5, §5.7, §5.8, §7.3, §9 riga B5.

## Global Constraints

- Ogni task dice in testa **in quale repo** si lavora: **BOT** = `C:\Users\bruno\Desktop\Software Messaggistica`, **CRM** = `C:\Users\bruno\Desktop\CRM GDO`. Non toccare l'altro repo dentro un task.
- Nomi esatti della spec, mai varianti: bucket `LANCIO_WEBDEV_2026`; fasi `attesa | posto_bloccato | link_inviato | post_pitch | scelta_fatta | followup_inviato | restituito | chiuso`; colonne `conversations.lancio_slug`, `lancio_fase`, `lancio_ingresso`, `lancio_link_inviato_at`, `lancio_followup_inviato_at`, `lancio_info`; chiavi `app_settings` `lancio_zoom_link`, `lancio_video_live_link`, `offerta_del_mese_link`, `lancio_evento_at`, `lancio_attivo` (`'0'/'1'`); evento CRM `LANCIO_RETURNED_TO_POOL` con `metadata.motivo ∈ { mai_risposto, silenzio_dopo_followup }`; tipi `event_log` del bot `lancio_followup_inviato`, `lancio_restituito`; env `LANCIO_FOLLOWUP_TEMPLATE_SID`, `OFFERTA_DEL_MESE_LINK`, `VIDEO_GDO_OFFERTA_SID`; note al CRM **esattamente** `"Lancio: mai risposto"` e `"Lancio: silenzio dopo il follow-up"`.
- Cron a data fissa: `/api/cron/lancio-followup` schedule UTC `*/10 10-11,15-17 6-7 10 *` + filtro minuto Rome nel route (fasce 12:00–14:00 e 17:30–19:30 Rome del 6 e 7/10); `/api/cron/lancio-restituzioni` schedule `0 * 8-31 10 *` + guardia data nel route (dall'8/10).
- `LANCIO_BATCH_MAX` = 250 per run del follow-up; numero WhatsApp a qualità LOW: errore Twilio/Meta **63049** ⇒ si salta la conversazione senza consumarla (riprova al run dopo). Concorrenza 5 come `send-batch`.
- Il follow-up **non** va a chi non ha mai scritto (nessun inbound dal lancio): quelli tornano al pool con "mai risposto".
- Il template del follow-up è l'unico messaggio a template di questo blocco; il video della live e il video dell'offerta viaggiano **sempre in testo libero** dentro la conversazione (decisione 2).
- Logica pura testabile: selezione bersagli follow-up, decisione restituzione, motivo restituzione dalla nota, finestra oraria, validazione impostazioni = funzioni pure su righe in input. Niente test che toccano DB o rete.
- CRM: nei file `'use server'` (`src/app/actions/*`) solo `export async function`; costanti e tipi condivisi vanno in `src/lib/*`. Nuovi test CRM vanno **aggiunti alla riga `"test"` di `package.json`** (l'elenco è esplicito). Migrazioni Drizzle a mano (`drizzle-kit generate` inutilizzabile).
- Bot: una migrazione SQL si applica su Supabase **prima** del deploy. Aperture/template solo dal numero `TWILIO_WHATSAPP_NUMBER_FENICE`.
- Ogni task chiude con test verdi del file toccato, poi commit. Alla fine di ogni repo: `npx tsc --noEmit` verde e suite completa verde. Push su `main` solo a blocco finito e dopo la review.
- Non modificare `ScriptWidget`, il middleware CRM, i canali realtime, la finestra del form Calendly/Jotform.

## Prerequisiti dai blocchi B0–B4 (verificare in Task 0)

Questo piano dà per fatto quanto la spec assegna ai blocchi precedenti. Se un prerequisito manca, il Task 0 dice cosa fare.

| Prerequisito | Dove | Se manca |
|---|---|---|
| Colonne `conversations.lancio_slug/lancio_fase/lancio_ingresso/lancio_link_inviato_at/lancio_followup_inviato_at/lancio_info` (B0) | bot `lib/supabase/types.ts` | applicare la migrazione di riserva del Task 0 e rigenerare i tipi |
| `lib/lancio-settings.ts` con `getLancioSettings(supabase)` / `setLancioSetting(supabase, key, value)` (B1) | bot | crearlo nel Task 1 (firme e contenuto sotto) |
| Il ramo lancio del drain (B1/B4) instrada al prompt lancio le fasi `attesa/posto_bloccato/link_inviato/post_pitch` | bot `lib/fenice-autoreply.ts` | il Task 6 lo condiziona con `isLancioStandardFlow` |
| L'arruolamento lancio azzera `bot_outcome`, `bot_outcome_at`, `bot_scheduled_at` sulla conversazione riusata (B1) | bot `lib/fenice-enroll.ts` | segnalarlo: la guardia `bot_outcome !== null` del Task 7 salterebbe quelle righe |
| Colonne `leads.lancioScelta`, `lancioIngresso` ecc. (B0 §3.1) e riga `launchPools` del bucket | CRM `src/db/schema.ts` | il Task 10 usa `lancioScelta`: se assente, aggiungere `lancioScelta: text('lancioScelta')` a `leads` e la migrazione SQL `ALTER TABLE leads ADD COLUMN IF NOT EXISTS "lancioScelta" text;` |
| Card `/import` del lancio con status action (B1) | CRM `src/app/actions/lancioPoolActions.ts` (nome atteso) | il Task 12 aggiunge il contatore `restituiti` dove la card legge lo stato |
| Template Meta approvato del follow-up (B0, `scripts/create-lancio-templates.mjs`) e SID in env `LANCIO_FOLLOWUP_TEMPLATE_SID` su Vercel | bot | il cron esce con `skipped: 'config'` finché non c'è: nessun invio |

---

### Task 0 (BOT + CRM): verifica dei prerequisiti

**Files:**
- Leggere (BOT): `lib/supabase/types.ts`, `lib/lancio-settings.ts` (se esiste), `lib/fenice-autoreply.ts`, `lib/fenice-enroll.ts`, `supabase/migrations/`
- Leggere (CRM): `src/db/schema.ts`, `src/app/actions/lancioPoolActions.ts` (se esiste), `src/components/` (card lancio)
- Creare solo se serve (BOT): `supabase/migrations/20261001000001_lancio_b5_guard.sql`

**Interfaces:**
- Consumes: niente.
- Produces: la lista dei prerequisiti mancanti (nel messaggio di chiusura del task), e — se serve — la migrazione di riserva applicata.

- [ ] **Step 1: Controlla le colonne lancio nel bot**

Run (BOT): `grep -n "lancio_fase\|lancio_followup_inviato_at\|lancio_slug" lib/supabase/types.ts | head`
Expected: almeno tre righe (Row/Insert/Update di `conversations`). Se zero righe: crea `supabase/migrations/20261001000001_lancio_b5_guard.sql`:

```sql
-- Riserva del B5: le colonne del lancio dovevano arrivare col B0. Idempotente.
alter table conversations add column if not exists lancio_slug text;
alter table conversations add column if not exists lancio_fase text;
alter table conversations add column if not exists lancio_ingresso text;
alter table conversations add column if not exists lancio_link_inviato_at timestamptz;
alter table conversations add column if not exists lancio_followup_inviato_at timestamptz;
alter table conversations add column if not exists lancio_info jsonb;
create index if not exists conversations_lancio_fase_idx on conversations (lancio_fase) where lancio_slug is not null;
```

Applicala su Supabase (MCP `apply_migration` sul progetto del bot) **prima** di qualunque deploy, poi `npm run supabase:gen-types` e verifica che il grep sopra ora trovi le righe.

- [ ] **Step 2: Controlla helper impostazioni e ramo lancio del drain**

Run (BOT): `ls lib/lancio-settings.ts; grep -n "lancio" lib/fenice-autoreply.ts | head -20; grep -n "bot_outcome" lib/fenice-enroll.ts | head`
Expected: annota (a) se `lib/lancio-settings.ts` esiste e con quali firme; (b) la riga in cui il drain decide "questa conversazione è lancio" (servirà al Task 6); (c) se l'enroll lancio azzera `bot_outcome`. Nessuna modifica in questo step.

- [ ] **Step 3: Controlla lo schema CRM e la card**

Run (CRM): `grep -n "lancioScelta\|LANCIO_WEBDEV" src/db/schema.ts src/lib/*.ts src/app/actions/*.ts src/components/*.tsx | head -20`
Expected: `lancioScelta` presente in `leads`; una action di stato del pool lancio (nome atteso `getLancioWebdevPoolStatus`) e una card. Se `lancioScelta` manca: aggiungi a `leads` in `src/db/schema.ts`, dopo `launchBucket`, la riga `lancioScelta: text('lancioScelta'),` e crea `drizzle/<NNNN>_lancio_scelta.sql` con `ALTER TABLE leads ADD COLUMN IF NOT EXISTS "lancioScelta" text;` (numero = ultimo + 1 in `drizzle/`), applicandola a mano come le altre.

- [ ] **Step 4: Commit solo se hai creato file**

```bash
git add supabase/migrations/20261001000001_lancio_b5_guard.sql lib/supabase/types.ts
git commit -m "chore(lancio): migrazione di riserva delle colonne lancio (B5)"
```

(CRM, se toccato: `git add src/db/schema.ts drizzle/ && git commit -m "chore(lancio): colonna lancioScelta (riserva B5)"`.)

---

### Task 1 (BOT): `lib/lancio-settings.ts` — helper delle impostazioni del lancio

**Files:**
- Create (o allinea se esiste dal B1): `lib/lancio-settings.ts`
- Test: `lib/lancio-settings.test.ts`

**Interfaces:**
- Consumes: `app_settings` (tabella esistente: `key text pk, value jsonb, updated_at`), pattern di `lib/fenice-settings.ts`.
- Produces:
  - `LANCIO_SETTING_KEYS`, `type LancioSettingKey`, `type LancioSettings = Record<LancioSettingKey, string | null>`
  - `LANCIO_EDITABLE_KEYS` (le 4 chiavi modificabili da `/fenice`)
  - `normalizeSettingValue(v: unknown): string | null`
  - `isLancioAttivo(s: Pick<LancioSettings, 'lancio_attivo'>): boolean`
  - `validateLancioSettingInput(key: string, raw: unknown): { ok: true; value: string | null } | { ok: false; reason: 'chiave_non_modificabile' | 'link_non_https' | 'valore_non_valido' }`
  - `getLancioSettings(supabase): Promise<LancioSettings>`
  - `setLancioSetting(supabase, key: LancioSettingKey, value: string | null): Promise<void>`

Se il file esiste già dal B1 con le stesse due funzioni async, **aggiungi** solo le parti pure mancanti senza cambiare le firme esistenti.

- [ ] **Step 1: Scrivi il test che fallisce**

`lib/lancio-settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  LANCIO_SETTING_KEYS,
  LANCIO_EDITABLE_KEYS,
  normalizeSettingValue,
  isLancioAttivo,
  validateLancioSettingInput,
} from './lancio-settings';

describe('chiavi', () => {
  it('sono le cinque della spec §3.2', () => {
    expect([...LANCIO_SETTING_KEYS].sort()).toEqual(
      ['lancio_attivo', 'lancio_evento_at', 'lancio_video_live_link', 'lancio_zoom_link', 'offerta_del_mese_link'],
    );
  });
  it('lancio_evento_at non si modifica dalla pagina', () => {
    expect(LANCIO_EDITABLE_KEYS).not.toContain('lancio_evento_at');
    expect(LANCIO_EDITABLE_KEYS).toHaveLength(4);
  });
});

describe('normalizeSettingValue', () => {
  it('stringhe vuote e null diventano null, le altre si trimmano', () => {
    expect(normalizeSettingValue(null)).toBeNull();
    expect(normalizeSettingValue('   ')).toBeNull();
    expect(normalizeSettingValue('  https://x.it/a ')).toBe('https://x.it/a');
  });
  it('booleani e numeri (valori jsonb legacy) diventano stringhe', () => {
    expect(normalizeSettingValue(true)).toBe('1');
    expect(normalizeSettingValue(false)).toBe('0');
    expect(normalizeSettingValue(1)).toBe('1');
  });
  it('oggetti non sono un valore', () => {
    expect(normalizeSettingValue({ a: 1 })).toBeNull();
  });
});

describe('isLancioAttivo', () => {
  it("è acceso solo con '1'", () => {
    expect(isLancioAttivo({ lancio_attivo: '1' })).toBe(true);
    expect(isLancioAttivo({ lancio_attivo: '0' })).toBe(false);
    expect(isLancioAttivo({ lancio_attivo: null })).toBe(false);
  });
});

describe('validateLancioSettingInput', () => {
  it('rifiuta chiavi fuori lista', () => {
    expect(validateLancioSettingInput('fenice_ai_autoreply', 'x')).toEqual({ ok: false, reason: 'chiave_non_modificabile' });
    expect(validateLancioSettingInput('lancio_evento_at', '2026-10-05')).toEqual({ ok: false, reason: 'chiave_non_modificabile' });
  });
  it('i link devono essere https; vuoto = azzera', () => {
    expect(validateLancioSettingInput('offerta_del_mese_link', 'http://corso.feniceacademy.it/x')).toEqual({ ok: false, reason: 'link_non_https' });
    expect(validateLancioSettingInput('offerta_del_mese_link', 'ciao')).toEqual({ ok: false, reason: 'link_non_https' });
    expect(validateLancioSettingInput('lancio_video_live_link', ' https://corso.feniceacademy.it/live-webdev ')).toEqual({ ok: true, value: 'https://corso.feniceacademy.it/live-webdev' });
    expect(validateLancioSettingInput('lancio_zoom_link', '')).toEqual({ ok: true, value: null });
  });
  it("lancio_attivo accetta solo 0/1 (vuoto = 0)", () => {
    expect(validateLancioSettingInput('lancio_attivo', '1')).toEqual({ ok: true, value: '1' });
    expect(validateLancioSettingInput('lancio_attivo', true)).toEqual({ ok: true, value: '1' });
    expect(validateLancioSettingInput('lancio_attivo', '')).toEqual({ ok: true, value: '0' });
    expect(validateLancioSettingInput('lancio_attivo', 'on')).toEqual({ ok: false, reason: 'valore_non_valido' });
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run lib/lancio-settings.test.ts`
Expected: FAIL (modulo o export mancanti).

- [ ] **Step 3: Implementa `lib/lancio-settings.ts`**

```ts
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Impostazioni del lancio Web Developer AI (spec §3.2), in `app_settings` come
 * `fenice_ai_autoreply`. Bruno le cambia da /fenice/impostazioni senza deploy:
 * il link dell'offerta del mese e quello della live editata arrivano il 6 mattina
 * e dopo la live. I valori sono stringhe (o null = non impostato); `lancio_attivo`
 * è '0'/'1'.
 */
export const LANCIO_SETTING_KEYS = [
  'lancio_zoom_link',
  'lancio_video_live_link',
  'offerta_del_mese_link',
  'lancio_evento_at',
  'lancio_attivo',
] as const;
export type LancioSettingKey = (typeof LANCIO_SETTING_KEYS)[number];
export type LancioSettings = Record<LancioSettingKey, string | null>;

export const EMPTY_LANCIO_SETTINGS: LancioSettings = {
  lancio_zoom_link: null,
  lancio_video_live_link: null,
  offerta_del_mese_link: null,
  lancio_evento_at: null,
  lancio_attivo: null,
};

/** Le chiavi che la pagina /fenice/impostazioni può scrivere (§5.7). */
export const LANCIO_EDITABLE_KEYS = [
  'offerta_del_mese_link',
  'lancio_video_live_link',
  'lancio_zoom_link',
  'lancio_attivo',
] as const satisfies readonly LancioSettingKey[];

function isKey(k: string): k is LancioSettingKey {
  return (LANCIO_SETTING_KEYS as readonly string[]).includes(k);
}

/** Un valore jsonb qualunque → stringa trimmata o null. Booleani/numeri legacy diventano '1'/'0'/cifre. */
export function normalizeSettingValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(v);
  return null;
}

export function isLancioAttivo(s: Pick<LancioSettings, 'lancio_attivo'>): boolean {
  return s.lancio_attivo === '1';
}

export type SettingValidation =
  | { ok: true; value: string | null }
  | { ok: false; reason: 'chiave_non_modificabile' | 'link_non_https' | 'valore_non_valido' };

/** Regole di scrittura dalla pagina: solo chiavi modificabili, link https, interruttore 0/1. */
export function validateLancioSettingInput(key: string, raw: unknown): SettingValidation {
  if (!(LANCIO_EDITABLE_KEYS as readonly string[]).includes(key)) {
    return { ok: false, reason: 'chiave_non_modificabile' };
  }
  const value = normalizeSettingValue(raw);
  if (key === 'lancio_attivo') {
    if (value === null || value === '0') return { ok: true, value: '0' };
    if (value === '1') return { ok: true, value: '1' };
    return { ok: false, reason: 'valore_non_valido' };
  }
  if (value === null) return { ok: true, value: null };
  if (!/^https:\/\/\S+$/.test(value)) return { ok: false, reason: 'link_non_https' };
  return { ok: true, value };
}

export async function getLancioSettings(supabase: Supa): Promise<LancioSettings> {
  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', [...LANCIO_SETTING_KEYS]);
  const out: LancioSettings = { ...EMPTY_LANCIO_SETTINGS };
  for (const row of (data ?? []) as { key: string; value: unknown }[]) {
    if (isKey(row.key)) out[row.key] = normalizeSettingValue(row.value);
  }
  return out;
}

export async function setLancioSetting(supabase: Supa, key: LancioSettingKey, value: string | null): Promise<void> {
  await supabase
    .from('app_settings')
    .upsert({ key, value: value as never, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run lib/lancio-settings.test.ts`
Expected: PASS (tutti i casi).

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-settings.ts lib/lancio-settings.test.ts
git commit -m "feat(lancio): helper delle impostazioni del lancio in app_settings"
```

---

### Task 2 (BOT): `videoLinkForVariant` legge l'offerta del mese dalle impostazioni; mappa template dinamica

**Files:**
- Modify: `lib/gdo-agenda.ts` (righe 12–26: `BLACK_SUMMER_LINK`, `videoLinkForVariant`)
- Modify: `lib/gdo-video-followup.ts` (righe 176–182: `VIDEO_TEMPLATE_ENV_BY_LINK`)
- Modify: `lib/send-agenda-gdo.ts` (`runSendAgenda`: due chiamate a `videoLinkForVariant`, chiamata a `enrollGdoLeadAsPostino`)
- Modify: `lib/fenice-enroll.ts` (`GdoEnrollArgs` righe 180–187; `gdo_video_url` riga ~245)
- Modify: `app/api/cron/gdo-video-followups/route.ts` (ramo `video-template`, riga ~240)
- Test: `lib/gdo-agenda.test.ts`, `lib/gdo-video-followup.test.ts`, `lib/send-agenda-gdo.test.ts` (fake Supabase)

**Interfaces:**
- Consumes: `getLancioSettings(supabase)` e `type LancioSettings` (Task 1).
- Produces:
  - `type OffertaDelMeseSettings = { offerta_del_mese_link?: string | null }`
  - `resolveOffertaDelMeseLink(settings?: OffertaDelMeseSettings | null, env?: string | undefined): string` — impostazione → env `OFFERTA_DEL_MESE_LINK` → `BLACK_SUMMER_LINK`
  - `videoLinkForVariant(v: GdoVariant, settings?: OffertaDelMeseSettings | null): string`
  - `videoTemplateEnvForLink(link: string | null, offertaDelMeseLink: string): string | undefined` — il link dinamico dell'offerta mappa su `'VIDEO_GDO_OFFERTA_SID'`
  - `GdoEnrollArgs.gdoVideoUrl?: string` (se presente, vince sul calcolo dalla variante)

- [ ] **Step 1: Scrivi i test che falliscono**

In `lib/gdo-agenda.test.ts`, dentro `describe('videoLinkForVariant', …)` sostituisci il caso `'offertaDelMese prevale su lavora e famiglia'` e quello `'ogni link è nella whitelist…'` con:

```ts
  function withOffertaEnv(value: string | undefined, fn: () => void) {
    const prev = process.env.OFFERTA_DEL_MESE_LINK;
    if (value === undefined) delete process.env.OFFERTA_DEL_MESE_LINK;
    else process.env.OFFERTA_DEL_MESE_LINK = value;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.OFFERTA_DEL_MESE_LINK;
      else process.env.OFFERTA_DEL_MESE_LINK = prev;
    }
  }

  it('offertaDelMese prevale su lavora e famiglia e, senza impostazione né env, resta il Black Summer', () => {
    withOffertaEnv(undefined, () => {
      expect(videoLinkForVariant(V(true, true, true))).toBe(BLACK_SUMMER_LINK);
      expect(videoLinkForVariant(V(false, false, true))).toBe(BLACK_SUMMER_LINK);
    });
  });
  it('offertaDelMese legge prima l\'impostazione, poi la env', () => {
    withOffertaEnv('https://corso.feniceacademy.it/da-env', () => {
      expect(videoLinkForVariant(V(true, false, true), { offerta_del_mese_link: 'https://corso.feniceacademy.it/webdev-offerta' }))
        .toBe('https://corso.feniceacademy.it/webdev-offerta');
      expect(videoLinkForVariant(V(true, false, true), { offerta_del_mese_link: null })).toBe('https://corso.feniceacademy.it/da-env');
      expect(videoLinkForVariant(V(true, false, true), { offerta_del_mese_link: '   ' })).toBe('https://corso.feniceacademy.it/da-env');
    });
  });
  it('l\'impostazione non tocca le quattro varianti lavora/famiglia', () => {
    expect(videoLinkForVariant(V(true, false), { offerta_del_mese_link: 'https://corso.feniceacademy.it/webdev-offerta' }))
      .toBe('https://corso.feniceacademy.it/conferenza-bx');
  });
  it('i quattro link fissi e il Black Summer sono nella whitelist', () => {
    withOffertaEnv(undefined, () => {
      for (const variant of [V(true, false), V(false, false), V(true, true), V(false, true), V(true, true, true)]) {
        expect(KNOWN_LINKS as readonly string[]).toContain(videoLinkForVariant(variant));
      }
    });
  });
```

Aggiungi `resolveOffertaDelMeseLink` all'import e un blocco:

```ts
describe('resolveOffertaDelMeseLink', () => {
  it('ordine: impostazione, env, Black Summer', () => {
    expect(resolveOffertaDelMeseLink({ offerta_del_mese_link: 'https://a' }, 'https://b')).toBe('https://a');
    expect(resolveOffertaDelMeseLink({ offerta_del_mese_link: null }, 'https://b')).toBe('https://b');
    expect(resolveOffertaDelMeseLink(null, undefined)).toBe(BLACK_SUMMER_LINK);
    expect(resolveOffertaDelMeseLink(undefined, '  ')).toBe(BLACK_SUMMER_LINK);
  });
});
```

In `lib/gdo-video-followup.test.ts`, aggiungi `videoTemplateEnvForLink` all'import e dentro `describe('mappa dei template video', …)`:

```ts
  it('il link dinamico dell\'offerta mappa sul template offerta; un link ignoto resta senza template', () => {
    const offerta = 'https://corso.feniceacademy.it/webdev-offerta';
    expect(videoTemplateEnvForLink(offerta, offerta)).toBe('VIDEO_GDO_OFFERTA_SID');
    expect(videoTemplateEnvForLink('https://corso.feniceacademy.it/conferenza-bx', offerta)).toBe('VIDEO_GDO_LAVORA_SID');
    expect(videoTemplateEnvForLink('https://corso.feniceacademy.it/conferenza-black-summer', offerta)).toBe('VIDEO_GDO_OFFERTA_SID');
    expect(videoTemplateEnvForLink('https://corso.feniceacademy.it/boh', offerta)).toBeUndefined();
    expect(videoTemplateEnvForLink(null, offerta)).toBeUndefined();
  });
```

In `lib/send-agenda-gdo.test.ts`, nel fake `makeSupabase` aggiungi PRIMA del ramo `if (table === 'conversations')` la tabella delle impostazioni (così `getLancioSettings` non esplode sul fake):

```ts
      if (table === 'app_settings') {
        return {
          select() {
            return { in() { return Promise.resolve({ data: opts.settingsRows ?? [] }); } };
          },
        };
      }
```

e allarga la firma: `function makeSupabase(opts: { convPrecedente?: any; statusSequence?: (string | null)[]; settingsRows?: { key: string; value: unknown }[] } = {})`. Poi aggiungi un caso:

```ts
  it('con offerta del mese impostata, il video corretto della deduplica è quello impostato', async () => {
    const { supabase, calls } = makeSupabase({
      convPrecedente: { id: 7, gdo_agenda_at: new Date(Date.now() - 60_000).toISOString(), gdo_agenda_esito: 'consegnato', gdo_video_url: 'https://corso.feniceacademy.it/conferenza-bx', gdo_video_sent_at: null },
      settingsRows: [{ key: 'offerta_del_mese_link', value: 'https://corso.feniceacademy.it/webdev-offerta' }],
    });
    const res = await runSendAgenda(supabase, { ...PAYLOAD, variant: { lavora: true, haFamiglia: false, offertaDelMese: true } });
    expect(res.deduplicato).toBe(true);
    expect(res.varianteAggiornata).toBe(true);
    expect(calls.updates.some((u) => u.gdo_video_url === 'https://corso.feniceacademy.it/webdev-offerta')).toBe(true);
  });
  it('passa all\'arruolamento il link del video già risolto', async () => {
    const { supabase } = makeSupabase({ settingsRows: [{ key: 'offerta_del_mese_link', value: 'https://corso.feniceacademy.it/webdev-offerta' }] });
    await runSendAgenda(supabase, { ...PAYLOAD, variant: { lavora: false, haFamiglia: false, offertaDelMese: true } });
    const args = (enrollGdoLeadAsPostino as any).mock.calls.at(-1)[1];
    expect(args.gdoVideoUrl).toBe('https://corso.feniceacademy.it/webdev-offerta');
  });
```

(Se il test esistente sulla deduplica passa un `convPrecedente` con campi diversi, copia la forma di quello.)

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run lib/gdo-agenda.test.ts lib/gdo-video-followup.test.ts lib/send-agenda-gdo.test.ts`
Expected: FAIL (`resolveOffertaDelMeseLink`/`videoTemplateEnvForLink` non esportati; `gdoVideoUrl` undefined).

- [ ] **Step 3: Implementa in `lib/gdo-agenda.ts`**

Sostituisci il blocco da `/** Video dell'offerta del mese …` a fine `videoLinkForVariant` con:

```ts
/** Video dell'offerta del mese: prevale su lavora/famiglia. Ripiego finale quando
 *  né `app_settings.offerta_del_mese_link` né la env sono impostati. */
export const BLACK_SUMMER_LINK = 'https://corso.feniceacademy.it/conferenza-black-summer';

const VIDEO_BY_PROFILO = {
  lavora: 'https://corso.feniceacademy.it/conferenza-bx',
  nonLavora: 'https://corso.feniceacademy.it/conferenza-axmsbn9r50',
  lavoraFamiglia: 'https://corso.feniceacademy.it/conferenza-dx',
  nonLavoraFamiglia: 'https://corso.feniceacademy.it/conferenza-ex',
} as const;

/** Il pezzo di `LancioSettings` che serve qui: il modulo resta client-safe e puro. */
export type OffertaDelMeseSettings = { offerta_del_mese_link?: string | null };

/**
 * Il link dell'offerta del mese (spec §5.7): impostazione da /fenice, poi env
 * `OFFERTA_DEL_MESE_LINK`, poi il Black Summer finché Bruno non imposta il nuovo.
 */
export function resolveOffertaDelMeseLink(
  settings?: OffertaDelMeseSettings | null,
  env: string | undefined = process.env.OFFERTA_DEL_MESE_LINK,
): string {
  const fromSettings = settings?.offerta_del_mese_link?.trim();
  if (fromSettings) return fromSettings;
  const fromEnv = env?.trim();
  if (fromEnv) return fromEnv;
  return BLACK_SUMMER_LINK;
}

/** Il video da mandare al lead, dal profilo raccolto dal GDO al telefono. */
export function videoLinkForVariant(v: GdoVariant, settings?: OffertaDelMeseSettings | null): string {
  if (v.offertaDelMese) return resolveOffertaDelMeseLink(settings);
  if (v.haFamiglia) return v.lavora ? VIDEO_BY_PROFILO.lavoraFamiglia : VIDEO_BY_PROFILO.nonLavoraFamiglia;
  return v.lavora ? VIDEO_BY_PROFILO.lavora : VIDEO_BY_PROFILO.nonLavora;
}
```

- [ ] **Step 4: Implementa in `lib/gdo-video-followup.ts`**

Dopo `VIDEO_TEMPLATE_ENV_BY_LINK` aggiungi:

```ts
/**
 * Come la mappa sopra, ma con il link dell'offerta del mese letto a runtime
 * (`resolveOffertaDelMeseLink`): il link cambia da /fenice senza deploy, il template
 * resta `VIDEO_GDO_OFFERTA_SID`. Fail-closed identico alla mappa statica.
 */
export function videoTemplateEnvForLink(link: string | null, offertaDelMeseLink: string): string | undefined {
  if (!link) return undefined;
  if (link === offertaDelMeseLink) return 'VIDEO_GDO_OFFERTA_SID';
  return VIDEO_TEMPLATE_ENV_BY_LINK[link];
}
```

- [ ] **Step 5: Collega i chiamanti**

`lib/fenice-enroll.ts`: in `GdoEnrollArgs` aggiungi `/** Link video già risolto dal chiamante (offerta del mese da impostazione). Se assente si calcola dalla variante. */ gdoVideoUrl?: string;` e alla riga `gdo_video_url: videoLinkForVariant(args.variant),` scrivi `gdo_video_url: args.gdoVideoUrl ?? videoLinkForVariant(args.variant),`.

`lib/send-agenda-gdo.ts`: aggiungi `import { getLancioSettings } from './lancio-settings';`. In `runSendAgenda`, subito dopo il controllo del telefono (`if (!phone) {…}`), inserisci:

```ts
  // Il link dell'offerta del mese è un'impostazione (spec §5.7): si legge una volta
  // per richiesta e vale sia per la deduplica sia per l'arruolamento.
  const settings = await getLancioSettings(supabase);
```

poi `const videoCorretto = videoLinkForVariant(payload.variant, settings);` e nella chiamata `enrollGdoLeadAsPostino(supabase, { … variant: payload.variant, gdoVideoUrl: videoLinkForVariant(payload.variant, settings) })`.

`app/api/cron/gdo-video-followups/route.ts`: importa `getLancioSettings` da `@/lib/lancio-settings`, `resolveOffertaDelMeseLink` da `@/lib/gdo-agenda` e `videoTemplateEnvForLink` da `@/lib/gdo-video-followup` (togli `VIDEO_TEMPLATE_ENV_BY_LINK` dall'import). Dopo `const supabase = getSupabaseAdmin();` aggiungi `const offertaLink = resolveOffertaDelMeseLink(await getLancioSettings(supabase));` e nel ramo `video-template` sostituisci `const envName = link ? VIDEO_TEMPLATE_ENV_BY_LINK[link] : undefined;` con `const envName = videoTemplateEnvForLink(link, offertaLink);`.

- [ ] **Step 6: Esegui i test e verifica che passino**

Run: `npx vitest run lib/gdo-agenda.test.ts lib/gdo-video-followup.test.ts lib/send-agenda-gdo.test.ts lib/fenice-enroll.test.ts && npx tsc --noEmit`
Expected: PASS, nessun errore di tipo.

- [ ] **Step 7: Commit**

```bash
git add lib/gdo-agenda.ts lib/gdo-agenda.test.ts lib/gdo-video-followup.ts lib/gdo-video-followup.test.ts lib/send-agenda-gdo.ts lib/send-agenda-gdo.test.ts lib/fenice-enroll.ts app/api/cron/gdo-video-followups/route.ts
git commit -m "feat(offerta): il video dell'offerta del mese arriva dalle impostazioni, non dal codice"
```

---

### Task 3 (BOT): link dinamici nella whitelist in uscita e nel blocco di conferma

**Files:**
- Modify: `lib/outbound-sanitize.ts` (`unknownFeniceLinks`, riga 42)
- Modify: `lib/confirmation-block.ts` (`containsVideoLink` riga 19, `ensureConfirmationBlock` riga 60)
- Test: `lib/outbound-sanitize.test.ts`, `lib/confirmation-block.test.ts` (aggiungi i casi ai file esistenti; se non esistono, creali con il solo blocco sotto)

**Interfaces:**
- Consumes: niente di nuovo.
- Produces:
  - `unknownFeniceLinks(text: string, extraKnown?: readonly string[]): string[]`
  - `containsVideoLink(p: string, extraVideoLinks?: readonly string[]): boolean`
  - `ensureConfirmationBlock(parts: string[], opts?: { extraVideoLinks?: readonly string[] })` — stesso ritorno di oggi

Motivo: il video della live (`lancio_video_live_link`) e l'offerta del mese sono link Fenice non presenti in `KNOWN_LINKS`; senza questo il drain li segnalerebbe come "inventati" e il blocco di conferma direbbe "link video assente".

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
// lib/outbound-sanitize.test.ts (aggiungi)
import { describe, it, expect } from 'vitest';
import { unknownFeniceLinks } from './outbound-sanitize';

describe('unknownFeniceLinks con link extra', () => {
  const live = 'https://corso.feniceacademy.it/live-webdev-2026';
  it('un link extra noto non è più inventato', () => {
    expect(unknownFeniceLinks(`ecco il video ${live}`, [live])).toEqual([]);
    expect(unknownFeniceLinks(`ecco il video ${live}`)).toEqual([live]);
  });
  it('gli altri link ignoti restano segnalati', () => {
    expect(unknownFeniceLinks(`${live} e https://corso.feniceacademy.it/conferenza-zx`, [live]))
      .toEqual(['https://corso.feniceacademy.it/conferenza-zx']);
  });
});
```

```ts
// lib/confirmation-block.test.ts (aggiungi)
import { describe, it, expect } from 'vitest';
import { containsVideoLink, ensureConfirmationBlock } from './confirmation-block';

describe('blocco di conferma con video extra', () => {
  const live = 'https://corso.feniceacademy.it/live-webdev-2026';
  it('containsVideoLink riconosce il link extra', () => {
    expect(containsVideoLink(`guarda ${live}`)).toBe(false);
    expect(containsVideoLink(`guarda ${live}`, [live])).toBe(true);
  });
  it('ensureConfirmationBlock non segnala il video assente se il link extra c\'è', () => {
    const res = ensureConfirmationBlock([`Ecco il video ${live}`], { extraVideoLinks: [live] });
    expect(res.missingVideoLink).toBe(false);
    expect(res.parts.some((p) => /\bFATTO\b/.test(p))).toBe(true);
  });
});
```

- [ ] **Step 2: Esegui e verifica che falliscano**

Run: `npx vitest run lib/outbound-sanitize.test.ts lib/confirmation-block.test.ts`
Expected: FAIL (argomenti in più ignorati → asserzioni false).

- [ ] **Step 3: Implementa**

`lib/outbound-sanitize.ts`:

```ts
/** Link Fenice nel testo che non sono fra quelli ufficiali. `extraKnown` sono i link
 *  che arrivano da impostazioni a runtime (live editata, offerta del mese): per quella
 *  conversazione sono ufficiali quanto gli altri. */
export function unknownFeniceLinks(text: string, extraKnown: readonly string[] = []): string[] {
  const found = text.match(FENICE_LINK_RE) ?? [];
  const cleaned = found.map((u) => u.replace(TRAILING_PUNCT_RE, ''));
  return cleaned.filter((u) => !(KNOWN_LINKS as readonly string[]).includes(u) && !extraKnown.includes(u));
}
```

`lib/confirmation-block.ts`:

```ts
export const containsVideoLink = (p: string, extraVideoLinks: readonly string[] = []) =>
  VIDEO_LINKS.some((l) => p.includes(l)) || extraVideoLinks.some((l) => l && p.includes(l));

export function ensureConfirmationBlock(
  parts: string[],
  opts: { extraVideoLinks?: readonly string[] } = {},
): { parts: string[]; added: string[]; missingVideoLink: boolean } {
  const extra = opts.extraVideoLinks ?? [];
  const hasVideo = (p: string) => containsVideoLink(p, extra);
  const out = [...parts];
  const added: string[] = [];

  const videoIdx = out.findIndex(hasVideo);
  // … resto identico (usa `videoIdx`), niente altro cambia …
```

(Rimuovi la costante `const hasVideoLink = containsVideoLink;` e usa `hasVideo` al suo posto dentro la funzione.)

- [ ] **Step 4: Esegui e verifica che passino**

Run: `npx vitest run lib/outbound-sanitize.test.ts lib/confirmation-block.test.ts lib/fenice-autoreply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/outbound-sanitize.ts lib/outbound-sanitize.test.ts lib/confirmation-block.ts lib/confirmation-block.test.ts
git commit -m "feat(lancio): i link video da impostazione sono ufficiali per sanitizzazione e blocco di conferma"
```

---

### Task 4 (BOT): `lib/lancio-followup.ts` — selezione pura dei bersagli del follow-up

**Files:**
- Create: `lib/lancio-followup.ts`
- Test: `lib/lancio-followup.test.ts`

**Interfaces:**
- Consumes: `romeDayKey`, `romeHour`, `romeMinute` da `./rome-time`; `templateName` da `./name`.
- Produces:
  - `LANCIO_BATCH_MAX = 250`
  - `LANCIO_FOLLOWUP_DAYS = ['2026-10-06', '2026-10-07']`
  - `FASI_FOLLOWUP = ['attesa', 'posto_bloccato', 'link_inviato']`
  - `isLancioFollowupWindow(now: Date): boolean`
  - `haInteragito(c: { last_inbound_at: string | null; ai_started_at: string | null }): boolean`
  - `type FollowupCandidate = { id: number; lancio_fase: string | null; lancio_followup_inviato_at: string | null; last_inbound_at: string | null; ai_started_at: string | null }`
  - `selectFollowupTargets<T extends FollowupCandidate>(rows: T[], max?: number): T[]`
  - `isLancioStandardFlow(fase: string | null | undefined): boolean` — `followup_inviato | chiuso`
  - `lancioStandardContextNote(videoLiveLink: string | null): string | null`
  - `lancioFollowupText(name: string | null | undefined): string` — testo del template §7.3, per il pannello

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// lib/lancio-followup.test.ts
import { describe, it, expect } from 'vitest';
import {
  LANCIO_BATCH_MAX,
  isLancioFollowupWindow,
  haInteragito,
  selectFollowupTargets,
  isLancioStandardFlow,
  lancioStandardContextNote,
  lancioFollowupText,
  type FollowupCandidate,
} from './lancio-followup';

const utc = (iso: string) => new Date(iso);

describe('isLancioFollowupWindow (Rome = UTC+2 a ottobre, ora legale fino al 25/10)', () => {
  it('6/10: 12:00–14:00 e 17:30–19:30 Rome sono dentro', () => {
    expect(isLancioFollowupWindow(utc('2026-10-06T10:00:00Z'))).toBe(true);  // 12:00
    expect(isLancioFollowupWindow(utc('2026-10-06T11:50:00Z'))).toBe(true);  // 13:50
    expect(isLancioFollowupWindow(utc('2026-10-06T15:30:00Z'))).toBe(true);  // 17:30
    expect(isLancioFollowupWindow(utc('2026-10-06T17:30:00Z'))).toBe(true);  // 19:30 incluso
  });
  it('fuori dalle fasce, anche dentro le ore UTC dello schedule, è fuori', () => {
    expect(isLancioFollowupWindow(utc('2026-10-06T15:20:00Z'))).toBe(false); // 17:20
    expect(isLancioFollowupWindow(utc('2026-10-06T17:40:00Z'))).toBe(false); // 19:40
    expect(isLancioFollowupWindow(utc('2026-10-06T09:50:00Z'))).toBe(false); // 11:50
  });
  it('vale il 6 e il 7, non il 5 né l\'8', () => {
    expect(isLancioFollowupWindow(utc('2026-10-07T10:00:00Z'))).toBe(true);
    expect(isLancioFollowupWindow(utc('2026-10-05T10:00:00Z'))).toBe(false);
    expect(isLancioFollowupWindow(utc('2026-10-08T10:00:00Z'))).toBe(false);
  });
});

describe('haInteragito', () => {
  it('senza inbound non ha interagito', () => {
    expect(haInteragito({ last_inbound_at: null, ai_started_at: '2026-09-20T10:00:00Z' })).toBe(false);
  });
  it('un inbound dopo l\'arruolamento conta (con 5 minuti di tolleranza)', () => {
    expect(haInteragito({ last_inbound_at: '2026-09-21T10:00:00Z', ai_started_at: '2026-09-20T10:00:00Z' })).toBe(true);
    expect(haInteragito({ last_inbound_at: '2026-09-20T09:56:00Z', ai_started_at: '2026-09-20T10:00:00Z' })).toBe(true);
  });
  it('un inbound di un funnel precedente, prima dell\'arruolamento, non conta', () => {
    expect(haInteragito({ last_inbound_at: '2026-06-01T10:00:00Z', ai_started_at: '2026-09-20T10:00:00Z' })).toBe(false);
  });
  it('senza ai_started_at qualunque inbound conta', () => {
    expect(haInteragito({ last_inbound_at: '2026-06-01T10:00:00Z', ai_started_at: null })).toBe(true);
  });
});

describe('selectFollowupTargets', () => {
  const row = (id: number, over: Partial<FollowupCandidate> = {}): FollowupCandidate => ({
    id,
    lancio_fase: 'attesa',
    lancio_followup_inviato_at: null,
    last_inbound_at: '2026-10-05T20:00:00Z',
    ai_started_at: '2026-09-20T10:00:00Z',
    ...over,
  });
  it('prende attesa/posto_bloccato/link_inviato con inbound e senza follow-up, in ordine di id', () => {
    const out = selectFollowupTargets([row(3, { lancio_fase: 'link_inviato' }), row(1, { lancio_fase: 'posto_bloccato' }), row(2)]);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3]);
  });
  it('salta chi non ha mai scritto', () => {
    expect(selectFollowupTargets([row(1, { last_inbound_at: null })])).toEqual([]);
  });
  it('salta chi ha già il follow-up e le fasi fuori perimetro', () => {
    expect(selectFollowupTargets([
      row(1, { lancio_followup_inviato_at: '2026-10-06T10:00:00Z' }),
      row(2, { lancio_fase: 'post_pitch' }),
      row(3, { lancio_fase: 'scelta_fatta' }),
      row(4, { lancio_fase: 'chiuso' }),
      row(5, { lancio_fase: 'restituito' }),
      row(6, { lancio_fase: null }),
    ])).toEqual([]);
  });
  it('rispetta il tetto per run', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i + 1));
    expect(selectFollowupTargets(rows)).toHaveLength(LANCIO_BATCH_MAX);
    expect(selectFollowupTargets(rows, 10).map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(LANCIO_BATCH_MAX).toBe(250);
  });
});

describe('flusso standard dopo il follow-up', () => {
  it('followup_inviato e chiuso vanno al flusso Mario standard, le altre fasi no', () => {
    expect(isLancioStandardFlow('followup_inviato')).toBe(true);
    expect(isLancioStandardFlow('chiuso')).toBe(true);
    for (const f of ['attesa', 'posto_bloccato', 'link_inviato', 'post_pitch', 'scelta_fatta', 'restituito', null, undefined]) {
      expect(isLancioStandardFlow(f)).toBe(false);
    }
  });
  it('la nota di contesto porta il link della live e sostituisce i quattro video', () => {
    const nota = lancioStandardContextNote('https://corso.feniceacademy.it/live-webdev-2026');
    expect(nota).toContain('https://corso.feniceacademy.it/live-webdev-2026');
    expect(nota).toMatch(/conferenza-\*/);
    expect(lancioStandardContextNote(null)).toBeNull();
    expect(lancioStandardContextNote('  ')).toBeNull();
  });
  it('il testo del follow-up è quello del template approvato (§7.3)', () => {
    expect(lancioFollowupText('Anna Verdi')).toBe(
      'Ciao Anna, ieri sera alla live abbiamo presentato il percorso Web Developer AI. Ti va di parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live.',
    );
  });
});
```

- [ ] **Step 2: Esegui e verifica che fallisca**

Run: `npx vitest run lib/lancio-followup.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 3: Implementa `lib/lancio-followup.ts`**

```ts
import { romeDayKey, romeHour, romeMinute } from './rome-time';
import { templateName } from './name';

/**
 * Follow-up del 6 ottobre (spec §5.5): a chi ha interagito col bot prima della live
 * ma non ha premuto il pulsante. Qui la sola selezione, senza effetti: il cron
 * `/api/cron/lancio-followup` la usa e agisce.
 */

/** Conversazioni per run: 250 ogni 10 minuti ≈ 3.000 per fascia (numero a qualità LOW). */
export const LANCIO_BATCH_MAX = 250;

/** Giorni di calendario italiani in cui il follow-up può partire. */
export const LANCIO_FOLLOWUP_DAYS = ['2026-10-06', '2026-10-07'] as const;

/** Fasi che ricevono il follow-up. `post_pitch`/`scelta_fatta` hanno già scelto. */
export const FASI_FOLLOWUP = ['attesa', 'posto_bloccato', 'link_inviato'] as const;

/**
 * Le due fasce Rome: 12:00–14:00 e 17:30–19:30 (estremi inclusi). Lo schedule UTC
 * `*/10 10-11,15-17 6-7 10 *` copre 12:00–13:50 e 17:00–19:50 Rome (ora legale, +2):
 * il filtro fine sta qui, così il cambio d'ora del 25/10 non sposta niente.
 */
export function isLancioFollowupWindow(now: Date): boolean {
  if (!(LANCIO_FOLLOWUP_DAYS as readonly string[]).includes(romeDayKey(now))) return false;
  const h = romeHour(now);
  const m = romeMinute(now);
  if (h === 12 || h === 13) return true;
  if (h === 14 && m === 0) return true;
  if (h === 17 && m >= 30) return true;
  if (h === 18) return true;
  if (h === 19 && m <= 30) return true;
  return false;
}

/** L'enroll inserisce l'apertura PRIMA di scrivere ai_started_at: stesso buffer degli altri cron. */
export const INBOUND_BUFFER_MS = 5 * 60_000;

/**
 * "Ha interagito" = almeno un messaggio del lead da quando è nel lancio. Una
 * conversazione riusata da un funnel precedente ha `last_inbound_at` vecchio: quello
 * non conta. Senza `ai_started_at` (riga anomala) vale qualunque inbound.
 */
export function haInteragito(c: { last_inbound_at: string | null; ai_started_at: string | null }): boolean {
  if (!c.last_inbound_at) return false;
  const inboundMs = Date.parse(c.last_inbound_at);
  if (Number.isNaN(inboundMs)) return false;
  if (!c.ai_started_at) return true;
  const startMs = Date.parse(c.ai_started_at);
  if (Number.isNaN(startMs)) return true;
  return inboundMs >= startMs - INBOUND_BUFFER_MS;
}

export type FollowupCandidate = {
  id: number;
  lancio_fase: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  ai_started_at: string | null;
};

/** Chi riceve il follow-up in questo run, in ordine di id, fino a `max`. */
export function selectFollowupTargets<T extends FollowupCandidate>(rows: T[], max: number = LANCIO_BATCH_MAX): T[] {
  return rows
    .filter((r) => r.lancio_fase !== null && (FASI_FOLLOWUP as readonly string[]).includes(r.lancio_fase))
    .filter((r) => r.lancio_followup_inviato_at === null)
    .filter(haInteragito)
    .sort((a, b) => a.id - b.id)
    .slice(0, Math.max(0, max));
}

/**
 * Dopo il follow-up la chat è di Mario standard (§5.5): `followup_inviato` (sta
 * per rispondere) e `chiuso` (ha risposto). Le altre fasi restano del prompt lancio.
 * Chi decide l'instradamento nel drain usa QUESTA funzione, non un confronto a mano.
 */
export function isLancioStandardFlow(fase: string | null | undefined): boolean {
  return fase === 'followup_inviato' || fase === 'chiuso';
}

/**
 * Nota di contesto per `generateMarioReply`: l'unica differenza dal flusso standard è
 * il video, che è la live editata. Null se Bruno non ha ancora impostato il link: in
 * quel caso Mario usa i quattro video classici (meglio un video che nessun video).
 */
export function lancioStandardContextNote(videoLiveLink: string | null): string | null {
  const link = videoLiveLink?.trim();
  if (!link) return null;
  return [
    'CONTESTO LANCIO WEB DEVELOPER AI: questo lead era iscritto alla live del 5 ottobre e ha risposto al nostro messaggio del giorno dopo.',
    `Il video di preparazione da mandargli è UNO SOLO ed è la registrazione della live: ${link}`,
    'Usa questo link al posto dei quattro link conferenza-* del blocco sul video, in ogni punto in cui manderesti il video. Non serve chiedere se lavora o ha famiglia per scegliere il video: il video è questo.',
    'Nel messaggio gli abbiamo promesso "il video riassuntivo della live": se lo chiede, mandaglielo subito, anche prima di fissare la call.',
  ].join('\n');
}

/**
 * Testo del template `LANCIO_FOLLOWUP_TEMPLATE_SID` (spec §7.3), replicato perché la
 * cronologia mostri il messaggio vero e non `{{1}}`. Deve restare identico al
 * template approvato da Meta.
 */
export function lancioFollowupText(name: string | null | undefined): string {
  return (
    `Ciao ${templateName(name)}, ieri sera alla live abbiamo presentato il percorso Web Developer AI. ` +
    'Ti va di parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live.'
  );
}
```

- [ ] **Step 4: Esegui e verifica che passi**

Run: `npx vitest run lib/lancio-followup.test.ts`
Expected: PASS. (Se `templateName('Anna Verdi')` non restituisce `Anna`, guarda `lib/name.ts` e adegua il test al comportamento reale di `templateName`, non il contrario.)

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-followup.ts lib/lancio-followup.test.ts
git commit -m "feat(lancio): selezione pura dei bersagli del follow-up del 6 e finestra oraria"
```

---

### Task 5 (BOT): cron `/api/cron/lancio-followup` + schedule

**Files:**
- Create: `app/api/cron/lancio-followup/route.ts`
- Create: `lib/run-pool.ts` (se il B4 non l'ha già creato: cerca `export async function runPool` in `lib/`)
- Modify: `lib/messaging.ts` (aggiungi `sendTemplateAndLogConCap`; se il B4 ha già un helper con gestione 63049 in `lib/`, usa quello e non duplicare)
- Modify: `vercel.json`
- Test: `lib/run-pool.test.ts`

**Interfaces:**
- Consumes: Task 1 (`getLancioSettings`, `isLancioAttivo`), Task 4 (tutto), `sendTemplate`/`getTemplateBody` da `./twilio`, `templateName` da `./name`.
- Produces:
  - `runPool<T, R>(items: T[], concurrency: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]>`
  - `sendTemplateAndLogConCap(supabase, conversationId, phone, templateSid, label, from, variables, bodyOverride?): Promise<{ ok: boolean; sid?: string; capped?: boolean; error?: string }>` — su 63049 non scrive nessun messaggio e torna `capped: true`
  - route `GET /api/cron/lancio-followup?secret=…[&dry=1][&forza=1][&max=N]` → JSON `{ ok, skipped? | candidati, targets, sent, capped, failed, riparati }`

- [ ] **Step 1: Test di `runPool`**

```ts
// lib/run-pool.test.ts
import { describe, it, expect } from 'vitest';
import { runPool } from './run-pool';

describe('runPool', () => {
  it('rispetta la concorrenza e restituisce i risultati nell\'ordine degli input', async () => {
    let inCorso = 0;
    let picco = 0;
    const out = await runPool([30, 10, 20], 2, async (ms) => {
      inCorso++; picco = Math.max(picco, inCorso);
      await new Promise((r) => setTimeout(r, ms));
      inCorso--;
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40]);
    expect(picco).toBe(2);
  });
  it('lista vuota → nessun worker', async () => {
    let chiamate = 0;
    expect(await runPool([], 5, async () => { chiamate++; })).toEqual([]);
    expect(chiamate).toBe(0);
  });
});
```

Run: `npx vitest run lib/run-pool.test.ts` → Expected: FAIL (modulo mancante).

- [ ] **Step 2: `lib/run-pool.ts`**

```ts
/** Esegue `worker` su `items` con al più `concurrency` promesse in volo; risultati
 *  nell'ordine degli input. Copia esportata del pool di `send-batch` (13/07). */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
```

Run: `npx vitest run lib/run-pool.test.ts` → Expected: PASS.

- [ ] **Step 3: `sendTemplateAndLogConCap` in `lib/messaging.ts`**

Sotto `sendTemplateAndLog` aggiungi (stessa logica di `sendSequenceTemplate` in `sequence-touches`, resa riusabile):

```ts
/**
 * Come `sendTemplateAndLog`, ma con il frequency cap Meta (63049): in quel caso NON
 * inserisce nessun messaggio, non tocca la conversazione e torna `capped: true` — chi
 * chiama lascia intatto il proprio marcatore e riprova al run dopo. Nato per il
 * lancio (blast e follow-up su un numero a qualità LOW).
 */
export async function sendTemplateAndLogConCap(
  supabase: Supa,
  conversationId: number,
  phone: string,
  templateSid: string,
  label: string,
  from?: string,
  variables: Record<string, string> = {},
  bodyOverride?: string,
): Promise<{ ok: boolean; sid?: string; capped?: boolean; error?: string }> {
  const tplBody = bodyOverride ?? (await getTemplateBody(templateSid)) ?? `[template] ${label}`;
  try {
    const sent = await sendTemplate({ to: phone, contentSid: templateSid, variables, from });
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_sid: sent.sid,
      twilio_status: sent.status,
      template_sid: templateSid,
      is_template: true,
      sender: 'automazione',
    });
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId);
    return { ok: true, sid: sent.sid };
  } catch (err: unknown) {
    const e = err as { message?: string; code?: number };
    if (e?.code === 63049) return { ok: false, capped: true };
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      direction: 'out',
      body: tplBody,
      twilio_status: 'failed',
      twilio_error_code: e?.code ?? null,
      template_sid: templateSid,
      is_template: true,
      sender: 'automazione',
    });
    return { ok: false, error: e?.message ?? 'unknown' };
  }
}
```

- [ ] **Step 4: Il route**

`app/api/cron/lancio-followup/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings, isLancioAttivo } from '@/lib/lancio-settings';
import {
  FASI_FOLLOWUP,
  LANCIO_BATCH_MAX,
  isLancioFollowupWindow,
  lancioFollowupText,
  selectFollowupTargets,
  type FollowupCandidate,
} from '@/lib/lancio-followup';
import { sendTemplateAndLogConCap } from '@/lib/messaging';
import { runPool } from '@/lib/run-pool';
import { templateName } from '@/lib/name';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Follow-up del 6 ottobre (spec §5.5): ogni 10 minuti nelle fasce 12-14 e 17:30-19:30
// Rome del 6 e del 7, a chi ha interagito prima della live e non ha premuto il
// pulsante. Template (finestra 24h chiusa da giorni), 250 per run, 5 in parallelo.
// Idempotenza doppia: `lancio_followup_inviato_at` + template_sid nei messages.

const CONCURRENCY = 5;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

type Candidate = FollowupCandidate & { leads?: { phone_e164?: string | null; first_name?: string | null } | null };

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const sp = req.nextUrl.searchParams;
  const dry = sp.get('dry') === '1';
  // QA della prova generale (B6): salta la finestra oraria. MAI la guardia lancio_attivo.
  const forza = sp.get('forza') === '1';
  const maxRaw = parseInt(sp.get('max') ?? '', 10);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, LANCIO_BATCH_MAX) : LANCIO_BATCH_MAX;

  const now = new Date();
  if (!forza && !isLancioFollowupWindow(now)) {
    return NextResponse.json({ ok: true, skipped: 'fuori fascia' });
  }

  const supabase = getSupabaseAdmin();
  const settings = await getLancioSettings(supabase);
  if (!isLancioAttivo(settings)) return NextResponse.json({ ok: true, skipped: 'lancio_attivo=0' });

  const sid = process.env.LANCIO_FOLLOWUP_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!sid || !from) {
    await supabase.from('event_log').insert({
      type: 'lancio_config_error',
      payload: { missing: !sid ? 'LANCIO_FOLLOWUP_TEMPLATE_SID' : 'TWILIO_WHATSAPP_NUMBER_FENICE' } as never,
      message: '[lancio] follow-up: configurazione mancante, run saltato',
      level: 'error',
    });
    return NextResponse.json({ ok: true, skipped: 'config' });
  }

  // Il grosso del filtro sta nel DB; la regola fine (inbound dopo l'arruolamento,
  // ordine, tetto) in selectFollowupTargets. 2000 righe bastano: il tetto è 250.
  const { data } = await supabase
    .from('conversations')
    .select('id, lancio_fase, lancio_followup_inviato_at, last_inbound_at, ai_started_at, leads(phone_e164, first_name)')
    .not('lancio_slug', 'is', null)
    .in('lancio_fase', [...FASI_FOLLOWUP])
    .is('lancio_followup_inviato_at', null)
    .not('last_inbound_at', 'is', null)
    .is('ai_paused_at', null)
    .order('id', { ascending: true })
    .limit(2000);
  const candidati = (data ?? []) as unknown as Candidate[];
  const targets = selectFollowupTargets(candidati, max);

  // Seconda difesa: template già partito (non fallito) ma colonna non scritta (run
  // morto a metà) ⇒ si ripara la colonna e non si rimanda.
  const ids = targets.map((t) => t.id);
  const giaSet = new Set<number>();
  if (ids.length > 0) {
    const { data: gia } = await supabase
      .from('messages')
      .select('conversation_id')
      .in('conversation_id', ids)
      .eq('template_sid', sid)
      .eq('direction', 'out')
      .not('twilio_status', 'in', '(failed,undelivered)');
    for (const m of (gia ?? []) as { conversation_id: number | null }[]) if (m.conversation_id != null) giaSet.add(m.conversation_id);
  }

  if (dry) {
    return NextResponse.json({ ok: true, dry: true, candidati: candidati.length, targets: targets.length, giaInviati: giaSet.size });
  }

  let sent = 0, capped = 0, failed = 0, riparati = 0;
  await runPool(targets, CONCURRENCY, async (c) => {
    const nowIso = new Date().toISOString();
    if (giaSet.has(c.id)) {
      await supabase.from('conversations')
        .update({ lancio_fase: 'followup_inviato', lancio_followup_inviato_at: nowIso })
        .eq('id', c.id);
      riparati++;
      return;
    }
    const phone = c.leads?.phone_e164 ?? null;
    if (!phone) { failed++; return; }
    const nome = c.leads?.first_name ?? null;
    const res = await sendTemplateAndLogConCap(
      supabase, c.id, phone, sid, 'follow-up lancio', from,
      { '1': templateName(nome) },
      lancioFollowupText(nome),
    );
    if (res.capped) { capped++; return; } // 63049: colonna intatta, riprova al run dopo
    if (!res.ok) { failed++; return; }
    await supabase.from('conversations')
      .update({ lancio_fase: 'followup_inviato', lancio_followup_inviato_at: nowIso })
      .eq('id', c.id);
    await supabase.from('event_log').insert({
      type: 'lancio_followup_inviato',
      payload: { conversationId: c.id, phone, sid: res.sid } as never,
      message: `[lancio] follow-up inviato a ${phone}`,
      level: 'info',
    });
    sent++;
  });

  await supabase.from('event_log').insert({
    type: 'batch_send',
    payload: { lancio: 'followup', candidati: candidati.length, targets: targets.length, sent, capped, failed, riparati } as never,
    message: `[lancio] follow-up: inviati ${sent}, cap ${capped}, falliti ${failed}, riparati ${riparati} (su ${targets.length})`,
    level: failed > 0 ? 'warn' : 'info',
  });

  return NextResponse.json({ ok: true, candidati: candidati.length, targets: targets.length, sent, capped, failed, riparati });
}
```

- [ ] **Step 5: `vercel.json`**

Aggiungi in coda all'array `crons`:

```json
    {
      "path": "/api/cron/lancio-followup",
      "schedule": "*/10 10-11,15-17 6-7 10 *"
    }
```

- [ ] **Step 6: Verifica**

Run: `npx vitest run lib/run-pool.test.ts lib/lancio-followup.test.ts && npx tsc --noEmit`
Expected: PASS, nessun errore di tipo. Poi, con il server locale (`npm run dev`) e `CRON_SECRET` in `.env.local`: `curl "http://localhost:3000/api/cron/lancio-followup?secret=$CRON_SECRET&dry=1&forza=1"` → `{"ok":true,"dry":true,...}` oppure `skipped: 'lancio_attivo=0'` se l'interruttore è spento (entrambi corretti: nessun invio in dry).

- [ ] **Step 7: Commit**

```bash
git add app/api/cron/lancio-followup/route.ts lib/run-pool.ts lib/run-pool.test.ts lib/messaging.ts vercel.json
git commit -m "feat(lancio): cron del follow-up del 6 ottobre, 250 per run, cap 63049 rispettato"
```

---

### Task 6 (BOT): dopo il follow-up la chat prosegue nel flusso Mario standard con il video della live

**Files:**
- Modify: `lib/fenice-autoreply.ts` (`drainMarioReplies`: select del claim riga ~267; blocco `const gdo = claimed as {…}` riga ~328; `videoGiaInviato` riga ~386; opzioni di `generateMarioReply` riga ~448; `unknownFeniceLinks` riga ~538; `ensureConfirmationBlock` riga ~555)
- Modify: il punto in cui il B1/B4 instrada le conversazioni lancio al prompt lancio (annotato nel Task 0, step 2b)

**Interfaces:**
- Consumes: `isLancioStandardFlow`, `lancioStandardContextNote` (Task 4); `getLancioSettings` (Task 1); `unknownFeniceLinks(text, extra)`, `containsVideoLink(p, extra)`, `ensureConfirmationBlock(parts, { extraVideoLinks })` (Task 3).
- Produces: nessuna API nuova. Comportamento: alla prima risposta dopo `followup_inviato` la fase diventa `chiuso`; per `followup_inviato`/`chiuso` il drain usa il prompt Mario standard + `contextNote` con `lancio_video_live_link`.

- [ ] **Step 1: Leggi il claim e aggiungi le colonne**

Nella stringa `.select('id, ai_started_at, crm_lead_id, gdo_agenda_at, …, leads(first_name)')` del claim aggiungi `lancio_slug, lancio_fase` (una sola stringa, prima di `leads(first_name)`).

- [ ] **Step 2: Decidi il flusso lancio subito dopo il blocco `gdo`**

Dopo la riga `const postino = gdoAgendaAt !== null;` inserisci:

```ts
  // Lancio Web Developer AI (spec §5.5): dopo il follow-up del 6 la chat è di Mario
  // standard. `followup_inviato` + inbound = ha risposto ⇒ `chiuso`, e da lì il flusso
  // classico (prompt Mario, slot, form, Conferme) con un'unica differenza: il video
  // di preparazione è la live editata, se Bruno l'ha impostata.
  const lancio = claimed as { lancio_slug?: string | null; lancio_fase?: string | null };
  const lancioStandard = !!lancio.lancio_slug && isLancioStandardFlow(lancio.lancio_fase ?? null);
  let lancioVideoLiveLink: string | null = null;
  if (lancioStandard) {
    if (lancio.lancio_fase === 'followup_inviato') {
      await supabase.from('conversations').update({ lancio_fase: 'chiuso' }).eq('id', conversationId);
    }
    lancioVideoLiveLink = (await getLancioSettings(supabase)).lancio_video_live_link;
    if (!lancioVideoLiveLink) {
      await supabase.from('event_log').insert({
        type: 'lancio_video_live_link_missing',
        payload: { conversationId, crmLeadId } as never,
        message: `[lancio] conv ${conversationId}: lancio_video_live_link non impostato, Mario userà i video classici`,
        level: 'warn',
      });
    }
  }
  const lancioExtraLinks: readonly string[] = lancioVideoLiveLink ? [lancioVideoLiveLink] : [];
```

Import in testa al file: `import { isLancioStandardFlow, lancioStandardContextNote } from './lancio-followup';` e `import { getLancioSettings } from './lancio-settings';`.

- [ ] **Step 3: Il ramo lancio del B1/B4 non deve catturare le fasi standard**

Nel punto in cui il drain instrada le conversazioni con `lancio_slug` verso il prompt lancio (Task 0, 2b), la condizione deve essere `lancio_slug && !isLancioStandardFlow(lancio_fase)`. Se il B4 ha una funzione tipo `isLancioFlow(fase)` o `lancioFaseAttiva(fase)`, aggiungi lì il `&& !isLancioStandardFlow(fase)` e un test nel suo file: `expect(isLancioFlow('followup_inviato')).toBe(false); expect(isLancioFlow('chiuso')).toBe(false);`.

- [ ] **Step 4: Usa i link extra e la nota di contesto**

- `const videoGiaInviato = rows.some((m) => m.direction === 'out' && containsVideoLink(m.body));` → `containsVideoLink(m.body, lancioExtraLinks)`.
- Nelle opzioni di `generateMarioReply`, sostituisci `...(postino ? { contextNote: gdoContextNote({…}) } : {})` con:

```ts
        ...(postino
          ? { contextNote: gdoContextNote({ /* invariato */ }) }
          : lancioStandard && lancioStandardContextNote(lancioVideoLiveLink)
            ? { contextNote: lancioStandardContextNote(lancioVideoLiveLink) as string }
            : {}),
```

- `const linkInventati = parts.flatMap((p) => unknownFeniceLinks(p));` → `unknownFeniceLinks(p, lancioExtraLinks)`.
- `const block = ensureConfirmationBlock(parts);` → `ensureConfirmationBlock(parts, { extraVideoLinks: lancioExtraLinks })`.

- [ ] **Step 5: Verifica**

Run: `npx vitest run lib/fenice-autoreply.test.ts lib/lancio-followup.test.ts && npx tsc --noEmit`
Expected: PASS. Se `lib/fenice-autoreply.test.ts` ha un fake Supabase per il claim che non serve `app_settings`, aggiungi al fake la tabella come nel Task 2 (`from('app_settings').select().in() → { data: [] }`): senza `lancio_slug` nel claim il ramo non entra e la lettura non parte, quindi i test esistenti non devono cambiare comportamento.

Prova manuale sul Simulatore (`/fenice`): non copre il drain reale. Prova con un numero di test (B6): conversazione con `lancio_slug='webdev-2026-10'`, `lancio_fase='followup_inviato'`, `lancio_video_live_link` impostato → rispondi "sì mi interessa" → verifica su `conversations` che `lancio_fase='chiuso'` e che il messaggio di Mario, quando manda il video, contenga il link della live e non un `conferenza-*`.

- [ ] **Step 6: Commit**

```bash
git add lib/fenice-autoreply.ts
git commit -m "feat(lancio): chi risponde al follow-up torna nel flusso Mario standard con il video della live"
```

(Se hai toccato il file del ramo lancio del B4, aggiungilo con il suo test.)

---

### Task 7 (BOT): `lib/lancio-restituzioni.ts` — decisione pura delle restituzioni

**Files:**
- Create: `lib/lancio-restituzioni.ts`
- Test: `lib/lancio-restituzioni.test.ts`

**Interfaces:**
- Consumes: `haInteragito`, `LANCIO_BATCH_MAX` (Task 4); `romeDayKey` (`./rome-time`).
- Produces:
  - `RESTITUZIONI_DAL = '2026-10-08'`, `RESTITUZIONE_ATTESA_MS = 48h`
  - `type MotivoRestituzione = 'mai_risposto' | 'silenzio_dopo_followup'`
  - `NOTA_RESTITUZIONE: Record<MotivoRestituzione, string>` = `{ mai_risposto: 'Lancio: mai risposto', silenzio_dopo_followup: 'Lancio: silenzio dopo il follow-up' }`
  - `FASI_RESTITUIBILI = ['attesa', 'link_inviato', 'followup_inviato']`
  - `type RestituzioneCandidate = { id: number; lancio_fase: string | null; lancio_followup_inviato_at: string | null; last_inbound_at: string | null; ai_started_at: string | null; crm_lead_id: string | null; bot_outcome: string | null }`
  - `isRestituzioniActive(now: Date): boolean`
  - `decideRestituzione(c: RestituzioneCandidate, nowMs: number): MotivoRestituzione | null`
  - `selectRestituzioni<T extends RestituzioneCandidate>(rows: T[], nowMs: number, max?: number): Array<{ row: T; motivo: MotivoRestituzione }>`

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// lib/lancio-restituzioni.test.ts
import { describe, it, expect } from 'vitest';
import {
  NOTA_RESTITUZIONE,
  RESTITUZIONE_ATTESA_MS,
  decideRestituzione,
  isRestituzioniActive,
  selectRestituzioni,
  type RestituzioneCandidate,
} from './lancio-restituzioni';

const H = 3600_000;
const NOW = Date.parse('2026-10-08T10:00:00Z');
const row = (over: Partial<RestituzioneCandidate> = {}): RestituzioneCandidate => ({
  id: 1,
  lancio_fase: 'attesa',
  lancio_followup_inviato_at: null,
  last_inbound_at: null,
  ai_started_at: '2026-09-20T10:00:00Z',
  crm_lead_id: 'lead-1',
  bot_outcome: null,
  ...over,
});

describe('isRestituzioniActive', () => {
  it('dall\'8 ottobre Rome in poi, non prima', () => {
    expect(isRestituzioniActive(new Date('2026-10-07T21:59:00Z'))).toBe(false); // 7/10 23:59 Rome
    expect(isRestituzioniActive(new Date('2026-10-07T22:00:00Z'))).toBe(true);  // 8/10 00:00 Rome
    expect(isRestituzioniActive(new Date('2026-10-20T10:00:00Z'))).toBe(true);
  });
});

describe('decideRestituzione', () => {
  it('attesa/link_inviato senza alcun inbound → mai_risposto', () => {
    expect(decideRestituzione(row(), NOW)).toBe('mai_risposto');
    expect(decideRestituzione(row({ lancio_fase: 'link_inviato' }), NOW)).toBe('mai_risposto');
  });
  it('attesa/link_inviato con un inbound del lancio → niente (aspetta il follow-up)', () => {
    expect(decideRestituzione(row({ last_inbound_at: '2026-10-05T20:00:00Z' }), NOW)).toBeNull();
  });
  it('un inbound di un funnel precedente non conta come risposta', () => {
    expect(decideRestituzione(row({ last_inbound_at: '2026-06-01T10:00:00Z' }), NOW)).toBe('mai_risposto');
  });
  it('followup_inviato: silenzio dopo 48h → silenzio_dopo_followup', () => {
    const fu = new Date(NOW - RESTITUZIONE_ATTESA_MS - H).toISOString();
    expect(decideRestituzione(row({ lancio_fase: 'followup_inviato', lancio_followup_inviato_at: fu, last_inbound_at: '2026-10-05T20:00:00Z' }), NOW))
      .toBe('silenzio_dopo_followup');
  });
  it('followup_inviato: prima delle 48h non si tocca', () => {
    const fu = new Date(NOW - RESTITUZIONE_ATTESA_MS + H).toISOString();
    expect(decideRestituzione(row({ lancio_fase: 'followup_inviato', lancio_followup_inviato_at: fu }), NOW)).toBeNull();
  });
  it('followup_inviato con una risposta dopo il follow-up non si tocca (il drain la chiude)', () => {
    const fu = new Date(NOW - 3 * RESTITUZIONE_ATTESA_MS).toISOString();
    expect(decideRestituzione(row({ lancio_fase: 'followup_inviato', lancio_followup_inviato_at: fu, last_inbound_at: new Date(NOW - RESTITUZIONE_ATTESA_MS).toISOString() }), NOW)).toBeNull();
  });
  it('followup_inviato senza data di invio (riga incoerente) non si tocca', () => {
    expect(decideRestituzione(row({ lancio_fase: 'followup_inviato' }), NOW)).toBeNull();
  });
  it('scelta_fatta, chiuso, restituito, posto_bloccato, post_pitch: mai', () => {
    for (const f of ['scelta_fatta', 'chiuso', 'restituito', 'posto_bloccato', 'post_pitch', null]) {
      expect(decideRestituzione(row({ lancio_fase: f }), NOW)).toBeNull();
    }
  });
  it('senza lead CRM o con un esito già dato non si restituisce', () => {
    expect(decideRestituzione(row({ crm_lead_id: null }), NOW)).toBeNull();
    expect(decideRestituzione(row({ bot_outcome: 'APPUNTAMENTO' }), NOW)).toBeNull();
  });
  it('le note sono esattamente quelle della spec', () => {
    expect(NOTA_RESTITUZIONE.mai_risposto).toBe('Lancio: mai risposto');
    expect(NOTA_RESTITUZIONE.silenzio_dopo_followup).toBe('Lancio: silenzio dopo il follow-up');
  });
});

describe('selectRestituzioni', () => {
  it('ordina per id, rispetta il tetto e porta il motivo', () => {
    const fu = new Date(NOW - 3 * RESTITUZIONE_ATTESA_MS).toISOString();
    const out = selectRestituzioni([
      row({ id: 3, lancio_fase: 'followup_inviato', lancio_followup_inviato_at: fu, last_inbound_at: '2026-10-05T20:00:00Z' }),
      row({ id: 1 }),
      row({ id: 2, lancio_fase: 'chiuso' }),
    ], NOW, 5);
    expect(out.map((o) => [o.row.id, o.motivo])).toEqual([[1, 'mai_risposto'], [3, 'silenzio_dopo_followup']]);
    expect(selectRestituzioni([row({ id: 1 }), row({ id: 2 })], NOW, 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Esegui e verifica che fallisca**

Run: `npx vitest run lib/lancio-restituzioni.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 3: Implementa `lib/lancio-restituzioni.ts`**

```ts
import { romeDayKey } from './rome-time';
import { haInteragito, LANCIO_BATCH_MAX } from './lancio-followup';

/**
 * Restituzione al pool (spec §5.8, assunzione A5): dall'8 ottobre, chi non ha mai
 * risposto e chi tace 48 ore dopo il follow-up torna al CRM come NON_RISPOSTO con
 * una nota fissa; il CRM lo rimette nel pool di /import (§4.6). Qui la sola
 * decisione; il cron `/api/cron/lancio-restituzioni` la applica.
 */

export const RESTITUZIONI_DAL = '2026-10-08';
export const RESTITUZIONE_ATTESA_MS = 48 * 3600_000;

export type MotivoRestituzione = 'mai_risposto' | 'silenzio_dopo_followup';

/** Note al CRM: da lì il CRM deriva `metadata.motivo`. Non cambiare una virgola. */
export const NOTA_RESTITUZIONE: Record<MotivoRestituzione, string> = {
  mai_risposto: 'Lancio: mai risposto',
  silenzio_dopo_followup: 'Lancio: silenzio dopo il follow-up',
};

export const FASI_RESTITUIBILI = ['attesa', 'link_inviato', 'followup_inviato'] as const;

export type RestituzioneCandidate = {
  id: number;
  lancio_fase: string | null;
  lancio_followup_inviato_at: string | null;
  last_inbound_at: string | null;
  ai_started_at: string | null;
  crm_lead_id: string | null;
  /** Un esito già dato (di questo o di un funnel precedente sulla stessa chat) non si sovrascrive. */
  bot_outcome: string | null;
};

/** Giorno solare italiano ≥ 8/10/2026. Regola a data, non a cron: non ha stati. */
export function isRestituzioniActive(now: Date): boolean {
  return romeDayKey(now) >= RESTITUZIONI_DAL;
}

export function decideRestituzione(c: RestituzioneCandidate, nowMs: number): MotivoRestituzione | null {
  if (!c.crm_lead_id) return null;
  if (c.bot_outcome !== null) return null;
  if (c.lancio_fase === 'attesa' || c.lancio_fase === 'link_inviato') {
    return haInteragito(c) ? null : 'mai_risposto';
  }
  if (c.lancio_fase === 'followup_inviato') {
    if (!c.lancio_followup_inviato_at) return null;
    const fuMs = Date.parse(c.lancio_followup_inviato_at);
    if (Number.isNaN(fuMs)) return null;
    if (nowMs < fuMs + RESTITUZIONE_ATTESA_MS) return null;
    const inboundMs = c.last_inbound_at ? Date.parse(c.last_inbound_at) : NaN;
    const haRispostoDopo = !Number.isNaN(inboundMs) && inboundMs > fuMs;
    return haRispostoDopo ? null : 'silenzio_dopo_followup';
  }
  // posto_bloccato, post_pitch, scelta_fatta, chiuso, restituito: mai.
  return null;
}

export function selectRestituzioni<T extends RestituzioneCandidate>(
  rows: T[],
  nowMs: number,
  max: number = LANCIO_BATCH_MAX,
): Array<{ row: T; motivo: MotivoRestituzione }> {
  const out: Array<{ row: T; motivo: MotivoRestituzione }> = [];
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const motivo = decideRestituzione(row, nowMs);
    if (motivo) out.push({ row, motivo });
    if (out.length >= max) break;
  }
  return out;
}
```

- [ ] **Step 4: Esegui e verifica che passi**

Run: `npx vitest run lib/lancio-restituzioni.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/lancio-restituzioni.ts lib/lancio-restituzioni.test.ts
git commit -m "feat(lancio): decisione pura delle restituzioni al pool (mai risposto / silenzio dopo il follow-up)"
```

---

### Task 8 (BOT): cron `/api/cron/lancio-restituzioni` + schedule

**Files:**
- Create: `app/api/cron/lancio-restituzioni/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: Task 7 (tutto), `sendOutcome(supabase, conversationId, { outcome: 'NON_RISPOSTO', note })` da `./bot-outcome` (ritorna `{ sent, status?, error? }`), `runPool` (Task 5).
- Produces: route `GET /api/cron/lancio-restituzioni?secret=…[&dry=1][&forza=1][&max=N]` → `{ ok, skipped? | candidati, daRestituire, restituiti, rifiutati, errori }`. Per ogni conversazione restituita: `lancio_fase='restituito'`, `ai_status='closed'`, `event_log` `lancio_restituito` `{ conversationId, crmLeadId, motivo, status }`.

Cosa fa `sendOutcome` qui: la conversazione ha `bot_outcome` nullo (guardia del Task 7), quindi `resolveOutcomeAction` è `normal`: POST al CRM con `outcome: 'NON_RISPOSTO'` e la nota; su 2xx scrive `bot_outcome`, `bot_outcome_at` e `ai_status='closed'` da sé. Un 403/404 del CRM (lead non del bot / non trovato) è una decisione del CRM: si segna `restituito` lo stesso per non ritentare ogni ora; rete/5xx/409 ⇒ si ritenta al run dopo.

- [ ] **Step 1: Il route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  FASI_RESTITUIBILI,
  NOTA_RESTITUZIONE,
  isRestituzioniActive,
  selectRestituzioni,
  type RestituzioneCandidate,
} from '@/lib/lancio-restituzioni';
import { LANCIO_BATCH_MAX } from '@/lib/lancio-followup';
import { sendOutcome } from '@/lib/bot-outcome';
import { runPool } from '@/lib/run-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Restituzioni al pool (spec §5.8): ogni ora dall'8 ottobre. NON_RISPOSTO al CRM con la
// nota fissa, poi `restituito` + `closed`. Mai su scelta_fatta / chiuso / restituito.
// Non dipende da `lancio_attivo`: spegnere il lancio non deve lasciare lead appesi al bot.

const CONCURRENCY = 5;
/** Un rifiuto del CRM è una decisione presa: non si ritenta ogni ora. */
const STATUS_TERMINALI = new Set([403, 404]);

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  const sp = req.nextUrl.searchParams;
  const dry = sp.get('dry') === '1';
  const forza = sp.get('forza') === '1'; // QA (B6): salta la guardia sulla data
  const maxRaw = parseInt(sp.get('max') ?? '', 10);
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, LANCIO_BATCH_MAX) : LANCIO_BATCH_MAX;

  const now = new Date();
  if (!forza && !isRestituzioniActive(now)) return NextResponse.json({ ok: true, skipped: 'prima dell\'8/10' });

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('conversations')
    .select('id, lancio_fase, lancio_followup_inviato_at, last_inbound_at, ai_started_at, crm_lead_id, bot_outcome')
    .not('lancio_slug', 'is', null)
    .in('lancio_fase', [...FASI_RESTITUIBILI])
    .not('crm_lead_id', 'is', null)
    .is('ai_paused_at', null)
    .order('id', { ascending: true })
    .limit(3000);
  const candidati = (data ?? []) as unknown as RestituzioneCandidate[];
  const daRestituire = selectRestituzioni(candidati, now.getTime(), max);

  if (dry) {
    return NextResponse.json({
      ok: true, dry: true, candidati: candidati.length, daRestituire: daRestituire.length,
      motivi: daRestituire.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.motivo]: (acc[d.motivo] ?? 0) + 1 }), {}),
    });
  }

  let restituiti = 0, rifiutati = 0, errori = 0;
  await runPool(daRestituire, CONCURRENCY, async ({ row, motivo }) => {
    try {
      const res = await sendOutcome(supabase, row.id, { outcome: 'NON_RISPOSTO', note: NOTA_RESTITUZIONE[motivo] });
      const terminale = res.sent || (res.status !== undefined && STATUS_TERMINALI.has(res.status));
      if (!terminale) {
        errori++;
        await supabase.from('event_log').insert({
          type: 'lancio_restituzione_error',
          payload: { conversationId: row.id, crmLeadId: row.crm_lead_id, motivo, status: res.status ?? null, error: res.error ?? null } as never,
          message: `[lancio] conv ${row.id}: restituzione non riuscita (${res.error ?? res.status ?? 'errore'}), riprovo al prossimo run`,
          level: 'error',
        });
        return;
      }
      await supabase.from('conversations')
        .update({ lancio_fase: 'restituito', ai_status: 'closed' })
        .eq('id', row.id);
      await supabase.from('event_log').insert({
        type: 'lancio_restituito',
        payload: { conversationId: row.id, crmLeadId: row.crm_lead_id, motivo, status: res.status ?? null, sent: res.sent } as never,
        message: res.sent
          ? `[lancio] conv ${row.id} restituita al pool: ${NOTA_RESTITUZIONE[motivo]}`
          : `[lancio] conv ${row.id}: il CRM ha rifiutato (${res.status}), segnata restituita per non ritentare`,
        level: res.sent ? 'info' : 'warn',
      });
      if (res.sent) restituiti++; else rifiutati++;
    } catch (err: unknown) {
      errori++;
      const e = err as { message?: string };
      await supabase.from('event_log').insert({
        type: 'lancio_restituzione_error',
        payload: { conversationId: row.id, motivo } as never,
        message: `[lancio] conv ${row.id}: restituzione esplosa — ${e?.message ?? 'errore ignoto'}`,
        level: 'error',
      });
    }
  });

  return NextResponse.json({ ok: true, candidati: candidati.length, daRestituire: daRestituire.length, restituiti, rifiutati, errori });
}
```

- [ ] **Step 2: `vercel.json`**

Aggiungi in coda a `crons`:

```json
    {
      "path": "/api/cron/lancio-restituzioni",
      "schedule": "0 * 8-31 10 *"
    }
```

- [ ] **Step 3: Verifica**

Run: `npx tsc --noEmit && npx vitest run lib/lancio-restituzioni.test.ts`
Expected: nessun errore, PASS. In locale: `curl "http://localhost:3000/api/cron/lancio-restituzioni?secret=$CRON_SECRET&dry=1&forza=1"` → `{"ok":true,"dry":true,"candidati":N,"daRestituire":M,"motivi":{…}}` (con `daRestituire` 0 finché non esistono conversazioni lancio).

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/lancio-restituzioni/route.ts vercel.json
git commit -m "feat(lancio): cron orario delle restituzioni al pool dall'8 ottobre"
```

---

### Task 9 (BOT): pagina `/fenice/impostazioni` + API

**Files:**
- Create: `app/api/fenice/lancio-settings/route.ts`
- Create: `app/(fenice)/fenice/impostazioni/page.tsx`
- Create: `app/(fenice)/fenice/impostazioni/_components/ImpostazioniPanel.tsx`
- Modify: `components/FeniceSidebar.tsx` (array `NAV`)

**Interfaces:**
- Consumes: Task 1 (`getLancioSettings`, `setLancioSetting`, `validateLancioSettingInput`, `LANCIO_EDITABLE_KEYS`, `type LancioSettings`, `isLancioAttivo`), `resolveOffertaDelMeseLink` (Task 2), `requireUser` come in `app/api/fenice/autoreply/route.ts`, `PageHeader`, `Input`, `Button`, `Switch`.
- Produces:
  - `GET /api/fenice/lancio-settings` → `{ settings: LancioSettings, offertaEffettiva: string }`
  - `POST /api/fenice/lancio-settings` body `{ key: string; value: unknown }` → `200 { ok: true, key, value }` | `400 { ok: false, error: reason }` | `401`
  - pagina con tre campi link (`offerta_del_mese_link`, `lancio_video_live_link`, `lancio_zoom_link`) e l'interruttore `lancio_attivo`

- [ ] **Step 1: API**

`app/api/fenice/lancio-settings/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings, setLancioSetting, validateLancioSettingInput, type LancioSettingKey } from '@/lib/lancio-settings';
import { resolveOffertaDelMeseLink } from '@/lib/gdo-agenda';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

export async function GET() {
  if (!(await requireUser())) return new NextResponse('unauthorized', { status: 401 });
  const settings = await getLancioSettings(getSupabaseAdmin());
  return NextResponse.json({ settings, offertaEffettiva: resolveOffertaDelMeseLink(settings) });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { key?: unknown; value?: unknown };
  const key = typeof body.key === 'string' ? body.key : '';
  const valid = validateLancioSettingInput(key, body.value);
  if (!valid.ok) return NextResponse.json({ ok: false, error: valid.reason }, { status: 400 });
  const admin = getSupabaseAdmin();
  await setLancioSetting(admin, key as LancioSettingKey, valid.value);
  await admin.from('event_log').insert({
    type: 'lancio_setting_changed',
    payload: { key, value: valid.value, by: user.email ?? user.id } as never,
    message: `[lancio] impostazione ${key} = ${valid.value ?? '(vuoto)'} (${user.email ?? user.id})`,
    level: 'info',
  });
  return NextResponse.json({ ok: true, key, value: valid.value });
}
```

- [ ] **Step 2: Pagina server**

`app/(fenice)/fenice/impostazioni/page.tsx`:

```tsx
import { Settings } from 'lucide-react';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getLancioSettings } from '@/lib/lancio-settings';
import { resolveOffertaDelMeseLink } from '@/lib/gdo-agenda';
import { PageHeader } from '@/components/fenice/PageHeader';
import { ImpostazioniPanel } from './_components/ImpostazioniPanel';

export const dynamic = 'force-dynamic';

export default async function FeniceImpostazioniPage() {
  const supabase = await getSupabaseServer();
  await supabase.auth.getUser();
  const settings = await getLancioSettings(getSupabaseAdmin());
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Settings}
        kicker="Lancio Web Developer AI"
        title="Impostazioni"
        description="I link che il bot manda cambiano da qui, senza deploy: offerta del mese per le agende dei GDO, live editata per chi risponde al follow-up, Zoom per la sera del 5."
      />
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <ImpostazioniPanel initial={settings} offertaEffettiva={resolveOffertaDelMeseLink(settings)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Pannello client**

`app/(fenice)/fenice/impostazioni/_components/ImpostazioniPanel.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Save, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { LancioSettings } from '@/lib/lancio-settings';

type LinkKey = 'offerta_del_mese_link' | 'lancio_video_live_link' | 'lancio_zoom_link';

const CAMPI: Array<{ key: LinkKey; label: string; hint: string }> = [
  { key: 'offerta_del_mese_link', label: 'Video offerta del mese', hint: 'Lo manda Marta quando il GDO spunta "Offerta del mese" in agenda. Vuoto = env OFFERTA_DEL_MESE_LINK, poi Black Summer.' },
  { key: 'lancio_video_live_link', label: 'Video della live editata', hint: 'Lo manda Mario, al posto dei quattro video classici, a chi risponde al follow-up del 6.' },
  { key: 'lancio_zoom_link', label: 'Link Zoom della live', hint: 'Usato dal blast del 5 ottobre (B4).' },
];

const ERRORI: Record<string, string> = {
  link_non_https: 'Serve un link completo che inizi con https://',
  chiave_non_modificabile: 'Questa impostazione non si cambia da qui.',
  valore_non_valido: 'Valore non valido.',
};

export function ImpostazioniPanel({ initial, offertaEffettiva }: { initial: LancioSettings; offertaEffettiva: string }) {
  const [values, setValues] = useState<Record<LinkKey, string>>({
    offerta_del_mese_link: initial.offerta_del_mese_link ?? '',
    lancio_video_live_link: initial.lancio_video_live_link ?? '',
    lancio_zoom_link: initial.lancio_zoom_link ?? '',
  });
  const [attivo, setAttivo] = useState(initial.lancio_attivo === '1');
  const [effettiva, setEffettiva] = useState(offertaEffettiva);
  const [stato, setStato] = useState<Partial<Record<LinkKey | 'lancio_attivo', { ok: boolean; text: string }>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function salva(key: LinkKey | 'lancio_attivo', value: string | boolean) {
    setBusy(key);
    try {
      const res = await fetch('/api/fenice/lancio-settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; value?: string | null };
      if (!res.ok || !data.ok) {
        setStato((s) => ({ ...s, [key]: { ok: false, text: ERRORI[data.error ?? ''] ?? 'Errore di salvataggio' } }));
        return;
      }
      setStato((s) => ({ ...s, [key]: { ok: true, text: data.value ? 'Salvato' : 'Azzerato' } }));
      if (key === 'offerta_del_mese_link') {
        const r = await fetch('/api/fenice/lancio-settings');
        const j = (await r.json().catch(() => ({}))) as { offertaEffettiva?: string };
        if (j.offertaEffettiva) setEffettiva(j.offertaEffettiva);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="fenice-rise rounded-2xl border border-border/70 bg-card/60 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold">Lancio attivo</div>
            <div className="text-xs text-muted-foreground">Spento: i cron del lancio (blast Zoom, follow-up) non mandano nulla. Le restituzioni al pool non dipendono da qui.</div>
          </div>
          <Switch
            checked={attivo}
            disabled={busy === 'lancio_attivo'}
            onCheckedChange={(on: boolean) => { setAttivo(on); void salva('lancio_attivo', on); }}
          />
        </div>
        {stato.lancio_attivo && <Esito e={stato.lancio_attivo} />}
      </div>

      {CAMPI.map(({ key, label, hint }) => (
        <div key={key} className="fenice-rise rounded-2xl border border-border/70 bg-card/60 p-5">
          <label className="text-sm font-semibold" htmlFor={key}>{label}</label>
          <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              id={key}
              value={values[key]}
              placeholder="https://…"
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              className="flex-1"
            />
            <Button disabled={busy === key} onClick={() => void salva(key, values[key])}>
              <Save className="mr-1.5 size-4" /> Salva
            </Button>
          </div>
          {key === 'offerta_del_mese_link' && (
            <div className="mt-2 text-xs text-muted-foreground">Link in uso adesso: <span className="font-mono">{effettiva}</span></div>
          )}
          {stato[key] && <Esito e={stato[key]!} />}
        </div>
      ))}
    </div>
  );
}

function Esito({ e }: { e: { ok: boolean; text: string } }) {
  return (
    <div className={`mt-2 flex items-center gap-1.5 text-xs ${e.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
      {e.ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />} {e.text}
    </div>
  );
}
```

- [ ] **Step 4: Voce di menu**

In `components/FeniceSidebar.tsx` aggiungi `Settings` all'import da `lucide-react` e in coda a `NAV`:

```ts
  { href: '/fenice/impostazioni', label: 'Impostazioni', desc: 'Link del lancio e offerta del mese', icon: Settings },
```

- [ ] **Step 5: Verifica**

Run: `npx tsc --noEmit && npm run lint`
Expected: nessun errore. Manuale (`npm run dev`, login su `/fenice`): apri `/fenice/impostazioni`, inserisci `http://x` → messaggio "Serve un link completo…"; inserisci `https://corso.feniceacademy.it/prova` → "Salvato" e "Link in uso adesso" aggiornato; svuota e salva → "Azzerato" e il link in uso torna a env/Black Summer; interruttore → riga `lancio_setting_changed` in `event_log`.

- [ ] **Step 6: Commit**

```bash
git add app/api/fenice/lancio-settings/route.ts "app/(fenice)/fenice/impostazioni" components/FeniceSidebar.tsx
git commit -m "feat(fenice): pagina Impostazioni con i link del lancio e l'interruttore lancio_attivo"
```

---

### Task 10 (CRM): `lancioReturnRules.ts` — regole pure del ritorno al pool

**Files:**
- Create: `src/lib/bot-fissatore/lancioReturnRules.ts`
- Test: `src/lib/bot-fissatore/lancioReturnRules.test.ts`
- Modify: `package.json` (riga `"test"`: aggiungi `src/lib/bot-fissatore/lancioReturnRules.test.ts`)

**Interfaces:**
- Consumes: `isLeadLocked(status: string, presentedAt: Date | null)` da `./contactRequests`.
- Produces:
  - `LANCIO_WEBDEV_BUCKET = 'LANCIO_WEBDEV_2026'`
  - `type LancioReturnMotivo = 'mai_risposto' | 'silenzio_dopo_followup'`
  - `motivoRestituzioneDaNota(note: string | null | undefined, outcome: 'NON_RISPOSTO' | 'INTERROTTO'): LancioReturnMotivo`
  - `type LancioReturnLead = { launchBucket: string | null; assigneeIsBot: boolean; status: string; presentedAt: Date | null; appointmentDate: Date | null; lancioScelta?: string | null }`
  - `checkLancioReturnToPool(l: LancioReturnLead): { ok: true } | { ok: false; reason: 'not_lancio' | 'not_bot' | 'already_rejected' | 'locked_appointment' | 'scelta_fatta' }`

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/bot-fissatore/lancioReturnRules.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LANCIO_WEBDEV_BUCKET,
    checkLancioReturnToPool,
    motivoRestituzioneDaNota,
    type LancioReturnLead,
} from './lancioReturnRules';

const base = (over: Partial<LancioReturnLead> = {}): LancioReturnLead => ({
    launchBucket: LANCIO_WEBDEV_BUCKET,
    assigneeIsBot: true,
    status: 'NEW',
    presentedAt: null,
    appointmentDate: null,
    lancioScelta: null,
    ...over,
});

test('il bucket è quello della spec', () => {
    assert.equal(LANCIO_WEBDEV_BUCKET, 'LANCIO_WEBDEV_2026');
});

test('motivo dalla nota: le due note del bot', () => {
    assert.equal(motivoRestituzioneDaNota('Lancio: mai risposto', 'NON_RISPOSTO'), 'mai_risposto');
    assert.equal(motivoRestituzioneDaNota('Lancio: silenzio dopo il follow-up', 'NON_RISPOSTO'), 'silenzio_dopo_followup');
    assert.equal(motivoRestituzioneDaNota('  lancio: SILENZIO dopo il follow-up.', 'NON_RISPOSTO'), 'silenzio_dopo_followup');
});

test('motivo dalla nota: senza nota riconoscibile decide l\'esito', () => {
    assert.equal(motivoRestituzioneDaNota(undefined, 'NON_RISPOSTO'), 'mai_risposto');
    assert.equal(motivoRestituzioneDaNota('boh', 'NON_RISPOSTO'), 'mai_risposto');
    assert.equal(motivoRestituzioneDaNota(null, 'INTERROTTO'), 'silenzio_dopo_followup');
});

test('torna al pool: lead del lancio, al bot, NEW/IN_PROGRESS, senza storico', () => {
    assert.deepEqual(checkLancioReturnToPool(base()), { ok: true });
    assert.deepEqual(checkLancioReturnToPool(base({ status: 'IN_PROGRESS' })), { ok: true });
});

test('non torna: non è del lancio, o non è al bot', () => {
    assert.deepEqual(checkLancioReturnToPool(base({ launchBucket: 'BLACK_SUMMER' })), { ok: false, reason: 'not_lancio' });
    assert.deepEqual(checkLancioReturnToPool(base({ launchBucket: null })), { ok: false, reason: 'not_lancio' });
    assert.deepEqual(checkLancioReturnToPool(base({ assigneeIsBot: false })), { ok: false, reason: 'not_bot' });
});

test('guardie invariate: REJECTED e isLeadLocked (APPOINTMENT / presentedAt)', () => {
    assert.deepEqual(checkLancioReturnToPool(base({ status: 'REJECTED' })), { ok: false, reason: 'already_rejected' });
    assert.deepEqual(checkLancioReturnToPool(base({ status: 'APPOINTMENT' })), { ok: false, reason: 'locked_appointment' });
    assert.deepEqual(checkLancioReturnToPool(base({ presentedAt: new Date('2026-10-06T09:00:00Z') })), { ok: false, reason: 'locked_appointment' });
});

test('guardie del lancio: appuntamento in agenda o scelta fatta', () => {
    assert.deepEqual(checkLancioReturnToPool(base({ appointmentDate: new Date('2026-10-06T09:00:00Z') })), { ok: false, reason: 'locked_appointment' });
    assert.deepEqual(checkLancioReturnToPool(base({ lancioScelta: 'chiamata_subito' })), { ok: false, reason: 'scelta_fatta' });
    assert.deepEqual(checkLancioReturnToPool(base({ lancioScelta: 'app_pomeriggio' })), { ok: false, reason: 'scelta_fatta' });
    assert.deepEqual(checkLancioReturnToPool(base({ lancioScelta: undefined })), { ok: true });
});
```

- [ ] **Step 2: Esegui e verifica che fallisca**

Run: `node --import tsx --test src/lib/bot-fissatore/lancioReturnRules.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 3: Implementa `src/lib/bot-fissatore/lancioReturnRules.ts`**

```ts
import { isLeadLocked } from './contactRequests';

/**
 * Ritorno al pool dei lead del lancio Web Developer AI (spec §4.6). Modulo puro:
 * niente DB. `NON_RISPOSTO`/`INTERROTTO` dal bot su un lead del bucket assegnato al
 * bot non fanno round robin verso un GDO ma lo rimettono nel pool di /import, da
 * cui gli admin lo distribuiscono come per Black Summer.
 */

export const LANCIO_WEBDEV_BUCKET = 'LANCIO_WEBDEV_2026';

export type LancioReturnMotivo = 'mai_risposto' | 'silenzio_dopo_followup';

/**
 * Il motivo lo dice la nota del bot ("Lancio: mai risposto" / "Lancio: silenzio dopo
 * il follow-up", spec §5.8). Senza nota riconoscibile: NON_RISPOSTO = mai risposto,
 * INTERROTTO = ha interagito e poi è sparito, cioè silenzio.
 */
export function motivoRestituzioneDaNota(
    note: string | null | undefined,
    outcome: 'NON_RISPOSTO' | 'INTERROTTO',
): LancioReturnMotivo {
    const t = (note ?? '').toLowerCase();
    if (/silenzio dopo il follow-?up/.test(t)) return 'silenzio_dopo_followup';
    if (/mai risposto/.test(t)) return 'mai_risposto';
    return outcome === 'INTERROTTO' ? 'silenzio_dopo_followup' : 'mai_risposto';
}

export type LancioReturnLead = {
    launchBucket: string | null;
    assigneeIsBot: boolean;
    status: string;
    presentedAt: Date | null;
    appointmentDate: Date | null;
    /** `chiamata_subito | app_mattina | app_pomeriggio | app_dopodomani | followup` (spec §3.1). */
    lancioScelta?: string | null;
};

export type LancioReturnCheck =
    | { ok: true }
    | { ok: false; reason: 'not_lancio' | 'not_bot' | 'already_rejected' | 'locked_appointment' | 'scelta_fatta' };

/**
 * Guardie, nell'ordine: appartenenza al lancio e al bot; REJECTED (una decisione
 * presa non si annulla, come in reassign.ts); `isLeadLocked` + `appointmentDate`
 * (un lead con una call in agenda o una presenza non torna mai nel pool);
 * `lancioScelta` (ha scelto la sera del 5: è di un venditore o delle Conferme).
 */
export function checkLancioReturnToPool(l: LancioReturnLead): LancioReturnCheck {
    if (l.launchBucket !== LANCIO_WEBDEV_BUCKET) return { ok: false, reason: 'not_lancio' };
    if (!l.assigneeIsBot) return { ok: false, reason: 'not_bot' };
    if (l.status === 'REJECTED') return { ok: false, reason: 'already_rejected' };
    if (isLeadLocked(l.status, l.presentedAt) || l.appointmentDate !== null) {
        return { ok: false, reason: 'locked_appointment' };
    }
    if (l.lancioScelta) return { ok: false, reason: 'scelta_fatta' };
    return { ok: true };
}
```

- [ ] **Step 4: Aggiungi il test alla suite e verifica**

In `package.json`, nella riga `"test"`, aggiungi ` src/lib/bot-fissatore/lancioReturnRules.test.ts` prima di ` src/lib/riconciliazione/sheetRows.test.ts`.

Run: `node --import tsx --test src/lib/bot-fissatore/lancioReturnRules.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot-fissatore/lancioReturnRules.ts src/lib/bot-fissatore/lancioReturnRules.test.ts package.json
git commit -m "feat(lancio): regole pure del ritorno al pool dei lead del lancio"
```

---

### Task 11 (CRM): `lancioReturn.ts` + ramo in `/api/bot/outcome`

**Files:**
- Create: `src/lib/bot-fissatore/lancioReturn.ts`
- Modify: `src/app/api/bot/outcome/route.ts` (select del lead righe 97–112; ramo `NON_RISPOSTO`/`INTERROTTO` righe 516–526)

**Interfaces:**
- Consumes: Task 10; `db`, `leads`, `leadEvents` (Drizzle); `reassignBotLeadToHumanPool` resta per i lead non lancio.
- Produces:
  - `returnLancioLeadToPool(params: { leadId: string; motivo: LancioReturnMotivo; outcome: 'NON_RISPOSTO' | 'INTERROTTO'; botUserId: string; botNote: string | null; assigneeIsBot: boolean }): Promise<{ ok: true; returned: true } | { ok: true; returned: false; note: string }>`
  - risposta del route sui lead lancio: `{ ok: true, returnedToPool: true, motivo }` oppure `{ ok: true, returnedToPool: false, skipped: <reason> }`
  - evento `LANCIO_RETURNED_TO_POOL` con `metadata: { motivo, outcome, botNote, fromBot, bucket }`, `userId: null`

- [ ] **Step 1: `src/lib/bot-fissatore/lancioReturn.ts`**

```ts
import { db } from '@/db';
import { leads, leadEvents } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { LANCIO_WEBDEV_BUCKET, checkLancioReturnToPool, type LancioReturnMotivo } from './lancioReturnRules';

const FENICE = 'fenice';

export type LancioReturnResult =
    | { ok: true; returned: true }
    | { ok: true; returned: false; note: string };

/**
 * Rimette nel pool di /import un lead del lancio che il bot restituisce (spec §4.6):
 * `assignedToId=null`, `status='NEW'`, `callCount=0`, richiami azzerati; `assignedAt`
 * NON si tocca (il lead conta dal giorno in cui è entrato al bot; la distribuzione
 * ai GDO fa COALESCE e non lo riscrive). Le guardie stanno in lancioReturnRules.ts e
 * si rileggono DENTRO la transazione: fra la risposta del bot e questa scrittura una
 * Conferma può aver fissato qualcosa.
 */
export async function returnLancioLeadToPool(params: {
    leadId: string;
    motivo: LancioReturnMotivo;
    outcome: 'NON_RISPOSTO' | 'INTERROTTO';
    botUserId: string;
    botNote: string | null;
    assigneeIsBot: boolean;
}): Promise<LancioReturnResult> {
    const { leadId, motivo, outcome, botUserId, botNote, assigneeIsBot } = params;
    return await db.transaction(async (tx) => {
        const [cur] = await tx.select({
            status: leads.status,
            presentedAt: leads.presentedAt,
            appointmentDate: leads.appointmentDate,
            launchBucket: leads.launchBucket,
            lancioScelta: leads.lancioScelta,
        }).from(leads).where(eq(leads.id, leadId)).limit(1);
        if (!cur) return { ok: true, returned: false, note: 'lead_not_found' };

        const check = checkLancioReturnToPool({ ...cur, assigneeIsBot });
        if (!check.ok) return { ok: true, returned: false, note: check.reason };

        const now = new Date();
        await tx.update(leads)
            .set({
                assignedToId: null,
                status: 'NEW',
                callCount: 0,
                recallDate: null,
                recallNote: null,
                recallMissedAt: null,
                updatedAt: now,
                version: sql`${leads.version} + 1`,
            })
            .where(eq(leads.id, leadId));

        await tx.insert(leadEvents).values({
            id: crypto.randomUUID(),
            leadId,
            eventType: 'LANCIO_RETURNED_TO_POOL',
            userId: null,
            timestamp: now,
            metadata: { motivo, outcome, botNote, fromBot: botUserId, bucket: LANCIO_WEBDEV_BUCKET },
            companyId: FENICE,
        });

        return { ok: true, returned: true };
    });
}
```

(Se il Task 0 ha rilevato che `lancioScelta` non è nello schema e non l'hai aggiunta, togli quella riga dal select: `checkLancioReturnToPool` accetta `lancioScelta` assente.)

- [ ] **Step 2: Il route**

In `src/app/api/bot/outcome/route.ts`:

- Import: `import { LANCIO_WEBDEV_BUCKET, motivoRestituzioneDaNota } from '@/lib/bot-fissatore/lancioReturnRules';` e `import { returnLancioLeadToPool } from '@/lib/bot-fissatore/lancioReturn';`.
- Nel `db.select({ … })` del lead aggiungi `launchBucket: leads.launchBucket,` (e `lancioScelta: leads.lancioScelta,` non serve: lo rilegge la transazione).
- Sostituisci il ramo:

```ts
    if (typedOutcome === 'NON_RISPOSTO' || typedOutcome === 'INTERROTTO') {
        // Lead del lancio Web Developer AI ancora al bot (spec §4.6): niente round
        // robin, torna nel pool di /import e da lì gli admin lo distribuiscono ai GDO.
        // Un lead del lancio già passato a un GDO umano non arriva qui: il blocco di
        // autorizzazione sopra risponde 403 a questi due esiti sui lead non del bot.
        if (lead.launchBucket === LANCIO_WEBDEV_BUCKET && assigneeIsBot) {
            const motivo = motivoRestituzioneDaNota(note, typedOutcome);
            const r = await returnLancioLeadToPool({
                leadId, motivo, outcome: typedOutcome, botUserId: actorUserId, botNote: note ?? null, assigneeIsBot,
            });
            if (!r.returned) return NextResponse.json({ ok: true, returnedToPool: false, skipped: r.note });
            return NextResponse.json({ ok: true, returnedToPool: true, motivo });
        }

        const reason = typedOutcome === 'NON_RISPOSTO' ? 'mai_risposto' : 'chat_interrotta';
        const r = await reassignBotLeadToHumanPool(leadId, reason, actorUserId, note);
        if (r.assignedToId === null && 'note' in r && r.note !== 'no_eligible_gdo') {
            return NextResponse.json({ ok: true, reassigned: null, skipped: r.note });
        }
        return NextResponse.json({ ok: true, reassigned: r.assignedToId });
    }
```

- [ ] **Step 3: Verifica**

Run: `npx tsc --noEmit && npm test`
Expected: nessun errore, suite verde. Prova dal vivo (dopo il deploy, con il bot in QA del B6, o con `curl` firmato HMAC dallo script che il repo usa per i test degli esiti): lead `LANCIO_WEBDEV_2026` assegnato al bot, POST `{ leadId, outcome: 'NON_RISPOSTO', note: 'Lancio: mai risposto' }` → risposta `{ ok: true, returnedToPool: true, motivo: 'mai_risposto' }`; su `leads` `assignedToId` nullo, `status='NEW'`, `callCount=0`, `assignedAt` invariato; su `leadEvents` una riga `LANCIO_RETURNED_TO_POOL` con `metadata.motivo='mai_risposto'`. Stesso POST su un lead lancio con `appointmentDate` → `{ ok: true, returnedToPool: false, skipped: 'locked_appointment' }` e nessuna scrittura.

- [ ] **Step 4: Commit**

```bash
git add src/lib/bot-fissatore/lancioReturn.ts src/app/api/bot/outcome/route.ts
git commit -m "feat(lancio): NON_RISPOSTO/INTERROTTO sui lead del lancio li rimettono nel pool di /import"
```

---

### Task 12 (CRM): distribuzione dal pool senza riscrivere `assignedAt`; contatore "restituiti" sulla card

**Files:**
- Modify: `src/lib/launchPoolShared.ts` (`pickAndAssignBuckets`, update righe 69–77)
- Modify: l'action di stato del pool lancio del B1 (nome atteso `getLancioWebdevPoolStatus` in `src/app/actions/lancioPoolActions.ts`) e la sua card (nome atteso `src/components/LancioWebdevPoolCard.tsx`)

**Interfaces:**
- Consumes: `leadEvents` (Drizzle), `LANCIO_WEBDEV_BUCKET` (Task 10).
- Produces: `pickAndAssignBuckets` conserva `assignedAt` se già valorizzato (`COALESCE`); lo status del pool lancio espone `restituiti: number` = numero di lead distinti con almeno un evento `LANCIO_RETURNED_TO_POOL` (Fenice), e la card lo mostra.

- [ ] **Step 1: `COALESCE` in `pickAndAssignBuckets`**

In `src/lib/launchPoolShared.ts`, dentro il ciclo `for (const [gdoId, leadIds] of Object.entries(idsByGdo))`, sostituisci l'update con:

```ts
                const now = new Date()
                await tx
                    .update(leads)
                    // `assignedAt` è la data con cui il lead viene contato nel
                    // mese: il momento vero di ingresso nel funnel, non l'import
                    // nel pool (che può essere di mesi prima). COALESCE: un lead
                    // che TORNA nel pool (lancio Web Dev AI, spec §4.6: era già
                    // assegnato al bot) era già stato contato al primo ingresso e
                    // non si riconta. Per i pool classici il campo è nullo alla
                    // pesca e il comportamento resta identico.
                    .set({ assignedToId: gdoId, assignedAt: sql`COALESCE(${leads.assignedAt}, ${now})`, updatedAt: now })
                    .where(and(
                        eq(leads.companyId, companyId),
                        inArray(leads.id, leadIds),
                    ))
```

- [ ] **Step 2: Contatore `restituiti`**

Nell'action di stato del pool lancio (B1) aggiungi al risultato:

```ts
    const [restituitiRow] = await db
        .select({ restituiti: sql<number>`count(distinct ${leadEvents.leadId})::int` })
        .from(leadEvents)
        .where(and(
            eq(leadEvents.companyId, ctx.companyId),
            eq(leadEvents.eventType, 'LANCIO_RETURNED_TO_POOL'),
        ))
    // … nel return: restituiti: restituitiRow?.restituiti ?? 0
```

(import `leadEvents` da `@/db/schema` se manca). Nella card, accanto agli altri contatori (nel pool / al bot / assegnati ai GDO), aggiungi una cella "Restituiti dal bot" con `status.restituiti`, stesso stile delle altre. Se l'action del B1 restituisce già `restituiti` calcolato così, non duplicare: verifica solo che la card lo mostri.

- [ ] **Step 3: Verifica**

Run: `npx tsc --noEmit && npm test`
Expected: verde. Manuale: `/import` con azienda Fenice mostra la card del lancio con il contatore "Restituiti dal bot" (0 finché non ci sono eventi); dopo il test del Task 11 step 3 il contatore vale 1; distribuendo quel lead a un GDO dalla card, `assignedAt` su `leads` resta la data originaria.

- [ ] **Step 4: Commit**

```bash
git add src/lib/launchPoolShared.ts src/app/actions/lancioPoolActions.ts src/components/LancioWebdevPoolCard.tsx
git commit -m "feat(lancio): la distribuzione dal pool conserva assignedAt e la card conta i restituiti"
```

(Adegua i path ai nomi reali del B1.)

---

### Task 13 (CRM): `AgendaButton` — "Offerta del mese" come pulsante evidente

**Files:**
- Modify: `src/components/AgendaButton.tsx` (blocco `{/* Offerta del Mese checkbox */}` righe ~229–255; stato `offertaDelMese`)

**Interfaces:**
- Consumes: niente di nuovo.
- Produces: nessun cambio di payload (`sendAgendaToLead(leadId, { lavora, haFamiglia, offertaDelMese })` invariato). UI: un pulsante-toggle a tutta larghezza in cima al corpo della modale, `aria-pressed`, che quando è acceso azzera e disabilita lavora/famiglia (come oggi).

- [ ] **Step 1: Aggiungi il gestore del toggle**

Sotto `handleClose` in `AgendaButton`:

```tsx
    const toggleOffertaDelMese = () => {
        if (loading) return
        setOffertaDelMese((on) => {
            const next = !on
            if (next) {
                setLavora(null)
                setHaFamiglia(null)
            }
            return next
        })
    }
```

- [ ] **Step 2: Sostituisci la spunta con il pulsante**

Al posto dell'intero `<label className={… offertaDelMese ? 'border-purple-500 …'}> … </label>` metti:

```tsx
                                    {/* Offerta del mese: pulsante evidente in cima (spec lancio §4.7).
                                        Acceso ⇒ il bot manda il video dell'offerta e ignora lavora/famiglia.
                                        Il payload non cambia: viaggia sempre variant.offertaDelMese. */}
                                    <button
                                        type="button"
                                        onClick={toggleOffertaDelMese}
                                        disabled={loading}
                                        aria-pressed={offertaDelMese}
                                        className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all disabled:opacity-50 ${offertaDelMese
                                            ? 'border-purple-600 bg-gradient-to-r from-purple-600 to-fuchsia-600 text-white shadow-md'
                                            : 'border-purple-300 bg-purple-50 text-purple-800 hover:border-purple-500 hover:bg-purple-100'
                                            }`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <Sparkles className="w-4 h-4 shrink-0" />
                                            <div>
                                                <div className="text-sm font-bold">Offerta del mese</div>
                                                <div className={`text-[11px] ${offertaDelMese ? 'text-purple-100' : 'text-purple-700/80'}`}>
                                                    {offertaDelMese
                                                        ? 'Attiva: il lead riceve il video dell\'offerta, le domande sotto non servono'
                                                        : 'Tocca per mandare il video dell\'offerta al posto di quello lavora/famiglia'}
                                                </div>
                                            </div>
                                        </div>
                                        <div className={`shrink-0 text-[11px] font-bold uppercase tracking-wider px-2 py-1 rounded-md ${offertaDelMese ? 'bg-white/20' : 'bg-purple-200/70'}`}>
                                            {offertaDelMese ? 'ON' : 'OFF'}
                                        </div>
                                    </button>
```

Il resto (domande lavora/famiglia disabilitate con `offertaDelMese`, `canSubmit`, `handleSubmit`) resta com'è. Nessun bottone interattivo dentro `<span>`/`<p>` (regola 1 di CLAUDE.md): il pulsante sta dentro il `<div className="p-5 space-y-5">`.

- [ ] **Step 3: Verifica**

Run: `npx tsc --noEmit && npm run lint`
Expected: verde. Manuale da account GDO Fenice: apri "Agenda" su un lead → il pulsante viola è in cima; toccato diventa pieno con "ON", lavora/famiglia si spengono e "Invia Agenda" è attivo; toccato di nuovo torna "OFF" e "Invia Agenda" si disattiva finché non rispondi alle due domande. Invia con ON e verifica nel bot (`conversations.gdo_video_url`) che il link sia quello di `offerta_del_mese_link` (o il ripiego).

- [ ] **Step 4: Commit**

```bash
git add src/components/AgendaButton.tsx
git commit -m "feat(agenda): 'Offerta del mese' diventa un pulsante evidente in cima alla modale"
```

---

### Task 14 (BOT + CRM): chiusura del blocco

**Files:**
- Nessun file nuovo. Env su Vercel (bot): `LANCIO_FOLLOWUP_TEMPLATE_SID` (dal B0), opzionale `OFFERTA_DEL_MESE_LINK`.

- [ ] **Step 1: Suite completa e typecheck, bot**

Run (BOT): `npx vitest run && npx tsc --noEmit && npm run lint`
Expected: tutto verde.

- [ ] **Step 2: Suite completa e typecheck, CRM**

Run (CRM): `npm test && npx tsc --noEmit && npm run lint`
Expected: tutto verde.

- [ ] **Step 3: Env e verifica dei cron**

Su Vercel (progetto del bot) imposta `LANCIO_FOLLOWUP_TEMPLATE_SID` con il SID del template 3 approvato. Dopo il push, nel pannello Cron di Vercel devono comparire `/api/cron/lancio-followup` e `/api/cron/lancio-restituzioni` con gli schedule del piano. Prova in produzione (nessun invio): `curl "https://<bot>/api/cron/lancio-followup?secret=…&dry=1&forza=1"` e `curl "https://<bot>/api/cron/lancio-restituzioni?secret=…&dry=1&forza=1"`.

- [ ] **Step 4: Push (solo dopo la review del blocco)**

```bash
git push origin main
```

in entrambi i repo.

---

## Self-review (fatta scrivendo il piano)

**Copertura della spec (perimetro B5):**
- §5.5 cron follow-up, fasce, bersaglio con inbound, `LANCIO_BATCH_MAX` 250, template, `followup_inviato` → Task 4, 5. Risposta → `chiuso` + flusso standard + video live via `contextNote` e override dei link → Task 3, 6.
- §5.8 restituzioni dall'8/10, due note, `restituito` + `closed`, mai su `scelta_fatta/chiuso/restituito` → Task 7, 8.
- §5.7 + §3.2 `videoLinkForVariant` da impostazione con fallback env → Black Summer, `gdo-video-followups` con link dinamico, pagina `/fenice` con i tre link e `lancio_attivo`, helper `lib/lancio-settings.ts` → Task 1, 2, 9.
- §4.6 ritorno al pool: guardie, `assignedAt` conservato, evento con `metadata.motivo` dalla nota, `assignFromLaunchPool`/`pickAndAssignBuckets` con COALESCE, contatore "restituiti" → Task 10, 11, 12.
- §4.7 pulsante "Offerta del mese", payload invariato → Task 13.
- Vincoli: 63049 → `sendTemplateAndLogConCap` (Task 5); niente `export const` nei file `'use server'` (le costanti stanno in `src/lib/bot-fissatore/lancioReturnRules.ts`); test puri per selezione, decisione, motivo, finestra, validazione.

**Fuori dal perimetro, segnalato e non fatto:** una conversazione in `attesa`/`link_inviato` **con** inbound che non riceve mai il follow-up (cap 63049 per tutta la finestra, template non configurato) resta al bot per sempre: né follow-up né restituzione. È coerente con la spec (§5.8 restituisce solo chi non ha alcun inbound) ma va tenuto d'occhio nel monitor del B6; se serve, un ritocco a `decideRestituzione` (fase `attesa`/`link_inviato` con inbound e `now ≥ 9/10`) è una riga più un test.

**Coerenza dei nomi fra task:** `getLancioSettings/setLancioSetting/isLancioAttivo/validateLancioSettingInput` (1 → 2, 5, 6, 9); `resolveOffertaDelMeseLink/videoLinkForVariant(v, settings)` (2 → 9); `videoTemplateEnvForLink` (2); `unknownFeniceLinks(text, extra)`, `containsVideoLink(p, extra)`, `ensureConfirmationBlock(parts, { extraVideoLinks })` (3 → 6); `LANCIO_BATCH_MAX`, `FASI_FOLLOWUP`, `isLancioFollowupWindow`, `haInteragito`, `selectFollowupTargets`, `isLancioStandardFlow`, `lancioStandardContextNote`, `lancioFollowupText` (4 → 5, 6, 7); `runPool`, `sendTemplateAndLogConCap` (5 → 8); `NOTA_RESTITUZIONE`, `FASI_RESTITUIBILI`, `isRestituzioniActive`, `selectRestituzioni` (7 → 8); `LANCIO_WEBDEV_BUCKET`, `motivoRestituzioneDaNota`, `checkLancioReturnToPool` (10 → 11, 12); `returnLancioLeadToPool` (11).
