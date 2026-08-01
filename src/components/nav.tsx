'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clapperboard, Film, Settings2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const LINKS = [
  { href: '/', label: 'Channels', icon: Clapperboard },
  { href: '/videos', label: 'Videos', icon: Film },
  { href: '/settings', label: 'Settings', icon: Settings2 },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-app bg-[var(--surface)]/85 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-6 px-5 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          Autoreel
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map(({ href, label, icon: Icon }) => {
            // `/` would otherwise match every route.
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors',
                  active ? 'surface font-medium' : 'text-muted hover:text-[var(--text)]',
                )}
              >
                <Icon size={15} aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
