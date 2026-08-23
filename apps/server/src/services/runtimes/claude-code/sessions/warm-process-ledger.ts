/**
 * The record of every warm claude-code subprocess this data directory owns, and
 * the boot-time sweep that ends the ones a previous instance left behind
 * (DOR-1310).
 *
 * ## The hole this fills
 *
 * {@link shutdownSessionPumps} closes every warm process on a GRACEFUL exit, and
 * the SDK adds its own `process.on('exit')` SIGTERM sweep behind that. Both are
 * exit handlers, and an exit handler does not run when the process is killed
 * outright: `kill -9`, an out-of-memory kill, force-quitting the desktop app, a
 * hard reboot. With `persistentSession` on, a server sitting at its ceiling
 * holds twelve CLI subprocesses and their descendants — measured at 61
 * processes and roughly 12 GB — and every one of them survives that kill with
 * nothing left to reap it. On macOS the orphans are reparented to `launchd` and
 * simply keep running.
 *
 * So the reaping cannot live in the dying process. It lives in the NEXT one:
 * every process is written down when it is spawned, and the next boot ends
 * whatever is still standing.
 *
 * ## The ownership-proof invariant
 *
 * **A process is signalled only when this data directory's own ledger names its
 * pid AND the pid's current start time is byte-identical to the start time
 * recorded when we spawned it AND no live process still owns the ledger.** All
 * three, every time. Nothing is ever matched by name, by command line, or by
 * pid alone.
 *
 * Each clause answers a specific way this could kill something innocent:
 *
 * - **The ledger lives under `dorkHome`**, so two DorkOS instances pointed at
 *   different data directories can never see each other's records. This is the
 *   whole reason the file is not global.
 * - **The start time is the anti-recycling proof.** Pids wrap around onto
 *   unrelated processes, and a ledger that survived a hard kill can easily name
 *   a pid that now belongs to the operator's editor. A recycled pid always
 *   belongs to a process that started AFTER the one we recorded, so its
 *   `lstart` differs — except within the one-second resolution `lstart`
 *   reports. That residual window is unreachable in practice rather than
 *   merely unlikely: pids are allocated monotonically, so the recycled pid
 *   cannot come back around until allocation has wrapped the whole pid space,
 *   which takes far longer than the second it would have to happen inside.
 *   Equality is deliberately exact rather than a tolerance window: reaping is
 *   destructive and unrecoverable, while failing to reap is merely the bug we
 *   already have, so the guard is the tight one. A start time we cannot read at
 *   all — no `ps` (Windows), a process that already exited, an unparseable
 *   format — is never treated as a match.
 * - **The owner stamp is the concurrency proof.** The single-instance lock
 *   normally guarantees one server per data directory, but it can be switched
 *   off (`DORKOS_SKIP_INSTANCE_LOCK`, `NODE_ENV=test`), and a ledger read while
 *   ANOTHER server is alive and using it describes processes that are very much
 *   still owned. So the file stamps the server that wrote it, proved the same
 *   way: alive, with a matching start time. A live owner aborts the whole
 *   sweep.
 *
 * ## Descendants ride on the root's proof
 *
 * Killing the CLI process alone leaves its own children — MCP servers, tool
 * subprocesses — orphaned in turn, which is most of the memory the ticket
 * measured. They are ended too, but never on their own evidence: descendants
 * are taken from a single `ps` snapshot of the live process table, walked down
 * from a root this module has ALREADY proven it owns. Ownership is transitive
 * from a proven root; it is never established from the bottom up.
 *
 * ## Windows
 *
 * There is no `ps`, so no start time can be read — at record time (nothing is
 * written down) or at reap time (nothing matches). The sweep is therefore inert
 * on Windows rather than wrong, which is the correct failure direction for a
 * component whose job is to kill things.
 *
 * @module services/runtimes/claude-code/sessions/warm-process-ledger
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';

/** Where the ledger lives, relative to `dorkHome`. */
const LEDGER_RELATIVE_PATH = path.join('cache', 'runtimes', 'claude-code', 'warm-processes.json');

/**
 * Ceiling on every `ps` call. They are synchronous, and one of them sits on the
 * spawn path of a warm process, so a wedged `ps` must not hang a launch. A throw
 * reads as "cannot say", which never kills anything.
 */
const PS_TIMEOUT_MS = 2_000;

