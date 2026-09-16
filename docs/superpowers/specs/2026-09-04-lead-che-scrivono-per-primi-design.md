# Il bot risponde a chi scrive per primo

Da approvare prima di eseguire. La parte rivolta al CRM sta in
`docs/crm/2026-09-04-lead-che-scrivono-per-primi.md`.

**Il numero che giustifica tutto:** dal 26/08 al 04/09, 43 persone hanno aperto loro una
chat sul numero Fenice con la frase precompilata del canale Telegram. **29 non hanno mai
ricevuto risposta** — zero messaggi in uscita, silenzio mediano di 113 ore, massimo 212.
Le 14 che una risposta l'hanno avuta (perche' il CRM le aveva registrate in parallelo)
hanno prodotto **4 appuntamenti su 14**, il 29%. Alla stessa resa, i 29 muti valgono ~8
appuntamenti persi in nove giorni. E il flusso accelera: 23 aperture in tutto agosto, 20
nei primi quattro giorni di settembre.

**La causa, in una riga:** il bot risponde solo se `ai_owner === 'mario'`
(`lib/fenice-autoreply.ts:48`), e quella colonna la scrive soltanto l'intake del CRM
(`lib/fenice-enroll.ts:47`). Chi scrive senza essere passato da un form non ha padrone:
il webhook salva il messaggio, alza `unread_count`, e finisce li'. Ne' bot ne' persona.

---

## Fase 0 — Il contratto col CRM (si fa per prima: aspetta una risposta loro)

Un lead che scrive per primo non esiste nel CRM, quindi non ha un `leadId`. Senza quello
`canSendOutcome` (`lib/fenice-autoreply.ts:83`) vieta l'invio dell'esito: il bot potrebbe
fissare un appuntamento e quell'appuntamento non arriverebbe da nessuna parte.

**`app/api/bot/lead-entranti/route.ts`** — nuovo endpoint di sola lettura, stessa firma
HMAC di `/api/bot/contatti-umani`, che il CRM ha gia' implementato ad agosto. Il CRM lo
interroga, crea i lead da parte sua, e ce li rimanda con l'intake normale: da li' in poi
`crm_lead_id` e' pieno e **tutto il resto del flusso funziona senza altre modifiche** —
esiti, note, appuntamenti, call-attempt.

`POST` con corpo `{"stato":"aperti"}`. Risposta:

```json
{ "ok": true, "totale": 29, "lead": [
  { "telefono": "+393200431888",
    "nome": null,
    "provenienza": "TELEGRAM",
    "primoMessaggio": "Buongiorno, sono nel canale Telegram e mi hanno indicato questo contatto per piu' informazioni su Fenice Academy",
    "scrittoIl": "2026-08-26T21:51:52+02:00",
    "conversationId": 7246,
    "statoBot": "active",
    "esito": null,
    "appuntamento": null } ] }
```

`esito` e `appuntamento` sono valorizzati quando il bot ha gia' concluso prima che loro
creassero il lead: cosi' al momento della creazione sanno subito che quella persona ha
gia' una call in agenda, invece di scoprirlo con un secondo giro.

Criterio della lista: conversazioni sul numero Fenice, con almeno un messaggio in
ingresso, **senza `crm_lead_id`**, non passate a una persona. Un lead esce dalla lista da
solo nel momento in cui il loro intake ci manda il `leadId`.

**Finche' non rispondono:** il bot lavora lo stesso e l'esito resta da noi, sulla colonna
`bot_outcome` e nel pannello `/fenice`, con un `event_log` di tipo
`bot_outcome_senza_leadid`. Nessun lead si perde, ma l'appuntamento non entra nel loro
flusso automatico finche' il giro non si chiude. E' la ragione per cui questa fase sta
per prima.

---

## Fase 1 — L'adozione (`lib/fenice-autoreply.ts`, puro, TDD)

```ts
export function shouldAdoptInbound(g: {
  toMatchesFenice: boolean;
  adoptionOn: boolean;
  aiOwner: string | null;
  aiPausedAt?: string | null;
  handedOffAt?: string | null;
  hasOutbound: boolean;
}): boolean
```

Vera **solo** se tutte: sul numero Fenice, interruttore acceso, `aiOwner === null`,
nessun fermo manuale, non in mano a una persona, e `hasOutbound === false`.

Le sei condizioni non sono difensivismo, sono sei modi diversi di rompere qualcosa:

- `aiOwner === null` — non si strappa una conversazione a Mario ne' a un GDO postino.
- `hasOutbound === false` — se un messaggio nostro e' gia' partito, quella chat ha una
  storia che non abbiamo letto qui. E' anche cio' che tiene fuori le campagne (`/inbox`,
  `campagne-chat`): la' il primo messaggio e' sempre nostro.
  **Qui "outbound" vuol dire una qualunque riga in uscita, anche senza `twilio_sid`** — e
  cioe' anche un invio tentato e fallito. E' il contrario del criterio della Fase 4, ed e'
  voluto: per adottare serve la certezza che nessuno abbia mai provato a scriverle;
  per non ricoprire una chat viva serve la certezza che il lead abbia visto qualcosa.
