/**
 * CLI handler for `dorkos uninstall <name>`.
 *
 * Calls `POST /api/marketplace/packages/:name/uninstall` and prints a
 * one-line summary. Defaults preserve `.dork/data/` and
 * `.dork/secrets.json`; pass `--purge` to remove them too.
 *
 * @module commands/uninstall
 */
import { parseArgs } from 'node:util';
import { ApiError, apiCall } from '../lib/api-client.js';

/** Parsed CLI arguments accepted by {@link runUninstall}. */
export interface UninstallArgs {
  /** Package name to uninstall. */
  name: string;
  /** Remove preserved data and secrets in addition to package files. */
  purge?: boolean;
  /** Project path for project-local uninstalls. */
  projectPath?: string;
}

/** Uninstall API response shape. Mirrors {@link UninstallResult} on the server. */
interface UninstallResultBody {
  ok: boolean;
  packageName: string;
  removedFiles: number;
  preservedData: string[];
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos uninstall <name> [--purge] [--project <path>]';

/**
 * Parse the raw argv slice that follows `dorkos uninstall`.
 *
 * @param rawArgs - The argv slice after `uninstall`.
 * @returns A typed {@link UninstallArgs} object.
 */
export function parseUninstallArgs(rawArgs: string[]): UninstallArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        purge: { type: 'boolean', default: false },
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
      throw new Error(`Unknown option for 'uninstall': ${option}\n${USAGE_LINE}`);
    }
    throw err;
  }

  const { values, positionals } = parsed;
  const name = positionals[0];
  if (!name) {
    throw new Error(`Missing required <name> argument.\n${USAGE_LINE}`);
  }

  return {
    name,
    purge: Boolean(values.purge),
    projectPath: typeof values.project === 'string' ? values.project : undefined,
  };
}

/**
 * Implements `dorkos uninstall <name>`.
 *
 * @param args - Parsed uninstall arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runUninstall(args: UninstallArgs): Promise<number> {
  try {
    const body: Record<string, unknown> = {};
    if (args.purge) body.purge = true;
    if (args.projectPath) body.projectPath = args.projectPath;

    const result = await apiCall<UninstallResultBody>(
      'POST',
      `/api/marketplace/packages/${encodeURIComponent(args.name)}/uninstall`,
      body
    );

    console.log(`Uninstalled ${result.packageName} (${result.removedFiles} entries removed)`);
    if (!args.purge && result.preservedData.length > 0) {
      console.log('Preserved:');
      for (const path of result.preservedData) {
        console.log(`  ${path}`);
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
