/**
 * Top-level dispatcher for the `dorkos auth <subcommand>` namespace.
 *
 * Lives in its own module so `cli.ts` can stay focused on global flag parsing
 * and server bootstrap. The dispatcher is invoked from the top-of-file
 * interception block in `cli.ts` (before the strict top-level `parseArgs`, so
 * subcommand flags like `--email`/`--password` are not rejected) and owns:
 *
 * - Help text for `auth` itself and each subcommand.
 * - Dispatch into the injectable handlers in `auth-commands.ts`, wiring them to
 *   the real runtime (`auth-runtime.ts`).
 * - Uniform error rendering for parse and runtime failures.
 *
 * Both subcommands operate directly on the local SQLite database and
 * `~/.dork/config.json` — no running server and no SMTP required (machine access
 * equals owner-level trust).
 *
 * Like every other command handler in this package, the dispatcher returns the
 * intended exit code rather than calling `process.exit` directly — `cli.ts`
 * remains the single source of truth for process termination.
 *
 * @module commands/auth-dispatcher
 */
import {
  parseAuthEnableArgs,
  parseAuthResetPasswordArgs,
  runAuthEnable,
  runAuthResetPassword,
} from './auth-commands.js';
import { buildAuthRuntime, consoleIo, resolveCredentialPrompt } from './auth-runtime.js';

/** Help text rendered when the user runs `dorkos auth` with no subcommand or `--help`. */
export const HELP_TEXT = `
Usage: dorkos auth <subcommand> [options]

Manage local login for this DorkOS instance. Both commands operate directly on
the local data directory — no running server and no email/SMTP required.

Subcommands:
  enable            Create the owner account and require login
  reset-password    Reset the owner account's password

Examples:
  dorkos auth enable
  dorkos auth enable --email you@example.com --password '<secret>'
  dorkos auth reset-password
`;

/** Help text for `dorkos auth enable`. */
export const ENABLE_HELP = `
Usage: dorkos auth enable [options]

Create the owner account, then require login for this instance. Prompts for an
email and password (entered twice) when run interactively; supply --email and
--password, or pipe them on stdin (one per line), for non-interactive use.

Fails if an owner account already exists — use \`dorkos auth reset-password\` to
change its password instead.

Options:
      --email <email>       Owner email (identifier only; never verified)
      --password <password> Owner password
  -h, --help                Show this help message

A running server must be restarted to pick up the change.
`;

/** Help text for `dorkos auth reset-password`. */
export const RESET_HELP = `
Usage: dorkos auth reset-password [options]

Reset the owner account's password. Works with no running server and no SMTP.
Prompts for a new password (entered twice) when run interactively; supply
--password or pipe it on stdin for non-interactive use.

Options:
      --password <password> New owner password
  -h, --help                Show this help message
`;

/**
 * Dispatch a `dorkos auth <subcommand>` invocation.
 *
 * @param dorkHome - The resolved `~/.dork` data directory (set by `cli.ts`).
 * @param subcommand - The subcommand name (`enable`, `reset-password`). Pass
 *   `undefined`, `--help`, or `-h` to print help.
 * @param subArgs - The argv slice that follows the subcommand.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runAuthDispatcher(
  dorkHome: string,
  subcommand: string | undefined,
  subArgs: string[]
): Promise<number> {
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }

  try {
    if (subcommand === 'enable') {
      const options = parseAuthEnableArgs(subArgs);
      if (options.help) {
        console.log(ENABLE_HELP);
        return 0;
      }
      const { auth, db, configStore } = await buildAuthRuntime(dorkHome);
      return await runAuthEnable({
        options,
        auth,
        db,
        configStore,
        prompt: resolveCredentialPrompt(),
        io: consoleIo,
      });
    }

    if (subcommand === 'reset-password') {
      const options = parseAuthResetPasswordArgs(subArgs);
      if (options.help) {
        console.log(RESET_HELP);
        return 0;
      }
      const { auth, db } = await buildAuthRuntime(dorkHome);
      return await runAuthResetPassword({
        options,
        auth,
        db,
        prompt: resolveCredentialPrompt(),
        io: consoleIo,
      });
    }

    console.error(`Unknown auth subcommand: ${subcommand}`);
    console.error('Usage: dorkos auth <enable|reset-password> [options]');
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
