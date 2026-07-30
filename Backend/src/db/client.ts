import pg from 'pg';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

/**
 * Numeric handling.
 *
 * node-postgres returns numeric/int8 as strings to avoid float precision loss.
 * We parse them to JS numbers here because every value in this application is
 * well inside the safe-integer range (the largest figure in the reference data
 * is IDR 3.48e12, and Number.MAX_SAFE_INTEGER is 9.0e15).
 *
 * NOTE if this ever handles rupiah values above ~9e15, revisit: the right answer
 * then is to keep them as strings and format at the boundary.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// DATE must stay a plain calendar string — never a Date, which would introduce
// a timezone shift and silently move documents between months.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export type Row = Record<string, unknown>;

export async function query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

export async function queryOne<T extends Row = Row>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(sql, params);
  return res.rowCount ?? 0;
}

export async function transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err) };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * Batched multi-row insert. Used by the ingestion loader.
 * Chunked so a 29k-row feed never builds a single oversized statement.
 */
export async function insertMany(
  client: pg.PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  chunkSize = 500,
): Promise<number> {
  if (rows.length === 0) return 0;
  let inserted = 0;
  const colList = columns.map((c) => `"${c}"`).join(', ');

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of chunk) {
      const placeholders = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      tuples.push(`(${placeholders.join(', ')})`);
    }
    const res = await client.query(
      `INSERT INTO ${table} (${colList}) VALUES ${tuples.join(', ')}`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}
