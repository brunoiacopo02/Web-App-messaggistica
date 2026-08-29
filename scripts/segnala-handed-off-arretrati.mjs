// Segnala al CRM i passaggi a una persona mai comunicati (esito CONTATTO_UMANO).
//
// Fino al 06/08 il tag [PASSAGGIO_UMANO] impostava solo ai_status='handed_off' in
// locale: quelle richieste non sono mai uscite dal nostro database. Questo script
// recupera l'arretrato. Il CRM sopprime i doppioni nelle 24h sullo stesso lead, quindi
// e' ri-eseguibile senza fare danno.
//
// Uso: node --env-file=.env.local scripts/segnala-handed-off-arretrati.mjs [--esegui]
// Senza --esegui e' una prova a vuoto: elenca e basta.

const ESEGUI = process.argv.includes('--esegui');
const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP = process.env.NEXT_PUBLIC_APP_URL;
const CRON = process.env.CRON_SECRET;
if (!URL_BASE || !KEY) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY mancanti');
if (ESEGUI && (!APP || !CRON)) throw new Error('NEXT_PUBLIC_APP_URL / CRON_SECRET mancanti: servono per --esegui');

const q = async (p) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} su ${p}: ${await r.text()}`);
  return r.json();
};

// `--conv=3319,3312,...` manda SOLO quelle conversazioni, senza gli altri filtri.
// Serve quando l'elenco lo decide il CRM e non la nostra query: il 29/08 ci hanno
// chiesto le 12 richieste di cui non avevano traccia, e tre di quelle hanno gia' un
// esito APPUNTAMENTO -- il filtro `bot_outcome is null` le avrebbe saltate proprio
// mentre ce le chiedevano.
const scelte = (process.argv.find((a) => a.startsWith('--conv=')) ?? '')
  .replace('--conv=', '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

const convs = scelte.length > 0
  ? await q(`conversations?select=id,crm_lead_id,last_inbound_at&id=in.(${scelte.join(',')})&order=id.asc`)
  : await q(
    'conversations?select=id,crm_lead_id,last_inbound_at' +
    '&ai_status=eq.handed_off&bot_outcome=is.null&crm_lead_id=not.is.null' +
    '&order=id.asc&limit=1000',
  );
console.log(`conversazioni handed_off senza esito CRM: ${convs.length}\n`);

let mandate = 0;
let soppresse = 0;
let fallite = 0;

for (const c of convs) {
  // Le parole del lead sono il suo ultimo messaggio in ingresso: e' esattamente cio'
  // che ha chiesto, e la nota non deve parafrasarlo.
  const m = await q(`messages?select=body,created_at&conversation_id=eq.${c.id}&direction=eq.in&order=created_at.desc&limit=1`);
  const parole = (m[0]?.body ?? '').replace(/\s+/g, ' ').trim();
  console.log(`conv ${c.id.toString().padEnd(5)} lead ${c.crm_lead_id}  "${parole.slice(0, 70)}"`);

  if (!ESEGUI) continue;

  const r = await fetch(`${APP}/api/cron/resend-outcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${CRON}` },
    body: JSON.stringify({ conversationId: c.id, outcome: 'CONTATTO_UMANO', note: parole }),
  });
  const testo = await r.text();
  let esito;
  try { esito = JSON.parse(testo); } catch { esito = null; }
  if (esito?.notifySuppressed) soppresse++;
  else if (r.ok && esito?.ok) mandate++;
  else fallite++;
  console.log(`      -> ${r.status} ${testo.slice(0, 120)}`);
}

if (ESEGUI) {
  console.log(`\nmandate: ${mandate}  soppresse dal CRM (gia' segnalate nelle 24h): ${soppresse}  fallite: ${fallite}`);
} else {
  console.log('\n(prova a vuoto: rilancia con --esegui per mandarle davvero)');
}
