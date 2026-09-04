# Il bot risponde a chi scrive per primi — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il bot prende in carico e risponde a chiunque scriva per primo sul numero Fenice, e i 29 lead rimasti in silenzio vengono ripresi con il template di riaggancio.

**Architecture:** L'adozione vive nel webhook Twilio: quando arriva un inbound su una conversazione che non è di nessuno e su cui non è mai partito niente, si scrivono `ai_owner='mario'` e `ai_status='active'` e il flusso di risposta esistente (`shouldAutoReply` → `drainMarioReplies`) prosegue da solo, senza template — il lead ha aperto lui la finestra 24h. Tre contorni: la dichiarazione IA sulla prima risposta libera (oggi vive solo nei template di apertura), una guardia perché l'intake del CRM non lasci cadere un'apertura sopra una chat già avviata, e un endpoint da cui il CRM legge i lead che non ha mai visto, così l'esito ha un `leadId` a cui tornare.

**Tech Stack:** Next.js (App Router, route handlers `runtime = 'nodejs'`), TypeScript, Supabase (client admin service-role), Twilio Content API, vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-lead-che-scrivono-per-primi-design.md`
**Documento per il CRM:** `docs/crm/2026-09-04-lead-che-scrivono-per-primi.md`

## Global Constraints

- **Tutto in italiano**: nomi di funzione, commenti, messaggi di log, testi dei test. È la convenzione di questo repo.
- **Interruttore `INBOUND_ADOPTION_ENABLED`**: l'adozione va in produzione **spenta**. È attiva solo con il valore esatto `'1'`.
- **Numero Fenice**: `TWILIO_WHATSAPP_NUMBER_FENICE` (`whatsapp:+393520413199`). Niente adozione su altri mittenti.
- **Due criteri di "outbound", opposti e voluti** (spec, Fase 1):
  - *adozione* → **qualunque** riga in uscita, anche senza `twilio_sid`, blocca;
  - *guardia sull'apertura* → blocca solo un outbound **con `twilio_sid`**, cioè partito davvero. Usare lo stesso criterio in tutti e due i punti romperebbe `app/api/cron/riapri-mute/route.ts`.
- **Comandi**: `bun run test` (vitest), `bun run typecheck`, `bun run lint`. Un task non è finito finché i tre non sono verdi.
- **Migration**: nessuna. Tutte le colonne usate esistono già (`ai_owner`, `ai_status`, `ai_started_at`, `crm_funnel`, `crm_lead_id`, `handed_off_at`, `ai_paused_at`, `wa_number`).
- **Commit**: uno per task, messaggio in italiano, con il trailer del repo:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0155zuH5FHstnTnCJnprbmR9
  ```

---

### Task 1: Le due funzioni pure dell'adozione

