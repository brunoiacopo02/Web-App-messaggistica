# Parco numeri del bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** il bot sceglie da solo, alla nascita di ogni chat, fra il numero storico e N numeri secondari con un tetto giornaliero per numero letto da `app_settings`, fallendo chiuso sul 3199.

**Architecture:** tre moduli puri/sottili (`twilio-account` a slot, `mittente` con elenco secondari, `tetti-numeri`) e un solo punto di decisione (`scelta-mittente.ts`) usato da `enrollLeadIntoMario` e da `mittenteBenvenutoLancio`. Con le env nuove assenti il comportamento è quello di oggi.

**Tech Stack:** Next 16, TypeScript, Supabase JS, Vitest (`bun test`), bun. Worktree: `C:\Users\bruno\Desktop\Software-Messaggistica-parco-numeri`, branch `feat/parco-numeri`.

**Spec:** `docs/superpowers/specs/2026-09-26-parco-numeri-design.md`

## Global Constraints

- Il numero di una chat si sceglie **solo alla nascita** (`conversations.wa_number`); nessun task cambia il numero di una chat esistente.
- Ogni dubbio = **3199** (`numeroPrimario()`), con riga in `event_log`. Mai un invio da un numero non scelto.
- `app_settings.tetti_numeri`: secondario assente o valore non intero/negativo = **0**. Il primario non ha tetto.
- Giorno = giorno civile di **Roma** (`inizioGiornataRoma` di `lib/bot2-tetto.ts`).
- Con `BOT_NUMERI_SECONDARI` assente vale `TWILIO_WHATSAPP_NUMBER_FENICE_2` come unico secondario.
- Numeri in forma `whatsapp:+39…` nelle env e in `wa_number`; i confronti accettano anche `+39…`.
- Niente modifiche a testi verso i lead, orari, sequenze, contratto CRM (resta v1.7).
- Commenti in italiano, stile del repo; test accanto al modulo in `lib/`.
- Prima del push: `bun run typecheck`, `bun test`, `bun run build` verdi. **Il push su main = deploy: lo autorizza il PO.**

## Review Focus

