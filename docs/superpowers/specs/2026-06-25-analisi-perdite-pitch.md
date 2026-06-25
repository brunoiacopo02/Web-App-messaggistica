# Analisi perdite al pitch e gestione obiezioni — Bot Mario

**Data:** 2026-06-25
**Tipo:** deliverable read-only (Fase 2). Alimenta un piano separato di tuning prompt (Fase 3).
**Metodo:** analisi dei transcript completi di tutte le 23 conversazioni Mario che hanno
raggiunto il pitch (prezzi/link comunicati) e NON hanno convertito. 3 subagent in parallelo,
sintesi incrociata. Dettaglio per-conversazione in `scratchpad/pitch-analysis-{A,B,C}.md`.

## 1. Il funnel reale (97 lead gestiti da Mario)

| Stadio | N | Note |
|--------|---|------|
| Lead totali Mario | 97 | |
| Hanno risposto almeno 1 volta | 34 (35%) | **65% non risponde mai all'apertura** |
| Ingaggiati (≥3 inbound) | 30 | chi risponde, di solito ingaggia |
| Arrivati al pitch (prezzi detti) | 25 | |
| **Appuntamenti presi** | **2** | conversione pitch→app ~8% |

**Due cliff distinti:**
- **Top-of-funnel:** 63/97 non rispondono mai. Parte è verosimilmente **deliverability**
  (storia blocco numero Meta) + copy di apertura. Va indagato a parte (non è gestione obiezioni).
- **Pitch→booking:** dei 25 arrivati al pitch, 23 persi. Questo report analizza questi 23.

La diagnosi chiave: **la maggior parte dei lead non si perde per un "no" vero, ma per come
viene gestito il prezzo e la chiusura.** Pochissimi sono fuori target reale; molti erano
recuperabili.

## 2. Pattern ricorrenti (con conteggio conversazioni)

### P1 — Prezzo lordo mai convertito in rata mensile nel pitch *(≈15/23, il più forte)*
Mario dice "dai 1.000 ai 3.000 euro, rateizzabile" come **numero lordo**. Quasi mai fa la
matematica della rata. L'**unica** volta che l'ha fatta spontaneamente ("100/250 euro al mese",
conv 1216) la lead ha detto sì alla call. Il totale lordo ancora il frame su "costo" e innesca
price-shock o silenzio.

### P2 — "Bait-and-switch" sui lead da funnel gratuito *(≈8/23: 1181,1200,1204,1219,1231,1237,1241,1243)*
Lead arrivati da CORSO 10 ORE / pubblicità "gratis" che chiedono il corso gratuito e ricevono
invece il pitch del corso a pagamento. Si sentono ingannati ("c'era scritto dieci ore gratuite
→ allora non mi interessa", 1219; "in cosa consiste il corso di 10 ore?" ignorata → pitch a
pagamento → "costa troppo", 1243). **È la singola perdita più grande.** *(Parzialmente
indirizzato dalla modifica già shippata oggi — vedi §4.)*

### P3 — Nessuna proposta di call IMMEDIATA dopo il prezzo *(≈6/23: 1210,1214,1218,1176,…)*
Dopo il prezzo Mario continua a qualificare o aspetta la mossa del lead, invece di invitare
subito alla call gratuita di 30 minuti. Segue silenzio. La call immediata relativizza il prezzo
("ne parliamo in 30 min, è gratis"); senza, il prezzo resta lì a sedimentare.

### P4 — Gestione obiezione "one-shot" poi resa *(≈4/23: 1151,1176,1184,1188)*
La logica 12-rate/ROI è corretta ma offerta **una volta** e poi mollata al secondo dubbio,
anche dopo un sì parziale ("può anche tornarmi" → Mario chiude lo stesso, 1176).

### P5 — Ghost booking: link JotForm inviato, mai confermato, nessun recupero *(≈4/23: 1205,1216,1227,1233)*
Il lead dà un "ok/sì" vago, non completa il form, Mario non fa follow-up né offre prenotazione
manuale. Il form è il single-point-of-failure più costoso (in 1205 lo slot non era disponibile;
in 1216 la lead 60+ non ha completato). *(Parzialmente indirizzato dal follow-up 2h shippato
oggi — vedi §4; serve però anche il fallback manuale esplicito.)*

### P6 — Re-push della call dopo rifiuto / lead occupato / momento emotivo *(≈4/23: 1184,1188,1231,1233)*
Mario ri-spinge la call (a volte con falsa scarsità "gli slot si riempiono") dopo che il lead
ha detto "preferisco la chat" / "ora non posso" / ha appena condiviso qualcosa di personale →
esito INTERROTTO. La pressione converte lead volenterosi in persi.

