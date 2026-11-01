/** Minimal counter store so the throttle runs on Redis in production and in memory in tests. */
export interface CounterStore {
  /** Increments and returns the new count; the key expires `ttlSeconds` after the first hit. */
  hit(key: string, ttlSeconds: number): Promise<number>;
  reset(key: string): Promise<void>;
}

export class MemoryCounterStore implements CounterStore {
  private readonly entries = new Map<string, { count: number; expires: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, ttlSeconds: number): Promise<number> {
    const e = this.entries.get(key);
    if (!e || e.expires <= this.now()) {
      this.entries.set(key, { count: 1, expires: this.now() + ttlSeconds * 1000 });
      return Promise.resolve(1);
    }
    e.count += 1;
    return Promise.resolve(e.count);
  }

  reset(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

export interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
}

export class RedisCounterStore implements CounterStore {
  constructor(private readonly redis: RedisLike) {}

  async hit(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttlSeconds);
    return count;
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/** Brute-force protection for credential endpoints, keyed by client address and account. */
export class LoginThrottle {
  constructor(
    private readonly store: CounterStore,
    private readonly maxAttempts = 10,
    private readonly windowSeconds = 15 * 60,
  ) {}

  /** Returns false once the caller is over the limit. */
  async allow(ip: string, email: string): Promise<boolean> {
    const [byIp, byAccount] = await Promise.all([
      this.store.hit(`login:ip:${ip}`, this.windowSeconds),
      this.store.hit(`login:acct:${email.toLowerCase()}`, this.windowSeconds),
    ]);
    return byIp <= this.maxAttempts * 3 && byAccount <= this.maxAttempts;
  }

  async succeeded(email: string): Promise<void> {
    await this.store.reset(`login:acct:${email.toLowerCase()}`);
  }
}
