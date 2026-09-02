/**
 * CLI handler for `dorkos version [--check]`.
 *
 * `dorkos version` prints the installed CLI version (the same value as
 * `dorkos --version`). `dorkos version --check` reports the running server's
 * version and the latest published version:
 *
 * - When a server is reachable, both come from `GET /api/config`
 *   (`version` + `latestVersion`).
 * - When no server is running, it degrades gracefully: the server version falls
 *   back to the installed CLI version and `latestVersion` comes from the local
 *   update-check cache (`~/.dork/cache/update-check.json`).
 * - When the server answers `401` (login is on and the CLI has no API key) it
 *   degrades the same way, but says so on stderr — reporting "not running" for a
 *   server that is running would be a lie.
 *
 * Accepts `--json` for raw machine output. Returns an exit code rather than
 * calling `process.exit` so `cli.ts` stays the single source of truth for
 * termination.
 *
 * @module commands/version
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { apiCall, ApiError } from '../lib/api-client.js';
import { printError, printJson } from '../lib/operator-output.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Help text for `dorkos version` (`--help`). */
const VERSION_USAGE = `Usage: dorkos version [--check]

Show the installed CLI version, or check server + latest versions.

Options:
      --check   Report the running server version and the latest release
      --json    Print raw JSON instead of text

Examples:
  dorkos version
  dorkos version --check
  dorkos version --check --json`;

/** Parsed arguments for `dorkos version`. */
export interface VersionArgs {
  check: boolean;
  json: boolean;
}

/** The version fields the check reports. */
interface VersionReport {
  /** Installed CLI version. */
  cli: string;
  /** Running server version, or null when no server is reachable. */
  server: string | null;
  /** Latest published version, or null when unknown. */
  latest: string | null;
  /** Where `server`/`latest` came from: the live server or the local cache. */
  source: 'server' | 'cache';
}

/**
 * Parse the argv slice after `dorkos version`.
 *
 * @param rawArgs - Argv after `version`.
 * @returns Typed {@link VersionArgs}.
 */
export function parseVersionArgs(rawArgs: string[]): VersionArgs {
  const usage = 'Usage: dorkos version [--check] [--json]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        check: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'version', usage);
  }
  return { check: Boolean(parsed.values.check), json: Boolean(parsed.values.json) };
}

/**
 * Read `latestVersion` from the local update-check cache. Returns `null` when
 * the file is missing or malformed — the same tolerant read the startup update
 * banner uses.
 *
 * @param dorkHome - The resolved data directory.
 * @returns The cached latest version, or `null`.
 */
function readCachedLatest(dorkHome: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dorkHome, 'cache', 'update-check.json'), 'utf-8');
    const cache = JSON.parse(raw) as { latestVersion?: unknown };
    return typeof cache.latestVersion === 'string' ? cache.latestVersion : null;
  } catch {
    return null;
  }
}

/**
 * Implements `dorkos version --check`.
 *
 * @param cliVersion - The installed CLI version (`__CLI_VERSION__`).
 * @param dorkHome - The resolved data directory (for the cache fallback).
 * @param json - When true, print the raw report as JSON.
 * @returns Always `0` — a missing server is a graceful degrade, not an error.
 */
export async function runVersionCheck(
  cliVersion: string,
  dorkHome: string,
  json: boolean
): Promise<number> {
  let report: VersionReport;
  try {
    const config = await apiCall<{ version?: string; latestVersion?: string | null }>(
      'GET',
      '/api/config'
    );
    report = {
      cli: cliVersion,
      server: config.version ?? cliVersion,
      latest: config.latestVersion ?? null,
      source: 'server',
    };
  } catch (err) {
    // Unreachable server: degrade to the local cache rather than failing. A 401 is
    // a different story — the server IS running, it just wants a credential, so
    // "not running" would be a lie. Say what is actually wrong on stderr and still
    // degrade, because the version report is not worth a non-zero exit.
    if (err instanceof ApiError && err.status === 401) {
      console.error(err.message);
    }
    report = {
      cli: cliVersion,
      server: null,
      latest: readCachedLatest(dorkHome),
      source: 'cache',
    };
  }

  if (json) {
    printJson(report);
    return 0;
  }

  console.log(`CLI:     ${report.cli}`);
  if (report.source === 'server') {
    console.log(`Server:  ${report.server}`);
  } else {
    console.log('Server:  not running');
  }
  console.log(`Latest:  ${report.latest ?? 'unknown'}`);
  return 0;
}

/**
 * Dispatch `dorkos version [--check]`.
 *
 * @param cliVersion - The installed CLI version (`__CLI_VERSION__`).
 * @param dorkHome - The resolved data directory.
 * @param rawArgs - Argv after `version`.
 * @returns The intended process exit code.
 */
export async function runVersionDispatcher(
  cliVersion: string,
  dorkHome: string,
  rawArgs: string[]
): Promise<number> {
  if (rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    console.log(VERSION_USAGE);
    return 0;
  }
  let args: VersionArgs;
  try {
    args = parseVersionArgs(rawArgs);
  } catch (err) {
    printError(err);
    return 1;
  }
  if (!args.check) {
    if (args.json) {
      printJson({ cli: cliVersion });
      return 0;
    }
    console.log(cliVersion);
    return 0;
  }
  return runVersionCheck(cliVersion, dorkHome, args.json);
}
