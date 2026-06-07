import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchListContacts } from './ac-api';

const OLD = { url: process.env.AC_ACCOUNT_URL, key: process.env.AC_API_KEY };

beforeEach(() => {
  process.env.AC_ACCOUNT_URL = 'https://example.api-us1.com';
  process.env.AC_API_KEY = 'token-test';
});
afterEach(() => {
  process.env.AC_ACCOUNT_URL = OLD.url;
  process.env.AC_API_KEY = OLD.key;
});

function page(contacts: Array<Record<string, unknown>>) {
  return { ok: true, status: 200, json: async () => ({ contacts }) } as unknown as Response;
}

describe('fetchListContacts', () => {
  it('pagina finché una pagina è incompleta e mappa i campi', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      email: `u${i}@x.it`,
      firstName: 'N',
      lastName: 'C',
      phone: '3480300004',
    }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page(full)) // pagina piena → continua
      .mockResolvedValueOnce(page([{ id: 101, email: null, firstName: null, lastName: null, phone: ' ' }])); // parziale → stop

    const out = await fetchListContacts('4', fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(101);
    expect(out[0]).toEqual({ id: '1', email: 'u0@x.it', firstName: 'N', lastName: 'C', phone: '3480300004' });
    // phone vuoto → null
    expect(out[100].phone).toBeNull();
    // url con listid/limit/offset
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/api/3/contacts?listid=4&status=1&limit=100&offset=0');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('offset=100');
  });

  it('lancia se mancano le credenziali', async () => {
    delete process.env.AC_API_KEY;
    await expect(fetchListContacts('4')).rejects.toThrow(/Missing AC/);
  });
});
