import { drive as createDrive, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ProviderUnavailableError, RemoteNotFoundError, StorageError } from './errors.js';
import { isRetryableGoogleError, mapGoogleError } from './google-errors.js';
import { ResumableUploader } from './google-resumable.js';
import type { ByteRange, Quota, StorageProvider } from './provider.js';
import { retry, Semaphore, type RetryOptions } from './resilience.js';

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];

export interface GoogleDriveProviderOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Id of this app's folder in the account; all blobs live inside it. */
  appFolderId: string;
  /** Max concurrent Drive calls for this account. */
  concurrency?: number;
  retry?: Partial<Pick<RetryOptions, 'retries' | 'baseMs' | 'maxMs'>>;
}

/** Drive v3 backed provider. Blobs are named by random UUIDs; real file names never reach Drive. */
export class GoogleDriveProvider implements StorageProvider {
  private readonly drive: drive_v3.Drive;
  private readonly auth: OAuth2Client;
  private readonly slots: Semaphore;
  private readonly retryOpts: Pick<RetryOptions, 'retries' | 'baseMs' | 'maxMs'>;
  private readonly uploader: ResumableUploader;

  constructor(private readonly options: GoogleDriveProviderOptions) {
    this.auth = new OAuth2Client(options.clientId, options.clientSecret);
    this.auth.setCredentials({ refresh_token: options.refreshToken });
    this.drive = createDrive({ version: 'v3', auth: this.auth });
    this.slots = new Semaphore(options.concurrency ?? 4);
    this.retryOpts = { retries: 5, baseMs: 500, maxMs: 30_000, ...options.retry };
    this.uploader = new ResumableUploader({
      fetch,
      accessToken: async () => {
        const { token } = await this.auth.getAccessToken();
        if (!token) throw new ProviderUnavailableError('Could not obtain a Google access token');
        return token;
      },
      retry: this.retryOpts,
    });
  }

  /** Run a Drive call with a concurrency slot, backoff on rate limits, and error translation. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.slots.run(() =>
        retry(fn, { ...this.retryOpts, shouldRetry: isRetryableGoogleError }),
      );
    } catch (err) {
      throw mapGoogleError(err);
    }
  }

  async allocateId(): Promise<string> {
    const res = await this.call(() => this.drive.files.generateIds({ count: 1, space: 'drive' }));
    return res.data.ids?.[0] ?? randomUUID();
  }

  async upload(remoteId: string, data: Readable, size: number): Promise<{ size: number }> {
    try {
      await this.slots.run(() =>
        this.uploader.upload(
          { id: remoteId, name: randomUUID(), parentId: this.options.appFolderId },
          data,
          size,
        ),
      );
    } catch (err) {
      throw mapGoogleError(err);
    }
    return { size };
  }

  async download(remoteId: string, range?: ByteRange): Promise<Readable> {
    const res = await this.call(() =>
      this.drive.files.get(
        { fileId: remoteId, alt: 'media' },
        {
          responseType: 'stream',
          headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
        },
      ),
    );
    return res.data as unknown as Readable;
  }

  async delete(remoteId: string): Promise<void> {
    try {
      await this.call(() => this.drive.files.delete({ fileId: remoteId }));
    } catch (err) {
      if (!(err instanceof RemoteNotFoundError)) throw err;
    }
  }

  async getQuota(): Promise<Quota> {
    const res = await this.call(() => this.drive.about.get({ fields: 'storageQuota' }));
    const quota = res.data.storageQuota;
    if (!quota?.usage) throw new StorageError('Google did not return storage quota');
    // Accounts without a cap (some Workspace plans) omit `limit`.
    return {
      limit: quota.limit ? Number(quota.limit) : Number.MAX_SAFE_INTEGER,
      usage: Number(quota.usage),
    };
  }

  async healthCheck(): Promise<void> {
    await this.call(() => this.drive.about.get({ fields: 'user(emailAddress)' }));
  }
}
