/**
 * Set a local password for an account, from the server's own shell.
 *
 *   docker exec -it pct-api node dist/cli/set-password.js --email someone@example.com
 *   docker exec -it pct-api node dist/cli/set-password.js --email someone@example.com --force-change
 *
 * Written 23 Sep 2026 for a locked-out environment: a local copy of staging's
 * database, where every account came across with staging's credentials, the
 * reader's own account signs in through the Hub on staging, and the Hub is not
 * configured locally. The User Access page can reset a password, but only for
 * an administrator who is already signed in - which is exactly what nobody was.
 *
 * ── Why a prompt and not an argument ─────────────────────────────────────
 *
 * The password is READ FROM THE TERMINAL with echo off, never taken as a flag.
 * A flag lands in shell history and in the process list for anyone on the host
 * to read, and a CLI that invites one teaches the habit.
 *
 * ── What it does ─────────────────────────────────────────────────────────
 *
 *   - hashes with hashLocalPassword, the login path's own parameters;
 *   - creates the credential if the account has none (a Hub-provisioned
 *     account usually does not) - local login authorises on the CREDENTIAL,
 *     not on auth_method, so that is all it takes;
 *   - clears the failed-attempt counter and any lockout;
 *   - with --force-change, makes the next sign-in rotate it, which is right
 *     when the password is being handed to somebody else;
 *   - records an audit row, so a reset done from a shell is as visible as one
 *     done from the page.
 *
 * It refuses a disabled account rather than quietly enabling it: re-enabling
 * someone is a decision for the User Access page, where it is recorded as one.
 */
import { stdin, stdout } from 'node:process';
import { closePool, queryOne, transaction } from '../db/client.js';
import { loadEnv } from '../config/env.js';
import { hashLocalPassword, MIN_PASSWORD_LENGTH } from '../modules/auth/auth.js';
import { recordAudit } from '../modules/audit/audit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * One line from the terminal with nothing echoed.
 *
 * Raw mode, byte by byte, so the characters are never written back: readline's
 * own muting still echoes on some Windows terminals.
 */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new Error('needs an interactive terminal - run it with `docker exec -it`'));
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { // Ctrl+C
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * The FIRST administrator of a new environment (12 Nov 2026).
 *
 *   docker exec -it pct-api node dist/cli/set-password.js --email a@b.c --create-admin --name "Full Name"
 *
 * A production database has no seeded admin (seed.ts seeds one in development
 * only), and the User Access page needs a signed-in administrator. This makes
 * the account - local, roles admin + steward, data scope everything - and then
 * sets its password exactly as a reset does. Refused when the address already
 * exists, so it can never quietly promote someone; for an existing account,
 * use the User Access page or plain --email.
 */
async function createAdmin(email: string, name: string): Promise<void> {
  const exists = await queryOne<{ id: string }>(`SELECT id FROM app.app_user WHERE email = $1`, [email]);
  if (exists) throw new Error(`${email} already exists; grant roles on the User Access page instead`);
  await transaction(async (c) => {
    const u = await c.query<{ id: string }>(
      `INSERT INTO app.app_user (email, display_name, auth_method, is_active)
       VALUES ($1, $2, 'local', true) RETURNING id`,
      [email, name],
    );
    const id = u.rows[0]!.id;
    await c.query(`INSERT INTO app.user_role (user_id, role_code) VALUES ($1, 'admin'), ($1, 'steward')`, [id]);
    await c.query(`INSERT INTO app.data_scope (user_id, company_code, plant, purch_org) VALUES ($1, '*', '*', '*')`, [id]);
  });
  await recordAudit({
    action: 'auth.admin.cli_bootstrap',
    actorEmail: 'cli',
    outcome: 'success',
    detail: { targetEmail: email, roles: ['admin', 'steward'], scope: 'all' },
  });
  stdout.write(`Created ${email} as an administrator with access to all data.\n`);
}

async function main(): Promise<void> {
  loadEnv();
  const email = arg('email');
  const forceChange = process.argv.includes('--force-change');
  if (!email) {
    throw new Error('usage: set-password --email <address> [--force-change] [--create-admin --name "Full Name"]');
  }
  if (process.argv.includes('--create-admin')) {
    const name = arg('name');
    if (!name) throw new Error('--create-admin needs --name "Full Name"');
    await createAdmin(email, name);
  }

  const user = await queryOne<{ id: string; is_active: boolean; auth_method: string }>(
    `SELECT id, is_active, auth_method FROM app.app_user WHERE email = $1`,
    [email],
  );
  if (!user) throw new Error(`no account with the email ${email}`);
  if (!user.is_active) {
    throw new Error(`${email} is disabled; re-enable it on the User Access page first`);
  }

  stdout.write(`Setting a local password for ${email} (${user.auth_method} account).\n`);
  const first = await readHidden('New password: ');
  if (first.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`the password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const second = await readHidden('Again: ');
  if (first !== second) throw new Error('the two entries did not match; nothing was changed');

  const hash = await hashLocalPassword(first);
  await transaction(async (c) => {
    await c.query(
      `INSERT INTO app.local_credential (user_id, password_hash, password_set_at, failed_attempts, locked_until)
       VALUES ($1, $2, now(), 0, NULL)
       ON CONFLICT (user_id) DO UPDATE
          SET password_hash = EXCLUDED.password_hash, password_set_at = now(),
              failed_attempts = 0, locked_until = NULL`,
      [user.id, hash],
    );
    await c.query(`UPDATE app.app_user SET must_change_password = $2 WHERE id = $1`, [user.id, forceChange]);
  });

  await recordAudit({
    action: 'auth.password.cli_reset',
    actorEmail: 'cli',
    outcome: 'success',
    detail: { targetEmail: email, forceChange },
  });

  stdout.write(
    forceChange
      ? `Done. ${email} must choose a new password at the next sign-in.\n`
      : `Done. ${email} can sign in with that password now.\n`,
  );
}

main()
  .catch((e: unknown) => {
    process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => { void closePool(); });
