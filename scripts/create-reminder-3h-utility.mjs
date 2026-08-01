// Rifà il promemoria pre-call T-3h con un testo esplicitamente transazionale.
//
// La v1 era stata CHIESTA come UTILITY ma Meta l'ha approvata MARKETING: "Ciao {{1}},
// ci sentiamo tra poco, {{2}}. Confermi che ci sei?" non nomina mai l'appuntamento, e
// l'auto-classificatore lo legge come promozionale. Qui l'oggetto della comunicazione è
// dichiarato (promemoria di un appuntamento già fissato dalla persona), che è quello
// che il messaggio è davvero.
//
// Uso: node --env-file=.env.local scripts/create-reminder-3h-utility.mjs
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const NAME = 'fenice_reminder_3h_v2';
const BODY = 'Promemoria appuntamento: ciao {{1}}, la tua videocall con Fenice Academy è in programma {{2}}. Confermi che ci sei? Se ti serve spostarla, scrivimelo qui.';

const createRes = await fetch('https://content.twilio.com/v1/Content', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    friendly_name: NAME,
    language: 'it',
    variables: { '1': 'Nome', '2': 'Slot' },
    types: { 'twilio/text': { body: BODY } },
  }),
});
const created = await createRes.json();
if (!createRes.ok) throw new Error(`CREATE fallita ${createRes.status}: ${JSON.stringify(created).slice(0, 300)}`);

const approvalRes = await fetch(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: NAME, category: 'UTILITY' }),
});
const approval = await approvalRes.json();
console.log(`REMINDER_3H_TEMPLATE_SID=${created.sid}`);
console.log('approvazione:', approvalRes.ok ? JSON.stringify(approval.whatsapp ?? approval) : `FALLITA ${JSON.stringify(approval).slice(0, 300)}`);
console.log('\nATTENZIONE: la categoria vera la decide Meta. Verificare con:');
console.log(`  node --env-file=.env.local scripts/lib/template-guard.mjs   (o l'ApprovalRequests del SID)`);
