import { execFileSync, spawn } from 'child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createRequire } from 'module';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * The packaged-desktop proof that the app refuses debugging switches at launch
 * (`src/main/launch-switches/`).
 *
 * The packaged app is launched with `--remote-debugging-port=0` and a throwaway
 * profile, and must exit non-zero on its own within {@link EXIT_DEADLINE_MS},
 * having written no `DevToolsActivePort` and listened on no port.
 *
 * The same launch runs first on stock Electron, with an app that does nothing,
 * and must open the port there. A check that cannot see the port on stock
 * Electron proves nothing about the packaged one.
 */

/** The switch both launches carry. Port 0 lets Chromium pick a free one. */
export const PROBE_SWITCH = '--remote-debugging-port=0';

/** The file Chromium writes into the profile once its debugging port is open. */
export const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';

/** How long the packaged app may take to refuse and exit. */
export const EXIT_DEADLINE_MS = 10_000;

/** How long stock Electron may take to open its port. */
const CONTROL_DEADLINE_MS = 30_000;

/** How often each launch is looked at while it runs. */
const POLL_MS = 100;

/** launchd's PATH, so nothing from the runner's shell answers for the app. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** What one launch with {@link PROBE_SWITCH} did. */
export interface LaunchObservation {
  /** Exit code, or `null` when it was still running at the deadline or died on a signal. */
  exitCode: number | null;
  /** The signal it died on, if any. */
  exitSignal: NodeJS.Signals | null;
  /** Whether it was still running at the deadline. */
  timedOut: boolean;
  /** Whether `DevToolsActivePort` ever appeared in its profile. */
  wroteDevToolsPortFile: boolean;
  /** Every TCP port it was seen listening on. */
  listeningPorts: number[];
}

/**
 * Read the port out of a `DevToolsActivePort` file: the first line is the port.
 *
 * @returns The port, or `null` when the file does not start with one.
 */