### P7 — Valore/ROI non costruito prima del prezzo *(≈5/23)*
Per i lead "scottati" da corsi/truffe (1197,1241,1151) il prezzo arriva prima di sciogliere il
dubbio fiducia. La garanzia "colloqui a contratto" e Trustpilot vanno messi **prima** del prezzo.

### P8 — Mis-tagging DA_SCARTARE invece di RICHIAMO *(es. 1237)*
Lead con blocco economico temporaneo o solo diffidenza taggati DA_SCARTARE → escono dal nurture
CRM invece di essere ricontattati.

### P9 — Latenza di risposta *(alto impatto dove capita: 1188, gap 21h)*
Gap lunghi azzerano il momentum su lead caldi/emotivi. *(Parzialmente mitigato dal backstop
re-drive già attivo.)*

### P10 — Segnali precoci di non-idoneità ignorati *(1210,1221) + mismatch copy ads (upstream)*
"Cercate soldi?", "mi bastano 10 euro al giorno" non usati per qualificare il budget presto →
15-30 messaggi sprecati. Causa a monte: il copy delle campagne crea aspettative di gratuità/lavoro.

## 3. Raccomandazioni per la Fase 3 (tuning prompt), in ordine di leva

1. **Rata mensile sempre dentro il pitch** *(P1)*. Dopo "dai 1.000 ai 3.000 euro" aggiungere
   SEMPRE: "rateizzabile fino a 12 rate, quindi circa 83–250 euro al mese — meno di molte
   palestre". Mai lasciare solo il totale lordo.
2. **Call gratuita come ultima frase del pitch, subito dopo il prezzo** *(P3)*. Nessuna domanda
   di qualificazione dopo il prezzo. Schema: [struttura] → [prezzo+rata] → "il modo più semplice
   per capire se fa per te è una call di 30 min, gratuita e senza impegno: ti va?".
3. **Lead da funnel gratuito gestiti sui loro termini** *(P2)*. Se chiede del corso gratuito:
   rispondere alla domanda, riconoscere/consegnare il corso 10h gratuito come primo passo
   ("vedi come lavoriamo senza spendere un centesimo"), costruire fiducia, e SOLO dopo proporre
   la consulenza. Non ignorare la domanda per saltare al pitch a pagamento.
4. **Dopo un rifiuto della call: restare in chat** *(P6)*. Niente re-push e niente falsa
   scarsità. Mandare il link self-service JotForm e lasciare scegliere ("scegli tu giorno e ora").
5. **Fallback manuale + nudge sul booking** *(P5)*. Dopo il link: "se non trovi l'orario,
   scrivimi giorno e ora e te lo fisso io". *(Il follow-up 2h già shippato copre il nudge base.)*
6. **Insistere meglio sull'obiezione, non arrendersi al primo/secondo no** *(P4)*: esplorare la
   radice ("cosa ti frena di preciso?") prima di chiudere; non mollare dopo un sì parziale.
7. **Fiducia prima del prezzo per i lead diffidenti** *(P7)*: garanzia contrattuale + Trustpilot
   inline prima del numero.
8. **Tagging:** blocco economico temporaneo / diffidenza → **RICHIAMO**, non DA_SCARTARE *(P8)*.

### Fuori scope prompt (segnalazioni operative)
- **Top-of-funnel:** 65% non risponde all'apertura → verificare deliverability (blocco numero
  Meta) e il copy del messaggio di apertura/template.
- **Copy delle campagne (CORSO 10 ORE / JOB SIMULATOR):** allineare le aspettative ("intro
  gratuita ≠ corso completo gratis") per non generare lead a budget zero/ingannati.
- **JotForm:** disponibilità slot e un fallback se il form non mostra orari.

## 4. Cosa è già stato fatto oggi (Fase 1, live)
- **Materiale gratuito:** Mario ora riconosce il corso 10h orientativo (email +
  info@feniceacademysrl.com) e prende comunque l'appuntamento → mitiga in parte **P2**.
  La Fase 3 deve completarlo: rispondere alla domanda sul corso e consegnarlo *prima* di
  proporre il pagamento, non solo accennarlo.
- **Follow-up 2h** sul link di prenotazione → mitiga in parte **P5/P9** (recupero ghost booking
  e silenzi). Serve aggiungere il fallback manuale esplicito nel testo del prompt.
- **Agenda 20:00:** elimina la proposta di slot ormai passati la sera.

## 5. Prossimo passo
Aprire un piano **Fase 3 — tuning prompt** che implementi le raccomandazioni 1-8 su
`lib/mario-prompt.ts`, con A/B mentale sui pattern P1/P2/P3 (i tre a più alta leva), e
verifichi su un campione di conversazioni simulate.