/** How long an orphan gets to honour SIGTERM before SIGKILL follows. */
const TERM_GRACE_MS = 2_000;

/** How often the grace window checks whether the orphans have gone. */
const TERM_POLL_MS = 100;

/** One process this server spawned, and the proof of which process it is. */
const WarmProcessRecordSchema = z.object({
  /** OS process id of the CLI subprocess. */
  pid: z.number().int().positive(),
  /** Its `ps -o lstart=` string, normalised, read the moment it was spawned. */
  startedAt: z.string().min(1),
});

/** The whole ledger file: who wrote it, and what it is holding. */
const WarmProcessLedgerFileSchema = z.object({
  /** The server that owns these processes, proved the same way they are. */
  owner: WarmProcessRecordSchema,
  /** Every subprocess that server has spawned and not yet seen exit. */
  processes: z.array(WarmProcessRecordSchema),
});

/** One process this server spawned, and the proof of which process it is. */
export type WarmProcessRecord = z.infer<typeof WarmProcessRecordSchema>;

/** The ledger file as it sits on disk: the owning server, and its processes. */
export type WarmProcessLedgerFile = z.infer<typeof WarmProcessLedgerFileSchema>;

/**
 * The operating-system facts this module needs, behind one seam so the
 * verification logic can be tested without spawning or killing anything.
 */
export interface ProcessProbe {
  /**
   * The process's start time as a normalised `ps -o lstart=` string, or `null`
   * when it cannot be answered — no such process, no `ps`, a timeout, or an
   * unparseable format. `null` NEVER counts as a match.
   *
   * @param pid - The process to ask about
   */
  startTimeOf(pid: number): string | null;
  /**
   * Every live process's parent, as `pid → ppid`, or `null` when the table
   * cannot be read. Used only to walk down from an already-proven root.
   */
  processTable(): ReadonlyMap<number, number> | null;
  /**
   * Deliver a signal, reporting whether the process was there to receive it.
   *
   * @param pid - The process to signal
   * @param signal - The signal to send
   */
  signal(pid: number, signal: NodeJS.Signals | 0): boolean;
  /**
   * Short command names for a set of pids, for the forensic log line only.
   * Optional: it informs no decision, so a probe that cannot answer simply
   * leaves the log naming bare pids.
   *
   * @param pids - The processes to name, asked in one call
   */
  commandsOf?(pids: readonly number[]): ReadonlyMap<number, string> | null;
}

/**
 * Run `ps` and hand back its stdout, or `null` when it could not be run.
 *
 * `LC_ALL=C` is load-bearing, exactly as it is in `lib/instance-lock.ts`: macOS
 * renders `lstart` through `strftime("%c")`, so on a non-English locale the
 * string differs between two readings taken under different environments and
 * the equality proof would silently never match.
 *
 * @param args - Arguments to `ps`
 */
