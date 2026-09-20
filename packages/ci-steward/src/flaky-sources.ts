/**
 * Where the flaky classification's INPUT comes from, and the `flaky` command
 * that renders it.
 *
 * Two sources, because the history has two shapes. The collector records named
 * flakes into each day's snapshot from now on, so the data branch is the cheap,
 * offline source. Actions keeps its artifacts for only seven days, though, and
 * a snapshot written before names were recorded has none — so `--fetch` reads
 * the artifacts directly, at a few hundred API requests, and is what makes the
 * lane usable on day one rather than in a fortnight.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Env } from './commands.ts';
import { loadSnapshots, snapshotPath, type Snapshot } from './data.ts';
import {
  classifyFlaky,
  readReportsIn,
  type FlakyCandidate,
  type FlakyObservation,
  type SampledBuild,
} from './flaky.ts';
import type { Gh } from './gh.ts';
import { addDays, dayOf } from './time.ts';

/** Every flaky observation and every sampled build in the window, from the data branch. */
function fromSnapshots(
  dataDir: string,
  days: readonly string[]
): { observations: FlakyObservation[]; builds: SampledBuild[] } {
  // Snapshots are loaded oldest first and each day's builds keep the order the
  // collector sampled them in, which is the queue's own order.
  const snaps: Snapshot[] = loadSnapshots(dataDir, days);
  const observations: FlakyObservation[] = [];
  const builds: SampledBuild[] = [];
  for (const s of snaps) {
    for (const b of s.flaky_builds) builds.push({ ...b, day: s.date });
    for (const f of s.flaky_tests) observations.push({ ...f, day: s.date });
  }
  return { observations, builds };
}

