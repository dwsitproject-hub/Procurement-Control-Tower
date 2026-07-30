/**
 * API entrypoint.
 *
 * The process refuses to start on invalid configuration (see config/env.ts) and
 * fails fast if the database is unreachable — a half-started API that returns 500
 * to every request is harder to diagnose than one that never came up.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { loadEnv, isOidcConfigured } from './config/env.js';
import { closePool, healthCheck } from './db/client.js';
import { buildRouter, problemHandler } from './api/routes.js';
import { initSessionStore, sessionStoreKind } from './modules/auth/session.js';
import { initOidc, oidcEnabled } from './modules/auth/auth.js';

const env = loadEnv();

async function main(): Promise<void> {
  const db = await healthCheck();
  if (!db.ok) {
    process.stderr.write(`FATAL: database unreachable — ${db.error}\n`);
    process.exit(1);
  }

  await initSessionStore();

  if (oidcEnabled()) {
    // Fail visibly at boot rather than on a user's first login attempt.
    const r = await initOidc();
    if (!r.ok) {
      process.stderr.write(
        `WARNING: OIDC discovery failed (${r.error}). SSO login will be unavailable; ` +
          `local authentication is unaffected.\n`,
      );
    } else {
      process.stdout.write('OIDC discovery loaded — DWS Hub SSO available\n');
    }
  } else {
    process.stdout.write('OIDC not configured — local authentication only\n');
  }

  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  // Single origin, so no CORS is configured at all — an entire class of
  // misconfiguration is removed rather than managed.
  app.use(
    helmet({
      contentSecurityPolicy: false, // set by nginx, which serves the SPA
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    req.requestId = (req.get('x-request-id') ?? randomUUID()).slice(0, 64);
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });

  app.use(buildRouter());
  app.use(problemHandler());

  const server = app.listen(env.PORT, () => {
    process.stdout.write(
      `Procurement Control Tower API listening on :${env.PORT}\n` +
        `  env=${env.NODE_ENV}  sessions=${sessionStoreKind()}  ` +
        `sso=${isOidcConfigured(env) ? 'configured' : 'off'}  share=${env.SHARE_PATH}\n`,
    );
  });

  const shutdown = async (signal: string) => {
    process.stdout.write(`\n${signal} received — shutting down\n`);
    server.close();
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
