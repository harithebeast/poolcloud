export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  shouldRetry: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0,1); injectable for deterministic tests. */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  return Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.retries || !opts.shouldRetry(err)) throw err;
      await sleep(backoffDelay(attempt, opts.baseMs, opts.maxMs, random));
    }
  }
}

/** Caps concurrent operations (per-account limit for provider calls). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}
