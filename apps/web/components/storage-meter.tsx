'use client';
import * as Progress from '@radix-ui/react-progress';
import { useQuery } from '@tanstack/react-query';
import { get } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import type { Usage } from '@/lib/types';

export function useUsage() {
  return useQuery({
    queryKey: ['usage'],
    queryFn: () => get<Usage>('/storage/usage'),
    refetchInterval: 60_000,
  });
}

/** The single pooled bar: every linked account added together. */
export function StorageMeter({ large = false }: { large?: boolean }) {
  const { data } = useUsage();
  if (!data) return null;
  const pct = data.limit > 0 ? Math.min(100, Math.round((data.used / data.limit) * 100)) : 0;
  const warn = pct >= 90;
  return (
    <div className={cn(large ? 'space-y-2' : 'space-y-1')}>
      <Progress.Root
        value={pct}
        aria-label="Pooled storage used"
        className={cn('overflow-hidden rounded-full bg-surface-hover', large ? 'h-3' : 'h-1.5')}
      >
        <Progress.Indicator
          className={cn('h-full', warn ? 'bg-danger' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </Progress.Root>
      <p className={cn('text-muted', large ? 'text-sm' : 'text-xs')}>
        {data.accounts.total === 0
          ? 'No storage linked yet'
          : `${formatBytes(data.used)} of ${formatBytes(data.limit)} used`}
      </p>
    </div>
  );
}