1. Un secondario con tetto > 0 ma **template d'apertura non esistente** su quell'account (elixir prima dell'approvazione Meta) → la chat nasce sul 3199, non sul numero muto. Test in Task 5.
2. `tetti_numeri` scritto a mano con una chiave **senza `whatsapp:`** (`"+393522018718": 150`) → deve valere lo stesso numero. Test in Task 3.
3. CRM non ancora aggiornato che manda **`numeroBot: 2` o `riscaldamento: true`** → non deve forzare il 0047 a riposo. Test in Task 6.
4. **Conteggio in errore** su un solo numero → quel numero scartato, gli altri restano candidati. Test in Task 5.
5. Numero secondario sul **principale** (8061) → nessuna traduzione, credenziali del principale. Test in Task 1.

---

### Task 1: Account Twilio a slot (2 e 3)

**Files:**
- Modify: `lib/twilio-account.ts`
- Modify: `lib/template-account.ts:111,206`
- Modify: `lib/lancio-monitor-db.ts:388-391`
- Test: `lib/twilio-account.test.ts`, `lib/template-account.test.ts`

**Interfaces:**
- Produces: `credenzialiPerMittente(from?: string|null): CredenzialiTwilio|null` (invariata nella firma), `eSuAltroAccount(from?: string|null): boolean` (nuova), `eDelSecondoAccount` resta come alias di `eSuAltroAccount`, `credenzialiSecondarie(): CredenzialiTwilio[]` (nuova, per il monitor).

- [ ] **Step 1: test che falliscono** — in `lib/twilio-account.test.ts` aggiungere a `CHIAVI` le tre chiavi `_3` e questi casi:

```ts
import { credenzialiPerMittente, eDelSecondoAccount, eSuAltroAccount, credenzialiSecondarie } from './twilio-account';

describe('terzo account', () => {
  beforeEach(() => {
    process.env.TWILIO_ACCOUNT_SID_3 = 'AC_terzo';
    process.env.TWILIO_AUTH_TOKEN_3 = 'tok_terzo';
    process.env.TWILIO_WHATSAPP_NUMBERS_3 = 'whatsapp:+393522018718';
  });

  it('un numero del terzo account usa le sue credenziali', () => {
    expect(credenzialiPerMittente('+393522018718')).toEqual({ sid: 'AC_terzo', token: 'tok_terzo' });
    expect(credenzialiPerMittente('whatsapp:+393522018718')?.sid).toBe('AC_terzo');
  });

  it('il secondo account resta com era', () => {
    expect(credenzialiPerMittente('+393522070047')?.sid).toBe('AC_secondo');
  });

  it('un numero secondario che sta sul principale (8061) usa il principale e non e su un altro account', () => {
    expect(credenzialiPerMittente('whatsapp:+393520158061')?.sid).toBe('AC_primo');
    expect(eSuAltroAccount('whatsapp:+393520158061')).toBe(false);
  });

  it('eSuAltroAccount vale per secondo e terzo; eDelSecondoAccount e un alias', () => {
    expect(eSuAltroAccount('+393522018718')).toBe(true);
    expect(eSuAltroAccount('+393522070047')).toBe(true);
    expect(eDelSecondoAccount('+393522018718')).toBe(true);
  });

  it('terzo account senza credenziali: ripiega sul primo', () => {
    delete process.env.TWILIO_AUTH_TOKEN_3;
    expect(credenzialiPerMittente('+393522018718')?.sid).toBe('AC_primo');
  });

  it('credenzialiSecondarie elenca solo gli account configurati', () => {
    expect(credenzialiSecondarie().map((c) => c.sid)).toEqual(['AC_secondo', 'AC_terzo']);
    delete process.env.TWILIO_ACCOUNT_SID_2;
    expect(credenzialiSecondarie().map((c) => c.sid)).toEqual(['AC_terzo']);
  });
});
```

- [ ] **Step 2:** `bun test lib/twilio-account.test.ts` → FAIL (`eSuAltroAccount` non esportata).

- [ ] **Step 3: implementazione** — in `lib/twilio-account.ts` sostituire `secondario()`, `numeriDelSecondo()`, `credenzialiPerMittente`, `eDelSecondoAccount` con:

```ts
/**
 * Gli account oltre al principale, per slot. Lo slot N legge
 * `TWILIO_ACCOUNT_SID_N`, `TWILIO_AUTH_TOKEN_N` e `TWILIO_WHATSAPP_NUMBERS_N`.
 * Il 2 e' "Account fenice 2" (+393522070047, 16/09/2026), il 3 e' "account
 * elixir" (+393522018718, 26/09/2026). Un numero non elencato in nessuno slot
 * sta sul principale: e' il caso di +393520158061, stesso account del 3199.
 */
const SLOT = [2, 3] as const;

function slot(n: number): { cred: CredenzialiTwilio | null; numeri: string[] } {
  const sid = process.env[`TWILIO_ACCOUNT_SID_${n}`];
  const token = process.env[`TWILIO_AUTH_TOKEN_${n}`];
  const numeri = (process.env[`TWILIO_WHATSAPP_NUMBERS_${n}`] ?? '')
    .split(',')
    .map((x) => soloNumero(x))
    .filter(Boolean);
  return { cred: sid && token ? { sid, token } : null, numeri };
}

/** Lo slot che dichiara questo numero, o null se il numero sta sul principale. */
function slotDi(from?: string | null): number | null {
  const numero = soloNumero(from);
  if (!numero) return null;
  for (const n of SLOT) if (slot(n).numeri.includes(numero)) return n;
  return null;
}

export function credenzialiPerMittente(from?: string | null): CredenzialiTwilio | null {
  const n = slotDi(from);
  if (n !== null) {
    const cred = slot(n).cred;
    if (cred) return cred;
    console.error(
      `[twilio] ${soloNumero(from)} e' dichiarato sull'account ${n} ma TWILIO_ACCOUNT_SID_${n}/TWILIO_AUTH_TOKEN_${n} mancano`,
    );
  }
  return principale();
}

/** true se quel numero sta su un account diverso dal principale. */
export function eSuAltroAccount(from?: string | null): boolean {
  return slotDi(from) !== null;
}

/** Nome storico, usato ancora dai chiamanti del secondo numero. */
export const eDelSecondoAccount = eSuAltroAccount;

/** Le credenziali degli account secondari configurati, in ordine di slot. */
export function credenzialiSecondarie(): CredenzialiTwilio[] {
  return SLOT.map((n) => slot(n).cred).filter((c): c is CredenzialiTwilio => c !== null);
}
```

Aggiornare il commento di testa (da "due account" a "principale + slot").

- [ ] **Step 4:** in `lib/template-account.ts` sostituire l'import e l'uso: `import { credenzialiPerMittente, eSuAltroAccount } from './twilio-account';` e in `traduciTemplate` `if (!eSuAltroAccount(from)) return { sid: contentSid, tradotto: true };`. In `lib/lancio-monitor-db.ts` (`nomeTemplateTwilio`) la lista `account` diventa:

```ts
  const account = [
    [process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN],
    ...credenzialiSecondarie().map((c) => [c.sid, c.token]),
  ].filter((x): x is [string, string] => !!x[0] && !!x[1]);
```
con `import { credenzialiSecondarie } from './twilio-account';`.

- [ ] **Step 5:** aggiungere in `lib/template-account.test.ts` un caso che, con `TWILIO_ACCOUNT_SID_3/TOKEN_3/NUMBERS_3` impostati e il `fetch` finto del file, `traduciTemplate('HX_ORIG', 'whatsapp:+393522018718')` chiami la Content API con le credenziali del terzo account e torni il SID trovato per nome (copiare lo schema del caso esistente sul secondo account, sostituendo `AC_secondo` con `AC_terzo`), e un caso `traduciTemplate('HX_ORIG', 'whatsapp:+393520158061')` → `{ sid: 'HX_ORIG', tradotto: true }` senza chiamate `fetch`.

- [ ] **Step 6:** `bun test lib/twilio-account.test.ts lib/template-account.test.ts lib/lancio-monitor` → PASS.

- [ ] **Step 7: commit** — `git add lib/twilio-account.ts lib/twilio-account.test.ts lib/template-account.ts lib/template-account.test.ts lib/lancio-monitor-db.ts && git commit -m "feat(numeri): account Twilio a slot, il terzo e' elixir"`

---

### Task 2: Elenco dei numeri del bot

**Files:**
- Modify: `lib/mittente.ts`
- Test: `lib/mittente.test.ts`

**Interfaces:**
- Produces: `numeriSecondari(): string[]` (forma grezza da env, `whatsapp:+39…`), `numeriDelBot(): string[]` = `[primario, ...secondari]`, `eNumeroDelBot` invariata nella firma. `mittentePerNuovaConversazione()` torna **sempre** `numeroPrimario()` (il sorteggio `FENICE_NUMERO2_QUOTA` sparisce: nessuna chat nasce su un secondario senza passare dai tetti). `numeroSecondo()` resta finché Task 6 non toglie l'ultimo uso.

- [ ] **Step 1: test che falliscono** in `lib/mittente.test.ts` (aggiungere `BOT_NUMERI_SECONDARI` alle chiavi salvate/ripristinate del file):

```ts
describe('numeri secondari', () => {
  it('senza BOT_NUMERI_SECONDARI vale il solo numero 2 di sempre', () => {
    delete process.env.BOT_NUMERI_SECONDARI;
    process.env.TWILIO_WHATSAPP_NUMBER_FENICE_2 = 'whatsapp:+393522070047';
    expect(numeriSecondari()).toEqual(['whatsapp:+393522070047']);
  });

  it('con BOT_NUMERI_SECONDARI vale l elenco, pulito da spazi e vuoti', () => {
    process.env.BOT_NUMERI_SECONDARI = ' whatsapp:+393522070047, whatsapp:+393522018718 ,,whatsapp:+393520158061 ';
    expect(numeriSecondari()).toEqual([
      'whatsapp:+393522070047', 'whatsapp:+393522018718', 'whatsapp:+393520158061',
    ]);
  });

  it('il primario non compare due volte anche se messo per errore fra i secondari', () => {
    process.env.BOT_NUMERI_SECONDARI = 'whatsapp:+393520413199,whatsapp:+393522018718';
    expect(numeriDelBot()).toEqual(['whatsapp:+393520413199', 'whatsapp:+393522018718']);
  });

  it('eNumeroDelBot riconosce tutti i secondari, con e senza prefisso', () => {
    process.env.BOT_NUMERI_SECONDARI = 'whatsapp:+393522018718,whatsapp:+393520158061';
    expect(eNumeroDelBot('whatsapp:+393522018718')).toBe(true);
    expect(eNumeroDelBot('+393520158061')).toBe(true);
    expect(eNumeroDelBot('whatsapp:+15559919332')).toBe(false);
  });

  it('una chat nuova senza scelta esplicita nasce sempre sul primario, qualunque quota', () => {
    process.env.FENICE_NUMERO2_QUOTA = '100';
    expect(mittentePerNuovaConversazione(() => 0)).toBe('whatsapp:+393520413199');
  });
});
```
(nel `beforeEach` del file il primario è `whatsapp:+393520413199`; se non lo è, impostarlo.) Rimuovere o riscrivere i test esistenti che si aspettano il sorteggio verso il secondo numero con `FENICE_NUMERO2_QUOTA`: ora devono aspettarsi il primario.

- [ ] **Step 2:** `bun test lib/mittente.test.ts` → FAIL.

- [ ] **Step 3: implementazione** in `lib/mittente.ts`:

```ts
/**
 * I numeri secondari del bot, da `BOT_NUMERI_SECONDARI` (separati da virgola).
 * Assente = il solo `TWILIO_WHATSAPP_NUMBER_FENICE_2`, com'era fino al 26/09/2026:
 * cosi' il deploy di questo codice non cambia niente finche' non si scrive l'env.
 * Essere nell'elenco vuol dire due cose: il webhook sveglia Mario sulle risposte
 * a quel numero, e il numero PUO' essere scelto per una chat nuova — se ha un
 * tetto in `app_settings.tetti_numeri` (lib/tetti-numeri.ts).
 */
export function numeriSecondari(): string[] {
  const grezzo = process.env.BOT_NUMERI_SECONDARI;
  const lista = grezzo === undefined
    ? [numeroSecondo()].filter((n): n is string => Boolean(n))
    : grezzo.split(',').map((n) => n.trim()).filter(Boolean);
  const primario = soloNumero(numeroPrimario());
  const visti = new Set<string>();
  return lista.filter((n) => {
    const k = soloNumero(n);
    if (!k || k === primario || visti.has(k)) return false;
    visti.add(k);
    return true;
  });
}

export function numeriDelBot(): string[] {
  const primario = numeroPrimario();
  return [...(primario ? [primario] : []), ...numeriSecondari()];
}

/**
 * Il mittente di una conversazione che nasce senza una scelta esplicita: il
 * primario. Dal 26/09/2026 una chat nasce su un secondario solo passando da
 * `scegliMittenteNuovo` (lib/scelta-mittente.ts), che guarda tetti e template.
 * Il vecchio sorteggio `FENICE_NUMERO2_QUOTA` lo scavalcava: tolto.
 * `sorteggio` resta nella firma per non rompere i chiamanti.
 */
export function mittentePerNuovaConversazione(_sorteggio: () => number = Math.random): string | undefined {
  return numeroPrimario();
}
```
Eliminare `quotaSecondo()` e il suo test se non ha altri usi (`git grep quotaSecondo`).

- [ ] **Step 4:** `bun test lib/mittente.test.ts` → PASS; `bun run typecheck` → nessun errore nuovo.

- [ ] **Step 5: commit** — `git commit -am "feat(numeri): elenco BOT_NUMERI_SECONDARI, niente piu' sorteggio verso il secondo"`

---

### Task 3: Tetti per numero da `app_settings`

**Files:**
- Create: `lib/tetti-numeri.ts`
- Test: `lib/tetti-numeri.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces: `parseTettiNumeri(raw: unknown): Map<string, number>` (chiave = numero senza `whatsapp:`), `tettoDi(tetti: Map<string, number>, numero: string): number`, `getTettiNumeri(supabase: Supa): Promise<Map<string, number> | null>` (null = lettura fallita).

- [ ] **Step 1: test che falliscono** — `lib/tetti-numeri.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseTettiNumeri, tettoDi, getTettiNumeri } from './tetti-numeri';

