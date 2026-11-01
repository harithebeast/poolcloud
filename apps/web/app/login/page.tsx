'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { ApiError, describeError, get, post, setCsrfToken } from '@/lib/api';
import type { Session } from '@/lib/session';

/** Sign in, or create the admin account on first run. */
export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: () => get<{ setupRequired: boolean }>('/auth/status'),
    retry: 1,
    staleTime: 0,
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => get<Session>('/auth/me'),
    retry: false,
  });

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const setup = status.data?.setupRequired ?? false;

  useEffect(() => {
    if (me.data) {
      setCsrfToken(me.data.csrfToken);
      router.replace('/files');
    }
  }, [me.data, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (setup && password.length < 12)
      return setError('Use at least 12 characters for the password.');
    if (setup && password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      const session = await post<Session>(setup ? '/auth/setup' : '/auth/login', {
        email,
        password,
      });
      setCsrfToken(session.csrfToken);
      qc.setQueryData(['me'], session);
      router.replace('/files');
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Incorrect email or password.'
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts. Wait a few minutes and try again.'
            : describeError(err),
      );
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-bg p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <HardDrive className="text-primary" aria-hidden />
          <span className="text-xl font-semibold">PoolDrive</span>
        </div>

        {status.isPending || me.isPending ? (
          <p className="text-sm text-muted" role="status">
            Loading…
          </p>
        ) : status.isError ? (
          <p className="text-sm text-danger" role="alert">
            Cannot reach the PoolDrive server. {describeError(status.error)}
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <h1 className="text-lg font-semibold">
              {setup ? 'Create the admin account' : 'Sign in'}
            </h1>
            {setup && (
              <p className="text-sm text-muted">
                Welcome! This is the first run. The account you create here manages the storage
                pool.
              </p>
            )}
            <Field
              label="Email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Field
              label="Password"
              type="password"
              autoComplete={setup ? 'new-password' : 'current-password'}
              required
              minLength={setup ? 12 : undefined}
              hint={setup ? 'At least 12 characters.' : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {setup && (
              <Field
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
