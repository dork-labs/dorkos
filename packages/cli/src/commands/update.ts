/**
 * CLI handler for `dorkos update [name]`.
 *
 * Advisory by default — calls `POST /api/marketplace/packages/:name/update`
 * (with `apply: false`) and prints any pending updates. Pass `--apply` to
 * actually reinstall.
 *
 * When no `<name>` is given, the CLI iterates over every installed
 * package returned by `GET /api/marketplace/installed` and runs the update
 * check for each. Per the spec, an `/api/marketplace/update-all` endpoint
 * is intentionally deferred, so the iteration lives client-side.
 *
 * @module commands/update
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';

/** Parsed CLI arguments accepted by {@link runUpdate}. */
export interface UpdateArgs {
  /** Optional package name; when omitted, every installed package is checked. */
  name?: string;
  /** Apply the update (default: advisory only). */
  apply?: boolean;
  /** Project path for project-local updates. */
  projectPath?: string;
}

/** A single update check result. Mirrors `UpdateCheckResult` on the server. */
interface UpdateCheckResult {
  packageName: string;
  installedVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  marketplace: string;
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

/** Response shape for `GET /api/marketplace/installed`. */
interface InstalledListBody {
  packages: { name: string }[];
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
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      const option = match?.[1] ?? 'unknown';
      throw new Error(`Unknown option for 'update': ${option}\n${USAGE_LINE}`);
    }
    throw err;
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
 * @param args - Parsed update arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runUpdate(args: UpdateArgs): Promise<number> {
  try {
    const targets = args.name ? [args.name] : await listInstalledPackageNames();

    if (targets.length === 0) {
      console.log('No installed packages to check.');
      return 0;
    }

    const allChecks: UpdateCheckResult[] = [];
    const allApplied: AppliedUpdate[] = [];

    for (const name of targets) {
      const body: Record<string, unknown> = { apply: Boolean(args.apply) };
      if (args.projectPath) body.projectPath = args.projectPath;

      const result = await apiCall<UpdateResultBody>(
        'POST',
        `/api/marketplace/packages/${encodeURIComponent(name)}/update`,
        body
      );
      allChecks.push(...result.checks);
      allApplied.push(...result.applied);
    }

    renderUpdateChecks(allChecks, Boolean(args.apply));

    if (args.apply && allApplied.length > 0) {
      console.log('');
      console.log('Applied:');
      for (const a of allApplied) {
        console.log(`  ${a.packageName}@${a.version} → ${a.installPath}`);
      }
    }

    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

/**
 * Fetch the names of every installed package via the marketplace API.
 * Returns an empty array when nothing is installed.
 */
async function listInstalledPackageNames(): Promise<string[]> {
  const installed = await apiCall<InstalledListBody>('GET', '/api/marketplace/installed');
  return installed.packages.map((p) => p.name);
}

/**
 * Render a flat list of update checks. Up-to-date entries are reported
 * once with a quiet status line; pending updates each get a dedicated line
 * with a hint about `--apply`.
 */
function renderUpdateChecks(checks: UpdateCheckResult[], apply: boolean): void {
  const pending = checks.filter((c) => c.hasUpdate);
  const upToDate = checks.length - pending.length;

  if (pending.length === 0) {
    console.log(`All ${checks.length} package(s) up to date.`);
    return;
  }

  for (const check of pending) {
    const suffix = apply ? '' : ' (run with --apply to update)';
    console.log(
      `${check.packageName}: ${check.installedVersion} → ${check.latestVersion}${suffix}`
    );
  }

  if (upToDate > 0) {
    console.log(`${upToDate} package(s) already up to date.`);
  }
}
