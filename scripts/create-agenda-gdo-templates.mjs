// Crea i template per l'invio agenda "per conto GDO" (integrazione CRM /send-agenda)
// e li sottomette all'approvazione WhatsApp via Twilio Content API.
//
// Uso: node --env-file=.env.local scripts/create-agenda-gdo-templates.mjs
// (richiede TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN in env)
//
// 1 template agenda + 5 template video (4 combinazioni lavora x famiglia + offerta
// del mese, che ha la precedenza). Tutti richiesti come UTILITY.
//
// Il percorso normale del video NON usa questi template: il messaggio agenda chiede
// al lead di rispondere, la risposta apre la finestra 24h e il video parte come testo
// libero. I template video sono la rete di sicurezza per chi non risponde mai, che
// altrimenti arriverebbe in call senza aver visto niente.
//
// Sulla categoria: il testo dei video è scritto per essere classificato UTILITY, cioè
// materiale relativo a un appuntamento che il lead ha già preso. Per questo non nomina
// professioni, pacchetti, quote né l'offerta del mese: sono quelle parole a far
// scattare MARKETING, che peserebbe sul quality rating del numero. Se Meta li declassa
// comunque a MARKETING va bene lo stesso (decisione di Bruno, 28/07), ma il testo va
// lasciato asciutto: è l'unica leva che abbiamo sulla classificazione.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOK) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN mancanti');
const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');

// Confermato dal CRM (28/07): i GDO mandano lo stesso form di prenotazione del bot,
// quindi l'appuntamento finisce nello stesso posto.
const BOOKING_LINK = 'https://form.jotform.com/240755654585063';

// Testo del messaggio video: identico per tutte le varianti, cambia solo il link.
const videoBody = (link) =>
  `Ciao {{1}}, ecco il video da vedere prima del tuo appuntamento 👉 ${link}\nSono 20 minuti e servono per arrivare preparato alla call. Quando l'hai visto scrivimi FATTO qui, così lo segno`;

const TEMPLATES = [
  {
    // L'invito a rispondere non è una formalità: senza una risposta del lead la
    // finestra 24h resta chiusa e il video può partire solo come template.
    key: 'AGENDA_GDO_TEMPLATE_SID',
    name: 'fenice_agenda_gdo_v2',
    body: `Ciao {{1}}, sono Marta di Fenice Academy 🙂 come ti ha detto il mio collega ti mando qui il link per scegliere giorno e ora della videocall 👉 ${BOOKING_LINK}\nRispondimi qui con un ok quando l'hai aperto, così ti mando il video da vedere prima della call`,
  },
  { key: 'VIDEO_GDO_LAVORA_SID', name: 'fenice_video_gdo_lavora_v2', video: 'https://corso.feniceacademy.it/conferenza-bx' },
  { key: 'VIDEO_GDO_NONLAVORA_SID', name: 'fenice_video_gdo_nonlavora_v2', video: 'https://corso.feniceacademy.it/conferenza-axmsbn9r50' },
  { key: 'VIDEO_GDO_LAVORA_FAMIGLIA_SID', name: 'fenice_video_gdo_lavora_famiglia_v2', video: 'https://corso.feniceacademy.it/conferenza-dx' },
  { key: 'VIDEO_GDO_NONLAVORA_FAMIGLIA_SID', name: 'fenice_video_gdo_nonlavora_famiglia_v2', video: 'https://corso.feniceacademy.it/conferenza-ex' },
  { key: 'VIDEO_GDO_OFFERTA_SID', name: 'fenice_video_gdo_offerta_v2', video: 'https://corso.feniceacademy.it/conferenza-black-summer' },
];

for (const t of TEMPLATES) {
  const body = t.body ?? videoBody(t.video);

  const createRes = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      friendly_name: t.name,
      language: 'it',
      variables: { '1': 'Nome' },
      types: { 'twilio/text': { body } },
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
