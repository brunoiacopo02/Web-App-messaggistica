// Crea i tre template del lancio "Web Developer AI" (webinar del 5/10/2026) e li
// sottomette all'approvazione WhatsApp. Spec: docs/superpowers/specs/2026-09-14-lancio-webdev-ottobre-design.md §7.
//
// 1. Benvenuto lista d'attesa  → LANCIO_WELCOME_TEMPLATE_SID   ({{1}}=Nome)
// 2. Link Zoom del 5/10        → LANCIO_ZOOM_TEMPLATE_SID      ({{1}}=Nome, {{2}}=Link)
// 3. Follow-up del 6/10        → LANCIO_FOLLOWUP_TEMPLATE_SID  ({{1}}=Nome)
//
// Testi APPROVATI da Bruno il 14/09/2026: non cambiarli.
//
// Categoria chiesta: UTILITY per tutti e tre (la categoria vera la decide Meta).
// Se l'API rifiuta la richiesta UTILITY per un template, si ritenta con MARKETING e
// lo si segnala: in quel caso il SID va anche in UTILITY_ONLY_ALLOW, altrimenti il
// presidio categoria (lib/twilio.ts) lo blocca e i messaggi non partono.
//
// Uso: node --env-file=.env.local scripts/create-lancio-templates.mjs
// (richiede TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in env)
//
// Idempotente: se esiste già un template con quel friendly_name non lo ricrea, stampa
// il SID e lo stato di approvazione reale.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const TEMPLATES = [
  {
    key: 'LANCIO_WELCOME_TEMPLATE_SID',
    name: 'fenice_lancio_benvenuto_v1',
    variables: { '1': 'Nome' },
    body:
      "Ciao {{1}}, sono l'assistente virtuale di Fenice Academy. Complimenti per esserti iscritto " +
      "alla lista d'attesa dell'evento del 5 ottobre: ti invieremo il link per collegarti alla live " +
      'direttamente qui su WhatsApp il giorno stesso. Rispondi a questo messaggio se sei realmente ' +
      'interessato, per bloccare il posto.',
  },
  {
    key: 'LANCIO_ZOOM_TEMPLATE_SID',
    name: 'fenice_lancio_zoom_v1',
    variables: { '1': 'Nome', '2': 'Link' },
    body:
      'Ciao {{1}}, ci siamo! Alle 21:00 inizia la live Web Developer AI. Questo è il tuo link per ' +
      'collegarti: {{2}} — ti consigliamo di entrare qualche minuto prima. Se hai problemi a ' +
      'collegarti scrivimi qui.',
  },
  {
    key: 'LANCIO_FOLLOWUP_TEMPLATE_SID',
    name: 'fenice_lancio_followup_v1',
    variables: { '1': 'Nome' },
    body:
      'Ciao {{1}}, ieri sera alla live abbiamo presentato il percorso Web Developer AI. Ti va di ' +
      'parlarne insieme? Rispondimi qui e ti mando anche il video riassuntivo della live.',
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
      variables: t.variables,
      types: { 'twilio/text': { body: t.body } },
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
  console.log('Questi template NON sono UTILITY: vanno aggiunti a UTILITY_ONLY_ALLOW, altrimenti il');
  console.log('presidio categoria (lib/twilio.ts) li blocca e i messaggi non partono:');
  for (const r of nonUtility) console.log(`  ${r.sid}  (${r.name}, ${r.requested ?? r.category})`);
}

console.log('\nLa categoria vera la decide Meta in fase di approvazione: rilanciare questo script');
console.log('tra qualche giorno per leggere status e categoria definitivi di ciascun SID.');
