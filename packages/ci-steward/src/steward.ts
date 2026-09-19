/**
 * The steps the daily workflow and `ci:pulse` run after (and around) collect:
 * write `latest.json`, compute verdicts, and on Mondays write the weekly report
 * and move the floors. Each step reads and writes a working tree of the data
 * branch and nothing else.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  FloorsSchema,
  LatestSchema,
  loadLocalDays,
  loadSnapshots,
  readData,
  snapshotPath,
  SnapshotSchema,
  VerdictSchema,
  writeData,
  type Floors,
  type Latest,
  type SloReading,
  type Verdict,
} from './data.ts';
import { floorValues, pickConstraint, updateFloors, type FloorRelease } from './floors.ts';
import type { Gh } from './gh.ts';
import type { HandFiles } from './load.ts';
import { renderReport } from './report.ts';
import { computeSlos } from './slo.ts';
import { addDays, daysBetween, dayStart, isoWeek, weekMonday } from './time.ts';
import { computeVerdict, hypothesisHash, seriesFrom, type LedgerEntry } from './verdicts.ts';
import type { WorkflowModel } from './workflows.ts';

/** What every step needs to know about the repo. */
export interface StewardContext {
  files: HandFiles;
  workflows: readonly WorkflowModel[];
  dataDir: string;
  now: Date;
}

const LOCAL_SLOS = new Set(['local-commit', 'local-push']);

/**
 * Every SLO over the 7 days ending `to`, against the current floors.
 *
 * @param ctx - The context.
 * @param to - Last day of the window.
 * @param days - Window length (7 for the daily reading and each weekly one).
 */
function readSlos(ctx: StewardContext, to: string, days = 7): SloReading[] {
  const { files, dataDir } = ctx;
  if (!files.slos) return [];
  const from = addDays(to, -(days - 1));
  const floors = readData(dataDir, 'floors.json', FloorsSchema);
  return computeSlos(files.slos, floorValues(files.slos, floors), {
    snapshots: loadSnapshots(dataDir, daysBetween(addDays(to, -27), to)),
    local: loadLocalDays(dataDir, daysBetween(from, to)),
    toolCeilingSeconds: files.config.local.tool_ceiling_seconds,
    from,
    to,
  });
}

/**
 * Write `latest.json` for the newest collected day, and record each SLO's
 * sample size against its minimum in that day's health block.
 *
 * @param ctx - The context.
 * @param newest - The newest day collected.
 * @param run - This run's API requests and health failures. A run that failed
 *   on a backfill day is red even when the day latest points at is healthy.
 */
export function writeLatest(
  ctx: StewardContext,
  newest: string,
  run: { apiCalls: number; failures: readonly string[] }
): Latest {
  const { files, dataDir } = ctx;
  const snap = readData(dataDir, snapshotPath(newest), SnapshotSchema);
  if (!snap) throw new Error(`no snapshot for ${newest} to point latest.json at`);
  const readings = readSlos(ctx, newest);
  snap.health.min_n = Object.fromEntries(readings.map((r) => [r.id, { n: r.n, min_n: r.min_n }]));
  const thin = readings
    .filter((r) => r.status === 'insufficient')
    .map((r) => `${r.id} (n=${r.n} < ${r.min_n})`);
  const warnings = snap.health.warnings.filter((w) => !w.startsWith('Thin sample:'));
  if (thin.length)
    warnings.push(
      `Thin sample: ${thin.join(', ')}; those SLOs read as insufficient, not as a breach or a win.`
    );
  snap.health.warnings = warnings;
  writeData(dataDir, snapshotPath(newest), snap);
  const prior = readData(dataDir, 'latest.json', LatestSchema);
  const latest: Latest = {
    schema: 1,
    date: newest,
    collected_at: snap.collected_at,
    snapshot: snapshotPath(newest),
    report_ref: prior?.report_ref ?? null,
    healthy: snap.healthy && run.failures.length === 0,
    failures: [...new Set([...snap.health.failures, ...run.failures])],
    warnings: snap.health.warnings,
    api_calls: run.apiCalls,
    slos: readings,
    constraint: files.slos
      ? pickConstraint(files.slos, readings, [
          ...new Set([...snap.health.failures, ...run.failures]),
        ])
      : { tier: 'none', id: null, reason: 'no SLOs' },
    local_breaches: readings
      .filter((r) => LOCAL_SLOS.has(r.id) && r.status === 'breach')
      .map((r) => r.id),
    safeguards_ok:
      snap.health.data_rulesets.length > 0 && snap.health.data_rulesets.every((d) => d.ok),
  };
  writeData(dataDir, 'latest.json', latest);
  return latest;
}

