import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One small query interface over two Postgres engines:
 * - DATABASE_URL set  -> a real Postgres server via `pg`
 * - otherwise         -> PGlite (Postgres compiled to WASM), so the app runs with no database install
 */
export interface Db {
  kind: 'postgres' | 'pglite';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function openDb(opts: { url?: string; memory?: boolean } = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL;
  let db: Db;

  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: url,
      ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
    });
    db = {
      kind: 'postgres',
      query: async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows as T[],
      exec: async (sql) => void (await pool.query(sql)),
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    // PGLITE_DIR=memory keeps everything in RAM; any other value is a directory to store the data in.
    const custom = process.env.PGLITE_DIR;
    const dir = opts.memory || custom === 'memory' ? undefined : custom || join(here, '..', '.data', 'pglite');
    if (dir) mkdirSync(dir, { recursive: true });
    const lite = new PGlite(dir);
    await lite.waitReady;
    db = {
      kind: 'pglite',
      query: async <T>(sql: string, params?: unknown[]) => (await lite.query(sql, params)).rows as T[],
      exec: async (sql) => void (await lite.exec(sql)),
      close: () => lite.close(),
    };
  }

  await db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}
