/**
 * Local hook timings (plan §4.5): turning the hook runs `bin/time-wrap.sh`
 * recorded (parsed in `timings.ts`) into per-day aggregates for
 * `local/<clone>/YYYY-MM-DD.json`, and rotating the file.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import type { LocalDay } from './data.ts';
import { dayOf } from './time.ts';
import { SIGNAL_STATUSES, type HookRun } from './timings.ts';

/**
 * Aggregate hook runs into one `LocalDay` per UTC day of their START, for
 * days before `today` (a day still in progress is exported tomorrow).
 *
 * @param runs - The hook runs.
 * @param clone - The clone's export name.
 * @param today - The current UTC day.
 * @param exportedAt - The clock, as an ISO time.
 */
export function aggregateDays(
  runs: readonly HookRun[],
  clone: string,
  today: string,
  exportedAt: string
): LocalDay[] {
  const days = new Map<string, LocalDay>();
  const bucket = (
    rec: Record<string, { durations: [number, number][]; killed: number; failed: number }>,
    key: string
  ) => (rec[key] ??= { durations: [], killed: 0, failed: 0 });
  for (const r of runs) {
    const day = dayOf(new Date(r.start * 1000));
    if (day >= today || r.state === 'open') continue;
    const d = days.get(day) ?? {
      schema: 1 as const,
      clone,
      date: day,
      exported_at: exportedAt,
      hooks: {},
      commands: {},
    };
    days.set(day, d);
    const h = bucket(d.hooks, r.hook);
    const sod = r.start - Date.parse(`${day}T00:00:00Z`) / 1000;
    if (r.state === 'killed') h.killed += 1;
    else h.durations.push([sod, r.seconds!]);
    if (r.failed) h.failed += 1;
    for (const c of r.commands) {
      const b = bucket(d.commands, `${c.hook}.${c.command}`);
      if (c.end === null || (c.status !== null && SIGNAL_STATUSES.has(c.status))) b.killed += 1;
      else b.durations.push([c.start - Date.parse(`${day}T00:00:00Z`) / 1000, c.end - c.start]);
      if (c.status !== null && c.status !== 0 && !SIGNAL_STATUSES.has(c.status)) b.failed += 1;
    }
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Drop events older than the retention window, then, if the file is still
 * over its size cap, the oldest half.
 *
 * The time-wrap appends to this file at any moment, so the rewrite must not
 * lose a line: a lost END turns a finished hook into a phantom kill. It reads
 * through one open descriptor, writes the kept lines to a temp file, renames
 * that over the file (new appends now land in the new file), then reads the
 * old descriptor again from where it stopped and appends anything that arrived
 * in between. A writer opens the file, appends one short line and closes it,
 * so after the rename only one that had already opened the old file can still
 * write there; the second read, a moment later, collects it.
 *
 * @param file - The timings file.
 * @param nowSec - The clock, in epoch seconds.
 * @param retentionDays - Keep this many days.
 * @param maxBytes - The size cap.
 * @param beforeRename - Test seam: runs between the read and the rename.
 * @returns Lines kept and dropped.
 */
export function rotateTimings(
  file: string,
  nowSec: number,
  retentionDays: number,
  maxBytes: number,
  beforeRename?: () => void
): { kept: number; dropped: number } {
  if (!existsSync(file)) return { kept: 0, dropped: 0 };
  const fd = openSync(file, 'r');
  try {
    const readFrom = (offset: number): { text: string; end: number } => {
      const size = fstatSync(fd).size;
      if (size <= offset) return { text: '', end: offset };
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      return { text: buf.toString('utf8'), end: size };
    };
    const first = readFrom(0);
    // Stop at the last whole line; a line still being written is carried over.
    const whole = first.text.slice(0, first.text.lastIndexOf('\n') + 1);
    const lines = whole.split('\n').filter((l) => l.trim());
    const cutoff = nowSec - retentionDays * 86_400;
    let kept = lines.filter((l) => {
      const t = /"t":(\d+)/.exec(l);
      return t ? Number(t[1]) >= cutoff : false;
    });
    if (Buffer.byteLength(kept.join('\n')) > maxBytes)
      kept = kept.slice(Math.floor(kept.length / 2));
    if (kept.length === lines.length && first.end <= maxBytes)
      return { kept: kept.length, dropped: 0 };
    const tmp = `${file}.rotate`;
    writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '');
    beforeRename?.();
    renameSync(tmp, file);
    // A moment for a writer that opened the old file just before the rename.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    const late = readFrom(Buffer.byteLength(whole));
    if (late.text) appendFileSync(file, late.text);
    return { kept: kept.length, dropped: lines.length - kept.length };
  } finally {
    closeSync(fd);
  }
}

/**
 * A clone's export name when none is given: a short digest of this machine and
 * the clone's git directory. Never the hostname itself, because the data
 * branch is public.
 *
 * @param commonDir - The clone's `git rev-parse --git-common-dir`, absolute.
 */
export function defaultCloneName(commonDir: string): string {
  return `clone-${createHash('sha256').update(`${hostname()}\n${commonDir}`).digest('hex').slice(0, 10)}`;
}
