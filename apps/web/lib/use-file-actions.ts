'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useToast } from '@/components/toast';
import { contentUrl, del, describeError, patch, post } from './api';
import type { NodeDto } from './types';

/** Mutations shared by the file browser, search results and the trash page. */
export function useFileActions() {
  const qc = useQueryClient();
  const toast = useToast();

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['files'] }),
      qc.invalidateQueries({ queryKey: ['trash'] }),
      qc.invalidateQueries({ queryKey: ['node'] }),
      qc.invalidateQueries({ queryKey: ['usage'] }),
    ]);
  }, [qc]);

  /** Run an action for a batch; report failures once instead of one toast per item. */
  const batch = useCallback(
    async (items: NodeDto[], run: (n: NodeDto) => Promise<unknown>, done: string) => {
      const results = await Promise.allSettled(items.map(run));
      await refresh();
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length === 0) toast(done, 'success');
      else toast(describeError(failed[0]!.reason), 'error');
      return failed.length === 0;
    },
    [refresh, toast],
  );

  return {
    refresh,
    trash: (items: NodeDto[]) =>
      batch(
        items,
        (n) => del(`/files/${n.id}`),
        items.length === 1
          ? `Moved "${items[0]!.name}" to the trash`
          : `Moved ${items.length} items to the trash`,
      ),
    move: (items: NodeDto[], parentId: string | null) =>
      batch(
        items,
        (n) => patch(`/files/${n.id}`, { parentId }),
        items.length === 1 ? 'Moved' : `Moved ${items.length} items`,
      ),
    rename: async (n: NodeDto, name: string) => {
      await patch<NodeDto>(`/files/${n.id}`, { name });
      await refresh();
    },
    setEncryptByDefault: async (n: NodeDto, value: boolean) => {
      await patch<NodeDto>(`/files/${n.id}`, { encryptByDefault: value });
      await refresh();
      toast(
        value
          ? 'New files in this folder will be encrypted'
          : 'New files in this folder are no longer encrypted by default',
        'success',
      );
    },
    restore: (items: NodeDto[]) =>
      batch(
        items,
        (n) => post(`/trash/${n.id}/restore`),
        items.length === 1 ? 'Restored' : `Restored ${items.length} items`,
      ),
    purge: (items: NodeDto[]) => batch(items, (n) => del(`/trash/${n.id}`), 'Deleted forever'),
    /** Downloads go straight to the API as a normal navigation, so the browser streams them to disk. */
    download: (n: NodeDto) => {
      if (n.unavailable) {
        toast(
          'This file is unavailable because a Google account that holds part of it is offline. Re-authorise it on the Storage page.',
          'error',
        );
        return;
      }
      const a = document.createElement('a');
      a.href = contentUrl(n.id, true);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  };
}
