'use client';
import { useQuery } from '@tanstack/react-query';
import { Download, HardDrive, Lock } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { FileIcon } from '@/components/file-icon';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { ApiError, describeError, get, post, url } from '@/lib/api';
import { formatBytes, formatDateTime, kindOf } from '@/lib/format';

interface ShareInfo {
  name: string;
  size: number;
  mime: string | null;
  passwordProtected: boolean;
  expiresAt: string | null;
}

/** Public page for a share link. No account needed; the file is streamed through the API. */
export default function SharedFile() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [access, setAccess] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const info = useQuery({
    queryKey: ['share', token],
    queryFn: () => get<ShareInfo>(`/public/shares/${token}`),
    retry: false,
  });

  async function unlock(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await post<{ access: string }>(`/public/shares/${token}/unlock`, { password });
      setAccess(res.access);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Incorrect password.'
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts. Try again later.'
            : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  }

  const data = info.data;
  const open = data && (!data.passwordProtected || access);
  const contentUrl = (download: boolean) =>
    url(`/public/shares/${token}/content`, { access, download: download ? 1 : undefined });

  return (
    <div className="min-h-screen bg-surface">
      <header className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 text-lg font-medium">
          <HardDrive className="text-primary" aria-hidden /> PoolDrive
        </span>
        <ThemeToggle />
      </header>
      <main className="mx-auto mt-8 w-full max-w-md px-4">
        <div className="rounded-2xl border border-line bg-bg p-6 shadow-sm">
          {info.isPending ? (
            <p className="text-sm text-muted" role="status">
              Loading…
            </p>
          ) : info.isError ? (
            <div role="alert">
              <h1 className="text-lg font-medium">Link unavailable</h1>
              <p className="mt-2 text-sm text-muted">
                {info.error instanceof ApiError && info.error.status === 404
                  ? 'This link is invalid, has expired, or was revoked by its owner.'
                  : describeError(info.error)}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <FileIcon mime={data!.mime} type="file" size={36} />
                <div className="min-w-0">
                  <h1 className="break-words text-lg font-medium">{data!.name}</h1>
                  <p className="text-sm text-muted">
                    {formatBytes(data!.size)}
                    {data!.expiresAt ? ` · expires ${formatDateTime(data!.expiresAt)}` : ''}
                  </p>
                </div>
              </div>

              {!open ? (
                <form onSubmit={unlock} className="mt-5 space-y-3">
                  <p className="flex items-center gap-2 text-sm text-muted">
                    <Lock size={14} aria-hidden /> This file is password protected.
                  </p>
                  <Field
                    label="Password"
                    type="password"
                    autoComplete="off"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    error={error || undefined}
                  />
                  <Button type="submit" className="w-full" disabled={busy}>
                    Unlock
                  </Button>
                </form>
              ) : (
                <div className="mt-5 space-y-4">
                  {kindOf(data!.mime, 'file') === 'image' && (
                    <img
                      src={contentUrl(false)}
                      alt={data!.name}
                      className="max-h-80 w-full rounded-lg bg-surface object-contain"
                    />
                  )}
                  <a
                    href={contentUrl(true)}
                    className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-on-primary hover:opacity-90"
                  >
                    <Download size={16} aria-hidden /> Download
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