/**
 * Merge times of every PR the ledger names, from the REST API.
 *
 * @param gh - The client.
 * @param repo - `owner/name`.
 * @param ledger - The ledger entries.
 */
export function fetchMergeTimes(
  gh: Gh,
  repo: string,
  ledger: readonly LedgerEntry[]
): Map<number, string> {
  const out = new Map<number, string>();
  const prs = [...new Set(ledger.flatMap((e) => e.prs))].sort((a, b) => a - b);
  for (const n of prs) {
    const pr = gh.rest(`repos/${repo}/pulls/${n}`) as { merged_at?: string | null };
    if (typeof pr.merged_at === 'string') out.set(n, pr.merged_at);
  }
  return out;
}

/**
 * Compute and write `verdicts/<id>.json` for every entry with a hypothesis and
 * a merged PR. A final verdict whose hypothesis has not changed is kept as is.
 *
 * @param ctx - The context.
 * @param ledger - The ledger entries.
 * @param mergedAt - Merge time per PR.
 */
export function runVerdicts(
  ctx: StewardContext,
  ledger: readonly LedgerEntry[],
  mergedAt: ReadonlyMap<number, string>
): Verdict[] {
  const { files, dataDir, now } = ctx;
  const series = seriesFrom(
    (days) => loadSnapshots(dataDir, days),
    (days) => loadLocalDays(dataDir, days)
  );
  const out: Verdict[] = [];
  for (const entry of ledger) {
    if (!entry.hypothesis) continue;
    const rel = `verdicts/${entry.id}.json`;
    const prior = readData(dataDir, rel, VerdictSchema);
    if (prior && prior.verdict !== 'pending' && prior.hypothesis_hash === hypothesisHash(entry)) {
      out.push(prior);
      continue;
    }
    const v = computeVerdict({ entry, mergedAt, ledger, files, series, now });
    if (!v) continue;
    writeData(dataDir, rel, v);
    out.push(v);
  }
  return out;
}

/**
 * Every verdict file in the data directory.
 *
 * @param dataDir - A working tree of the data branch.
 */
export function loadVerdicts(dataDir: string): Verdict[] {
  const dir = path.join(dataDir, 'verdicts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const v = readData(dataDir, `verdicts/${f}`, VerdictSchema);
      return v ? [v] : [];
    });
}

/**
 * The ISO week a report covers: the last full week before `now`.
 *
 * @param now - The clock.
 */
function reportWeek(now: Date): { week: string; from: string; to: string } {
  const monday = addDays(weekMonday(now.toISOString().slice(0, 10)), -7);
  return { week: isoWeek(dayStart(monday)), from: monday, to: addDays(monday, 6) };
}

/**
 * Write the weekly report for the week before `now`, move the floors by rule,
 * and point `latest.json` at the report.
 *
 * @param ctx - The context.
 * @param ledger - The ledger entries (titles, floor releases).
 * @param verdicts - The current verdicts.
 */
export function runReport(
  ctx: StewardContext,
  ledger: readonly LedgerEntry[],
  verdicts: readonly Verdict[]
): { path: string; floorChanges: string[] } {
  const { files, dataDir, now } = ctx;
  const { week, from, to } = reportWeek(now);
  const weekly = [0, 1, 2, 3].map((i) => ({
    week: isoWeek(dayStart(addDays(from, -7 * i))),
    to: addDays(to, -7 * i),
    readings: readSlos(ctx, addDays(to, -7 * i)),
  }));
  const releases: FloorRelease[] = ledger.flatMap((e) =>
    e['floor-release'].map((r) => ({ ledgerId: e.id, ...r }))
  );
  let floors: Floors | null = readData(dataDir, 'floors.json', FloorsSchema);
  let floorChanges: string[] = [];
  if (files.slos) {
    const updated = updateFloors(files.slos, floors, week, weekly[0]!.readings, releases, now);
    floors = updated.floors;
    floorChanges = updated.changes;
    writeData(dataDir, 'floors.json', floors);
  }
  const rel = `reports/${week}.md`;
  const text = renderReport({
    ctx,
    week,
    from,
    to,
    weekly,
    ledger,
    verdicts,
    floors,
    floorChanges,
    snapshots: loadSnapshots(dataDir, daysBetween(from, to)),
  });
  writeData(dataDir, rel, text);
  const latest = readData(dataDir, 'latest.json', LatestSchema);
  if (latest) writeData(dataDir, 'latest.json', { ...latest, report_ref: rel });
  return { path: rel, floorChanges };
}
