// Crea i due template per il recupero dei lead che non rispondono al telefono
// durante le Conferme: uno al primo tentativo fallito di call, uno al terzo.
// Entrambi categorizzati UTILITY (comunicazioni relative a un appuntamento già preso).
//
// Uso: node --env-file=.env.local scripts/create-recupero-nr-templates.mjs
// (richiede TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in env)
//
// Idempotente: se un template con quel friendly_name esiste già, non lo ricrea,
// stampa il SID. Tutti i SID stampati vanno messi in env e ANCHE in UTILITY_ONLY_ALLOW,
// altrimenti il presidio li blocca e i messaggi non partono.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const TEMPLATES = [
  {
    key: 'NR1_TEMPLATE_SID',
    name: 'fenice_nr1_marta_v1',
    body: 'Ciao {{1}}, ti abbiamo appena chiamato per la call di {{2}} con Noemi: sono 5 minuti per sistemare gli ultimi dettagli e mandarti il link per collegarti. Quando ti va bene che ti richiamiamo?',
  },
  {
    key: 'NR3_TEMPLATE_SID',
    name: 'fenice_nr3_marta_v1',
    body: 'Ciao {{1}}, abbiamo provato a chiamarti tre volte per la call di {{2}} con Noemi e non siamo riusciti a sentirti. Se la vuoi ancora scrivimi qui, bastano due righe e la confermiamo: sono 5 minuti al telefono. Senza una tua risposta l\'appuntamento lo annulliamo.',
  },
];

/** Cerca un template per friendly_name; restituisce il SID se esiste, null se no. */
async function findTemplate(friendlyName) {
  let url = `https://content.twilio.com/v1/Content?PageSize=100`;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: auth },
    });
    if (!res.ok) throw new Error(`GET Content fallita ${res.status}`);
    const data = await res.json();
    const found = (data.contents ?? []).find((t) => t.friendly_name === friendlyName);
    if (found) return found.sid;
    url = data.meta?.next_page_url || null;
  }
  return null;
}

/** Legge lo stato di approvazione reale di un template. */
async function readApproval(sid) {
  const res = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) throw new Error(`ApprovalRequests fallita ${res.status}`);
  const data = await res.json();
  const wa = data.whatsapp ?? {};
  return { status: wa.status ?? null, category: wa.category ?? null };
}

const results = [];
for (const t of TEMPLATES) {
  let sid = await findTemplate(t.name);
  if (sid) {
    const approval = await readApproval(sid);
    console.log(
      `${t.name}: esiste già, SID ${sid}`,
      '| status:',
      approval.status ?? '?',
      approval.category ? `| categoria Meta: ${approval.category}` : '',
    );
    results.push({ key: t.key, name: t.name, sid, category: approval.category });
    continue;
  }

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
  sid = created.sid;

  const approvalRes = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: t.name, category: 'UTILITY' }),
  });
  const approval = await approvalRes.json();
  const approvalStatus = approvalRes.ok ? (approval.whatsapp?.status ?? 'submitted') : 'FAILED';

  console.log(
    `${t.name}: creato ${sid}`,
    '| approval:',
    approvalStatus,
    approval.whatsapp?.category ? `(categoria Meta: ${approval.whatsapp.category})` : '',
  );

  results.push({ key: t.key, name: t.name, sid, category: approval.whatsapp?.category });
}

console.log('\n═══ SID da mettere in .env.local ═══');
for (const r of results) {
  console.log(`${r.key}=${r.sid}`);
}

console.log('\n⚠️  ATTENZIONE CRITICA');
console.log('Aggiungi ANCHE questi SID a UTILITY_ONLY_ALLOW in .env.local:');
for (const r of results) {
  console.log(`  ${r.sid}`);
}
console.log('\nSenza questo, il presidio categoria li blocca e i messaggi non partono.');
console.log('Il 24/08/2026 sei template sono stati creati senza aggiungerli alla allow-list,');
console.log('e 27 lead sono rimasti senza primo messaggio per quattro giorni.');

console.log('\n═══ Categorie assegnate da Meta ═══');
for (const r of results) {
  console.log(`${r.name}: ${r.category ?? '(non ancora assegnata, in attesa di approvazione)'}`);
}
