// Il momento del "ti va?": cosa dice il bot, cosa risponde il lead, e come finisce.
// Coorte: INTERROTTO a cui la call è stata proposta ma che non sono mai arrivati al
// blocco Noemi (cioè non hanno accettato). Sola lettura.
const URL_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function fetchAll(p) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL_BASE}/${p}&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const conv = await fetchAll(
  'conversations?select=id,bot_outcome,gdo_agenda_at,last_inbound_at&ai_owner=eq.mario&crm_lead_id=not.is.null&created_at=gte.2026-07-15'
);
const cand = conv.filter((c) => !c.gdo_agenda_at && c.last_inbound_at && c.bot_outcome === 'INTERROTTO');
const ids = cand.map((c) => c.id);
const msgs = [];
for (let i = 0; i < ids.length; i += 150) {
  msgs.push(
    ...(await fetchAll(
      `messages?select=conversation_id,direction,body,created_at&conversation_id=in.(${ids.slice(i, i + 150).join(',')})&order=id`
    ))
  );
}
const perConv = new Map();
for (const m of msgs) {
  if (!perConv.has(m.conversation_id)) perConv.set(m.conversation_id, []);
  perConv.get(m.conversation_id).push(m);
}

const PROPOSTA = /videocall|30\/40 minuti/i;
const casi = [];
for (const c of cand) {
  const righe = perConv.get(c.id) ?? [];
  const testoOut = righe.filter((m) => m.direction === 'out').map((m) => m.body ?? '').join(' ');
  if (!PROPOSTA.test(testoOut)) continue;
  if (/Noemi/i.test(testoOut)) continue; // ha accettato: non è questo il caso
  // Il primo messaggio del bot che propone la call, e cosa succede dopo.
  const idx = righe.findIndex((m) => m.direction === 'out' && PROPOSTA.test(m.body ?? ''));
  if (idx < 0) continue;
  const dopo = righe.slice(idx + 1);
  casi.push({
    id: c.id,
    proposta: (righe[idx].body ?? '').replace(/\s+/g, ' ').slice(0, 150),
    scambiDopo: dopo.length,
    rispostaLead: (dopo.find((m) => m.direction === 'in')?.body ?? '').replace(/\s+/g, ' ').slice(0, 180),
    ultimoLead: ((dopo.filter((m) => m.direction === 'in').at(-1)?.body) ?? '').replace(/\s+/g, ' ').slice(0, 180),
    ultimoBot: ((dopo.filter((m) => m.direction === 'out').at(-1)?.body) ?? '').replace(/\s+/g, ' ').slice(0, 200),
  });
}

console.log(`Casi: proposta di call fatta, mai arrivati al blocco Noemi, finiti INTERROTTO: ${casi.length}\n`);
const scambi = casi.map((c) => c.scambiDopo).sort((a, b) => a - b);
console.log(`Messaggi scambiati dopo la proposta: mediana ${scambi[Math.floor(scambi.length / 2)]}`);
console.log(`Chat morte SUBITO dopo la proposta (0-1 messaggi dopo): ${casi.filter((c) => c.scambiDopo <= 1).length}`);
console.log(`Il lead ha risposto qualcosa alla proposta: ${casi.filter((c) => c.rispostaLead).length}\n`);

console.log('══════ 25 casi: cosa risponde il lead alla proposta, e come si chiude ══════\n');
for (const c of casi.slice(-25)) {
  console.log(`── conv ${c.id}  (${c.scambiDopo} messaggi dopo la proposta)`);
  console.log(`   BOT propone: ${c.proposta}`);
  if (c.rispostaLead) console.log(`   LEAD risponde: "${c.rispostaLead}"`);
  if (c.ultimoLead && c.ultimoLead !== c.rispostaLead) console.log(`   LEAD, ultimo: "${c.ultimoLead}"`);
  if (c.ultimoBot) console.log(`   BOT, ultimo:  ${c.ultimoBot}`);
  console.log('');
}
