// Crea il template "la live sta iniziando" del lancio Web Developer AI (decisione PO 5
// del 25/09/2026) e lo sottomette all'approvazione WhatsApp come UTILITY, su ENTRAMBI gli
// account Twilio: il SID dell'account storico va in LANCIO_INIZIO_TEMPLATE_SID, la copia
// sull'account 2 la trova da sola `lib/template-account.ts` per friendly_name — per
// questo il nome deve essere identico sui due account.
//
// Il messaggio parte il 5/10 fra le 20:30 e le 21:30 (cron `lancio-inizio`), quindi il
// testo regge sia prima sia dopo le 21:00: "e' in programma oggi alle 21:00" + "se la
// live e' gia' iniziata puoi entrare comunque dallo stesso link".
//
// Perche' dovrebbe essere UTILITY (lezione dei template gia' approvati, 25/09):
//  - UTILITY: fenice_lancio_zoom_v2 ("il link per accedere alla live ... a cui ti sei
//    iscritto"), benvenuto_v2 ("confermo la tua iscrizione"), reminder_3h_v2
//    ("Promemoria appuntamento: ..."). Nominano l'azione dell'utente (l'iscrizione /
//    l'appuntamento), danno un'informazione operativa (link, orario) e offrono solo
//    assistenza ("se hai difficolta' rispondi").
//  - MARKETING: zoom_v1 ("ci siamo!"), followup_v1 ("Ti va di parlarne?"),
//    reminder_3h_v1 (non nomina l'appuntamento). Entusiasmo, invito a una conversazione
//    commerciale, oggetto non dichiarato.
// Qui: "Promemoria evento", "a cui ti sei iscritto", orario + link, solo assistenza.
// Niente "a brevissimo", niente punti esclamativi, niente offerta.
//
// Uso: node --env-file=.env.local scripts/create-lancio-inizio-template.mjs
// Idempotente: se il friendly_name esiste gia' su un account non lo ricrea, ne stampa
// SID e stato. Non manda NESSUN messaggio.

const NAME = 'fenice_lancio_inizio_v1';
const BODY =
  'Promemoria evento: ciao {{1}}, la live Web Developer AI a cui ti sei iscritto è in programma ' +
  'oggi alle 21:00. Questo è il link per accedere: {{2}} - se la live è già iniziata puoi entrare ' +
  'comunque dallo stesso link. Se hai difficoltà a collegarti, rispondi a questo messaggio.';
// Valori d'esempio per la revisione Meta: realistici, non segnaposto.
const VARIABLES = { '1': 'Giulia', '2': 'https://us06web.zoom.us/j/89845223337' };

const ACCOUNTS = [
  { tag: 'account storico', sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN },
  { tag: 'account 2', sid: process.env.TWILIO_ACCOUNT_SID_2, token: process.env.TWILIO_AUTH_TOKEN_2 },
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

console.log('\nLANCIO_INIZIO_TEMPLATE_SID = il SID dell\'account storico (la copia sull\'account 2 si traduce per nome).');
console.log('La categoria vera la decide Meta: rilanciare lo script per leggere lo stato definitivo.');