describe('parseTettiNumeri', () => {
  it('legge la mappa e normalizza le chiavi', () => {
    const t = parseTettiNumeri({ 'whatsapp:+393522018718': 150, '+393520158061': 150, 'whatsapp:+393522070047': 0 });
    expect(tettoDi(t, 'whatsapp:+393522018718')).toBe(150);
    expect(tettoDi(t, 'whatsapp:+393520158061')).toBe(150);
    expect(tettoDi(t, '+393522070047')).toBe(0);
  });

  it('numero assente = 0', () => {
    expect(tettoDi(parseTettiNumeri({}), 'whatsapp:+393522018718')).toBe(0);
  });

  it('valori strani = 0', () => {
    const t = parseTettiNumeri({ '+391': -5, '+392': 3.5, '+393': 'tanti', '+394': null, '+395': '40' });
    for (const n of ['+391', '+392', '+393', '+394']) expect(tettoDi(t, n), n).toBe(0);
    expect(tettoDi(t, '+395')).toBe(40); // stringa intera: accettata, e' come la scrive un umano
  });

  it('non un oggetto = mappa vuota', () => {
    for (const raw of [null, undefined, 'x', 3, [1, 2]]) expect(parseTettiNumeri(raw).size).toBe(0);
  });
});

describe('getTettiNumeri', () => {
  const finto = (risposta: { data?: unknown; error?: unknown; lancia?: boolean }) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => {
      if (risposta.lancia) throw new Error('rete giu');
      return { data: risposta.data ?? null, error: risposta.error ?? null };
    } }) }) }),
  }) as never;

  it('riga presente', async () => {
    const t = await getTettiNumeri(finto({ data: { value: { '+393522018718': 150 } } }));
    expect(t && tettoDi(t, '+393522018718')).toBe(150);
  });
  it('riga assente = mappa vuota (tutti a 0)', async () => {
    expect((await getTettiNumeri(finto({ data: null })))?.size).toBe(0);
  });
  it('errore o eccezione = null', async () => {
    expect(await getTettiNumeri(finto({ error: { message: 'boom' } }))).toBeNull();
    expect(await getTettiNumeri(finto({ lancia: true }))).toBeNull();
  });
});
```

- [ ] **Step 2:** `bun test lib/tetti-numeri.test.ts` → FAIL (modulo mancante).

- [ ] **Step 3: implementazione** — `lib/tetti-numeri.ts`:

```ts
import type { getSupabaseAdmin } from './supabase/admin';

type Supa = ReturnType<typeof getSupabaseAdmin>;

