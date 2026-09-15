# Lancio Web Dev AI — deploy blocco B1 (lato bot)

Checklist per portare in produzione l'intake del lancio "Web Developer AI"
(webinar 5/10/2026). Ordine vincolante: la migrazione deve esistere prima del
primo intake con campo `lancio`, altrimenti l'`update` su `lancio_slug` fallisce
e l'endpoint risponde `accettato:false, motivo:'arruolamento_fallito'`.

## 1. Migrazione

Applicare `supabase/migrations/20260914000001_lancio_webdev.sql`: aggiunge 7
colonne a `conversations` (`lancio_slug`, `lancio_fase`, `lancio_ingresso`,
`lancio_link_inviato_at`, `lancio_followup_inviato_at`, `lancio_info`,
`lancio_benvenuto_at`), l'indice parziale `conversations_lancio_idx` e le chiavi
`app_settings` (`lancio_attivo=false`, `lancio_zoom_link`,
`lancio_video_live_link`, `offerta_del_mese_link`, `lancio_evento_at`).

Verificare dopo l'apply che `lancio_attivo` sia `false` (nasce spento, per
scelta — vedi punto 4).

## 2. Env Vercel (production)

Verificare che `LANCIO_WELCOME_TEMPLATE_SID` sia già presente (usato da
`lib/fenice-enroll.ts`, `lib/lancio-turno.ts` e
`app/api/cron/lancio-aperture/route.ts`). Se manca, aggiungerlo con
`npx vercel env add LANCIO_WELCOME_TEMPLATE_SID production` (valore da
`.env.local`, generato da `scripts/create-lancio-templates.mjs`).

Se il template è categoria `MARKETING` (non `UTILITY`), il SID va aggiunto
anche a `UTILITY_ONLY_ALLOW` (lista separata da virgole: valore esistente +
`,HX...`).

`LANCIO_ZOOM_TEMPLATE_SID` e `LANCIO_FOLLOWUP_TEMPLATE_SID` non sono ancora
usati da nessun codice in questo blocco (arrivano con B4/B5): tenerli
valorizzati in `.env.example`/Vercel non è bloccante per B1, ma è comodo
prepararli ora visto che lo script li crea tutti e 3 insieme.

Verifica: `npx vercel env ls production`.

## 3. Push

```bash
git fetch origin
git rev-list --count origin/main..main
git push origin main
```

La produzione si aggiorna al push (nessun deploy manuale). Verificare con
`npx vercel ls --yes` che l'ultimo deployment sia `Ready`.

## 4. `lancio_attivo` resta spento finché il CRM non accende l'intake

`lancio_attivo` nasce `false` dalla migrazione. Va acceso a mano solo per la
prova con il numero di test (vedi punto 5) e resta `true` in produzione solo
quando, lato CRM, è acceso `LANCIO_WEBDEV_INTAKE=on` (contratto v1.6, §9): è il
CRM a mandare il campo `lancio` nel payload di `/api/bot/intake`, il bot si
limita a rispettare l'interruttore `lancio_attivo` per decidere se il
benvenuto parte subito o resta `differita` fino al prossimo run del cron
`/api/cron/lancio-aperture`.

Spegnimento in emergenza (i lead nuovi restano presi in carico, i benvenuti si
accumulano e partono alla riaccensione):

```sql
update app_settings set value = 'false'::jsonb where key = 'lancio_attivo';
```

## 5. Prova con un numero di test

Prima di accendere lato CRM:

1. `POST https://<prod>/api/bot/intake` con body firmato HMAC
   (`x-bot-signature`, vedi `lib/bot-hmac.ts`), `companyId: 'fenice'` e
   `lancio: { slug: 'webdev-2026-10', ingresso: 'lista' }`.
   Con `lancio_attivo=false` attesa risposta
   `{ ok:true, accettato:true, apertura:'differita' }` e riga con
   `lancio_fase='attesa'`.
2. Accendere l'interruttore:
   ```sql
   update app_settings set value = 'true'::jsonb, updated_at = now()
   where key = 'lancio_attivo';
   ```
3. `GET https://<prod>/api/cron/lancio-aperture?secret=$CRON_SECRET`: il
   benvenuto parte (`sent: 1`).
4. Dal numero di test: rispondere "sì" → attesa "Perfetto, il tuo posto è
   bloccato…" e `lancio_fase='posto_bloccato'`; rispondere "è a pagamento?" →
   risposta secca del modello.
5. Controllare in `event_log` gli eventi `lancio_intake`,
   `lancio_apertura_inviata`, `lancio_posto_bloccato`, `fenice_ai_reply` con
   `lancio:true`.
6. Verificare che dopo un'ora `bot_followups_run` NON abbia ri-drivato quella
   chat (nessun secondo messaggio) — è la garanzia che i lead del lancio
   restano fuori da sequenza/nudge/promemoria/solleciti finché non arrivano le
   restituzioni (dall'8/10).

Solo a questo punto il CRM può accendere `LANCIO_WEBDEV_INTAKE`.
