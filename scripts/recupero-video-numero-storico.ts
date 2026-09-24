/**
 * Recupero del 24/09/2026: agende GDO partite dal numero storico su chat nate sul
 * numero nuovo. Il lead ha risposto al 3199, il video e' uscito dal 0047 e Twilio l'ha
 * respinto (63016, finestra chiusa su quella coppia di numeri).
 *
 * Per ogni chat: sposta `wa_number` sul numero storico (da qui in poi il bot risponde
 * da li') e manda il template approvato del video dal numero storico.
 *
 *   bun scripts/recupero-video-numero-storico.ts          # prova a vuoto
 *   bun scripts/recupero-video-numero-storico.ts --invia  # invio vero
 */
import { getSupabaseAdmin } from '../lib/supabase/admin';
import { sendTemplateAndLog } from '../lib/messaging';
import { numeroPrimario } from '../lib/mittente';
import { gdoVideoText } from '../lib/gdo-agenda';
import { videoTemplateEnvForLink } from '../lib/gdo-video-followup';
import { templateName } from '../lib/name';

const CHAT = [14351, 14419, 14421, 14475, 14550, 14569, 14576, 14751, 15187];
const invia = process.argv.includes('--invia');

const supabase = getSupabaseAdmin();
const primario = numeroPrimario();
if (!primario) throw new Error('numero storico non configurato');

const { data, error } = await supabase
  .from('conversations')
  .select('id, wa_number, gdo_video_url, ai_paused_at, leads(first_name, phone_e164)')
  .in('id', CHAT);
if (error) throw error;

for (const c of (data ?? []) as unknown as {
  id: number; wa_number: string | null; gdo_video_url: string | null; ai_paused_at: string | null;
  leads: { first_name: string | null; phone_e164: string } | null;
}[]) {
  const link = c.gdo_video_url;
  const envName = videoTemplateEnvForLink(link, null);
  const sid = envName ? process.env[envName] : undefined;
  const phone = c.leads?.phone_e164;
  const nome = c.leads?.first_name ?? null;
  if (!sid || !link || !phone) {
    console.log(c.id, 'SALTATA', { link, envName, phone });
    continue;
  }
  console.log(c.id, phone, templateName(nome), link, envName, c.wa_number, '->', primario);
  if (!invia) continue;

  await supabase.from('conversations').update({ wa_number: primario }).eq('id', c.id);
  const res = await sendTemplateAndLog(
    supabase, c.id, phone, sid, 'video gdo (recupero numero storico)', primario,
    { 1: templateName(nome) }, gdoVideoText(nome, link),
  );
  if (res.ok) {
    await supabase.from('conversations').update({ gdo_video_sent_at: new Date().toISOString() }).eq('id', c.id);
  }
  await supabase.from('event_log').insert({
    type: 'gdo_video_recupero_numero_storico',
    payload: { conversationId: c.id, sid: res.sid, error: res.error, da: c.wa_number, a: primario } as never,
    message: `[gdo] conv ${c.id}: video rimandato dal numero storico (${res.ok ? 'ok' : res.error})`,
    level: res.ok ? 'info' : 'error',
  });
  console.log('   ', res.ok ? `inviato ${res.sid}` : `FALLITO ${res.error}`);
}