/**
 * Quante chat NUOVE al giorno puo' aprire ogni numero secondario del bot.
 *
 * Vive in `app_settings.tetti_numeri` e non in una env perche' il PO la gira a
 * mano, senza deploy (delibera 26/09/2026: 150 elixir, 150 8061, 0 il 0047 a
 * riposo). Per esempio:
 *   update app_settings set value='{"whatsapp:+393522018718":150}'::jsonb where key='tetti_numeri';
 *
 * Fallisce chiuso: un numero assente, o con un valore che non e' un intero >= 0,
 * vale 0 — cioe' non apre niente. Un numero nuovo si brucia col volume, e
 * l'unico volume giusto e' quello che una persona ha scritto.
 * Il primario non passa di qui: non ha tetto.
 */
const KEY = 'tetti_numeri';

function chiave(n: string): string {
  return n.trim().replace(/^whatsapp:/i, '');
}

export function parseTettiNumeri(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 0) out.set(chiave(k), n);
  }
  return out;
}

export function tettoDi(tetti: Map<string, number>, numero: string): number {
  return tetti.get(chiave(numero)) ?? 0;
}

/** null = non si e' potuto leggere: chi chiama tratta tutti i secondari come chiusi. */
export async function getTettiNumeri(supabase: Supa): Promise<Map<string, number> | null> {
  try {
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', KEY).maybeSingle();
    if (error) {
      console.error('[tetti-numeri] lettura fallita: nessun secondario apre', error);
      return null;
    }
    return parseTettiNumeri((data as { value?: unknown } | null)?.value);
  } catch (e) {
    console.error('[tetti-numeri] lettura esplosa: nessun secondario apre', e);
    return null;
  }
}
```

- [ ] **Step 4:** `bun test lib/tetti-numeri.test.ts` → PASS.

- [ ] **Step 5: commit** — `git add lib/tetti-numeri.ts lib/tetti-numeri.test.ts && git commit -m "feat(numeri): tetti per numero in app_settings, fail-closed"`

---

### Task 4: Conteggio delle chat nate oggi, per un numero qualunque

**Files:**
- Modify: `lib/bot2-tetto.ts`
- Test: `lib/bot2-tetto.test.ts`

**Interfaces:**
- Produces: `chatNateOggi(supabase: Supa, numero: string, adesso?: Date): Promise<number | null>` (null = conteggio fallito). `puoAprireSuBot2` viene riscritta sopra `chatNateOggi` senza cambiare comportamento (la tolgono i Task 6/7 se resta senza usi).

- [ ] **Step 1: test che falliscono** — in `lib/bot2-tetto.test.ts`:

```ts
import { chatNateOggi } from './bot2-tetto';

describe('chatNateOggi', () => {
  it('torna il conteggio', async () => {
    expect(await chatNateOggi(finto({ count: 12 }), 'whatsapp:+393522018718')).toBe(12);
  });
  it('errore, eccezione o conteggio nullo = null', async () => {
    expect(await chatNateOggi(finto({ error: { message: 'x' } }), NUM)).toBeNull();
    expect(await chatNateOggi(finto({ lancia: true }), NUM)).toBeNull();
    expect(await chatNateOggi(finto({ count: null }), NUM)).toBeNull();
  });
});
```

- [ ] **Step 2:** `bun test lib/bot2-tetto.test.ts` → FAIL.

- [ ] **Step 3: implementazione** — in `lib/bot2-tetto.ts` aggiungere e far usare a `puoAprireSuBot2`:

```ts
/**
 * Quante conversazioni sono NATE oggi (giorno di Roma) con quel `wa_number`.
 * E' la prova di cosa e' davvero partito, non un contatore a parte. null =
 * conteggio non riuscito: chi chiama deve trattarlo come "numero chiuso".
 */
export async function chatNateOggi(supabase: Supa, numero: string, adesso: Date = new Date()): Promise<number | null> {
  try {
    const { count, error } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('wa_number', numero)
      .gte('created_at', inizioGiornataRoma(adesso));
    if (error || count === null || count === undefined) {
      console.error(`[numeri] conteggio di oggi per ${numero} non riuscito`, error);
      return null;
    }
    return count;
  } catch (e) {
    console.error(`[numeri] conteggio di oggi per ${numero} esploso`, e);
    return null;
  }
}
```
e in `puoAprireSuBot2` sostituire il blocco `try/catch` con:

```ts
  const count = await chatNateOggi(supabase, numeroSecondo, adesso);
  if (count === null) return { consentito: false, oggi: 0, tetto, motivo: 'conteggio_fallito' };
  if (count >= tetto) return { consentito: false, oggi: count, tetto, motivo: 'tetto_raggiunto' };
  return { consentito: true, oggi: count, tetto, motivo: 'ok' };
```

- [ ] **Step 4:** `bun test lib/bot2-tetto.test.ts` → PASS (anche i test vecchi).

- [ ] **Step 5: commit** — `git commit -am "refactor(numeri): chatNateOggi, conteggio per qualunque numero"`

---

### Task 5: `scegliMittenteNuovo`

**Files:**
- Create: `lib/scelta-mittente.ts`
- Test: `lib/scelta-mittente.test.ts`

**Interfaces:**
- Consumes: `numeroPrimario`, `numeriSecondari` (Task 2), `getTettiNumeri`, `tettoDi` (Task 3), `chatNateOggi` (Task 4), `spedibileDa(templateSid, numero): Promise<EsitoSpedibilita>` da `lib/lancio-mittente.ts` (esistente).
- Produces:

```ts
export type Scarto = { numero: string; motivo: 'tetto_zero' | 'tetto_raggiunto' | 'conteggio_fallito' | 'template_non_tradotto' | 'template_bloccato'; oggi?: number; tetto?: number; errore?: string | null };
export type SceltaMittente = { from: string; secondario: boolean; scartati: Scarto[]; motivo: 'scelto' | 'nessun_candidato' | 'tetti_illeggibili' | 'nessun_secondario' };
export async function scegliMittenteNuovo(supabase: Supa, i: { templateSids: string[]; chiave: string; crmLeadId?: string | null; ignoraTetti?: boolean; adesso?: Date }): Promise<SceltaMittente>
export function sidAperturaMario(): string[]
```
`scegliMittenteNuovo` lancia solo se manca il primario (configurazione rotta, come oggi).

- [ ] **Step 1: test che falliscono** — `lib/scelta-mittente.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./lancio-mittente', () => ({ spedibileDa: vi.fn(async (sid: string) => ({ ok: true, sidTradotto: sid })) }));
vi.mock('./bot2-tetto', () => ({ chatNateOggi: vi.fn(async () => 0) }));
vi.mock('./tetti-numeri', async (orig) => ({ ...(await orig<typeof import('./tetti-numeri')>()), getTettiNumeri: vi.fn() }));

