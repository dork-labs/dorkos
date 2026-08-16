/**
 * Top-level handler for `dorkos doctor`.
 *
 * Runs a short checklist over the local setup — Node version, data directory,
 * port, open-file limit, Claude Code CLI, optional runtimes, bundled
 * extensions, and login/tunnel config sanity — and prints a calm, plain report.
 * It boots no server and keeps nothing: the only thing it writes is a
 * throwaway probe file in the data directory, which is how it answers "can
 * DorkOS write here?" and which it deletes immediately. Exit code is `1` only
 * when something is genuinely broken (a `fail`), never for warnings or
 * informational notes.
 *
 * Two options widen it:
 *
 * - `--json` prints the raw `CheckResult[]` and nothing else, so it pipes into
 *   `jq`. The exit-code rule is unchanged.
 * - `--deep` also asks a running DorkOS for the checks that need live state
 *   (`GET /api/health/deep`) and merges them into the same checklist. With no
 *   server running it adds one note and never fails — "DorkOS is not running"
 *   is not a broken setup.
 *
 * Wired from the top-of-file interception block in `cli.ts` (after `DORK_HOME`
 * is resolved). Like every command handler here, it returns the exit code
 * rather than calling `process.exit`.
 *
 * @see {@link checkDorkHomeWritable} for the one write, and why it is one.
 *
 * @module commands/doctor
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckResult, DeepHealthResponse } from '@dorkos/shared/health-schemas';
import type { ConfigStore } from '../config-commands.js';
import { apiCall, ApiError } from '../lib/api-client.js';
import { printJson } from '../lib/operator-output.js';
import {
  checkNode,
  checkDorkHomeWritable,
  checkPortFree,
  checkClaudeCli,
  checkClaudeAuth,
  checkRuntimeAuth,
  checkExtensions,
  checkAuthConfig,
  checkTunnelConfig,
  checkFileDescriptors,
  readFileDescriptorLimit,
} from './doctor-checks.js';
import { exitCodeFor, printChecklist } from './doctor-render.js';

/** Help text for `dorkos doctor`. */
const HELP_TEXT = `
Usage: dorkos doctor [options]

Check your DorkOS setup and report what is wrong in plain words.
Reads your config and probes the environment; changes nothing.

Options:
      --json   Print the results as JSON instead of a report
      --deep   Also ask a running DorkOS about rooms, messaging, integrations,
               and agents. Skipped with a note when DorkOS is not running.

Examples:
  dorkos doctor
  dorkos doctor --deep
  dorkos doctor --json | jq '.[] | select(.status == "fail")'
`;

/** Default server port, kept in sync with @dorkos/shared/constants. */
const DEFAULT_PORT = 4242;

/**
 * Persisted signing-secret filename under the dork home. Mirrors
 * `SECRET_FILE_NAME` in `apps/server/src/services/core/auth/secret.ts`; kept as
 * a local literal so this read-only check never imports the resolver (which
 * would generate the file as a side effect).
 */
const SECRET_FILE_NAME = 'better-auth-secret';

/** Parsed options for `dorkos doctor`. */
export interface DoctorArgs {
  json: boolean;
  deep: boolean;
}

/**
 * Parse the argv slice after `doctor`. Unknown options are rejected with usage,
 * matching the other verbs — a silently ignored flag is a lie about what ran.
 *
 * @param rawArgs - Argv after `doctor`.
 * @returns Typed {@link DoctorArgs}.
 */
export function parseDoctorArgs(rawArgs: string[]): DoctorArgs {
  const usage = 'Usage: dorkos doctor [--json] [--deep]';
  const args: DoctorArgs = { json: false, deep: false };
  for (const arg of rawArgs) {
    if (arg === '--json') args.json = true;
    else if (arg === '--deep') args.deep = true;
    else throw new Error(`Unknown option for 'doctor': ${arg}\n${usage}`);
  }
  return args;
}

/**
 * Run `dorkos doctor`.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param args - The argv slice after `doctor`.
 * @returns The intended process exit code (`0` healthy, `1` on any failed check).
 */
