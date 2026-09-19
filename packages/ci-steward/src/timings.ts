/**
 * The local timings file's events and the hook runs they make (plan §4.5).
 *
 * Kept free of imports on purpose: the SessionStart line loads this file on
 * every session start, inside a 500 ms budget shared with other checks.
 *
 * The file holds one JSON line per event: `S` (START) when a lefthook command
 * begins and `E` (END, with its exit status `x`) when its shell exits. One hook
 * run is every command of one hook under one lefthook process (`pp`), so a
 * whole-hook wall time is its last END minus its first START, whether the
 * commands ran in parallel (pre-commit) or one after another (pre-push).
 *
 * A run is killed when a command's END carries a signal status (the wrap's
 * INT/TERM/HUP trap writes 128+n), or when a START has no END and is older
 * than the ceiling (SIGKILL runs no trap). A younger unmatched START is
 * "running or killed", never "killed".
 */

/** One line of the timings file. */
export interface TimingEvent {
  e: 'S' | 'E';
  h: string;
  c: string;
  id: string;
  pp: number;
  t: number;
  x?: number;
}

/** One command's run: a START, and its END when there was one. */
interface CommandRun {
  hook: string;
  command: string;
  ppid: number;
  start: number;
  end: number | null;
  status: number | null;
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
      if (
        (v.e === 'S' || v.e === 'E') &&
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
          x: typeof v.x === 'number' ? v.x : undefined,
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
      });
    else {
      const c = cmds.get(key);
      if (c) {
        c.end = ev.t;
        c.status = ev.x ?? null;
      }
    }
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
    };
  });
}