function runPs(args: string[]): string | null {
  try {
    return execFileSync('ps', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
      // eslint-disable-next-line no-restricted-syntax -- forwarding the real environment to a child process, with the C locale forced so `lstart` reads identically every time
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch {
    return null;
  }
}

/** Collapse `ps` padding so two readings of the same process compare equal. */
function normalise(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** The real operating system, for production. */
export const systemProcessProbe: ProcessProbe = {
  startTimeOf(pid) {
    const raw = runPs(['-p', String(pid), '-o', 'lstart=']);
    if (raw === null) return null;
    const value = normalise(raw);
    return value === '' ? null : value;
  },
  processTable() {
    const raw = runPs(['-A', '-o', 'pid=,ppid=']);
    if (raw === null) return null;
    const table = new Map<number, number>();
    for (const line of raw.split('\n')) {
      const [pid, ppid] = normalise(line).split(' ');
      const child = Number(pid);
      const parent = Number(ppid);
      if (Number.isInteger(child) && Number.isInteger(parent) && child > 0) {
        table.set(child, parent);
      }
    }
    return table.size === 0 ? null : table;
  },
  commandsOf(pids) {
    if (pids.length === 0) return null;
    const raw = runPs(['-p', pids.join(','), '-o', 'pid=,comm=']);
    if (raw === null) return null;
    const names = new Map<number, string>();
    for (const line of raw.split('\n')) {
      const trimmed = normalise(line);
      const gap = trimmed.indexOf(' ');
      if (gap <= 0) continue;
      const pid = Number(trimmed.slice(0, gap));
      if (Number.isInteger(pid)) names.set(pid, trimmed.slice(gap + 1));
    }
    return names;
  },
  signal(pid, sig) {
    try {
      process.kill(pid, sig);
      return true;
    } catch (error) {
      // EPERM means it exists but belongs to somebody else, which is still a
      // process that is there — and one we deliberately do not chase further.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

/**
 * The durable list of warm subprocesses one data directory owns.
 *
 * Writes are synchronous and atomic (write-then-rename), because the whole
 * point is to survive a kill that gives this process no chance to flush
 * anything. The cost is one small file write per PROCESS launched, not per
 * turn.
 */
export class WarmProcessLedger {
  private readonly filePath: string;
  private readonly probe: ProcessProbe;
  /** This server's own start time, or `null` when the platform cannot say. */
  private ownStartedAt: string | null | undefined;

  /**
   * Build a ledger over one data directory.
   *
   * @param dorkHome - The data directory whose processes this tracks
   * @param probe - The operating system, injectable for tests
   */
  constructor(dorkHome: string, probe: ProcessProbe = systemProcessProbe) {
    this.filePath = path.join(dorkHome, LEDGER_RELATIVE_PATH);
    this.probe = probe;
  }

  /** Where this ledger is stored. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Write down a subprocess we just spawned.
   *
   * A pid whose start time cannot be read is NOT recorded: a record with no
   * proof attached could never be acted on, so writing one would only invite a
   * future reader to act on the pid alone. This is the Windows path, and it
   * makes the whole mechanism inert there rather than unsafe.
   *
   * ## A foreign LIVE owner's records are not ours to adopt
   *
   * This write re-stamps the file's `owner` with us, so it must not carry
   * another server's pids across that re-stamp. Normally it cannot happen — the
   * single-instance lock means one server per data directory — but the lock can
   * be switched off (`DORKOS_SKIP_INSTANCE_LOCK`, `NODE_ENV=test`), and then two
   * servers share this file. Inheriting there would forge the ownership proof:
   * server B stamps `owner: B` over a list containing server A's LIVE pids, B is
   * killed, and B's next boot finds a ledger it believes it owns naming a
   * process A is still using. It would kill it, and every clause of the proof
   * would have been satisfied — because the lie was told at write time, not at
   * read time.
   *
   * So a file whose owner is a DIFFERENT, still-living process is not merged
   * with; the list starts empty and holds only what we ourselves spawn. The
   * cost is that the live owner's records are dropped from the file, which is
   * the same exposure the unlocked configuration already has, and strictly
   * better than reaping a process that is in use.
   *
   * @param pid - The process id the spawn returned
   */
  record(pid: number): void {
    const startedAt = this.probe.startTimeOf(pid);
    if (startedAt === null) {
      logger.debug('[warm-process-ledger] cannot read a start time; not recording', { pid });
      return;
    }
    const owner = this.owner();
    if (owner === null) return;
    const file = this.read();
    const foreignLiveOwner =
      file !== null && file.owner.pid !== process.pid && stillOurs(file.owner, this.probe);
    if (foreignLiveOwner) {
      logger.warn(
        '[warm-process-ledger] another live server owns this ledger; starting a new one',
        {
          owner: file.owner.pid,
          dropped: file.processes.length,
        }
      );
    }
    const inherited = foreignLiveOwner ? [] : (file?.processes ?? []);
    const processes = inherited.filter((entry) => entry.pid !== pid);
    processes.push({ pid, startedAt });
    this.write({ owner, processes });
  }

  /**
   * Forget a subprocess that has exited. Called from the child's own `exit`
   * event, so the ledger shrinks as processes go rather than only at boot.
   *
   * @param pid - The process id that exited
   */
  forget(pid: number): void {
    const file = this.read();
    if (!file) return;
    const processes = file.processes.filter((entry) => entry.pid !== pid);
    if (processes.length === file.processes.length) return;
    this.write({ ...file, processes });
  }

  /** The ledger as it stands, or `null` when there is none or it is unreadable. */
  read(): WarmProcessLedgerFile | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = WarmProcessLedgerFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      // Truncated by the very kill this exists to survive, or hand-edited.
      // Unreadable is the same as absent: there is nothing here we could prove.
      return null;
    }
  }

  /** Drop the whole ledger. Never throws — a sweep must not fail a boot. */
  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      logger.warn('[warm-process-ledger] could not clear the ledger', { path: this.filePath });
    }
  }

  /**
   * This server's own identity stamp, resolved once. `null` when the platform
   * cannot prove it, in which case nothing is written at all — an unstamped
   * ledger is one a future boot could not tell from another instance's.
   */
  private owner(): WarmProcessRecord | null {
    if (this.ownStartedAt === undefined) this.ownStartedAt = this.probe.startTimeOf(process.pid);
    if (this.ownStartedAt === null) return null;
    return { pid: process.pid, startedAt: this.ownStartedAt };
  }

  /** Persist the ledger atomically, so a kill mid-write cannot corrupt it. */
  private write(file: WarmProcessLedgerFile): void {
    const temp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(file, null, 2));
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      // A ledger we cannot write means the next boot will not reap — the bug we
      // already had. It must never take a warm launch down with it.
      logger.warn('[warm-process-ledger] could not write the ledger', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing further to try; the stray temp file is inert.
      }
    }
  }
}

