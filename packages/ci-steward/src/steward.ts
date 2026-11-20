/**
 * The steps the daily workflow and `ci:pulse` run after (and around) collect:
 * write `latest.json`, compute verdicts, and on Mondays write the weekly report
 * and move the floors. Each step reads and writes a working tree of the data
 * branch and nothing else.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
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
import { machineReading } from './machine.ts';
import { BudgetExhausted, type Gh } from './gh.ts';
import type { HandFiles } from './load.ts';
import { renderReport } from './report.ts';
import { computeSlos, sloRuler } from './slo.ts';
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
 * `ledger-prs/<ledger-id>.json`: the PR that added a ledger entry's file to the
 * default branch, for an entry whose own `prs:` is empty. An entry lands in the
 * PR that ships its change, so this is its anchor. Looked up once and kept;
 * `pr: null` records that the file's first commit came through no merged PR.
 */
export const LedgerPrSchema = z
  .object({
    schema: z.literal(1),
    id: z.string(),
    /** The ledger file the lookup was made for, repo-relative. */
    file: z.string(),
    pr: z.number().int().positive().nullable(),
    merged_at: z.string().nullable(),
    /** The commit that added the file. */
    sha: z.string(),
    resolved_at: z.string(),
  })
  .strict();
/** One resolved landing PR. */
export type LedgerPr = z.infer<typeof LedgerPrSchema>;

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
    ...sloRuler(files.config),
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
    machine: machineReading(loadLocalDays(dataDir, daysBetween(addDays(newest, -6), newest))),
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
 * @param known - Merge times already in hand (the landing-PR cache); not re-fetched.
 */
export function fetchMergeTimes(
  gh: Gh,
  repo: string,
  ledger: readonly LedgerEntry[],
  known: ReadonlyMap<number, string> = new Map()
): Map<number, string> {
  const out = new Map<number, string>();
  const prs = [...new Set(ledger.flatMap((e) => e.prs))].sort((a, b) => a - b);
  for (const n of prs) {
    const at = known.get(n);
    if (at !== undefined) {
      out.set(n, at);
      continue;
    }
    const pr = gh.rest(`repos/${repo}/pulls/${n}`) as { merged_at?: string | null };
    if (typeof pr.merged_at === 'string') out.set(n, pr.merged_at);
  }
  return out;
}

/** Fresh landing-PR lookups one run may make (two requests each); the rest wait for the next run. */
export const LANDING_LOOKUPS_PER_RUN = 50;

/** Where an entry's landing PR is cached in the data directory. */
export const ledgerPrPath = (id: string): string => `ledger-prs/${id}.json`;

/** The cached landing PR of an entry; `null` when absent or unreadable. */
function cachedLandingPr(dataDir: string, id: string): LedgerPr | null {
  try {
    return readData(dataDir, ledgerPrPath(id), LedgerPrSchema);
  } catch {
    return null;
  }
}

/** True when the entry needs a landing PR and the cache has no answer for it yet. */
function needsLookup(dataDir: string, e: LedgerEntry): boolean {
  return (
    e.prs.length === 0 &&
    e.file !== undefined &&
    !existsSync(path.join(dataDir, ledgerPrPath(e.id)))
  );
}

/**
 * How many entries a landing-PR lookup would query this run, capped at
 * {@link LANDING_LOOKUPS_PER_RUN}: the caller budgets two requests for each.
 *
 * @param dataDir - A working tree of the data branch.
 * @param ledger - The authored ledger entries.
 */
export function pendingLandingLookups(dataDir: string, ledger: readonly LedgerEntry[]): number {
  return Math.min(ledger.filter((e) => needsLookup(dataDir, e)).length, LANDING_LOOKUPS_PER_RUN);
}

/**
 * The PR that landed each ledger entry whose own `prs:` is empty.
 *
 * Authors rarely come back to fill in `prs:` once their PR merges, but an entry
 * reaches the default branch in the same PR that ships its change, so the PR
 * that added the entry's file is its anchor. That is the merged PR, into the
 * default branch, of the OLDEST commit touching the file.
 *
 * Each answer is cached at `ledger-prs/<id>.json`, so an entry costs one lookup
 * ever; a file whose first commit came through no merged PR is cached as
 * `pr: null`. A failed request skips that entry for this run (nothing is
 * cached, so the next run asks again) and never throws; a spent budget ends
 * the lookups for this run.
 *
 * @param gh - The client.
 * @param repo - `owner/name`.
 * @param dataDir - A working tree of the data branch.
 * @param ledger - The authored ledger entries.
 * @param opts - The clock, the default branch, and the per-run lookup cap.
 * @returns Entry id -> its landing PR, only for entries that resolved to one.
 */
