/**
 * The local timings file's events and the hook runs they make (plan §4.5).
 *
 * Kept free of imports on purpose: the SessionStart line loads this file on
 * every session start, inside a 500 ms budget shared with other checks.
 *
 * The file holds one JSON line per event: `S` (START) when a lefthook command
 * begins, `E` (END, with its exit status `x`) when its shell exits, and `O` (a
 * NOTE, with a key `o` and an optional number `d`) for an outcome the exit
 * status cannot carry. One hook run is every command of one hook under one
 * lefthook process (`pp`), so a whole-hook wall time is its last END minus its
 * first START, whether the commands ran in parallel (pre-commit) or one after
 * another (pre-push).
 *
 * A run is killed when a command's END carries a signal status (the wrap's
 * INT/TERM/HUP trap writes 128+n), or when a START has no END and is older
 * than the ceiling (SIGKILL runs no trap). A younger unmatched START is
 * "running or killed", never "killed".
 *
 * A NOTE IS NOT A STATUS (DOR-2160). `notes` carries what the exit status
 * cannot: `lock_wait` when a heavy command queued behind another agent's, and
 * `lock_timeout` when it gave up waiting and ran with no machine-wide slot at
 * all. Neither changes whether the run succeeded, and neither is inferable from
 * anything else — a command that ran uncapped looks exactly like one that had a
 * slot to itself, which is how a cap stops existing without anyone noticing.
 *
 * Every event line also carries the machine at that instant — load average
 * `l`, cores `n`, available memory `m` in MiB, swap in use `s` in MiB — because
 * a hook's wall time here is mostly a fact about the machine. Any of them may
 * be `null` where the platform will not say.
 */

/** One line of the timings file. */
export interface TimingEvent {
  e: 'S' | 'E' | 'O';
  h: string;
  c: string;
  id: string;
  pp: number;
  t: number;
  x?: number;
  /** A note's key, on an `O` line. */
  o?: string;
  /** A note's number, when it carries one. */
  d?: number;
  /** 1-minute load average. */
  l?: number;
  /** Online cores. */
  n?: number;
  /** Available memory, MiB. */
  m?: number;
  /** Swap in use, MiB. */
  s?: number;
}

/** The machine as one event saw it. */
export interface MachineSample {
  t: number;
  /** Load average divided by cores; `null` when either was unavailable. */
  loadPerCore: number | null;
  /** Available memory, MiB. */
  memAvailableMb: number | null;
  /** Swap in use, MiB. */
  swapUsedMb: number | null;
}

/** One command's run: a START, and its END when there was one. */
interface CommandRun {
  hook: string;
  command: string;
  ppid: number;
  start: number;
  end: number | null;
  status: number | null;
  /** Note keys seen against this command, with how many times each. */
  notes: Record<string, number>;
  /** The machine as this command's own events saw it. */
  machine: MachineSample[];
}

/** One hook run: its commands under one lefthook process. */
export interface HookRun {
  hook: string;
  start: number;
  /** Wall seconds from the first START to the last END; `null` when killed or still open. */
  seconds: number | null;
  state: 'done' | 'killed' | 'open';
  failed: boolean;
  commands: CommandRun[];
  /** Every machine reading this run's events carried, oldest first. */
  machine: MachineSample[];
}

/**
 * Parse the timings file's text, skipping lines that are not events.
 *
 * @param text - The file's contents.
 */
export function parseTimings(text: string): TimingEvent[] {
  const out: TimingEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Partial<TimingEvent>;
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
      if (
        (v.e === 'S' || v.e === 'E' || v.e === 'O') &&
        typeof v.h === 'string' &&
        typeof v.c === 'string' &&
        typeof v.id === 'string' &&
        typeof v.t === 'number'
      ) {
        out.push({
          e: v.e,
          h: v.h,
          c: v.c,
          id: v.id,
          pp: Number(v.pp ?? 0),
          t: v.t,
          x: num(v.x),
          o: typeof v.o === 'string' ? v.o : undefined,
          d: num(v.d),
          l: num(v.l),
          n: num(v.n),
          m: num(v.m),
          s: num(v.s),
        });
      }
    } catch {
      // a torn or foreign line; the rest of the file still counts
    }
  }
  return out;
}

/**
 * Exit statuses of a hook the time-wrap's signal trap wrote: 128 + HUP, INT,
 * TERM. A hook stopped this way was killed, not failed.
 */
export const SIGNAL_STATUSES: ReadonlySet<number> = new Set([129, 130, 143]);

/** Commands of one hook run start within this many seconds of the run's last activity. */
const SAME_RUN_GAP_SECONDS = 60;

/**
 * Pair STARTs with ENDs and group commands into hook runs.
 *
 * @param events - The parsed events.
 * @param nowSec - The clock, in epoch seconds.
 * @param ceilingSec - A START with no END older than this was killed.
 */
export function hookRuns(
  events: readonly TimingEvent[],
  nowSec: number,
  ceilingSec: number
): HookRun[] {
  const cmds = new Map<string, CommandRun>();
  for (const ev of events) {
    const key = `${ev.id}/${ev.h}/${ev.c}`;
    if (ev.e === 'S')
      cmds.set(key, {
        hook: ev.h,
        command: ev.c,
        ppid: ev.pp,
        start: ev.t,
        end: null,
        status: null,
        notes: {},
        machine: [],
      });
    // A note or an END whose START has aged out of the file belongs to no run.
    const c = cmds.get(key);
    if (!c) continue;
    if (ev.e === 'O') {
      if (ev.o) c.notes[ev.o] = (c.notes[ev.o] ?? 0) + 1;
    } else if (ev.e === 'E') {
      c.end = ev.t;
      c.status = ev.x ?? null;
    }
    if (ev.l !== undefined || ev.m !== undefined || ev.s !== undefined)
      c.machine.push({
        t: ev.t,
        // A load average without a core count says nothing comparable between
        // machines, so the ratio is null rather than the raw number.
        loadPerCore: ev.l !== undefined && ev.n ? ev.l / ev.n : null,
        memAvailableMb: ev.m ?? null,
        swapUsedMb: ev.s ?? null,
      });
  }
  const sorted = [...cmds.values()].sort((a, b) => a.start - b.start);
  const groups: CommandRun[][] = [];
  const open = new Map<string, CommandRun[]>();
  for (const c of sorted) {
    const key = `${c.hook}/${c.ppid}`;
    const g = open.get(key);
    const lastActivity = g ? Math.max(...g.map((x) => x.end ?? x.start)) : -Infinity;
    if (g && c.start - lastActivity <= SAME_RUN_GAP_SECONDS) g.push(c);
    else {
      const fresh = [c];
      groups.push(fresh);
      open.set(key, fresh);
    }
  }
  return groups.map((g) => {
    const start = Math.min(...g.map((c) => c.start));
    const unmatched = g.filter((c) => c.end === null);
    const signalled = g.some((c) => c.status !== null && SIGNAL_STATUSES.has(c.status));
    const state: HookRun['state'] = signalled
      ? 'killed'
      : unmatched.length === 0
        ? 'done'
        : unmatched.some((c) => nowSec - c.start > ceilingSec)
          ? 'killed'
          : 'open';
    const end = Math.max(...g.map((c) => c.end ?? c.start));
    return {
      hook: g[0]!.hook,
      start,
      seconds: state === 'done' ? end - start : null,
      state,
      failed: g.some((c) => c.status !== null && c.status !== 0 && !SIGNAL_STATUSES.has(c.status)),
      commands: g,
      machine: g.flatMap((c) => c.machine).sort((a, b) => a.t - b.t),
    };
  });
}
