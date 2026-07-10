import net from 'net';
import fs from 'fs';
import path from 'path';
import { CAPTURE_HOME, SERVER_PORT, VITE_PORT } from './config.js';
import { sleep } from './lib.js';

/**
 * Crash-safe supervision state for a capture stack: a pidfile recording the live
 * server/Vite process groups, a resilient run log, port-occupancy probing, and
 * reconciliation of a stack orphaned by a previous crashed run.
 *
 * Everything here lives under this shard's isolated `CAPTURE_HOME`
 * (`~/.dork-capture` for shard 0), so a parallel record's shards never collide.
 * Writes are synchronous and self-healing (they recreate their directory and
 * swallow errors) precisely because they run on teardown and process-exit paths
 * — where the record phase may already have wiped and recreated `CAPTURE_HOME`,
 * and where a thrown ENOENT would corrupt an otherwise clean shutdown.
 *
 * @module capture/supervisor
 */

/** The pidfile: one live process-group leader pid per line, under `CAPTURE_HOME`. */
const PIDFILE = path.join(CAPTURE_HOME, 'capture.pid');
/** Directory for the run log. */
const LOG_DIR = path.join(CAPTURE_HOME, 'logs');
/** Append-only diagnostics log for boot/teardown/reconcile lifecycle events. */
const LOG_FILE = path.join(LOG_DIR, 'capture.log');

/** SIGTERM→SIGKILL grace while reconciling a stale stack. */
const RECONCILE_TERM_WAIT_MS = 400;
/** Settle time after killing a stale stack, letting the OS release its ports. */
const RECONCILE_SETTLE_MS = 400;
/** How long a port probe waits for a connection before calling the port free. */
const PORT_PROBE_TIMEOUT_MS = 500;

/**
 * Append a line to the capture run log. Recreates the log directory first and
 * swallows every error, so a wiped `CAPTURE_HOME` or a mid-teardown race can
 * never turn a diagnostic write into an ENOENT that breaks the shutdown.
 *
 * @param message - The event to record (a timestamp is prepended).
 */
export function log(message: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never break a run or its teardown.
  }
}

/** Serialize process-group pids to pidfile text (one per line). */
export function formatPidfile(pids: readonly number[]): string {
  return pids.length > 0 ? `${pids.join('\n')}\n` : '';
}

/**
 * Parse pidfile text into process-group pids, tolerating blank lines, stray
 * whitespace, and junk — a corrupt pidfile must degrade to "nothing to
 * reconcile", never throw.
 *
 * @param content - Raw pidfile contents.
 */
export function parsePidfile(content: string): number[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Record the live stack's process-group pids so a crashed run can be reconciled next boot. */
export function writePidfile(pids: readonly number[]): void {
  try {
    fs.mkdirSync(CAPTURE_HOME, { recursive: true });
    fs.writeFileSync(PIDFILE, formatPidfile(pids));
  } catch {
    // A missing pidfile only costs us reconciliation on the next run; never fatal.
  }
}

/** Read the pidfile a crashed prior run may have left, or `[]` if none/unreadable. */
export function readStalePids(): number[] {
  try {
    return parsePidfile(fs.readFileSync(PIDFILE, 'utf8'));
  } catch {
    return [];
  }
}

/** Remove the pidfile. Idempotent and never throws (a clean run's final act). */
export function clearPidfile(): void {
  try {
    fs.rmSync(PIDFILE, { force: true });
  } catch {
    // Already gone, or the home was wiped out from under us — either way, done.
  }
}

/**
 * Signal a detached process group by its leader pid. Best-effort: a group that
 * has already exited (ESRCH) is a success, not an error.
 *
 * @param pid - The group-leader pid (the negative is signaled to hit the group).
 * @param signal - The signal to deliver.
 */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Probe whether something is listening on `port` of localhost. A successful
 * connect means occupied; a refused connect (or timeout) means free.
 *
 * @param port - The TCP port to probe.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Terminate a capture stack a previous run left orphaned. Reads the pidfile —
 * the group pids the previous run recorded as its own; PID reuse between that
 * run's crash and this reconcile is a small residual risk we accept — escalates
 * SIGTERM→SIGKILL over those groups, then clears the pidfile and lets the OS
 * release the ports. A no-op when there is no pidfile — i.e. after any clean
 * run.
 *
 * MUST run before the record phase wipes `CAPTURE_HOME`, since that wipe removes
 * the very pidfile this reads.
 */
export async function reconcileStaleStack(): Promise<void> {
  const stale = readStalePids();
  if (stale.length === 0) return;
  log(`reconcile: stale stack from a prior run (groups ${stale.join(',')}) — terminating`);
  process.stdout.write(
    `▸ Reconciling ${stale.length} orphaned process group(s) from a previous capture run…\n`
  );
  for (const pid of stale) killGroup(pid, 'SIGTERM');
  await sleep(RECONCILE_TERM_WAIT_MS);
  for (const pid of stale) killGroup(pid, 'SIGKILL');
  clearPidfile();
  await sleep(RECONCILE_SETTLE_MS);
}

/** The capture ports this shard needs free, paired with human-readable labels. */
const REQUIRED_PORTS: readonly (readonly [number, string])[] = [
  [SERVER_PORT, 'API server'],
  [VITE_PORT, 'Vite client'],
];

/**
 * Fail fast if a capture port is still occupied after reconciliation — a
 * foreign process (or a stack we could not prove was ours) is holding it, and
 * booting anyway would seed against the wrong server or fail to bind. Throws an
 * actionable error naming the port and how to inspect it.
 */
export async function assertPortsFree(): Promise<void> {
  for (const [port, label] of REQUIRED_PORTS) {
    if (await isPortInUse(port)) {
      throw new Error(
        `Capture port ${port} (${label}) is already in use. A previous capture stack may still ` +
          `be running, or another process is holding it. Free it and retry — inspect with ` +
          `\`lsof -iTCP:${port} -sTCP:LISTEN\`.`
      );
    }
  }
}