import { scegliMittenteNuovo, sidAperturaMario } from './scelta-mittente';
import { spedibileDa } from './lancio-mittente';
import { chatNateOggi } from './bot2-tetto';
import { getTettiNumeri, parseTettiNumeri } from './tetti-numeri';

const P = 'whatsapp:+393520413199';
const ELIXIR = 'whatsapp:+393522018718';
const N8061 = 'whatsapp:+393520158061';
const N0047 = 'whatsapp:+393522070047';

function supa() {
  const eventi: any[] = [];
  return { eventi, s: { from: () => ({ insert: (r: any) => { eventi.push(r); return Promise.resolve({ error: null }); } }) } as any };
}
const tetti = (o: Record<string, number>) => vi.mocked(getTettiNumeri).mockResolvedValue(parseTettiNumeri(o));
const scegli = (s: any, extra: Partial<Parameters<typeof scegliMittenteNuovo>[1]> = {}) =>
  scegliMittenteNuovo(s, { templateSids: ['HX_A'], chiave: '+393331234567', ...extra });

beforeEach(() => {
  process.env.TWILIO_WHATSAPP_NUMBER_FENICE = P;
  process.env.BOT_NUMERI_SECONDARI = `${N0047},${ELIXIR},${N8061}`;
  vi.mocked(spedibileDa).mockReset().mockImplementation(async (sid: string) => ({ ok: true, sidTradotto: sid }));
  vi.mocked(chatNateOggi).mockReset().mockResolvedValue(0);
});
afterEach(() => { delete process.env.BOT_NUMERI_SECONDARI; });

describe('scegliMittenteNuovo', () => {
  it('prende il secondario con meno chat oggi', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150, [N0047]: 0 });
    vi.mocked(chatNateOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? 40 : 12));
    const { s } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: N8061, secondario: true, motivo: 'scelto' });
  });

  it('a parita vince l ordine della lista', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    expect((await scegli(supa().s)).from).toBe(ELIXIR);
  });

  it('tetto zero o assente: il numero non e nemmeno contato', async () => {
    tetti({ [ELIXIR]: 150 });
    await scegli(supa().s);
    expect(vi.mocked(chatNateOggi).mock.calls.map((c) => c[1])).toEqual([ELIXIR]);
  });

  it('tutti pieni: 3199, e un evento info per numero', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    vi.mocked(chatNateOggi).mockResolvedValue(150);
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: P, secondario: false, motivo: 'nessun_candidato' });
    expect(eventi.filter((e) => e.type === 'mittente_tetto')).toHaveLength(2);
  });

  // Review Focus 1: elixir prima che Meta approvi i template.
  it('template non esistente sull account di elixir: elixir scartato, si usa il 8061', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    vi.mocked(spedibileDa).mockImplementation(async (sid, n) =>
      n === ELIXIR ? { ok: false, motivo: 'template_non_tradotto', sidTradotto: sid, errore: '404' } : { ok: true, sidTradotto: sid });
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r.from).toBe(N8061);
    expect(eventi.find((e) => e.type === 'mittente_ripiego')?.payload).toMatchObject({ numero: ELIXIR, motivo: 'template_non_tradotto' });
  });

  it('basta UN template non spedibile per scartare il numero', async () => {
    tetti({ [ELIXIR]: 150 });
    vi.mocked(spedibileDa).mockImplementation(async (sid) =>
      sid === 'HX_B' ? { ok: false, motivo: 'template_bloccato', sidTradotto: sid, errore: 'MARKETING' } : { ok: true, sidTradotto: sid });
    expect((await scegli(supa().s, { templateSids: ['HX_A', 'HX_B'] })).from).toBe(P);
  });

  // Review Focus 4
  it('conteggio fallito su un numero: scartato quello, l altro resta', async () => {
    tetti({ [ELIXIR]: 150, [N8061]: 150 });
    vi.mocked(chatNateOggi).mockImplementation(async (_s, n) => (n === ELIXIR ? null : 3));
    expect((await scegli(supa().s)).from).toBe(N8061);
  });

  it('tetti illeggibili: 3199 e un warn', async () => {
    vi.mocked(getTettiNumeri).mockResolvedValue(null);
    const { s, eventi } = supa();
    const r = await scegli(s);
    expect(r).toMatchObject({ from: P, motivo: 'tetti_illeggibili' });
    expect(eventi[0]).toMatchObject({ type: 'mittente_ripiego', level: 'warn' });
  });

  it('nessun secondario configurato: 3199 senza query', async () => {
    process.env.BOT_NUMERI_SECONDARI = '';
    tetti({});
    const r = await scegli(supa().s);
    expect(r).toMatchObject({ from: P, motivo: 'nessun_secondario' });
    expect(getTettiNumeri).not.toHaveBeenCalled();
  });

  it('ignoraTetti: sceglie anche un numero pieno o a tetto zero, ma non uno con template mancante', async () => {
    tetti({ [ELIXIR]: 0 });
    vi.mocked(spedibileDa).mockImplementation(async (sid, n) =>
      n === N0047 ? { ok: false, motivo: 'template_bloccato', sidTradotto: sid, errore: 'x' } : { ok: true, sidTradotto: sid });
    const r = await scegli(supa().s, { ignoraTetti: true });
    expect([ELIXIR, N8061]).toContain(r.from);
  });

  it('senza template da verificare: 3199 (non si apre un numero alla cieca)', async () => {
    tetti({ [ELIXIR]: 150 });
    expect((await scegli(supa().s, { templateSids: [] })).from).toBe(P);
  });
});

