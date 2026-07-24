// Crea i template della persona Marta (6 aperture A/B per-funnel + 5 sequenza) via
// Twilio Content API e li sottomette all'approvazione WhatsApp.
// Uso: node scripts/create-marta-templates.mjs (richiede TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in env)
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const TEMPLATES = [
  // Aperture A/B — testi ESATTI dalla spec 2026-07-24-apertura-marta-ab-design.md
  { key: 'OPENING_SID_C1', name: 'fenice_open_c1_marta_v1', body: 'Ciao {{1}}, sono Marta di Fenice Academy. Le tue 10 ore gratuite arrivano via email a minuti. Intanto dimmi: punti a una seconda entrata o a cambiare proprio lavoro?' },
  { key: 'OPENING_SID_C2', name: 'fenice_open_c2_marta_v1', body: 'Ciao {{1}}, Marta di Fenice Academy: il corso di 10 ore è gratuito davvero, l’accesso ti arriva via email. Tu che obiettivo hai: un’entrata extra o un nuovo lavoro da remoto?' },
  { key: 'OPENING_SID_T1', name: 'fenice_open_t1_marta_v1', body: 'Ciao {{1}}, sono Marta di Fenice Academy. L’accesso al canale Telegram ti arriva via email a breve. Intanto dimmi: ti interessa più un’entrata extra o cambiare proprio lavoro?' },
  { key: 'OPENING_SID_T2', name: 'fenice_open_t2_marta_v1', body: 'Ciao {{1}}, Marta di Fenice Academy: l’ingresso nel canale Telegram è in arrivo via email. Curiosità: hai già una professione digitale in mente o vuoi capire quale fa per te?' },
  { key: 'OPENING_SID_J1', name: 'fenice_open_j1_marta_v1', body: 'Ciao {{1}}, sono Marta di Fenice Academy. Il simulatore ti dirà quale professione digitale ti si addice di più: tu intanto dimmi, punti a un’entrata extra o a cambiare lavoro?' },
  { key: 'OPENING_SID_J2', name: 'fenice_open_j2_marta_v1', body: 'Ciao {{1}}, Marta di Fenice Academy. Prima che il simulatore delle professioni digitali ti dia il verdetto: una professione in mente ce l’hai già o parti da zero?' },
  // Sequenza estesa — stessi testi dei template Mario, firma Marta
  { key: 'MARTA_SEQ_TEMPLATE_SID_1', name: 'fenice_seq_touch1_marta_v1', body: 'Ciao {{1}}, sono Marta di Fenice Academy 👋 Ti ho scritto ieri ma magari ti ho beccato nel momento sbagliato. Ti va se ti racconto in due messaggi di cosa si tratta, così vedi se può esserti utile? Se preferisci non essere ricontattato/a scrivimi pure NO e chiudo qui.' },
  { key: 'MARTA_SEQ_TEMPLATE_SID_2', name: 'fenice_seq_touch2_marta_v1', body: 'Ciao {{1}}, sono di nuovo Marta di Fenice Academy. Se hai lasciato i tuoi contatti è perché l’idea di lavorare col digitale ti incuriosiva: posso mandarti due info concrete sul percorso, così decidi con calma e senza impegno. Se non ti interessa, un NO e non ti scrivo più.' },
  { key: 'MARTA_SEQ_TEMPLATE_SID_3', name: 'fenice_seq_touch3_marta_v1', body: 'Ciao {{1}}, Marta di Fenice Academy. Domanda secca, così non ti faccio perdere tempo: il tema lavoro digitale ti interessa ancora o è un capitolo chiuso? Mi basta un sì o un no.' },
  { key: 'MARTA_SEQ_TEMPLATE_SID_4', name: 'fenice_seq_touch4_marta_v1', body: 'Ciao {{1}}, sono Marta di Fenice Academy. Questo è il mio ultimo messaggio: non ti disturbo oltre. Se in futuro vorrai capire se il percorso fa per te, mi trovi qui. Ti auguro il meglio 🙂' },
  { key: 'MARTA_REENGAGE_TEMPLATE_SID', name: 'fenice_reengage_marta_v1', body: 'Ciao {{1}}, sono Marta di Fenice Academy: ci eravamo persi a metà discorso 🙂 Se ti va riprendiamo da dove eravamo rimasti, altrimenti scrivimi NO e non ti disturbo più.' },
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
console.log('\nStato: node scripts/check-sequence-templates.mjs (matcha fenice_open_*/fenice_seq_*/fenice_reengage*)');
