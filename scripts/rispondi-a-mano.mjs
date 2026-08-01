// Risposta manuale su una conversazione, quando il bot e' stato fermato e le redini
// passano a un umano. La webapp non ha un composer: questo script e' il canale.
//
// Uso (dalla root del progetto, con .env.local presente):
//   node scripts/rispondi-a-mano.mjs <conversationId> "testo del messaggio"
//   node scripts/rispondi-a-mano.mjs <conversationId> "testo" --dry     (non invia)
//
// Invia free text: richiede che la finestra WhatsApp di 24h sia aperta (ultimo
// inbound del lead < 24h fa). Lo script lo verifica e si ferma se e' chiusa.
// Il messaggio parte dal numero della conversazione (conversations.wa_number),
// non dal default TWILIO_WHATSAPP_NUMBER, e viene registrato in messages con
// sender='human' cosi' si distingue dalle bolle del bot nei pannelli.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const id = Number(process.argv[2]);
const body = process.argv[3];
const dry = process.argv.includes('--dry');
if (!Number.isFinite(id) || id <= 0 || !body) {
  throw new Error('uso: node scripts/rispondi-a-mano.mjs <conversationId> "testo" [--dry]');
}

const db = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: conv, error } = await db
  .from('conversations')
  .select('id, wa_number, ai_owner, ai_status, last_inbound_at, leads(first_name, phone_e164)')
  .eq('id', id)
  .single();
if (error) throw error;

const to = conv.leads?.phone_e164;
if (!to) throw new Error(`conv ${id}: lead senza phone_e164`);

// Finestra 24h: fuori da qui Twilio rifiuta il free text (servirebbe un template).
const oreDaUltimoInbound = conv.last_inbound_at
  ? (Date.now() - Date.parse(conv.last_inbound_at)) / 3_600_000
  : Infinity;
if (oreDaUltimoInbound > 24) {
  throw new Error(
    `conv ${id}: finestra 24h chiusa (ultimo inbound ${oreDaUltimoInbound.toFixed(1)}h fa). Serve un template approvato.`,
  );
}

console.log(`conv ${id} → ${conv.leads.first_name} ${to}`);
console.log(`da ${conv.wa_number} | ai_owner=${conv.ai_owner} ai_status=${conv.ai_status} | finestra ${oreDaUltimoInbound.toFixed(1)}h`);
console.log(`testo: ${body}`);
if (!dry) await inviaEregistra();
else console.log('\n--dry: nessun invio.');

async function inviaEregistra() {
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const msg = await client.messages.create({
  from: conv.wa_number,
  to: `whatsapp:${to}`,
  body,
  statusCallback: `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio`,
});
console.log(`inviato: ${msg.sid} (${msg.status})`);

await db.from('messages').insert({
  conversation_id: id,
  direction: 'out',
  body,
  twilio_sid: msg.sid,
  twilio_status: msg.status,
  sender: 'human',
});
await db
  .from('conversations')
  .update({ last_message_at: new Date().toISOString(), last_message_preview: body.slice(0, 120) })
  .eq('id', id);
console.log('registrato in messages (sender=human)');
}
