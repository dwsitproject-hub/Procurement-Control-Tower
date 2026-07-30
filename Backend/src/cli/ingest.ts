/**
 * CLI: run an ingestion from the share folder.
 *
 *   npm run ingest -w @pct/backend -- [--path <dir>] [--no-publish]
 */

import { fileURLToPath } from 'node:url';
import { closePool } from '../db/client.js';
import { loadEnv } from '../config/env.js';
import { runIngest } from '../modules/ingest/pipeline.js';
import { ShareFolderSource } from '../modules/ingest/sources.js';

const env = loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const path = arg('path') ?? env.SHARE_PATH;
  const noPublish = process.argv.includes('--no-publish');

  process.stdout.write(`Ingesting from: ${path}\n`);

  // settleSeconds = 0 for the CLI: a manual run is deliberate, and the operator
  // is not racing an export job.
  const source = new ShareFolderSource(path, 0);

  const t0 = Date.now();
  const result = await runIngest({
    source,
    autoPublish: !noPublish,
    onProgress: (stage, detail) =>
      process.stdout.write(`  [${stage}]${detail ? ` ${detail}` : ''}\n`),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  process.stdout.write(`\n=== ${result.outcome.toUpperCase()} in ${secs}s ===\n`);

  switch (result.outcome) {
    case 'source_unavailable':
      process.stderr.write(`Share not readable: ${result.path}\n`);
      return 1;

    case 'incomplete_bundle':
      process.stderr.write(`Missing feeds: ${result.missing.join(', ')}\nNothing was published.\n`);
      return 1;

    case 'noop_unchanged':
      process.stdout.write(
        `Bundle unchanged (identical file hashes already published as batch ${result.batchId}).\n`,
      );
      return 0;

    case 'failed': {
      process.stderr.write(`Batch ${result.batchId} FAILED\n${result.reason}\n`);
      printFindings(result.findings);
      process.stderr.write('\nThe previously published version is untouched and still serving.\n');
      return 1;
    }

    case 'ready':
    case 'published': {
      process.stdout.write(
        `Batch ${result.batchId} -> dataset version ${result.datasetVersionId}` +
          `${result.outcome === 'ready' ? ' (READY, awaiting confirmation)' : ' (PUBLISHED)'}\n`,
      );
      printFindings(result.findings);
      return 0;
    }
  }
}

function printFindings(findings: readonly { ruleId: string; severity: string; message: string; affectedRows: number | null }[]): void {
  if (findings.length === 0) {
    process.stdout.write('\nNo validation findings.\n');
    return;
  }
  const order = ['BLOCKER', 'CAVEAT', 'WARNING', 'INFO'];
  process.stdout.write('\nValidation findings:\n');
  for (const sev of order) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    process.stdout.write(`\n  ${sev} (${group.length})\n`);
    for (const f of group) {
      const rows = f.affectedRows === null ? '' : ` [${f.affectedRows.toLocaleString()} rows]`;
      process.stdout.write(`    ${f.ruleId}${rows}\n      ${f.message}\n`);
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main()
    .then(async (code) => {
      await closePool();
      process.exit(code);
    })
    .catch(async (err) => {
      process.stderr.write(`\nINGEST ERROR: ${err instanceof Error ? err.stack : String(err)}\n`);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
