/**
 * Reading test reports, and classifying a test as flaky FROM THE DATA.
 *
 * Two jobs live here because they read the same files:
 *
 *  - the parsers that turn a Playwright `results.json`, a vitest
 *    `vitest-shard-report.json` and a `vitest-flake-report.json` into one flat
 *    shape (`ReportedTest`), used by the quarantine gate and by the collector;
 *  - the classifier that decides, from a window of queue builds, which tests
 *    are flaky enough to be quarantined.
 *
 * WHAT COUNTS AS EVIDENCE. One occurrence is one merge-group SHA on which the
 * test failed and then passed — Playwright's `flaky` status and vitest's
 * `diagnostic().flaky`, both of which mean "the same tree, twice, two answers".
 * Occurrences are counted per distinct SHA, never per shard or per report, so
 * three shards of one build can never look like three pieces of evidence.
 *
 * WHY THERE IS A `cooling` STATE. A test that flaked in almost every build and
 * has now been quiet for several builds was probably FIXED, and quarantining it
 * spends a slot on nothing while hiding whatever it does next. So a candidate
 * whose clean builds since its last flake exceed its OWN average gap between
 * flakes (`builds_sampled / occurrences`) is `cooling`, and the add path
 * refuses it. The rule is rate-aware on purpose: two clean builds after a
 * 26-of-27 flake means something changed, while two clean builds after a
 * 2-of-27 flake is Tuesday.
 *
 * HOW OFTEN IT IS WRONG, stated plainly because the number is not small. For a
 * test that flakes independently at rate p, the chance of being quiet for its
 * own mean gap (1/p builds) is about (1-p)^(1/p), which is close to e⁻¹ — so
 * roughly ONE IN THREE genuinely flaky tests is called `cooling` on any given
 * run of this command, across the whole realistic rate range. That is accepted
 * rather than tuned away for two reasons: the cost of a false `cooling` is a
 * day (run `ci-steward flaky` again the next time it flakes and it qualifies),
 * while the cost of a false `qualifies` is a quarantine slot spent watching a
 * test somebody already fixed; and the alternative — lowering
 * `cooling_min_clean_builds` — trades this for the much worse error. If the
 * refusals become annoying, the lever is `min_occurrences` (more evidence per
 * entry) or a recency requirement (a flake within the last N builds), not the
 * floor.
 *
 * IDENTITY IS BYTE-FOR-BYTE. `file` and `title` are compared as the runner
 * spells them, with no Unicode normalisation, so a title whose report and whose
 * lane entry differ only by normal form will not match. That fails SAFE — the
 * entry excuses nothing and the fan-in's union check names it as a quarantined
 * test that did not run — but it is why both `ci-steward flaky` and the skill
 * tell you to COPY the file and title rather than retype them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { QuarantineConfig } from './schemas.ts';
import { testId, type ReportedTest, type Runner } from './quarantine.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every file under a path: the file itself, or a directory walked recursively.
 * An absent path has none, so a caller may name a report that a partial run
 * never wrote without special-casing it.
 *
 * @param target - A file or directory.
 */
export function walk(target: string): string[] {
  if (!existsSync(target)) return [];
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target).flatMap((n) => walk(path.join(target, n)));
}

/** Playwright's per-test statuses, mapped onto the gate's four outcomes. */
function playwrightOutcome(status: unknown): ReportedTest['outcome'] {
  switch (status) {
    case 'unexpected':
      return 'failed';
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return 'skipped';
    default:
      return 'passed';
  }
}

/**
 * Every test in one Playwright JSON report.
 *
 * `file` is what the report carries — relative to Playwright's rootDir, which
 * for this repo is `apps/e2e/tests` — and `title` is the spec's own title, so
 * an id here reads exactly as `assert-browser-tests-executed.sh` prints it.
 *
 * @param doc - The parsed report.
 */
export function readPlaywrightReport(doc: unknown): ReportedTest[] {
  const out: ReportedTest[] = [];
  const visit = (suite: unknown): void => {
    if (!isObj(suite)) return;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isObj(spec) || typeof spec.file !== 'string' || typeof spec.title !== 'string') continue;
      for (const t of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isObj(t)) continue;
        out.push({
          runner: 'playwright',
          file: spec.file,
          title: spec.title,
          outcome: playwrightOutcome(t.status),
        });
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) visit(child);
  };
  if (isObj(doc)) for (const s of Array.isArray(doc.suites) ? doc.suites : []) visit(s);
  return out;
}

/**
 * The package prefix a vitest report belongs to, as `<area>/<name>`.
 *
 * Reports are read both on the runner (absolute paths under the workspace) and
 * from downloaded artifacts (absolute paths from a different machine), so the
 * last two segments of the package directory are the only portable handle —
 * the same one `.github/workflows/test.yml` already uses in its jq.
 *
 * @param cwd - The directory vitest ran in.
 */
function packagePrefix(cwd: string): string {
  return cwd.split('/').filter(Boolean).slice(-2).join('/');
}

