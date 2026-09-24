/**
 * CLI handler for `dorkos marketplace update [name]` (and its shorthand,
 * `dorkos update [name]`).
 *
 * Advisory by default: prints one line per package — a newer version, up to
 * date, or could not check (and why).
 *
 * - **With a name**, the check asks the one-package door,
 *   `POST /api/marketplace/packages/:name/update`.
 * - **Without one**, it asks the all-packages door in ONE request,
 *   `GET /api/marketplace/updates`: the server checks every installation in
 *   view (every scope, or `--project`'s view) and answers one line's worth per
 *   installation, so the same package in two places prints as two lines, each
 *   naming where it lives.
 *
 * `--apply` checks through the all-packages door (keeping the named package's
 * installations when a name is given), prints everything each new version runs,
 * asks before going on (`--yes` skips the question), and applies exactly what it
 * printed through `POST /api/marketplace/updates`, held to it (DOR-2306). From an
 * agent's session a person approves it first; the run prints how to retry with
 * `--approval <token>` once they have.
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
import {
  isOlderServer,
  OLDER_SERVER_MESSAGE,
  resolveProjectFlag,
} from '../lib/package-commands.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';
import { confirm } from '../lib/confirm-prompt.js';
import { renderDisclosureLines } from '../lib/disclosure-render.js';

/** Parsed CLI arguments accepted by {@link runUpdate}. */
export interface UpdateArgs {
  /** Optional package name; when omitted, every installed package is checked. */
  name?: string;
  /** Apply the update (default: advisory only). */
  apply?: boolean;
  /** Skip the confirmation prompt after printing what each new version runs. */
  yes?: boolean;
  /** Approval token from an earlier run that came back waiting for a person. */
  approvalToken?: string;
  /** Absolute project path for project-local updates, resolved against the caller's cwd. */
  projectPath?: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE =
  'Usage: dorkos marketplace update [<name>] [--apply [--yes] [--approval <token>]] [--project <path>]';

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
        yes: { type: 'boolean', short: 'y', default: false },
        approval: { type: 'string' },
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
    yes: Boolean(values.yes),
    approvalToken: typeof values.approval === 'string' ? values.approval : undefined,
    projectPath: resolveProjectFlag(values.project),
  };
}

/**
 * Implements `dorkos marketplace update [name]`.
 *
 * @param args - Parsed update arguments.
 * @returns The intended process exit code: `0` on success, `1` when the server
 *   was unreachable or refused the request, a named package is installed
 *   nowhere, an update is waiting for a person's approval, or any requested
 *   reinstall failed. Packages that could not be checked do not change it on
 *   their own.
 */