describe('sidAperturaMario', () => {
  afterEach(() => { for (const k of Object.keys(process.env)) if (k.startsWith('OPENING_SID_')) delete process.env[k]; delete process.env.NEW_OPENING_ENABLED; });
  it('con le aperture A/B accese: tutti gli OPENING_SID_* presenti', () => {
    process.env.NEW_OPENING_ENABLED = '1';
    process.env.OPENING_SID_C1 = 'HX1'; process.env.OPENING_SID_T2 = 'HX2';
    expect(sidAperturaMario().sort()).toEqual(['HX1', 'HX2']);
  });
  it('spente: il template legacy', () => {
    process.env.FENICE_OPENING_TEMPLATE_SID = 'HX_LEG';
    expect(sidAperturaMario()).toEqual(['HX_LEG']);
  });
});
```

- [ ] **Step 2:** `bun test lib/scelta-mittente.test.ts` → FAIL (modulo mancante).

- [ ] **Step 3: implementazione** — `lib/scelta-mittente.ts`:

```ts
/**
 * Da quale numero nasce una chat NUOVA del bot. Unico punto di decisione dal
 * 26/09/2026 (spec 2026-09-26-parco-numeri-design.md): prima lo sceglieva il CRM
 * fra "bot 1" e "bot 2", e il tetto stava in due repo.
 *
 * Regola: fra i secondari con tetto > 0 (app_settings.tetti_numeri), che oggi non
 * l'hanno ancora raggiunto e da cui TUTTI i template richiesti sono spedibili, si
 * prende quello con meno chat nate oggi. Nessuno = il numero storico.
 *
 * Fallisce chiuso: tetti illeggibili, conteggio in errore, template che non esiste
 * sull'account del numero o che il presidio blocca — ogni dubbio toglie il numero
 * dai candidati. Il costo di sbagliare verso il 3199 e' un'apertura dal numero di
 * sempre; nell'altra direzione e' un lead muto o un numero bruciato.
 *
 * Il conteggio e l'INSERT della chat non sono atomici: due intake concorrenti
 * possono sforare il tetto di qualche unita'. Accettato: il tetto protegge la
 * qualita' del numero, non un contratto.
 */
import type { getSupabaseAdmin } from './supabase/admin';
import { numeroPrimario, numeriSecondari } from './mittente';
import { getTettiNumeri, tettoDi } from './tetti-numeri';
import { chatNateOggi } from './bot2-tetto';
import { spedibileDa } from './lancio-mittente';

type Supa = ReturnType<typeof getSupabaseAdmin>;

export type Scarto = {
  numero: string;
  motivo: 'tetto_zero' | 'tetto_raggiunto' | 'conteggio_fallito' | 'template_non_tradotto' | 'template_bloccato';
  oggi?: number;
  tetto?: number;
  errore?: string | null;
};

export type SceltaMittente = {
  from: string;
  secondario: boolean;
  scartati: Scarto[];
  motivo: 'scelto' | 'nessun_candidato' | 'tetti_illeggibili' | 'nessun_secondario';
};

async function log(supabase: Supa, type: string, level: 'info' | 'warn', payload: Record<string, unknown>, message: string) {
  await supabase.from('event_log').insert({ type, level, payload: payload as never, message }).then(() => undefined, () => undefined);
}

/** I template d'apertura che una chat di Mario puo' ricevere: devono esserci TUTTI sul numero scelto. */
export function sidAperturaMario(): string[] {
  if (process.env.NEW_OPENING_ENABLED === '1') {
    return Object.entries(process.env)
      .filter(([k, v]) => k.startsWith('OPENING_SID_') && Boolean(v))
      .map(([, v]) => String(v));
  }
  const legacy = process.env.FENICE_OPENING_TEMPLATE_SID;
  return legacy ? [legacy] : [];
}