/**
 * Every test in one vitest JSON report (`--reporter=json`).
 *
 * @param doc - The parsed report.
 * @param repoRoot - The repo root, when the report's absolute paths are from
 *   this machine; otherwise the last two segments of each file's package
 *   directory are used, which is what a downloaded artifact allows.
 */
export function readVitestReport(doc: unknown, repoRoot?: string): ReportedTest[] {
  if (!isObj(doc) || !Array.isArray(doc.testResults)) return [];
  const out: ReportedTest[] = [];
  for (const tr of doc.testResults) {
    if (!isObj(tr) || typeof tr.name !== 'string') continue;
    const file =
      repoRoot && tr.name.startsWith(`${repoRoot}/`)
        ? tr.name.slice(repoRoot.length + 1)
        : tr.name.replace(/^.*?((?:apps|packages)\/)/, '$1');
    for (const a of Array.isArray(tr.assertionResults) ? tr.assertionResults : []) {
      if (!isObj(a) || typeof a.fullName !== 'string') continue;
      out.push({
        runner: 'vitest',
        file,
        title: a.fullName,
        outcome: a.status === 'failed' ? 'failed' : a.status === 'passed' ? 'passed' : 'skipped',
      });
    }
  }
  return out;
}

/**
 * The retried passes in one `vitest-flake-report.json`.
 *
 * vitest's own json reporter carries no retry information, so this file — the
 * one `scripts/vitest-flake-reporter.ts` writes — is the only place a vitest
 * flake is nameable at all.
 *
 * @param doc - The parsed flake report.
 */
export function readVitestFlakeReport(doc: unknown): ReportedTest[] {
  if (!isObj(doc) || typeof doc.cwd !== 'string' || !Array.isArray(doc.flaky)) return [];
  const prefix = packagePrefix(doc.cwd);
  return doc.flaky.flatMap((f) =>
    isObj(f) && typeof f.file === 'string' && typeof f.test === 'string'
      ? [
          {
            runner: 'vitest' as const,
            file: `${prefix}/${f.file}`,
            title: f.test,
            outcome: 'flaky' as const,
          },
        ]
      : []
  );
}

/**
 * Read every report of one format under a path, whatever the layout.
 *
 * `tally` is the runner's OWN count of failed TESTS, read from its summary block
 * (`stats.unexpected`, `numFailedTests`) rather than from the per-test walk.
 * Two numbers out of one report, from two places in it, is what lets the gate
 * refuse a report that disagrees with itself instead of trusting whichever half
 * it happened to read.
 *
 * `unattributed` is the count of failures the runner reports that belong to NO
 * test, and it exists because a tally of tests cannot see them. A test file
 * that throws on import — a bad import, a missing export, a top-level throw —
 * fails to COLLECT, so it never becomes a failed test. Without this, a whole
 * unloadable file rides through any run where one quarantined test happened to
 * fail, because the tally and the walk agree on the one test and nothing looks
 * at the file that never loaded.
 *
 * It is counted as a file that FAILED WITH NO FAILED TEST INSIDE IT, which is
 * exactly that shape. The obvious reading, vitest's `numFailedTestSuites`, is
 * wrong: it counts every file containing any failure, so an ordinary file with
 * one failing test scores 1 and every vitest quarantine would be inert —
 * absorbing the failure and then redding the shard anyway, blaming a file that
 * loaded perfectly. Playwright's equivalent is its top-level `errors[]`, which
 * really does hold only failures with no test behind them.
 *
 * @param dir - A directory to walk, or a single report file.
 * @param format - Which runner's reports to read.
 * @param repoRoot - Makes vitest paths repo-relative when the report is from
 *   this machine.
 */
export function readReportsIn(
  dir: string,
  format: Runner,
  repoRoot?: string
): { tests: ReportedTest[]; files: number; tally: number; unattributed: number } {
  const tests: ReportedTest[] = [];
  let files = 0;
  let tally = 0;
  let unattributed = 0;
  for (const f of walk(dir)) {
    if (!f.endsWith('.json')) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    const base = path.basename(f);
    if (format === 'playwright' && isObj(doc) && isObj(doc.stats)) {
      tests.push(...readPlaywrightReport(doc));
      tally += Number(doc.stats.unexpected ?? 0);
      // Global failures with no test behind them: a config error, a worker
      // crash, a file that would not load.
      unattributed += Array.isArray(doc.errors) ? doc.errors.length : 0;
      files += 1;
    } else if (format === 'vitest' && base === 'vitest-shard-report.json') {
      tests.push(...readVitestReport(doc, repoRoot));
      const failedTests = isObj(doc) ? Number(doc.numFailedTests ?? 0) : 0;
      tally += failedTests;
      // A file that FAILED with no failed test inside it — that is the exact
      // shape of one that never loaded. NOT `numFailedTestSuites`, which counts
      // every file containing any failure at all: an ordinary file with one
      // failing test scores 1 there, so counting it would make every vitest
      // quarantine inert and blame a file that loaded perfectly.
      const orphanFiles = (
        isObj(doc) && Array.isArray(doc.testResults) ? doc.testResults : []
      ).filter(
        (t) =>
          isObj(t) &&
          t.status === 'failed' &&
          !(Array.isArray(t.assertionResults) ? t.assertionResults : []).some(
            (a) => isObj(a) && a.status === 'failed'
          )
      ).length;
      unattributed += orphanFiles;
      // Last resort: vitest said the run failed and counted nothing. Whatever
      // that is, it is not a quarantined test, so it must not be excusable.
      if (isObj(doc) && doc.success === false && failedTests === 0 && orphanFiles === 0) {
        unattributed += 1;
      }
      files += 1;
    } else if (format === 'vitest' && base === 'vitest-flake-report.json') {
      // Retried passes only: they carry no failures, so they add nothing to the
      // tally. They are read for `recovered`, which names a test worth releasing.
      tests.push(...readVitestFlakeReport(doc));
      files += 1;
    }
  }
  return { tests, files, tally, unattributed };
}

