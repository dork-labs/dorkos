/**
 * Top-level handler for `dorkos doctor`.
 *
 * Runs a short, read-only checklist over the local setup — Node version, data
 * directory, port, Claude Code CLI, optional runtimes, bundled extensions, and
 * login/tunnel config sanity — and prints a calm, plain report. It boots no
 * server and changes nothing on disk; it only reads config and probes the
 * environment. Exit code is `1` only when something is genuinely broken (a
 * `fail`), never for warnings or informational notes.
 *
 * Wired from the top-of-file interception block in `cli.ts` (after `DORK_HOME`
 * is resolved). Like every command handler here, it returns the exit code
 * rather than calling `process.exit`.
 *
 * @module commands/doctor
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigStore } from '../config-commands.js';
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
  type CheckResult,
} from './doctor-checks.js';

/** Help text for `dorkos doctor`. */
const HELP_TEXT = `
Usage: dorkos doctor

Check your DorkOS setup and report what is wrong in plain words.
Reads your config and probes the environment; changes nothing.
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

/**
 * Run `dorkos doctor`.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param args - The argv slice after `doctor` (only `--help`/`-h` is read).
 * @returns The intended process exit code (`0` healthy, `1` on any failed check).
 */
export async function runDoctor(dorkHome: string, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP_TEXT);
    return 0;
  }

  const store = await loadConfig(dorkHome);
  const results = await gatherResults(dorkHome, store);

  console.log(`\nChecking your DorkOS setup...\n`);
  for (const result of results) {
    printResult(result);
  }
  printSummary(results);

  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

/** Load the config store, or `null` if it cannot be read (checks then degrade gracefully). */
async function loadConfig(dorkHome: string): Promise<ConfigStore | null> {
  try {
    const { initConfigManager } = await import('../../server/services/core/config-manager.js');
    return initConfigManager(dorkHome) as unknown as ConfigStore;
  } catch {
    return null;
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
    checkClaudeCli(),
    checkClaudeAuth(homeDir),
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

/** Resolve the port doctor probes: env var, then config, then the default. */
function resolvePort(store: ConfigStore | null): number {
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_PORT is set imperatively by cli.ts before subcommands run
  const envPort = process.env.DORKOS_PORT;
  if (envPort && /^\d+$/.test(envPort)) return Number(envPort);
  const configPort = readNumber(store, 'server.port');
  return configPort ?? DEFAULT_PORT;
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

/** ANSI colors, used directly (the CLI has no color dependency). */
const COLOR = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const;

/** Glyph + color per status. */
const GLYPH: Record<CheckResult['status'], { symbol: string; color: string }> = {
  pass: { symbol: '✔', color: COLOR.green },
  warn: { symbol: '⚠', color: COLOR.yellow },
  fail: { symbol: '✖', color: COLOR.red },
  info: { symbol: '•', color: COLOR.dim },
};

/** Print one checklist line, with dimmed detail and a fix hint when relevant. */
function printResult(result: CheckResult): void {
  const { symbol, color } = GLYPH[result.status];
  console.log(`  ${color}${symbol}${COLOR.reset} ${result.label}`);
  if (result.detail) {
    console.log(`    ${COLOR.dim}${result.detail}${COLOR.reset}`);
  }
  if (result.fix && (result.status === 'warn' || result.status === 'fail')) {
    for (const line of result.fix.split('\n')) {
      console.log(`    ${COLOR.dim}${line}${COLOR.reset}`);
    }
  }
}

/** Print the closing one-line summary. */
function printSummary(results: CheckResult[]): void {
  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;
  console.log('');
  if (failures > 0) {
    console.log(
      `  ${COLOR.red}${failures} ${plural(failures, 'thing needs', 'things need')} fixing before DorkOS runs right.${COLOR.reset}`
    );
  } else if (warnings > 0) {
    console.log(
      `  ${COLOR.yellow}Ready to run. ${warnings} ${plural(warnings, 'note', 'notes')} worth a look above.${COLOR.reset}`
    );
  } else {
    console.log(`  ${COLOR.green}Everything looks good.${COLOR.reset}`);
  }
  console.log('');
}

/** Singular/plural helper for the summary line. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
