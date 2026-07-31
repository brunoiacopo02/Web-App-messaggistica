# Pannello chat di supervisione (`/chat`)

Data: 2026-07-31
Stato: design approvato, da pianificare

## Problema

Oggi non esiste un posto dove vedere tutte le chat del mondo Fenice. Sono spezzate in tre
pannelli che si escludono a vicenda:

- `/inbox` filtra via **tutto** ciò che ha `ai_owner='mario'` (`app/(app)/inbox/layout.tsx:19`,
  `app/api/conversations/route.ts:26`) e tutte le campagne `owner='fenice'`
  (`excludeFeniceCampaigns`). Quindi né Mario né i lead GDO in modalità postino.
- `/campagne-chat` vede **solo** `campaign_id ∈ campagne fenice`.
- `/fenice/conversazioni` vede **solo** `ai_owner='mario'`, è read-only, e mostra i messaggi
  solo da `ai_started_at` in poi (`app/api/fenice/conversation/route.ts:46`): la storia
  precedente all'arruolamento è invisibile.

Serve una vista unica, in sola lettura, su tutte le chat in cui il bot lavora — comprese
quelle in modalità postino GDO — accessibile da un'utenza dedicata.

## Obiettivo

Un pannello `/chat` che mostra tutte le conversazioni del mondo Fenice e cosa risponde il bot,
con l'esito del lead secondo Mario, lo stato di consegna WhatsApp e l'indicazione di quale
mondo sia ciascuna chat. Sola lettura, senza possibilità di scrivere.

## Decisioni

**Sola lettura per costruzione, non per configurazione.** Il `Composer` non viene importato e
non esiste alcun endpoint POST sotto `/api/chat`. Non c'è un flag da spegnere: manca proprio
la strada per scrivere.

**Perimetro = mondo Fenice, fuori Serenamente.** Una conversazione entra se
`ai_owner='mario'` **oppure** `campaign_id` appartiene a una campagna `owner='fenice'`. La
prima condizione copre sia i lead di Mario sia i lead GDO in modalità postino (che
`lib/fenice-enroll.ts:166-183` marca proprio con `ai_owner='mario'`).

**Storia intera.** Nessun filtro su `ai_started_at`, a differenza di `/fenice/conversazioni`.

**Client autenticato, non service-role.** Il pannello legge con il client di sessione (come
`/campagne-chat`), non con il client admin che `/fenice` usa e che scavalca RLS.

**Riuso dei componenti esistenti.** `ConversationList` e `MessageThread` accettano già le prop
che servono; il pannello è quasi tutto assemblaggio.

## Architettura

### 1. Accesso

`lib/access.ts` guadagna una quarta area, `'chat'`, sul modello esatto di `'campagne'`:

```ts
export type Area = 'fenice' | 'campagne' | 'chat' | 'all';
const CHAT_ONLY = new Set(['fenice@academy.com']);
```

- `canAccess` per l'area `chat` consente `/chat`, `/chat/*`, `/api/chat` e `/api/chat/*`.
- `landingPath` per l'area `chat` restituisce `/chat`.

Il gate resta quello per path già in `proxy.ts:28-35`: fuori area, redirect alla landing per le
pagine e `403 {"error":"forbidden"}` per le API. Nessuna modifica a `proxy.ts`.

**Utenza:** `fenice@academy.com`, creata su Supabase Auth via Admin API con
`email_confirm: true`. La password richiesta (`2134`) è sotto il minimo di 6 caratteri imposto
da Supabase Auth: si usa **`fenice2134`** salvo indicazione diversa di Bruno al momento della
creazione.

### 2. Perimetro

Nuovo `lib/chat-perimetro.ts`, unico punto in cui il perimetro è definito — lista, dettaglio e
API lo chiamano tutte:

```ts
/** Restringe una query conversations al mondo Fenice (Mario + GDO + campagne fenice). */
export function soloMondoFenice(query: any, feniceIds: number[]): any;

/** True se la conversazione è nel perimetro del pannello /chat. */
export async function isConversazioneChat(client, conversationId): Promise<boolean>;
```

`soloMondoFenice` compone un solo `.or()`:

