/**
 * Top-level dispatcher for the `dorkos harness <subcommand>` namespace.
 *
 * Lives in its own module so `cli.ts` can stay focused on global flag parsing
 * and server bootstrap. The dispatcher is invoked from the top-of-file
 * interception block in `cli.ts` and owns:
 *
 * - Help text for `harness` itself (no/`--help`/`-h` subcommand).
 * - Dynamic-import dispatch into the `sync` handler in `harness-sync-command.ts`.
 * - Uniform error rendering for parse and runtime failures.
 *
 * The whole namespace drives the `@dorkos/harness` projection engine entirely
 * offline — no `~/.dork` directory and no server runtime.
 *
 * Like every other command handler in this package, the dispatcher returns the
 * intended exit code rather than calling `process.exit` directly — `cli.ts`
 * remains the single source of truth for process termination.
 *
 * @module commands/harness-dispatcher
 */

/** Help text rendered when the user runs `dorkos harness` with no subcommand or `--help`. */
const HELP_TEXT = `
Usage: dorkos harness <subcommand> [options]

Project skills, instructions, hooks, and commands from the canonical
\`.agents/\` source to every enabled agent harness.

Subcommands:
  sync [options]    Report or apply the cross-harness projection plan

Options (sync):
      --check            Report drift without touching disk (default)
      --fix              Realize the plan on disk
      --harness <id>     Narrow to one harness (claude-code|codex|cursor|gemini|copilot)

Examples:
  dorkos harness sync
  dorkos harness sync --fix
  dorkos harness sync --check --harness codex
`;

/**
 * Dispatch a `dorkos harness <subcommand>` invocation.
 *
 * @param subcommand - The subcommand name (currently only `sync`). Pass
 *   `undefined`, `--help`, or `-h` to print help.
 * @param subArgs - The argv slice that follows the subcommand.
 * @returns The intended process exit code (`0` success, `1` drift/error).
 */
export async function runHarnessDispatcher(
  subcommand: string | undefined,
  subArgs: string[]
): Promise<number> {
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }

  try {
    if (subcommand === 'sync') {
      const { runHarnessSync, parseHarnessSyncArgs } = await import('../harness-sync-command.js');
      const result = await runHarnessSync(parseHarnessSyncArgs(subArgs));
      return result.exitCode;
    }

    console.error(`Unknown harness subcommand: ${subcommand}`);
    console.error('Usage: dorkos harness sync [--check|--fix] [--harness <id>]');
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
