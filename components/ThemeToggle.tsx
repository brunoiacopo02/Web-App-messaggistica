'use client';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Moon, Sun } from 'lucide-react';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <div className="flex items-center gap-2 text-xs">
      <Sun className="size-3.5" />
      <Switch
        checked={isDark}
        onCheckedChange={(v) => setTheme(v ? 'dark' : 'light')}
        aria-label="Toggle dark mode"
      />
      <Moon className="size-3.5" />
    </div>
  );
}
