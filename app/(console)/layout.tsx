import { Schibsted_Grotesk, JetBrains_Mono } from 'next/font/google';
import { redirect } from 'next/navigation';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { getSupabaseServer } from '@/lib/supabase/server';
import { puoUsareConsole } from '@/lib/access';
import { Shell } from '@/components/console/Shell';
import './console.css';

const sans = Schibsted_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-console' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-console-mono' });

export const metadata = { title: 'Regia · Fenice' };

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const s = await getSupabaseServer();
  const { data: { user } } = await s.auth.getUser();
  if (!user) redirect('/login?from=/console');
  if (!puoUsareConsole(user.email)) redirect('/');
  return (
    <div data-console data-theme="dark" className={`${sans.variable} ${mono.variable}`}>
      <NuqsAdapter>
        <Shell email={user.email ?? ''}>{children}</Shell>
      </NuqsAdapter>
    </div>
  );
}
