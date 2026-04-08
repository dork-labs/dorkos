/**
 * Top-level dispatcher for the `dorkos cache <subcommand>` namespace.
 *
 * Lives in its own module so `cli.ts` can stay focused on global flag
 * parsing and server bootstrap. The dispatcher is invoked from the
 * top-of-file interception block in `cli.ts` and owns:
 *
 * - Help text for `cache` itself (no/`--help`/`-h` subcommand).
 * - Dynamic-import dispatch into the three leaf handlers
 *   (`list`/`prune`/`clear`) in `cache-commands.ts`.
 * - Uniform error rendering for parse and runtime failures.
 *
 * Like every other command handler in this package, the dispatcher
 * returns the intended exit code rather than calling `process.exit`
 * directly — `cli.ts` remains the single source of truth for process
 * termination.
 *
 * @module commands/cache-dispatcher
 */

/** Help text rendered when the user runs `dorkos cache` with no subcommand or `--help`. */
const HELP_TEXT = `
Usage: dorkos cache <subcommand> [options]

Inspect and manage the marketplace package cache on the running DorkOS server.

Subcommands:
  list                       Show cache counts and total size
  prune [--keep-last-n <N>]  Remove older cached package SHAs (default: keep 1)
  clear [-y|--yes]           Wipe the entire cache (requires confirmation)

Examples:
  dorkos cache list
  dorkos cache prune
  dorkos cache prune --keep-last-n 3
  dorkos cache clear --yes
`;

/**
 * Dispatch a `dorkos cache <subcommand>` invocation.
 *
 * @param subcommand - The subcommand name (e.g. `list`, `prune`, `clear`).
 *   Pass `undefined`, `--help`, or `-h` to print help.
 * @param subArgs - The argv slice that follows the subcommand.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runCacheDispatcher(
  subcommand: string | undefined,
  subArgs: string[]
): Promise<number> {
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }

  try {
    const {
      runCacheList,
      runCachePrune,
      runCacheClear,
      parseCacheListArgs,
      parseCachePruneArgs,
      parseCacheClearArgs,
    } = await import('./cache-commands.js');

    if (subcommand === 'list') {
      parseCacheListArgs(subArgs);
      return await runCacheList();
    }
    if (subcommand === 'prune') {
      return await runCachePrune(parseCachePruneArgs(subArgs));
    }
    if (subcommand === 'clear') {
      return await runCacheClear(parseCacheClearArgs(subArgs));
    }

    console.error(`Unknown cache subcommand: ${subcommand}`);
    console.error('Usage: dorkos cache <list|prune|clear> [options]');
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
