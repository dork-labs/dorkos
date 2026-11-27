/**
 * The optional `.env` file in the folder DorkOS starts in.
 *
 * It carries a project's own variables for its own tools, filling in what the
 * real environment left unset and never overriding a value already set. It
 * can't change how DorkOS runs: a setting DorkOS itself reads loads from it
 * only when {@link PROJECT_ENV_ALLOWED} names it. Anything else DorkOS reads is
 * dropped, and its name logged once.
 *
 * @module lib/project-env
 */
import fs from 'node:fs';
import { parse } from 'dotenv';

/** The settings DorkOS reads that a project `.env` may still set. Reviewed one by one. */
export const PROJECT_ENV_ALLOWED: ReadonlySet<string> = new Set(['LOG_LEVEL', 'DO_NOT_TRACK']);

/** Every `DORKOS_*` and `DORK_*` name is DorkOS's own, whether it exists yet or not. */
const DORKOS_PREFIX = /^DORK(OS)?_/;

/**
 * The names DorkOS reads without its prefix: the server's environment schema
 * (`apps/server/src/env.ts`) and the CLI's (`env.ts`). A census test reads
 * both schemas, so a new name fails until it is listed here or allowed.
 */
export const DORKOS_READS_UNPREFIXED: ReadonlySet<string> = new Set([
  // apps/server/src/env.ts
  'HOME',
  'GITHUB_TOKEN',
  'NODE_ENV',
  'CLIENT_DIST_PATH',
  'MCP_API_KEY',
  'DO_NOT_TRACK',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'OTEL_SDK_DISABLED',
  'TUNNEL_ENABLED',
  'TUNNEL_PORT',
  'TUNNEL_AUTH',
  'TUNNEL_DOMAIN',
  'NGROK_AUTHTOKEN',
  'NANGO_BASE_URL',
  'NANGO_ENCRYPTION_KEY',
  // packages/cli/src/env.ts
  'LOG_LEVEL',
  'PATH',
  'USERPROFILE',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'FLY_CONFIG_DIR',
  'GH_CONFIG_DIR',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
]);

/**
 * Whether a project `.env` may set this name.
 *
 * @param key - The variable's name.
 */
export function projectEnvMaySet(key: string): boolean {
  if (PROJECT_ENV_ALLOWED.has(key)) return true;
  return !DORKOS_PREFIX.test(key) && !DORKOS_READS_UNPREFIXED.has(key);
}

/** What loading a project `.env` did. */
export interface ProjectEnvResult {
  /** Keys it set, because the environment had none. */
  readonly applied: readonly string[];
  /** Keys DorkOS reads that it held, dropped. Names only. */
  readonly ignored: readonly string[];
}

/**
 * Load a project `.env` into `target` without overriding anything already set,
 * and without any name {@link projectEnvMaySet} refuses.
 *
 * @param envPath - The file; a missing one loads nothing.
 * @param target - The environment to fill, `process.env` in the CLI.
 * @param warn - Told once, by name only, when keys were dropped.
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
    if (!projectEnvMaySet(key)) {
      ignored.push(key);
      continue;
    }
    if (target[key] !== undefined) continue;
    target[key] = value;
    applied.push(key);
  }
  if (ignored.length > 0) {
    warn(
      `[DorkOS] Ignored ${ignored.join(', ')} in the project .env: the project .env file ` +
        "can't change how DorkOS runs. Set these in the environment DorkOS starts in."
    );
  }
  return { applied, ignored };
}