**Files:**
- Modify: `lib/persona.ts` (in coda a `normalizeFunnel`, ~riga 20)
- Modify: `lib/fenice-autoreply.ts` (subito dopo `shouldReopen`, ~riga 72)
- Test: `lib/persona.test.ts`, `lib/fenice-autoreply.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces:
  - `funnelDaPrimoMessaggio(body: string | null | undefined): 'TELEGRAM' | 'INBOUND'` da `lib/persona.ts`
  - `shouldAdoptInbound(g: AdoptGate): boolean` e `type AdoptGate` da `lib/fenice-autoreply.ts`

- [ ] **Step 1: Scrivi i test che falliscono per `funnelDaPrimoMessaggio`**

In `lib/persona.test.ts`, aggiungi in coda al file (e aggiungi `funnelDaPrimoMessaggio` all'import da `./persona`):

```ts
describe('funnelDaPrimoMessaggio', () => {
  const linkTelegram =
    'Buongiorno, sono nel canale Telegram e mi hanno indicato questo contatto per più informazioni su Fenice Academy';

  it('riconosce il messaggio precompilato del canale', () => {
    expect(funnelDaPrimoMessaggio(linkTelegram)).toBe('TELEGRAM');
  });
  it('riconosce anche la variante col refuso "qusto"', () => {
    expect(funnelDaPrimoMessaggio(linkTelegram.replace('questo', 'qusto'))).toBe('TELEGRAM');
  });
  it('riconosce il precompilato con una riga aggiunta dal lead', () => {
    expect(funnelDaPrimoMessaggio(`${linkTelegram}.Sono a metà percorso di studi per diventare Copy`)).toBe('TELEGRAM');
  });
  // Nomina Telegram ma non viene dal link: sulle statistiche di funnel non deve
  // finire su TELEGRAM, o il confronto fra canali diventa falso.
  it('chi nomina Telegram per altro non è TELEGRAM', () => {
    expect(funnelDaPrimoMessaggio('Vorrei entrare nel canale telegram')).toBe('INBOUND');
    expect(funnelDaPrimoMessaggio('Per caso avete un recapito che non sia un canale Telegram/WhatsApp?')).toBe('INBOUND');
  });
  it('vuoto o nullo è INBOUND', () => {
    expect(funnelDaPrimoMessaggio(null)).toBe('INBOUND');
    expect(funnelDaPrimoMessaggio('')).toBe('INBOUND');
  });
  it("il risultato è mangiabile da normalizeFunnel", () => {
    expect(normalizeFunnel(funnelDaPrimoMessaggio(linkTelegram))).toBe('telegram');
    expect(normalizeFunnel(funnelDaPrimoMessaggio('ciao'))).toBe('other');
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `bun run test -- lib/persona.test.ts`
Expected: FAIL — `funnelDaPrimoMessaggio is not a function`

- [ ] **Step 3: Implementa `funnelDaPrimoMessaggio`**

In `lib/persona.ts`, subito dopo `normalizeFunnel`:

```ts
/** Provenienza di chi ci scrive per primo, senza passare dal CRM. */
export type ProvenienzaInbound = 'TELEGRAM' | 'INBOUND';

/**
 * Il link del canale Telegram consegna al lead un messaggio GIÀ SCRITTO: fra il 26/08 e
 * il 04/09 è arrivato 47 volte su 51 identico parola per parola. Riconoscerlo è l'unico
 * modo onesto di attribuire il funnel a chi non è mai passato da un form.
 *
 * Il match è sulla frase precompilata, NON sulle parole "canale telegram": chi chiede
 * come entrare nel canale, o chi si lamenta che non c'è un recapito telefonico, nomina
 * Telegram senza venire da lì. Metterlo su TELEGRAM falserebbe il confronto fra canali.
 */
const LINK_TELEGRAM = /sono nel canale telegram e mi hanno indicato/i;

export function funnelDaPrimoMessaggio(body: string | null | undefined): ProvenienzaInbound {
  return LINK_TELEGRAM.test(body ?? '') ? 'TELEGRAM' : 'INBOUND';
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `bun run test -- lib/persona.test.ts`
Expected: PASS

- [ ] **Step 5: Scrivi i test che falliscono per `shouldAdoptInbound`**

In `lib/fenice-autoreply.test.ts`, aggiungi `shouldAdoptInbound` all'import da `./fenice-autoreply` e questo blocco dopo `describe('shouldAutoReply', ...)`:

```ts
describe('shouldAdoptInbound', () => {
  const ok = {
    toMatchesFenice: true,
    adoptionOn: true,
    aiOwner: null,
    aiPausedAt: null,
    handedOffAt: null,
    hasOutbound: false,
  };
  it('vero: il lead ha scritto per primo e la chat non è di nessuno', () => {
    expect(shouldAdoptInbound(ok)).toBe(true);
  });
  it('falso se il numero non è quello di Fenice', () => {
    expect(shouldAdoptInbound({ ...ok, toMatchesFenice: false })).toBe(false);
  });
  it('falso a interruttore spento', () => {
    expect(shouldAdoptInbound({ ...ok, adoptionOn: false })).toBe(false);
  });
  it('falso se la chat è già di qualcuno', () => {
    expect(shouldAdoptInbound({ ...ok, aiOwner: 'mario' })).toBe(false);
  });
  it('falso col fermo manuale o con la chat passata a una persona', () => {
    expect(shouldAdoptInbound({ ...ok, aiPausedAt: '2026-09-04T10:00:00Z' })).toBe(false);
    expect(shouldAdoptInbound({ ...ok, handedOffAt: '2026-09-04T10:00:00Z' })).toBe(false);
  });
  // Il caso che conta di più: una chat di campagna ha ai_owner nullo e un outbound
  // partito. Adottarla vorrebbe dire mettere il bot sopra 2.680 conversazioni.
  it('falso se un messaggio nostro è già partito (campagne, invii a mano)', () => {
    expect(shouldAdoptInbound({ ...ok, hasOutbound: true })).toBe(false);
  });
});
```

- [ ] **Step 6: Esegui i test e verifica che falliscano**

Run: `bun run test -- lib/fenice-autoreply.test.ts`
Expected: FAIL — `shouldAdoptInbound is not a function`

- [ ] **Step 7: Implementa `shouldAdoptInbound`**

In `lib/fenice-autoreply.ts`, subito dopo `shouldReopen`:

```ts
export type AdoptGate = {
  toMatchesFenice: boolean;
  /** INBOUND_ADOPTION_ENABLED === '1' */
  adoptionOn: boolean;
  aiOwner: string | null;
  aiPausedAt?: string | null;
  handedOffAt?: string | null;
  /** Esiste una QUALUNQUE riga in uscita su questa conversazione, anche senza SID. */
  hasOutbound: boolean;
};

/**
 * Pure: il bot prende in carico una conversazione che nessuno possiede?
 *
 * Fino al 04/09/2026 rispondeva solo ai lead arruolati dall'intake del CRM: chi scriveva
 * per primo non aveva padrone e restava zitto. 29 persone su 43 arrivate dal canale
 * Telegram fra il 26/08 e il 04/09 non hanno mai ricevuto una risposta, con un silenzio
 * mediano di 113 ore.
 *
 * `hasOutbound` conta QUALUNQUE riga in uscita, anche di un invio fallito: se qualcuno ha
 * provato a scrivere a questa persona, la chat ha una storia che qui non conosciamo. È
 * anche ciò che tiene fuori le campagne e la inbox, dove il primo messaggio è sempre
 * nostro. È il criterio OPPOSTO a quello della guardia sull'apertura in
 * `enrollLeadIntoMario`, che guarda solo agli outbound partiti davvero: là serve sapere
 * se il lead ha visto qualcosa, qui se qualcuno ha provato.
 */
export function shouldAdoptInbound(g: AdoptGate): boolean {
  if (!g.toMatchesFenice || !g.adoptionOn) return false;
  if (g.aiOwner !== null) return false;
  if (g.aiPausedAt || g.handedOffAt) return false;
  return !g.hasOutbound;
}
```

- [ ] **Step 8: Esegui tutta la suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: tutto verde

- [ ] **Step 9: Commit**

```bash
git add lib/persona.ts lib/persona.test.ts lib/fenice-autoreply.ts lib/fenice-autoreply.test.ts
git commit -m "$(cat <<'EOF'
feat(bot): le due decisioni pure per adottare chi scrive per primo

shouldAdoptInbound: una chat che non e' di nessuno e su cui non e' mai
partito niente si puo' prendere in carico. Qualunque riga in uscita,
anche fallita, e' un no: e' cio' che tiene fuori le campagne.

funnelDaPrimoMessaggio: il link del canale Telegram consegna un
messaggio gia' scritto, e riconoscerlo e' l'unico modo onesto di dare un
funnel a chi non e' mai passato da un form. Match sulla frase, non sulle
parole "canale telegram": chi chiede come entrare nel canale non viene
da li'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0155zuH5FHstnTnCJnprbmR9
EOF
)"
```

---

### Task 2: L'elenco per il CRM (`/api/bot/lead-entranti`)

Il CRM non può ricevere un esito senza `leadId`, e un lead che scrive per primo da loro non esiste. Questo endpoint è la lista da cui lo creano; poi ce lo rimandano dall'intake normale e tutto il resto del flusso funziona già.

**Files:**
- Create: `app/api/bot/lead-entranti/route.ts`
- Test: nessuno automatico (route di sola lettura, stessa forma di `app/api/bot/contatti-umani/route.ts`, che non ha test di route). La verifica è manuale, allo Step 3.

**Interfaces:**
- Consumes: `verifySignature` (`lib/bot-hmac`), `checkRateLimit` (`lib/rate-limit`), `fetchAllRows` (`lib/supabase/paginate`), `getSupabaseAdmin` (`lib/supabase/admin`).
- Produces: `POST /api/bot/lead-entranti` → `{ ok, totale, lead: [...] }`.

- [ ] **Step 1: Scrivi la route**

Crea `app/api/bot/lead-entranti/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { verifySignature } from '@/lib/bot-hmac';
import { checkRateLimit } from '@/lib/rate-limit';
import { fetchAllRows } from '@/lib/supabase/paginate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * I lead che il bot sta lavorando e che il CRM non ha mai visto.
 *
 * Chi ci scrive per primo su WhatsApp non e' passato da nessun form, quindi dal lato CRM
 * non esiste e non ha un `leadId`. Senza quel numero `canSendOutcome` vieta l'invio
 * dell'esito (`lib/fenice-autoreply.ts`): il bot puo' fissare un appuntamento e quello
 * non arriva da nessuna parte. Questo e' l'elenco da cui il CRM crea i lead mancanti;
 * appena ce li rimanda con l'intake, `crm_lead_id` si riempie e il lead esce dalla lista
 * da solo.
 *
 * Stessa autenticazione di `/api/bot/intake` e `/api/bot/contatti-umani`.
 * POST, corpo opzionale: `{ "limit": 500 }`.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const rl = checkRateLimit(`leadentranti:${ip}`, 30, 60_000);
  if (!rl.ok) return new NextResponse('rate limit', { status: 429 });

  const secret = process.env.BOT_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const rawBody = await req.text();
  const check = verifySignature(rawBody, req.headers.get('x-bot-signature'), secret);
  if (!check.valid) return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });

  let opts: { limit?: number } = {};
  if (rawBody.trim() !== '') {
    try { opts = JSON.parse(rawBody) as typeof opts; }
    catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);

  const admin = getSupabaseAdmin();
  let convs: any[];
  try {
    // Il criterio e' esattamente "lo lavoriamo noi e voi non lo conoscete": preso in
    // carico da Mario, senza `crm_lead_id`. Ci finiscono sia gli adottati dal webhook
    // sia i pochi arruolati a mano da /api/fenice/enroll — anche quelli il CRM non li ha.
    convs = await fetchAllRows<any>((from, to) => admin
      .from('conversations')
      .select('id, crm_funnel, ai_status, bot_outcome, bot_scheduled_at, ai_started_at, last_message_at, leads(phone_e164, first_name, last_name)')
      .eq('ai_owner', 'mario')
      .is('crm_lead_id', null)
      .order('ai_started_at', { ascending: true, nullsFirst: true })
      .range(from, to));
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'errore' }, { status: 500 });
  }

  const scelte = convs.slice(0, limit);
  const lead = [];
  for (const c of scelte) {
    // Il primo messaggio del lead: e' con quello che si e' presentato, ed e' il testo da
    // cui abbiamo dedotto la provenienza. Al CRM serve per sapere chi sta creando.
    const { data: primi } = await admin
      .from('messages')
      .select('body, created_at')
      .eq('conversation_id', c.id)
      .eq('direction', 'in')
      .order('created_at', { ascending: true })
      .limit(1);
    const primo = (primi ?? [])[0] as { body: string | null; created_at: string } | undefined;
    const nome = [c.leads?.first_name, c.leads?.last_name].filter(Boolean).join(' ').trim();
    lead.push({
      telefono: (c.leads?.phone_e164 ?? null) as string | null,
      nome: nome || null,
      provenienza: (c.crm_funnel ?? 'INBOUND') as string,
      primoMessaggio: (primo?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null,
      scrittoIl: primo?.created_at ?? null,
      conversationId: c.id as number,
      statoBot: (c.ai_status ?? null) as string | null,
      // Valorizzati quando il bot ha gia' concluso prima che loro creassero il lead:
      // cosi' al momento della creazione sanno che quella persona ha gia' una call in
      // agenda, invece di scoprirlo al giro dopo.
      esito: (c.bot_outcome ?? null) as string | null,
      appuntamento: (c.bot_scheduled_at ?? null) as string | null,
    });
  }

  return NextResponse.json({ ok: true, totale: lead.length, lead });
}
```

- [ ] **Step 2: Verifica tipi e lint**

Run: `bun run typecheck && bun run lint`
Expected: verde

- [ ] **Step 3: Prova la route in locale**

Avvia `bun run dev` in un terminale, poi in un altro:

```bash
BODY='{"limit":50}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$BOT_WEBHOOK_SECRET" -r | cut -d' ' -f1)"
curl -s -X POST http://localhost:3000/api/bot/lead-entranti \
  -H 'content-type: application/json' -H "x-bot-signature: $SIG" -d "$BODY" | head -c 800
