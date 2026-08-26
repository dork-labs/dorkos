import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';

interface TestEntry {
  specFile: string;
  feature: string;
  description: string;
  lastRun: string;
  lastStatus: string;
  runCount: number;
  passCount: number;
  failCount: number;
  relatedCode: string[];
  explorationNotes?: string[];
  lastModified: string;
}

interface Manifest {
  version: number;
  tests: Record<string, TestEntry>;
  runHistory: Array<{
    id: string;
    timestamp: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  }>;
}

interface TestCaseResult {
  title: string;
  status: string;
  file: string;
  feature: string;
  duration: number;
}

/**
 * The env var that opts a run into refreshing existing manifest
 * descriptions. See {@link isFullSuiteRun} for why an opt-in, rather than
 * config inspection alone, is the primary gate.
 */
export const REFRESH_MANIFEST_ENV_VAR = 'E2E_REFRESH_MANIFEST';

/**
 * Whether `FullConfig` looks unfiltered — no `--grep`/`--grep-invert`,
 * no `--shard`, and no project carries a standing `grep`/`grepInvert` of
 * its own.
 *
 * This is necessary but **not sufficient** for "this run saw every test in
 * every file it touched" (see {@link REFRESH_MANIFEST_ENV_VAR}), because
 * `onBegin`'s `Suite` already reflects all of that filtering (Playwright
 * applies it before handing the suite to a reporter), so a reporter can
 * never recover "every test declared in this file" from the suite tree
 * alone — only "every test this invocation kept." `FullConfig` is the one
 * place some of those filters are still visible as such: `grep` defaults to
 * the literal match-everything regex Playwright compiles in when `-g` is
 * never passed (`defaultGrep` in `playwright/lib/common/index.js`), so
 * anything else means `-g`/`--grep` narrowed the run; `grepInvert` is `null`
 * unless `--grep-invert` was used; and `shard` is `null` unless `--shard`
 * split the suite across workers — which, per `--shard`'s own docs, divides
 * by test count rather than by file, so a single spec file's tests can land
 * on either side of a shard boundary (confirmed against this repo's own
 * `browser-test.yml`, which shards `apps/e2e` in CI for exactly this
 * reason). `config.projects[].grep`/`grepInvert` catch the filter this
 * repo's own `playwright.config.ts` applies at the PROJECT level rather
 * than the top one — the default `chromium` project sets
 * `grepInvert: /@integration/` unless `INCLUDE_INTEGRATION` is set, which
 * never touches `config.grep`/`config.grepInvert` at all, so checking only
 * those two would have called an ordinary local run "full" while it was
 * silently skipping every `@integration` test.
 *
 * What this still cannot see: `.only`, `--last-failed`, `--only-changed`,
 * and selecting a single test by `file.spec.ts:LINE` — none of those are
 * exposed on `FullConfig`. This is why {@link REFRESH_MANIFEST_ENV_VAR} is
 * the primary gate and this function is only the secondary, defense-in-depth
 * AND-condition: a run must explicitly opt in AND look unfiltered by every
 * signal this function CAN see. Anything not opted in fails closed.
 *
 * @param config - The resolved config `onBegin` receives.
 * @returns `true` when nothing filtered which tests would run, as far as `FullConfig` can tell.
 */
export function isFullSuiteRun(
  config: Pick<FullConfig, 'grep' | 'grepInvert' | 'shard' | 'projects'>
): boolean {
  const isDefaultGrep = (grep: RegExp | RegExp[]): boolean =>
    (Array.isArray(grep) ? grep : [grep]).every(
      (pattern) => pattern.source === '.*' && pattern.flags === ''
    );

  if (!isDefaultGrep(config.grep) || config.grepInvert !== null || config.shard !== null) {
    return false;
  }
  return config.projects.every(
    (project) => isDefaultGrep(project.grep) && project.grepInvert === null
  );
}

/**
 * Playwright reporter that keeps `apps/e2e/manifest.json` — the test
 * registry AI commands like `/browsertest:maintain` read for health
 * dashboards and stale-test detection — in sync with the actual suite.
 */
class ManifestReporter implements Reporter {
  private manifestPath: string;
  private manifest: Manifest;
  private runResults: TestCaseResult[] = [];
  private startTime = Date.now();
  /**
   * Whether this run is allowed to refresh existing `description`s: the
   * operator opted in via {@link REFRESH_MANIFEST_ENV_VAR} AND `FullConfig`
   * looks unfiltered ({@link isFullSuiteRun}). Set from `onBegin`. Defaults
   * to `false` so that a reporter driven directly — outside a real
   * Playwright run, where `onBegin` is guaranteed to fire before `onEnd` —
   * fails toward leaving descriptions alone rather than toward overwriting
   * them.
   */
  private canRefreshDescriptions = false;

  constructor(options: { manifestPath?: string } = {}) {
    this.manifestPath =
      options.manifestPath ?? path.resolve(import.meta.dirname, '..', 'manifest.json');
    this.manifest = this.loadManifest();
  }

