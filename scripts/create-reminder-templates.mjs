// Crea i due template UTILITY dei promemoria pre-call (T-24h e T-3h) via
// Twilio Content API e li sottomette all'approvazione WhatsApp.
// Uso: node --env-file=.env.local scripts/create-reminder-templates.mjs
// (richiede TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in env)
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const TEMPLATES = [
  { key: 'REMINDER_24H_TEMPLATE_SID', name: 'fenice_reminder_24h_v1', body: 'Ciao {{1}}, ti ricordo la videocall di {{2}}. Hai già visto il video che ti ho mandato? Fammi sapere qui, così arriviamo pronti.' },
  { key: 'REMINDER_3H_TEMPLATE_SID', name: 'fenice_reminder_3h_v1', body: 'Ciao {{1}}, ci sentiamo tra poco, {{2}}. Confermi che ci sei?' },
];

for (const t of TEMPLATES) {
  const createRes = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      friendly_name: t.name,
      language: 'it',
      variables: { '1': 'Nome', '2': 'Slot' },
      types: { 'twilio/text': { body: t.body } },
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    console.error(t.name, 'CREATE FAILED', createRes.status, JSON.stringify(created).slice(0, 300));
    continue;
  }
  const approvalRes = await fetch(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: t.name, category: 'UTILITY' }),
  });
  const approval = await approvalRes.json();
  console.log(`${t.key}=${created.sid}`, '| approval:', approvalRes.ok ? (approval.whatsapp?.status ?? 'submitted') : 'FAILED ' + JSON.stringify(approval).slice(0, 200));
}
console.log('\nStato: node scripts/check-sequence-templates.mjs (matcha fenice_open_*/fenice_seq_*/fenice_reengage*/fenice_reminder_*)');
