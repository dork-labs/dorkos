/**
 * CLI handler for `dorkos marketplace check-files <name>` (DOR-2320).
 *
 * Compares this package with the version you installed, so updates keep your edits.
 *
 * A package an older DorkOS installed has no installed-files record, so
 * DorkOS cannot tell its files from yours until its next update. This asks the
 * running server to build that record from the exact commit the package was
 * installed at (`POST /api/marketplace/packages/:name/check-files`). The server
 * writes it only when that commit matches the installed files byte for byte,
 * and otherwise says why and changes nothing.
 *
 * Exits 0 when the files were recorded (or already were) and 1 when they could
 * not be, so a script can tell. `--json` prints the server's answer.
 *
 * @module commands/marketplace-check-files
 */
import { parseArgs } from 'node:util';
import type { CheckFilesResult } from '@dorkos/shared/marketplace-schemas';
import { apiCall } from '../lib/api-client.js';
import { printError, printJson } from '../lib/operator-output.js';
import { resolveProjectFlag } from '../lib/package-commands.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceCheckFiles}. */
export interface MarketplaceCheckFilesArgs {
  /** The installed package whose files to check. */
  name: string;
  /** The project the installation belongs to, for a project-scoped install. */
  projectPath?: string;
  /** Print the server's answer as JSON. */
  json: boolean;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace check-files <name> [--project <path>] [--json]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace check-files`.
 *
 * @param rawArgs - The argv slice after `marketplace check-files`.
 * @returns A typed {@link MarketplaceCheckFilesArgs} object.
 * @throws When no package name is given.
 */
export function parseMarketplaceCheckFilesArgs(rawArgs: string[]): MarketplaceCheckFilesArgs {
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
    rethrowUnknownOption(err, 'marketplace check-files', USAGE_LINE);
  }
  const [name] = parsed.positionals;
  if (!name) throw new Error(`Name the package whose files to check.\n${USAGE_LINE}`);
  return {
    name,
    projectPath: resolveProjectFlag(parsed.values.project),
    json: Boolean(parsed.values.json),
  };
}

/**
 * Implements `dorkos marketplace check-files`.
 *
 * @param args - Parsed arguments.
 * @returns `0` when its files are recorded (now or already) or its kept files sorted, `1` when not.
 */
export async function runMarketplaceCheckFiles(args: MarketplaceCheckFilesArgs): Promise<number> {
  let result: CheckFilesResult;
  try {
    result = await apiCall<CheckFilesResult>(
      'POST',
      `/api/marketplace/packages/${encodeURIComponent(args.name)}/check-files`,
      args.projectPath !== undefined ? { projectPath: args.projectPath } : {}
    );
  } catch (err) {
    printError(err);
    return 1;
  }
  if (args.json) printJson(result);
  else console.log(result.message);
  return result.outcome === 'rebuilt' ||
    result.outcome === 'sorted' ||
    result.outcome === 'not-needed'
    ? 0
    : 1;
}
