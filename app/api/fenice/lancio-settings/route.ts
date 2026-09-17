import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  getLancioSettings,
  getLancioSettingValue,
  setLancioSetting,
  validateLancioSettingInput,
  type LancioSettingKey,
} from '@/lib/lancio-settings';
import { puoModificareLancio } from '@/lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireUser() {
  const authed = await getSupabaseServer();
  const { data: { user } } = await authed.auth.getUser();
  return user;
}

export async function GET() {
  const user = await requireUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  const settings = await getLancioSettings(getSupabaseAdmin());
  return NextResponse.json({ settings, puoModificare: puoModificareLancio(user.email) });
}

/**
 * Cambia UNA chiave del lancio. Due porte prima di scrivere: la sessione (401) e
 * l'area dell'account (403 — qui "admin" è l'area `all`, l'unica nozione di ruolo del
 * repo), poi la validazione, che è la stessa funzione pura provata dai test.
 *
 * Ogni scrittura lascia una riga in `event_log` con il prima, il dopo e chi: la sera
 * del 5 ottobre queste manopole si girano di fretta, e senza traccia non si saprebbe
 * più chi ha spento il lancio né da quale valore.
 *
 * I due errori non sono simmetrici, e non devono esserlo:
 * - **la scrittura fallita è un 500**. Questa pagina è la manopola d'emergenza: un 200
 *   su un `update` mai avvenuto farebbe leggere "Salvato" a chi sta spegnendo il lancio
 *   mentre i messaggi continuano a partire. Meglio un errore in faccia.
 * - **l'audit fallito non è un errore**. Il registro non può bloccare la manopola: la
 *   scrittura è già valida, si risponde 200 con `audit: false` e la pagina dice che di
 *   quel cambio non resta traccia. Il tentativo di avviso è best effort.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return new NextResponse('unauthorized', { status: 401 });
  if (!puoModificareLancio(user.email)) {
    return NextResponse.json({ ok: false, error: 'sola_lettura' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { key?: unknown; value?: unknown };
  const key = typeof body.key === 'string' ? body.key : '';
  const valid = validateLancioSettingInput(key, body.value);
  if (!valid.ok) return NextResponse.json({ ok: false, error: valid.reason }, { status: 400 });

  const admin = getSupabaseAdmin();
  const chiave = key as LancioSettingKey;
  const prima = await getLancioSettingValue(admin, chiave);

  const scritto = await setLancioSetting(admin, chiave, valid.value);
  if (!scritto.ok) {
    // Best effort: se anche il registro è giù, l'errore resta comunque nella risposta.
    await admin.from('event_log').insert({
      type: 'lancio_setting_scrittura_fallita',
      payload: { key: chiave, value: valid.value, who: user.email ?? user.id, error: scritto.error } as never,
      message: `[lancio] impostazione ${chiave} NON salvata: ${scritto.error}`,
      level: 'error',
    }).then(() => undefined, () => undefined);
    return NextResponse.json({ ok: false, errore: 'scrittura_fallita' }, { status: 500 });
  }

  const chi = user.email ?? user.id;
  const leggibile = valid.value === '' ? '(vuoto)' : String(valid.value);
  const audit = await admin.from('event_log').insert({
    type: 'lancio_setting_cambiata',
    payload: { key: chiave, old: prima ?? null, new: valid.value, who: chi } as never,
    message: `[lancio] ${chiave}: ${prima === null || prima === undefined ? '(vuoto)' : String(prima)} → ${leggibile} (${chi})`,
    level: 'info',
  }).then(({ error }) => !error, () => false);

  if (!audit) {
    await admin.from('event_log').insert({
      type: 'lancio_setting_audit_fallito',
      payload: { key: chiave, value: valid.value, who: chi } as never,
      message: `[lancio] ${chiave} salvata, ma la riga di registro non è stata scritta (${chi})`,
      level: 'warn',
    }).then(() => undefined, () => undefined);
  }

  return NextResponse.json({ ok: true, key: chiave, value: valid.value, audit });
}
