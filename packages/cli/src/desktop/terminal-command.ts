/**
 * `dorkos` as the Mac app's Terminal command runs it (DOR-3105): the commands that
 * make sense beside a running app, bundled into the app as
 * `dist/cli/dorkos.mjs` (`apps/desktop/scripts/build-server.ts`) and run by
 * `~/.local/bin/dorkos` with the app's own Node.
 *
 * It is not the whole CLI on purpose. The app already runs DorkOS, and a plain
 * `dorkos` would start a second server beside it. Every other command says so and
 * names the full command line.
 *
 * @module desktop/terminal-command
 */
import { runBrowserDispatcher } from '../commands/browser-dispatcher.js';

declare const __CLI_VERSION__: string;

/** What `dorkos`, `dorkos --help` or an unknown command prints. */
export const TERMINAL_COMMAND_HELP = `
Usage: dorkos <command>

This dorkos comes with the DorkOS app.

  browser <subcommand>   Manage the signed-in browser. See: dorkos browser --help
  --version              Show the app's version

The app runs DorkOS itself. For every other dorkos command, install the full
command line: npm install -g dorkos
`;

/**
 * Run one command.
 *
 * @param argv - The arguments after `dorkos`.
 * @param out - Where to print: the console, or a test's capture.
 * @param browser - The CLI's own `dorkos browser` dispatcher; a test passes a fake.
 * @returns The exit code.
 */
export async function runTerminalCommand(
  argv: readonly string[],
  out: { log: (text: string) => void; error: (text: string) => void } = console,
  browser: typeof runBrowserDispatcher = runBrowserDispatcher
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'browser') return browser(rest[0], rest.slice(1));
  if (command === '--version' || command === '-v' || command === 'version') {
    out.log(__CLI_VERSION__);
    return 0;
  }
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    out.log(TERMINAL_COMMAND_HELP);
    return 0;
  }
  out.error(`The DorkOS app's dorkos has no '${command}' command.`);
  out.error(TERMINAL_COMMAND_HELP);
  return 1;
}
