'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { LayoutDashboard, Inbox, Megaphone, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { signOutAction } from '@/app/(auth)/login/actions';
import { ThemeToggle } from '@/components/ThemeToggle';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/inbox',     label: 'Inbox',     icon: Inbox, badgeKey: 'unread' as const },
  { href: '/campagne',  label: 'Campagne',  icon: Megaphone },
  { href: '/log',       label: 'Log',       icon: FileText },
];

export function Sidebar({ unreadCount, userEmail }: {
  unreadCount: number;
  userEmail: string;
}) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 border-r bg-zinc-50 dark:bg-zinc-900">
      <div className="p-4 font-semibold text-lg">WA Lead</div>
      <nav className="flex-1 px-2 space-y-1">
        {NAV.map((item) => {
          const active = pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-md text-sm',
                active
                  ? 'bg-zinc-200 dark:bg-zinc-800 font-medium'
                  : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
              {item.badgeKey === 'unread' && unreadCount > 0 && (
                <Badge variant="destructive" className="ml-auto h-5 px-1.5 text-xs">
                  {unreadCount}
                </Badge>
              )}
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
