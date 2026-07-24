// Crea i template della sequenza estesa via Twilio Content API e li sottomette
// all'approvazione WhatsApp. Uso: node scripts/create-sequence-templates.mjs
// Richiede TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in env.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const TEMPLATES = [
  {
    key: 'SEQ_TEMPLATE_SID_1',
    name: 'fenice_seq_touch1_v1',
    body: 'Ciao {{1}}, sono Mario di Fenice Academy 👋 Ti ho scritto ieri ma magari ti ho beccato nel momento sbagliato. Ti va se ti racconto in due messaggi di cosa si tratta, così vedi se può esserti utile? Se preferisci non essere ricontattato/a scrivimi pure NO e chiudo qui.',
  },
  {
    key: 'SEQ_TEMPLATE_SID_2',
    name: 'fenice_seq_touch2_v1',
    body: 'Ciao {{1}}, sono di nuovo Mario di Fenice Academy. Se hai lasciato i tuoi contatti è perché l’idea di lavorare col digitale ti incuriosiva: posso mandarti due info concrete sul percorso, così decidi con calma e senza impegno. Se non ti interessa, un NO e non ti scrivo più.',
  },
  {
    key: 'SEQ_TEMPLATE_SID_3',
    name: 'fenice_seq_touch3_v1',
    body: 'Ciao {{1}}, Mario di Fenice Academy. Domanda secca, così non ti faccio perdere tempo: il tema lavoro digitale ti interessa ancora o è un capitolo chiuso? Mi basta un sì o un no.',
  },
  {
    key: 'SEQ_TEMPLATE_SID_4',
    name: 'fenice_seq_touch4_v1',
    body: 'Ciao {{1}}, sono Mario di Fenice Academy. Questo è il mio ultimo messaggio: non ti disturbo oltre. Se in futuro vorrai capire se il percorso fa per te, mi trovi qui. Ti auguro il meglio 🙂',
  },
  {
    key: 'REENGAGE_TEMPLATE_SID',
    name: 'fenice_reengage_v1',
    body: 'Ciao {{1}}, sono Mario di Fenice Academy: ci eravamo persi a metà discorso 🙂 Se ti va riprendiamo da dove eravamo rimasti, altrimenti scrivimi NO e non ti disturbo più.',
  },
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
