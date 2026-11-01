'use client';
import { useQuery } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FileIcon } from '@/components/file-icon';
import { useToast } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { del, describeError, get } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import type { NodeDto } from '@/lib/types';
import { useFileActions } from '@/lib/use-file-actions';

export default function TrashPage() {
  const actions = useFileActions();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'empty' | NodeDto | null>(null);
  const trash = useQuery({
    queryKey: ['trash'],
    queryFn: () => get<{ items: NodeDto[] }>('/trash'),
  });
  const items = trash.data?.items ?? [];
  const target = confirm !== null && confirm !== 'empty' ? confirm : null;

  return (
    <div className="p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-medium">Trash</h1>
          <p className="text-sm text-muted">Items are deleted forever after 30 days.</p>
        </div>
        <Button variant="outline" disabled={items.length === 0} onClick={() => setConfirm('empty')}>
          <Trash2 size={16} aria-hidden /> Empty trash
        </Button>
      </div>

      {trash.isPending ? (
        <p className="text-sm text-muted" role="status">
          Loading…
        </p>
      ) : trash.isError ? (
        <p role="alert" className="text-sm text-danger">
          {describeError(trash.error)}
        </p>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-muted">Trash is empty.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {items.map((n) => (
            <li key={n.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <FileIcon mime={n.mime} type={n.type} />
              <span className="min-w-0 flex-1 truncate" title={n.name}>
                {n.name}
              </span>
              <span className="hidden text-muted sm:inline">
                {n.type === 'file' ? formatBytes(n.size) : 'Folder'} · deleted{' '}
                {n.trashedAt ? formatDate(n.trashedAt) : ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void actions.restore([n])}
                aria-label={`Restore ${n.name}`}
              >
                <RotateCcw size={14} aria-hidden /> Restore
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirm(n)}
                aria-label={`Delete ${n.name} forever`}
              >
                <Trash2 size={14} aria-hidden /> Delete forever
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'empty' ? 'Empty trash?' : 'Delete forever?'}
        description={
          confirm === 'empty'
            ? 'Everything in the trash will be permanently deleted. This cannot be undone.'
            : `"${target?.name ?? ''}" will be permanently deleted. This cannot be undone.`
        }
        confirmLabel={confirm === 'empty' ? 'Empty trash' : 'Delete forever'}
        onConfirm={async () => {
          try {
            if (confirm === 'empty') {
              await del('/trash');
              await actions.refresh();
              toast('Trash emptied', 'success');
            } else if (confirm) {
              await actions.purge([confirm]);
            }
          } catch (e) {
            toast(describeError(e), 'error');
          }
        }}
      />
    </div>
  );
}
