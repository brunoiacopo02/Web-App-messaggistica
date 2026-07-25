// Controlla lo stato di approvazione WhatsApp dei template della sequenza.
// Uso: node scripts/check-sequence-templates.mjs HXsid1 HXsid2 ...  (senza args: tutti i fenice_seq*/fenice_reengage*)
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

let sids = process.argv.slice(2);
if (!sids.length) {
  const res = await fetch('https://content.twilio.com/v1/Content?PageSize=100', { headers: { Authorization: auth } });
  const data = await res.json();
  sids = (data.contents ?? [])
    .filter((c) => /^fenice_(seq_|reengage|open_|reminder_)/.test(c.friendly_name ?? ''))
    .map((c) => c.sid);
}
for (const sid of sids) {
  const res = await fetch(`https://content.twilio.com/v1/Content/${sid}/ApprovalRequests`, { headers: { Authorization: auth } });
  const data = await res.json();
  const wa = data.whatsapp ?? {};
  console.log(sid, '|', wa.name ?? '?', '|', wa.status ?? '?', wa.rejection_reason ? '| rejected: ' + wa.rejection_reason : '');
}
