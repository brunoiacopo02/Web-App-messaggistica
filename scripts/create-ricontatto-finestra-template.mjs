// Crea il template del RICONTATTO FUORI FINESTRA (lotto B).
//
// A cosa serve: quando il lead non può in nessuno dei due giorni prenotabili, il bot non
// fissa fuori finestra e non lo perde: gli dice il giorno in cui lo ricontatta e poi lo
// ricontatta davvero. Se quel giorno cade oltre le 24h dall'ultimo messaggio del lead, il
// free-text è vietato da WhatsApp e serve questo template.
//
// UNO SOLO, generico: deve reggere a qualunque distanza e qualunque giorno della settimana,
// perché il giorno del ricontatto si calcola (primo giorno in cui il giorno voluto dal lead
// entra nella finestra "domani + dopodomani") e non è prevedibile a priori.
//
// Testo approvato da Bruno il 10/09/2026.
//
// Uso: node --env-file=.env.local scripts/create-ricontatto-finestra-template.mjs
// (richiede TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in env)
//
// Idempotente: se esiste già un template con quel friendly_name non lo ricrea, stampa il SID
// e lo stato di approvazione reale.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const TEMPLATES = [
  {
    key: 'RICONTATTO_FINESTRA_TEMPLATE_SID',
    name: 'fenice_ricontatto_finestra_v1',
    body:
      "Ciao {{1}}, sono Marta di Fenice Academy. Come concordato insieme ti scrivo per fissare " +
      "l'appuntamento che qualche giorno fa non abbiamo preso per mancanza di orari disponibili: " +
      'adesso ho disponibilità in linea con le tue esigenze. Ti interessa ancora?',
  },
];

/** Cerca un template per friendly_name; restituisce il SID se esiste, null se no. */
async function findTemplate(friendlyName) {
  let url = 'https://content.twilio.com/v1/Content?PageSize=100';
  while (url) {
    const res = await fetch(url, { headers: { Authorization: auth } });
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
      `${t.name}: esiste già, SID ${sid} | status: ${approval.status ?? '?'}` +
        (approval.category ? ` | categoria Meta: ${approval.category}` : ''),
    );
    results.push({ ...t, sid, category: approval.category, status: approval.status });
    continue;
  }

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
  sid = created.sid;

  const approvalRes = await fetch(
    `https://content.twilio.com/v1/Content/${sid}/ApprovalRequests/whatsapp`,
    {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t.name, category: 'UTILITY' }),
    },
  );
  const approval = await approvalRes.json();
  const status = approvalRes.ok ? (approval.whatsapp?.status ?? 'submitted') : 'FAILED';
  console.log(
    `${t.name}: creato ${sid} | approval: ${status}` +
      (approval.whatsapp?.category ? ` (categoria Meta: ${approval.whatsapp.category})` : ''),
  );
  results.push({ ...t, sid, category: approval.whatsapp?.category, status });
}

console.log('\n═══ SID da mettere in .env.local e su Vercel ═══');
for (const r of results) console.log(`${r.key}=${r.sid}`);

console.log('\n⚠️  ATTENZIONE CRITICA');
console.log('Aggiungi ANCHE questo SID a UTILITY_ONLY_ALLOW.');
console.log('Il numero Fenice è a qualità LOW e il presidio categoria blocca tutto quello che');
console.log("non è in allow-list: il 24/08/2026 sei template sono stati creati senza aggiungerli,");
console.log('e 27 lead sono rimasti senza primo messaggio per quattro giorni.');
