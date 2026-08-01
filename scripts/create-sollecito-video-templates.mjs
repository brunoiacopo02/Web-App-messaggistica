// Template del sollecito "hai visto il video?" per i lead dei GDO, sottomesso in due
// copie identiche.
//
// Uso: node --env-file=.env.local scripts/create-sollecito-video-templates.mjs
//
// Serve al lead che non ha MAI risposto: la finestra 24h resta chiusa, quindi il
// sollecito del mattino può partire solo come template. Chi ha risposto almeno una
// volta riceve invece un messaggio scritto dal modello nel contesto della chat.
//
// Due copie identiche di proposito: il 29/07 una copia risottomessa è passata in 20
// minuti mentre l'originale restava impantanata per oltre 17 ore. I tempi di
// approvazione Meta non sono prevedibili e non ci si pianifica sopra: si usa la prima
// che passa.
//
// Niente link nel corpo: servirebbe un template per variante (cinque) o una variabile
// in URL. Il video gliel'abbiamo mandato la sera prima, gli basta scorrere.
//
// Sulla categoria: il testo resta asciutto — nessun riferimento a professioni,
// pacchetti, quote o offerte. Sono quelle parole a far scattare MARKETING, che pesa sul
// quality rating del numero. Qui si parla solo di un appuntamento già preso.
//
// Il richiamo a Noemi è dentro il template di proposito: per un lead che non risponde
// mai questo è l'ultimo messaggio automatico che riceve, e sarebbe l'unico posto in cui
// può sentirsi dire da noi che quella chiamata è il passaggio che conferma
// l'appuntamento. Chi risponde se lo sente dire in chat, dal modello.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

const BODY =
  `Ciao {{1}}, ti ricordo il video che ti ho mandato per il tuo appuntamento 🙂 ` +
  `sono 20 minuti e servono per arrivare preparato alla call. Quando l'hai visto scrivimi FATTO qui, così lo segno\n` +
  `Ti ricordo anche che prima della call ti chiama Noemi, una collega, da un cellulare: ` +
  `sono 5-10 minuti per capire bene la tua situazione ed è il passaggio che conferma l'appuntamento. ` +
  `Se ti scappa la chiamata non è un problema, richiamala pure su quel numero`;

const TEMPLATES = [
  { key: 'SOLLECITO_VIDEO_GDO_SID', name: 'fenice_sollecito_video_gdo_v1' },
  { key: 'SOLLECITO_VIDEO_GDO_SID_RISERVA', name: 'fenice_sollecito_video_gdo_v2' },
];

for (const t of TEMPLATES) {
  const createRes = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      friendly_name: t.name,
      language: 'it',
      variables: { '1': 'Nome' },
      types: { 'twilio/text': { body: BODY } },
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    console.error(t.name, 'CREATE FAILED', createRes.status, JSON.stringify(created).slice(0, 300));
    continue;
  }

  const approvalRes = await fetch(`https://content.twilio.com/v1/Content/${created.sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: t.name, category: 'UTILITY' }),
  });
  const approval = await approvalRes.json();
  console.log(
    `${t.key}=${created.sid}`,
    '| approval:',
    approvalRes.ok ? (approval.whatsapp?.status ?? 'submitted') : 'FAILED ' + JSON.stringify(approval).slice(0, 200),
  );
}
