# Brief: invio agenda per conto dei GDO (`POST /send-agenda`)

Documento di consegna per una sessione pulita. Tutte le decisioni qui sotto sono già
state prese con Bruno il 28–29/07/2026: non vanno ridiscusse, vanno implementate.

## Il problema

Quando un GDO umano è al telefono con un lead, preme "Agenda" sul CRM Fenice. Oggi il
CRM passa per ActiveCampaign → Spoki, che **non consegna più**, e ActiveCampaign
risponde comunque "ok": il GDO vede l'invio riuscito mentre il lead non riceve nulla.
Negli ultimi 30 giorni: 2.881 invii su 1.608 lead distinti, quasi metà reinvii manuali
fatti dai GDO perché il lead al telefono dice di non aver ricevuto niente.

Il CRM ci chiede di fare noi da canale. **Il lead resta di proprietà del GDO**: il bot
fa il postino e poi gestisce la conversazione, ma non deve mai toccare lo stato del
lead né l'appuntamento già fissato.

## Il contratto con il CRM

`POST /send-agenda`, stessa firma HMAC già in uso su `/api/bot/intake`
(`x-bot-signature: sha256=...` su `BOT_WEBHOOK_SECRET`, vedi `lib/bot-hmac.ts`).

```json
{
  "leadId": "uuid-del-lead-nel-crm",
  "name": "Mario Rossi",
  "phone": "333 123 4567",
  "email": "mario@esempio.it",
  "funnel": "Nome funnel",
  "companyId": "fenice",
  "variant": { "lavora": true, "haFamiglia": false, "offertaDelMese": false }
}
```

Il telefono arriva grezzo: la normalizzazione E.164 è nostra (`toE164` in `lib/phone.ts`).

### La risposta deve essere sincrona, a TRE stati

Il GDO è al telefono col lead mentre clicca. Non basta ok/errore:

| Esito | Significato | Il GDO può ritentare? |
|---|---|---|
| **consegnato** | Twilio riporta `delivered`/`read` entro ~8s | — |
| **inviato, non ancora consegnato** | accettato da Twilio ma nessun `delivered` entro 8s (telefono spento/offline) | **NO** — altrimenti quando il telefono torna online arriva doppio |
| **fallito** | numero non su WhatsApp, template bloccato, Twilio giù | sì |

Il secondo stato esiste perché un telefono offline non è un fallimento, ma il lead
comunque non può usare l'agenda: il GDO deve saperlo per non insistere.

Attesa massima 8 secondi, poi si risponde comunque. Il loro timeout è ~10s.

### Deduplicazione

Stesso `leadId` entro **15 minuti** → non si rimanda, si risponde con l'esito
precedente. Il blocco salta solo dopo un fallimento vero (terzo stato).

## Cosa manda il bot

Due messaggi separati.

1. **Agenda**, subito, via template approvato (il lead non ci ha mai scritto su
   WhatsApp: la finestra 24h è chiusa, quindi il testo libero non è possibile).
   Il messaggio chiede esplicitamente al lead di rispondere.
2. **Video**, dopo che il lead ha risposto. Qualunque risposta va bene, anche solo
   "ok": apre la finestra 24h e il video parte come **testo libero**, niente template.

Il link video dipende da `variant`, con `offertaDelMese` che prevale sulle altre due:

| variant | link |
|---|---|
| `offertaDelMese: true` (prevale) | `https://corso.feniceacademy.it/conferenza-black-summer` |
| lavora, senza famiglia | `https://corso.feniceacademy.it/conferenza-bx` |
| non lavora, senza famiglia | `https://corso.feniceacademy.it/conferenza-axmsbn9r50` |
| lavora, con famiglia | `https://corso.feniceacademy.it/conferenza-dx` |
| non lavora, con famiglia | `https://corso.feniceacademy.it/conferenza-ex` |

Il link Black Summer **va aggiunto alla whitelist** in `lib/outbound-sanitize.ts`,
altrimenti il bot lo tratta come link inventato dal modello e lo segnala.

## Le regole non negoziabili

1. **Niente nome del GDO.** Il messaggio dice "come ti ha detto il mio collega". Non
   serve nessun campo in più nel payload.
2. **Sui lead già nostri vince il GDO.** Succede spesso, perché il bot restituisce
   lead ai GDO. All'arrivo dell'agenda la conversazione bot si ferma: niente sequenza
   di riaggancio, niente follow-up "prenota", niente classificazione a 14 giorni. Se
   era `closed` con un esito, va riaperta in modalità postino.
3. **Solo NOTE verso il CRM.** Questi lead non sono nostri: `sendOutcome` oggi manda
   esiti che cambiano lo stato del lead e chiude la conversazione. Per i lead GDO
   serve un canale che mandi `outcome: 'NOTA'` senza toccare stato né appuntamento e
   **senza chiudere** la conversazione. Si lega al contratto `noteOnly` già in sospeso
   col CRM (vedi la memoria `project_bot_appuntamento_terminale`).