export async function runDoctor(dorkHome: string, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP_TEXT);
    return 0;
  }

  let options: DoctorArgs;
  try {
    options = parseDoctorArgs(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const gather = async (): Promise<CheckResult[]> => {
    const { store, failure } = await loadConfig(dorkHome);
    const results = await gatherResults(dorkHome, store);
    if (options.deep) {
      results.push(...(await gatherDeepResults()));
    }
    // First, because every check below it read defaults rather than the
    // person's real settings, and because it is the headline diagnosis.
    if (failure) results.unshift(failure);
    return results;
  };

  const results = options.json ? await withCleanStdout(gather) : await gather();

  if (options.json) {
    printJson(results);
    return exitCodeFor(results);
  }

  printChecklist('Checking your DorkOS setup...', results);
  return exitCodeFor(results);
}

/**
 * Load the config store, or report why it could not be opened.
 *
 * The failure is returned as a check rather than swallowed. Doctor is the
 * command a person runs BECAUSE something is wrong, and a config file the
 * operating system will not let DorkOS read is now the one condition that stops
 * the server from starting at all. Reporting it as `null` and carrying on would
 * make doctor print a clean bill of health for the one machine that is broken.
 *
 * The remaining checks still run, on defaults, so the report is not cut short.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @returns The store when it opened, plus a failing check when it did not.
 */
async function loadConfig(
  dorkHome: string
): Promise<{ store: ConfigStore | null; failure: CheckResult | null }> {
  try {
    const { initConfigManager } = await import('../../server/services/core/config-manager.js');
    return { store: initConfigManager(dorkHome) as unknown as ConfigStore, failure: null };
  } catch (err) {
    return { store: null, failure: configFailureCheck(err, dorkHome) };
  }
}

/**
 * The checklist row for a config that would not open.
 *
 * @param err - Whatever `initConfigManager` threw.
 * @param dorkHome - The resolved DorkOS data directory.
 * @returns A failing check naming the file, the reason, and the way out.
 * @internal Exported for testing.
 */
export function configFailureCheck(err: unknown, dorkHome: string): CheckResult {
  return {
    // "Used", not "read": the same row now covers a config DorkOS refused to
    // update as well as one the operating system would not let it open, and
    // both leave the file where the person left it.
    label: 'Your settings could not be used',
    status: 'fail',
    detail: describeConfigFailure(err),
    fix:
      `DorkOS did not replace or delete the file: ${path.join(dorkHome, 'config.json')}\n` +
      `Everything below was checked against the built-in defaults instead.\n` +
      adviceFrom(err),
  };
}

/**
 * One line naming why the config would not open.
 *
 * Prefers the underlying failure over the wrapper: `ConfigUnreadableError`
 * carries a multi-line message meant for a terminal of its own, while its
 * `cause` is the single line that says what the operating system refused
 * (`EMFILE: too many open files, open '…'`), which is what belongs on a
 * checklist row.
 *
 * @param err - Whatever `initConfigManager` threw.
 * @internal Exported for testing.
 */
export function describeConfigFailure(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) return err.cause.message;
  if (err instanceof Error) return err.message.split('\n')[0] ?? err.name;
  return String(err);
}

/**
 * The next step to show, taken from the error rather than restated here.
 *
 * `ConfigUnreadableError` already picks its advice by the errno it saw:
 * "try again" for a descriptor shortage, a permission fix for `EACCES`. Doctor
 * showing its own copy is how the two drifted into disagreeing once, and a
 * person running doctor is the one who most needs the right instruction.
 *
 * @param err - Whatever `initConfigManager` threw.
 */
function adviceFrom(err: unknown): string {
  // Guarded rather than cast: `describeConfigFailure` already handles a thrown
  // non-object, and the two should not disagree about what they can be given.
  const advice =
    typeof err === 'object' && err !== null ? (err as { advice?: unknown }).advice : undefined;
  if (typeof advice === 'string' && advice.length > 0) return advice;
  return 'Start DorkOS again. If that does not help, the reason above says what your computer refused.';
}

/**
 * Run `gather` with anything it prints diverted to stderr.
 *
 * `--json` promises stdout carries the payload and nothing else, so it pipes
 * into `jq`. Gathering breaks that promise on its own: reading config brings up
 * the server's logger, which announces the file it loaded on stdout. Rather
 * than silencing that (a message worth keeping, and only one of the things that
 * could print), send it where non-payload output belongs.
 *
 * @param gather - The work whose incidental output must not reach stdout.
 * @returns Whatever `gather` returns.
 * @internal Exported for testing.
 */
export async function withCleanStdout<T>(gather: () => Promise<T>): Promise<T> {
  const original = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try {
    return await gather();
  } finally {
    process.stdout.write = original;
  }
}

