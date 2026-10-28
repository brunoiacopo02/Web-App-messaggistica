// INVIO DELL'AGENDA DA QUI, senza CRM: gira in locale la stessa funzione di POST /api/send-agenda
// (runSendAgenda), saltando solo la firma HMAC: BOT_WEBHOOK_SECRET su Vercel è "sensibile" e non
// si scarica. Serve quando il lead ha WhatsApp su un numero diverso da quello del CRM.
//
// Env (una volta, nel repo del bot): npx vercel env pull .env.production.local --environment=production --yes
// Uso: NOME=.. EMAIL=.. FUNNEL=.. bun --env-file=.env.production.local scripts/invia-agenda-locale.ts \
//        <leadId CRM> <numero> <lavora|non-lavora|offerta> [famiglia|no-figli] [--prova]
// Il bot lega la chat al lead per crm_lead_id (la più recente vince), quindi video, appuntamento e
// solleciti seguono il numero dato qui. Nel CRM agendaSentAt/agendaStatus + evento AGENDA_SENT
// vanno scritti a parte: il bot avvisa il CRM solo sulle consegne arrivate in ritardo.

// Le env "sensibili" arrivano come segnaposto: meglio vuote che un valore finto.
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.includes('SENSITIVE')) delete process.env[k];
}
// I due valori non segreti che mancano, ricavati dal DB (agende delle ultime 48h).
process.env.AGENDA_GDO_TEMPLATE_SID ||= 'HX2ac49b476a02975072946976d2994a7c';
process.env.TWILIO_WHATSAPP_NUMBER_FENICE ||= 'whatsapp:+393520413199';

const [leadId, phone, lavoro, famiglia] = process.argv.slice(2);
if (!leadId || !phone || !lavoro) throw new Error('argomenti mancanti');

const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
const { runSendAgenda } = await import('@/lib/send-agenda-gdo');

const { parseSendAgendaPayload } = await import('@/lib/bot-contract');

// Stesso JSON che manda il CRM, passato dallo stesso parser dell'endpoint.
const parsed = parseSendAgendaPayload({
  leadId,
  phone,
  companyId: 'fenice',
  name: process.env.NOME || undefined,
  email: process.env.EMAIL || undefined,
  funnel: process.env.FUNNEL || undefined,
  variant: { lavora: lavoro === 'lavora', haFamiglia: famiglia === 'famiglia', offertaDelMese: lavoro === 'offerta' },
});
if (!parsed.ok) throw new Error(`payload rifiutato: ${parsed.reason}`);
if (process.argv.includes('--prova')) { console.log('payload ok', JSON.stringify(parsed.value)); process.exit(0); }

const res = await runSendAgenda(getSupabaseAdmin(), parsed.value);
console.log(JSON.stringify(res));

export {};
