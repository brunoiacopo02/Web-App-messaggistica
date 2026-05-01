'use server';

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';

export async function signInAction(formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const from = String(formData.get('from') ?? '/inbox');

  if (!email || !password) {
    redirect(`/login?error=${encodeURIComponent('Inserisci email e password')}&from=${encodeURIComponent(from)}`);
  }

  const supabase = await getSupabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent('Credenziali non valide')}&from=${encodeURIComponent(from)}`);
  }

  redirect(from);
}

export async function signOutAction() {
  const supabase = await getSupabaseServer();
  await supabase.auth.signOut();
  redirect('/login');
}
