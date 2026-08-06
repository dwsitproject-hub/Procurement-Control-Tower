/**
 * Migration runner. Forward-only, applied in filename order, each in its own
 * transaction, recorded in a ledger so re-running is a no-op.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pool, closePool } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

async function ensureLedger(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migration (
      filename    text PRIMARY KEY,
      sha256      char(64) NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  // Serialise concurrent runners (e.g. two instances booting at once): the
  // second waits here until the first finishes, then applies nothing.
  await pool.query('SELECT pg_advisory_lock(208671163)');
  try {
    return await migrateLocked();
  } finally {
    await pool.query('SELECT pg_advisory_unlock(208671163)');
  }
}

async function migrateLocked(): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureLedger();

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');

    const existing = await pool.query<{ sha256: string }>(
      'SELECT sha256 FROM public.schema_migration WHERE filename = $1',
      [file],
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0]!.sha256 !== sha) {
        // An applied migration must never change: editing one silently diverges
        // environments. Fix forward with a new file instead.
        throw new Error(
          `Migration ${file} has changed since it was applied. Migrations are immutable — add a new file.`,
        );
      }
      skipped.push(file);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migration (filename, sha256) VALUES ($1, $2)', [
        file,
        sha,
      ]);
      await client.query('COMMIT');
      applied.push(file);
      process.stdout.write(`  applied  ${file}\n`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  migrate()
    .then(({ applied, skipped }) => {
      process.stdout.write(
        `\nMigration complete: ${applied.length} applied, ${skipped.length} already present.\n`,
      );
      return closePool();
    })
    .then(() => process.exit(0))
    .catch(async (err) => {
      process.stderr.write(`\nMIGRATION FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
