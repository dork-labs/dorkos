/**
 * Local MCP token resolution — the single source of truth for the per-instance
 * bearer token that gates the external `/mcp` endpoint and the `/a2a` gateway
 * when login is off.
 *
 * When login is disabled (the default) and no `MCP_API_KEY` env override is set,
 * DorkOS still must not leave its mutating and code-execution tools reachable by
 * any local process. This module resolves a per-instance token — the Jupyter
 * pattern — stored `0600` under the dork home and required as
 * `Authorization: Bearer` on every mutating call. Read-only tools stay tokenless
 * via the carve-out in `middleware/mcp-auth.ts`.
 *
 * It is a near-clone of {@link module:services/core/auth/secret} (the Better Auth
 * signing-secret precedent, DOR-242): env override → persisted `0600` file →
 * generate + persist, with a lax-permission repair pass on read. Precedence:
 *
 *   1. **`env.MCP_API_KEY`** — when set, that env override IS the bearer clients
 *      use (existing acceptor 1 in the middleware), so this module returns `null`
 *      and neither reads nor writes the token file.
 *   2. **A persisted `<dorkHome>/mcp-local-token` file** — read (and permission-
 *      repaired) if present, so the token is stable across restarts.
 *   3. **A freshly generated `dork_mcp_local_<hex>`** — written `0600` and returned.
 *
 * The token is inactive when login is on (ADR-0320): it is resolved at boot only
 * in login-off mode, and the middleware consults it only while login is off.
 * The token value is never logged — only its file path is.
 *
 * @module services/core/auth/mcp-local-token
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../../env.js';
import { logger } from '../../../lib/logger.js';

/**
 * File name of the persisted local MCP token under the dork home. A `0600`
 * sibling of `config.json` and `better-auth-secret`, kept off the user-visible
 * config surface: raw secrets live in files, never in `config.json` (ADR-0315,
 * `CREDENTIAL_REF_PATTERN`).
 */
const TOKEN_FILE_NAME = 'mcp-local-token';

/** Owner-only file mode for the persisted token (`rw-------`). */
const TOKEN_FILE_MODE = 0o600;

/**
 * Self-describing prefix for the generated token. Makes it greppable in a client
 * config and distinguishes it from the legacy global `dork_mcp_*` key and
 * per-user Better Auth keys.
 */
const TOKEN_PREFIX = 'dork_mcp_local_';

/** Number of random bytes generated for a new token (256 bits → 64 hex chars). */
const TOKEN_BYTES = 32;

/**
 * The resolved token, cached so the middleware and the config DTO compare against
 * it without a per-request file read. `null` until {@link resolveMcpLocalToken}
 * (or {@link rotateMcpLocalToken}) has run in login-off mode; stays `null` when an
 * `MCP_API_KEY` env override is set or login is on.
 */
let cachedToken: string | null = null;

/** The resolved token file path, cached so a helpful 401 can name it. */
let cachedPath: string | null = null;

/**
 * Resolve this instance's local MCP token.
 *
 * Never throws for the missing-token case — it generates and persists one.
 * Returns `null` only when an `MCP_API_KEY` env override is set (that env key is
 * the bearer, so no local token file is read or written). Precedence:
 * environment override → persisted file → freshly generated + persisted.
 *
 * Only meaningful in login-off mode; per ADR-0320 the token is inactive when
 * `config.auth.enabled` is `true` (the caller must gate this resolve on login-off
 * — see the boot wiring in `index.ts`).
 *
 * @param dorkHome - The resolved DorkOS data directory (from `resolveDorkHome`).
 *   The token lives at `<dorkHome>/mcp-local-token`.
 * @returns The local token, or `null` when an `MCP_API_KEY` env override is set.
 */
