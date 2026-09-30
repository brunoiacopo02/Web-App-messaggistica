import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { toE164 } from '@/lib/phone';
import { findOrCreateLeadConversation, sendTemplateAndLog } from '@/lib/messaging';
import { getTemplateBody } from '@/lib/twilio';
import { mittenteDiConversazione } from '@/lib/mittente';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Endpoint generico chiamato dal CRM per inviare UN template a un lead, su trigger.
// Adatto a tutti i messaggi "manuali/evento" (es. conferme: nr, autoconferma).
// Body JSON: { phone, templateSid, label?, firstName?, lastName?, email?, acContactId?,
//              variables?: {"1":"Mehdi"}, from?: "fenice" | "+39..." }

function authorized(req: NextRequest): boolean {
  const secret = process.env.AGENDA_API_SECRET; // secret condiviso dei trigger CRM
  if (!secret) return false;
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true;
  if (req.headers.get('x-agenda-secret') === secret) return true;
  if (req.nextUrl.searchParams.get('secret') === secret) return true;
  return false;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('unauthorized', { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    const text = await req.text();
    new URLSearchParams(text).forEach((v, k) => (body[k] = v));
  }

  const phone = toE164((body.phone ?? body.Phone ?? body.to ?? null) as string | null);
  if (!phone) {
    return NextResponse.json({ ok: false, error: 'telefono mancante o non valido' }, { status: 400 });
  }

  const templateSid = (body.templateSid ?? body.template_sid ?? body.contentSid) as string | undefined;
  if (!templateSid || !/^HX[0-9a-f]{32}$/i.test(templateSid)) {
    return NextResponse.json({ ok: false, error: 'templateSid mancante o non valido (atteso HX...)' }, { status: 400 });
  }

  const label = ((body.label as string | undefined) ?? 'Template').slice(0, 80);

  const supabase = getSupabaseAdmin();

  // Il mittente, in tre casi:
  //  - `from: 'fenice'` → il numero della chat (lib/mittente.ts): il primario se la chat
  //    nasce adesso, il suo se esisteva gia'. Prima era sempre
  //    il numero storico, e con due numeri avrebbe spezzato le chat nate sul secondo;
  //  - `from: '+39…'` → quel numero, scritto in `wa_number` se la chat nasce adesso;
  //  - `from` assente → il numero di default di `sendTemplate` (`TWILIO_WHATSAPP_NUMBER`),
  //    come sempre: e' la strada di Serenamente (`serenamenteMessaging.ts` nel CRM), che
  //    non manda `from` e non deve finire su un numero Fenice. Alla nascita si scrive
  //    quel numero, cosi' `wa_number` dice sempre da dove la chat ha parlato davvero.
  const fromRaw = (body.from ?? body.sender) as string | undefined;
  const esplicito = fromRaw === 'fenice' ? undefined : (fromRaw || process.env.TWILIO_WHATSAPP_NUMBER || null);

  const { conversationId, waNumber } = await findOrCreateLeadConversation(supabase, {
    phone,
    firstName: (body.firstName ?? body.first_name) as string | undefined,
    lastName: (body.lastName ?? body.last_name) as string | undefined,
    email: body.email as string | undefined,
    acContactId: (body.acContactId ?? body.contact_id) as string | undefined,
  }, { mittente: esplicito });
  const from = fromRaw === 'fenice' ? mittenteDiConversazione({ wa_number: waNumber }) : (fromRaw || undefined);

  // Le variabili del template ({{1}} = nome) e il numero mittente. Senza le prime un
  // template che saluta per nome parte come "Ciao ,"; senza il secondo esce dal numero
  // di default e non da quello della chat, cioè da un numero che il lead non conosce.
  // Servono per gli invii puntuali fatti da noi (il riaggancio di un singolo lead), non
  // al CRM, che manda template senza variabili: entrambi restano facoltativi.
  const variables: Record<string, string> = {};
  const varsRaw = (body.variables ?? body.contentVariables) as unknown;
  if (varsRaw && typeof varsRaw === 'object') {
    for (const [k, v] of Object.entries(varsRaw as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') variables[k] = String(v);
    }
  }

  // Il testo che salviamo deve essere quello che il lead ha davvero letto: senza questa
  // sostituzione in chat resta scritto "Ciao {{1}}", e chi guarda il pannello non sa cosa
  // gli abbiamo mandato. Se il corpo non si riesce a leggere si spedisce lo stesso: il
  // log meno bello vale meno del messaggio.
  let bodyLog: string | undefined;
  if (Object.keys(variables).length > 0) {
    const grezzo = await getTemplateBody(templateSid, from);
    if (grezzo) {
      bodyLog = Object.entries(variables).reduce(
        (testo, [k, v]) => testo.replaceAll(`{{${k}}}`, v),
        grezzo,
      );
    }
  }

  const res = await sendTemplateAndLog(supabase, conversationId, phone, templateSid, label, from, variables, bodyLog);

  await supabase.from('event_log').insert({
    type: res.ok ? 'template_sent' : 'send_error',
    payload: { phone, conversationId, templateSid, label, sid: res.sid, error: res.error } as never,
    message: res.ok ? `Template '${label}' inviato a ${phone}` : `Template '${label}' fallito per ${phone}: ${res.error}`,
    level: res.ok ? 'info' : 'error',
  });

  return NextResponse.json({ ok: res.ok, sid: res.sid, conversationId, error: res.error });
}
