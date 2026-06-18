'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Bot, Radio, MessagesSquare } from 'lucide-react';
import { signOutAction } from '@/app/(auth)/login/actions';
import { ThemeToggle } from '@/components/ThemeToggle';

const NAV = [
  { href: '/fenice', label: 'Simulatore', icon: Bot, exact: true },
  { href: '/fenice/live', label: 'Live', icon: Radio },
  { href: '/fenice/conversazioni', label: 'Conversazioni', icon: MessagesSquare },
];

export function FeniceSidebar({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 border-r bg-zinc-50 dark:bg-zinc-900">
      <div className="p-4 font-semibold text-lg">Fenice · Mario</div>
      <nav className="flex-1 px-2 space-y-1">
        {NAV.map((item) => {
          const active = item.exact ? pathname === item.href : pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-md text-sm',
                active ? 'bg-zinc-200 dark:bg-zinc-800 font-medium' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t text-xs text-zinc-500 space-y-2">
        <div className="truncate" title={userEmail}>{userEmail}</div>
        <form action={signOutAction}>
          <button type="submit" className="text-red-600 hover:underline">Esci</button>
        </form>
        <ThemeToggle />
      </div>
    </aside>
  );
}
