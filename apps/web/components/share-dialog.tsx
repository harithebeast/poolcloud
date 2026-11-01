'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2Off } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { del, describeError, get, post } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { NodeDto, ShareDto } from '@/lib/types';
import { useToast } from './toast';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field } from './ui/field';

const EXPIRY: Array<{ label: string; days: number | null }> = [
  { label: 'Never', days: null },
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

/** Create and revoke public links for a file. The link is shown once; only its hash is stored. */
export function ShareDialog({ node, onClose }: { node: NodeDto | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [days, setDays] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [created, setCreated] = useState<ShareDto | null>(null);
  const [error, setError] = useState('');

  const shares = useQuery({
    queryKey: ['shares', node?.id],
    enabled: node !== null,
    // Download counts change outside this page, so always show fresh numbers when opened.
    staleTime: 0,
    queryFn: () => get<{ items: ShareDto[] }>('/shares', { nodeId: node!.id }),
  });

  const create = useMutation({
    mutationFn: () =>
      post<ShareDto>('/shares', {
        nodeId: node!.id,
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        password: password || null,
      }),
    onSuccess: (share) => {
      setCreated(share);
      setPassword('');
      void qc.invalidateQueries({ queryKey: ['shares', node?.id] });
    },
    onError: (e) => setError(describeError(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => del(`/shares/${id}`),
    onSuccess: () => {
      toast('Link revoked', 'success');
      void qc.invalidateQueries({ queryKey: ['shares', node?.id] });
    },
    onError: (e) => toast(describeError(e), 'error'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password && password.length < 4)
      return setError('Use at least 4 characters for the password.');
    create.mutate();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied', 'success');
    } catch {
      toast('Copy failed. Select the link and copy it manually.', 'error');
    }
  }

  const live = (shares.data?.items ?? []).filter(
    (s) => !s.revokedAt && (!s.expiresAt || new Date(s.expiresAt) > new Date()),
  );

  return (
    <Dialog
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCreated(null);
          setError('');
          onClose();
        }
      }}
      title={node ? `Share "${node.name}"` : 'Share'}
      description="Anyone with the link can download this file until it expires or you revoke it."
    >
      {created?.url && (
        <div className="mb-4 rounded-xl bg-ok-soft p-3 text-sm text-ok">
          <p className="font-medium">Link created</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              readOnly
              aria-label="Share link"
              value={created.url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 py-1.5 text-xs text-fg"
            />
            <Button size="sm" onClick={() => void copy(created.url!)}>
              <Copy size={14} aria-hidden /> Copy
            </Button>
          </div>
          <p className="mt-2 text-xs">
            Copy it now: for security the full link cannot be shown again.
          </p>
        </div>
      )}

      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="expiry" className="block text-sm font-medium">
            Link expires
          </label>
          <select
            id="expiry"
            value={days ?? ''}
            onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}
            className="h-10 w-full rounded-lg border border-line bg-bg px-3 text-sm"
          >
            {EXPIRY.map((o) => (
              <option key={o.label} value={o.days ?? ''}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Password (optional)"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error || undefined}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending}>
            Create link
          </Button>
        </div>
      </form>

      <section aria-label="Existing links" className="mt-6">
        <h3 className="mb-2 text-sm font-medium">Active links ({live.length})</h3>
        {live.length === 0 ? (
          <p className="text-sm text-muted">No active links.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {live.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p>
                    {s.passwordProtected ? 'Password protected' : 'Open link'} · {s.downloadCount}{' '}
                    {s.downloadCount === 1 ? 'download' : 'downloads'}
                  </p>
                  <p className="text-xs text-muted">
                    Created {formatDateTime(s.createdAt)} ·{' '}
                    {s.expiresAt ? `expires ${formatDateTime(s.expiresAt)}` : 'never expires'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Revoke link created ${formatDateTime(s.createdAt)}`}
                  onClick={() => revoke.mutate(s.id)}
                >
                  <Link2Off size={14} aria-hidden /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Dialog>
  );
}
