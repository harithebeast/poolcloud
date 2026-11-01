import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const MIB = 1024 * 1024;

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  // Base64 32-byte key(s). Format: "kid1:<b64>,kid2:<b64>"; first entry is the active key.
  MASTER_KEYS: z.string().regex(/^[\w-]+:[A-Za-z0-9+/=]{43,44}(,[\w-]+:[A-Za-z0-9+/=]{43,44})*$/, {
    message: 'MASTER_KEYS must be "kid:base64(32 bytes)" entries separated by commas',
  }),
  STORAGE_PROVIDER: z.enum(['google', 'fake']).default('google'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  CHUNK_SIZE_BYTES: z.coerce
    .number()
    .int()
    .min(MIB)
    .default(64 * MIB),
  HEADROOM_PERCENT: z.coerce.number().min(0).max(50).default(5),
  HEADROOM_MIN_BYTES: z.coerce.number().int().min(0).default(100_000_000),
  QUOTA_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(300),
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  FEATURE_TOTP: bool.default(false),
  SENTRY_DSN: z.string().optional(),
  /** When set, /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const cfg = parsed.data;
  return cfg;
}
