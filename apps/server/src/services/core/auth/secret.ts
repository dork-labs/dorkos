/**
 * Better Auth signing-secret resolution — the single source of truth for the
 * secret that signs DorkOS session cookies.
 *
 * Better Auth signs every session with a secret. When none is provided it falls
 * back to a hardcoded development secret and, in production, refuses to sign —
 * turning the first sign-in into a 500 (DOR-242). Historically the secret was
 * read straight from the environment by the `better-auth` library, so a fresh
 * install that followed the documented `dorkos auth enable` path had login
 * silently broken until an operator hand-set `BETTER_AUTH_SECRET`.
 *
 * {@link resolveBetterAuthSecret} closes that gap: it always returns a usable
 * secret, in this precedence order:
 *
 *   1. **`BETTER_AUTH_SECRET` from the environment** — an explicit operator
 *      override always wins (declared in `env.ts`, validated there).
 *   2. **A persisted secret file** under the dork home — read if it exists, so
 *      the secret is stable across restarts (rotating it would invalidate every
 *      live session).
 *   3. **A freshly generated secret** — 32 random bytes, hex-encoded, written to
 *      the persisted file with `0600` permissions and returned. This is the
 *      zero-config path a fresh install lands on.
 *
 * The secret value is never logged; only its file path is.
 *
 * @module services/core/auth/secret
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../../lib/logger.js';

/**
 * File name of the persisted signing secret under the dork home. A sibling of
 * `config.json` and `dork.db`, kept out of the user-visible config file on
 * purpose: `config.json` is meant to be read and hand-edited, and the
 * accounts-and-auth migration deliberately removed the old root `sessionSecret`
 * from it. A dedicated `0600` file keeps the secret off that surface.
 */
const SECRET_FILE_NAME = 'better-auth-secret';

/** Owner-only file mode for the persisted secret (`rw-------`). */
const SECRET_FILE_MODE = 0o600;

/** Number of random bytes generated for a new secret (256 bits). */
const SECRET_BYTES = 32;

/**
 * Read a non-empty environment override for the signing secret, if present.
 *
 * Read from `process.env` directly (rather than the parsed `env`) so this module
 * stays free of an import cycle with `env.ts`; `env.ts` is the schema-validation
 * surface, this is the resolution surface. Whitespace-only values are treated as
 * unset.
 */
function readEnvSecret(): string | undefined {
  // eslint-disable-next-line no-restricted-syntax -- reading an env override, not a homedir path
  const fromEnv = process.env.BETTER_AUTH_SECRET?.trim();
  return fromEnv ? fromEnv : undefined;
}

/**
 * Resolve the Better Auth signing secret for this instance.
 *
 * Never throws for the missing-secret case — it generates and persists one
 * instead, so the server always boots with a working secret. Precedence:
 * environment override → persisted file → freshly generated + persisted.
 *
 * @param dorkHome - The resolved DorkOS data directory (from `resolveDorkHome`).
 *   The persisted secret lives at `<dorkHome>/better-auth-secret`.
 * @returns The signing secret (hex string, or the operator's env value).
 */
export function resolveBetterAuthSecret(dorkHome: string): string {
  const fromEnv = readEnvSecret();
  if (fromEnv) return fromEnv;

  const secretPath = path.join(dorkHome, SECRET_FILE_NAME);

  try {
    const persisted = fs.readFileSync(secretPath, 'utf8').trim();
    if (persisted) return persisted;
  } catch (err) {
    // ENOENT is the expected first-boot case; anything else (e.g. EACCES) is
    // worth surfacing before we overwrite, but is still recoverable by
    // regenerating below.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[Auth] Could not read the persisted signing secret; generating a new one', {
        path: secretPath,
        error: (err as Error).message,
      });
    }
  }

  const generated = randomBytes(SECRET_BYTES).toString('hex');
  fs.mkdirSync(dorkHome, { recursive: true });
  fs.writeFileSync(secretPath, generated, { mode: SECRET_FILE_MODE });
  // Re-assert the mode: `writeFileSync`'s `mode` is ignored when the file
  // already exists, and is subject to the process umask on create.
  fs.chmodSync(secretPath, SECRET_FILE_MODE);
  logger.info('[Auth] Generated a persistent session-signing secret', { path: secretPath });
  return generated;
}
