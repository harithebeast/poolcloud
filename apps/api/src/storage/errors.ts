/** Base class so callers can tell storage-domain failures from programming errors. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Credentials revoked/expired. The account must be re-authorised; never retried. */
export class ProviderAuthError extends StorageError {}

/** Transient provider failure (network, 5xx, rate limit after retries). */
export class ProviderUnavailableError extends StorageError {}

export class RemoteNotFoundError extends StorageError {}

export class InsufficientCapacityError extends StorageError {
  constructor(
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Not enough free space in the pool: need ${requested} bytes, ${available} available`);
  }
}

/** Some chunk lives on an account that is not currently usable. */
export class FileUnavailableError extends StorageError {
  constructor(
    readonly fileId: string,
    readonly unavailableAccountIds: string[],
  ) {
    super(
      `File ${fileId} is temporarily unavailable: ${unavailableAccountIds.length} storage account(s) holding its data are offline`,
    );
  }
}

/** Stored bytes do not match the recorded checksum, or authenticated decryption failed. */
export class IntegrityError extends StorageError {}

export class SizeMismatchError extends StorageError {}
