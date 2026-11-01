import {
  ProviderAuthError,
  ProviderUnavailableError,
  RemoteNotFoundError,
  StorageError,
} from './errors.js';

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface GoogleLikeError {
  code?: number | string;
  status?: number;
  response?: {
    status?: number;
    data?: { error?: string | { errors?: Array<{ reason?: string }> } };
  };
  errors?: Array<{ reason?: string }>;
}

function statusOf(err: GoogleLikeError): number | undefined {
  const raw = err.response?.status ?? err.status ?? err.code;
  return typeof raw === 'number' ? raw : undefined;
}

function reasonsOf(err: GoogleLikeError): string[] {
  const data = err.response?.data?.error;
  const nested = typeof data === 'object' ? (data?.errors ?? []) : [];
  return [...(err.errors ?? []), ...nested].map((e) => e.reason ?? '');
}

/** True for failures worth retrying with backoff: rate limits, 5xx and transport errors. */
export function isRetryableGoogleError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as GoogleLikeError;
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  const status = statusOf(e);
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return status === 403 && reasonsOf(e).some((r) => RATE_LIMIT_REASONS.has(r));
}

/** Translate a raw Google/gaxios error into the provider-agnostic error types. */
export function mapGoogleError(err: unknown): Error {
  if (err instanceof StorageError) return err;
  const e = (err ?? {}) as GoogleLikeError;
  const message = err instanceof Error ? err.message : 'Google API error';
  const oauthError = e.response?.data?.error;
  if (oauthError === 'invalid_grant' || statusOf(e) === 401) {
    return new ProviderAuthError(
      'Google authorisation was revoked or expired; re-authorise the account',
    );
  }
  const status = statusOf(e);
  if (status === 404) return new RemoteNotFoundError(message);
  if (isRetryableGoogleError(err)) return new ProviderUnavailableError(message);
  return new StorageError(message);
}
