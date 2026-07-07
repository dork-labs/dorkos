/**
 * Top-level dispatcher for the `dorkos cloud <subcommand>` namespace
 * (accounts-and-auth P2, task 2.4).
 *
 * Lives in its own module so `cli.ts` stays focused on global flag parsing and
 * server bootstrap. Invoked from the top-of-file interception block in `cli.ts`
 * (before the strict top-level `parseArgs`). This is the only file in the CLI
 * package that reaches into `apps/server` (the pure device-flow client + the
 * config manager); the command LOGIC lives in the server-free `cloud-commands.ts`
 * so it stays unit-testable. Runs the device flow DIRECTLY against the cloud — no
 * running DorkOS server required, so it works headless.
 *
 * Like every other command handler here, the dispatcher returns the intended
 * exit code rather than calling `process.exit` — `cli.ts` owns termination.
 *
 * @module commands/cloud-dispatcher
 */
import { execFile } from 'node:child_process';
import type { ConfigStore } from '../config-commands.js';
import {
  runCloudLogin,
  runCloudLogout,
  runCloudStatus,
  type CloudFlowClient,
  type CommandIO,
} from './cloud-commands.js';
import {
  buildInstanceDescriptor,
  pollForToken,
  requestDeviceCode,
  resolveCloudBaseUrl,
  revokeInstanceKey,
  sendHeartbeat,
} from '../../server/services/core/auth/cloud-link-client.js';

/** Help text rendered for `dorkos cloud` with no subcommand or `--help`. */
export const HELP_TEXT = `
Usage: dorkos cloud <subcommand>

Link this instance to a DorkOS account. Runs the device flow directly against
the cloud, so it works headless (no running DorkOS server required).

Subcommands:
  login     Link this instance (prints a code to approve in your browser)
  logout    Unlink this instance and clear the saved cloud token
  status    Show the linked account and instance name, or 'not linked'

Examples:
  dorkos cloud login
  dorkos cloud status
  dorkos cloud logout
`;

/** Command output routed to the console. */
const consoleIo: CommandIO = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/** The real device-flow client (server primitives), adapted to {@link CloudFlowClient}. */
const client: CloudFlowClient = {
  resolveCloudBaseUrl,
  buildInstanceDescriptor,
  requestDeviceCode,
  pollForToken,
  sendHeartbeat,
  revokeInstanceKey,
};

/**
 * Open a URL in the user's default browser, best-effort. Guards the scheme to
 * http(s) and uses `execFile` with an argument array (never a shell string) so a
 * crafted URL cannot inject shell commands.
 */
function defaultOpenUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  try {
    if (process.platform === 'darwin') execFile('open', [url], () => {});
    else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
    else execFile('xdg-open', [url], () => {});
  } catch {
    // Best-effort — the URL is always printed, so a failed open is harmless.
  }
}

/**
 * Dispatch a `dorkos cloud <subcommand>` invocation.
 *
 * @param dorkHome - The resolved `~/.dork` data directory (set by `cli.ts`).
 * @param subcommand - `login`, `logout`, `status`; `undefined`/`--help`/`-h` prints help.
 * @param subArgs - The argv slice following the subcommand.
 * @returns The intended process exit code.
 */
export async function runCloudDispatcher(
  dorkHome: string,
  subcommand: string | undefined,
  subArgs: string[]
): Promise<number> {
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }
  if (subArgs[0] === '--help' || subArgs[0] === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }

  try {
    const { initConfigManager } = await import('../../server/services/core/config-manager.js');
    const configStore = initConfigManager(dorkHome) as unknown as ConfigStore;
    const deps = {
      client,
      configStore,
      io: consoleIo,
      openUrl: defaultOpenUrl,
      isTty: Boolean(process.stdin.isTTY),
    };

    if (subcommand === 'login') return await runCloudLogin(deps);
    if (subcommand === 'logout') return await runCloudLogout(deps);
    if (subcommand === 'status') return runCloudStatus(deps);

    console.error(`Unknown cloud subcommand: ${subcommand}`);
    console.error('Usage: dorkos cloud <login|logout|status>');
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
