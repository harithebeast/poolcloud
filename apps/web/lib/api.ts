/**
 * Thin client for the PoolDrive API. The browser talks to the API directly (not through Next) so
 * large uploads and downloads stream without an extra hop. Cookies are sent with `credentials`,
 * and every state-changing request carries the per-session CSRF token.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

let csrfToken = '';
export const setCsrfToken = (t: string) => {
  csrfToken = t;
};
export const getCsrfToken = () => csrfToken;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Fired when the session is gone, so the shell can send the user to the login page. */
export const UNAUTHORIZED_EVENT = 'pooldrive:unauthorized';

type Query = Record<string, string | number | boolean | null | undefined>;

export function url(path: string, query?: Query): string {
  const u = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { body?: unknown; query?: Query } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(url(path, opts.query), {
      method,
      headers,
      credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.');
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const message =
      typeof data.message === 'string' ? data.message : `Request failed (${res.status})`;
    throw new ApiError(
      res.status,
      typeof data.code === 'string' ? data.code : 'error',
      message,
      data,
    );
  }
  return data as T;
}

export const get = <T>(path: string, query?: Query) => request<T>('GET', path, { query });
export const post = <T>(path: string, body?: unknown) => request<T>('POST', path, { body });
export const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, { body });
export const del = <T>(path: string) => request<T>('DELETE', path);

export const contentUrl = (id: string, download = false) =>
  url(`/files/${id}/content`, download ? { download: 1 } : undefined);

/** Friendly text for the failures a user can actually act on. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'name_conflict':
        return err.message;
      case 'insufficient_storage':
        return 'Not enough free space in your pool. Link another account or empty the trash.';
      case 'file_unavailable':
        return 'This file is unavailable because a Google account that holds part of it is offline. Re-authorise it on the Storage page.';
      case 'upload_in_progress':
        return 'This upload is already in progress.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