- con campagne fenice presenti → `.or('ai_owner.eq.mario,campaign_id.in.(<ids>)')`
- con `feniceIds` vuoto → `.eq('ai_owner', 'mario')`

Gli id fenice arrivano da `getFeniceCampaignIds` (`lib/campagne.ts:4-7`), già esistente.

**Trappola SQL da non ripetere:** `excludeFeniceCampaigns` esiste perché `NOT IN` scarta anche
i NULL. Qui il rischio è speculare — `IN` su lista vuota produce SQL invalido — ed è la ragione
del ramo esplicito per `feniceIds` vuoto.

### 3. Pagine

Nuovo route group `app/(chat)/`, che ricalca `app/(campagne)/`:

| File | Contenuto |
|---|---|
| `app/(chat)/chat/layout.tsx` | carica la lista server-side con `soloMondoFenice`, ordina per `last_message_at` desc, limit 200; rende `ConversationList` |
| `app/(chat)/chat/page.tsx` | stato vuoto ("scegli una conversazione") |
| `app/(chat)/chat/[conversationId]/page.tsx` | guardia `isConversazioneChat` → `notFound()`; intestazione + `MessageThread` |

Prop usate: `ConversationList` con `apiPath='/api/chat/conversations'`, `basePath='/chat'`,
`channelName='chat-list'` (nome canale realtime distinto dagli altri pannelli);
`MessageThread` con `apiBase='/api/chat/conversations'`.

**Nessun `Composer`.**

### 4. API

| Rotta | Metodo | Comportamento |
|---|---|---|
| `/api/chat/conversations` | GET | lista filtrata da `soloMondoFenice`; supporta `?filter=all\|unread\|recent&q=` come le altre liste; risponde `{ data: Conv[] }` |
| `/api/chat/conversations/[id]/messages` | GET | guardia `isConversazioneChat` → `403 {"error":"forbidden"}`; messaggi ordinati per `created_at`, **senza** taglio a `ai_started_at` |

Nessun POST, PATCH o DELETE. Nemmeno la marcatura "letto": il pannello non tocca
`unread_count` (chi guarda non deve alterare lo stato che vede chi lavora).

### 5. Attribuzione dei messaggi

Oggi una risposta del bot e una scritta a mano sono righe identiche (`direction='out'`,
`is_template=false`, `template_sid=null`): non esiste alcuna colonna `sender`, `source` o `role`.

**Migration `20260731000001_messages_sender.sql`:**

```sql
alter table public.messages add column if not exists sender text;
comment on column public.messages.sender is
  'Chi ha prodotto il messaggio in uscita: bot | automazione | operatore. Nullo sugli inbound.';
```

Colonna nullable, nessun vincolo NOT NULL, nessun indice (non ci si filtra sopra).

Valori:

- **`bot`** — messaggio deciso e composto dal turno di Mario.
- **`automazione`** — template programmato, nessuna decisione presa sul momento.
- **`operatore`** — una persona l'ha scritto o l'ha scelto e mandato dalla UI.
- **null** — messaggi in ingresso (`direction='in'`).

Punti d'invio da valorizzare (tutti gli insert su `messages` presenti in repo):

| File:riga | Valore |
|---|---|
| `lib/fenice-autoreply.ts:328` (risposta AI di Mario) | `bot` |
| `lib/fenice-autoreply.ts:240` (video GDO al primo inbound) | `bot` |
| `lib/conversation-send.ts:42` (testo libero da UI) | `operatore` |
| `lib/conversation-send.ts:79` (template da UI) | `operatore` |
| `lib/messaging.ts:68`, `:84` (`sendTemplateAndLog`: apertura Mario, agenda GDO) | `automazione` |
| `lib/agenda-followup.ts:160` | `automazione` |
| `app/api/cron/sequence-touches/route.ts:64`, `:89`, `:343` | `automazione` |
| `app/api/cron/send-batch/route.ts:138`, `:161` | `automazione` |
| `app/api/webhooks/activecampaign/route.ts:156`, `:170` | `automazione` |
| `scripts/invio-agenda-gdo.mjs:232` | `automazione` |
| `scripts/invio-video-agenda-gdo.mjs:228` | `automazione` |
| `app/api/webhooks/twilio/route.ts:137` (inbound) | non valorizzato (null) |

