# Teste nota stabili — report

Branch `fix/teste-nota-stabili`, worktree `Software-Messaggistica-comportamento`.

## Criterio applicato

Nella testa di una nota (prima del primo `". "`, o prima di `motivo:` se compare) può
starci solo ciò che identifica IL FATTO. Se quel dato viene dal nostro DB (data in
agenda, esito precedente, motivo tipizzato) è stabile per costruzione: resta. Se è un
orario "di quando è successa la cosa" o qualunque valore calcolato al momento
dell'invio (`new Date()`), due invii dello stesso fatto lo producono diverso: va in
coda. Eccezione esplicita: la data che il LEAD ha chiesto in uno spostamento identifica
il fatto stesso (martedì ≠ mercoledì) e resta in testa anche se "cambia" — perché lì un
cambio è davvero un fatto diverso, non lo stesso fatto raccontato due volte.

## Due difetti misurati, due fix

### 1. `buildBotRipresoNote` — orario di invio in testa

Prima: `IL BOT HA RIPRESO LA CHAT — il lead ha riscritto ${orario}, dopo che ve lo
avevamo restituito come ${esito}.` L'orario (`new Date().toISOString()` calcolato al
momento dell'invio) stava prima del primo punto. Due invii dello stesso fatto a
30-101 secondi di distanza producevano minuti diversi → chiavi diverse → 122 note su
152 non riconosciute come re-invio.

Dopo: l'esito precedente (stabile, è lo stesso per i due invii) resta in testa da solo;
l'orario si è spostato in coda, dopo il primo punto.

```
IL BOT HA RIPRESO LA CHAT — il lead ha riscritto dopo che ve lo avevamo restituito
come DA_SCARTARE. Ha riscritto sabato 5 settembre alle 11:26. Non chiamatelo a mano
finché non vi arriva un nuovo esito dal bot.
```

Chiave CRM (`crmDedupKey`): `IL BOT HA RIPRESO LA CHAT — il lead ha riscritto dopo che
ve lo avevamo restituito come DA_SCARTARE` — identica a qualunque orario di invio.

### 2. `buildLockedNote` — stesso fatto raccontato con due formulazioni dal ramo `RICHIAMO` e dal ramo `APPUNTAMENTO`

Segnalato a lavoro in corso dal coordinatore, sui dati CRM: lo stesso spostamento, con
la stessa data, usciva come `... alla data indicata (martedì 18 agosto alle 19:00)` dal
ramo `RICHIAMO` e come `... a martedì 18 agosto alle 19:00` dal ramo `APPUNTAMENTO` — il
modello può emettere l'uno o l'altro esito per la stessa richiesta a un turno di
distanza (84 secondi nei campioni). Due stringhe diverse per lo stesso fatto = due
chiavi = doppia campanella (5 lead APPUNTAMENTO colpiti).

