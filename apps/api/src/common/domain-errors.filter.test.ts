import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { FileUnavailableError, InsufficientCapacityError } from '../storage/errors.js';
import { DomainErrorsFilter, mapDomainError } from './domain-errors.filter.js';

/** A stand-in for Fastify's reply that records what was sent. */
function run(err: unknown, sent = false) {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const reply = {
    sent,
    status(code: number) {
      out.status = code;
      return this;
    },
    send(body: Record<string, unknown>) {
      out.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ id: 'req-1' }) }),
  } as unknown as ArgumentsHost;
  new DomainErrorsFilter().catch(err, host);
  return out;
}

describe('DomainErrorsFilter', () => {
  it('passes 4xx errors from Fastify and its plugins through (rate limiting must be 429, not 500)', () => {
    const rateLimited = Object.assign(new Error('Rate limit exceeded, retry in 22 seconds'), {
      statusCode: 429,
    });
    expect(run(rateLimited)).toEqual({
      status: 429,
      body: {
        statusCode: 429,
        code: 'rate_limited',
        message: 'Rate limit exceeded, retry in 22 seconds',
      },
    });
    const malformed = Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 });
    expect(run(malformed).status).toBe(400);
  });

  it('keeps nest HTTP exceptions as they are', () => {
    const out = run(new HttpException('nope', HttpStatus.FORBIDDEN));
    expect(out.status).toBe(403);
  });

  it('turns unknown errors, including 5xx ones, into an opaque 500 that leaks nothing', () => {
    for (const err of [
      new Error('select * from users failed: password'),
      Object.assign(new Error('boom'), { statusCode: 503 }),
    ]) {
      const out = run(err);
      expect(out.status).toBe(500);
      expect(JSON.stringify(out.body)).not.toMatch(/select|password|boom/);
    }
  });

  it('maps storage conditions to meaningful statuses', () => {
    expect(run(new InsufficientCapacityError(10, 0)).status).toBe(507);
    expect(run(new FileUnavailableError('f', ['a'])).status).toBe(503);
    expect(mapDomainError(new Error('x'))).toBeNull();
  });

  it('does nothing if a response was already sent', () => {
    expect(run(new Error('late'), true)).toEqual({});
  });
});