export function readDevToolsPort(contents: string): number | null {
  const port = Number.parseInt(contents.split('\n')[0] ?? '', 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Read `lsof -F n` output into the ports listed on its `n` lines.
 *
 * @param output - `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -Fn` standard output.
 */
export function parseListeningPorts(output: string): number[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => Number.parseInt(line.slice(line.lastIndexOf(':') + 1), 10))
    .filter((port) => Number.isInteger(port) && port > 0);
}

/**
 * Judge a packaged launch with {@link PROBE_SWITCH}.
 *
 * @returns One line per thing it did that it should not have; empty when it
 *   refused cleanly.
 */
export function refusalProblems(observed: LaunchObservation): string[] {
  const problems: string[] = [];
  if (observed.timedOut) {
    problems.push(`it was still running after ${EXIT_DEADLINE_MS / 1000} s`);
  } else if (observed.exitSignal !== null) {
    problems.push(`it died on ${observed.exitSignal} instead of exiting`);
  } else if (observed.exitCode === 0) {
    problems.push('it exited 0');
  }
  if (observed.wroteDevToolsPortFile) problems.push(`it wrote ${DEVTOOLS_PORT_FILE}`);
  if (observed.listeningPorts.length > 0) {
    problems.push(`it listened on port ${observed.listeningPorts.join(', ')}`);
  }
  return problems;
}

/**
 * Every `DevToolsActivePort` under `dir`. The whole scratch folder is searched
 * (profile and HOME alike), so a profile in an unexpected place still counts.
 */
function findPortFiles(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[])
      .filter((entry) => path.basename(entry) === DEVTOOLS_PORT_FILE)
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

/** The TCP ports `pid` is listening on right now. */
function listeningPortsOf(pid: number): number[] {
  try {
    const output = execFileSync(
      'lsof',
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return parseListeningPorts(output);
  } catch {
    // lsof exits 1 when it finds nothing, which is the answer we want.
    return [];
  }
}

/** Whether something accepts a TCP connection on `port` on this machine. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Launch `binary` with {@link PROBE_SWITCH} and a throwaway profile, and watch
 * it until it exits, `stopWhen` says so, or `deadlineMs` passes.
 *
 * Whatever is still running at the end is killed by its own PID.
 */
async function observeLaunch(
  binary: string,
  args: string[],
  scratch: string,
  deadlineMs: number,
  stopWhen: (observed: LaunchObservation) => boolean
): Promise<LaunchObservation> {
  const profile = path.join(scratch, 'profile');
  const home = path.join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  const child = spawn(
    binary,
    [...args, PROBE_SWITCH, `--user-data-dir=${profile}`, '--use-mock-keychain'],
    {
      env: {
        PATH: LAUNCHD_PATH,
        HOME: home,
        DORK_HOME: path.join(home, '.dork'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      },
      stdio: 'ignore',
    }
  );
  const observed: LaunchObservation = {
    exitCode: null,
    exitSignal: null,
    timedOut: false,
    wroteDevToolsPortFile: false,
    listeningPorts: [],
  };
  let exited = false;
  child.once('exit', (code, signal) => {
    exited = true;
    observed.exitCode = code;
    observed.exitSignal = signal;
  });
  const started = Date.now();
  while (!exited) {
    if (findPortFiles(scratch).length > 0) observed.wroteDevToolsPortFile = true;
    if (child.pid !== undefined) {
      for (const port of listeningPortsOf(child.pid)) {
        if (!observed.listeningPorts.includes(port)) observed.listeningPorts.push(port);
      }
    }
    if (stopWhen(observed)) break;
    if (Date.now() - started > deadlineMs) {
      observed.timedOut = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  // One last look: the file outlives a process that wrote it and exited.
  if (findPortFiles(scratch).length > 0) observed.wroteDevToolsPortFile = true;
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  return observed;
}

/**
 * Launch stock Electron the same way, and require the port to open there.
 *
 * @throws If stock Electron opens no port, which would make the packaged check
 *   meaningless.
 */
async function assertControlOpensPort(scratch: string): Promise<number> {
  const stock = createRequire(import.meta.url)('electron') as string;
  const appDir = path.join(scratch, 'control-app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'dorkos-smoke-control', main: 'main.cjs' })
  );
  writeFileSync(path.join(appDir, 'main.cjs'), "require('electron').app.whenReady();\n");
  const observed = await observeLaunch(
    stock,
    [appDir],
    scratch,
    CONTROL_DEADLINE_MS,
    (o) => o.wroteDevToolsPortFile && o.listeningPorts.length > 0
  );
  const [portFile] = findPortFiles(scratch);
  const port = portFile ? readDevToolsPort(readFileSync(portFile, 'utf-8')) : null;
  if (!observed.wroteDevToolsPortFile || port === null || !observed.listeningPorts.includes(port)) {
    throw new Error(
      `Stock Electron (${stock}) launched with ${PROBE_SWITCH} did not open its port ` +
        `(${JSON.stringify(observed)}). Fix the check; one that can't see the port there ` +
        `proves nothing about the packaged app.`
    );
  }
  return port;
}

/**
 * Prove the packaged app refuses to start with a debugging switch.
 *
 * @param appPath - The packaged `.app` bundle.
 * @returns A one-line summary for the smoke log.
 * @throws If the control fails, or the packaged app did anything but exit
 *   non-zero with no port open.
 */
export async function assertLaunchSwitchesRefused(appPath: string): Promise<string> {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dorkos-smoke-switches-')));
  try {
    const controlScratch = path.join(scratch, 'control');
    const controlPort = await assertControlOpensPort(controlScratch);
    // The control was killed; its port must be gone before the real check, or
    // a leftover listener could be mistaken for the app's.
    if (await accepts(controlPort)) {
      throw new Error(`Stock Electron's port ${controlPort} is still open after it was stopped.`);
    }

    const binary = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'));
    const observed = await observeLaunch(
      binary,
      [],
      path.join(scratch, 'packaged'),
      EXIT_DEADLINE_MS,
      () => false
    );
    const problems = refusalProblems(observed);
    if (problems.length > 0) {
      throw new Error(
        `The packaged app, launched with ${PROBE_SWITCH}, should exit non-zero with no port ` +
          `open. Instead: ${problems.join('; ')}.`
      );
    }
    return (
      `${PROBE_SWITCH} opens a port on stock Electron and is refused by the app ` +
      `(exit ${observed.exitCode}, no ${DEVTOOLS_PORT_FILE}, nothing listening)`
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
