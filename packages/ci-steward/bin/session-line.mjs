#!/usr/bin/env node
/**
 * The CI Steward dead-man's switch (plans/ci-steward-plan.md §4.4), run by
 * `.claude/hooks/session-maintenance.sh` at SessionStart.
 *
 * Prints at most ONE `[Harness]` line, and nothing when all is well:
 *
 * - the newest snapshot on `origin/<data_branch>` is over 2 days old. When this
 *   checkout fetched recently, that means the daily collector stopped; when it
 *   has not fetched since, it says the local copy is old instead, because the
 *   collector may be fine;
 * - that snapshot's health failed, or it reports a data-branch safeguard missing;
 * - the day's triage left a red trigger open (the summary `triage` writes into
 *   latest.json, so this still reads exactly one file). Suppressed when health
 *   already failed, because the health failure is itself the first trigger;
 * - a local SLO (local-commit, local-push) is in breach;
 * - this clone's most recent hook run in the last 6 hours was killed: an END
 *   with a signal status (128 + HUP, INT or TERM), or a START with no END older
 *   than the pre-push watchdog's ceiling. A younger unmatched START may still
 *   be running, so it is never reported.
 *
 * Plain JavaScript on purpose: SessionStart has a 500 ms budget shared with
 * other checks, and a `.ts` file pays for type stripping. It imports only
 * Node built-ins, reads git objects only (no network), and reads
 * `ci/config.yaml` with a regex. The killed-run rule mirrors `hookRuns` in
 * `src/timings.ts`; a test holds the two to the same answers. The hook runs it
 * behind a hard timeout, and it always exits 0.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const SIGNAL_STATUSES = new Set([129, 130, 143]);
const TWO_DAYS_MS = 48 * 3_600_000;

/**
 * Whether this clone's most recent hook run (within 6 hours) was killed.
 *
 * @param {string} text - The tail of the timings file.
 * @param {number} nowSec - The clock, in epoch seconds.
 * @param {number} ceilingSec - A START with no END older than this was killed.
 * @returns {string | null} The hook's name when it was killed, else null.
 */
export function lastRunKilled(text, nowSec, ceilingSec) {
  const cmds = new Map();
  for (const line of text.split('\n')) {
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!v || typeof v.id !== 'string' || typeof v.t !== 'number') continue;
    const key = `${v.id}/${v.h}/${v.c}`;
    if (v.e === 'S') cmds.set(key, { h: v.h, pp: v.pp, start: v.t, end: null, x: null });
    else if (v.e === 'E' && cmds.has(key))
      Object.assign(cmds.get(key), { end: v.t, x: v.x ?? null });
  }
  const recent = [...cmds.values()].filter((c) => nowSec - c.start < 6 * 3600);
  if (recent.length === 0) return null;
  const newest = recent.reduce((a, b) => (b.start > a.start ? b : a));
  // The newest run: that command and its siblings under the same lefthook process.
  const run = recent.filter(
    (c) => c.h === newest.h && c.pp === newest.pp && newest.start - c.start <= 3600
  );
  const killed = run.some(
    (c) =>
      (c.x !== null && SIGNAL_STATUSES.has(c.x)) ||
      (c.end === null && nowSec - c.start > ceilingSec)
  );
  return killed ? newest.h : null;
}

/**
 * The line to print, or null for silence.
 *
 * @param {{ latest: string | null, timings: string | null, nowMs: number, ceilingSec: number, lastFetchMs: number | null }} inp - The inputs.
 * @returns {string | null} One `[Harness]` line, or null.
 */
export function sessionLine(inp) {
  const problems = [];
  if (inp.latest !== null) {
    try {
      const l = JSON.parse(inp.latest);
      const collected = Date.parse(l.collected_at ?? '');
      if (!Number.isFinite(collected) || inp.nowMs - collected > TWO_DAYS_MS) {
        // A fetch well after the snapshot should have been replaced says the
        // collector stopped; otherwise this checkout just has an old copy.
        const fetchedSince =
          inp.lastFetchMs !== null && inp.lastFetchMs > collected + 26 * 3_600_000;
        problems.push(
          fetchedSince
            ? `the newest CI snapshot (${l.date ?? 'unknown'}) is over 2 days old, so the daily collector has stopped`
            : `the local copy of ci-steward-data (${l.date ?? 'unknown'}) was not fetched in over 2 days; run git fetch origin ci-steward-data`
        );
      }
      if (l.healthy === false) {
        const n = (l.failures ?? []).length;
        problems.push(`collector health failed (${n} problem${n === 1 ? '' : 's'})`);
      } else if (l.triggers && l.triggers.red > 0) {
        const top = String(l.triggers.top ?? '').slice(0, 120);
        problems.push(
          `${l.triggers.red} red CI trigger${l.triggers.red === 1 ? '' : 's'} open${top ? `: ${top}` : ''}`
        );
      }
      if (l.safeguards_ok === false)
        problems.push('a ci-steward-data safeguard ruleset is missing or changed');
      if ((l.local_breaches ?? []).length)
        problems.push(`local SLO breached: ${l.local_breaches.join(', ')}`);
    } catch {
      problems.push('latest.json on the data branch does not parse');
    }
  }
  if (inp.timings) {
    const hook = lastRunKilled(inp.timings, Math.floor(inp.nowMs / 1000), inp.ceilingSec);
    if (hook) problems.push(`the last ${hook} hook in this clone was killed before it finished`);
  }
  return problems.length ? `[Harness] CI Steward: ${problems.join('; ')}. Run /ci-status.` : null;
}

function tail(file, bytes) {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

function mtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function main() {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const [root, common, gitDir] = git([
    'rev-parse',
    '--show-toplevel',
    '--path-format=absolute',
    '--git-common-dir',
    '--git-dir',
  ]).split('\n');
  const config = readFileSync(path.join(root, 'ci/config.yaml'), 'utf8');
  const branch = /^data_branch:\s*(\S+)/m.exec(config)?.[1] ?? 'ci-steward-data';
  const ceilingSec = Number(/^\s*killed_after_seconds:\s*(\d+)/m.exec(config)?.[1] ?? 7500);
  const timingsRel =
    /^\s*timings_file:\s*(\S+)/m.exec(config)?.[1] ?? 'ci-steward/local-timings.jsonl';
  let latest = null;
  try {
    latest = git(['cat-file', '-p', `refs/remotes/origin/${branch}:latest.json`]);
  } catch {
    // no data branch here yet: nothing to watch
  }
  const fetches = [
    mtime(path.join(gitDir, 'FETCH_HEAD')),
    mtime(path.join(common, 'FETCH_HEAD')),
  ].filter((t) => t !== null);
  const line = sessionLine({
    latest,
    timings: tail(path.join(common, timingsRel), 64 * 1024),
    nowMs: Date.now(),
    ceilingSec,
    lastFetchMs: fetches.length ? Math.max(...fetches) : null,
  });
  if (line) process.stdout.write(`${line}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    main();
  } catch {
    // SessionStart must never fail
  }
}
