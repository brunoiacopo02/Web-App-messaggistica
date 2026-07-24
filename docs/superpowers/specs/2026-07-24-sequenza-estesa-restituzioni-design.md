# Sequenza estesa anti-restituzione — design (24/07/2026)

Obiettivo concordato col team CRM: restituiti/ricevuti ≤50% (oggi 79,6%), fissati ≥8% (oggi 8,1%),
senza riclassificazioni di comodo. Cap assegnazione alzato a 50 lead/giorno.

## Dati Fase 1 (DB produzione, 24/07)

- 677 conversazioni CRM da inizio attività; ultimi 30gg: 602.
- Esiti 30gg: NON_RISPOSTO 342 (56,8%), INTERROTTO 137 (22,8%), APPUNTAMENTO 49 (8,1%),
  DA_SCARTARE 43 (7,1%), RICHIAMO 7, senza esito 24.
- Oggi NESSUN sollecito: apertura singola + classificazione NON_RISPOSTO a 24h
  (p50 = 24,5h; 339/394 NR hanno UN solo outbound). INTERROTTO a 24h di silenzio.
- Sui NON_RISPOSTO: 62% ha LETTO senza rispondere; 24% consegnato non letto;
  14,2% (56/394) MAI consegnato → numeri morti. Error codes: 63024 (numero non
  WhatsApp) ×67, 63016 (free-form fuori finestra 24h) ×79.
- INTERROTTO: 102/147 si fermano dopo 6+ messaggi del lead (stallo profondo, zona
  pitch/prezzo); ai_dropoff_stage inutilizzabile (95% "non chiaro").
- Arruolamento notturno (21–08, 27% dei lead): risposta 33,9% vs 43,6% diurno.
- 4 lead incastrati senza esito: 1415 (handed_off, il cron non lo processa),
  3061 (booked ma outcome mai inviato al CRM), 1251/1462 (active con ultimo
  messaggio inbound → loop di redrive silenzioso, mai classificati).
- R6 verificato: 0 re-invii APPUNTAMENTO duplicati dal fix 1409b2a (20/07).

## Vincoli piattaforma (verificati 24/07/2026)

- Free-form solo entro 24h dall'ultimo inbound del lead; fuori finestra SOLO template approvati.
- Meta frequency cap per-UTENTE ~2 template marketing/24h cross-business (err. 131049):
  gestire il fallimento come "ritenta domani", non consuma il tentativo.
- Numero Fenice già bloccato da Meta a giugno: cap giornaliero invii sequenza,
  jitter orario, opt-out esplicito nei template, kill-switch via env.

## Track A — "Mai risposto" (nessun inbound)

1. Apertura solo in fascia 08:30–20:30 Europe/Rome; intake notturno → schedulato a mattina.
2. Fast-fail numeri morti: apertura undelivered/failed (63024) → 1 retry a +24h in fascia;
   ancora non consegnato → DA_SCARTARE `numero inesistente` (giorno 1–2). Criterio: CONSEGNA
   (delivered/read), mai la lettura.
3. Touch: T0 apertura, T+1g, T+3g, T+7g, T+12g (5 totali, orari variati, 4 template
   variante: social proof / outcome specifico / domanda secca / ultimo messaggio+opt-out).
4. Risposta → flusso Mario normale. "STOP"/"no" → DA_SCARTARE motivato (opt-out).
5. Giorno 14: mai consegnato nulla → DA_SCARTARE `numero inesistente`;
   consegnato ma muto → NON_RISPOSTO (un umano al telefono può ancora provarci).
6. Da allineare col CRM: RICHIAMO (date = fine sequenza, ISO con offset) inviato a 48h
   per rendere visibile lo stato "in lavorazione estesa" sul loro cruscotto.

## Track B — Interrotte

1. Nudge 1 a ~20h dall'ultimo inbound (dentro finestra: free-form contestuale di Mario
   che riprende il punto esatto della conversazione).
2. Nudge 2 a ~48h (template re-engagement); Nudge 3 a ~96h solo se i precedenti consegnati.
3. Classificazione a ~120h: obiezione chiara → DA_SCARTARE motivato;
   altrimenti INTERROTTO con note = punto script + ultima frase del lead verbatim (R5).
4. Migliorare l'estrazione di ai_dropoff_stage/objection (oggi inservibile) con prompt dedicato.

## Robustezza / watchdog

- Sweep cron su TUTTI gli ai_status con crm_lead_id: booked senza outcome → invia
  APPUNTAMENTO; handed_off >48h → alert; redrive fallito ripetuto → fallthrough a
  classificazione; hard-alert su lead senza esito >15 giorni.
- Cron: paginazione oltre limit(500) (WIP atteso ~700 con cap 50/g e sequenze 14g).
- Nuove colonne: sequence_stage, next_touch_at (scheduler dei touch), delivery tracking già presente.
- Cap invii sequenza/giorno + jitter; env SEQUENCE_ENABLED come kill-switch.

## Stima impatto (30gg, base 602)

- Numeri morti → scarto: ~49 lead (−8 punti di restituzioni).
- Sequenza su NR consegnati (62% già leggono): risposta attesa 15–25% → NR restituiti
  dal 56,8% a ~38–42%.
- Apertura diurna: +3–5 punti risposta iniziale sul 27% di lead notturni.
- Re-engagement interrotte + scarto obiezioni chiare: INTERROTTO da 22,8% a ~17–19%.
- Totale restituiti atteso: 55–61% al primo giro; ≤50% richiede anche il tuning del
  copy di apertura/pitch (Fase 3 già analizzata: problema #1 = chiarezza) — iterare
  sui report quindicinali del CRM.

## Stato

- [x] Piano condiviso col CRM; Bruno ha dato il go immediato (24/07)
- [x] Implementazione completa su feat/sequenza-estesa (lib/sequence.ts, lib/interrotto-note.ts,
      cron sequence-touches, rework bot-followups, apertura differita in fenice-enroll)
- [x] 5 template creati via Content API e APPROVATI da Meta (fenice_seq_touch1..4_v1, fenice_reengage_v1)
- [x] Env produzione: SEQ_TEMPLATE_SID_1..4, REENGAGE_TEMPLATE_SID, SEQUENCE_ENABLED, SEQUENCE_MAX_PER_RUN
- [ ] RICHIAMO interim a 48h: NON implementato, in attesa di conferma semantica dal team CRM
- [ ] Onboarding WABA del numero +393399907883 come sender follow-up dedicato (review Meta, manuale)

Decisione sender: i follow-up partono dallo stesso numero dell'apertura (Fenice, +393520413199,
quality HIGH) — un template da numero diverso aprirebbe una chat nuova scollegata sul telefono
del lead. Multi-numero solo per ripartire NUOVI lead, mai a metà sequenza.
