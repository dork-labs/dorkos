/**
 * Top-level dispatcher for the `dorkos harness <subcommand>` namespace.
 *
 * Lives in its own module so `cli.ts` can stay focused on global flag parsing
 * and server bootstrap. The dispatcher is invoked from the top-of-file
 * interception block in `cli.ts` and owns:
 *
 * - Help text for `harness` itself (no/`--help`/`-h` subcommand).
 * - Dynamic-import dispatch into the `sync` handler in `harness-sync-command.ts`
 *   and the `hooks` handler in `harness-hooks-command.ts`.
 * - Uniform error rendering for parse and runtime failures.
 *
 * The whole namespace drives the `@dorkos/harness` projection engine entirely
 * offline — no server runtime. It reads `~/.dork/config.json` for the hook
 * decisions a person has made, and writes it only for the two flags that exist
 * to change one (`sync --fix --allow-hooks`, `hooks --revoke`).
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
  hooks [options]   See and change which packages may run commands

Sync acts on the folder you run it in, reading its manifest at
\`.agents/harness.manifest.json\` — so run it from your project root. If that
file is missing, --check stops and tells you where it looked, and --fix
writes a default one there.

Some packages ship hooks: commands your agent runs on its own. Sync holds
those back until you allow them, prints each command it held back, and
carries on with everything else.

Every run also says what it noticed: a harness you use here but have not
turned on, and the lines your .gitignore is missing for the files DorkOS
writes. Neither changes the exit code, and neither is acted on without a flag.

Options (sync):
      --check                 Report drift. Never writes anything (default)
      --fix                   Realize the plan on disk
      --harness <id>          Narrow to one harness
                              (claude-code|codex|cursor|gemini|copilot|opencode)
      --strict                Exit 1 if any hooks were held back
      --allow-hooks <pkg>     Install that package's hooks and remember it.
                              Needs --fix. Repeatable
      --enable <harness>      Turn a harness on in your manifest and set it up.
                              Needs --fix. Repeatable
      --write-gitignore       Add the lines your .gitignore is missing for the
                              files DorkOS writes. Needs --fix

Options (hooks):
      --list                  Show every decision you have made (default)
      --revoke <pkg>          Forget a package's decision, so you are asked again

Examples:
  dorkos harness sync
  dorkos harness sync --fix
  dorkos harness sync --check --harness codex
  dorkos harness sync --fix --allow-hooks acme-tools
  dorkos harness sync --fix --enable cursor
  dorkos harness sync --fix --write-gitignore
  dorkos harness hooks --list
  dorkos harness hooks --revoke acme-tools
`;

/**
 * Dispatch a `dorkos harness <subcommand>` invocation.
 *
 * @param subcommand - The subcommand name (`sync` or `hooks`). Pass
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
      // `--help`/`-h` exits cleanly with help text, matching every other command in
      // cli.ts. Without this, `--help` reaches parseHarnessSyncArgs (strict parseArgs)
      // and throws ERR_PARSE_ARGS_UNKNOWN_OPTION, printing an error instead of help.
      if (subArgs[0] === '--help' || subArgs[0] === '-h') {
        console.log(HELP_TEXT);
        return 0;
      }
      const { runHarnessSync, parseHarnessSyncArgs } = await import('../harness-sync-command.js');
      const result = await runHarnessSync(parseHarnessSyncArgs(subArgs));
      return result.exitCode;
    }

    if (subcommand === 'hooks') {
      if (subArgs[0] === '--help' || subArgs[0] === '-h') {
        console.log(HELP_TEXT);
        return 0;
      }
      const { runHarnessHooks, parseHarnessHooksArgs } =
        await import('../harness-hooks-command.js');
      const result = await runHarnessHooks(parseHarnessHooksArgs(subArgs));
      return result.exitCode;
    }

    console.error(`Unknown harness subcommand: ${subcommand}`);
    console.error('Usage: dorkos harness <sync|hooks> [options]');
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