/** Every flaky observation and sampled build read live from Actions artifacts. */
function fromGitHub(
  env: Env,
  gh: Gh,
  since: string,
  maxBuilds: number
): { observations: FlakyObservation[]; builds: SampledBuild[] } {
  const repo = env.files.config.github_repo;
  const observations: FlakyObservation[] = [];
  const builds: (SampledBuild & { at: string })[] = [];
  const tmp = mkdtempSync(path.join(tmpdir(), 'ci-steward-flaky-'));
  try {
    for (const a of env.files.config.collect.artifacts) {
      const res = gh.rest(
        `repos/${repo}/actions/workflows/${a.workflow}/runs?event=merge_group&per_page=100&created=%3E%3D${since}`
      ) as { workflow_runs?: { id: number; head_sha: string; created_at: string }[] };
      const runs = (res.workflow_runs ?? []).slice(0, maxBuilds);
      for (const run of runs) {
        const sha = run.head_sha.slice(0, 12);
        const day = run.created_at.slice(0, 10);
        const dir = mkdtempSync(path.join(tmp, 'a-'));
        try {
          if (gh.downloadArtifacts(run.id, a.pattern, dir) === 0) continue;
          if (!builds.some((b) => b.sha === sha && b.runner === a.format)) {
            builds.push({ sha, day, runner: a.format, at: run.created_at });
          }
          for (const t of readReportsIn(dir, a.format).tests) {
            if (t.outcome !== 'flaky') continue;
            observations.push({ runner: t.runner, file: t.file, title: t.title, sha, day });
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // Oldest first, by the build's own creation time: `clean_builds_since` is
  // measured in the queue's order, and the API lists runs newest first.
  builds.sort((x, y) => x.at.localeCompare(y.at));
  return { observations, builds: builds.map(({ at: _at, ...b }) => b) };
}

/**
 * `flaky`: which tests failed and then passed on the same tree, how often, and
 * which of them the thresholds would let into the lane.
 *
 * @param env - The environment.
 * @param opts - The window, where to read from, and the output shape.
 */
export function cmdFlaky(
  env: Env,
  opts: { data?: string; days?: number; fetch?: boolean; json?: boolean; builds?: number }
): number {
  const cfg = env.files.config.quarantine;
  const days = opts.days ?? cfg.window_days;
  const from = addDays(dayOf(env.now), -(days - 1));
  const span: string[] = [];
  for (let d = from; d <= dayOf(env.now); d = addDays(d, 1)) span.push(d);
  let source: { observations: FlakyObservation[]; builds: SampledBuild[] };
  let label: string;
  if (opts.fetch) {
    const gh = env.gh(env.files.config.collect.api_budget);
    source = fromGitHub(env, gh, from, opts.builds ?? 30);
    label = `Actions artifacts since ${from} (${gh.calls} API requests)`;
  } else if (opts.data) {
    source = fromSnapshots(opts.data, span);
    label = `${opts.data}, ${from}..${dayOf(env.now)}`;
  } else {
    const dir = snapshotsFromGit(env, span);
    try {
      source = fromSnapshots(dir, span);
      label = `origin/${env.files.config.data_branch}, ${from}..${dayOf(env.now)}`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const candidates = classifyFlaky(source.observations, source.builds, cfg);
  if (opts.json) {
    env.io.out(
      `${JSON.stringify({ schema: 1, source: label, window_days: days, builds_sampled: source.builds.length, thresholds: cfg, candidates }, null, 1)}\n`
    );
    return 0;
  }
  env.io.out(
    `Flaky classification from ${label}: ${source.builds.length} queue build(s) sampled, ${candidates.length} test(s) flaked.\n` +
      `A test qualifies on ${cfg.min_occurrences}+ distinct merge-group SHAs where it failed and then passed.\n\n`
  );
  if (candidates.length === 0) {
    env.io.out(
      'Nothing flaked in the window. If that is a surprise, the collector may not have sampled any build yet (`counts.flaky_builds_sampled`), or the artifacts have expired (Actions keeps them 7 days) — try --fetch.\n'
    );
    return 0;
  }
  for (const c of candidates) {
    env.io.out(
      `  ${c.status === 'qualifies' ? 'QUALIFIES' : c.status.toUpperCase()}  ${c.occurrences}/${source.builds.length} build(s)  ${c.first_day}..${c.last_day}  clean since ${c.clean_builds_since}\n    ${c.id}\n${c.why ? `    ${c.why}\n` : ''}`
    );
  }
  const qualify = candidates.filter((c) => c.status === 'qualifies');
  env.io.out(
    `\n${qualify.length} test(s) qualify for the lane. Add one with:\n  pnpm ci:quarantine add --runner <runner> --file <file> --title <title> --reason "<why>"\n`
  );
  return 0;
}

/**
 * The classification the add path checks a request against.
 *
 * @param env - The environment.
 * @param opts - Where to read the evidence from.
 */
export function evidence(
  env: Env,
  opts: { data?: string; fetch?: boolean; builds?: number; evidence?: string }
): { candidates: FlakyCandidate[]; label: string } {
  const cfg = env.files.config.quarantine;
  const from = addDays(dayOf(env.now), -(cfg.window_days - 1));
  // A saved `ci-steward flaky --json`, so an add does not re-download every
  // artifact the classification already read. Still the classifier's own
  // verdict: this reads its output, it never lets a caller assert one.
  if (opts.evidence) {
    const doc = JSON.parse(readFileSync(opts.evidence, 'utf8')) as {
      source?: string;
      candidates?: FlakyCandidate[];
    };
    return {
      candidates: doc.candidates ?? [],
      label: `${doc.source ?? opts.evidence} (via ci-steward flaky --json)`,
    };
  }
  if (opts.fetch) {
    const gh = env.gh(env.files.config.collect.api_budget);
    const s = fromGitHub(env, gh, from, opts.builds ?? 30);
    return {
      candidates: classifyFlaky(s.observations, s.builds, cfg),
      label: `ci-steward flaky --fetch, ${from}..${dayOf(env.now)}`,
    };
  }
  const span: string[] = [];
  for (let d = from; d <= dayOf(env.now); d = addDays(d, 1)) span.push(d);
  const dir = opts.data ?? snapshotsFromGit(env, span);
  try {
    const s = fromSnapshots(dir, span);
    return {
      candidates: classifyFlaky(s.observations, s.builds, cfg),
      label: `ci-steward flaky, ${from}..${dayOf(env.now)}`,
    };
  } finally {
    if (!opts.data) rmSync(dir, { recursive: true, force: true });
  }
}

/** Materialise the window's snapshots from the data branch into a temp directory. */
function snapshotsFromGit(env: Env, span: readonly string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-steward-snap-'));
  for (const d of span) {
    let text: string;
    try {
      text = env.git(env.root, [
        'show',
        `origin/${env.files.config.data_branch}:${snapshotPath(d)}`,
      ]);
    } catch {
      continue;
    }
    mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
    writeFileSync(path.join(dir, snapshotPath(d)), text);
  }
  return dir;
}
