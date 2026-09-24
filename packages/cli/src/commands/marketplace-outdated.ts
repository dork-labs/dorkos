/**
 * CLI handler for `dorkos marketplace outdated`.
 *
 * Asks the all-packages update door once — `GET /api/marketplace/updates`, with
 * `?projectPath=` for `--project` — and prints only the installations that have
 * a newer version, plus the ones that could not be checked. It never changes
 * anything; `dorkos marketplace update --apply` does that.
 *
 * The exit code is the answer, so a script or a scheduled job can gate on it.
 * It follows `diff`'s convention:
 *
 * - `0` — every installation was checked and is current (or nothing is installed).
 * - `1` — at least one installation has an update. This wins over `2`: a known
 *   stale package is the fact to act on, and the unchecked ones are still printed.
 * - `2` — could not tell: nothing is known to be stale, but at least one
 *   installation could not be checked, or the request itself failed (the server
 *   is not running, refused the request, or the arguments were wrong).
 *
 * @module commands/marketplace-outdated
 */
import { parseArgs } from 'node:util';
import type {
  InstallationUpdateCheck,
  InstallationUpdatesResult,
} from '@dorkos/shared/marketplace-schemas';
import { apiCall } from '../lib/api-client.js';
import { formatUpdateLine, labelOf } from '../lib/installation-label.js';
import { printError, printJson } from '../lib/operator-output.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceOutdated}. */
export interface MarketplaceOutdatedArgs {
  /** Check this project's view (global installs plus its own) instead of every scope. */
  projectPath?: string;
  /** Print `{ outdated, unknown }` as JSON instead of lines. */
  json: boolean;
}

/** The exit codes of `dorkos marketplace outdated`; see the module comment. */
export const OUTDATED_EXIT = {
  /** Every installation was checked and is current, or nothing is installed. */
  current: 0,
  /** At least one installation has an update. */
  outdated: 1,
  /** Nothing is known to be stale, but something could not be checked. */
  unknown: 2,
} as const;

/** The `--json` document: the server's own check objects, current ones left out. */
export interface OutdatedJson {
  /** Every installation whose check is `update-available`, in scan order. */
  outdated: InstallationUpdateCheck[];
  /** Every installation whose check is `unknown`, each with its `note`. */
  unknown: InstallationUpdateCheck[];
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace outdated [--project <path>] [--json]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace outdated`. It takes
 * no package name: it always reports every installation in view.
 *
 * @param rawArgs - The argv slice after `marketplace outdated`.
 * @returns A typed {@link MarketplaceOutdatedArgs} object.
 */
export function parseMarketplaceOutdatedArgs(rawArgs: string[]): MarketplaceOutdatedArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        project: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace outdated', USAGE_LINE);
  }
  const { values } = parsed;
  return {
    projectPath: typeof values.project === 'string' ? values.project : undefined,
    json: Boolean(values.json),
  };
}

/**
 * Implements `dorkos marketplace outdated`.
 *
 * @param args - Parsed arguments.
 * @returns One of {@link OUTDATED_EXIT}.
 */
export async function runMarketplaceOutdated(args: MarketplaceOutdatedArgs): Promise<number> {
  let result: InstallationUpdatesResult;
  try {
    const query = args.projectPath ? `?projectPath=${encodeURIComponent(args.projectPath)}` : '';
    result = await apiCall<InstallationUpdatesResult>('GET', `/api/marketplace/updates${query}`);
  } catch (err) {
    printError(err);
    return OUTDATED_EXIT.unknown;
  }

  const outdated = result.checks.filter((c) => c.status === 'update-available');
  const unknown = result.checks.filter((c) => c.status === 'unknown');
  const code =
    outdated.length > 0
      ? OUTDATED_EXIT.outdated
      : unknown.length > 0
        ? OUTDATED_EXIT.unknown
        : OUTDATED_EXIT.current;

  if (args.json) {
    printJson({ outdated, unknown } satisfies OutdatedJson);
    return code;
  }

  if (result.checks.length === 0) {
    console.log('No installed packages to check.');
    return code;
  }
  if (code === OUTDATED_EXIT.current) {
    const n = result.checks.length;
    console.log(`Everything is up to date (${n} ${n === 1 ? 'package' : 'packages'} checked).`);
    return code;
  }

  for (const check of outdated) {
    console.log(formatUpdateLine(check));
    // A caveat on a known answer, such as a check of the default branch.
    if (check.note) console.log(`  ${check.note}`);
  }
  if (unknown.length > 0) {
    if (outdated.length > 0) console.log('');
    console.log('Could not check:');
    for (const check of unknown) {
      console.log(`  ${labelOf(check)}: ${check.note ?? 'no reason given'}`);
    }
  }

  console.log('');
  const parts = [
    outdated.length > 0 &&
      `${outdated.length} ${outdated.length === 1 ? 'update' : 'updates'} available`,
    unknown.length > 0 && `${unknown.length} could not be checked`,
  ].filter(Boolean);
  const hint =
    outdated.length > 0
      ? ` Run \`dorkos marketplace update --apply${
          args.projectPath ? ` --project ${shellWord(args.projectPath)}` : ''
        }\` to install ${outdated.length === 1 ? 'it' : 'them'}.`
      : '';
  console.log(`${parts.join(', ')}.${hint}`);
  return code;
}

/** A path as it can be pasted back into a shell: quoted when it holds whitespace or a quote. */
function shellWord(value: string): string {
  return /[\s'"]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}