Fix: nuovo costruttore condiviso `buildSpostamentoChiestoNote(leadDateIso, inAgenda)`,
usato da entrambi i rami. Tenuta la forma breve (`APPUNTAMENTO`, "ha chiesto di
spostare a ..."), indicata dal CRM come quella corretta. Anche la coda ("In agenda
resta X: mantenuto finché non lo spostate voi." / "Appuntamento mantenuto: da spostare
voi.") è ora la stessa funzione per entrambi i rami, quando l'informazione disponibile
(`inAgenda`) è la stessa. Il caso "nessuna nuova data indicata dal lead" resta una
stringa distinta (fatto diverso, prodotto solo dal ramo `RICHIAMO`) e non è stato
toccato. La data richiesta dal lead resta in testa in entrambi i rami: identifica il
fatto.

```
SPOSTAMENTO CHIESTO — il lead ha chiesto di spostare a martedì 18 agosto alle 19:00.
In agenda resta [data]: mantenuto finché non lo spostate voi.
```

uguale bit per bit da qualunque ramo arrivi (`RICHIAMO` o `APPUNTAMENTO`), quindi
stessa `crmDedupKey`.

## Tutte le teste esaminate

| Funzione | Cosa sta in testa | Da dove viene | Decisione |
|---|---|---|---|
| `buildBotRipresoNote` | orario di quando il lead ha riscritto | `new Date()` al momento dell'invio | **Spostato in coda** (difetto 1, fix sopra) |
| `buildLockedNote` — `DA_SCARTARE` | `appuntamento di <data in agenda> da annullare` | `existingDate`, colonna DB | Stabile, lasciata (uso di "Causa:" non "Motivo:" già protegge la chiave dal motivo di scarto, che cambia — difesa preesistente, non toccata) |
| `buildLockedNote` — `INTERROTTO` | "il lead ha smesso di rispondere dopo il fissaggio" (nessun dato variabile) | testo fisso | Stabile, lasciata; `inAgenda` è già in coda |
| `buildLockedNote` — `RICHIAMO` **e** `APPUNTAMENTO` (ramo spostamento) | data chiesta dal lead | tag del modello, IDENTIFICA il fatto | **Lasciata in testa** (per design, va così) — ma **unificata** fra i due rami (difetto 2, fix sopra) perché la STESSA data usciva con due formulazioni diverse a seconda del ramo |
| `buildLockedNote` — `RICHIAMO`/`APPUNTAMENTO` senza nuova data | "nessuna nuova data indicata dal lead" (nessun dato variabile) | testo fisso | Stabile, lasciata (fatto distinto da quello con data, di proposito) |
| `buildLockedNote` — `NON_RISPOSTO` | "nessun riscontro dopo il fissaggio" (nessun dato variabile) | testo fisso | Stabile, lasciata; `inAgenda` in coda |
| `buildLockedNote` — `APPUNTAMENTO` (ramo riconferma) | "il lead ha riconfermato l'appuntamento di \<data in agenda\>" | `existingDate`, colonna DB | Stabile, lasciata: la data identifica QUALE appuntamento è stato riconfermato ed è sempre la stessa per lo stesso appuntamento |
| `buildLockedNote` — `NOTA`/`CONTATTO_UMANO` (ramo morto, per esaustività switch) | "appuntamento mantenuto: \<data in agenda\>" | `existingDate`, colonna DB | Stabile, lasciata; ramo irraggiungibile in pratica |
| `buildAppuntamentoNonFissabileNote` — con appuntamento in agenda | "in agenda resta \<data\>, e non è stato spostato niente" | `appuntamentoInAgenda`, colonna DB | Stabile, lasciata (il commento nel codice lo spiega già: la data RICHIESTA dal lead sta apposta dopo il primo punto) |
| `buildAppuntamentoNonFissabileNote` — senza appuntamento in agenda | motivo tipizzato (`domenica`, `fuori_fascia`, ...) via `DETTAGLIO_APPUNTAMENTO` | enum fisso, non un istante | Stabile, lasciata; la data richiesta è già in coda |
| `buildContattoUmanoNote` | "il bot si è fatto da parte" (nessun dato variabile) | testo fisso | Stabile, lasciata; parole del lead e motivo già in coda |
| `buildRichiamoSenzaDataNote` | motivo tipizzato (`assente`, `illeggibile`, ...) via `DETTAGLIO_MOTIVO` | enum fisso, non un istante | Stabile, lasciata; nessuna data in testa per design (è la nota che non si fida a mandarne una) |
| `buildRispostaPostNrNote` | "gli avevamo scritto \<orario\> dicendogli che..." | `terzoNrInviatoAt`, letto da `event_log` (immutabile: il terzo tentativo è successo una volta sola) | Stabile per lo stesso fatto: non è `new Date()` al momento dell'invio, è una riga di DB fissa. C'è anche un lucchetto a monte (`risposta_post_nr_segnalata`) che impedisce il doppio invio prima ancora che arrivi qui. Lasciata |
| `buildScriveDopoLaCallNote` | "UN CLIENTE HA SCRITTO IN CHAT" / "HA SCRITTO CHI SI È GIÀ PRESENTATO ALLA CALL" (nessun dato variabile) | booleano `cliente`, non un istante | Stabile, lasciata; parole del lead in coda |
| `buildConfermaPersaNote` | "il lead ha detto sì... ma da noi non è mai partito nessun appuntamento" (nessun dato variabile prima del primo punto: parole e stage sono dopo) | testo fisso | Stabile, lasciata |
| `buildEsitoRifiutatoNote` (`lib/arretrati.ts`) | "il bot \<esito\> il \<data\>, ma il vostro sistema aveva rifiutato..." | `quandoIso` = `e.created_at`, il timestamp del rifiuto letto da `event_log` (riga immutabile), non `new Date()` al momento dell'invio | Stabile per lo stesso fatto, lasciata. Il cron marca anche ogni conversazione come "fatta" dopo l'invio (`arretrato_esito_rinviato`), quindi in pratica non viene nemmeno richiamata due volte per lo stesso rifiuto |

## Test aggiunti (`lib/bot-outcome-rules.test.ts`)

- `stesso esito precedente, istanti diversi a un minuto di distanza → stessa chiave di
  dedup CRM` — costruisce `buildBotRipresoNote` due volte a un minuto di distanza,
  verifica `crmDedupKey` identica. **Falliva prima del fix.**
- `esiti precedenti diversi restano fatti diversi` — stesso orario, esiti diversi →
  chiavi diverse (test opposto).
- `RICHIAMO e APPUNTAMENTO, stessa data chiesta dal lead e stesso appuntamento in
  agenda → stessa nota, stessa chiave` — costruisce `buildLockedNote` da entrambi i
  rami con lo stesso fatto, verifica testo e chiave identici. **Falliva prima del fix
  (2).**
- `la richiesta di spostamento SENZA una nuova data è un fatto diverso da quella CON
  data` — chiavi diverse (test opposto).
- `due date diverse chieste dal lead sono due fatti diversi` — chiavi diverse (protegge
  il caso esplicitamente escluso dallo spostamento: la data che identifica il fatto non
  va mai tolta dalla testa).

Non toccati: `neutralizzaMarcatoreMotivo`, `divergiChiaveDaNotePrecedenti`, il prompt,
le guardie sugli appuntamenti, il contratto verso il CRM (solo il testo di `note`).

## Verifica

- `npm test`: 1301 verdi (1296 preesistenti + 5 nuovi), 0 falliti.
- `npm run typecheck`: pulito.
