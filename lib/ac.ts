export type AcParsedLead = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  acContactId: string | null;
  listName: string | null;
  listId: string | null;
};

type Bag = Record<string, unknown>;

function pick(b: Bag, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = b[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function nested(b: Bag, root: string, key: string): string | null {
  const r = b[root];
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    const v = (r as Bag)[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

export function parseAcPayload(input: unknown): AcParsedLead {
  const b = (input ?? {}) as Bag;

  return {
    email:        pick(b, 'contact[email]', 'email')         ?? nested(b, 'contact', 'email'),
    firstName:    pick(b, 'contact[first_name]', 'first_name') ?? nested(b, 'contact', 'first_name'),
    lastName:     pick(b, 'contact[last_name]', 'last_name')  ?? nested(b, 'contact', 'last_name'),
    phone:        pick(b, 'contact[phone]', 'phone')         ?? nested(b, 'contact', 'phone'),
    acContactId:  pick(b, 'contact[id]', 'contact_id')       ?? nested(b, 'contact', 'id'),
    listName:     pick(b, 'list[name]', 'list_name')         ?? nested(b, 'list', 'name'),
    listId:       pick(b, 'list[id]', 'list_id')             ?? nested(b, 'list', 'id'),
  };
}

export const DEDUP_WINDOW_MINUTES = 5;
