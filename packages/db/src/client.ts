// packages/db/src/client.ts
// Drizzle ORM client factory.
// Exports a singleton `db` connected via DATABASE_URL and the full schema type.

import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  // .env is optional when variables are injected via the environment
}

if (process.env['NODE_ENV'] === 'production' && !process.env['DATABASE_URL']) {
  throw new Error('DATABASE_URL must be set when NODE_ENV=production');
}

const sql = postgres(
  process.env['DATABASE_URL'] ?? 'postgres://reapd:reapd_dev_password@localhost:5432/reapd'
);

export const db = drizzle(sql, { schema });

/** Drizzle client type — use this for dependency injection in repository functions */
export type DrizzleClient = typeof db;