export function resolveMcpLocalToken(dorkHome: string): string | null {
  // 1. Env override: MCP_API_KEY IS the bearer clients use (acceptor 1), so the
  //    local-token file is neither read nor written. Whitespace-only = unset.
  const envKey = env.MCP_API_KEY?.trim();
  if (envKey) return null;

  const tokenPath = path.join(dorkHome, TOKEN_FILE_NAME);

  // 2. Read a persisted token if present, so it is stable across restarts.
  try {
    const persisted = fs.readFileSync(tokenPath, 'utf8').trim();
    if (persisted) {
      repairTokenPermissions(tokenPath);
      cachedToken = persisted;
      cachedPath = tokenPath;
      return persisted;
    }
  } catch (err) {
    // ENOENT is the expected first-boot case; anything else (e.g. EACCES) is
    // worth surfacing before we overwrite, but is still recoverable below.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[MCP] Could not read the persisted local MCP token; generating a new one', {
        path: tokenPath,
        error: (err as Error).message,
      });
    }
  }

  // 3. Generate + persist a fresh token.
  const generated = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('hex');
  fs.mkdirSync(dorkHome, { recursive: true });
  fs.writeFileSync(tokenPath, generated, { mode: TOKEN_FILE_MODE });
  // Re-assert the mode: `writeFileSync`'s `mode` is ignored when the file
  // already exists, and is subject to the process umask on create.
  fs.chmodSync(tokenPath, TOKEN_FILE_MODE);
  logger.info('[MCP] Generated a per-instance local MCP token', { path: tokenPath });
  cachedToken = generated;
  cachedPath = tokenPath;
  return generated;
}

/**
 * Regenerate the token file (rotation), returning the new value.
 *
 * Always writes a fresh `dork_mcp_local_<hex>` `0600` (overwriting any existing
 * token) and refreshes the cache that {@link getMcpLocalToken} /
 * {@link getMcpLocalTokenPath} read. Rotating invalidates every previously
 * configured client until it re-pastes the new token.
 *
 * @param dorkHome - The resolved DorkOS data directory (from `resolveDorkHome`).
 * @returns The freshly generated local token.
 */
export function rotateMcpLocalToken(dorkHome: string): string {
  const tokenPath = path.join(dorkHome, TOKEN_FILE_NAME);
  const generated = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('hex');
  fs.mkdirSync(dorkHome, { recursive: true });
  fs.writeFileSync(tokenPath, generated, { mode: TOKEN_FILE_MODE });
  fs.chmodSync(tokenPath, TOKEN_FILE_MODE);
  logger.info('[MCP] Rotated the per-instance local MCP token', { path: tokenPath });
  cachedToken = generated;
  cachedPath = tokenPath;
  return generated;
}

/**
 * The resolved local token, or `null` when it does not apply (an `MCP_API_KEY`
 * env override is set, login is on, or it has not been resolved). The middleware
 * and the config DTO compare against this cached value without a file read.
 */
export function getMcpLocalToken(): string | null {
  return cachedToken;
}

/**
 * The resolved token file path, or `null` when no token has been resolved. The
 * middleware's helpful 401 names this path without needing to know `dorkHome`.
 */
export function getMcpLocalTokenPath(): string | null {
  return cachedPath;
}

/**
 * Ensure a persisted token file is owner-only on read.
 *
 * The token is written `0600`, but a file restored from a lax-permission backup,
 * synced from a dotfiles repo, or left by an older build under a loose umask can
 * end up group- or world-readable — which silently leaks the token. Rather than
 * reject (that would lock the owner out of their own instance), repair the mode
 * back to `0600` and warn. On Windows, where POSIX mode bits do not apply, this
 * is a no-op. A stat/chmod failure must never throw — warn and continue.
 *
 * @param tokenPath - Absolute path to the persisted token file.
 */
function repairTokenPermissions(tokenPath: string): void {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(tokenPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      fs.chmodSync(tokenPath, TOKEN_FILE_MODE);
      logger.warn(
        '[MCP] Local MCP token file was readable by other users; tightened it to owner-only (0600)',
        { path: tokenPath, previousMode: mode.toString(8) }
      );
    }
  } catch (err) {
    // A stat/chmod failure must never block the surface; the token already read.
    logger.warn('[MCP] Could not verify permissions on the local MCP token file', {
      path: tokenPath,
      error: (err as Error).message,
    });
  }
}
