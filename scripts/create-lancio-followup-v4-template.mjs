// Crea il follow-up v4 del lancio Web Developer AI (PO 06/10/2026) sui TRE account Twilio e
// lo sottomette a Meta come UTILITY. Sostituisce v1-v3 (v3: "come richiesto durante la live di ieri"), che dicevano "come richiesto durante la
// live di ieri": falso dal secondo giorno e per chi alla live non c era. Il testo vale per
// tutti i giorni del follow-up ("lunedì sera") e mette la call prima del video.
// Il SID dell account storico va in app_settings.lancio_followup_template_sid (vince
// sull env LANCIO_FOLLOWUP_TEMPLATE_SID); le copie sugli account 2 e 3 si trovano per nome.
// Uso: node --env-file=.env.local scripts/create-lancio-followup-v2-template.mjs
// Idempotente: se il friendly_name esiste gia non lo ricrea. Non manda NESSUN messaggio.

const NAME = 'fenice_lancio_followup_v4';
const BODY =
  'Ciao {{1}}, lunedì sera abbiamo presentato in diretta il percorso Web Developer AI. ' +
  'Fissiamo una call con un consulente per vedere il tuo caso? Prima della call ti mando anche la registrazione da guardare. ' +
  'Rispondi a questo messaggio.';
// Valori d'esempio per la revisione Meta: realistici, non segnaposto.
const VARIABLES = { '1': 'Giulia' };

const ACCOUNTS = [
  { tag: 'account storico', sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN },
  { tag: 'account 2', sid: process.env.TWILIO_ACCOUNT_SID_2, token: process.env.TWILIO_AUTH_TOKEN_2 },
  { tag: 'account 3', sid: process.env.TWILIO_ACCOUNT_SID_3, token: process.env.TWILIO_AUTH_TOKEN_3 },
];

async function findTemplate(auth) {
  let url = 'https://content.twilio.com/v1/Content?PageSize=100';
  while (url) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`GET Content fallita ${res.status}`);
    const data = await res.json();
    const found = (data.contents ?? []).find((t) => t.friendly_name === NAME);
    if (found) return found.sid;
    url = data.meta?.next_page_url || null;
  }
  return null;
}

async function readApproval(auth, sid) {
  const res = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) return { status: `lettura fallita ${res.status}`, category: null, rejection: null };
  const wa = (await res.json()).whatsapp ?? {};
  return { status: wa.status ?? null, category: wa.category ?? null, rejection: wa.rejection_reason || null };
}

let sidStorico = null;

for (const acc of ACCOUNTS) {
  if (!acc.sid || !acc.token) {
    console.warn(`${acc.tag}: credenziali assenti, saltato — lanciare lo script con quelle env`);
    continue;
  }
  const auth = 'Basic ' + Buffer.from(`${acc.sid}:${acc.token}`).toString('base64');

  let sid = await findTemplate(auth);
  if (sid) {
    const a = await readApproval(auth, sid);
    console.log(`${acc.tag}: ${NAME} esiste già, SID ${sid} | ${a.status}/${a.category ?? '?'}${a.rejection ? ` | rifiuto: ${a.rejection}` : ''}`);
    if (acc.tag === 'account storico') sidStorico = sid;
    continue;
  }

  const createRes = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ friendly_name: NAME, language: 'it', variables: VARIABLES, types: { 'twilio/text': { body: BODY } } }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    console.error(`${acc.tag}: CREATE fallita ${createRes.status} ${JSON.stringify(created).slice(0, 300)}`);
    continue;
  }
  sid = created.sid;
  if (acc.tag === 'account storico') sidStorico = sid;

  // Solo UTILITY: nessun ripiego automatico su MARKETING. Un template MARKETING il
  // presidio UTILITY_ONLY lo blocca comunque, e sul numero a qualita' LOW non lo vogliamo.
  const apprRes = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: NAME, category: 'UTILITY' }),
  });
  const appr = await apprRes.json();
  console.log(
    `${acc.tag}: creato ${sid} | richiesta UTILITY: ` +
      (apprRes.ok ? JSON.stringify(appr.whatsapp ?? appr) : `FALLITA ${apprRes.status} ${JSON.stringify(appr).slice(0, 300)}`),
  );
}

console.log(`\napp_settings.lancio_followup_template_sid = ${sidStorico ?? '(account storico non disponibile)'}`);
console.log('E\' il SID dell\'account storico: le copie sugli account 2 e 3 si traducono per nome.');
console.log('La categoria vera la decide Meta: rilanciare lo script per leggere lo stato definitivo.');
