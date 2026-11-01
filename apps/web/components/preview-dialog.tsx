'use client';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useEffect } from 'react';
import { contentUrl } from '@/lib/api';
import { formatBytes, kindOf } from '@/lib/format';
import type { NodeDto } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * Previews images, PDFs, text, video and audio served by the API (which only labels inline-safe
 * types as previewable). Left/right arrow keys move between the previewable files in the folder.
 */
export function PreviewDialog({
  items,
  index,
  onIndexChange,
  onClose,
  onDownload,
}: {
  items: NodeDto[];
  index: number | null;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  onDownload: (n: NodeDto) => void;
}) {
  const node = index === null ? null : (items[index] ?? null);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && index < items.length - 1) onIndexChange(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onIndexChange]);

  return (
    <Dialog
      open={node !== null}
      onOpenChange={(open) => !open && onClose()}
      title={node?.name ?? 'Preview'}
      description={node ? formatBytes(node.size) : undefined}
      wide
    >
      {node && (
        <div>
          <div className="flex min-h-[50vh] items-center justify-center rounded-xl bg-surface p-2">
            <Body node={node} />
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous file"
                disabled={index === 0}
                onClick={() => onIndexChange(index! - 1)}
              >
                <ChevronLeft size={18} aria-hidden />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next file"
                disabled={index === items.length - 1}
                onClick={() => onIndexChange(index! + 1)}
              >
                <ChevronRight size={18} aria-hidden />
              </Button>
            </div>
            <Button onClick={() => onDownload(node)}>
              <Download size={16} aria-hidden /> Download
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Body({ node }: { node: NodeDto }) {
  const kind = kindOf(node.mime, node.type);
  const src = contentUrl(node.id);

  if (node.unavailable) {
    return (
      <p role="alert" className="max-w-md p-6 text-center text-sm">
        This file is unavailable because a Google account that holds part of it is offline.
        Re-authorise the account on the Storage page and it will work again.
      </p>
    );
  }
  switch (kind) {
    case 'image':
      return (
        <img src={src} alt={node.name} className="max-h-[65vh] max-w-full rounded object-contain" />
      );
    case 'pdf':
      return <iframe src={src} title={node.name} className="h-[65vh] w-full rounded bg-white" />;
    case 'video':
      return <video src={src} controls className="max-h-[65vh] max-w-full rounded" />;
    case 'audio':
      return <audio src={src} controls className="w-full max-w-md" />;
    case 'text':
      return <TextBody node={node} src={src} />;
    default:
      return (
        <p className="p-6 text-sm text-muted">
          No preview available. Download the file to open it.
        </p>
      );
  }
}

function TextBody({ node, src }: { node: NodeDto; src: string }) {
  const tooBig = node.size > MAX_TEXT_BYTES;
  const q = useQuery({
    queryKey: ['preview-text', node.id, node.updatedAt],
    enabled: !tooBig,
    queryFn: async () => {
      const res = await fetch(src, { credentials: 'include' });
      if (!res.ok) throw new Error(`Could not load the file (${res.status})`);
      return res.text();
    },
  });
  if (tooBig)
    return <p className="p-6 text-sm text-muted">Too large to preview. Download it instead.</p>;
  if (q.isPending) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (q.isError)
    return (
      <p role="alert" className="p-6 text-sm text-danger">
        {q.error.message}
      </p>
    );
  return (
    <pre className="max-h-[65vh] w-full overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-4 text-sm">
      {q.data}
    </pre>
  );
}