```

Expected: `{"ok":true,"totale":...}`. Prima che il Task 6 giri il numero sarà basso (solo gli arruolati a mano senza `crmLeadId`): va bene, quello che si verifica qui è che la firma passi e la forma sia giusta. Con una firma sbagliata deve rispondere `401 invalid_signature`.

- [ ] **Step 4: Commit**

```bash
git add app/api/bot/lead-entranti/route.ts
git commit -m "$(cat <<'EOF'
feat(crm): l'elenco dei lead che il CRM non ha mai visto

Chi scrive per primo non e' passato da nessun form, quindi da loro non
esiste e non ha un leadId: senza quello l'esito del bot non ha dove
tornare. Da qui il CRM crea i lead mancanti e ce li rimanda con
l'intake normale; il lead esce dalla lista da solo quando crm_lead_id
si riempie.

Stessa firma HMAC di intake e contatti-umani, il client ce l'hanno gia'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0155zuH5FHstnTnCJnprbmR9
EOF
)"
```

---

### Task 3: L'adozione nel webhook

**Files:**
- Modify: `app/api/webhooks/twilio/route.ts:176-226` (dentro il ramo `if (toMatchesFenice)`)
- Modify: `.env.example` (aggiungi `INBOUND_ADOPTION_ENABLED`)

**Interfaces:**
- Consumes: `shouldAdoptInbound` (Task 1), `funnelDaPrimoMessaggio` (Task 1).
- Produces: conversazioni con `ai_owner='mario'`, `ai_status='active'`, `crm_funnel` valorizzato, e un `event_log` di tipo `inbound_adottato`.

- [ ] **Step 1: Aggiorna gli import**

In testa a `app/api/webhooks/twilio/route.ts`, aggiungi `shouldAdoptInbound` all'import esistente da `@/lib/fenice-autoreply` e aggiungi:

```ts
import { funnelDaPrimoMessaggio } from '@/lib/persona';
```

- [ ] **Step 2: Aggiungi `handed_off_at` alla select della conversazione**

Sostituisci la select esistente (riga ~182):

```ts
        .select('ai_owner, ai_status, ai_paused_at, crm_lead_id, bot_outcome')
