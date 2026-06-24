# Tab "Presi" — chat degli appuntamenti presi

**Data:** 2026-06-24
**Sezione:** pannello `/fenice` (bot Mario), area **Lead**

## Problema

Quando il bot Mario fissa un appuntamento, la conversazione viene marcata con
`bot_outcome = 'APPUNTAMENTO'` ma **non c'è nessun posto nel pannello dove vedere
l'elenco degli appuntamenti presi e aprire la relativa chat**.

- La sezione **Lead** ha le tab `Attive · Mai risposto · Ferme · Report · Analisi`.
  Esiste già il conteggio `PRESO` nei dati, ma **non c'è una tab "Presi"**: l'elenco
  dei lead con appuntamento non è navigabile da nessuna parte.
- La sezione **Conversazioni** mostra tutte le chat mescolate insieme, senza modo di
  isolare quelle con appuntamento.

Risultato pratico (verificato su dati reali, 24/06/2026): c'è 1 appuntamento preso
(Deborah Tiano, +393500845771, fissato per Ven 26 Giu 08:00, conversazione `closed`,
53 messaggi) ma l'utente non riesce a trovarne la chat.

La chat **esiste** ed è già raggiungibile: il deep-link
`/fenice/conversazioni?id=<convId>` apre la conversazione (vedi `ConversationsPanel`
che legge `?id=` e carica il dettaglio via `/api/fenice/conversation?id=`). Manca solo
il punto di accesso: un elenco degli appuntamenti presi.

## Obiettivo

Aggiungere una tab **"Presi"** (per prima) nella sezione Lead, che mostri gli
appuntamenti presi come **agenda** (il più imminente in cima), con per ogni lead:

- data/ora appuntamento (`bot_scheduled_at`), es. "Ven 26 Giu · 08:00"
- nome + telefono del lead
- link **"Apri"** alla chat completa in Conversazioni

La chat aperta mostra già: contatti (nome/telefono/email), riassunto AI, trascrizione
completa. In più, mostreremo la **data dell'appuntamento anche nell'header della chat**.

## Decisioni prese

- **Approccio:** estendere la sezione Lead esistente con una tab "Presi" (non una
  nuova route dedicata).
- **Posizione tab:** "Presi" **per prima** →
  `Presi · Attive · Mai risposto · Ferme · Report · Analisi`.
- **Ordinamento:** agenda, appuntamento più imminente in cima (`bot_scheduled_at` ASC).
- **Data in chat:** mostrare la data appuntamento anche nell'intestazione della
  conversazione aperta.
- **Niente** migrazione DB, **niente** nuova route, **niente** nuova API. Si
  riusano `bot_outcome` / `bot_scheduled_at` già presenti su `conversations`.

## Modifiche (4 file)

### 1. `app/api/fenice/segments/route.ts`
- Aggiungere `bot_scheduled_at` alla `.select(...)` sulle conversations.
- Aggiungere `scheduledAt: c.bot_scheduled_at ?? null` ad ogni riga in `rows`.
- Il conteggio `counts.PRESO` esiste già (via `segmentOf`): nessuna modifica alla logica.
- L'ordinamento agenda della tab Presi viene fatto lato client (vedi sotto), così la
  API resta generica per tutti i segmenti.

### 2. `app/(fenice)/fenice/lead/_components/LeadPipeline.tsx`
- Estendere il tipo `Tab` con `'PRESO'`.
- Aggiungere `{ key: 'PRESO', label: 'Presi' }` **in testa** a `SEGMENT_TABS`.
- Aggiungere `'PRESO'` a `LIST_TABS` (così usa il rendering a lista già esistente).
- Estendere `SegRow` con `scheduledAt?: string | null`.
- Quando `tab === 'PRESO'`: ordinare le righe per `scheduledAt` crescente (le righe
  senza data in fondo) e renderizzare, accanto al nome, una **pill calendario** con
  data/ora formattata in `it-IT` (es. "Ven 26 Giu · 08:00"). Le righe degli altri
  segmenti restano invariate (mostrano `ReasonPill`).
- Il link "Apri" resta `/fenice/conversazioni?id=${r.id}` (già funzionante).

### 3. `app/api/fenice/conversation/route.ts`
- Aggiungere `bot_scheduled_at` alla `.select(...)` (ramo GET).
- Aggiungere `scheduledAt: c.bot_scheduled_at ?? null` all'oggetto `report` restituito.

### 4. `app/(fenice)/fenice/conversazioni/_components/ConversationsPanel.tsx`
- Estendere il tipo `Detail.report` con `scheduledAt: string | null`.
- Nell'header del dettaglio, **se `report.scheduledAt` è valorizzato**, mostrare una
  pill/badge "Appuntamento: <data/ora>" accanto allo `ChatStatusPill`.

## Flusso dati

```
conversations (bot_outcome='APPUNTAMENTO', bot_scheduled_at)
   └─ GET /api/fenice/segments?segment=PRESO  → rows[{ id, name, phone, scheduledAt, ... }]
        └─ LeadPipeline tab "Presi" (ordina per scheduledAt ASC, pill data)
             └─ "Apri" → /fenice/conversazioni?id=<id>
                  └─ ConversationsPanel → GET /api/fenice/conversation?id=<id>
                       → header con data appuntamento + contatti + riassunto AI + chat
```

## Edge case

- **`bot_scheduled_at` nullo** su un lead PRESO: la riga compare comunque (è preso),
  pill data assente o "—", ordinata in fondo. Nell'header chat il badge appuntamento
  non viene mostrato.
- **Periodo (7/30/all):** il filtro `period` esistente si applica su `created_at`
  della conversazione, coerente con gli altri segmenti. Nessun cambiamento.
- **Appuntamento fuori dalle 200 conversazioni recenti:** irrilevante — la lista Presi
  viene dalla API segments (limit 1000) e la chat si carica per `id`, non dalla lista
  precaricata.

## Verifica

- `npm run typecheck` e `npm run build` puliti.
- Manuale: aprire `/fenice/lead`, tab "Presi" → deve elencare Deborah Tiano con
  "Ven 26 Giu · 08:00"; "Apri" deve aprire la chat con header che riporta la data
  appuntamento, i contatti e i 53 messaggi.

## Fuori scope (YAGNI)

- Nuova route/sezione dedicata `/fenice/appuntamenti`.
- Modifiche allo schema DB.
- Notifiche / promemoria appuntamento.
- Modifica dell'appuntamento dal pannello.
