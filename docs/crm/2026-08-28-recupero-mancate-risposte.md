# Specifica: recuperare i lead che non rispondono alle Conferme

*Bozza per il team CRM. Non è stata mandata a nessuno.*

---

## Perché questa cosa viene prima di tutte le altre

Lo scarto per **"3 NR consecutivi"** vale il **42% degli appuntamenti fissati dal bot** e il
**44% di quelli fissati dai GDO**: circa **1.288 appuntamenti persi dal 24 giugno**. È il
collo di bottiglia più grande che abbiamo tutti e due, e non dipende da chi fissa.

La differenza è che sui lead passati dal bot esiste **una chat WhatsApp aperta**. Il lead
non risponde al telefono, ma il messaggio lo legge: negli ultimi sette giorni il 98,5% dei
nostri messaggi è stato consegnato e il 77,6% letto.

L'idea è semplice: **quando la Conferma non riesce a parlargli, glielo scriviamo.**

---

## 1. Cosa ci serve da voi

Una chiamata verso di noi **nell'istante in cui la Conferma registra il mancato
contatto** — stessa forma dell'invio automatico dell'agenda che già usate.

```
POST https://web-app-messaggistica.vercel.app/api/bot/call-attempt
x-bot-signature: sha256=<hmac del body grezzo, stesso BOT_WEBHOOK_SECRET>
Content-Type: application/json

{
  "leadId": "…",
  "esito": "no_answer",
  "tentativo": 1,                              // 1 oppure 3
  "at": "2026-08-28T15:40:00+02:00",           // quando avete provato a chiamare
  "appointmentAt": "2026-08-29T15:00:00+02:00" // data e ora della call
}
```

Rispondiamo `200 { ok: true, inviato: true | false, motivo?: "…" }`. Se `inviato` è
`false` il motivo dice perché il bot si è fermato (vedi il punto 4): non è un errore,
è la risposta giusta in quei casi.

La chiamata è **idempotente su `leadId` + `tentativo`**: un doppio clic non manda due
messaggi.

**`appointmentAt` è la cosa che fa la differenza.** Il messaggio cita giorno e ora della
call ("la call di domani alle 15"): è quello che fa capire al lead di cosa stiamo
parlando. Senza, il messaggio diventa generico e recupera molto meno.

**Il momento conta.** Il messaggio deve partire entro pochi minuti dalla chiamata persa,
quando il lead ha ancora la chiamata non risposta sul telefono. Non un giro notturno.

---

## 2. Cosa facciamo noi

Due strade, decise dalla finestra di 24 ore di WhatsApp — che si apre sull'**ultimo
messaggio scritto dal lead**, non sul nostro:

| | quando | cosa parte |
|---|---|---|
| **dentro le 24h** | 79% dei casi | Marta scrive un messaggio **libero**, costruito sulla conversazione che c'è già |
| **fuori dalle 24h** | 21% dei casi | parte un **template approvato da Meta** |

Il 79/21 non è una stima: l'abbiamo calcolato sui 371 appuntamenti fissati dal bot
usando **i vostri orari di chiamata** — il pomeriggio stesso (13-20) per gli appuntamenti
del pomeriggio, il pomeriggio prima per quelli della mattina.

I due template li facciamo approvare noi come **UTILITY**: sono messaggi transazionali su
un appuntamento che esiste, quindi passano anche con il nostro numero ancora in
riabilitazione.

### I testi dei template

**Dopo il primo tentativo:**

> Ciao {{1}}, ti abbiamo appena chiamato per la call di {{2}} con Noemi: sono 5 minuti
> per sistemare gli ultimi dettagli e mandarti il link per collegarti. Quando ti va bene
> che ti richiamiamo?

**Dopo il terzo tentativo:**

> Ciao {{1}}, abbiamo provato a chiamarti tre volte per la call di {{2}} con Noemi e non
> siamo riusciti a sentirti. Se la vuoi ancora scrivimi qui, bastano due righe e la
> confermiamo: sono 5 minuti al telefono. Senza una tua risposta l'appuntamento lo
> annulliamo.

Il secondo dice le cose come stanno: senza una risposta esplicita l'appuntamento salta.
Non è una minaccia, è l'informazione che gli serve per decidere, e gli lascia una strada
per dire di sì in due righe.

Dentro la finestra Marta dice le stesse cose con parole sue, agganciandosi a com'era
andata la conversazione.

---

## 3. Il messaggio dopo il terzo tentativo cambia il conto

Oggi al terzo NR il lead viene scartato e finisce lì: sono **138 lead scartati così sui
soli appuntamenti del bot**, e oltre mille contando anche i vostri. Sono persone che
avevano detto di sì a una call e che nessuno ha più sentito.

Con questo messaggio quella porta resta aperta un'ultima volta, e la risposta arriva a
noi in chat invece che al centralino.

---

## 4. Quando il bot NON scrive, anche se premete il tasto

Questa è la parte da blindare, perché è dove si fanno i pasticci. Sono **quattro
condizioni secche e verificabili**, non un giudizio del modello:

1. il lead ha **chiesto di disdire o spostare** (ce l'abbiamo già registrato);
2. la chat è **già passata a una persona** ed è ancora lì;
3. il lead **ha già risposto** dopo l'orario della chiamata persa — non c'è niente da
   recuperare;
4. l'appuntamento è **già passato o annullato**.

Oggi le prime due valgono 13 lead su 371 (3,5%): pochi, ma sono esattamente quelli su cui
un messaggio sbagliato fa danno.

Una scelta deliberata: **non chiediamo al modello di capire se il lead "non è più
interessato"**. Riconoscerlo dalle parole della chat vuol dire sbagliare qualche volta, e
qui sbagliare significa scrivere a chi ci aveva chiesto di smettere. Accettiamo di
mandare qualche messaggio in più piuttosto che dare al modello un potere di veto che può
sbagliare.

---

## 5. La sezione per le Conferme

Oggi quando un lead chiede di parlare con una persona la richiesta finisce in coda per un
**GDO**. È sbagliato quando quel lead **ha già un appuntamento**: da quel momento è di
competenza delle **Conferme**, non di chi fissa. Oggi sono **13 richieste su 66 (20%)**.

Quello che serve:

- una **sezione nei profili Conferme**, con un **pallino rosso per ogni nuova notifica**
  non ancora vista;
- ci finiscono i lead già fissati che: chiedono di **parlare con una persona**, dicono che
  **aspettano la call**, chiedono di **essere richiamati**, oppure chiedono di **disdire o
  spostare**;
- da parte nostra vi marchiamo la notifica con **"già fissato" e la data della call**,
  così potete instradarla senza doverla cercare.

Questa sezione serve anche al punto 4.3: se il lead viene ricontattato davvero da una
Conferma, la richiesta si chiude e il bot non ci scrive sopra.

---

## 6. In sintesi, cosa serve da voi

1. La chiamata `/api/bot/call-attempt` al primo e al terzo mancato contatto, con
   `appointmentAt`.
2. La sezione Conferme con il pallino rosso, e l'instradamento a Conferme (non ai GDO)
   dei lead già fissati.
