# Il bot sposta la call dei lead GDO (28/10/2026)

Decisione del PO (Bruno), 28/10/2026. Cambia la regola del 25/09 ("il bot non sposta mai
una call", commit 1ab0f3d) **solo sui lead dei GDO** (bot postino). Sulle call fissate dal
bot resta tutto com'è.

## Perché

- Lead GDO, nota "SPOSTAMENTO CHIESTO" con data: 18% confermati (8/45). Senza data: 4% (6/169).
- Le Conferme chiamano e il lead risponde «ho già spostato col bot».
- Fino al 25/09 il bot spostava le sue call: in media +1 giorno, presenze come gli altri.

## Cosa fa il bot

1. Il lead GDO chiede di spostare. Se lo spostamento si può fare, il prompt riceve un
   blocco in più (`notaSpostamentoPrompt`, in coda alla nota GDO). Tono deciso **solo lì**:
   «Avevi preso un impegno e la videochiamata era riservata a te. Si può spostare una volta
   sola: dimmi giorno e ora in cui sei sicuro di esserci.» Giorni ammessi: i prossimi 3
   lavorativi (domenica e giorni di chiusura esclusi), fascia 10-21. Le 9 non si propongono,
   si accettano se il lead insiste (regola ee66f23).
2. Quando il lead dà giorno e ora validi il modello scrive solo `[SPOSTA|<ISO con fuso>]`.
3. Il codice verifica la data (`motivoDataNonValida`), poi chiama il CRM
   (`POST /api/bot/outcome`, esito `SPOSTAMENTO`, contratto v1.9).
4. Sì del CRM: il lead riceve una bolla scritta dal codice (`testoSpostamentoFatto`): data
   nuova, "si può spostare una volta sola", quando chiama Noemi (regola
   `lib/noemi-quando.ts`, fissata adesso), e se il video non risulta visto «Il video l'hai già
   visto? Se no, guardalo prima della videochiamata 👉 link». La chat prende la data nuova:
   `gdo_appuntamento_at`, `gdo_appuntamento_set_at` = adesso, `gdo_recap_for_at` (la conferma
   vale come recap "spostamento"), `cancel_requested_at` = null. Il promemoria T-24h si
   riapre da solo (dedup `gdo_reminder24_for_at` per data). Evento `gdo_spostamento_bot`.
5. No (data non valida, CRM 409, rete): testo `TESTO_SPOSTAMENTO_NON_FATTO` («ti chiama
   Noemi per confermare») e la nota "SPOSTAMENTO CHIESTO — … a <data>" di oggi (esito
   RICHIAMO sul canale solo-nota). Evento `gdo_spostamento_non_fatto` col motivo.
6. Lead vago o date lontane ("tra settimane", "non so"): nessun tag SPOSTA, comportamento
   di oggi (Noemi + `[ESITO:RICHIAMO|...]`).

## Quando il blocco NON entra nel prompt (`motivoNonSpostabile`)

Interruttore spento; non postino; call fissata dal bot (`bot_outcome = APPUNTAMENTO`);
nessuna data; call fra meno di 30 minuti o passata (per le passate resta il rifissaggio
del 20/10); già spostato una volta (evento `gdo_spostamento_bot` sulla chat); lo stato CRM
locale dice confermato/scartato/da_rifissare, presentato o esito venditore.

## Lato CRM (`src/lib/bot-fissatore/spostamentoGdo.ts`)

Il CRM ricontrolla tutto e decide: lead di un GDO umano passato dal bot, `APPOINTMENT` con
call futura, nessun esito Conferme (confermato = venditore in calendario, incidente del
25/09), non parcheggiato, non presentato, mai spostato dal bot, data nei prossimi 3 giorni
lavorativi fra 9:00 e 21:00. Scrive `appointmentDate`, `appointmentMovedAt`, `version+1`,
`updatedAt`, evento `BOT_APPOINTMENT_RESCHEDULED` (trigger `bot_sposta_gdo`), `BOT_NOTE`
"Spostato dal bot: da … a …" e notifica le Conferme. Non tocca i canali Realtime e non
richiama `/api/appointment-set`.

## Interruttore

`GDO_SPOSTAMENTO_BOT_ENABLED`: acceso di default (funzione approvata), `0` lo spegne. Spento,
il bot torna esattamente al comportamento del 25/09.

## Non cambia

Riscaldamento (gdo-warmup), le 9 solo in emergenza, il tono del resto del bot, le regole
intoccabili, il comportamento sulle call fissate dal bot.