```

con:

```ts
        .select('ai_owner, ai_status, ai_paused_at, handed_off_at, crm_lead_id, bot_outcome')
```

- [ ] **Step 3: Inserisci il blocco di adozione**

Subito **dopo** la select della conversazione e **prima** del blocco `segnalaRispostaDopoTerzoNr`, inserisci:

```ts
      // Adozione: il lead ha scritto per primo e questa chat non e' di nessuno.
      //
      // Il conteggio degli outbound si fa SOLO quando `ai_owner` e' nullo: sulle chat
      // gia' arruolate (la stragrande maggioranza degli inbound) non si aggiunge nessuna
      // query al webhook, che deve restare veloce perche' Twilio ritenta.
      if (conv && conv.ai_owner === null) {
        const { count } = await supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversationId)
          .eq('direction', 'out');
        if (shouldAdoptInbound({
          toMatchesFenice,
          adoptionOn: process.env.INBOUND_ADOPTION_ENABLED === '1',
          aiOwner: conv.ai_owner,
          aiPausedAt: conv.ai_paused_at,
          handedOffAt: conv.handed_off_at,
          hasOutbound: (count ?? 0) > 0,
        })) {
          const provenienza = funnelDaPrimoMessaggio(messageBody);
          await supabase.from('conversations').update({
            ai_owner: 'mario',
            ai_status: 'active',
            ai_started_at: now,
            crm_funnel: provenienza,
          }).eq('id', conversationId);
          // La copia in memoria serve subito dopo: e' quella che `shouldAutoReply` legge.
          conv.ai_owner = 'mario';
          conv.ai_status = 'active';
          await supabase.from('event_log').insert({
            type: 'inbound_adottato',
            payload: { conversationId, phone, provenienza } as never,
            message: `[bot-fissatore] adottato ${phone}: ha scritto per primo (${provenienza})`,
            level: 'info',
          });
        }
      }
```

Nota: `messageBody`, `now`, `phone` e `conversationId` sono già definiti più in alto nella funzione (righe ~125, ~158, ~76). Non ridichiararli.

**Nessun template**: dopo questo blocco `shouldAutoReply` trova `ai_owner='mario'` e `ai_status='active'` e `drainMarioReplies` risponde a testo libero. Il lead ha appena aperto lui la finestra 24h.

- [ ] **Step 4: Documenta l'interruttore**

In `.env.example`, sotto le altre variabili del bot:

```
# Il bot prende in carico chi scrive per primo sul numero Fenice, senza passare dal CRM.
# '1' per accendere. Va acceso solo dopo l'ok del CRM su /api/bot/lead-entranti.
INBOUND_ADOPTION_ENABLED=0
```

- [ ] **Step 5: Verifica che nulla si sia rotto**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: tutto verde. Nessun test esistente deve cambiare: a interruttore spento il comportamento è identico a prima.

- [ ] **Step 6: Commit**

```bash
git add app/api/webhooks/twilio/route.ts .env.example
git commit -m "$(cat <<'EOF'
feat(bot): il bot prende in carico chi scrive per primo

Dietro INBOUND_ADOPTION_ENABLED, spento. Quando arriva un inbound sul
numero Fenice su una chat che non e' di nessuno e su cui non e' mai
partito niente, si scrivono ai_owner e ai_status e il flusso di risposta
esistente prosegue da solo: nessun template, il lead ha aperto lui la
finestra 24h.

Il conteggio degli outbound gira solo quando ai_owner e' nullo: sugli
inbound normali il webhook non prende nessuna query in piu'.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0155zuH5FHstnTnCJnprbmR9
EOF
)"
```

---

### Task 4: La dichiarazione IA sulla prima risposta

L'AI Act art. 50 è in vigore dal 2 agosto. Oggi "sono Marta, l'assistente digitale di Fenice Academy" vive **solo** dentro i template di apertura (`lib/persona.ts`). Un lead adottato non riceve nessuna apertura: senza questo task non se lo sentirebbe mai dire.

**Files:**
- Create: `lib/primo-contatto-note.ts`
- Create: `lib/primo-contatto-note.test.ts`
- Modify: `lib/fenice-autoreply.ts` (la chiamata a `generateMarioReply`, ~riga 443)

**Interfaces:**
- Consumes: niente.
- Produces: `notaPrimoContatto(rows: readonly { direction: string }[]): string | undefined` e `NOTA_PRIMO_CONTATTO` da `lib/primo-contatto-note.ts`.

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `lib/primo-contatto-note.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { notaPrimoContatto, NOTA_PRIMO_CONTATTO } from './primo-contatto-note';

