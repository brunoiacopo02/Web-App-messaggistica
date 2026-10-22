// Crea il template UTILITY del promemoria del giorno prima per i lead fissati dai GDO,
// su OGNI account Twilio da cui il bot manda, e ne chiede l'approvazione a Meta.
//
// Il testo e' quello di `gdoReminderText` (lib/precall-reminders.ts): se cambia la' va
// cambiato qui, e il nome va alzato di versione. Il friendly_name e' lo STESSO su tutti
// gli account: lib/template-account.ts traduce i SID tra account proprio dal nome.
//
// Idempotente: se il nome esiste gia' su un account non lo ricrea; se manca solo la
// richiesta di approvazione, la manda.
//
// Uso: bun --env-file="<percorso>/.env.local" scripts/crea-template-reminder-gdo.ts
import { gdoReminderText } from '../lib/precall-reminders';

const NAME = 'fenice_reminder_24h_gdo_v1';
const ESEMPIO = { '1': 'Luca', '2': 'venerdì 23 ottobre alle 10:00', '3': 'oggi pomeriggio' };
// Il corpo con i segnaposto: stessa funzione del codice, cosi' non puo' divergere.
const BODY = gdoReminderText({ '1': '{{1}}', '2': '{{2}}', '3': '{{3}}' });

const ACCOUNT: { etichetta: string; sid?: string; token?: string }[] = [
  { etichetta: 'principale', sid: process.env.TWILIO_ACCOUNT_SID, token: process.env.TWILIO_AUTH_TOKEN },
  { etichetta: 'slot 2', sid: process.env.TWILIO_ACCOUNT_SID_2, token: process.env.TWILIO_AUTH_TOKEN_2 },
  { etichetta: 'slot 3', sid: process.env.TWILIO_ACCOUNT_SID_3, token: process.env.TWILIO_AUTH_TOKEN_3 },
];

const BASE = 'https://content.twilio.com/v1/Content';

async function trovaPerNome(auth: string): Promise<string | null> {
  let url: string | null = `${BASE}?PageSize=50`;
  while (url) {
    const r: Response = await fetch(url, { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`LIST ${r.status}`);
    const j: any = await r.json();
    const c = (j.contents ?? []).find((x: any) => x.friendly_name === NAME);
    if (c) return String(c.sid);
    url = j.meta?.next_page_url ?? null;
  }
  return null;
}

async function stato(sid: string, auth: string): Promise<string> {
  const r = await fetch(`${BASE}/${sid}/ApprovalRequests`, { headers: { Authorization: auth } });
  const j: any = await r.json();
  return j?.whatsapp ? `${j.whatsapp.status} (${j.whatsapp.category})` : 'nessuna richiesta';
}

for (const a of ACCOUNT) {
  if (!a.sid || !a.token || a.sid.includes('SENSITIVE') || a.token.includes('SENSITIVE')) {
    console.log(`[${a.etichetta}] credenziali mancanti o mascherate: SALTATO`);
    continue;
  }
  const auth = 'Basic ' + Buffer.from(`${a.sid}:${a.token}`).toString('base64');
  try {
    let sid = await trovaPerNome(auth);
    if (sid) {
      console.log(`[${a.etichetta}] esiste gia': ${sid}`);
    } else {
      const r = await fetch(BASE, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          friendly_name: NAME,
          language: 'it',
          variables: ESEMPIO,
          types: { 'twilio/text': { body: BODY } },
        }),
      });
      const j: any = await r.json();
      if (!r.ok) throw new Error(`CREATE ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      sid = String(j.sid);
      console.log(`[${a.etichetta}] creato: ${sid}`);
    }
    const prima = await stato(sid, auth);
    if (prima === 'nessuna richiesta' || prima.startsWith('unsubmitted')) {
      const r = await fetch(`${BASE}/${sid}/ApprovalRequests/whatsapp`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NAME, category: 'UTILITY' }),
      });
      if (!r.ok) throw new Error(`APPROVAL ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    console.log(`[${a.etichetta}] approvazione: ${await stato(sid, auth)}`);
  } catch (e) {
    console.log(`[${a.etichetta}] ERRORE: ${(e as Error).message}`);
  }
}
