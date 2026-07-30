'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  Clapperboard,
  Command,
  LayoutDashboard,
  Menu,
  Moon,
  Send,
  Settings,
  Sparkles,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge, Kbd } from '@/components/ui/primitives';

/**
 * Application shell: sidebar, top bar, command palette.
 *
 * The sidebar collapses to a slide-over on small screens rather than
 * disappearing, so every destination stays reachable on a phone — creators
 * review and approve from mobile even when they edit on desktop.
 */

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Projects', icon: Clapperboard },
  { href: '/studio', label: 'AI Studio', icon: Sparkles },
  { href: '/planner', label: 'Planner', icon: CalendarDays },
  { href: '/publish', label: 'Publishing', icon: Send },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/team', label: 'Team', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

export function AppShell({
  children,
  workspaceName = 'My workspace',
}: {
  children: React.ReactNode;
  workspaceName?: string;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Close the mobile drawer whenever the route changes, or it stays open
  // covering the page the user just navigated to.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:sticky lg:top-0 lg:h-dvh border-r border-[var(--border-subtle)] px-3 py-4">
        <SidebarContent workspaceName={workspaceName} pathname={pathname} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            className="absolute inset-0 bg-black/60 animate-fade-in"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="glass-strong absolute inset-y-0 left-0 flex w-64 flex-col px-3 py-4 animate-fade-up">
            <SidebarContent workspaceName={workspaceName} pathname={pathname} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <header className="glass sticky top-0 z-40 flex h-14 items-center gap-3 border-x-0 border-t-0 px-4">
          <button
            className="lg:hidden -ml-1 grid size-9 place-items-center rounded-lg hover:bg-[var(--surface-hover)]"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-5" />
          </button>

          <button
            onClick={() => setPaletteOpen(true)}
            className="group flex h-9 flex-1 max-w-sm items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-inset)] px-3 text-sm text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)]"
          >
            <Command className="size-3.5" />
            <span className="flex-1 text-left">Search or jump to…</span>
            <Kbd>⌘K</Kbd>
          </button>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <div className="grid size-8 place-items-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">
              {workspaceName.slice(0, 1).toUpperCase()}
            </div>
          </div>
        </header>

        <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}

function SidebarContent({ workspaceName, pathname }: { workspaceName: string; pathname: string }) {
  return (
    <>
      <Link href="/dashboard" className="mb-6 flex items-center gap-2.5 px-2">
        <div className="grid size-8 place-items-center rounded-lg bg-[var(--accent)] shadow-[var(--shadow-glow)]">
          <Sparkles className="size-4 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight">Phantom</p>
          <p className="truncate text-xs text-[var(--text-muted)]">{workspaceName}</p>
        </div>
      </Link>

      <nav className="flex-1 space-y-0.5" aria-label="Main">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
              )}
            >
              <item.icon className={cn('size-4', active && 'text-[var(--accent)]')} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-inset)] p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium">Render credits</span>
          <Badge tone="accent">Free</Badge>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-base)]">
          <div className="h-full w-2/5 rounded-full bg-[var(--accent)]" />
        </div>
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">12 of 30 renders used</p>
      </div>
    </>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const stored = localStorage.getItem('phantom-theme');
    if (stored === 'dark' || stored === 'light') {
      setTheme(stored);
      return;
    }
    setTheme(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('phantom-theme', next);
  };

  return (
    <button
      onClick={toggle}
      className="grid size-9 place-items-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

const COMMANDS = [
  { label: 'New project from upload', href: '/projects/new', hint: 'Upload' },
  { label: 'Generate a video from a prompt', href: '/studio', hint: 'AI Studio' },
  { label: 'Open the content calendar', href: '/planner', hint: 'Planner' },
  { label: 'Review the publishing queue', href: '/publish', hint: 'Publishing' },
  { label: 'See analytics', href: '/analytics', hint: 'Analytics' },
  { label: 'Connect a social account', href: '/settings/accounts', hint: 'Settings' },
  { label: 'Manage team members', href: '/team', hint: 'Team' },
];

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const filtered = COMMANDS.filter((command) =>
    command.label.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24">
      <button className="absolute inset-0 bg-black/50 animate-fade-in" aria-label="Close" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass-strong relative w-full max-w-lg overflow-hidden rounded-2xl shadow-[var(--shadow-lift)] animate-scale-in"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4">
          <Command className="size-4 text-[var(--text-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command or search…"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
            aria-label="Command"
          />
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <ul className="max-h-72 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">No matches</li>
          ) : (
            filtered.map((command) => (
              <li key={command.href}>
                <Link
                  href={command.href}
                  onClick={onClose}
                  className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <span>{command.label}</span>
                  <span className="text-xs text-[var(--text-muted)]">{command.hint}</span>
                </Link>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
