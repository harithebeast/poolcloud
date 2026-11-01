import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '../auth/tokens.js';

export interface LinkState {
  /** User who started the flow; the callback must come from the same user. */
  uid: string;
  /** Present when re-authorising an existing account. */
  accountId?: string;
  /** Also stored in an httpOnly cookie, binding the flow to this browser. */
  nonce: string;
  exp: number;
}

const sign = (secret: string, body: string) =>
  createHmac('sha256', secret).update(`oauth-state|${body}`).digest('base64url');

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function encodeState(secret: string, state: LinkState): string {
  const body = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** Returns null for anything forged, malformed or expired. */
export function decodeState(secret: string, token: string, now: number): LinkState | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined || !safeEqual(sig, sign(secret, body))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkState;
    if (typeof s.uid !== 'string' || typeof s.nonce !== 'string' || !(s.exp > now)) return null;
    return s;
  } catch {
    return null;
  }
}