/** This data directory's ledger, built on first use. */
let shared: WarmProcessLedger | undefined;

/**
 * The one ledger this server writes to.
 *
 * A module-level singleton rather than a constructor-threaded dependency
 * because both of its users sit at opposite ends of the process — the spawn
 * seam deep inside a pump launch, and the sweep at the top of boot — and the
 * single-instance lock already guarantees one server per data directory, which
 * is precisely the scope of this object.
 */
export function sharedWarmProcessLedger(): WarmProcessLedger {
  shared ??= new WarmProcessLedger(resolveDorkHome());
  return shared;
}

/** What one boot-time sweep did. */
export interface WarmProcessReapReport {
  /** Records that named a process we proved we own, and therefore ended. */
  reaped: number[];
  /**
   * Live descendants of the reaped roots, ended on the root's proof. Empty when
   * the process table could not be read, in which case only the roots are
   * signalled and the CLI's own shutdown is left to take its children with it.
   */
  descendants: number[];
  /** Records whose pid is gone, or now belongs to somebody else. Left alone. */
  skipped: number[];
  /**
   * Why nothing was swept, when nothing was: `no-ledger` (the normal case) or
   * `owner-alive` (another server is using this data directory right now).
   */
  declined?: 'no-ledger' | 'owner-alive';
}

