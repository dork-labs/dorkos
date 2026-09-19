/**
 * Top-level dispatcher for `dorkos browser <subcommand>`.
 *
 * Intercepted at the top of `cli.ts`, before the global flag parser and before
 * any server or config setup: the agent browser needs neither. Owns the help
 * text, the dynamic import of the handlers, and uniform error rendering; the
 * handlers return exit codes and `cli.ts` exits.
 *
 * @module commands/browser-dispatcher
 */

/** Help for `dorkos browser` with no subcommand or `--help`. */
const HELP_TEXT = `
Usage: dorkos browser <subcommand> [options]

Sign in to websites once, in a separate "agent browser", so your agents'
browsers start already signed in. Agents get the saved sign-ins, never your
passwords.

Subcommands:
  login [site]        Open the agent browser, sign in, press Enter to save
    --plain           Open it with no automation marker, for sites that refuse
                      to sign you in otherwise (sign-ins that end when the
                      browser closes are not kept)
    --chrome <path>   Use this Chrome or Chromium instead of the usual one
  status [--json]     Which sites have a saved sign-in, and how long each lasts
  forget <site>       Take one site away from your agents
  forget --all        Take every site away (asks first; --yes to skip)

Examples:
  dorkos browser login github.com
  dorkos browser status
  dorkos browser forget github.com

Then give an agent the browser: open the agent's profile, then Tools & MCP,
then Signed-in browser. Setup for the claude, codex and opencode CLIs:
https://dorkos.ai/docs/guides/agent-browser
`;

/**
 * Dispatch a `dorkos browser <subcommand>` invocation.
 *
 * @param subcommand - `login`, `status` or `forget`; `undefined`, `--help` or `-h` prints help.
 * @param subArgs - The argv after the subcommand.
 * @returns The exit code.
 */
export async function runBrowserDispatcher(
  subcommand: string | undefined,
  subArgs: string[]
): Promise<number> {
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }
  try {
    const commands = await import('./browser-commands.js');
    const { defaultBrowserDeps } = await import('../lib/agent-browser/browser-deps.js');
    const deps = defaultBrowserDeps();
    if (subcommand === 'login') {
      return await commands.runBrowserLogin(commands.parseBrowserLoginArgs(subArgs), deps);
    }
    if (subcommand === 'status') {
      return await commands.runBrowserStatus(commands.parseBrowserStatusArgs(subArgs), deps);
    }
    if (subcommand === 'forget') {
      return await commands.runBrowserForget(commands.parseBrowserForgetArgs(subArgs), deps);
    }
    console.error(`Unknown browser subcommand: ${subcommand}`);
    console.error('Usage: dorkos browser <login|status|forget> [options]');
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
