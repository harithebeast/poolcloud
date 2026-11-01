'use client';
import { useQuery } from '@tanstack/react-query';
import { Lock, LockOpen, Mail, TriangleAlert, X } from 'lucide-react';
import { get } from '@/lib/api';
import { formatBytes, formatDateTime, kindOf } from '@/lib/format';
import type { Crumb, NodeDto, StoredIn } from '@/lib/types';
import { FileIcon } from './file-icon';
import { Button } from './ui/button';

const KIND_LABEL = {
  folder: 'Folder',
  image: 'Image',
  pdf: 'PDF document',
  text: 'Text',
  video: 'Video',
  audio: 'Audio',
  archive: 'Archive',
  file: 'File',
} as const;

/**
 * Facts about the selected item. For the admin it also says which Gmail account(s) hold a file;
 * the API sends that to the admin only, so everyone else simply never sees the section.
 */
export function DetailsPanel({
  node,
  location,
  count,
  onClose,
}: {
  node: NodeDto | null;
  location: string;
  /** How many items are selected (the panel describes one). */
  count: number;
  onClose: () => void;
}) {
  return (
    <aside aria-label="Details" className="w-72 shrink-0 overflow-auto border-l border-line p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium">Details</h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 px-0"
          aria-label="Close details"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </Button>
      </div>
      {count > 1 ? (
        <p className="text-sm text-muted">{count} items selected</p>
      ) : !node ? (
        <p className="text-sm text-muted">Select a file or folder to see its details.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <FileIcon mime={node.mime} type={node.type} size={32} />
            <p className="break-all text-sm font-medium">{node.name}</p>
          </div>
          {node.unavailable && (
            <p role="alert" className="flex gap-2 rounded-lg bg-warn-soft p-3 text-xs text-warn">
              <TriangleAlert size={16} aria-hidden className="shrink-0" />
              Unavailable: a Google account holding part of this file is offline.
            </p>
          )}
          <dl className="space-y-3 text-sm">
            <Row label="Type" value={KIND_LABEL[kindOf(node.mime, node.type)]} />
            {node.type === 'file' && <Row label="Size" value={formatBytes(node.size)} />}
            <Row label="Location" value={location} />
            <Row label="Modified" value={formatDateTime(node.updatedAt)} />
            <Row label="Created" value={formatDateTime(node.createdAt)} />
            {node.type === 'file' && <StoredInRow fileId={node.id} />}
            <div>
              <dt className="text-xs text-muted">Protection</dt>
              <dd className="mt-0.5 flex items-center gap-1.5">
                {node.type === 'folder' ? (
                  node.encryptByDefault ? (
                    <>
                      <Lock size={14} aria-hidden /> New files are encrypted
                    </>
                  ) : (
                    <>
                      <LockOpen size={14} aria-hidden /> New files are not encrypted by default
                    </>
                  )
                ) : node.encrypted ? (
                  <>
                    <Lock size={14} aria-hidden /> Encrypted (AES-256-GCM)
                  </>
                ) : (
                  <>
                    <LockOpen size={14} aria-hidden /> Not encrypted
                  </>
                )}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 break-words">{value}</dd>
    </div>
  );
}

function StoredInRow({ fileId }: { fileId: string }) {
  const q = useQuery({
    queryKey: ['node', fileId],
    queryFn: () => get<{ node: NodeDto; path: Crumb[]; storedIn?: StoredIn[] }>(`/files/${fileId}`),
    // Accounts can go offline at any time, so always show the current state.
    staleTime: 0,
  });
  const where = q.data?.storedIn;
  if (!where || where.length === 0) return null;
  return (
    <div>
      <dt className="text-xs text-muted">Stored in</dt>
      <dd className="mt-0.5 space-y-1.5">
        {where.map((w) => (
          <div key={w.accountId} className="flex items-start gap-1.5">
            <Mail size={14} aria-hidden className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="break-all">{w.email}</p>
              <p className="text-xs text-muted">
                {where.length === 1
                  ? 'Whole file'
                  : `${w.parts} ${w.parts === 1 ? 'part' : 'parts'}`}
                {' · '}
                {formatBytes(w.bytes)}
                {w.status !== 'HEALTHY' && w.status !== 'DRAINING' ? ' · offline' : ''}
              </p>
            </div>
          </div>
        ))}
        {where.length > 1 && (
          <p className="text-xs text-muted">
            Split across {where.length} accounts. If any one is offline, this file cannot be opened
            until it is reconnected.
          </p>
        )}
      </dd>
    </div>
  );
}
