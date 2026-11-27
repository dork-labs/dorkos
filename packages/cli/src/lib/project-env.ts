/**
 * The optional `.env` file in the folder DorkOS starts in.
 *
 * It fills in settings the real environment left unset, never overriding one
 * (CLI flags and config are applied before it). It never sets a trust
 * setting: who may reach this server, what it trusts, where it sends its
 * credentials, how far file access reaches. Those are read only from the
 * server's own environment (or its config), so a key in this file is dropped
 * and named once in the log.
 *
 * @module lib/project-env
 */
import fs from 'node:fs';
import { parse } from 'dotenv';

/**
 * The settings a project `.env` may never set, each with why.
 *
 * A setting belongs here when it widens who reaches the server, what it
 * trusts, where its credentials go or what its agents may touch.
 */
export const TRUST_ENV_KEYS: Readonly<Record<string, string>> = {
  DORKOS_TRUSTED_HOSTS: 'host names the server and the person bar accept',
  DORKOS_CORS_ORIGIN: 'sites allowed to read the server’s answers',
  DORKOS_HOST: 'the network address the server listens on',
  DORKOS_ALLOW_INSECURE_BIND: 'listening beyond this computer without the host guard',
  DORKOS_TRUST_PROXY: 'believing a forwarded client address',
  DORKOS_TLS_HOST: 'a second listener’s address',
  DORKOS_TLS_PORT: 'a second listener’s port',
  DORKOS_TLS_CERT: 'a second listener’s certificate',
  DORKOS_TLS_KEY: 'a second listener’s private key',
  DORKOS_SERVER_ROLE: 'whether this server runs as a hub, which changes its gate',
  DORKOS_MANAGED_REMOTE: 'turning managed remote access on',
  DORKOS_HUB_INSTANCE_KEY: 'a credential the hub link presents',
  DORKOS_BOUNDARY: 'how far file access reaches',
  DORKOS_CLOUD_URL: 'where the account sign-in goes',
  DORKOS_CLOUD_API_URL: 'where account credentials are sent',
  DORKOS_TEST_RUNTIME: 'a test mode that swaps the runtimes',
  DORKOS_TEST_CLOUD_AUTO_APPROVE: 'a test mode that approves a sign-in by itself',
};

/** What loading a project `.env` did. */
export interface ProjectEnvResult {
  /** Keys it set, because the environment had none. */
  readonly applied: readonly string[];
  /** Trust settings it held, dropped. Names only. */
  readonly ignored: readonly string[];
}

/**
 * Load a project `.env` into `target` without overriding anything already
 * set, and without any of {@link TRUST_ENV_KEYS}.
 *
 * @param envPath - The file; a missing one loads nothing.
 * @param target - The environment to fill, `process.env` in the CLI.
 * @param warn - Told once, by name only, when trust settings were dropped.
 * @returns What was applied and what was dropped.
 */
export function loadProjectEnv(
  envPath: string,
  target: NodeJS.ProcessEnv,
  warn: (message: string) => void
): ProjectEnvResult {
  if (!fs.existsSync(envPath)) return { applied: [], ignored: [] };
  const parsed = parse(fs.readFileSync(envPath));
  const applied: string[] = [];
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.hasOwn(TRUST_ENV_KEYS, key)) {
      ignored.push(key);
      continue;
    }
    if (target[key] !== undefined) continue;
    target[key] = value;
    applied.push(key);
  }
  if (ignored.length > 0) {
    warn(
      `[DorkOS] Ignored ${ignored.join(', ')} in the project .env: set these in the ` +
        'environment DorkOS starts in.'
    );
  }
  return { applied, ignored };
}
