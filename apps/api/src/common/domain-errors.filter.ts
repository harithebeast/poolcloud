import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidLinkStateError } from '../accounts/accounts.service.js';
import { LinkError } from '../accounts/link-backend.js';
import { IdempotencyMismatchError, UploadInProgressError } from '../files/files.service.js';
import {
  InvalidMoveError,
  InvalidNameError,
  NameConflictError,
  NotFoundError,
} from '../fs/fs.service.js';
import {
  FileUnavailableError,
  InsufficientCapacityError,
  IntegrityError,
  ProviderAuthError,
  ProviderUnavailableError,
  SizeMismatchError,
} from '../storage/errors.js';
import { RangeNotSupportedError } from '../storage/download-service.js';

interface Mapped {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Translate domain errors into stable HTTP responses. Unknown errors become an opaque 500. */
export function mapDomainError(err: unknown): Mapped | null {
  if (err instanceof NotFoundError) return { status: 404, code: 'not_found', message: err.message };
  if (err instanceof NameConflictError)
    return { status: 409, code: 'name_conflict', message: err.message };
  if (err instanceof InvalidNameError || err instanceof InvalidMoveError)
    return { status: 400, code: 'invalid_request', message: err.message };
  if (err instanceof UploadInProgressError)
    return { status: 409, code: 'upload_in_progress', message: err.message };
  if (err instanceof IdempotencyMismatchError)
    return { status: 422, code: 'idempotency_mismatch', message: err.message };
  if (err instanceof InsufficientCapacityError) {
    return {
      status: 507,
      code: 'insufficient_storage',
      message: 'Not enough free space across your linked accounts',
      details: { requested: err.requested, available: err.available },
    };
  }
  if (err instanceof FileUnavailableError) {
    return {
      status: 503,
      code: 'file_unavailable',
      message:
        'This file is unavailable because a Google account that holds part of it is offline. Re-authorise the account to restore access.',
    };
  }
  if (err instanceof SizeMismatchError)
    return {
      status: 400,
      code: 'size_mismatch',
      message: 'Uploaded data did not match the declared size',
    };
  if (err instanceof RangeNotSupportedError)
    return { status: 416, code: 'range_not_supported', message: err.message };
  if (err instanceof IntegrityError)
    return {
      status: 500,
      code: 'integrity_error',
      message: 'The stored data failed its integrity check and was not delivered',
    };
  if (err instanceof ProviderAuthError || err instanceof ProviderUnavailableError)
    return {
      status: 502,
      code: 'storage_unavailable',
      message: 'A storage account could not be reached. Try again shortly.',
    };
  if (err instanceof InvalidLinkStateError || err instanceof LinkError)
    return { status: 400, code: 'link_failed', message: err.message };
  return null;
}

@Catch()
export class DomainErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest>();
    if (reply.sent) return;

    if (err instanceof HttpException) {
      const body = err.getResponse();
      void reply
        .status(err.getStatus())
        .send(typeof body === 'string' ? { statusCode: err.getStatus(), message: body } : body);
      return;
    }
    const mapped = mapDomainError(err);
    if (mapped) {
      // 503/507 are expected operating conditions (an account is offline, the pool is full).
      const expected = mapped.status === 503 || mapped.status === 507;
      if (mapped.status >= 500) {
        (expected ? this.log.warn : this.log.error).call(this.log, { reqId: req.id }, mapped.code);
      }
      void reply.status(mapped.status).send({
        statusCode: mapped.status,
        code: mapped.code,
        message: mapped.message,
        ...mapped.details,
      });
      return;
    }
    // Never leak internals (SQL, stack traces, provider messages) to clients.
    this.log.error({ err, reqId: req.id }, 'unhandled error');
    void reply
      .status(500)
      .send({ statusCode: 500, code: 'internal_error', message: 'Internal server error' });
  }
}
