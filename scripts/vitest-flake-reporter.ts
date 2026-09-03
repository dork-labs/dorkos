/**
 * A Vitest reporter that NAMES every test which only passed because it was
 * retried.
 *
 * WHY THIS EXISTS. A retry budget is the cheapest way to keep a contended
 * runner honest and the easiest way to hide a real intermittent failure: the
 * second attempt passes, the suite goes green, and nobody ever learns which
 * test flaked. The browser suite solved this a year of lessons ago — Playwright
 * marks a retried pass `flaky` in its JSON report, and
 * `scripts/assert-browser-tests-executed.sh` prints every one of them and
 * raises a `::warning` annotation, so an absorbed retry costs visibility rather
 * than nothing. The vitest side had no equivalent, and it could not simply copy
 * the browser one: vitest's built-in `json` reporter carries no retry
 * information at all (its `assertionResults` entries are
 * `{status, title, duration, failureMessages, location, meta, tags}` and
 * nothing else), so a retried pass and a first-attempt pass are byte-identical
 * in the artifact the merge-queue leg already collects. Reading the retry count
 * requires a reporter, which is this file.
 *
 * WHAT IT DOES. Nothing that can change a verdict. It records the tests whose
 * final state is `passed` with a non-zero retry count, prints them, and writes
 * them to `vitest-flake-report.json` in the package's own working directory for
 * `.github/workflows/test.yml` to turn into annotations and a job summary. A
 * test that still fails after its retries is not in this list and stays red on
 * its own; a run with no retried passes writes an empty list, which is what
 * lets the workflow tell "clean run" apart from "reporter never loaded".
 *
 * WHERE IT RUNS. The merge-queue leg of `test.yml` only, passed as
 * `--reporter=../../scripts/vitest-flake-reporter.ts` — every package that
 * declares a `test` script lives exactly two directories deep, so one relative
 * path resolves from all of them. It deliberately does NOT ride the lefthook
 * pre-push gate: that gate's passthrough is pinned to exactly `-- --run`
 * because turbo hashes passthrough args into the task cache key, and any extra
 * flag there would force a full re-run of every suite on every push (see the
 * CACHE-KEY CONSTRAINT comment in `lefthook.yml`). The queue leg already
 * carries `--shard` and the json reporter, so it has already forked that key
 * and pays nothing more for this.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Reporter, TestCase } from 'vitest/node';

/**
 * The per-package artifact this reporter writes, relative to the working
 * directory of the `vitest` process (which under turbo is the package root).
 */
export const FLAKE_REPORT_FILENAME = 'vitest-flake-report.json';

/** One test that failed at least once and then passed on a retry. */
export interface FlakyTestRecord {
  /** Test file, relative to the package root the run started in. */
  file: string;
  /** Full test name, parent suites included. */
  test: string;
  /** How many retries the pass cost. */
  retries: number;
}

/** The whole artifact: the package's directory plus everything it absorbed. */
export interface FlakeReport {
  /** Absolute path of the directory vitest ran in — names the package. */
  cwd: string;
  /** Every retried pass in this run; empty on a clean run, never absent. */
  flaky: FlakyTestRecord[];
}

/**
 * Collects retried passes and reports them without touching the run's verdict.
 *
 * Registered by path rather than by name, so this class is the module's default
 * export — vitest refuses a custom reporter module that has none.
 */
export default class VitestFlakeReporter implements Reporter {
  #flaky: FlakyTestRecord[] = [];

  /**
   * Record a test whose final state is a pass that cost at least one retry.
   *
   * `diagnostic().flaky` is vitest's own name for exactly that condition
   * (`retryCount > 0 && state === 'pass'`); it is read rather than recomputed
   * so this stays true to the runner's definition. Diagnostics are only
   * available once a test has finished, and this hook fires once per test with
   * its final result, not once per attempt.
   */
  onTestCaseResult(testCase: TestCase): void {
    const diagnostic = testCase.diagnostic();
    if (!diagnostic?.flaky) return;

    this.#flaky.push({
      file: path.relative(process.cwd(), testCase.module.moduleId),
      test: testCase.fullName,
      retries: diagnostic.retryCount,
    });
  }

  /**
   * Write the artifact and name every retried pass in the run's own log.
   *
   * The artifact is written even when nothing flaked. An absent file means the
   * reporter never loaded — a broken passthrough — and the workflow step that
   * reads these treats the two differently, which it can only do if a clean run
   * still leaves a file behind.
   */
  onTestRunEnd(): void {
    const report: FlakeReport = { cwd: process.cwd(), flaky: this.#flaky };
    writeFileSync(
      path.join(process.cwd(), FLAKE_REPORT_FILENAME),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8'
    );

    if (this.#flaky.length === 0) return;

    // Printed as well as written: the artifact feeds the workflow's annotation
    // step, but a person reading the failing shard's log should not have to
    // download anything to see which test was absorbed.
    console.log(
      `vitest-flake-reporter: WARNING — ${this.#flaky.length} test(s) only passed on a retry:`
    );
    for (const record of this.#flaky) {
      console.log(`  ${record.file} › ${record.test} (${record.retries} retry)`);
    }
  }
}
