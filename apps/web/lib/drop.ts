import { ApiError, get, post } from './api';
import type { NodeDto } from './types';

export interface Dropped {
  file: File;
  /** Folder names from the dropped root down to the file's folder; empty for loose files. */
  dirs: string[];
}

/** True when the drag carries files from the operating system (not an item from this app). */
export const hasOsFiles = (dt: DataTransfer | null) => Boolean(dt?.types.includes('Files'));

export const MOVE_MIME = 'application/x-pooldrive-ids';
export const hasMoveItems = (dt: DataTransfer | null) => Boolean(dt?.types.includes(MOVE_MIME));

/** Flatten dropped files and folders (recursively) into files with their relative folder path. */
export async function collectDropped(dt: DataTransfer): Promise<Dropped[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => ({ entry: i.webkitGetAsEntry?.() ?? null, file: i.getAsFile() }));

  const out: Dropped[] = [];
  async function walk(entry: FileSystemEntry, dirs: string[]): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      out.push({ file, dirs });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns at most ~100 entries per call, so keep reading until it is empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
          reader.readEntries(res, rej),
        );
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, [...dirs, entry.name]);
      }
    }
  }
  for (const { entry, file } of entries) {
    if (entry) await walk(entry, []);
    else if (file) out.push({ file, dirs: [] });
  }
  return out;
}

/** Get-or-create a child folder, so dropping a folder twice merges instead of failing. */
export async function ensureFolder(parentId: string | null, name: string): Promise<string> {
  try {
    return (await post<NodeDto>('/folders', { name, parentId })).id;
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'name_conflict') throw e;
    const { items } = await get<{ items: NodeDto[] }>('/files', { parentId });
    const existing = items.find((n) => n.type === 'folder' && n.name === name);
    if (!existing) throw e;
    return existing.id;
  }
}
