/**
 * Container healthcheck. Exits 0 when the API answers, 1 otherwise.
 * Kept dependency-free so it works inside a minimal runtime image.
 */

const port = process.env.PORT ?? '3000';

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    signal: AbortSignal.timeout(4000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