export async function scegliMittenteNuovo(
  supabase: Supa,
  i: { templateSids: string[]; chiave: string; crmLeadId?: string | null; ignoraTetti?: boolean; adesso?: Date },
): Promise<SceltaMittente> {
  const primario = numeroPrimario();
  if (!primario) throw new Error('TWILIO_WHATSAPP_NUMBER_FENICE non configurato');
  const base = { chiave: i.chiave, crmLeadId: i.crmLeadId ?? null };
  const alPrimario = (motivo: SceltaMittente['motivo'], scartati: Scarto[] = []): SceltaMittente =>
    ({ from: primario, secondario: false, scartati, motivo });

  const secondari = numeriSecondari();
  if (secondari.length === 0) return alPrimario('nessun_secondario');
  if (i.templateSids.length === 0) return alPrimario('nessun_candidato');

  const tetti = i.ignoraTetti ? null : await getTettiNumeri(supabase);
  if (!i.ignoraTetti && tetti === null) {
    await log(supabase, 'mittente_ripiego', 'warn', { ...base, motivo: 'tetti_illeggibili' },
      `[numeri] tetti illeggibili: ${i.chiave} nasce sul numero storico`);
    return alPrimario('tetti_illeggibili');
  }

  const scartati: Scarto[] = [];
  const candidati: { numero: string; oggi: number }[] = [];
  for (const numero of secondari) {
    let oggi = 0;
    if (!i.ignoraTetti) {
      const tetto = tettoDi(tetti!, numero);
      if (tetto <= 0) { scartati.push({ numero, motivo: 'tetto_zero' }); continue; }
      const n = await chatNateOggi(supabase, numero, i.adesso);
      if (n === null) {
        scartati.push({ numero, motivo: 'conteggio_fallito' });
        await log(supabase, 'mittente_ripiego', 'warn', { ...base, numero, motivo: 'conteggio_fallito' },
          `[numeri] conteggio di oggi per ${numero} fallito: escluso`);
        continue;
      }
      if (n >= tetto) {
        scartati.push({ numero, motivo: 'tetto_raggiunto', oggi: n, tetto });
        await log(supabase, 'mittente_tetto', 'info', { ...base, numero, oggi: n, tetto },
          `[numeri] ${numero} ha raggiunto il tetto (${n}/${tetto})`);
        continue;
      }
      oggi = n;
    }
    let bloccato: Scarto | null = null;
    for (const sid of i.templateSids) {
      const sped = await spedibileDa(sid, numero);
      if (!sped.ok) { bloccato = { numero, motivo: sped.motivo, errore: sped.errore }; break; }
    }
    if (bloccato) {
      scartati.push(bloccato);
      await log(supabase, 'mittente_ripiego', 'warn', { ...base, ...bloccato },
        `[numeri] ${numero} escluso: ${bloccato.motivo} (${bloccato.errore ?? 'senza dettaglio'})`);
      continue;
    }
    candidati.push({ numero, oggi });
  }

  if (candidati.length === 0) return alPrimario('nessun_candidato', scartati);
  // Meno chat oggi vince; a parita' resta l'ordine della lista (sort stabile).
  candidati.sort((a, b) => a.oggi - b.oggi);
  return { from: candidati[0].numero, secondario: true, scartati, motivo: 'scelto' };
}
```

Nota: `mittente_tetto` si scrive a ogni scelta con un numero pieno. Se in collaudo risulta rumoroso (centinaia di righe/giorno), ridurlo a una riga per numero al giorno è un task a parte: non farlo qui senza misurare.

- [ ] **Step 4:** `bun test lib/scelta-mittente.test.ts` → PASS.

- [ ] **Step 5: commit** — `git add lib/scelta-mittente.ts lib/scelta-mittente.test.ts && git commit -m "feat(numeri): scegliMittenteNuovo, un solo punto di decisione"`

---

### Task 6: Iscrizione Mario e lancio passano dalla scelta unica

**Files:**
- Modify: `lib/fenice-enroll.ts:107-133` (ramo Mario) e `:483-527` (ramo lancio)
- Modify: `lib/lancio-mittente.ts` (`mittenteBenvenutoLancio`)
- Test: `lib/fenice-enroll.test.ts`, `lib/lancio-mittente.test.ts`

**Interfaces:**
- Consumes: `scegliMittenteNuovo`, `sidAperturaMario` (Task 5).
- Produces: `mittenteBenvenutoLancio(supabase, { settings, chiave, templateSid, primario, crmLeadId? })` — il parametro `secondo` sparisce; `EsitoMittenteLancio` resta `{ from, secondario, scelta, ripiego }` con `MotivoRipiego = 'nessun_candidato' | 'tetti_illeggibili' | 'nessun_secondario'`.

- [ ] **Step 1: test che falliscono** — in `lib/fenice-enroll.test.ts` aggiungere in testa:

```ts
vi.mock('./scelta-mittente', () => ({
  scegliMittenteNuovo: vi.fn(async () => ({ from: 'whatsapp:+393520413199', secondario: false, scartati: [], motivo: 'nessun_secondario' })),
  sidAperturaMario: vi.fn(() => ['HX_OPEN']),
}));
import { scegliMittenteNuovo } from './scelta-mittente';
```
e i casi:

```ts
describe('mittente di una chat nuova (parco numeri)', () => {
  it('Mario: il numero scelto finisce nella nascita della chat', async () => {
    vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: 'whatsapp:+393522018718', secondario: true, scartati: [], motivo: 'scelto' });
    await enrollLeadIntoMario(makeSupabase().supabase as never, { phone: '+393331234567', firstName: 'Anna' });
    expect(vi.mocked(findOrCreateLeadConversation).mock.calls[0][2]).toEqual({ mittente: 'whatsapp:+393522018718' });
    expect(vi.mocked(scegliMittenteNuovo).mock.calls[0][1]).toMatchObject({ templateSids: ['HX_OPEN'], chiave: '+393331234567' });
  });

  // Review Focus 3: CRM vecchio.
  it('numeroBot 2 e riscaldamento non forzano piu nessun numero', async () => {
    await enrollLeadIntoMario(makeSupabase().supabase as never, { phone: '+393331234567', numeroBot: 2, riscaldamento: true });
    expect(vi.mocked(findOrCreateLeadConversation).mock.calls[0][2]).toEqual({ mittente: 'whatsapp:+393520413199' });
    expect(vi.mocked(scegliMittenteNuovo)).toHaveBeenCalledTimes(1);
  });
});
```
(`makeSupabase` e gli argomenti minimi di `enrollLeadIntoMario`: usare l'helper e la forma già usati nel file; se l'helper ha un altro nome, adattare solo il nome.) Rimuovere/riscrivere i test del file che si aspettano `bot2_tetto` o il secondo numero forzato da `numeroBot: 2`.

In `lib/lancio-mittente.test.ts`: sostituire i mock di `./twilio`/`./template-account` per i test di `mittenteBenvenutoLancio` con

```ts
vi.mock('./scelta-mittente', () => ({ scegliMittenteNuovo: vi.fn() }));
```
e riscrivere i casi di `mittenteBenvenutoLancio` così (i test di `posizioneQuota`, `toccaAlSecondario`, `spedibileDa` restano):

```ts
const PRIMARIO = 'whatsapp:+393520413199';
const ELIXIR = 'whatsapp:+393522018718';
const scegli = (settings: any, chiave = IN_QUOTA) =>
  mittenteBenvenutoLancio({} as any, { settings, chiave, templateSid: WELCOME, primario: PRIMARIO });

it('principale e fuori quota: primario, senza chiedere niente a nessuno', async () => {
  const r = await scegli(impostazioni(0, 'principale'));
  expect(r).toEqual({ from: PRIMARIO, secondario: false, scelta: 'principale', ripiego: null });
  expect(scegliMittenteNuovo).not.toHaveBeenCalled();
});
it('in quota: chiede la scelta rispettando i tetti', async () => {
  vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: ELIXIR, secondario: true, scartati: [], motivo: 'scelto' });
  const r = await scegli(impostazioni(9));
  expect(r).toMatchObject({ from: ELIXIR, secondario: true, scelta: 'quota', ripiego: null });
  expect(vi.mocked(scegliMittenteNuovo).mock.calls[0][1]).toMatchObject({ templateSids: [WELCOME], ignoraTetti: false });
});
it('sender secondario: ignora i tetti', async () => {
  vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: ELIXIR, secondario: true, scartati: [], motivo: 'scelto' });
  await scegli(impostazioni(0, 'secondario'), FUORI_QUOTA);
  expect(vi.mocked(scegliMittenteNuovo).mock.calls[0][1]).toMatchObject({ ignoraTetti: true });
});
it('nessun candidato: primario con il motivo', async () => {
  vi.mocked(scegliMittenteNuovo).mockResolvedValueOnce({ from: PRIMARIO, secondario: false, scartati: [], motivo: 'nessun_candidato' });
  expect(await scegli(impostazioni(9))).toMatchObject({ from: PRIMARIO, secondario: false, ripiego: 'nessun_candidato' });
});
```

- [ ] **Step 2:** `bun test lib/fenice-enroll.test.ts lib/lancio-mittente.test.ts` → FAIL.

- [ ] **Step 3: implementazione, ramo Mario** — in `lib/fenice-enroll.ts` sostituire da `const secondo = numeroSecondo();` fino alla chiusura dell'`if (vuoleSecondo) {…}` (righe ~117-133) con:

```ts
  // Da quale numero nasce la chat lo decide il bot, e solo il bot (26/09/2026):
  // `numeroBot` e `riscaldamento` del CRM non forzano piu' niente. Vedi
  // lib/scelta-mittente.ts. Su una chat che esiste gia' la scelta non ha effetto:
  // `findOrCreateLeadConversation` tiene il suo numero.
  const scelta = await scegliMittenteNuovo(supabase, {
    templateSids: sidAperturaMario(),
    chiave: args.phone,
    crmLeadId: args.crmLeadId ?? null,
  });
  const mittenteImposto: string | undefined = scelta.from;
