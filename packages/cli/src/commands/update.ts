/**
 * CLI handler for `dorkos marketplace update [name]` (and its shorthand,
 * `dorkos update [name]`).
 *
 * Advisory by default: prints one line per package — a newer version, up to
 * date, or could not check (and why). Pass `--apply` to reinstall the packages
 * that have an update.
 *
 * - **With a name**, it asks the one-package door,
 *   `POST /api/marketplace/packages/:name/update`.
 * - **Without one**, it asks the all-packages door in ONE request:
 *   `GET /api/marketplace/updates` to check, `POST /api/marketplace/updates`
 *   with `apply: true` to update. The server checks every installation in view
 *   (every scope, or `--project`'s view) and answers one line's worth per
 *   installation, so the same package in two places prints as two lines, each
 *   naming where it lives.
 *
 * @module commands/update
 */
import { parseArgs } from 'node:util';
import type {
  InstallationUpdatesResult,
  UpdateCheckResult,
  UpdateResult,
} from '@dorkos/shared/marketplace-schemas';
import { ApiError, apiCall } from '../lib/api-client.js';
import {
  formatUpdateLine,
  formatVersion,
  labelOf,
  type PrintableCheck,
} from '../lib/installation-label.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runUpdate}. */
export interface UpdateArgs {
  /** Optional package name; when omitted, every installed package is checked. */
  name?: string;
  /** Apply the update (default: advisory only). */
  apply?: boolean;
  /** Project path for project-local updates. */
  projectPath?: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace update [<name>] [--apply] [--project <path>]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace update`.
 *
 * @param rawArgs - The argv slice after `update`.
 * @returns A typed {@link UpdateArgs} object.
 */
export function parseUpdateArgs(rawArgs: string[]): UpdateArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        apply: { type: 'boolean', default: false },
        project: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace update', USAGE_LINE);
  }

  const { values, positionals } = parsed;
  return {
    name: positionals[0],
    apply: Boolean(values.apply),
    projectPath: typeof values.project === 'string' ? values.project : undefined,
  };
}

/**
 * Implements `dorkos marketplace update [name]`.
 *
 * @param args - Parsed update arguments.
 * @returns The intended process exit code: `0` on success, `1` when the server
 *   was unreachable or refused the request, a named package is installed
 *   nowhere, or any requested reinstall failed. Packages that could not be
 *   checked do not change it on their own.
 */
export async function runUpdate(args: UpdateArgs): Promise<number> {
  try {
    return args.name ? await updateOne(args.name, args) : await updateAll(args);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * One package, through the per-package door. An error for it prints as a
 * `could not check` line; a 404 (installed nowhere, often a typo) or any error
 * during `--apply` exits 1.
 */
async function updateOne(name: string, args: UpdateArgs): Promise<number> {
  const body: Record<string, unknown> = { apply: Boolean(args.apply) };
  if (args.projectPath) body.projectPath = args.projectPath;

  let result: UpdateResult;
  try {
    result = await apiCall<UpdateResult>(
      'POST',
      `/api/marketplace/packages/${encodeURIComponent(name)}/update`,
      body
    );
  } catch (err) {
    // Anything but an answer from the server (it could not be reached at all)
    // is rethrown to the caller's single catch.
    if (!(err instanceof ApiError)) throw err;
    renderUpdateChecks([couldNotCheck(name, err.message)], Boolean(args.apply));
    return err.status === 404 || args.apply ? 1 : 0;
  }

  renderUpdateChecks(result.checks, Boolean(args.apply));
  if (args.apply && result.applied.length > 0) {
    console.log('');
    console.log('Applied:');
    for (const a of result.applied)
      console.log(`  ${a.packageName}@${a.version} → ${a.installPath}`);
  }
  return 0;
}

/**
 * Every installation in view, in one request. The server isolates failures per
 * installation, so there is nothing left to loop over here.
 */
async function updateAll(args: UpdateArgs): Promise<number> {
  const result = args.apply
    ? await apiCall<InstallationUpdatesResult>('POST', '/api/marketplace/updates', {
        apply: true,
        ...(args.projectPath && { projectPath: args.projectPath }),
      })
    : await apiCall<InstallationUpdatesResult>(
        'GET',
        `/api/marketplace/updates${
          args.projectPath ? `?projectPath=${encodeURIComponent(args.projectPath)}` : ''
        }`
      );

  if (result.checks.length === 0) {
    console.log('No installed packages to check.');
    return 0;
  }

  renderUpdateChecks(result.checks, Boolean(args.apply));

  const applied = result.checks.flatMap((c) =>
    c.applied ? [{ check: c, result: c.applied }] : []
  );
  if (applied.length > 0) {
    console.log('');
    console.log('Applied:');
    for (const { check, result: a } of applied) {
      console.log(`  ${labelOf(check)}@${a.version} → ${a.installPath}`);
    }
  }
  const failed = result.checks.filter((c) => c.applyError !== undefined);
  if (failed.length > 0) {
    console.log('');
    console.log('Could not update:');
    for (const c of failed) console.log(`  ${labelOf(c)}: ${c.applyError}`);
  }
  return failed.length > 0 ? 1 : 0;
}

/** A check result standing in for a package the server returned an error for. */
function couldNotCheck(packageName: string, reason: string): UpdateCheckResult {
  return {
    packageName,
    installedVersion: '',
    latestVersion: '',
    hasUpdate: false,
    marketplace: '',
    status: 'unknown',
    note: reason,
  };
}

/**
 * Print one line per check, then a summary that counts all three outcomes.
 * The summary never claims everything is up to date while any package could
 * not be checked.
 */
function renderUpdateChecks(checks: PrintableCheck[], apply: boolean): void {
  for (const check of checks) {
    const label = labelOf(check);
    if (check.status === 'unknown') {
      console.log(`${label}  could not check: ${check.note ?? 'no reason given'}`);
      continue;
    }
    if (check.status === 'update-available') {
      console.log(formatUpdateLine(check));
    } else {
      const installed = formatVersion(check.installedVersion, check.installedVersionSource);
      console.log(`${label}  up to date (${installed})`);
    }
    // A caveat on a known answer: a rollback, or a check of the default branch.
    if (check.note) console.log(`  ${check.note}`);
  }

  const updates = checks.filter((c) => c.status === 'update-available').length;
  const current = checks.filter((c) => c.status === 'current').length;
  const unknown = checks.filter((c) => c.status === 'unknown').length;
  const parts = [
    updates > 0 && `${updates} ${updates === 1 ? 'update' : 'updates'} available`,
    current > 0 && `${current} up to date`,
    unknown > 0 && `${unknown} could not be checked`,
  ].filter(Boolean);
  const hint =
    !apply && updates > 0
      ? ` Run again with --apply to install ${updates === 1 ? 'it' : 'them'}.`
      : '';
  console.log(`${parts.join(', ')}.${hint}`);
}
