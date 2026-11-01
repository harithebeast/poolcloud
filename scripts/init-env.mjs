#!/usr/bin/env node
// Creates .env from .env.example with freshly generated secrets. Never overwrites an existing file.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = new URL('../.env', import.meta.url);
if (existsSync(target)) {
  console.log('.env already exists; leaving it untouched.');
  process.exit(0);
}

const values = {
  POSTGRES_PASSWORD: randomBytes(18).toString('hex'),
  SESSION_SECRET: randomBytes(48).toString('base64url'),
  MASTER_KEYS: `k1:${randomBytes(32).toString('base64')}`,
};
let text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
for (const [key, value] of Object.entries(values)) {
  text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
}
writeFileSync(target, text, { mode: 0o600 });
console.log('Created .env with generated secrets.');
console.log('BACK UP MASTER_KEYS: without it, encrypted files cannot be recovered.');
