import { SizeMismatchError } from './errors.js';

/**
 * Pulls exact-length slices from an async byte source without buffering more than one source piece.
 * Lets the upload pipeline split an arbitrarily large stream into chunks with bounded memory.
 */
export class ByteReader {
  private readonly iterator: AsyncIterator<Buffer | string>;
  private pending: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Buffer | string>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** Yield exactly `length` bytes in source-sized pieces; throws if the source ends early. */
  async *take(length: number): AsyncGenerator<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      if (this.pending.length === 0 && !(await this.fill())) {
        throw new SizeMismatchError(`stream ended ${remaining} bytes before the declared size`);
      }
      const piece = this.pending.subarray(0, remaining);
      this.pending = this.pending.subarray(piece.length);
      remaining -= piece.length;
      yield piece;
    }
  }

  /** Buffer exactly `length` bytes. Only for bounded lengths (one chunk). */
  async readExact(length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const piece of this.take(length)) parts.push(piece);
    return Buffer.concat(parts, length);
  }

  /** Throws if the source still has data (client sent more than it declared). */
  async assertEnd(): Promise<void> {
    if (this.pending.length > 0 || (await this.fill())) {
      throw new SizeMismatchError('stream is longer than the declared size');
    }
  }

  private async fill(): Promise<boolean> {
    while (!this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        return false;
      }
      const buf = typeof next.value === 'string' ? Buffer.from(next.value) : next.value;
      if (buf.length > 0) {
        this.pending = buf;
        return true;
      }
    }
    return false;
  }
}