  private loadManifest(): Manifest {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
    } catch {
      return { version: 1, tests: {}, runHistory: [] };
    }
  }

  onBegin(config: FullConfig) {
    // eslint-disable-next-line no-restricted-syntax -- apps/e2e has no env.ts (see playwright.config.ts's own disable); this reads the opt-in the reporter's own docs and this repo's scripts/workflow set.
    const optedIn = process.env[REFRESH_MANIFEST_ENV_VAR] === '1';
    this.canRefreshDescriptions = optedIn && isFullSuiteRun(config);
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const testsDir = path.resolve(import.meta.dirname, '..', 'tests');
    const relativeFile = path.relative(testsDir, test.location.file);
    const feature = relativeFile.split(path.sep)[0] || 'unknown';

    this.runResults.push({
      title: test.title,
      status: result.status,
      file: relativeFile,
      feature,
      duration: result.duration,
    });
  }

  onEnd(_result: FullResult) {
    // Nothing ran, so there is nothing to record. Playwright builds custom
    // reporters for `--list` too, and calls `onEnd` there without ever calling
    // `onTestEnd` — so without this guard, merely listing the suite rewrites
    // this tracked file and dirties the repo. A `-g` that matches no test takes
    // the same path, and for the same reason should leave the manifest alone.
    if (this.runResults.length === 0) return;

    const now = new Date();
    const runId = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Aggregate results per spec file (not per test case)
    const byFile = new Map<string, TestCaseResult[]>();
    for (const r of this.runResults) {
      const group = byFile.get(r.file) ?? [];
      group.push(r);
      byFile.set(r.file, group);
    }

    for (const [file, results] of byFile) {
      // Both suffixes, because not every file that declares tests is a spec
      // file: `tests/chat/session-read-state.ts` is a module the mock spec
      // registers its tests from (see its header), and Playwright reports them
      // against the file that DECLARED them. Stripping only `.spec.ts` left that
      // one keyed `session-read-state.ts` — an extension in a namespace where
      // nothing else has one.
      const testKey = path.basename(file).replace(/(\.spec)?\.ts$/, '');
      const allPassed = results.every((r) => r.status === 'passed');
      const anyFailed = results.some((r) => r.status === 'failed');

      const isNewEntry = !this.manifest.tests[testKey];
      const entry: TestEntry = this.manifest.tests[testKey] ?? {
        specFile: `tests/${file}`,
        feature: results[0].feature,
        description: '',
        lastRun: '',
        lastStatus: '',
        runCount: 0,
        passCount: 0,
        failCount: 0,
        relatedCode: [],
        lastModified: '',
      };

      // specFile/feature are per-file facts, true of any run that saw the
      // file at all — a moved spec needs no full-suite gate to be reported
      // at its current location. Left stale, they misdirect
      // `/browsertest:maintain`'s existence check: it globs the STORED
      // specFile, and a spec that moved directories would fail that glob
      // and get classified Orphaned — offering to DELETE the still-live test
      // (DOR-1555 follow-up).
      entry.specFile = `tests/${file}`;
      entry.feature = results[0].feature;

      // A rename only reaches the description on a run that actually saw the
      // whole file — a `-g`/`--shard` subset run can only see some of a
      // file's titles, and refreshing from that would collapse the
      // description to just the tests this invocation happened to touch
      // (DOR-1555). A brand-new entry has no stale description to protect,
      // so it is always safe to seed from whatever titles this run saw.
      //
      // Deduped: `--repeat-each=N` (this package's own STABILIZE step and
      // GOTCHAS.md's standard stability loop) reports one onTestEnd per
      // ATTEMPT with the same title repeated N times, and touches none of
      // grep/grepInvert/shard/projects — so an un-deduped join would turn
      // "renders the app shell" into "renders the app shell, renders the
      // app shell, renders the app shell" on every stabilization run.
      const titlesThisRun = [...new Set(results.map((r) => r.title))].join(', ');
      if (isNewEntry || this.canRefreshDescriptions) {
        entry.description = titlesThisRun;
      }

      entry.lastRun = now.toISOString();
      entry.lastStatus = allPassed ? 'passed' : anyFailed ? 'failed' : 'mixed';
      entry.runCount++;
      if (allPassed) entry.passCount++;
      if (anyFailed) entry.failCount++;
      this.manifest.tests[testKey] = entry;
    }

    this.manifest.runHistory.push({
      id: runId,
      timestamp: now.toISOString(),
      total: this.runResults.length,
      passed: this.runResults.filter((r) => r.status === 'passed').length,
      failed: this.runResults.filter((r) => r.status === 'failed').length,
      skipped: this.runResults.filter((r) => r.status === 'skipped').length,
      duration: Date.now() - this.startTime,
    });
    if (this.manifest.runHistory.length > 100) {
      this.manifest.runHistory = this.manifest.runHistory.slice(-100);
    }

    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }
}

export default ManifestReporter;
