// Crea i DUE template a pulsanti della scelta del lancio "Web Developer AI" (delibera PO
// 17/09) e li sottomette all'approvazione WhatsApp.
//
// 1. Scelta della notte  → LANCIO_SCELTA_NOTTE_TEMPLATE_SID   (domanda + spinta alla chiamata)
// 2. Scelta del giorno   → LANCIO_SCELTA_GIORNO_TEMPLATE_SID  (sola domanda)
//
// Perché a pulsanti: il 14/09, in prova, alla domanda scritta il lead ha risposto
// "Adessi". Con due quick reply il lead tocca e basta, e il testo che ci arriva è
// ESATTAMENTE il titolo del pulsante: la classificazione torna deterministica
// (lib/lancio-pulsanti.ts) e non costa un turno di modello.
//
// I due corpi sono le stringhe di lib/lancio-prompt.ts (DOMANDA_SCELTA_NOTTE +
// SPINTA_CHIAMATA_NOTTE, DOMANDA_SCELTA_GIORNO), copiate qui perché un .mjs non importa
// TypeScript. Se cambiano là vanno rigenerati i template (v2), o il lead legge una cosa e
// in `messages` ne resta un'altra: lib/lancio-pulsanti.test.ts fa fallire i test se i due
// testi divergono da questo file.
//
// Vincoli WhatsApp: titolo di un quick reply ≤ 20 caratteri, corpo ≤ 1024.
//
// Categoria chiesta: UTILITY (la categoria vera la decide Meta). Se Meta li approva
// MARKETING vengono BLOCCATI dal presidio categoria (lib/twilio.ts) quando UTILITY_ONLY=1
// — è già successo il 17/09 con Zoom e follow-up, rifatti in v2: in quel caso o si rifà il
// template, o il SID va in UTILITY_ONLY_ALLOW (decisione PO). Il turno non fallisce
// comunque: senza pulsanti la domanda esce come testo, come oggi.
//
// Uso: node --env-file=.env.local scripts/create-lancio-scelta-templates.mjs
//
// Idempotente: se esiste già un template con quel friendly_name non lo ricrea, stampa il
// SID e lo stato di approvazione reale.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const TEMPLATES = [
  {
    key: 'LANCIO_SCELTA_NOTTE_TEMPLATE_SID',
    name: 'fenice_lancio_scelta_notte_v1',
    body: "Preferisci che ti chiami un nostro consulente adesso, anche se è tardi, oppure fissiamo una call domani? Ti consiglio di farti chiamare subito: i posti per l'offerta sono limitati e si assegnano in ordine di chiamata, e in questo momento stiamo chiamando tante persone.",
    pulsanti: [
      { id: 'chiama_ora', title: 'Chiamami subito' },
      { id: 'fissiamo_domani', title: 'Fissiamo domani' },
    ],
  },
  {
    key: 'LANCIO_SCELTA_GIORNO_TEMPLATE_SID',
    name: 'fenice_lancio_scelta_giorno_v1',
    body: 'Fissiamo una call oggi pomeriggio, oppure domani mattina?',
    pulsanti: [
      { id: 'oggi_pomeriggio', title: 'Oggi pomeriggio' },
      { id: 'domani_mattina', title: 'Domani mattina' },
    ],
  },
];

// I limiti di WhatsApp si controllano PRIMA di chiamare l'API: un titolo di 21 caratteri
// torna un 400 generico, e a quel punto il template mezzo creato resta lì.
for (const t of TEMPLATES) {
  if (t.body.length > 1024) throw new Error(`${t.name}: corpo di ${t.body.length} caratteri (max 1024)`);
  for (const p of t.pulsanti) {
    if (p.title.length > 20) throw new Error(`${t.name}: pulsante "${p.title}" di ${p.title.length} caratteri (max 20)`);
  }
}

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

/** Chiede l'approvazione WhatsApp con una categoria; restituisce { ok, status, category, error }. */
async function requestApproval(sid, name, category) {
  const res = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, category }),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: `${res.status} ${JSON.stringify(data).slice(0, 300)}` };
  return { ok: true, status: data.whatsapp?.status ?? 'submitted', category: data.whatsapp?.category ?? category };
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
    results.push({ ...t, sid, category: approval.category, status: approval.status, requested: null });
    continue;
  }

  const createRes = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      friendly_name: t.name,
      language: 'it',
      variables: {},
      types: {
        'twilio/quick-reply': {
          body: t.body,
          actions: t.pulsanti.map((p) => ({ type: 'QUICK_REPLY', title: p.title, id: p.id })),
        },
      },
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    console.error(t.name, 'CREATE FAILED', createRes.status, JSON.stringify(created).slice(0, 300));
    continue;
  }
  sid = created.sid;

  let requested = 'UTILITY';
  let approval = await requestApproval(sid, t.name, requested);
  if (!approval.ok) {
    console.warn(`${t.name}: richiesta UTILITY rifiutata (${approval.error}), ritento con MARKETING`);
    requested = 'MARKETING';
    approval = await requestApproval(sid, t.name, requested);
  }
  const status = approval.ok ? approval.status : `FAILED ${approval.error}`;
  console.log(
    `${t.name}: creato ${sid} | categoria chiesta: ${requested} | approval: ${status}` +
      (approval.ok && approval.category ? ` (categoria: ${approval.category})` : ''),
  );
  results.push({ ...t, sid, category: approval.ok ? approval.category : null, status, requested });
}

console.log('\n═══ SID da mettere in .env.local e su Vercel (production) ═══');
for (const r of results) console.log(`${r.key}=${r.sid}`);

const nonUtility = results.filter((r) => r.requested === 'MARKETING' || (r.category && r.category !== 'UTILITY'));
if (nonUtility.length) {
  console.log('\n⚠️  ATTENZIONE CRITICA');
  console.log('Questi template NON sono UTILITY: con UTILITY_ONLY=1 il presidio (lib/twilio.ts) li');
  console.log('blocca e la scelta esce come testo (nessun turno fallisce, ma i pulsanti non si vedono).');
  for (const r of nonUtility) console.log(`  ${r.sid}  (${r.name}, ${r.requested ?? r.category})`);
}

console.log('\nLa categoria vera la decide Meta in fase di approvazione: rilanciare questo script');
console.log('tra qualche ora per leggere status e categoria definitivi di ciascun SID.');
