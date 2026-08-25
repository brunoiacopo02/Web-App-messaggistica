# Lead che chiedono di parlare con una persona — cosa serve dal CRM

25/08/2026 · lato bot è tutto pronto e in produzione.

## Il problema

Quando un lead scrive che vuole parlare con una persona, il bot smette di rispondere e
vi manda subito un `CONTATTO_UMANO` con le parole del lead. Quella è una **notifica**:
arriva una volta e, se in quel momento non la vede nessuno, il lead resta fermo.

Oggi ce ne sono **43** in attesa. La più vecchia è del **27 luglio**: "Mi puoi
chiamare". Nessuno di questi lead è stato assegnato a un operatore.

## Cosa vi serve

Una sezione in cui l'admin veda questi lead e li assegni. I dati ve li diamo noi.

### Endpoint

```
POST https://web-app-messaggistica.vercel.app/api/bot/contatti-umani
```

Stessa autenticazione di `/api/bot/intake`, che già usate: header
`x-bot-signature: sha256=<HMAC-SHA256 del corpo grezzo>` con il `BOT_WEBHOOK_SECRET`
concordato. Corpo (tutti i campi opzionali):

```json
{ "stato": "aperti", "limit": 500 }
```

- `stato: "aperti"` (predefinito) — solo chi non è ancora stato chiuso da parte nostra.
- `stato: "tutti"` — include anche i già esitati, per riconciliare.

### Risposta

```json
{
  "ok": true,
  "count": 43,
  "troncato": false,
  "lead": [
    {
      "leadId": "b8c2c36b-d5f9-4327-8ef2-53bacbbebae6",
      "conversationId": 3319,
      "phone": "+393486935915",
      "nome": "Giuseppe Sorrentino",
      "richiestoIl": "2026-07-27T06:32:11.000Z",
      "motivo": "vuole_essere_chiamato",
      "motivoRegistrato": true,
      "paroleDelLead": "Mi puoi chiamare",
      "ultimiMessaggi": [
        { "quando": "2026-07-27T06:30:02.000Z", "testo": "..." }
      ],
      "ultimoMessaggioIl": "2026-07-27T06:40:00.000Z",
      "esitoBot": null
    }
  ]
}
```

L'elenco è **ordinato per attesa**: prima chi aspetta da più tempo. È l'ordine in cui
andrebbero assegnati.

### I campi che contano

| campo | a cosa serve |
|---|---|
| `leadId` | il vostro id: è la chiave con cui agganciate il lead nel CRM |
| `richiestoIl` | da quando aspetta — la colonna su cui ordinare la lista |
| `motivo` | categoria, per filtrare e smistare |
| `paroleDelLead` | **quello che ha scritto davvero**: mostratelo sempre, è la verità |
| `ultimiMessaggi` | gli ultimi tre messaggi suoi, il contesto per chi richiama |
| `motivoRegistrato` | `true` = registrato al momento del passaggio; `false` = ricostruito dalla chat, quindi meno affidabile |

`motivo` è uno di questi sette valori, e non ne arriveranno altri:

`vuole_essere_chiamato` · `chiede_una_persona` · `disdetta_o_spostamento` ·
`problema_prenotazione` · `prezzo_o_pagamento` · `lamentela` · `altro`

La categoria è calcolata a regole sulle parole del lead, non è un riassunto scritto da
un modello: preferiamo un `altro` onesto a un "vuole disdire" inventato che manda
l'operatore alla telefonata sbagliata. **Le parole del lead vanno mostrate sempre.**

## Come lo usereste

1. Un lavoro periodico (ogni 10-15 minuti basta) chiama l'endpoint e allinea la
   sezione "da assegnare".
2. L'admin vede l'elenco ordinato per attesa, con nome, telefono, motivo e parole.
3. Assegna a un operatore; da lì in poi il lead è vostro.

Il bot su queste chat **non scrive più**: le lascia alla persona. Se poi chiudete il
lead da parte vostra, sparisce da `stato: "aperti"`.

## Due cose da decidere insieme

1. **I 43 arretrati.** Possiamo rimandarvi le segnalazioni `CONTATTO_UMANO` una per
   una, così arrivano sui vostri canali di notifica come se fossero appena successe. Se
   invece vi bastano dall'endpoint, non mandiamo niente: ditecelo voi. (Il vostro CRM
   sopprime i doppioni entro le 24h, quindi in ogni caso non fa danni.)

2. **Chi chiude i lead GDO "postino".** Sono 735 conversazioni in cui il bot fa solo da
   corriere per l'appuntamento del GDO: per scelta non le classifica e non le chiude
   mai. Da parte vostra sono indistinguibili da lead abbandonati — 477 hanno più di 12
   giorni. Non è un problema di software: è da decidere chi le chiude e con che esito.
