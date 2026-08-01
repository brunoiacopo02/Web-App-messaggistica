// Qualità dei sender WhatsApp secondo Meta, più il polso degli ultimi 7 giorni.
//
// Il quality rating è l'unico segnale diretto che Meta ci passa: blocchi e segnalazioni
// dei singoli utenti non arrivano mai, né a noi né a Twilio. Si guarda questo.
//
// Uso: node --env-file=.env.local scripts/qualita-numero.mjs
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');
const get = async (url) => {
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`HTTP ${r.status} su ${url}`);
  return r.json();
};

const oggi = new Date().toISOString().slice(0, 10);
console.log(`# Qualità sender — ${oggi}\n`);

const { senders = [] } = await get('https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50');
for (const s of senders) {
  if (s.status !== 'ONLINE') continue;
  const p = s.properties ?? {};
  console.log(`${String(s.sender_id).padEnd(26)} qualità: ${String(p.quality_rating).padEnd(8)} limite: ${p.messaging_limit}   (${s.profile?.name || 'senza nome'})`);
}

// Polso degli ultimi 7 giorni sul numero del bot: consegna e lettura sono i due
// comportamenti che alimentano il rating.
const num = process.env.TWILIO_WHATSAPP_NUMBER_FENICE;
if (num) {
  const from = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  let url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json?From=${encodeURIComponent(num)}&DateSent%3E=${from}&PageSize=1000`;
  const st = new Map(); let tot = 0;
  while (url) {
    const j = await get(url);
    for (const m of j.messages ?? []) { tot++; st.set(m.status, (st.get(m.status) ?? 0) + 1); }
    url = j.next_page_uri ? `https://api.twilio.com${j.next_page_uri}` : null;
  }
  const n = (k) => st.get(k) ?? 0;
  const cons = n('read') + n('delivered');
  const pct = (a) => (tot ? ((100 * a) / tot).toFixed(1) + '%' : '—');
  console.log(`\n${num} — ultimi 7 giorni: ${tot} messaggi`);
  console.log(`  consegnati ${pct(cons)} | letti ${pct(n('read'))} | falliti ${pct(n('undelivered') + n('failed'))} | ancora "sent" ${pct(n('sent'))}`);
  console.log('\nLettura: qualità LOW con consegna e lettura in salute = si sta pagando il passato,');
  console.log('non il presente. LOW con lettura in calo = c\'è ancora qualcosa che infastidisce.');
}
