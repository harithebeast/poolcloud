import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque session token handed to the browser. Only its hash is stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** CSRF token bound to the session: HMAC(secret, sessionId). The browser reads it from /auth/me. */
export function csrfTokenFor(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf|${sessionId}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
