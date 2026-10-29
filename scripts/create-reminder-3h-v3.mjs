// Promemoria pre-call T-3h, v3: la v2 chiudeva con "Se ti serve spostarla, scrivimelo
// qui", cioe' invitava il lead a spostare la call proprio nelle ultime ore. Il 25/09 una
// lead ha risposto "va bene anche domani?" e il bot le ha spostato l'appuntamento da solo.
// Dal 29/10/2026 il bot sposta di nuovo, ma solo col flusso controllato (lib/gdo-spostamento.ts:
// una volta, 3 giorni, 10-21): se il lead lo chiede lo sposta, ma il promemoria non lo invita.
// Testo approvato dal PO il 29/10/2026.
//
// Stesso impianto della v2 (oggetto dichiarato = promemoria di un appuntamento, UTILITY),
// senza nessun invito a spostare, disdire o cambiare.
//
// Il template va creato con lo STESSO nome su tutti e due gli account Twilio: il secondo
// numero ritrova il gemello per nome (vedi app/api/admin/secondo-numero).
//
// Uso:
//   node --env-file=.env.local scripts/create-reminder-3h-v3.mjs           (prova, non invia)
//   node --env-file=.env.local scripts/create-reminder-3h-v3.mjs --invia   (crea e manda a Meta)
const NAME = 'fenice_reminder_3h_v3';
const BODY = 'Promemoria appuntamento: ciao {{1}}, la tua videocall con Fenice Academy è in programma {{2}}. Confermi che ci sei?';

if (/spost|disdi|annull|cambia/i.test(BODY)) throw new Error('il testo contiene ancora un invito a spostare');

const ACCOUNTS = [
  { label: 'primario', sid: process.env.TWILIO_ACCOUNT_SID, tok: process.env.TWILIO_AUTH_TOKEN },
  { label: 'secondo', sid: process.env.TWILIO_ACCOUNT_SID_2, tok: process.env.TWILIO_AUTH_TOKEN_2 },
];
const invia = process.argv.includes('--invia');

console.log(`nome:  ${NAME}\ntesto: ${BODY}\n`);
if (!invia) {
  console.log('Prova: nessun invio. Rilancia con --invia per creare il template e chiedere l\'approvazione UTILITY.');
  process.exit(0);
}

for (const a of ACCOUNTS) {
  if (!a.sid || !a.tok) { console.log(`[${a.label}] credenziali mancanti, saltato`); continue; }
  const auth = 'Basic ' + Buffer.from(`${a.sid}:${a.tok}`).toString('base64');

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
  if (!createRes.ok) { console.log(`[${a.label}] CREATE fallita ${createRes.status}: ${JSON.stringify(created).slice(0, 300)}`); continue; }

  const approvalRes = await fetch(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, category: 'UTILITY' }),
  });
  const approval = await approvalRes.json();
  console.log(`[${a.label}] SID=${created.sid}`);
  console.log(`[${a.label}] approvazione:`, approvalRes.ok ? JSON.stringify(approval.whatsapp ?? approval) : `FALLITA ${JSON.stringify(approval).slice(0, 300)}`);
}

console.log('\nLa categoria vera la decide Meta: prima di cambiare REMINDER_3H_TEMPLATE_SID su Vercel');
console.log('verificare che su TUTTI E DUE gli account sia approved + UTILITY.');
