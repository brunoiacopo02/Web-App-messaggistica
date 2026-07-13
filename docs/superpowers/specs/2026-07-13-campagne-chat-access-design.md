# Accesso "campagne" — chat delle campagne Fenice (Black Summer)

Data: 2026-07-13 · Stato: approvato dall'utente (design + esclusione da /inbox)

## Problema

Oggi (13/07) partono ~2640 template Black Summer verso la lista AC 130 (7 slot orari
da 450, 14:00→20:00 IT). Le risposte dei lead finiscono a DB ma:

- il pannello `/fenice` filtra `ai_owner='mario'` → le chat campagna non compaiono;
- l'inbox Serenamente (`/inbox`) mostra tutte le conversazioni `ai_owner null` →
  verrebbe sommersa da 2640 chat che non c'entrano col loro CRM;
- non esiste un accesso dedicato per il team Fenice Academy che deve vedere e
  rispondere a queste chat.

## Decisioni utente

1. Perimetro: **tutte le campagne Fenice** (oggi la 5, in futuro le prossime), non solo
   Black Summer. Le campagne di giugno (1–4) sono di Serenamente e restano fuori.
2. Login dedicato: **campagne@fenice.com** (Supabase Auth, password generata e
   consegnata a fine lavoro).
3. Le conversazioni di campagne Fenice vengono **escluse da /inbox** (Serenamente).
4. Limite noto e accettato: i 3 lead overlap con Mario hanno la conversazione già
   intestata a Mario (`ai_owner='mario'`, `campaign_id` null) → restano visibili solo
   in `/fenice`, non nel nuovo pannello (decisione del 07/07 confermata).

## Design

### 1. Dato: proprietario campagna

Migrazione Supabase:

```sql
alter table campaigns add column owner text not null default 'serenamente';
update campaigns set owner = 'fenice' where id = 5;
```

`owner ∈ {'serenamente','fenice'}` (check constraint). Le campagne future Fenice si
marcano impostando `owner='fenice'` alla creazione.

### 2. Accesso (`lib/access.ts`)

- Nuova `Area = 'fenice' | 'campagne' | 'all'`.
- `CAMPAGNE_ONLY = {'campagne@fenice.com'}`.
- `canAccess`: area `campagne` → solo `/campagne-chat`(+sotto-path) e
  `/api/campagne-chat`(+sotto-path). Nessun accesso a /inbox, /fenice, ecc.
- `landingPath('campagne@fenice.com') = '/campagne-chat'`.
- L'area `fenice` NON vede `/campagne-chat`. L'area `all` vede tutto (invariato).
- Il gate è il `proxy.ts` esistente (path-based), nessuna modifica al proxy.

### 3. UI: `app/(campagne)/campagne-chat/`

Due pannelli, pattern e componenti ricalcati da `/inbox`:

- **Lista conversazioni**: nome, telefono, anteprima ultimo messaggio, badge non
  letti, ora ultimo messaggio; filtri `tutte | non lette | recenti`, ricerca per
  nome/numero, selettore campagna (se >1 campagna Fenice). Polling/refresh come
  l'inbox esistente.
- **Thread**: messaggi in/out in ordine cronologico (inclusi i template inviati dal
  batch), stato Twilio degli out.
- **Box risposta**: testo libero. All'invio: POST all'API di reply; in caso di errore
  Twilio "fuori finestra 24h" (63016 e affini) messaggio leggibile in UI.
- Layout con logout, titolo "Chat campagne Fenice". Stile coerente col resto
  (shadcn/design system esistente).

### 4. API: `app/api/campagne-chat/`

Tutte con auth Supabase server-side (`getSupabaseServer` + `auth.getUser()`), come le
route esistenti. In più, ogni route sui singoli thread riverifica che la conversazione
appartenga a una campagna con `owner='fenice'` (difesa in profondità oltre al gate di
path del proxy).

- `GET /api/campagne-chat/conversations` — come `/api/conversations` ma filtrata su
  `campaign_id ∈ (select id from campaigns where owner='fenice')`; stessi parametri
  `filter`/`q`, in più `campaign` opzionale.
- `GET /api/campagne-chat/conversations/[id]/messages` — thread (mirror di
  `/api/conversations/[id]/messages` + verifica ownership fenice).
- `POST /api/campagne-chat/conversations/[id]/reply` — body `{ text }`:
  `sendText` Twilio (from = `TWILIO_WHATSAPP_NUMBER`, quello della campagna), insert
  in `messages` (direction 'out'), update `last_message_at`; errori Twilio mappati
  (finestra 24h scaduta → 422 con messaggio chiaro).
- `POST /api/campagne-chat/conversations/[id]/read` — azzera `unread_count` (mirror
  della route read esistente).

### 5. Esclusione da /inbox

`app/api/conversations/route.ts`: al filtro esistente `.is('ai_owner', null)` si
aggiunge l'esclusione delle conversazioni con `campaign_id` di campagne
`owner='fenice'` (fetch degli id fenice + `not in`). Le conversazioni delle campagne
1–4 (giugno, Serenamente) restano in /inbox.

### 6. Utenza

Creazione via Supabase Auth Admin API (service role): `campagne@fenice.com`,
password forte generata, `email_confirm: true`. Consegna credenziali all'utente a
fine lavoro (non committate da nessuna parte).

## Test

- `lib/access.test.ts`: casi per l'area `campagne` (vede solo i suoi path, non vede
  /inbox e /fenice; fenicebot non vede /campagne-chat; landing corretta).
- Unit test per l'eventuale helper puro di scoping/mappatura errori Twilio.
- Verifica end-to-end post-deploy: login con la nuova utenza → vede solo
  /campagne-chat; l'inbox Serenamente non mostra conversazioni campagna 5;
  reply su una chat reale entro finestra.

## Fuori scope

- Gestione campagne (creazione/attivazione) dal nuovo pannello: no, resta in
  /campagne (area 'all').
- Notifiche push/email su nuove risposte: no (YAGNI).
- Migrare i 3 overlap Mario nel nuovo pannello: no (decisione 07/07).