/** Run every check in a sensible order and flatten the runtime-auth group. */
async function gatherResults(dorkHome: string, store: ConfigStore | null): Promise<CheckResult[]> {
  const port = resolvePort(store);
  const homeDir = os.homedir();

  const results: CheckResult[] = [
    checkNode(),
    checkDorkHomeWritable(dorkHome),
    await checkPortFree(port),
    checkFileDescriptors(readFileDescriptorLimit()),
    checkClaudeCli(),
    checkClaudeAuth(homeDir),
    ...checkUnreadableSettings(store),
    ...checkRuntimeAuth({
      codexEnabled: readBool(store, 'runtimes.codex.enabled', true),
      codexCredentialRef: readString(store, 'runtimes.codex.credentialRef'),
      opencodeEnabled: readBool(store, 'runtimes.opencode.enabled', true),
      opencodeProvider: readString(store, 'runtimes.opencode.provider'),
    }),
    await checkExtensions(),
    checkAuthConfig({
      authEnabled: readBool(store, 'auth.enabled', false),
      secretFileExists: fs.existsSync(path.join(dorkHome, SECRET_FILE_NAME)),
      // eslint-disable-next-line no-restricted-syntax -- reading an operator env override, matching secret.ts
      secretEnvSet: Boolean(process.env.BETTER_AUTH_SECRET?.trim()),
    }),
    checkTunnelConfig({
      tunnelEnabled: readBool(store, 'tunnel.enabled', false),
      tokenConfigured:
        Boolean(readString(store, 'tunnel.authtoken')) ||
        // eslint-disable-next-line no-restricted-syntax -- ngrok token env override, matching routes/tunnel.ts
        Boolean(process.env.NGROK_AUTHTOKEN?.trim()),
    }),
  ];

  return results;
}

/**
 * Ask a running DorkOS for the checks that need live state.
 *
 * A server that is not running, or that is too old to know the route, is a
 * skipped section rather than a failure: `--deep` never turns a healthy machine
 * into a non-zero exit just because nothing was listening.
 *
 * @returns The server's checks, or a single note explaining why there are none.
 */
export async function gatherDeepResults(): Promise<CheckResult[]> {
  try {
    const response = await apiCall<DeepHealthResponse>('GET', '/api/health/deep');
    return response.checks;
  } catch (err) {
    return [
      {
        label: 'Skipped the checks that need DorkOS running',
        status: 'info',
        detail: reasonDeepWasSkipped(err),
      },
    ];
  }
}

/** Say, in one line, why the deep checks did not run. */
function reasonDeepWasSkipped(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return (
      'The DorkOS that is running is older than these checks, so it does not have them yet. ' +
      'Update it with `npm install -g dorkos@latest` and restart it.'
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('Cannot reach DorkOS server')) {
    return (
      'DorkOS is not running, so rooms, messaging, integrations, and agents were not checked. ' +
      'Start it with `dorkos` and run this again.'
    );
  }
  return message;
}

/** Resolve the port doctor probes: env var, then config, then the default. */
function resolvePort(store: ConfigStore | null): number {
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_PORT is set imperatively by cli.ts before subcommands run
  const envPort = process.env.DORKOS_PORT;
  if (envPort && /^\d+$/.test(envPort)) return Number(envPort);
  const configPort = readNumber(store, 'server.port');
  return configPort ?? DEFAULT_PORT;
}

/**
 * The row for settings a newer version of DorkOS wrote and this one cannot read.
 *
 * **Absent when there is nothing to say.** Every other row here answers a
 * question worth asking on every machine; this one answers "is anything on this
 * machine being ignored", and on a machine where the answer is no, printing it
 * would be a line of reassurance nobody needed. It appears exactly when it has
 * news, which is the same reason the runtime-auth group spreads rather than
 * always showing.
 *
 * A `warn`, never a `fail`: the file is fine, DorkOS started, and every OTHER
 * setting in it is being used. It exists so that a login gate this build read as
 * off, or a bound it read back at its default, is something a person can find
 * rather than something they discover.
 *
 * @param store - The config store, or `null` when it would not open.
 * @returns One row, or none.
 * @internal Exported for testing.
 */
export function checkUnreadableSettings(store: ConfigStore | null): CheckResult[] {
  const warnings = store?.validate().warnings ?? [];
  if (warnings.length === 0) return [];
  const what = warnings.length === 1 ? 'setting was' : 'settings were';
  return [
    {
      label: `${warnings.length} ${what} saved by a newer version of DorkOS`,
      status: 'warn',
      detail: warnings.join('; '),
      fix:
        `This version does not know those values, so it is using its own defaults for them.\n` +
        `Everything else in your settings is being used as normal, and the values above are\n` +
        `still in the file — update DorkOS and it will pick them up again.`,
    },
  ];
}

function readBool(store: ConfigStore | null, key: string, fallback: boolean): boolean {
  const value = store?.getDot(key);
  return typeof value === 'boolean' ? value : fallback;
}

function readString(store: ConfigStore | null, key: string): string | null {
  const value = store?.getDot(key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(store: ConfigStore | null, key: string): number | null {
  const value = store?.getDot(key);
  return typeof value === 'number' ? value : null;
}
