/**
 * CLI handler for `dorkos update [name]`.
 *
 * Advisory by default — calls `POST /api/marketplace/packages/:name/update`
 * (with `apply: false`) and prints one line per package: a newer version, up
 * to date, or could not check (and why). Pass `--apply` to reinstall the
 * packages that have an update.
 *
 * When no `<name>` is given, the CLI lists installed packages through
 * `GET /api/marketplace/installed` (forwarding `--project`) and checks each
 * one in the scope it was found in, so an agent's install is checked in that
 * agent's project. One package failing never stops the rest. An
 * all-packages endpoint is deferred (DOR-2194), so the iteration lives
 * client-side.
 *
 * @module commands/update
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';
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

/** Where a version came from, in Claude Code's order. Mirrors `VersionSource` on the server. */
type VersionSource = 'package' | 'index' | 'commit';

/** A single update check result. Mirrors `UpdateCheckResult` on the server. */
interface UpdateCheckResult {
  packageName: string;
  installedVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  marketplace: string;
  status: 'current' | 'update-available' | 'unknown';
  installedVersionSource?: VersionSource;
  latestVersionSource?: VersionSource;
  note?: string;
}

/** Mirrors `InstallResult` on the server, narrowed to fields we render. */
interface AppliedUpdate {
  packageName: string;
  version: string;
  installPath: string;
}

/** Update API response shape. Mirrors `UpdateResult` on the server. */
interface UpdateResultBody {
  checks: UpdateCheckResult[];
  applied: AppliedUpdate[];
}

/** Response shape for `GET /api/marketplace/installed`, narrowed to what targeting needs. */
interface InstalledListBody {
  packages: { name: string; agentPath?: string; scope?: string }[];
}

/** One package to check, in the scope it was found in. */
interface UpdateTarget {
  name: string;
  /** The scope to check it in; absent for a global install. */
  projectPath?: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos update [<name>] [--apply] [--project <path>]';

/**
 * Parse the raw argv slice that follows `dorkos update`.
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
    rethrowUnknownOption(err, 'update', USAGE_LINE);
  }

  const { values, positionals } = parsed;
  return {
    name: positionals[0],
    apply: Boolean(values.apply),
    projectPath: typeof values.project === 'string' ? values.project : undefined,
  };
}

/**
 * Implements `dorkos update [name]`.
 *
 * Each target is checked on its own: a server error for one package prints as
 * `could not check` and the run goes on. Only failing to reach the server at
 * all ends the run early.
 *
 * @param args - Parsed update arguments.
 * @returns The intended process exit code: `0` on success, `1` when the
 *   server was unreachable, a named package is installed nowhere, or any
 *   requested apply failed. Packages that could not be checked do not change
 *   it on their own.
 */
export async function runUpdate(args: UpdateArgs): Promise<number> {
  try {
    const targets = args.name
      ? [{ name: args.name, projectPath: args.projectPath }]
      : await listTargets(args.projectPath);

    if (targets.length === 0) {
      console.log('No installed packages to check.');
      return 0;
    }

    const allChecks: UpdateCheckResult[] = [];
    const allApplied: AppliedUpdate[] = [];
    let failedTargets = 0;
    let namedNotInstalled = false;

    for (const target of targets) {
      const body: Record<string, unknown> = { apply: Boolean(args.apply) };
      if (target.projectPath) body.projectPath = target.projectPath;

      try {
        const result = await apiCall<UpdateResultBody>(
          'POST',
          `/api/marketplace/packages/${encodeURIComponent(target.name)}/update`,
          body
        );
        allChecks.push(...result.checks);
        allApplied.push(...result.applied);
      } catch (err) {
        // Anything but an answer from the server (it could not be reached at
        // all) ends the run below; an error for ONE package does not.
        if (!(err instanceof ApiError)) throw err;
        failedTargets += 1;
        // The route answers 404 for a name installed in no scope: a named
        // run asked about a package that is not there (often a typo).
        if (args.name && err.status === 404) namedNotInstalled = true;
        allChecks.push(couldNotCheck(target.name, err.message));
      }
    }

    renderUpdateChecks(allChecks, Boolean(args.apply));

    if (args.apply && allApplied.length > 0) {
      console.log('');
      console.log('Applied:');
      for (const a of allApplied) {
        console.log(`  ${a.packageName}@${a.version} → ${a.installPath}`);
      }
    }

    // With --apply, a target the server refused is an apply that did not land.
    return namedNotInstalled || (args.apply && failedTargets > 0) ? 1 : 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * List every installed package to check, each in the scope it was found in.
 *
 * With `--project` the listing is that project's merged view (global plus
 * project installs) and every target is checked there. Without it the listing
 * spans every scope, and an agent's install is checked with that agent's
 * directory as its project, so the server walks the same scope the listing
 * found it in. Targets are de-duplicated on (name, scope), because the route
 * checks by name.
 *
 * @param projectPath - The `--project` value, when given.
 */
async function listTargets(projectPath: string | undefined): Promise<UpdateTarget[]> {
  const query = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
  const installed = await apiCall<InstalledListBody>('GET', `/api/marketplace/installed${query}`);
  const byKey = new Map<string, UpdateTarget>();
  for (const pkg of installed.packages) {
    const target = { name: pkg.name, projectPath: projectPath ?? pkg.agentPath };
    byKey.set(`${target.name}\n${target.projectPath ?? ''}`, target);
  }
  return [...byKey.values()];
}

/** A check result standing in for a target the server returned an error for. */
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

/** A version as a person reads it: a commit prints as `commit <short sha>`. */
function formatVersion(version: string, source: VersionSource | undefined): string {
  return source === 'commit' ? `commit ${version.slice(0, 7)}` : version;
}

/**
 * Print one line per check, then a summary that counts all three outcomes.
 * The summary never claims everything is up to date while any package could
 * not be checked.
 */
function renderUpdateChecks(checks: UpdateCheckResult[], apply: boolean): void {
  for (const check of checks) {
    const installed = formatVersion(check.installedVersion, check.installedVersionSource);
    if (check.status === 'unknown') {
      console.log(`${check.packageName}  could not check: ${check.note ?? 'no reason given'}`);
      continue;
    }
    if (check.status === 'update-available') {
      const latest = formatVersion(check.latestVersion, check.latestVersionSource);
      const from = check.marketplace ? `  (${check.marketplace})` : '';
      console.log(`${check.packageName}  ${installed} → ${latest}${from}`);
    } else {
      console.log(`${check.packageName}  up to date (${installed})`);
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
