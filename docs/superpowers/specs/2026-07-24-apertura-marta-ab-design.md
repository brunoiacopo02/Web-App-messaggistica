# Nuove aperture per-funnel + persona "Marta" + A/B test — design (24/07/2026)

Approvato da Bruno il 24/07 sera. Obiettivo: alzare il tasso di prima risposta (oggi 41,3%)
verso il benchmark 55-65%, senza far calare i fissati (≥8%).

## Evidenze a monte (analisi 681 chat CRM + 4 ricerche web, 24/07)

- Chi risponde lo fa in mediana entro 2': l'apertura o aggancia subito o mai. 70% legge, 41% risponde.
- Promise-gap: i lead arrivano aspettandosi la promessa dell'ad (CORSO 10 ORE 53%, TELEGRAM 21%,
  JOB SIMULATOR 20% — campo `crm_funnel`) e l'apertura attuale non la nomina. Confusione e
  scetticismo documentati nelle prime risposte ("dove trovo le 10h?", "era gratis poi 27€").
- Motivazioni ricorrenti: lavoro da remoto / seconda entrata / cambiare vita.
- Ricerca: <134 char meglio (ma la promessa vale lo sforamento moderato), zero emoji nel primo
  messaggio (+22%), nome+beneficio nel primo rigo (= anteprima push), UNA domanda a due opzioni
  (3× meno non-risposta delle aperte), give-first (promessa mantenuta), inoculation ("gratuito
  davvero"), tono "tu". Volto umano > logo per i servizi; mittente donna in media risponde di più;
  foto naturale non patinata (rischio effetto-catfish). Verifica Meta e profilo completo = segnale
  anti-truffa (+18-26% da fonti vendor).

## 1. Persona "Marta" (switch globale, non A/B-abile: foto profilo unica per numero)

- Marta è una dipendente reale e consenziente; nome vero nei messaggi, foto profilo del numero
  Fenice = foto scelta (occhiali + sorriso, ritaglio quadrato) via Twilio API.
- Regola etica invariata: mai dichiararsi umana proattivamente, mai negare l'AI se chiesto,
  nessuna manipolazione. Liberatoria scritta per nome+immagine (Bruno la fa firmare).
- Coerenza stack: aperture, prompt bot, testi nudge free-form, 5 template sequenza/riaggancio
  ricreati in versione Marta. Follow-up agenda: verificare se il template cita Mario (follow-up).
- Convivenza: conversazioni aperte da Mario FINISCONO come Mario (persona derivata dal
  template_sid di apertura nei messages); nuove conversazioni = Marta. Nessuna migrazione dati.
- Misura effetto persona: prima/dopo sul tasso di risposta complessivo (non attribuibile
  separatamente dal copy — accettato).

## 2. Le 6 aperture (A/B 2 varianti × 3 funnel)

Struttura fissa: `Ciao {nome}` → chi sono → promessa dell'ad mantenuta/nominata (accesso via
email; il link NON si può dare in chat: le credenziali arrivano via email) → UNA domanda a due
opzioni entrambe vere che estrae il driver (entrata extra vs cambio lavoro / professione in mente
vs da capire). Zero emoji, zero filler.

- C1 (CORSO 10 ORE): "Ciao {nome}, sono Marta di Fenice Academy. Le tue 10 ore gratuite arrivano
  via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?"
- C2 (inoculation): "Ciao {nome}, Marta di Fenice Academy: il corso di 10 ore è gratuito davvero,
  l'accesso ti arriva via email. Tu che obiettivo hai: un'entrata extra o un nuovo lavoro da remoto?"
- T1 (TELEGRAM): "Ciao {nome}, sono Marta di Fenice Academy. L'accesso al canale Telegram ti
  arriva via email a breve. Intanto dimmi: ti interessa più un'entrata extra o cambiare proprio lavoro?"
- T2: "Ciao {nome}, Marta di Fenice Academy: l'ingresso nel canale Telegram è in arrivo via email.
  Curiosità: hai già una professione digitale in mente o vuoi capire quale fa per te?"
- J1 (JOB SIMULATOR): "Ciao {nome}, sono Marta di Fenice Academy. Il simulatore ti dirà quale
  professione digitale ti si addice di più: tu intanto dimmi, punti a un'entrata extra o a
  cambiare lavoro?"
- J2: "Ciao {nome}, Marta di Fenice Academy. Prima che il simulatore delle professioni digitali
  ti dia il verdetto: una professione in mente ce l'hai già o parti da zero?"

Funnel non riconosciuto → C1. Il lead che risponde entra nel flusso bot normale: il prompt sa
quale apertura è stata mandata (body esatto nel contesto) e prosegue senza ripresentarsi.

## 3. Meccanica A/B

- Assegnazione: variante 1/2 per parità di `conversationId`, dentro il funnel.
- Misura (gratis, via `messages.template_sid`): primaria = % conv con primo inbound ≤72h
  dall'apertura; secondaria = % APPUNTAMENTO. Vince chi fa meglio su entrambe (o primaria a
  parità di secondaria).
- Decisione: ~150 invii/variante per funnel (CORSO ≈2 settimane, altri ≈3-4); promozione del
  vincente = si punta l'env della variante perdente al SID vincente (i template restano approvati,
  rollback = flip di env).
- Guardia: fissati coorte nuova <8% → rollback completo (NEW_OPENING_ENABLED=0 ripristina
  Mario + apertura legacy).
- Report: script `scripts/ab-report.mjs` → tabella per template: invii, consegnati, risposta
  ≤72h, appuntamenti.

## 4. Rollout e kill-switch

- Tutto dietro `NEW_OPENING_ENABLED` (default 0). Si accende quando: 6+5 template Marta approvati
  da Meta, foto profilo impostata, Bruno ha visto l'anteprima. In-flight Mario non toccati.
- Env nuove: OPENING_SID_C1/C2/T1/T2/J1/J2, MARTA_SEQ_TEMPLATE_SID_1..4,
  MARTA_REENGAGE_TEMPLATE_SID, NEW_OPENING_ENABLED.

## 5. Contorno

- Profilo WhatsApp Business: descrizione, sito, indirizzo via API; richiesta verifica Meta
  (manuale, guidata). Typing indicator Twilio: verificare supporto API, task separato se esiste.
- Liberatoria uso nome/immagine per Marta (bozza fornita a Bruno).

## Fuori scope

- Cambi al flusso di sequenza/classificazione (live da oggi, non si tocca).
- Template agenda/video legacy (verifica citazione "Mario" come follow-up separato).
- A/B sulla persona (impossibile: foto per-numero).