/** Inputs to {@link reapOrphanedWarmProcesses}. */
export interface ReapOrphanedWarmProcessesInput {
  /** The ledger to sweep. Defaults to this data directory's. */
  ledger?: WarmProcessLedger;
  /** The operating system, injectable for tests. */
  probe?: ProcessProbe;
  /** Sleep, injectable so tests do not spend the SIGTERM grace window. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait, so the grace window can be driven synthetically in tests.
 *
 * The timer is deliberately NOT `unref`'d, unlike almost every other timer in
 * this server. This runs at the very top of boot, before the HTTP listener and
 * before any other handle exists, so an unref'd timer is the ONLY thing holding
 * the event loop — and Node answers an empty loop by exiting, silently and with
 * status 0. That is not theoretical: it is what the first version of this did,
 * and a server with orphans to reap quit during the reap and never started.
 * Two seconds of a referenced timer, once, at boot, is the correct trade.
 *
 * @internal Exported so a test can pin that it holds the event loop open.
 * @param ms - How long to wait
 */
export function graceSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Every live descendant of an already-proven-owned root, deepest first.
 *
 * Deepest-first so a tree is dismantled from the leaves, and the root — the one
 * process that might still shut its own children down politely — is signalled
 * by the caller first regardless.
 *
 * @param roots - Pids this module has already proven it owns
 * @param table - One snapshot of the live process table, `pid → ppid`
 */
function descendantsOf(roots: readonly number[], table: ReadonlyMap<number, number>): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const [pid, ppid] of table) {
    const siblings = childrenOf.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  const owned = new Set(roots);
  const found: number[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of childrenOf.get(pid) ?? []) {
      // A cycle is impossible in a real process table, but the table is parsed
      // from text and a malformed line must not spin here forever.
      if (owned.has(child)) continue;
      owned.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found.reverse();
}

/**
 * Whether a recorded process is still the one we recorded.
 *
 * This is the ownership proof, and it is deliberately the whole of it: an exact
 * match on the start time we captured at spawn. See the module doc.
 *
 * @param record - What was written down when the process was spawned
 * @param probe - The operating system
 */
function stillOurs(record: WarmProcessRecord, probe: ProcessProbe): boolean {
  const startedAt = probe.startTimeOf(record.pid);
  return startedAt !== null && startedAt === record.startedAt;
}

/**
 * End every warm claude-code subprocess a previous instance of THIS data
 * directory left running.
 *
 * ## The grace window is for the roots only
 *
 * Roots get SIGTERM, then up to {@link TERM_GRACE_MS} to go, then SIGKILL.
 * Descendants get no window of their own: they are signalled once, after the
 * roots' window has already elapsed. That is deliberate rather than an
 * oversight. The root is the CLI, and a CLI honouring SIGTERM shuts its own
 * children down, so by the time the window closes most descendants are already
 * gone and the survivors are the ones that ignored their parent's shutdown. A
 * second full window for them would double a boot delay to be polite to
 * processes that have already demonstrated they will not take the hint. If that
 * ever proves wrong, the fix is a second window here, not a change to the
 * ownership proof.
 *
 * Call once at boot, after the single-instance lock is held and before anything
 * can hand out a warm slot. The ledger is cleared FIRST, in every path: the
 * records describe a server that is gone, the sweep must not be able to repeat
 * itself if it is interrupted, and the instance about to run is going to start
 * writing its own records into the same file.
 *
 * @param input - The ledger, the operating system, and the clock — all
 *   injectable, all defaulted to the real ones
 */
export async function reapOrphanedWarmProcesses(
  input: ReapOrphanedWarmProcessesInput = {}
): Promise<WarmProcessReapReport> {
  const probe = input.probe ?? systemProcessProbe;
  const ledger = input.ledger ?? sharedWarmProcessLedger();
  const sleep = input.sleep ?? graceSleep;

  const file = ledger.read();
  if (!file) return { reaped: [], descendants: [], skipped: [], declined: 'no-ledger' };

  // Another server is alive and holding this data directory: these are its
  // processes, not orphans. Leave the ledger exactly as it is — it is the live
  // owner's, and clearing it would cost that server its own next-boot sweep.
  if (stillOurs(file.owner, probe) && file.owner.pid !== process.pid) {
    logger.warn('[warm-process-ledger] another instance owns this data directory; not sweeping', {
      owner: file.owner.pid,
    });
    return { reaped: [], descendants: [], skipped: [], declined: 'owner-alive' };
  }

  ledger.clear();

  const reaped: number[] = [];
  const skipped: number[] = [];
  for (const record of file.processes) {
    if (stillOurs(record, probe)) reaped.push(record.pid);
    else skipped.push(record.pid);
  }
  if (reaped.length === 0) return { reaped, descendants: [], skipped };

  const table = probe.processTable();
  const descendants = table === null ? [] : descendantsOf(reaped, table);

  // The subjects, not a count of them. This is the one path in DorkOS whose
  // failure mode is "a process somebody was using is gone", and after the fact
  // the evidence is unrecoverable: the pids no longer resolve to anything. So
  // the names are read HERE, while the processes still exist, and the line
  // carries the full lists rather than lengths. One extra `ps` at boot, only
  // when there is actually something to reap, is a cheap price for being able
  // to answer "what exactly did it end?".
  const named = probe.commandsOf?.([...reaped, ...descendants]) ?? null;
  const describe = (pids: readonly number[]): string[] =>
    pids.map((pid) => (named?.get(pid) === undefined ? String(pid) : `${pid} (${named.get(pid)})`));

  logger.info('[warm-process-ledger] ending agent processes an earlier run left behind', {
    reaped: describe(reaped),
    descendants: describe(descendants),
    skipped,
  });

  for (const pid of reaped) probe.signal(pid, 'SIGTERM');

  // The roots get the grace window; whatever is still standing after it — roots
  // and any descendant their own shutdown did not take with them — is ended.
  for (let waited = 0; waited < TERM_GRACE_MS; waited += TERM_POLL_MS) {
    if (!reaped.some((pid) => probe.signal(pid, 0))) break;
    await sleep(TERM_POLL_MS);
  }
  for (const pid of [...descendants, ...reaped]) {
    if (probe.signal(pid, 0)) probe.signal(pid, 'SIGKILL');
  }

  return { reaped, descendants, skipped };
}