export function resolveLandingPrs(
  gh: Gh,
  repo: string,
  dataDir: string,
  ledger: readonly LedgerEntry[],
  opts: { now: Date; base?: string; limit?: number }
): Map<string, LedgerPr & { pr: number; merged_at: string }> {
  const base = opts.base ?? 'main';
  let lookups = opts.limit ?? LANDING_LOOKUPS_PER_RUN;
  const out = new Map<string, LedgerPr & { pr: number; merged_at: string }>();
  const keep = (e: LedgerEntry, r: LedgerPr | null) => {
    if (r && r.pr !== null && r.merged_at !== null)
      out.set(e.id, { ...r, pr: r.pr, merged_at: r.merged_at });
  };
  for (const e of ledger) {
    if (e.prs.length > 0 || e.file === undefined) continue;
    if (!needsLookup(dataDir, e)) {
      keep(e, cachedLandingPr(dataDir, e.id));
      continue;
    }
    if (lookups <= 0) continue;
    lookups -= 1;
    try {
      const commits = gh.rest(`repos/${repo}/commits?path=${e.file}&per_page=100`);
      const sha = Array.isArray(commits)
        ? (commits.at(-1) as { sha?: unknown } | undefined)?.sha
        : undefined;
      // Not on the default branch (yet): nothing to cache.
      if (typeof sha !== 'string') continue;
      const pulls = gh.rest(`repos/${repo}/commits/${sha}/pulls`);
      const landed = (Array.isArray(pulls) ? pulls : [])
        .map((p) => p as { number?: unknown; merged_at?: unknown; base?: { ref?: unknown } })
        .filter(
          (p): p is { number: number; merged_at: string } =>
            typeof p.number === 'number' && typeof p.merged_at === 'string' && p.base?.ref === base
        )
        .sort((a, b) => a.merged_at.localeCompare(b.merged_at))[0];
      const r: LedgerPr = {
        schema: 1,
        id: e.id,
        file: e.file,
        pr: landed?.number ?? null,
        merged_at: landed?.merged_at ?? null,
        sha,
        resolved_at: opts.now.toISOString(),
      };
      writeData(dataDir, ledgerPrPath(e.id), r);
      keep(e, r);
    } catch (err) {
      if (err instanceof BudgetExhausted) break;
      // One entry's failure skips that entry; the next run asks again.
    }
  }
  return out;
}

/**
 * The ledger as the verdict engine reads it: an entry with no `prs:` of its
 * own takes the PR that landed it, and a `proposed` entry that landed is
 * `active`, because being on the default branch is what makes it live.
 * Explicit `prs:` and every other status are kept. The files are never
 * rewritten; `ledger-check` still validates what was authored.
 *
 * @param ledger - The authored ledger entries.
 * @param landing - Entry id -> landing PR, from {@link resolveLandingPrs}.
 */
export function effectiveLedger(
  ledger: readonly LedgerEntry[],
  landing: ReadonlyMap<string, { pr: number }>
): LedgerEntry[] {
  return ledger.map((e) => {
    const l = e.prs.length === 0 ? landing.get(e.id) : undefined;
    if (!l) return e;
    return { ...e, prs: [l.pr], status: e.status === 'proposed' ? 'active' : e.status };
  });
}

/**
 * Merge times already known from the landing-PR cache: pr -> ISO time.
 *
 * @param landing - Entry id -> landing PR, from {@link resolveLandingPrs}.
 */
export function landingMergeTimes(
  landing: ReadonlyMap<string, { pr: number; merged_at: string }>
): Map<number, string> {
  return new Map([...landing.values()].map((l) => [l.pr, l.merged_at]));
}

/**
 * The ledger as verdicts read it ({@link effectiveLedger}), and the merge time
 * of every PR it names. What `verdicts` and `daily` pass to `runVerdicts`.
 *
 * Its own small budget: one request per PR the ledger names plus two per fresh
 * landing-PR lookup, so a day the collector spent its whole budget on still
 * gets its verdicts.
 *
 * @param ghFor - Builds a client with a request budget.
 * @param repo - `owner/name`.
 * @param dataDir - A working tree of the data branch.
 * @param authored - The ledger entries as read from disk.
 * @param opts - The clock and the default branch.
 */
export function verdictInputs(
  ghFor: (budget: number) => Gh,
  repo: string,
  dataDir: string,
  authored: readonly LedgerEntry[],
  opts: { now: Date; base: string }
): { ledger: LedgerEntry[]; merged: Map<number, string> } {
  const explicit = new Set(authored.flatMap((e) => e.prs)).size;
  const gh = ghFor(explicit + 2 * pendingLandingLookups(dataDir, authored) + 5);
  const landing = resolveLandingPrs(gh, repo, dataDir, authored, opts);
  const ledger = effectiveLedger(authored, landing);
  return { ledger, merged: fetchMergeTimes(gh, repo, ledger, landingMergeTimes(landing)) };
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
