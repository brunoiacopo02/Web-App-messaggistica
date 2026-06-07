// Client minimale per l'API di ActiveCampaign (solo lettura contatti di una lista).
// L'app NON dipende da AC per il funzionamento dei webhook: questo modulo serve
// esclusivamente al job di invio batch (cron) per prelevare i lead di una lista.

export type AcApiContact = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

function creds(): { base: string; token: string } {
  const base = process.env.AC_ACCOUNT_URL;
  const token = process.env.AC_API_KEY;
  if (!base || !token) throw new Error('Missing AC_ACCOUNT_URL or AC_API_KEY');
  return { base: base.replace(/\/+$/, ''), token };
}

function norm(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Preleva TUTTI i contatti di una lista AC, paginando (max 100/pagina).
 * `fetchImpl` è iniettabile per i test.
 */
export async function fetchListContacts(
  listId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AcApiContact[]> {
  const { base, token } = creds();
  const limit = 100;
  let offset = 0;
  const out: AcApiContact[] = [];

  // Guard rail: evita loop infiniti (max 100 pagine = 10.000 contatti).
  for (let page = 0; page < 100; page++) {
    const url = `${base}/api/3/contacts?listid=${encodeURIComponent(listId)}&limit=${limit}&offset=${offset}`;
    const res = await fetchImpl(url, { headers: { 'Api-Token': token } });
    if (!res.ok) {
      throw new Error(`AC API ${res.status} su ${url}`);
    }
    const data = (await res.json()) as { contacts?: Array<Record<string, unknown>> };
    const contacts = data.contacts ?? [];
    for (const c of contacts) {
      out.push({
        id: String(c.id ?? ''),
        email: norm(c.email),
        firstName: norm(c.firstName),
        lastName: norm(c.lastName),
        phone: norm(c.phone),
      });
    }
    if (contacts.length < limit) break;
    offset += limit;
  }

  return out;
}
