'use client';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Folder } from 'lucide-react';
import { useEffect, useState } from 'react';
import { get } from '@/lib/api';
import type { Crumb, NodeDto } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

/** Pick a destination by walking the folder tree. Folders being moved cannot be entered. */
export function MoveDialog({
  items,
  onClose,
  onMove,
}: {
  items: NodeDto[] | null;
  onClose: () => void;
  onMove: (parentId: string | null) => Promise<unknown>;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = items !== null;
  const moving = new Set((items ?? []).map((i) => i.id));

  useEffect(() => {
    if (open) setFolderId(null);
  }, [open]);

  const children = useQuery({
    queryKey: ['files', folderId],
    enabled: open,
    queryFn: () => get<{ items: NodeDto[] }>('/files', { parentId: folderId }),
  });
  const here = useQuery({
    queryKey: ['node', folderId],
    enabled: open && folderId !== null,
    queryFn: () => get<{ node: NodeDto; path: Crumb[] }>(`/files/${folderId}`),
  });

  const folders = (children.data?.items ?? []).filter(
    (n) => n.type === 'folder' && !moving.has(n.id),
  );
  const path = folderId && here.data ? here.data.path : [];
  const sameParent = items?.every((i) => i.parentId === folderId) ?? false;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        items && items.length === 1
          ? `Move "${items[0]!.name}"`
          : `Move ${items?.length ?? 0} items`
      }
      description="Choose a destination folder."
    >
      <nav aria-label="Destination" className="mb-2 flex flex-wrap items-center gap-1 text-sm">
        <button
          className="rounded px-1 py-0.5 hover:bg-surface-hover"
          onClick={() => setFolderId(null)}
        >
          My files
        </button>
        {path.map((c) => (
          <span key={c.id} className="flex items-center gap-1">
            <ChevronRight size={14} aria-hidden className="text-muted" />
            <button
              className="rounded px-1 py-0.5 hover:bg-surface-hover"
              onClick={() => setFolderId(c.id)}
            >
              {c.name}
            </button>
          </span>
        ))}
      </nav>

      <ul className="h-56 overflow-auto rounded-xl border border-line">
        {children.isPending ? (
          <li className="p-3 text-sm text-muted">Loading…</li>
        ) : folders.length === 0 ? (
          <li className="p-3 text-sm text-muted">No folders here.</li>
        ) : (
          folders.map((f) => (
            <li key={f.id}>
              <button
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover"
                onClick={() => setFolderId(f.id)}
              >
                <Folder size={18} aria-hidden className="text-muted" />
                <span className="truncate">{f.name}</span>
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy || sameParent}
          onClick={async () => {
            setBusy(true);
            try {
              await onMove(folderId);
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          Move here
        </Button>
      </div>
    </Dialog>
  );
}
