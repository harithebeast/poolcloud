'use client';
import * as Progress from '@radix-ui/react-progress';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '@/lib/format';
import { useUploads, type UploadItem } from './upload-manager';
import { Button } from './ui/button';

/** Bottom-right progress list, like Google Drive's. Hidden when there is nothing to show. */
export function UploadPanel() {
  const { items, cancel, retry, clearFinished } = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (items.length === 0) return null;

  const active = items.filter((i) => i.status === 'queued' || i.status === 'uploading').length;
  const failed = items.filter((i) => i.status === 'error').length;
  const heading =
    active > 0
      ? `Uploading ${active} ${active === 1 ? 'item' : 'items'}`
      : failed > 0
        ? `${failed} upload${failed === 1 ? '' : 's'} failed`
        : 'Uploads complete';

  return (
    <section
      aria-label="Uploads"
      className="fixed bottom-4 right-4 z-30 w-80 overflow-hidden rounded-xl border border-line bg-bg shadow-xl"
    >
      <header className="flex items-center justify-between bg-surface px-4 py-2">
        <h2 className="text-sm font-medium" aria-live="polite">
          {heading}
        </h2>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 px-0"
            aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
          </Button>
          {active === 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 px-0"
              aria-label="Dismiss uploads"
              onClick={clearFinished}
            >
              <X size={16} aria-hidden />
            </Button>
          )}
        </div>
      </header>
      {!collapsed && (
        <ul className="max-h-72 divide-y divide-line overflow-auto">
          {items.map((item) => (
            <Row key={item.id} item={item} onCancel={cancel} onRetry={retry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  item,
  onCancel,
  onRetry,
}: {
  item: UploadItem;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const pct = item.size === 0 ? (item.status === 'done' ? 100 : 0) : Math.round((item.loaded / item.size) * 100);
  return (
    <li className="px-4 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate" title={item.name}>
          {item.name}
        </span>
        {item.status === 'done' && <CheckCircle2 size={16} className="text-ok" aria-label="Done" />}
        {item.status === 'error' && (
          <>
            <AlertCircle size={16} className="text-danger" aria-label="Failed" />
            <button
              className="rounded p-1 hover:bg-surface-hover"
              aria-label={`Retry ${item.name}`}
              onClick={() => onRetry(item.id)}
            >
              <RotateCcw size={14} aria-hidden />
            </button>
          </>
        )}
        {(item.status === 'queued' || item.status === 'uploading') && (
          <button
            className="rounded p-1 hover:bg-surface-hover"
            aria-label={`Cancel ${item.name}`}
            onClick={() => onCancel(item.id)}
          >
            <X size={14} aria-hidden />
          </button>
        )}
      </div>
      {item.status === 'uploading' || item.status === 'queued' ? (
        <>
          <Progress.Root
            value={pct}
            aria-label={`Uploading ${item.name}`}
            className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-hover"
          >
            <Progress.Indicator className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </Progress.Root>
          <p className="mt-1 text-xs text-muted">
            {item.status === 'queued' ? 'Waiting…' : `${formatBytes(item.loaded)} of ${formatBytes(item.size)}`}
          </p>
        </>
      ) : (
        <p className={item.status === 'error' ? 'mt-1 text-xs text-danger' : 'mt-1 text-xs text-muted'}>
          {item.status === 'error'
            ? item.error
            : item.status === 'cancelled'
              ? 'Cancelled'
              : formatBytes(item.size)}
        </p>
      )}
    </li>
  );
}