4. **Il follow-up agenda 2h va spento per questi lead.** `lib/agenda-followup.ts:16`
   si aggancia all'URL JotForm, che per i GDO è **lo stesso**: manderebbe "non ho
   ancora visto la conferma, vuoi che ti tenga uno slot?" a chi ha già prenotato col
   GDO durante la telefonata. È esattamente ciò che il CRM ci ha chiesto di evitare.
5. **Mario non deve ripartire col pitch.** Questi lead hanno già l'appuntamento. La
   sezione "SE L'APPUNTAMENTO È GIÀ FISSATO" in `lib/mario-prompt.ts` fa già il
   comportamento giusto: il lead va arruolato direttamente in quello stato.
6. **Il primo inbound è il turno del video.** Attenzione: su quel turno Mario
   genererebbe anche una sua risposta e il lead ne riceverebbe due. Il video deve
   *essere* la risposta a quel messaggio, non aggiungersi.

## Cosa esiste già

- `lib/bot-hmac.ts` — firma e verifica, riusabile così com'è
- `lib/bot-contract.ts` — `parseIntakePayload` è il modello da seguire per il nuovo payload
- `app/api/bot/intake/route.ts` — struttura di riferimento per il nuovo endpoint
- `lib/fenice-enroll.ts` — `enrollLeadIntoMario`, da estendere con la modalità postino
- `lib/messaging.ts` — `findOrCreateLeadConversation`, `sendTemplateAndLog`
- `lib/bot-outcome.ts` — `sendOutcome`, da estendere col canale solo-NOTA
- `lib/phone.ts` — `toE164`
- **Attenzione**: esiste già `app/api/send-agenda/route.ts`, ma è il vecchio flusso
  ActiveCampaign con auth a bearer token e template legacy fermo dal 19/06. Non è
  questo. Decidere se sostituirlo o affiancarlo su un path diverso.

## Template WhatsApp

Il template agenda è stato sottomesso due volte (la prima è rimasta impantanata):

- `fenice_agenda_gdo_v2` = `HX94bf89519dffd6f54e0d8aeb930b70ae`
- `fenice_agenda_gdo_v3` = `HX2ac49b476a02975072946976d2994a7c`

Usare quello approvato, in env come `AGENDA_GDO_TEMPLATE_SID`. Stato:
`node --env-file=.env.local scripts/....mjs` oppure via Content API.

Testo (v3):
> Ciao {{1}}, sono Marta di Fenice Academy 🙂 come ti ha detto il mio collega ti mando
> qui il link per scegliere giorno e ora della videocall 👉 https://form.jotform.com/240755654585063
> Rispondimi qui con un ok quando l'hai aperto, così ti mando il video da vedere prima della call

**Lezione dal campo**: i tempi di approvazione Meta non sono prevedibili — tre template
identici passati in 30 minuti, un quarto fermo oltre 17 ore. Se un template si impianta,
**risottometterne una copia identica** funziona meglio che aspettare. Chiedere sempre
UTILITY: i MARKETING pesano sul quality rating del numero e possono incontrare i limiti
per-utente di Meta. Bruno ha deciso che i template MARKETING non si usano.

## Vincoli operativi

- Mittente: `TWILIO_WHATSAPP_NUMBER_FENICE` = `whatsapp:+393520413199`, tier 10K
  clienti/24h, quality HIGH. I 250 invii/giorno previsti stanno al 2,5% del tetto.
- **In `.env.local` quella variabile vale letteralmente `[SENSITIVE]`**, un segnaposto:
  il valore vero sta solo su Vercel. Recuperarlo con `vercel env pull` (la CLI ora è
  installata), altrimenti ogni script locale fallisce con Twilio 21212.
- Fascia invii 08:30–20:30 Europe/Rome (`inSendWindow` in `lib/sequence.ts`). Ma qui il
  GDO è al telefono col lead: **l'invio agenda deve partire comunque**, anche fuori
  fascia. Da confermare con Bruno se non è già stato deciso.
- Con `Prefer: return=minimal` PostgREST risponde 201 con corpo vuoto: `r.json()`
  lancia. Trappola già costata un invio contato come fallito quando era riuscito.

## Test

Il repo è TDD-first: 456 test su 35 file, tutti verdi. Suite `npm test`, typecheck
`./node_modules/.bin/tsc --noEmit` (NON `npx tsc`, prende il pacchetto sbagliato).
Ogni funzione pura va testata prima di essere implementata.

## Cosa serve dal CRM prima del go-live

Non dipende da noi, ma senza queste cose il sistema non parte:

- conferma dei **tre stati di consegna** (tocca la UI che vede il GDO)
- conferma della finestra **dedup di 15 minuti**
- **`BOT_WEBHOOK_SECRET`** concordato — in sospeso dall'integrazione di giugno
- permesso lato loro perché `/api/bot/outcome` accetti NOTE su lead non assegnati al bot
- istruzione ai GDO: dire al lead **di rispondere al messaggio**, perché senza risposta
  la finestra 24h resta chiusa e il video non parte
