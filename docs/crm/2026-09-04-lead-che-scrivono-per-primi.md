# Lead che scrivono per primi su WhatsApp — cosa serve dal lato CRM

Per il terminale che lavora sul repo CRM. Lato messaggistica il lavoro è finito, testato e
fermo su un branch (`feat/lead-scrivono-per-primi`), spento dietro
`INBOUND_ADOPTION_ENABLED`.

## Il problema, coi numeri

Dal 26 agosto al 4 settembre 43 persone hanno aperto loro una chat sul numero Fenice
(+39 352 041 3199) con questa frase, identica parola per parola:

> "Buongiorno, sono nel canale Telegram e mi hanno indicato questo contatto per più
> informazioni su Fenice Academy"

È un link `wa.me` precompilato che gira nel canale Telegram: il lead lo tocca e il
messaggio parte già scritto.

**29 di quelle 43 non hanno mai ricevuto risposta.** Zero messaggi in uscita, silenzio
mediano di 113 ore, il più lungo 212. Sei hanno riscritto nel vuoto: *"Hei!!! Tutor.
Quando possiamo parlare?"*, *"Scusa poi risponde"*, *"Piacere sono Monia, nello specifico
di cosa vi occupate?"*.

La causa sta tutta da questo lato: il bot risponde solo se `ai_owner = 'mario'`, e quella
colonna la scrive **soltanto** l'intake. Le 14 che una risposta l'hanno avuta sono quelle
che il CRM aveva registrato in parallelo, con l'intake arrivato quasi in contemporanea al
messaggio del lead. Le altre 29 nel CRM non sono mai esistite, quindi per il bot non
avevano un padrone.

**Resa:** le 14 lavorate hanno prodotto 4 appuntamenti, il 29%. Alla stessa resa le 29
mute valgono circa 8 appuntamenti persi in nove giorni. E il flusso accelera: 23 aperture
in tutto agosto, 20 nei primi quattro giorni di settembre.

## Cosa cambia lato messaggistica

Il bot prende in carico chiunque scriva per primo sul numero Fenice e non sia già di
qualcun altro. Nessun template: il lead ha aperto lui la finestra 24h, quindi si risponde
a testo libero, in secondi. La prima risposta si presenta come assistente digitale di
Fenice Academy (AI Act art. 50).

Due cose che toccano il lato CRM, entrambe già chiuse qui:

- **Niente doppioni.** Se un lead sta già parlando col bot e poi arriva l'intake,
  l'apertura "Ciao, sono Marta…" **non parte** sopra la conversazione in corso. La risposta
  diventa `accettato: true, apertura: "saltata_chat_in_corso"`: il lead è preso in carico,
  non è muto. È la distinzione che il 29/08 aveva spiegato i "lead fermi al bot".
- **I 29 fermi li riprende questo lato**, col template di riaggancio già approvato, da una
  rotta manuale che di default conta e basta.

## Cosa serve dal lato CRM

Una cosa sola, e da qui non è risolvibile: **un lead che scrive per primo nel CRM non
esiste, quindi non ha un `leadId`.** Senza quel valore `POST /api/bot/outcome` non ha dove
consegnare — il bot può fissargli un appuntamento e quell'appuntamento non arriva da
nessuna parte.

La lista sta nell'endpoint qui sotto. Va letta, i lead vanno creati lato CRM e rimandati
con l'intake normale: da lì `crm_lead_id` si riempie e **tutto il resto funziona col
codice che c'è già** — esiti, note, appuntamenti, call-attempt. Nessun'altra modifica, né
di qua né di là.

### Endpoint

```
POST https://web-app-messaggistica.vercel.app/api/bot/lead-entranti
```

Stessa autenticazione di `/api/bot/intake` e `/api/bot/contatti-umani`: header
`x-bot-signature: sha256=<HMAC-SHA256 del corpo grezzo>` con `BOT_WEBHOOK_SECRET`. Il
client HMAC lato CRM esiste già da agosto per `contatti-umani`, cambia solo l'URL.

Corpo, opzionale:

```json
{ "limit": 500 }
```

Il criterio della lista: preso in carico dal bot, **senza `crm_lead_id`**, sul numero
Fenice, con almeno un messaggio in ingresso, non passato a una persona. Ordine dal più
vecchio. Nessun filtro di stato: serve anche un lead già concluso dal bot, ed è anzi
quello che serve di più.

### Risposta

