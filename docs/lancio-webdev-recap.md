# Lancio "Web Developer AI" — recap per la sessione del bot (bozza 17/09/2026, aggiornare a fine B5)

Webinar Zoom **5 ottobre 2026 ore 21:00** (`https://us06web.zoom.us/j/89845223337`, nessun passcode). Lista AC 132 "Lancio Web Developer AI", ads dal 19/09. Spec: `docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md` (stessa copia nel CRM). Piani: `docs/superpowers/plans/2026-09-14-lancio-*.md` + nota di riconciliazione `…-00-riconciliazione-interfacce.md` (vince sui piani). Ledger di esecuzione: `.superpowers/sdd/2026-09-14-lancio-B*/progress.md` (git-ignorati, solo su questo PC).

## Cosa c'e' in produzione (bot) al 17/09
| Blocco | Stato | Interruttore | Dove |
|---|---|---|---|
| B1 intake + benvenuto lista d'attesa (fase `attesa` → `posto_bloccato`, domande, congedo, tetto 200/h) | in prod | `app_settings.lancio_attivo` (false) + lato CRM `LANCIO_WEBDEV_INTAKE` (off) | `lib/lancio-*.ts`, `lib/fenice-enroll.ts`, cron `lancio-aperture` |
| B2 lead che scrivono per primi (Telegram / INBOUND / pulsante webinar) | in prod | `INBOUND_ADOPTION_ENABLED` (non impostata) + `app_settings.lancio_pulsante_attivo` (false) | `app/api/webhooks/twilio/route.ts`, `lib/primo-messaggio.ts`, cron manuale `adotta-mai-risposti` |
| B4 sera del webinar: blast Zoom 19:30-20:45 a lotti con freno, assistenza al collegamento, scelta (chiamata subito / prenotazione 6-7/10), client HMAC verso il CRM | in prod | `lancio_attivo` + cron a data fissa 5/10 in `vercel.json` | `lib/lancio-zoom-blast.ts`, cron `lancio-zoom`, `lib/lancio-assistenza.ts`, `lib/lancio-post-pitch.ts`, `lib/lancio-crm.ts` |
| B5 follow-up 6/10, restituzioni al pool, veto riapertura, pagina impostazioni, offerta del mese | IN CORSO su `feat/lancio-webdev` | — | piano B5 |

Lato CRM (repo `CRM GDO`, tutto su main): webhook AC lista 132 bloccata, pool `LANCIO_WEBDEV_2026` + push al bot, turni venditori `/lancio`, rotte `/api/bot/lancio/{slots,book,call-now}`, scheda "chiamate subito", badge Conferme, ritorno al pool su NON_RISPOSTO/INTERROTTO, pulsante "Offerta del mese" nell'agenda. Contratto: `docs/bot-fissatore-contract.md` v1.6 (v1.7 da scrivere a fine B5).

## Chiavi `app_settings` del lancio (tutte presenti in prod, 16/09)
`lancio_attivo` (false) · `lancio_pulsante_attivo` (false — accendere SOLO dopo le 21:00 del 5/10) · `lancio_zoom_link` · `lancio_video_live_link` (vuoto, lo da' Bruno la mattina del 6) · `offerta_del_mese_link` (vuoto, dopo la live) · `lancio_evento_at` (2026-10-05T21:00:00+02:00) · `lancio_blast_perimetro` (`tutti`; piano B = `risposto`) · `lancio_sender` (`principale`; il secondario resta spento finche' Bruno non lo dice).

## Decisioni del PO da ricordare
- Benvenuti tutti dal numero principale finche' il secondo numero (+393522070047, Account fenice 2) non ha le verifiche legali Twilio; poi il secondario prende i primi 50/g.
- Link Zoom a TUTTI come UTILITY, ordine di intenzione, freno automatico (63018/63051 gravi, 63049 = capped per destinatario); piano B `lancio_blast_perimetro=risposto` solo se ci sono problemi.
- Chi dice no in modo esplicito ("non mi interessa", "toglimi") viene congedato e scartato; un "no" secco di risposta a una domanda del bot NON e' un congedo.
- Prenotazioni: solo 6/10 9-15 ai venditori del turno (ore dichiarate nel calendario), 15-21 alle Conferme; mattina piena → pomeriggio; solo-mattina → 7/10 mattina alle Conferme.
- `INBOUND_ADOPTION_ENABLED=1` e l'accensione del lancio le decide Bruno: nessuna sessione le accende da sola.

## Runbook 5-8 ottobre (bozza, completare in B6)

> Versione operativa completa (prova generale, sonde dei cron, timeline con gli interruttori, freno e riaccensione, gotcha): **`docs/lancio-webdev-runbook-b6.md`**. Quello che segue e' il riassunto in sei righe.
1. 4/10: `vercel env ls production` → `LANCIO_ZOOM_TEMPLATE_SID`, `LANCIO_FOLLOWUP_TEMPLATE_SID` presenti e template UTILITY approvati; NIENTE `LANCIO_FAKE_NOW*` in prod; `lancio_zoom_link` corretto.
2. 5/10 18:00 go/no-go: qualita' del numero, `update app_settings set value='true' where key='lancio_attivo'`.
3. 5/10 19:00: il cron `lancio-zoom` gira fuori finestra e verifica la config (evento se manca qualcosa). 19:30-20:45 blast a lotti di 200/5'. Se scatta il freno: `lancio_attivo` va a false da solo → capire il codice Twilio, poi riaccendere a mano (e il 6 il follow-up NON parte finche' e' spento: evento `lancio_followup_fermo`).
4. 5/10 dopo le 21:00: `lancio_pulsante_attivo=true`. Turni venditori "sera" caricati su `/lancio` nel CRM.
5. 6/10 mattina: `lancio_video_live_link` (link della live editata). 12-14 e 17:30-19:30 follow-up a lotti. 
6. 8/10: restituzioni al pool (cron), lead in `/import` bucket `LANCIO_WEBDEV_2026`; `offerta_del_mese_link` per il pulsante dell'agenda GDO.

## Punti aperti / gotcha
- I tre cron del lancio (`lancio-zoom`, `lancio-followup`, `lancio-restituzioni`) hanno DATE FISSE in `vercel.json` mentre il bot deriva le finestre da `lancio_evento_at`: se l'evento si sposta, vanno aggiornate anche le voci cron (altrimenti niente blast/follow-up/restituzioni e nessun allarme, salvo `fuori_finestra_cron` nel run event delle restituzioni).
- `bot-followups` (re-drive orario) usa il predicato "inbound dopo l'ultimo outbound": un messaggio finito sotto una bolla del bot non viene visto — riguarda tutte le chat Mario, non solo il lancio.
- Le ore dure (9-14 / 15-20, anticipo 1h) sono duplicate bot/CRM: se cambia una parte, cambiare l'altra.
- Prova generale: il CRM ha le date hard-coded (`LANCIO_WEBDEV` in `src/lib/lancio/config.ts`): spostando `lancio_evento_at` sul bot, `slots`/`book` rispondono 422.
- Il cron `adotta-mai-risposti` e' manuale (POST con `esegui`) e bypassa `INBOUND_ADOPTION_ENABLED` per disegno.
- Mittente secondario (Task 11 del piano B4): non implementato; quando si fa, allinearsi a `lib/twilio-account.ts` (`TWILIO_AUTH_TOKEN_2`) dell'altra sessione.
- PROSSIMO LAVORONE dopo il lancio: altri numeri per il bot (ne parla Bruno).