```
e aggiornare il commento sopra (via i paragrafi sul riscaldamento/numero nuovo).

- [ ] **Step 4: implementazione, ramo lancio** — sostituire nello stesso modo il blocco `const secondo = numeroSecondo(); … if (vuoleSecondo) {…} else {…}` con:

```ts
  const settings = await getLancioSettings(supabase);
  // Nessuna richiesta del CRM conta piu' (26/09/2026): decide il lancio
  // (`lancio_sender`, `lancio_quota_secondario`) e sotto la scelta unica dei numeri.
  const sceltaLancio = await mittenteBenvenutoLancio(supabase, {
    settings,
    chiave: args.phone,
    templateSid,
    primario,
    crmLeadId: args.crmLeadId ?? null,
  });
  const mittenteImposto: string | undefined = sceltaLancio.from;
```
Rimuovere dagli import `numeroSecondo` e `puoAprireSuBot2` se non più usati; aggiungere `import { scegliMittenteNuovo, sidAperturaMario } from './scelta-mittente';`.

- [ ] **Step 5: implementazione, `mittenteBenvenutoLancio`** — in `lib/lancio-mittente.ts` sostituire tipo `MotivoRipiego`, il parametro `secondo` e il corpo da `const secondo = …` in giù con:

```ts
export type MotivoRipiego = 'nessun_candidato' | 'tetti_illeggibili' | 'nessun_secondario';

export async function mittenteBenvenutoLancio(
  supabase: Supa,
  i: {
    settings: Pick<LancioSettings, 'sender' | 'quotaSecondario'>;
    chiave: string;
    templateSid: string;
    primario: string;
    crmLeadId?: string | null;
  },
): Promise<EsitoMittenteLancio> {
  const perSender = i.settings.sender === 'secondario';
  const perQuota = !perSender && toccaAlSecondario(i.chiave, i.settings.quotaSecondario);
  if (!perSender && !perQuota) {
    return { from: i.primario, secondario: false, scelta: 'principale', ripiego: null };
  }
  const scelta: 'quota' | 'sender' = perSender ? 'sender' : 'quota';
  // La scelta del numero e' quella di tutto il bot (lib/scelta-mittente.ts): verifica
  // che il benvenuto sia spedibile, e logga lei i numeri scartati. `sender` e' una
  // decisione umana dal pannello e scavalca i tetti; la quota automatica li rispetta.
  const r = await scegliMittenteNuovo(supabase, {
    templateSids: [i.templateSid],
    chiave: i.chiave,
    crmLeadId: i.crmLeadId ?? null,
    ignoraTetti: perSender,
  });
  if (!r.secondario) {
    return { from: i.primario, secondario: false, scelta, ripiego: r.motivo as MotivoRipiego };
  }
  return { from: r.from, secondario: true, scelta, ripiego: null };
}
```
con `import { scegliMittenteNuovo } from './scelta-mittente';` e rimozione degli import `numeroSecondo`, `puoAprireSuBot2` se inutilizzati. `logRipiego` resta esportata se ha altri usi (`git grep logRipiego`), altrimenti si toglie. Aggiornare il commento di testa del file (regola: "un secondario scelto da `scegliMittenteNuovo`", non più "il numero nuovo").

Attenzione al ciclo d'import: `scelta-mittente` importa `spedibileDa` da `lancio-mittente`, e `lancio-mittente` importa `scegliMittenteNuovo`. Se Vitest o il build segnalano il ciclo, spostare `spedibileDa` (e il tipo `EsitoSpedibilita`) in un file nuovo `lib/spedibilita.ts`, re-esportandolo da `lancio-mittente.ts` per i chiamanti esistenti, e far importare `scelta-mittente` da lì.

- [ ] **Step 6:** `bun test lib/fenice-enroll.test.ts lib/lancio-mittente.test.ts lib/scelta-mittente.test.ts` → PASS; `bun run typecheck` → pulito.

- [ ] **Step 7: commit** — `git commit -am "feat(numeri): Mario e lancio nascono dalla scelta unica; numeroBot del CRM non forza piu'"`

---

### Task 7: Pulizia, documenti, verifica completa

**Files:**
- Modify: `lib/bot2-tetto.ts` (togliere `puoAprireSuBot2`/`tettoBot2`/`TETTO_BOT2_DEFAULT` se `git grep` non trova usi fuori dai test; togliere i relativi test), `lib/mittente.ts` (togliere `numeroSecondo` solo se inutilizzato — è ancora il ripiego di `numeriSecondari`, quindi di solito **resta**)
- Modify: `app/(fenice)/fenice/impostazioni/_components/ImpostazioniLancioPanel.tsx:65` (testo del hint: "quota verso i numeri secondari" invece di "il numero nuovo")
- Modify: `app/api/admin/secondo-numero/route.ts` solo se non compila più
- Create: `docs/numeri-bot.md` — tabella numeri/account/WABA, env (`BOT_NUMERI_SECONDARI`, `TWILIO_*_3`), chiave `tetti_numeri` con l'`update` SQL d'esempio, sequenza di accensione (copiata dalla spec §5)

- [ ] **Step 1:** `git grep -n "puoAprireSuBot2\|tettoBot2\|numeroSecondo\|quotaSecondo" -- lib app` e togliere ciò che resta senza usi.
- [ ] **Step 2:** aggiornare il testo del pannello e scrivere `docs/numeri-bot.md`.
- [ ] **Step 3:** `bun run typecheck` → 0 errori.
- [ ] **Step 4:** `bun test` → tutto verde (riportare il conteggio).
- [ ] **Step 5:** `bun run build` → completato.
- [ ] **Step 6: commit** — `git commit -am "chore(numeri): pulizia bot2, doc dei numeri del bot"`
- [ ] **Step 7: STOP.** Non si pusha: il push su `main` è il deploy e lo autorizza il PO. Riportare: branch, commit, esiti di typecheck/test/build, e l'elenco delle azioni di produzione della spec §5 (env Vercel, `app_settings`, env CRM, webhook elixir, test sul telefono), ognuna da confermare.