describe('notaPrimoContatto', () => {
  it('c\'è quando il lead ha scritto e noi non ancora', () => {
    expect(notaPrimoContatto([{ direction: 'in' }])).toBe(NOTA_PRIMO_CONTATTO);
  });
  it('non c\'è appena abbiamo risposto una volta', () => {
    expect(notaPrimoContatto([{ direction: 'in' }, { direction: 'out' }, { direction: 'in' }]))
      .toBeUndefined();
  });
  it('non c\'è su una chat aperta da un nostro template', () => {
    expect(notaPrimoContatto([{ direction: 'out' }, { direction: 'in' }])).toBeUndefined();
  });
  it('la nota dice di presentarsi come assistente digitale', () => {
    expect(NOTA_PRIMO_CONTATTO).toContain('assistente digitale di Fenice Academy');
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `bun run test -- lib/primo-contatto-note.test.ts`
Expected: FAIL — modulo non trovato

- [ ] **Step 3: Implementa il modulo**

Crea `lib/primo-contatto-note.ts`:

```ts
/**
 * La dichiarazione IA per chi ci scrive per primo.
 *
 * Le aperture dichiarate dicono "sono Marta, l'assistente digitale di Fenice Academy",
 * ma vivono dentro i TEMPLATE (`lib/persona.ts`): un lead adottato dal webhook non ne
 * riceve nessuno, quindi senza questa nota non se lo sentirebbe mai dire. L'AI Act
 * art. 50 e' in vigore dal 02/08/2026 e chiede la dichiarazione al primo contatto.
 *
 * E' una nota appesa al system prompt, non un messaggio fisso: il modello la integra nel
 * saluto invece di sparare un annuncio addosso a chi ha appena fatto una domanda. Stessa
 * meccanica di `gdoContextNote`.
 */
export const NOTA_PRIMO_CONTATTO =
  'PRIMO CONTATTO: questa persona ha scritto lei per prima e non ha mai ricevuto un ' +
  'nostro messaggio, quindi non sa con chi sta parlando. Nel PRIMO messaggio che le mandi ' +
  "presentati come l'assistente digitale di Fenice Academy, con parole tue e senza farne " +
  'un annuncio: mezza riga dentro il saluto, poi rispondi subito a quello che ha chiesto. ' +
  'Nei messaggi successivi non ripeterlo.';

/** La nota, se sulla conversazione non e' mai uscito niente da parte nostra. */
export function notaPrimoContatto(rows: readonly { direction: string }[]): string | undefined {
  return rows.some((r) => r.direction === 'out') ? undefined : NOTA_PRIMO_CONTATTO;
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `bun run test -- lib/primo-contatto-note.test.ts`
Expected: PASS

- [ ] **Step 5: Aggancia la nota al drain**

In `lib/fenice-autoreply.ts`, aggiungi l'import:

```ts
import { notaPrimoContatto } from './primo-contatto-note';
```

Poi, nella chiamata a `generateMarioReply` (~riga 443), sostituisci il blocco `...(postino ? { contextNote: gdoContextNote({...}) } : {})` con:

```ts
        // I promemoria pendenti (video non confermato, Noemi non ancora spiegata)
        // viaggiano dentro il contesto: il modello li integra nel discorso invece di
        // farli arrivare come un messaggio programmato addosso. Sui lead adottati la
        // nota e' un'altra, la dichiarazione IA: un postino ha sempre ricevuto l'agenda,
        // quindi i due casi non si incontrano mai.
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
          : notaPrimoContatto(rows)
            ? { contextNote: notaPrimoContatto(rows) }
            : {}),
```

**Non toccare** il secondo `generateMarioReply` (~riga 490): è il retry del ramo postino, dove la nota primo contatto non si applica mai.

- [ ] **Step 6: Esegui tutta la suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: tutto verde

- [ ] **Step 7: Commit**

```bash
git add lib/primo-contatto-note.ts lib/primo-contatto-note.test.ts lib/fenice-autoreply.ts
git commit -m "$(cat <<'EOF'
feat(bot): la dichiarazione IA anche a chi scrive per primo

Le aperture dichiarate vivono dentro i template: un lead adottato dal
webhook non ne riceve nessuno e senza questa nota non saprebbe mai con
chi parla. L'AI Act art. 50 e' in vigore dal 2 agosto.

Nota appesa al system prompt, non messaggio fisso: il modello la integra
nel saluto invece di sparare un annuncio addosso a chi ha appena fatto
una domanda.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0155zuH5FHstnTnCJnprbmR9
EOF
)"
```

---

### Task 5: Nessuna apertura sopra una chat già avviata

Sui 14 lead Telegram lavorati ad agosto la prima risposta è partita in **0.0 ore**: l'intake del CRM arriva a conversazione già iniziata. Senza guardia il lead vedrebbe "Ciao, sono Marta di Fenice Academy" cadere sopra una chat in corso, cioè un bot che ricomincia da capo.

**Files:**
- Modify: `lib/fenice-enroll.ts:29-115` (`enrollLeadIntoMario`)
- Modify: `app/api/bot/intake/route.ts:104-120` (la risposta)
- Test: `lib/fenice-enroll.test.ts`

**Interfaces:**
- Consumes: niente dai task precedenti.
- Produces: `apreSopraChatViva(g: { aiOwner: string | null; aiStatus: string | null; haOutboundPartito: boolean }): boolean` da `lib/fenice-enroll.ts`; `enrollLeadIntoMario` torna in più `aperturaSaltata?: boolean`.

- [ ] **Step 1: Scrivi il test che fallisce**

In `lib/fenice-enroll.test.ts`, aggiungi `apreSopraChatViva` all'import da `./fenice-enroll` e in coda al file:

```ts
describe('apreSopraChatViva', () => {
  const viva = { aiOwner: 'mario', aiStatus: 'active', haOutboundPartito: true };
  it("vero: Mario sta già parlando con questa persona", () => {
    expect(apreSopraChatViva(viva)).toBe(true);
  });
  it('falso su una chat nuova', () => {
    expect(apreSopraChatViva({ aiOwner: null, aiStatus: null, haOutboundPartito: false })).toBe(false);
  });
  // Il caso di riapri-mute: abbiamo PROVATO a mandare l'apertura e non è mai partita.
  // Se la guardia scattasse qui, quelle conversazioni resterebbero mute per sempre.
  it("falso se un invio è stato tentato ma non è mai partito", () => {
    expect(apreSopraChatViva({ ...viva, haOutboundPartito: false })).toBe(false);
  });
  it('falso su una chat chiusa o passata a una persona', () => {
    expect(apreSopraChatViva({ ...viva, aiStatus: 'closed' })).toBe(false);
    expect(apreSopraChatViva({ ...viva, aiStatus: 'handed_off' })).toBe(false);
  });
  it("falso se la chat non è di Mario", () => {
    expect(apreSopraChatViva({ ...viva, aiOwner: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `bun run test -- lib/fenice-enroll.test.ts`
Expected: FAIL — `apreSopraChatViva is not a function`

- [ ] **Step 3: Implementa la funzione pura**

In `lib/fenice-enroll.ts`, sopra `enrollLeadIntoMario`:

```ts
/**
 * Pure: mandare l'apertura adesso vorrebbe dire ricoprire una conversazione viva?
 *
 * Vero solo se Mario sta gia' parlando con questa persona E il lead ha gia' visto almeno
 * un nostro messaggio. Il caso e' quotidiano da quando il bot adotta chi scrive per primo:
 * sui 14 lead Telegram lavorati ad agosto l'intake del CRM e' arrivato a chat gia'
 * iniziata, con 0.0 ore di ritardo.
 *
 * `haOutboundPartito` conta solo i messaggi con `twilio_sid`, cioe' partiti davvero. E'
 * il criterio di `app/api/cron/riapri-mute/route.ts`, e cambiarlo lo romperebbe: quel
 * cron esiste per le conversazioni dove abbiamo PROVATO a mandare l'apertura e non e'
 * mai partita, e con "esiste una riga in uscita" diventerebbero irrecuperabili.
 */
export function apreSopraChatViva(g: {
  aiOwner: string | null;
  aiStatus: string | null;
  haOutboundPartito: boolean;
}): boolean {
  return g.aiOwner === 'mario' && g.aiStatus === 'active' && g.haOutboundPartito;
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `bun run test -- lib/fenice-enroll.test.ts`
Expected: PASS

- [ ] **Step 5: Usa la guardia dentro `enrollLeadIntoMario`**

In `lib/fenice-enroll.ts`, subito **dopo** `findOrCreateLeadConversation` e **prima** della dichiarazione di `convUpdate`, inserisci:

```ts
  // Non si lascia cadere un'apertura sopra una conversazione gia' avviata: il lead
  // vedrebbe il bot ricominciare da capo. Si prende comunque in carico il lead per il
  // CRM, cosi' da parte loro non risulta fermo.
  {
    const { data: convRow } = await supabase
      .from('conversations').select('ai_owner, ai_status').eq('id', conversationId).single();
    const { count: partiti } = await supabase
      .from('messages').select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId).eq('direction', 'out').not('twilio_sid', 'is', null);
    if (apreSopraChatViva({
      aiOwner: convRow?.ai_owner ?? null,
      aiStatus: convRow?.ai_status ?? null,
      haOutboundPartito: (partiti ?? 0) > 0,
    })) {
      // Solo i campi valorizzati: scrivere null cancellerebbe il `crm_funnel` che il
      // webhook ha appena dedotto dal primo messaggio del lead.
      const patch = {
        ...(args.crmLeadId ? { crm_lead_id: args.crmLeadId } : {}),
        ...(args.crmFunnel ? { crm_funnel: args.crmFunnel } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await supabase.from('conversations').update(patch).eq('id', conversationId);
      }
      await supabase.from('event_log').insert({
        type: 'apertura_saltata_chat_in_corso',
        payload: { phone: args.phone, conversationId, crmLeadId: args.crmLeadId ?? null } as never,
        message: `[bot-fissatore] apertura saltata per ${args.phone}: la chat e' gia' avviata`,
        level: 'info',
      });
      return { ok: true, conversationId, aperturaSaltata: true };
    }
  }
```

E aggiungi `aperturaSaltata?: boolean` al tipo di ritorno di `enrollLeadIntoMario`.

**Non toccare** `enrollGdoLeadAsPostino`: manda sempre, per scelta — il GDO è al telefono col lead in quel momento.

- [ ] **Step 6: Dillo al CRM nella risposta dell'intake**

In `app/api/bot/intake/route.ts`, nella risposta di successo (~riga 111), aggiungi in coda all'oggetto, accanto a `...(res.deferred ? { apertura: 'differita' } : {})`:

```ts
      // Il lead sta gia' parlando col bot (ci ha scritto lui per primo): l'apertura non
      // parte, ma il lead e' preso in carico. Dirlo evita che dal loro lato risulti muto,
      // che e' la radice della disputa sui "lead fermi al bot" del 29/08.
      ...(res.aperturaSaltata ? { apertura: 'saltata_chat_in_corso' } : {}),
```

- [ ] **Step 7: Esegui tutta la suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: tutto verde. Se un test esistente di `fenice-enroll` fallisce perché il mock di Supabase non gestisce le due query nuove, aggiorna il mock — **non** la guardia.

- [ ] **Step 8: Commit**

```bash
git add lib/fenice-enroll.ts lib/fenice-enroll.test.ts app/api/bot/intake/route.ts
git commit -m "$(cat <<'EOF'
fix(bot): l'intake non ricopre una chat gia' avviata

Sui 14 lead Telegram lavorati ad agosto l'intake del CRM e' arrivato a
conversazione gia' iniziata, con 0.0 ore di ritardo: con l'adozione
accesa il lead si vedrebbe cadere addosso "Ciao, sono Marta" mentre sta
gia' parlando col bot.

Il criterio e' outbound CON twilio_sid, cioe' partito davvero: con
"esiste una riga in uscita" le conversazioni che riapri-mute recupera
diventerebbero irrecuperabili.

L'intake risponde apertura: 'saltata_chat_in_corso', cosi' dal lato CRM
il lead risulta preso in carico e non fermo.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0155zuH5FHstnTnCJnprbmR9
EOF
)"
```

---

### Task 6: Il recupero dei 29

**Files:**
- Create: `app/api/cron/adotta-mai-risposti/route.ts`

**Interfaces:**
- Consumes: `funnelDaPrimoMessaggio` (Task 1), `sendTemplateAndLog` (`lib/messaging`), `templateName` (`lib/name`), `inSendWindow` (`lib/sequence`), `fetchAllRows` (`lib/supabase/paginate`).
- Produces: `POST /api/cron/adotta-mai-risposti` → `{ ok, candidate, inviati, falliti, esempi }`.

Il template è il **riaggancio già approvato** (`MARTA_REENGAGE_TEMPLATE_SID`), non le aperture: quelle promettono "l'accesso al canale Telegram ti arriva via email" a gente che nel canale c'è già, o 10 ore gratuite che nessuno ha chiesto.

- [ ] **Step 1: Scrivi la route**

Crea `app/api/cron/adotta-mai-risposti/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { sendTemplateAndLog } from '@/lib/messaging';
import { funnelDaPrimoMessaggio } from '@/lib/persona';
import { templateName } from '@/lib/name';
import { inSendWindow } from '@/lib/sequence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * I lead che ci hanno scritto per primi e a cui non ha mai risposto nessuno.
 *
 * Fino al 04/09/2026 il bot rispondeva solo a chi gli mandava l'intake del CRM: chi
 * scriveva per primo non aveva padrone. Fra il 26/08 e il 04/09 sono 29 persone su 43
 * arrivate dal canale Telegram, con un silenzio mediano di 113 ore, e sei di loro hanno
 * scritto di nuovo nel vuoto ("Scusa poi risponde").
 *
 * Sono tutte fuori dalla finestra 24h, quindi per riaprire serve un template. Si usa il
 * RIAGGANCIO gia' approvato, non le aperture: l'apertura Telegram dice "l'accesso al
 * canale ti arriva via email a breve" a gente che nel canale c'e' gia' — e' da li' che ha
 * preso il nostro numero — e quella del corso promette 10 ore che nessuno ha chiesto.
 * Il riaggancio non promette niente.
 *
 * Rotta manuale come `riapri-mute`, NON in vercel.json. Con l'adozione accesa la sua
 * lista deve restare vuota: ricontrollarla ogni tanto e' il modo per accorgersi se
 * l'adozione ha smesso di funzionare.
 *
 * POST { dal?: 'YYYY-MM-DD', esegui?: boolean, max?: number }
 */

const BUDGET_MS = 240_000;

export async function POST(req: NextRequest) {
  const cron = process.env.CRON_SECRET;
  if (!cron || req.headers.get('authorization') !== `Bearer ${cron}`) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  let body: { dal?: string; esegui?: boolean; max?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 }); }

  const dal = typeof body.dal === 'string' ? body.dal : '2026-08-01';
  const esegui = body.esegui === true;
  const max = typeof body.max === 'number' && body.max > 0 ? Math.min(body.max, 100) : 25;

  const templateSid = process.env.MARTA_REENGAGE_TEMPLATE_SID;
  const from = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
  if (!templateSid || !from) {
    return NextResponse.json({ ok: false, error: 'MARTA_REENGAGE_TEMPLATE_SID o TWILIO_WHATSAPP_NUMBER_FENICE non configurati' }, { status: 503 });
  }

  const admin = getSupabaseAdmin();
  const started = Date.now();

  // Candidati: nessun padrone, il lead ha scritto, sul numero Fenice, nessuno l'ha
  // presa in mano. Il filtro sugli outbound si fa dopo, in memoria: PostgREST non sa
  // fare "nessuna riga collegata" senza una vista.
  const convs = await fetchAllRows<any>((from_, to) => admin
    .from('conversations')
    .select('id, lead_id, wa_number, ai_paused_at, handed_off_at, last_inbound_at')
    .is('ai_owner', null)
    .is('handed_off_at', null)
    .is('ai_paused_at', null)
    .not('last_inbound_at', 'is', null)
    .eq('wa_number', from)
    .gte('last_inbound_at', dal)
    .order('id', { ascending: true })
    .range(from_, to));

  const conOutbound = new Set<number>();
  const ids = convs.map((c: any) => c.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await admin.from('messages')
      .select('conversation_id').eq('direction', 'out').in('conversation_id', ids.slice(i, i + 100));
    for (const m of (data ?? []) as Array<{ conversation_id: number }>) conOutbound.add(m.conversation_id);
  }
  const muti = convs.filter((c: any) => !conOutbound.has(c.id) && c.lead_id);

  // Anagrafica e primo messaggio: il numero sta su `leads.phone_e164`, NON su
  // `conversations.wa_number` — quella colonna e' il NOSTRO mittente, e usarla come
  // destinatario vorrebbe dire mandare i riaggancio a noi stessi.
  const anagrafica = new Map<number, { phone: string; first_name: string | null }>();
  const leadIds = [...new Set(muti.map((c: any) => c.lead_id))];
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data } = await admin.from('leads')
      .select('id, phone_e164, first_name').in('id', leadIds.slice(i, i + 100));
    for (const l of (data ?? []) as Array<{ id: number; phone_e164: string; first_name: string | null }>) {
      if (l.phone_e164) anagrafica.set(l.id, { phone: l.phone_e164, first_name: l.first_name });
    }
  }

  let inviati = 0, falliti = 0;
  const errori: string[] = [];
  const esempi = muti.slice(0, 5).map((c: any) => ({ conv: c.id, scrittoIl: c.last_inbound_at }));

  if (esegui) {
    if (!inSendWindow(Date.now())) {
      return NextResponse.json({ ok: true, candidate: muti.length, inviati: 0, falliti: 0, esegui, fuoriFascia: true, esempi });
    }
    for (const c of muti) {
      if (inviati + falliti >= max || Date.now() - started > BUDGET_MS) break;
      const l = anagrafica.get(c.lead_id);
      if (!l) { falliti++; if (errori.length < 5) errori.push(`conv ${c.id}: nessun numero`); continue; }

      const { data: primi } = await admin.from('messages')
        .select('body').eq('conversation_id', c.id).eq('direction', 'in')
        .order('created_at', { ascending: true }).limit(1);
      const provenienza = funnelDaPrimoMessaggio(((primi ?? [])[0] as { body: string | null } | undefined)?.body);

      const now = new Date().toISOString();
      await admin.from('conversations').update({
        ai_owner: 'mario', ai_status: 'active', ai_started_at: now, crm_funnel: provenienza,
      }).eq('id', c.id);

      const nome = templateName(l.first_name);
      const res = await sendTemplateAndLog(
        admin, c.id, l.phone, templateSid, 'Riaggancio (mai risposto)', from,
        { '1': nome },
        `Ciao ${nome}, sono Marta di Fenice Academy: ci eravamo persi a metà discorso 🙂 Se ti va riprendiamo da dove eravamo rimasti, altrimenti scrivimi NO e non ti disturbo più.`,
      );
      if (res.ok) inviati++;
      else { falliti++; if (errori.length < 5) errori.push(res.error ?? 'errore'); }
    }

    await admin.from('event_log').insert({
      type: 'adotta_mai_risposti',
      payload: { candidate: muti.length, inviati, falliti, dal } as never,
      message: `[bot-fissatore] recupero di chi ci ha scritto per primo: ${inviati} riaggancio partiti, ${falliti} falliti`,
      level: falliti > 0 ? 'warn' : 'info',
    });
  }

  return NextResponse.json({
    ok: true, dal, candidate: muti.length, esaminate: convs.length, inviati, falliti, esegui, errori, esempi,
  });
}
```

- [ ] **Step 2: Verifica tipi, lint e suite**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: tutto verde

- [ ] **Step 3: Prova a vuoto in locale**

Con `bun run dev` avviato:

```bash
curl -s -X POST http://localhost:3000/api/cron/adotta-mai-risposti \
  -H "authorization: Bearer $CRON_SECRET" \
  -H 'content-type: application/json' \
  -d '{"dal":"2026-08-01"}' | head -c 600
```

Expected: `esegui:false`, e **`candidate` intorno a 29**. Se torna 43 il filtro sugli outbound non funziona; se torna centinaia, il filtro su `wa_number` non sta mordendo. In tutti e due i casi fermarsi e capire prima di eseguire.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/adotta-mai-risposti/route.ts
git commit -m "$(cat <<'EOF'
feat(bot): recupero di chi ci ha scritto per primo e non ha avuto risposta

29 persone fra il 26/08 e il 04/09, silenzio mediano di 113 ore. Sono
fuori dalla finestra 24h, quindi serve un template: si usa il riaggancio
gia' approvato e non le aperture, che promettono l'accesso al canale
Telegram a chi nel canale c'e' gia' e 10 ore gratuite che nessuno ha
chiesto.

Rotta manuale come riapri-mute, esegui:false di default. Con l'adozione
accesa la sua lista deve restare vuota.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0155zuH5FHstnTnCJnprbmR9
EOF
)"
```

---

## Verifiche prima di accendere (a mano, dopo il merge e il push)

Non sono task: sono i controlli che vanno fatti in produzione, in quest'ordine.

- [ ] **Il push.** Il merge non basta: la produzione si aggiorna al push su `origin/main`.
- [ ] **La categoria del riaggancio.** Se `UTILITY_ONLY=1` in produzione, `MARTA_REENGAGE_TEMPLATE_SID` deve essere UTILITY o stare in `UTILITY_ONLY_ALLOW`, altrimenti `assertTemplateSendable` blocca tutti e 29 gli invii. È l'errore del 24/08 — template in env e mai in allow-list, 27 lead muti per quattro giorni.
- [ ] **Prova a vuoto del recupero** in produzione (`esegui:false`): `candidate` deve essere ~29.
- [ ] **Un lead vero.** Accendi `INBOUND_ADOPTION_ENABLED=1`, scrivi dal tuo telefono al numero Fenice e verifica: risposta in meno di un minuto, dichiarazione IA nella prima riga, `ai_owner='mario'`, `crm_funnel='INBOUND'`, e la riga che compare in `/api/bot/lead-entranti`.
- [ ] **La collisione.** Sullo stesso lead di prova manda l'intake: deve rispondere `apertura: 'saltata_chat_in_corso'` e **non** deve arrivare nessun template.
- [ ] **Il recupero vero**, a scaglioni: `{"esegui":true,"max":5}` e si guarda cosa succede, poi il resto.
- [ ] **L'ok del CRM** su `/api/bot/lead-entranti` prima di lasciare l'adozione accesa a regime: da quel momento il bot parla con gente che loro non hanno mandato, e devono saperlo prima di scoprirlo dalla dashboard.
