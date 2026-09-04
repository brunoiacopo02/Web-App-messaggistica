# Lead che scrivono per primi su WhatsApp — cosa serve dal CRM

04/09/2026 · lato bot il lavoro è pronto, spento dietro un interruttore in attesa della
vostra risposta.

## Il problema, coi numeri

Dal 26 agosto al 4 settembre, **43 persone hanno aperto loro una chat** sul numero Fenice
(+39 352 041 3199) con questa frase, identica parola per parola:

> "Buongiorno, sono nel canale Telegram e mi hanno indicato questo contatto per più
> informazioni su Fenice Academy"

È un link precompilato che gira nel canale Telegram: il lead lo tocca e il messaggio parte
già scritto.

**29 di quelle 43 persone non hanno mai ricevuto risposta.** Zero messaggi in uscita.
Silenzio mediano di 113 ore, il più lungo 212. Sei di loro hanno scritto di nuovo nel
vuoto: *"Hei!!! Tutor. Quando possiamo parlare?"*, *"Scusa poi risponde"*, *"Piacere sono
Monia, nello specifico di cosa vi occupate?"*.

Il motivo è nostro e ve lo diciamo per intero: **il bot risponde solo ai lead che ci
mandate voi con l'intake.** Quelle 14 su 43 che una risposta l'hanno avuta sono
esattamente quelle che voi avevate registrato in parallelo — il vostro intake è arrivato
quasi in contemporanea al messaggio del lead, e da lì il bot è partito. Le altre 29 nel
vostro CRM non sono mai esistite, quindi per il bot non avevano un padrone.

**Quanto vale.** Le 14 lavorate hanno prodotto **4 appuntamenti**, il 29% — sopra la nostra
media. Alla stessa resa, le 29 mute valgono circa **8 appuntamenti persi in nove giorni**.
E il flusso sta accelerando: 23 aperture in tutto agosto, 20 nei primi quattro giorni di
settembre.

## Cosa cambiamo noi

Da quando accendiamo, **il bot risponde a chiunque scriva per primo** sul numero Fenice e
non sia già di qualcun altro. Nessun template: il lead ha aperto lui la finestra 24h,
quindi si risponde a testo libero, in secondi. La prima risposta si presenta come
assistente digitale di Fenice Academy, come le aperture dichiarate (AI Act art. 50).

Due cose per voi, entrambe già gestite dal nostro lato:

- **Non vi arrivano doppioni.** Se un lead sta già parlando col bot e poi arriva il vostro
  intake, l'apertura "Ciao, sono Marta..." **non parte** sopra la conversazione in corso.
  Vi rispondiamo `accettato: true, apertura: "saltata_chat_in_corso"`: il lead è preso in
  carico, non è muto.
- **I 29 fermi li riprendiamo noi**, con il template di riaggancio già approvato.

## Cosa serve da voi

Una cosa sola, ed è l'unica che non possiamo fare da soli: **un lead che scrive per primo
nel vostro CRM non esiste, quindi non ha un `leadId`.** Senza quel numero il nostro
`POST /api/bot/outcome` non ha dove consegnare — il bot può fissargli un appuntamento e
quell'appuntamento non arriva da nessuna parte.

Vi esponiamo la lista. La leggete, create i lead da parte vostra, e ce li rimandate con
l'intake normale: da lì in poi `crm_lead_id` è pieno e **tutto il resto funziona col
codice che c'è già** — esiti, note, appuntamenti, call-attempt. Nessun'altra modifica, né
da noi né da voi.

### Endpoint

```
POST https://web-app-messaggistica.vercel.app/api/bot/lead-entranti
```

Stessa autenticazione di `/api/bot/intake` e `/api/bot/contatti-umani`, che già usate:
header `x-bot-signature: sha256=<HMAC-SHA256 del corpo grezzo>` con il
`BOT_WEBHOOK_SECRET` concordato. Corpo, opzionale:

```json
{ "limit": 500 }
```

La lista è **tutti** i lead che stiamo lavorando e di cui voi non avete un `leadId`, dal
più vecchio. Non c'è un filtro di stato: anche uno già concluso dal bot vi serve, ed è
anzi quello che vi serve di più — se ha un appuntamento, lo vedete nel campo `esito`.

Il criterio esatto: conversazioni sul numero Fenice, con almeno un messaggio in ingresso,
senza `leadId` vostro, non passate a una persona. Chi è finito in mano a un umano da parte
nostra resta fuori: quella chat la sta già lavorando qualcuno, e un intake sopra ci
manderebbe a scriverle entrambi.

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
      "esito": null,
      "appuntamento": null
    }
  ]
}
```

- **`totale` e `totaleCompleto`** — `totale` è quanti lead ci sono in questa risposta,
  `totaleCompleto` quanti ce ne sono in tutto. Se il secondo è più grande del primo la
  lista è tagliata dal vostro `limit`: rifate la chiamata con un `limit` più alto.
- **`statoBot`** — dove sta la conversazione da parte nostra: `active` il bot ci sta parlando adesso, `replying` sta scrivendo la risposta in questo momento (è lo stesso di `active` per voi, ma in produzione restano righe ferme su quel valore e vi arriverebbero grezze), `closed` ha chiuso con un esito, `booked` ha fissato l'appuntamento, `handed_off` è passata a una persona. Sono i nostri stati interni e ve li diamo grezzi apposta: tradurli vorrebbe dire appiattire distinzioni che vi servono. Se ci fate uno switch sopra, tenete un ramo di default.
- **`provenienza`** — `"TELEGRAM"` per chi apre con la frase del canale, `"INBOUND"` per
  chiunque altro scriva spontaneamente. Non mettiamo tutti su Telegram: sulle vostre
  statistiche di funnel deve restare vero. Può contenere anche uno dei **vostri** nomi di
  funnel (`CORSO 10 ORE`, `JOB SIMULATOR`…): succede quando quella persona era già stata
  arruolata da un vostro intake in passato, e in quel caso il funnel è quello che ci
  avevate mandato voi.
- **`nome`** — quasi sempre `null`. Il messaggio è precompilato e non contiene il nome; a
  volte lo dicono nel secondo messaggio e allora ve lo passiamo.
- **`esito` e `appuntamento`** — valorizzati quando il bot ha già concluso prima che voi
  creaste il lead. Serve a farvi vedere subito che quella persona **ha già una call in
  agenda**, invece di scoprirlo al giro dopo.
- **Un lead esce dalla lista da solo** nel momento in cui il vostro intake ci manda il suo
  `leadId`. Non serve che ci diciate niente.

### Se preferite il contrario

Se per voi è più comodo ricevere invece che leggere, lo giriamo: ci date un vostro
endpoint e vi mandiamo il lead nel momento in cui il bot lo adotta. Il contenuto è lo
stesso. Abbiamo proposto la lista perché il client HMAC verso di noi lo avete già scritto
ad agosto per `contatti-umani`: per voi è un URL nuovo su codice esistente.

## Nel frattempo

Il bot risponde comunque — quello non dipende da voi, e ogni giorno di attesa sono lead
che restano zitti. Quello che aspetta il `leadId` è solo l'esito finale: finché non arriva,
resta da noi e lo vedete nel pannello, ma non entra nel vostro flusso automatico.

Ditecelo anche solo con un sì: accendiamo e vi mandiamo i primi numeri dopo una settimana.