export async function runUpdate(args: UpdateArgs): Promise<number> {
  try {
    if (args.apply) return await applyUpdates(args);
    return args.name ? await checkOne(args.name, args) : await checkAll(args);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * One package, through the per-package door. An error for it prints as a
 * `could not check` line; a 404 (installed nowhere, often a typo) exits 1.
 */
async function checkOne(name: string, args: UpdateArgs): Promise<number> {
  const body: Record<string, unknown> = {};
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
    renderUpdateChecks([couldNotCheck(name, err.message)], false);
    return err.status === 404 ? 1 : 0;
  }

  renderUpdateChecks(result.checks, false);
  return 0;
}

/**
 * Every installation in view, in one request. The server isolates failures per
 * installation, so there is nothing left to loop over here.
 */
async function checkAll(args: UpdateArgs): Promise<number> {
  const result = await fetchChecks(args);
  if (!result) return 1;
  if (result.checks.length === 0) {
    console.log('No installed packages to check.');
    return 0;
  }
  renderUpdateChecks(result.checks, false);
  return 0;
}

/** Every installation's check in view, or `undefined` after saying the server is too old. */
async function fetchChecks(args: UpdateArgs): Promise<InstallationUpdatesResult | undefined> {
  try {
    return await apiCall<InstallationUpdatesResult>(
      'GET',
      `/api/marketplace/updates${
        args.projectPath ? `?projectPath=${encodeURIComponent(args.projectPath)}` : ''
      }`
    );
  } catch (err) {
    // This door has no 404 of its own, so one is a DorkOS started before this
    // CLI; anything else goes to the single catch.
    if (!isOlderServer(err)) throw err;
    console.error(OLDER_SERVER_MESSAGE);
    return undefined;
  }
}

/** The answer an update gets while it waits for a person (an agent's run only). */
interface AwaitingApprovalBody {
  status: 'requires_confirmation';
  confirmationToken: string;
  message: string;
}

/**
 * Check, print what each new version runs, confirm, then update exactly what
 * was printed (DOR-2306). The apply sends each installation's version and
 * disclosure back as they were printed; the server installs only a version
 * that still matches and refuses the whole apply otherwise, so what a person
 * says yes to here is what runs.
 *
 * From inside an agent's session the server asks a person first: the run
 * prints how to retry once they have, and exits non-zero.
 */
async function applyUpdates(args: UpdateArgs): Promise<number> {
  const result = await fetchChecks(args);
  if (!result) return 1;

  const inView = args.name
    ? result.checks.filter((check) => check.packageName === args.name)
    : result.checks;
  if (args.name && inView.length === 0) {
    console.error(`${args.name} is not installed here.`);
    return 1;
  }
  if (inView.length === 0) {
    console.log('No installed packages to check.');
    return 0;
  }
  renderUpdateChecks(inView, true);

  // Only what can be shown can be approved: a check that could not say what
  // its new version runs is never offered (the server marks it unknown).
  const stale = inView.filter((c) => c.status === 'update-available' && c.disclosed !== undefined);
  if (stale.length === 0) return 0;

  console.log('');
  console.log(stale.length === 1 ? 'What the new version runs:' : 'What each new version runs:');
  for (const check of stale) {
    console.log(
      `  ${labelOf(check)} → ${formatVersion(check.latestVersion, check.latestVersionSource)}`
    );
    for (const line of renderDisclosureLines(
      check.disclosed,
      check.scope === 'global' ? 'global' : 'project'
    )) {
      console.log(line);
    }
  }
  console.log('');

  if (!args.yes) {
    const proceed = await confirm(
      stale.length === 1 ? 'Update it?' : `Update these ${stale.length}?`
    );
    if (!proceed) {
      console.log('Nothing was updated.');
      return 0;
    }
  }

  let applied: InstallationUpdatesResult | AwaitingApprovalBody;
  try {
    applied = await apiCall<InstallationUpdatesResult | AwaitingApprovalBody>(
      'POST',
      '/api/marketplace/updates',
      {
        apply: true,
        targets: stale.map((check) => ({
          installPath: check.installPath,
          latestVersion: check.latestVersion,
          disclosed: check.disclosed ?? null,
          contentHash: check.contentHash ?? '',
        })),
        ...(args.projectPath && { projectPath: args.projectPath }),
        ...(args.approvalToken && { confirmationToken: args.approvalToken }),
      }
    );
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 409) {
      // A new version changed what it runs after the check printed above.
      console.error(`Nothing was updated. ${err.message}`);
      return 1;
    }
    const reason = (err.body as { reason?: unknown }).reason;
    if (err.status === 403 && typeof reason === 'string') {
      console.error(`Nothing was updated: ${reason}`);
      return 1;
    }
    throw err;
  }

  if ('status' in applied && applied.status === 'requires_confirmation') {
    console.error(applied.message);
    const target = args.name ? ` ${args.name}` : '';
    const project = args.projectPath ? ` --project ${args.projectPath}` : '';
    console.error(
      `Retry with: dorkos marketplace update${target} --apply --yes${project} --approval ${applied.confirmationToken}`
    );
    return 1;
  }
  return reportApplied(applied as InstallationUpdatesResult);
}

/** Print what an apply changed, and exit non-zero when any reinstall failed. */
function reportApplied(result: InstallationUpdatesResult): number {
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