**Backfill dello storico (stima dichiarata, non fatto):** nella stessa migration,

1. `is_template = true` → `automazione`
2. `direction='out' and is_template=false` su conversazioni con `ai_owner='mario'` → `bot`
3. restante `direction='out'` → `operatore`

La regola 2 sbaglia per eccesso sui messaggi scritti a mano dentro una chat di Mario e per
difetto sui testi del bot precedenti a un cambio di `ai_owner`. È accettabile e va detto nella
UI: il pannello mostra l'etichetta come "stimata" per i messaggi anteriori alla migration
(confronto su `messages.created_at`), certa da lì in poi.

### 6. Contorno della chat

In testa al thread, tutto derivato — nessuna colonna nuova oltre a `sender`:

- **Badge del mondo:** `gdo_agenda_at` valorizzato → **GDO (postino)**; altrimenti
  `ai_owner='mario'` → **Mario**; altrimenti → **Campagna**. In quest'ordine di precedenza,
  perché una conversazione GDO ha anche `ai_owner='mario'` e può avere un `campaign_id` fenice
  ereditato da una campagna precedente.
- **Esito del bot:** `bot_outcome`, `ai_status` e `bot_scheduled_at` (data appuntamento),
  resi con i pill già esistenti in `components/fenice/status.tsx` (`ReasonPill`,
  `ChatStatusPill`) e la logica di `lib/lead-segments.ts`.
- **Stato di consegna:** già mostrato da `MessageThread` tramite `DeliveryStatus`
  (`twilio_status`, `twilio_error_code`) — nessun lavoro.

Il badge del mondo compare anche nelle righe della lista.

## Limite noto (accettato)

L'isolamento è **solo per path**. Le RLS sono `auth_all` (single-tenant): chi possiede le
credenziali `fenice@academy.com` può in teoria leggere qualsiasi tabella interrogando
PostgREST direttamente, Serenamente compresa. Vale già oggi per `campagne@fenice.com` ed è un
follow-up aperto dal 13/07. Se l'utenza finisce fuori dal controllo di Bruno, va affrontata
prima con RLS per ruolo.

## Test

- **`lib/access.test.ts`** — quattro aree: `fenice@academy.com` apre `/chat` e `/api/chat/...`,
  non apre `/inbox`, `/campagne-chat`, `/fenice`, `/api/conversations`; le tre aree esistenti
  restano invariate; `landingPath` corretta.
- **`lib/chat-perimetro.test.ts`** — un caso per tipo: lead Mario (dentro), lead GDO postino
  (dentro), conversazione campagna fenice (dentro), conversazione Serenamente con
  `campaign_id` null (fuori), conversazione Serenamente con campagna non-fenice (fuori);
  ramo `feniceIds` vuoto che non produce un `IN ()`.
- **API** — `/api/chat/conversations/[id]/messages` risponde 403 su conversazione fuori
  perimetro; la lista non contiene conversazioni Serenamente.
- **Attribuzione** — ogni punto d'invio scrive il `sender` atteso: verifica sui mock già
  presenti in `lib/fenice-autoreply.test.ts` e nei test di `conversation-send`,
  `sequence-touches`, `agenda-followup`.
- **Migration** — dopo il backfill, zero righe `direction='out'` con `sender` nullo.
- **Manuale** — login con `fenice@academy.com`, verifica che il menù non offra altre sezioni e
  che l'accesso diretto a `/inbox` rimbalzi su `/chat`.

## Fuori scope

- **`conversations.bot_report`**: il ragionamento strutturato di Mario (obiezioni, urgenza,
  leva consigliata) è già salvato a DB e non lo mostra nessuna UI. Esporlo è un lavoro a sé.
- Qualsiasi capacità di scrittura, pausa del bot o presa in carico dalla vista `/chat`.
- RLS per ruolo (vedi Limite noto).
- Ripulire la sovrapposizione per cui un lead GDO con un `campaign_id` fenice compare anche in
  `/campagne-chat` con il composer attivo mentre Mario risponde: è un bug reale ma preesistente
  e indipendente da questo pannello.
