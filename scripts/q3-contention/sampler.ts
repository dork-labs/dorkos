/**
 * 1 Hz resource sampling for the Q3 contention harness (DOR-500).
 *
 * Records, once per second: load average, the RSS of the server process tree
 * (which is where a real runtime's subprocesses live), the machine's open-file
 * count, the running `SQLITE_BUSY` / `EMFILE` tallies, and how many turns are
 * still in flight.
 *
 * KEEPING IT CHEAP — the sampler must not perturb the thing it measures:
 *
 *  - `os.loadavg()` is an in-process read; no syscall, no spawn.
 *  - Exactly ONE short-lived child per tick. `ps` and `sysctl` are issued in a
 *    single `sh -c`, their outputs split on a sentinel, so a 60-second run costs
 *    60 tiny spawns rather than 120 (or one per pid, which is what walking a
 *    process tree naively would cost).
 *  - Open descriptors come from `sysctl kern.num_files`, an instant counter
 *    read. `lsof` was rejected: it takes hundreds of milliseconds per call on
 *    macOS and would itself open enough descriptors to move the number.
 *  - The process tree is reconstructed IN PROCESS from one `ps -axo pid,ppid,rss`
 *    dump, so tracking a runtime's freshly-spawned children costs no extra
 *    spawns.
 *  - Ticks never pile up: if a sample is still in flight when the next timer
 *    fires, that tick is skipped and counted in `skippedTicks`.
 *
 * @module scripts/q3-contention/sampler
 */
import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';
import type { ErrorCounters } from './server-process.js';

const exec = promisify(execFile);

/** One second of machine state. */
export interface Sample {
  readonly iso: string;
  readonly tMs: number;
  readonly load1: number;
  readonly load5: number;
  readonly load15: number;
  /** Processes in the server's tree, including the server itself. */
  readonly procCount: number;
  /** Total RSS of the server tree, in kilobytes. */
  readonly rssTreeKb: number;
  /** RSS of the server process itself, in kilobytes. */
  readonly rssServerKb: number;
  /** Machine-wide open file count, or -1 when unavailable on this platform. */
  readonly openFiles: number;
  /** Machine-wide open file limit, or -1 when unavailable. */
  readonly maxFiles: number;
  readonly sqliteBusy: number;
  readonly emfile: number;
  readonly turnsRunning: number;
  readonly turnsEnded: number;
  /** Terminal outcomes seen so far, e.g. `cats=ok;dogs=error`. */
  readonly terminalOutcomes: string;
}

/** What the sampler needs to know about the run's turns, read once per tick. */
export interface TurnProbe {
  turnsRunning(): number;
  turnsEnded(): number;
  /** Compact `label=outcome` list for every turn that has finished. */
  terminalOutcomes(): string;
}

const SENTINEL = '---q3---';
const SAMPLE_INTERVAL_MS = 1_000;

/** The single per-tick shell command: process table, then the fd counters. */
function probeCommand(): string {
  const fdProbe =
    process.platform === 'darwin'
      ? 'sysctl -n kern.num_files kern.maxfiles'
      : "cat /proc/sys/fs/file-nr 2>/dev/null | awk '{print $1; print $3}'";
  return `ps -axo pid=,ppid=,rss=; echo "${SENTINEL}"; ${fdProbe}`;
}

/** A row of `ps -axo pid=,ppid=,rss=`. */
interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
}

/** Parse the `ps` half of the probe output. */
function parseProcTable(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue;
    rows.push({ pid, ppid, rssKb });
  }
  return rows;
}

/**
 * Sum the RSS of a process and every descendant, from a single `ps` dump.
 *
 * @param rows - Parsed process table.
 * @param rootPid - Root of the tree to measure.
 * @returns Process count and total RSS in kilobytes.
 * @internal Exported for testing.
 */
export function sumProcessTree(
  rows: readonly ProcRow[],
  rootPid: number
): { procCount: number; rssTreeKb: number; rssRootKb: number } {
  const children = new Map<number, number[]>();
  const rssByPid = new Map<number, number>();
  for (const row of rows) {
    rssByPid.set(row.pid, row.rssKb);
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }

  let procCount = 0;
  let rssTreeKb = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const rss = rssByPid.get(pid);
    if (rss === undefined) continue;
    procCount++;
    rssTreeKb += rss;
    stack.push(...(children.get(pid) ?? []));
  }
  return { procCount, rssTreeKb, rssRootKb: rssByPid.get(rootPid) ?? 0 };
}

/**
 * Parse the fd half of the probe output: two integers, count then limit.
 *
 * The empty-token filter is load-bearing — `Number('')` is 0, not NaN, so a
 * leading newline would otherwise read as "zero open files".
 *
 * @internal Exported for testing.
 */
export function parseFdProbe(text: string): { openFiles: number; maxFiles: number } {
  const numbers = text
    .split(/\s+/)
    .filter((token) => token !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return { openFiles: numbers[0] ?? -1, maxFiles: numbers[1] ?? -1 };
}

/** Collects {@link Sample} rows on a 1 Hz timer until stopped. */
export class Sampler {
  private readonly samples: Sample[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private skipped = 0;

  /**
   * Bind a sampler to the process tree and counters it will read each tick.
   *
   * @param rootPid - Server process group leader whose tree is measured.
   * @param counters - Live `SQLITE_BUSY` / `EMFILE` tallies from the server tail.
   * @param probe - Turn-state accessors, read once per tick.
   */
  constructor(
    private readonly rootPid: number,
    private readonly counters: ErrorCounters,
    private readonly probe: TurnProbe
  ) {}

  /** Begin sampling. Safe to call once. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  /** Stop sampling and take one final sample so the run's tail is recorded. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.inFlight) await this.tick();
  }

  /** Every sample collected, in order. */
  rows(): readonly Sample[] {
    return this.samples;
  }

  /** Ticks dropped because the previous sample had not finished. */
  skippedTicks(): number {
    return this.skipped;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      this.skipped++;
      return;
    }
    this.inFlight = true;
    const tMs = Date.now();
    const [load1, load5, load15] = os.loadavg();
    try {
      const { stdout } = await exec('sh', ['-c', probeCommand()], { maxBuffer: 8 * 1024 * 1024 });
      const [psText = '', fdText = ''] = stdout.split(SENTINEL);
      const tree = sumProcessTree(parseProcTable(psText), this.rootPid);
      const fds = parseFdProbe(fdText);
      this.samples.push({
        iso: new Date(tMs).toISOString(),
        tMs,
        load1: load1 ?? 0,
        load5: load5 ?? 0,
        load15: load15 ?? 0,
        procCount: tree.procCount,
        rssTreeKb: tree.rssTreeKb,
        rssServerKb: tree.rssRootKb,
        openFiles: fds.openFiles,
        maxFiles: fds.maxFiles,
        sqliteBusy: this.counters.sqliteBusy,
        emfile: this.counters.emfile,
        turnsRunning: this.probe.turnsRunning(),
        turnsEnded: this.probe.turnsEnded(),
        terminalOutcomes: this.probe.terminalOutcomes(),
      });
    } catch {
      // A failed probe is a missing row, never a failed run.
    } finally {
      this.inFlight = false;
    }
  }
}
