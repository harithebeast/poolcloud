'use client';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, describeError, getCsrfToken, url } from '@/lib/api';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  parentId: string | null;
  encrypt: boolean;
  status: UploadStatus;
  /** Bytes sent so far. */
  loaded: number;
  error?: string;
}

interface Internal extends UploadItem {
  file: File;
  /** Reused on retry so a request that actually succeeded is never stored twice. */
  key: string;
}

interface Manager {
  items: UploadItem[];
  enqueue: (files: File[], parentId: string | null, encrypt: boolean) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  clearFinished: () => void;
}

const Ctx = createContext<Manager | null>(null);
export const useUploads = () => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useUploads must be used inside <UploadProvider>');
  return ctx;
};

const CONCURRENCY = 2;

export function UploadProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [items, setItems] = useState<Internal[]>([]);
  const xhrs = useRef(new Map<string, XMLHttpRequest>());

  const patch = useCallback((id: string, change: Partial<Internal>) => {
    setItems((all) => all.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }, []);

  const start = useCallback(
    (item: Internal) => {
      const xhr = new XMLHttpRequest();
      xhrs.current.set(item.id, xhr);
      xhr.open(
        'POST',
        url('/files/upload', {
          name: item.name,
          parentId: item.parentId,
          // Only send an explicit choice when asked to encrypt; otherwise the folder's setting applies.
          encrypt: item.encrypt ? true : undefined,
        }),
      );
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Idempotency-Key', item.key);
      xhr.setRequestHeader('X-CSRF-Token', getCsrfToken());
      xhr.upload.onprogress = (e) => patch(item.id, { loaded: e.loaded });
      xhr.onload = () => {
        xhrs.current.delete(item.id);
        if (xhr.status === 201) {
          patch(item.id, { status: 'done', loaded: item.size });
          void qc.invalidateQueries({ queryKey: ['files'] });
          void qc.invalidateQueries({ queryKey: ['usage'] });
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(xhr.responseText) as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
        const err = new ApiError(
          xhr.status,
          typeof body.code === 'string' ? body.code : 'error',
          typeof body.message === 'string' ? body.message : `Upload failed (${xhr.status})`,
          body,
        );
        patch(item.id, { status: 'error', error: describeError(err) });
      };
      xhr.onerror = () => {
        xhrs.current.delete(item.id);
        patch(item.id, { status: 'error', error: 'Connection lost. Retry to continue.' });
      };
      xhr.onabort = () => xhrs.current.delete(item.id);
      xhr.send(item.file);
    },
    [patch, qc],
  );

  // Start queued uploads whenever a slot frees up.
  useEffect(() => {
    const active = items.filter((i) => i.status === 'uploading').length;
    const next = items.filter((i) => i.status === 'queued').slice(0, CONCURRENCY - active);
    for (const item of next) {
      if (xhrs.current.has(item.id)) continue; // already started (effects can run twice)
      patch(item.id, { status: 'uploading' });
      start(item);
    }
  }, [items, patch, start]);

  // Warn before leaving the page while something is still uploading.
  useEffect(() => {
    const busy = items.some((i) => i.status === 'uploading' || i.status === 'queued');
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [items]);

  const value = useMemo<Manager>(
    () => ({
      items,
      enqueue: (files, parentId, encrypt) =>
        setItems((all) => [
          ...all,
          ...files.map<Internal>((file) => ({
            id: crypto.randomUUID(),
            key: crypto.randomUUID(),
            file,
            name: file.name,
            size: file.size,
            parentId,
            encrypt,
            status: 'queued',
            loaded: 0,
          })),
        ]),
      cancel: (id) => {
        xhrs.current.get(id)?.abort();
        patch(id, { status: 'cancelled' });
      },
      retry: (id) => patch(id, { status: 'queued', loaded: 0, error: undefined }),
      clearFinished: () =>
        setItems((all) => all.filter((i) => i.status === 'queued' || i.status === 'uploading')),
    }),
    [items, patch],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
