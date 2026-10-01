// Crea il template "ecco la registrazione della live" del lancio Web Developer AI e lo
// sottomette all'approvazione WhatsApp come UTILITY, sui TRE account Twilio: il SID
// dell'account storico va in LANCIO_REGISTRAZIONE_TEMPLATE_SID, le copie sugli account 2
// e 3 le trova da sola `lib/template-account.ts` per friendly_name — per questo il nome
// deve essere identico sui tre account.
//
// Perche' esiste (piano 2026-10-01, Task 4): dal 1/10 il bot, a chi non puo' esserci la
// sera della live o chiede la registrazione, risponde "dopo la live ti mandiamo qui la
// registrazione" e timbra `lancio_info.registrazione_promessa_at`. Il 6/10 il cron del
// follow-up manda QUESTO template a quelle chat al posto del follow-up generico: la
// promessa si mantiene, e fuori dalle 24h serve un template.
//
// Perche' dovrebbe essere UTILITY (stessa lezione di fenice_lancio_inizio_v1): risponde a
// una richiesta esplicita del lead ("come ci avevi chiesto"), consegna il contenuto
// richiesto (il link) e offre solo una risposta. Niente entusiasmo, niente offerta.
//
// Uso: node --env-file=.env.local scripts/create-lancio-registrazione-template.mjs
// Idempotente: se il friendly_name esiste gia' su un account non lo ricrea, ne stampa
// SID e stato. Non manda NESSUN messaggio.

const NAME = 'fenice_lancio_registrazione_v1';
const BODY =
  'Ciao {{1}}, come ci avevi chiesto ecco la registrazione della live Web Developer AI: {{2}} - ' +
  'se dopo averla vista vuoi parlarne con un consulente, rispondi a questo messaggio.';
// Valori d'esempio per la revisione Meta: realistici, non segnaposto.
const VARIABLES = { '1': 'Giulia', '2': 'https://corso.feniceacademy.it/registrazione-web-developer-ai' };

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

console.log(`\nLANCIO_REGISTRAZIONE_TEMPLATE_SID = ${sidStorico ?? '(account storico non disponibile)'}`);
console.log('E\' il SID dell\'account storico: le copie sugli account 2 e 3 si traducono per nome.');
console.log('La categoria vera la decide Meta: rilanciare lo script per leggere lo stato definitivo.');
