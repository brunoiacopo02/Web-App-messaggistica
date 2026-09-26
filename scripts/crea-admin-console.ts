// Crea (o ritrova) l'account admin della console. Uso: bun scripts/crea-admin-console.ts <email> <file-password>
// La password si genera qui e si scrive SOLO nel file indicato (fuori dal repo).
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [email, out] = process.argv.slice(2);
if (!email || !out) throw new Error('uso: bun scripts/crea-admin-console.ts <email> <file>');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const password = randomBytes(12).toString('base64url');
const { data: lista } = await s.auth.admin.listUsers({ perPage: 1000 });
const esistente = lista?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
const r = esistente
  ? await s.auth.admin.updateUserById(esistente.id, { password })
  : await s.auth.admin.createUser({ email, password, email_confirm: true });
if (r.error) throw r.error;
writeFileSync(out, `Console Fenice\nURL: https://web-app-messaggistica.vercel.app/console\nEmail: ${email}\nPassword: ${password}\n`);
console.log(`ok: ${esistente ? 'password aggiornata' : 'account creato'} per ${email}; credenziali in ${out}`);