- `handedOffAt` / `aiPausedAt` — se una persona ha preso la chat, il bot non rientra. E'
  la stessa regola di `shouldReopen` (`lib/fenice-autoreply.ts:69`).

**Test** (`lib/fenice-autoreply.test.ts`): una per condizione, piu' il caso vero. Il caso
che conta di piu' e' il negativo: una conversazione di campagna con `ai_owner` nullo e un
outbound partito **non** deve essere adottata.

---

## Fase 2 — Il webhook (`app/api/webhooks/twilio/route.ts`)

Dentro il ramo `if (toMatchesFenice)` gia' esistente, **prima** di `shouldReopen`, la
select aggiunge `handed_off_at` e si conta l'outbound della conversazione (una query,
`head: true`).

Se `shouldAdoptInbound` e' vera:

```ts
await supabase.from('conversations').update({
  ai_owner: 'mario',
  ai_status: 'active',
  ai_started_at: now,
  crm_funnel: funnelDaPrimoMessaggio(body),  // 'TELEGRAM' | 'INBOUND'
}).eq('id', conversationId);
```

Poi il flusso prosegue da solo: `shouldAutoReply` trova `ai_owner='mario'` e
`ai_status='active'`, e `drainMarioReplies` risponde. **Nessun template**: il lead ha
appena aperto lui la finestra 24h, si risponde a testo libero, in secondi, a costo zero e
senza toccare la categoria dei template — che su un numero a qualita' LOW e' il punto.

`funnelDaPrimoMessaggio` (puro, in `lib/persona.ts` accanto a `normalizeFunnel`): il testo
del canale Telegram → `'TELEGRAM'`, qualunque altro → `'INBOUND'`. Serve a due cose: la
variante A/B corretta se un giorno a questa persona si mandasse un template, e statistiche
oneste — su Telegram non devono finire persone che da Telegram non sono passate.

Un `event_log` di tipo `inbound_adottato` con telefono, conversationId e provenienza: e'
la traccia con cui si misura se questa cosa funziona.

**Interruttore:** `INBOUND_ADOPTION_ENABLED`. Va in produzione a `0`. Si accende quando il
CRM ha risposto sulla Fase 0.

---

## Fase 3 — La dichiarazione IA sulla prima risposta