```json
{
  "ok": true,
  "totale": 29,
  "totaleCompleto": 29,
  "lead": [
    {
      "telefono": "+393200431888",
      "nome": null,
      "provenienza": "TELEGRAM",
      "primoMessaggio": "Buongiorno, sono nel canale Telegram e mi hanno indicato questo contatto per più informazioni su Fenice Academy",
      "scrittoIl": "2026-08-26T21:51:52+02:00",
      "conversationId": 7246,
      "statoBot": "active",
      "botHaRisposto": true,
      "esito": null,
      "appuntamento": null
    }
  ]
}
```

I campi che meritano una nota:

- **`totale` e `totaleCompleto`** — il primo è quanti lead ci sono in questa risposta, il
  secondo quanti ce ne sono in tutto. Se il secondo è più grande, la lista è tagliata dal
  `limit`: rifare la chiamata con un valore più alto.
- **`statoBot`** — dove sta la conversazione da questo lato: `active` il bot ci sta
  parlando, `replying` sta scrivendo in questo istante (per il CRM è come `active`, ma in
  produzione restano righe ferme su quel valore e arriverebbero grezze), `closed` ha chiuso
  con un esito, `booked` ha fissato l'appuntamento. `handed_off` non compare: le chat
  passate a una persona sono escluse dalla lista. Sono stati interni e arrivano grezzi
  apposta — tradurli appiattirebbe distinzioni che servono. Se ci si fa uno switch sopra,
  tenere un ramo di default.
- **`provenienza`** — `"TELEGRAM"` per chi apre con la frase del canale, `"INBOUND"` per
  chiunque altro scriva spontaneamente. Non finiscono tutti su Telegram: sulle statistiche
  di funnel deve restare vero. Può contenere anche un funnel del CRM (`CORSO 10 ORE`,
  `JOB SIMULATOR`…) quando quella persona era già stata arruolata da un intake in passato.
- **`nome`** — quasi sempre `null`: il messaggio precompilato non lo contiene. A volte
  arriva nel secondo messaggio, e allora c'è.
- **`esito` e `appuntamento`** — valorizzati quando il bot ha già concluso prima che il
  lead esistesse nel CRM: servono a sapere subito che quella persona **ha già una call in
  agenda**, invece di scoprirlo al giro dopo. `appuntamento` è valorizzato **solo** se
  `esito` è `APPUNTAMENTO`: la data di un RICHIAMO non passa di qui, o arriverebbe alle
  Conferme come una call che non esiste.
- **`botHaRisposto`** — falso quando il bot ha preso in carico il lead ma **non gli ha
  ancora scritto**. Su questi non va mandato un intake: la guardia che salta l'apertura
  pretende un messaggio gia' partito, quindi in quella finestra l'apertura "Ciao, sono
  Marta..." cadrebbe sopra un lead che aspetta ancora la risposta alla sua domanda. Di
  norma la finestra dura qualche decina di secondi — il ritardo umano della risposta piu'
  la chiamata al modello — ma se il bot va giu' (Anthropic irraggiungibile, credito a
  zero) non si chiude da sola. Aspettare che diventi vero costa un giro di lista.
- **Un lead esce dalla lista da solo** quando l'intake manda il suo `leadId`. Non serve
  dire niente.

### Se conviene il verso opposto

Se lato CRM è più comodo ricevere che leggere, si gira: basta un endpoint là e il lead
parte da qui nel momento in cui il bot lo adotta, con lo stesso contenuto. La lista è
proposta solo perché il client HMAC verso questo lato esiste già.

## Due punti aperti, da decidere insieme

**1. `booked` e la guardia sull'apertura.** Oggi, se arriva un intake su una chat che ha
già l'appuntamento fissato, l'apertura parte lo stesso. È il comportamento precedente a
questo branch e il rifissaggio del contratto v1.5 ci si appoggia. Estenderla anche a
`booked` è una riga, ma cambia chi viene toccato: va deciso, non fatto di iniziativa.

**2. Il testo del riaggancio per i 29.** Il template dice *"ci eravamo persi a metà
discorso"*, ma con queste persone un discorso non c'è mai stato: hanno scritto loro e non
ha risposto nessuno. È già approvato e non promette niente di falso — a differenza delle
aperture standard, che promettono l'accesso al canale Telegram a gente che nel canale c'è
già, o 10 ore gratuite che nessuno ha chiesto. Resta però una frase imprecisa.
L'alternativa è un template dedicato di scuse, coi tempi di approvazione Meta.

## Nel frattempo

Il bot risponde comunque: non dipende dal lato CRM, e ogni giorno di attesa sono lead che
restano zitti. Quello che aspetta il `leadId` è solo l'esito finale — finché non arriva
resta da questo lato, visibile nel pannello e in questa lista, ma non entra nel flusso
automatico del CRM.
