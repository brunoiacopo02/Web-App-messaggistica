// I lead in attesa di una persona, come li vede il CRM.
//
// Interroga /api/bot/contatti-umani con la stessa firma HMAC di /api/bot/intake:
// serve anche come esempio di integrazione per chi implementa la sezione lato CRM.
//
// Uso: node --env-file=.env.local scripts/contatti-umani.mjs [url-base] [--json]
//   url-base predefinito: NEXT_PUBLIC_APP_URL (in locale: http://localhost:3000)
import crypto from 'node:crypto';

const SEGRETO = process.env.BOT_WEBHOOK_SECRET;
if (!SEGRETO) throw new Error('BOT_WEBHOOK_SECRET mancante');

const argomenti = process.argv.slice(2).filter((a) => a !== '--json');
const base = argomenti[0] ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const soloJson = process.argv.includes('--json');

const corpo = JSON.stringify({ stato: 'aperti' });
const firma = 'sha256=' + crypto.createHmac('sha256', SEGRETO).update(corpo).digest('hex');

const r = await fetch(`${base.replace(/\/$/, '')}/api/bot/contatti-umani`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bot-signature': firma },
  body: corpo,
});
const testo = await r.text();
if (!r.ok) throw new Error(`HTTP ${r.status}: ${testo.slice(0, 300)}`);
const risposta = JSON.parse(testo);

if (soloJson) {
  console.log(JSON.stringify(risposta, null, 2));
} else {
  console.log(`# Lead in attesa di una persona: ${risposta.count}\n`);
  const perMotivo = {};
  for (const l of risposta.lead) perMotivo[l.motivo] = (perMotivo[l.motivo] ?? 0) + 1;
  for (const [m, n] of Object.entries(perMotivo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${m}`);
  }
  console.log('\n# In ordine di attesa (prima chi aspetta da più tempo)\n');
  for (const l of risposta.lead) {
    const quando = String(l.richiestoIl ?? '—').slice(0, 16).replace('T', ' ');
    console.log(`${quando}  ${l.motivo.padEnd(24)} ${l.nome ?? 'senza nome'} ${l.phone ?? ''}`);
    console.log(`    lead ${l.leadId}  conv ${l.conversationId}`);
    console.log(`    "${l.paroleDelLead.slice(0, 110)}"`);
  }
}
