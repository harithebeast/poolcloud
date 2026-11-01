import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { IntegrityError } from './errors.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export const GCM_TAG_BYTES = TAG_BYTES;

function seal(key: Buffer, plaintext: Buffer, aad: string): { nonce: Buffer; data: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, data: Buffer.concat([ciphertext, cipher.getAuthTag()]) };
}

function open(key: Buffer, nonce: Buffer, data: Buffer, aad: string): Buffer {
  if (data.length < TAG_BYTES) throw new IntegrityError('ciphertext is shorter than the auth tag');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    // Deliberately generic: never reveal key material or partial plaintext.
    throw new IntegrityError('authentication failed: data was modified or the wrong key was used');
  }
}

export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * AAD binding a chunk to its file, position and whether it is the final chunk. Blocks reordering,
 * cross-file splicing and truncation without needing the chunk count up front (chunk sizes adapt).
 */
export function chunkAad(fileId: string, index: number, isLast: boolean): string {
  return `chunk|${fileId}|${index}|${isLast ? 'last' : 'more'}`;
}

export function encryptChunk(dek: Buffer, plaintext: Buffer, aad: string) {
  return seal(dek, plaintext, aad);
}

export function decryptChunk(dek: Buffer, nonce: Buffer, data: Buffer, aad: string): Buffer {
  return open(dek, nonce, data, aad);
}

export interface WrappedKey {
  keyId: string;
  /** base64(nonce | ciphertext | tag) */
  wrapped: string;
}

/** Master keys from env (`kid:base64,kid2:base64`). The first entry is active; others only unwrap. */
export class KeyRing {
  private constructor(
    private readonly keys: Map<string, Buffer>,
    readonly activeKeyId: string,
  ) {}

  static parse(spec: string): KeyRing {
    const keys = new Map<string, Buffer>();
    let active: string | undefined;
    for (const entry of spec.split(',')) {
      const sep = entry.indexOf(':');
      const kid = entry.slice(0, sep);
      const key = Buffer.from(entry.slice(sep + 1), 'base64');
      if (sep < 1 || key.length !== KEY_BYTES) throw new Error('Invalid master key entry');
      if (keys.has(kid)) throw new Error(`Duplicate master key id ${kid}`);
      keys.set(kid, key);
      active ??= kid;
    }
    if (!active) throw new Error('No master keys configured');
    return new KeyRing(keys, active);
  }

  wrap(dek: Buffer, fileId: string): WrappedKey {
    const { nonce, data } = seal(this.get(this.activeKeyId), dek, `dek|${fileId}`);
    return { keyId: this.activeKeyId, wrapped: Buffer.concat([nonce, data]).toString('base64') };
  }

  unwrap(key: WrappedKey, fileId: string): Buffer {
    const raw = Buffer.from(key.wrapped, 'base64');
    return open(
      this.get(key.keyId),
      raw.subarray(0, NONCE_BYTES),
      raw.subarray(NONCE_BYTES),
      `dek|${fileId}`,
    );
  }

  private get(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new IntegrityError(`Unknown master key id ${keyId}`);
    return key;
  }
}
