/**
 * CLI handler for `dorkos marketplace prepare <name>` (DOR-2320).
 *
 * A package an older DorkOS installed has no installed-files record, so
 * DorkOS cannot tell its files from yours until its next update. This asks the
 * running server to build that record from the exact commit the package was
 * installed at (`POST /api/marketplace/packages/:name/prepare`). The server
 * writes it only when that commit matches the installed files byte for byte,
 * and otherwise says why and changes nothing.
 *
 * Exits 0 when the package is prepared (or needed nothing) and 1 when it could
 * not be, so a script can tell. `--json` prints the server's answer.
 *
 * @module commands/marketplace-prepare
 */
import { parseArgs } from 'node:util';
import type { PrepareResult } from '@dorkos/shared/marketplace-schemas';
import { apiCall } from '../lib/api-client.js';
import { printError, printJson } from '../lib/operator-output.js';
import { resolveProjectFlag } from '../lib/package-commands.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runMarketplacePrepare}. */
export interface MarketplacePrepareArgs {
  /** The installed package to prepare. */
  name: string;
  /** The project the installation belongs to, for a project-scoped install. */
  projectPath?: string;
  /** Print the server's answer as JSON. */
  json: boolean;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace prepare <name> [--project <path>] [--json]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace prepare`.
 *
 * @param rawArgs - The argv slice after `marketplace prepare`.
 * @returns A typed {@link MarketplacePrepareArgs} object.
 * @throws When no package name is given.
 */
export function parseMarketplacePrepareArgs(rawArgs: string[]): MarketplacePrepareArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        project: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace prepare', USAGE_LINE);
  }
  const [name] = parsed.positionals;
  if (!name) throw new Error(`Name the package to prepare.\n${USAGE_LINE}`);
  return {
    name,
    projectPath: resolveProjectFlag(parsed.values.project),
    json: Boolean(parsed.values.json),
  };
}

/**
 * Implements `dorkos marketplace prepare`.
 *
 * @param args - Parsed arguments.
 * @returns `0` when prepared or already recorded, `1` when it could not be.
 */
export async function runMarketplacePrepare(args: MarketplacePrepareArgs): Promise<number> {
  let result: PrepareResult;
  try {
    result = await apiCall<PrepareResult>(
      'POST',
      `/api/marketplace/packages/${encodeURIComponent(args.name)}/prepare`,
      args.projectPath !== undefined ? { projectPath: args.projectPath } : {}
    );
  } catch (err) {
    printError(err);
    return 1;
  }
  if (args.json) printJson(result);
  else console.log(result.message);
  return result.outcome === 'rebuilt' || result.outcome === 'not-needed' ? 0 : 1;
}
