'use client';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { HardDrive, LogOut, Search, Settings, Trash2, FolderOpen } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { NewMenu } from '@/components/new-menu';
import { StorageMeter, useUsage } from '@/components/storage-meter';
import { ThemeToggle } from '@/components/theme-toggle';
import { UploadProvider } from '@/components/upload-manager';
import { UploadPanel } from '@/components/upload-panel';
import { post, UNAUTHORIZED_EVENT } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';

const NAV = [
  { href: '/files', label: 'My files', icon: FolderOpen },
  { href: '/trash', label: 'Trash', icon: Trash2 },
  { href: '/storage', label: 'Storage', icon: Settings },
] as const;

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const session = useSession();

  // Session expired mid-use (any API call returned 401): back to the login page.
  useEffect(() => {
    const out = () => {
      qc.clear();
      router.replace('/login');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, out);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, out);
  }, [qc, router]);

  useEffect(() => {
    if (session.isError) router.replace('/login');
  }, [session.isError, router]);

  if (!session.data) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted" role="status">
        Loading…
      </div>
    );
  }

  return (
    <UploadProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-bg focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <div className="flex h-screen flex-col bg-surface">
        <header className="flex items-center gap-2 px-3 py-2 sm:gap-4 sm:px-4">
          <Link href="/files" className="flex items-center gap-2 pr-2 text-lg font-medium sm:w-56">
            <HardDrive className="text-primary" aria-hidden />
            <span className="hidden sm:inline">PoolDrive</span>
          </Link>
          <Suspense fallback={<div className="flex-1" />}>
            <SearchBox />
          </Suspense>
          <ThemeToggle />
          <UserMenu email={session.data.user.email} />
        </header>

        <div className="flex min-h-0 flex-1">
          <aside aria-label="Sidebar" className="flex w-16 shrink-0 flex-col gap-4 px-2 py-2 md:w-60 md:px-3">
            <div className="flex justify-center md:justify-start">
              <NewMenu />
            </div>
            <Nav />
            <div className="mt-auto hidden px-3 pb-2 md:block">
              <Quota />
            </div>
          </aside>
          <main
            id="main"
            tabIndex={-1}
            className="mb-2 mr-2 min-w-0 flex-1 overflow-auto rounded-2xl bg-bg focus:outline-none"
          >
            {children}
          </main>
        </div>
      </div>
      <UploadPanel />
    </UploadProvider>
  );
}

function Nav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                title={label}
                className={cn(
                  'flex h-10 items-center justify-center gap-3 rounded-full px-3 text-sm md:justify-start',
                  active ? 'bg-primary-soft font-medium text-on-primary-soft' : 'hover:bg-surface-hover',
                )}
              >
                <Icon size={20} aria-hidden />
                <span className="hidden md:inline">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Quota() {
  const { data } = useUsage();
  return (
    <div>
      <StorageMeter />
      {data && data.accounts.degraded > 0 && (
        <Link href="/storage" className="mt-2 block text-xs font-medium text-danger underline">
          {data.accounts.degraded} account{data.accounts.degraded === 1 ? '' : 's'} need attention
        </Link>
      )}
    </div>
  );
}

function SearchBox() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  function submit(e: FormEvent) {
    e.preventDefault();
    if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
  }
  return (
    <form role="search" onSubmit={submit} className="relative max-w-2xl flex-1">
      <Search size={18} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
      <input
        type="search"
        aria-label="Search files by name"
        placeholder="Search in PoolDrive"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="h-11 w-full rounded-full bg-surface-hover pl-11 pr-4 text-sm placeholder:text-muted focus:bg-bg focus:shadow"
      />
    </form>
  );
}

function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  async function logout() {
    await post('/auth/logout').catch(() => undefined);
    qc.clear();
    router.replace('/login');
  }
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Account menu for ${email}`}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-semibold uppercase text-on-primary"
      >
        {email.slice(0, 1)}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className="z-40 min-w-56 rounded-xl border border-line bg-bg p-1 shadow-lg">
          <div className="truncate px-3 py-2 text-xs text-muted">{email}</div>
          <Menu.Item
            onSelect={() => void logout()}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-hover"
          >
            <LogOut size={16} aria-hidden /> Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
