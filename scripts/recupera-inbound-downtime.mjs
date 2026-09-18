// Recupera i messaggi WhatsApp IN ENTRATA che il webhook Twilio non ha registrato
// durante una finestra di indisponibilita' del database (es. il riavvio del 15/09/2026
// per l'upgrade Nano -> Small).
//
// Perche' funziona: Twilio conserva ogni messaggio, e `messages.twilio_sid` e' UNIQUE.
// Reinserire un messaggio gia' presente viola il vincolo e viene scartato, quindi lo
// script e' idempotente e si puo' rilanciare senza creare doppioni.
//
// Uso:
//   node --env-file=.env.local scripts/recupera-inbound-downtime.mjs --da 2026-09-15T17:34:00Z
//   ... aggiungere --esegui per scrivere davvero (senza, e' una prova a vuoto).
import { createClient } from '@supabase/supabase-js';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const ESEGUI = argv.includes('--esegui');
const DA = arg('--da');
const A = arg('--a') ?? new Date().toISOString();
if (!DA) { console.error('serve --da <ISO8601>'); process.exit(1); }

const SID = process.env.TWILIO_ACCOUNT_SID, TOK = process.env.TWILIO_AUTH_TOKEN;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');
const tw = async (u) => { const r = await fetch(u, { headers: { Authorization: auth } }); if (!r.ok) throw new Error(`Twilio ${r.status}`); return r.json(); };

// Twilio filtra per giorno, non per istante: si prende il giorno e si stringe a mano.
const giorno = DA.slice(0, 10);
let url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json?DateSent%3E=${giorno}&PageSize=1000`;
const entranti = [];
while (url) {
  const j = await tw(url);
  for (const m of j.messages ?? []) {
    if (m.direction !== 'inbound') continue;
    const t = new Date(m.date_sent || m.date_created).toISOString();
    if (t >= DA && t <= A) entranti.push(m);
  }
  url = j.next_page_uri ? `https://api.twilio.com${j.next_page_uri}` : null;
}
console.log(`messaggi IN ENTRATA su Twilio fra ${DA} e ${A}: ${entranti.length}`);
if (entranti.length === 0) { console.log('niente da recuperare.'); process.exit(0); }

// Quali di questi mancano a database?
const sids = entranti.map((m) => m.sid);
const presenti = new Set();
for (let i = 0; i < sids.length; i += 200) {
  const { data, error } = await db.from('messages').select('twilio_sid').in('twilio_sid', sids.slice(i, i + 200));
  if (error) throw new Error(error.message);
  for (const r of data ?? []) presenti.add(r.twilio_sid);
}
const mancanti = entranti.filter((m) => !presenti.has(m.sid));
console.log(`gia' registrati: ${presenti.size} — MANCANTI: ${mancanti.length}`);
for (const m of mancanti.slice(0, 10)) console.log(`   ${m.sid}  da ${m.from}  "${(m.body ?? '').slice(0, 60)}"`);
if (mancanti.length === 0) { console.log('\nNessun messaggio perso: il webhook ha retto.'); process.exit(0); }
if (!ESEGUI) { console.log('\n(prova a vuoto: rilancia con --esegui per inserirli)'); process.exit(0); }

// Inserimento: serve la conversazione del mittente. Se non esiste, si segnala e si salta:
// creare lead+conversazione qui replicherebbe la logica del webhook, meglio non duplicarla.
let inseriti = 0, senzaConv = 0;
for (const m of mancanti) {
  const phone = String(m.from).replace('whatsapp:', '');
  const { data: lead } = await db.from('leads').select('id').eq('phone_e164', phone).maybeSingle();
  if (!lead) { senzaConv++; continue; }
  const { data: conv } = await db.from('conversations').select('id').eq('lead_id', lead.id).maybeSingle();
  if (!conv) { senzaConv++; continue; }
  // Le note vocali arrivano da Twilio senza testo: il webhook normale le trascrive,
  // qui non possiamo, ma un corpo vuoto renderebbe il messaggio invisibile a chi
  // legge la chat. Si usa lo stesso segnaposto del webhook.
  const corpo = (m.body ?? '').trim() || '[nota vocale]';
  const { error } = await db.from('messages').insert({
    conversation_id: conv.id, direction: 'in', body: corpo,
    twilio_sid: m.sid, twilio_status: m.status, is_template: false,
    created_at: new Date(m.date_sent || m.date_created).toISOString(),
  });
  if (error && !String(error.message).includes('duplicate')) console.error(`  ${m.sid}: ${error.message}`);
  else inseriti++;
}
console.log(`\ninseriti: ${inseriti} — saltati (nessuna conversazione): ${senzaConv}`);
