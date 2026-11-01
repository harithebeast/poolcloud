'use client';
import * as Progress from '@radix-ui/react-progress';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Link2, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { StorageMeter, useUsage } from '@/components/storage-meter';
import { Button } from '@/components/ui/button';
import { del, describeError, get, post } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { AccountView, AlertDto } from '@/lib/types';

export default function StoragePage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-muted">Loading…</p>}>
      <Storage />
    </Suspense>
  );
}

const STATUS: Record<AccountView['status'], { label: string; cls: string }> = {
  HEALTHY: { label: 'Healthy', cls: 'bg-ok-soft text-ok' },
  DEGRADED: { label: 'Needs re-authorisation', cls: 'bg-danger-soft text-danger' },
  DRAINING: { label: 'Being emptied', cls: 'bg-warn-soft text-warn' },
  DISCONNECTED: { label: 'Disconnected', cls: 'bg-surface-hover text-muted' },
};

function Storage() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const session = useSession();
  const isAdmin = session.data?.user.role === 'admin';
  const usage = useUsage();
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // The API sends the browser back here after the Google consent screen.
  useEffect(() => {
    const linked = params.get('linked');
    const failed = params.get('linkError');
    if (linked)
      setBanner({ kind: 'ok', text: `Linked ${linked}. Its space is now part of your pool.` });
    else if (failed) setBanner({ kind: 'error', text: failed });
    if (linked || failed) {
      router.replace('/storage');
      void qc.invalidateQueries();
    }
  }, [params, router, qc]);

  const accounts = useQuery({
    queryKey: ['accounts'],
    enabled: isAdmin,
    queryFn: () => get<AccountView[]>('/accounts'),
    refetchInterval: 30_000,
  });
  const alerts = useQuery({
    queryKey: ['alerts'],
    queryFn: () => get<{ items: AlertDto[] }>('/alerts'),
    refetchInterval: 30_000,
  });

  const link = useMutation({
    mutationFn: (accountId?: string) =>
      post<{ url: string }>('/accounts/google/start', accountId ? { accountId } : {}),
    onSuccess: ({ url }) => {
      window.location.href = url; // off to Google (or straight back, in fake mode)
    },
    onError: (e) => setBanner({ kind: 'error', text: describeError(e) }),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => del(`/alerts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <h1 className="text-xl font-medium">Storage</h1>

      {banner && (
        <p
          role={banner.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'flex items-start justify-between gap-3 rounded-xl px-4 py-3 text-sm',
            banner.kind === 'ok' ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger',
          )}
        >
          {banner.text}
          <button aria-label="Dismiss message" onClick={() => setBanner(null)}>
            <X size={16} aria-hidden />
          </button>
        </p>
      )}

      {(alerts.data?.items ?? []).length > 0 && (
        <section aria-label="Alerts" className="space-y-2">
          {alerts.data!.items.map((a) => (
            <div
              key={a.id}
              role="alert"
              className="flex items-start gap-3 rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn"
            >
              <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <p>{a.message}</p>
                <p className="mt-1 text-xs opacity-80">{formatDateTime(a.createdAt)}</p>
              </div>
              <button aria-label="Dismiss alert" onClick={() => dismiss.mutate(a.id)}>
                <X size={16} aria-hidden />
              </button>
            </div>
          ))}
        </section>
      )}

      <section aria-labelledby="pool" className="rounded-2xl border border-line p-5">
        <h2 id="pool" className="mb-3 font-medium">
          Your pool
        </h2>
        <StorageMeter large />
        {usage.data && usage.data.accounts.total > 0 && (
          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <Stat label="Free" value={formatBytes(usage.data.free)} />
            <Stat label="Available for new uploads" value={formatBytes(usage.data.uploadable)} />
            <Stat
              label="Accounts"
              value={`${usage.data.accounts.healthy} healthy${usage.data.accounts.degraded ? `, ${usage.data.accounts.degraded} offline` : ''}`}
            />
          </dl>
        )}
        <p className="mt-4 flex gap-2 text-xs text-muted">
          <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
          Files that fit in one account are stored whole. Larger files are split across accounts,
          and a split file is unavailable while any account holding part of it is offline. There is
          no redundancy copy. Keep a safety margin free: "available for new uploads" already leaves
          it out.
        </p>
      </section>

      {isAdmin && (
        <section aria-labelledby="accts" className="rounded-2xl border border-line p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="accts" className="font-medium">
              Google accounts
            </h2>
            <Button onClick={() => link.mutate(undefined)} disabled={link.isPending}>
              <Link2 size={16} aria-hidden /> Link a Google account
            </Button>
          </div>
          {accounts.isPending ? (
            <p className="text-sm text-muted" role="status">
              Loading…
            </p>
          ) : (accounts.data ?? []).length === 0 ? (
            <p className="text-sm text-muted">
              No accounts linked yet. Link at least one Google account to start storing files. Each
              account adds its free space (about 15 GB) to the pool.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {accounts.data!.map((a) => (
                <AccountRow
                  key={a.id}
                  a={a}
                  onReauth={() => link.mutate(a.id)}
                  busy={link.isPending}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function AccountRow({
  a,
  onReauth,
  busy,
}: {
  a: AccountView;
  onReauth: () => void;
  busy: boolean;
}) {
  const pct = a.quotaLimit > 0 ? Math.min(100, Math.round((a.quotaUsage / a.quotaLimit) * 100)) : 0;
  const s = STATUS[a.status];
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{a.email}</p>
          <span className={cn('mt-1 inline-block rounded-full px-2 py-0.5 text-xs', s.cls)}>
            {s.label}
          </span>
        </div>
        {(a.status === 'DEGRADED' || a.status === 'HEALTHY') && (
          <Button
            variant={a.status === 'DEGRADED' ? 'primary' : 'outline'}
            size="sm"
            onClick={onReauth}
            disabled={busy}
          >
            <RefreshCw size={14} aria-hidden /> Re-authorise
          </Button>
        )}
      </div>
      <Progress.Root
        value={pct}
        aria-label={`Space used in ${a.email}`}
        className="h-1.5 overflow-hidden rounded-full bg-surface-hover"
      >
        <Progress.Indicator className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </Progress.Root>
      <p className="text-xs text-muted">
        {formatBytes(a.quotaUsage)} of {formatBytes(a.quotaLimit)} used
        {a.quotaSyncedAt ? ` · updated ${formatDateTime(a.quotaSyncedAt)}` : ''}
      </p>
      {a.status === 'DEGRADED' && (
        <p className="text-xs text-danger">
          Files stored on this account are unavailable until you re-authorise it. Nothing has been
          deleted.
        </p>
      )}
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}
