// Crea i 6 template di apertura che DICHIARANO l'IA (AI Act art. 50, in vigore dal
// 2/8/2026) via Twilio Content API e li sottomette all'approvazione WhatsApp.
// Gemello di create-marta-templates.mjs: quello crea gli 11 template storici, questo
// SOLO i sei nuovi — rieseguire il primo duplicherebbe roba già approvata.
// Uso: node scripts/create-marta-openings-dichiarate.mjs
//      (richiede TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in env)
// I SID stampati vanno messi in env come OPENING_SID_C3/C4/T3/T4/J3/J4.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

// Cloni delle varianti 1, con la SOLA presentazione cambiata: l'A/B isola così
// esattamente il costo della dichiarazione. Testi allineati a lib/persona.ts.
const TEMPLATES = [
  { key: 'OPENING_SID_C3', name: 'fenice_open_c3_marta_ia_v1', body: `Ciao {{1}}, sono Marta, l’assistente digitale di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?` },
  { key: 'OPENING_SID_C4', name: 'fenice_open_c4_marta_ia_v1', body: `Ciao {{1}}, sono Marta, digital assistant di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?` },
  { key: 'OPENING_SID_T3', name: 'fenice_open_t3_marta_ia_v1', body: `Ciao {{1}}, sono Marta, l’assistente digitale di Fenice Academy. L’accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un’entrata extra o cambiare proprio lavoro?` },
  { key: 'OPENING_SID_T4', name: 'fenice_open_t4_marta_ia_v1', body: `Ciao {{1}}, sono Marta, digital assistant di Fenice Academy. L’accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un’entrata extra o cambiare proprio lavoro?` },
  { key: 'OPENING_SID_J3', name: 'fenice_open_j3_marta_ia_v1', body: `Ciao {{1}}, sono Marta, l’assistente digitale di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un’entrata extra o a cambiare lavoro?` },
  { key: 'OPENING_SID_J4', name: 'fenice_open_j4_marta_ia_v1', body: `Ciao {{1}}, sono Marta, digital assistant di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un’entrata extra o a cambiare lavoro?` },
];

for (const t of TEMPLATES) {
  const createRes = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      friendly_name: t.name,
      language: 'it',
      variables: { '1': 'Nome' },
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
    body: JSON.stringify({ name: t.name, category: 'MARKETING' }),
  });
  const approval = await approvalRes.json();
  console.log(`${t.key}=${created.sid}`, '| approval:', approvalRes.ok ? (approval.whatsapp?.status ?? 'submitted') : 'FAILED ' + JSON.stringify(approval).slice(0, 200));
}
console.log('\nStato approvazioni: node scripts/check-sequence-templates.mjs');