L'AI Act art. 50 e' in vigore dal 2 agosto: al primo contatto il bot deve dichiararsi.
Oggi quella dichiarazione vive **solo dentro i template di apertura** ("sono Marta,
l'assistente digitale di Fenice Academy", `lib/persona.ts:79`). Un lead adottato non
riceve nessuna apertura: senza questa fase, non se lo sentirebbe mai dire.

In `lib/mario-prompt.ts`, una regola per il caso "nessun nostro messaggio prima": la prima
risposta si apre presentandosi come l'assistente digitale di Fenice Academy. Il resto del
prompt non si tocca — in particolare resta la riga 144, che gia' vieta di affermare di
essere una persona reale.

**Test** (`lib/mario-prompt.test.ts`): il prompt costruito su una cronologia senza
outbound contiene l'istruzione; con outbound non la contiene.

---

## Fase 4 — Nessuna apertura sopra una chat gia' avviata

Sui 14 lead lavorati la prima risposta e' partita in **0.0 ore**: l'intake del CRM arriva
quasi in contemporanea al messaggio del lead. Con l'adozione accesa, senza guardia, la
sequenza sarebbe: il lead scrive, Mario risponde, venti minuti dopo arriva l'intake e
`enrollLeadIntoMario` gli lascia cadere "Ciao, sono Marta di Fenice Academy" sopra una
conversazione gia' in corso. Il lead vede un bot che ricomincia da capo.

`enrollLeadIntoMario` (`lib/fenice-enroll.ts:29`) prende una guardia: se la conversazione
ha gia' **un messaggio in uscita partito davvero** (con `twilio_sid`) ed e'
`ai_owner='mario'` con `ai_status='active'`, l'apertura non parte. Si aggiornano solo
`crm_lead_id` e `crm_funnel`, e si torna `{ ok: true, conversationId, aperturaSaltata: true }`.

`/api/bot/intake` risponde `accettato: true, apertura: 'saltata_chat_in_corso'`: dal lato
CRM il lead risulta preso in carico, non muto. E' la lezione del 29/08 — un lead che noi
lavoriamo e loro vedono come fermo e' la radice della disputa sui "lead fermi al bot".

**Il criterio e' "outbound CON `twilio_sid`", non "esiste una riga in uscita".** E' lo
stesso che usa `app/api/cron/riapri-mute/route.ts:60`, e la coincidenza non e' casuale:
quel cron recupera le conversazioni dove abbiamo *provato* a mandare e non e' partito
niente. Con il criterio sbagliato, la guardia le renderebbe irrecuperabili.

Da non toccare: `enrollGdoLeadAsPostino`. Manda sempre, per scelta — il GDO e' al telefono
col lead in quel momento.

**Test** (`lib/fenice-enroll.test.ts`): chat adottata e attiva → apertura saltata,
`crm_lead_id` scritto; chat con riga in uscita ma senza SID → apertura mandata (non si
rompe `riapri-mute`); chat nuova → apertura mandata come oggi.

---

## Fase 5 — I 29 rimasti indietro

Fuori dalla finestra 24h (mediana 5 giorni, massimo 9): per riaprire serve un template.

**Il template e' il riaggancio gia' approvato**, `MARTA_REENGAGE_TEMPLATE_SID`:

> Ciao {{1}}, sono Marta di Fenice Academy: ci eravamo persi a meta' discorso 🙂 Se ti va
> riprendiamo da dove eravamo rimasti, altrimenti scrivimi NO e non ti disturbo piu'.

**Non le aperture standard.** L'apertura Telegram dice "l'accesso al canale Telegram ti
arriva via email a breve", ma queste persone **sono gia' nel canale** — e' da li' che
hanno preso il nostro numero. Quella del corso promette 10 ore gratuite che nessuno di
loro ha chiesto. Aprire con una cosa falsa verso gente che ci ha scritto e ha aspettato
cinque giorni non si fa, e non serve: il riaggancio non promette niente, e' gia'
approvato, e non ha tempi Meta.

**`app/api/cron/adotta-mai-risposti/route.ts`**, gemello di `riapri-mute` e con la stessa
forma collaudata:

- `POST { dal?: 'YYYY-MM-DD', esegui?: boolean, max?: number }`, auth `CRON_SECRET`.
- Candidati: conversazioni con `ai_owner IS NULL`, almeno un messaggio in ingresso, **zero
  messaggi in uscita**, `wa_number` = numero Fenice, `handed_off_at` nullo, dal `dal`.
- `esegui: false` di default — prova a vuoto che conta e mostra cinque esempi, come
  `riapri-mute`. Nessun invio senza chiederlo.
- Per ognuno: adozione (le stesse colonne della Fase 2, provenienza da
  `funnelDaPrimoMessaggio`) e invio del riaggancio con `sendTemplateAndLog`.
- Tetto `max` (default 25, limite 100) e budget di 240s, come il gemello.
- `event_log` di tipo `adotta_mai_risposti` con contati, inviati, falliti.

Non va in `vercel.json`: e' una rotta manuale, si lancia a mano come `riapri-mute`. Con
l'adozione accesa la sua lista deve restare vuota — e ricontrollarla ogni tanto e' il modo
per accorgersi se l'adozione ha smesso di funzionare.

**Fuori fascia non parte.** Il riaggancio rispetta `inSendWindow` (08:30–20:30
Europe/Rome) come tutto il resto.

---

## Verifiche prima di accendere

1. **Categoria del riaggancio.** Se `UTILITY_ONLY` e' attivo in produzione, il SID deve
   essere UTILITY oppure stare in `UTILITY_ONLY_ALLOW`. In locale le env sono oscurate: il
   controllo si fa sull'ambiente vero, con `assertTemplateSendable`. E' l'errore del
   24/08 — template in env e mai in allow-list, 27 lead muti per quattro giorni.
2. **Prova a vuoto della Fase 5** (`esegui: false`) e confronto: deve trovare 29
   candidati, non 43 e non 2.680.
3. **Un lead vero.** Si accende l'adozione, si scrive dal proprio telefono al numero
   Fenice, si verifica: risposta in meno di un minuto, dichiarazione IA nella prima riga,
   `ai_owner='mario'`, `crm_funnel='INBOUND'`, riga in `lead-entranti`.
4. **La collisione.** Sullo stesso lead di prova si manda l'intake: deve rispondere
   `apertura: 'saltata_chat_in_corso'` e **non** deve arrivare nessun template.
5. `bun run test` verde su tutta la suite, non solo sui file nuovi.

## Cosa non e' in questo piano

- **La qualita' del numero.** Il numero Fenice e' a LOW (consegna 98.9%, letture 77.9%:
  si sta pagando giugno, non il presente). L'adozione non aggiunge nessun template, quindi
  non peggiora niente. I 29 riaggancio sono 29 template, poco ma non zero.
- **Un template dedicato di scusa** per chi ha insistito (`7276`, `7318`, `8977`, `7266`,
  `7330`, `8918` hanno scritto due-cinque volte nel vuoto). Piu' onesto del riaggancio,
  ma sono tempi Meta su un numero in riabilitazione. Se il riaggancio rende male, e'
  la prima cosa da riprendere.
- **Il secondo numero.** Niente in questo piano cambia il routing dei mittenti.
