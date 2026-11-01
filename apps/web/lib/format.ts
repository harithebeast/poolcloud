const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export type Kind = 'folder' | 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'archive' | 'file';

export function kindOf(mime: string | null, type: 'file' | 'folder'): Kind {
  if (type === 'folder') return 'folder';
  if (!mime) return 'file';
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/zip') return 'archive';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return 'file';
}

/** What the preview dialog can show. Mirrors the API's allowlist of inline-safe types. */
export function isPreviewable(mime: string | null, type: 'file' | 'folder'): boolean {
  const k = kindOf(mime, type);
  return k === 'image' || k === 'pdf' || k === 'text' || k === 'video' || k === 'audio';
}