/** One test seen flaking on one queue build. */
export interface FlakyObservation {
  runner: Runner;
  file: string;
  title: string;
  /** The merge-group build's head SHA, short. */
  sha: string;
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
}

/** How a candidate stands against the thresholds. */
export type FlakyStatus = 'qualifies' | 'cooling' | 'below-threshold';

/** One candidate, with everything the add path needs to refuse or record it. */
export interface FlakyCandidate {
  id: string;
  runner: Runner;
  file: string;
  title: string;
  occurrences: number;
  /** Queue builds of THIS runner whose reports were read in the window. */
  builds_sampled: number;
  shas: string[];
  first_day: string;
  last_day: string;
  /** Queue builds newer than the last occurrence, among those sampled. */
  clean_builds_since: number;
  status: FlakyStatus;
  /** One sentence saying why it is not `qualifies`, when it is not. */
  why?: string;
}

/** One queue build whose reports were read, for one runner. */
export interface SampledBuild {
  sha: string;
  day: string;
  runner: Runner;
}

/**
 * Rank every test that flaked in a window and say which qualify.
 *
 * Rates and clean runs are computed against the builds of the test's OWN
 * runner. The two suites sample different builds, so counting vitest's builds
 * against a browser test's flake would make every quiet browser test look
 * fixed the moment vitest ran.
 *
 * @param observations - Every flake seen in the window.
 * @param builds - Every queue build sampled in the window, oldest first; a
 *   candidate's clean run is measured against this order.
 * @param cfg - The thresholds.
 */
export function classifyFlaky(
  observations: readonly FlakyObservation[],
  builds: readonly SampledBuild[],
  cfg: QuarantineConfig
): FlakyCandidate[] {
  const orderFor = new Map<Runner, Map<string, number>>();
  const countFor = new Map<Runner, number>();
  for (const r of ['playwright', 'vitest'] as const) {
    const mine = builds.filter((b) => b.runner === r);
    orderFor.set(r, new Map(mine.map((b, i) => [b.sha, i])));
    countFor.set(r, mine.length);
  }
  const byTest = new Map<string, FlakyObservation[]>();
  for (const o of observations) {
    const id = testId(o);
    const list = byTest.get(id);
    if (list) list.push(o);
    else byTest.set(id, [o]);
  }
  const out: FlakyCandidate[] = [];
  for (const [id, obs] of byTest) {
    const runner = obs[0]!.runner;
    const order = orderFor.get(runner)!;
    const total = countFor.get(runner) ?? 0;
    const shas = [...new Set(obs.map((o) => o.sha))];
    const days = [...new Set(obs.map((o) => o.day))].sort();
    const occurrences = shas.length;
    const lastIndex = Math.max(-1, ...shas.map((s) => order.get(s) ?? -1));
    const clean = lastIndex < 0 ? 0 : total - 1 - lastIndex;
    // A candidate's own average gap between flakes, in builds. Quiet for longer
    // than that (and for more than the floor) means the behaviour changed.
    const gap = total > 0 && occurrences > 0 ? total / occurrences : Infinity;
    let status: FlakyStatus = 'qualifies';
    let why: string | undefined;
    if (occurrences < cfg.min_occurrences) {
      status = 'below-threshold';
      why = `${occurrences} flaky build(s) of ${total} in the window; ${cfg.min_occurrences} are needed. One bad runner is not a classification.`;
    } else if (clean >= Math.max(cfg.cooling_min_clean_builds, Math.ceil(gap))) {
      status = 'cooling';
      why = `clean for the last ${clean} queue build(s), which is longer than its own average gap between flakes (${gap.toFixed(1)} builds). It looks FIXED; quarantining it would spend a slot on nothing. Re-run this when it flakes again.`;
    }
    out.push({
      id,
      runner,
      file: obs[0]!.file,
      title: obs[0]!.title,
      occurrences,
      builds_sampled: total,
      shas,
      first_day: days[0]!,
      last_day: days.at(-1)!,
      clean_builds_since: clean,
      status,
      why,
    });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences || a.id.localeCompare(b.id));
}
