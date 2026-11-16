#!/usr/bin/env node
/**
 * Prove that test.yml's `test-binary` job ran every real-CLI suite it owns
 * (DOR-4190, ledger 261115-203006).
 *
 * WHY. The `*.binary.test.ts` suites spawn a real CLI (the SDK-bundled
 * `claude`, the pinned `opencode`) and `describe.skipIf(BINARY === null)` when
 * it is missing, so a broken install reads as a green, fully skipped file. In
 * the shards that was invisible; they now run in their own job, and this is
 * what that job must prove before its green means anything: the codex-sandbox
 * job's receipt check, generalised to a list read from the tree.
 *
 * It reads the list of repo-relative files the job planned to run, and each
 * owning package's `vitest-shard-report.json` (vitest's json reporter, written
 * in the package directory by `turbo test`), and fails unless:
 *   - the list is not empty;
 *   - the files collected are EXACTLY the planned ones (a missing file, or a
 *     filter that collected something else, both fail);
 *   - every file has at least one test, and no test was skipped, pending or
 *     todo. A failed test is not judged here: the sweep step fails a pull
 *     request on it, and the quarantine gate judges it everywhere else.
 * Then it writes the collected files, one per line, for the fan-in's union
 * check (`shard-files-binary.txt`).
 *
 * Usage: node scripts/assert-binary-suites-ran.mjs <planned-files.txt> <out.txt>
 * Paths in the reports are resolved against the current directory, which is
 * the repo root in the workflow and a temp dir in the fixture tests
 * (scripts/__tests__/binary-lane-job.test.ts).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [plannedPath, outPath] = process.argv.slice(2);

/** @param {string} message */
function fail(message) {
  process.stderr.write(`assert-binary-suites-ran: ${message}\n`);
  process.exit(1);
}

if (!plannedPath || !outPath) {
  fail('usage: assert-binary-suites-ran.mjs <planned-files.txt> <out.txt>');
}
if (!existsSync(plannedPath)) fail(`no planned-files list at ${plannedPath}.`);

const planned = readFileSync(plannedPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
if (planned.length === 0) {
  fail(
    'the planned list is empty. The job only reaches this step when it planned to run something.'
  );
}

const root = process.cwd();
const packages = [...new Set(planned.map((file) => file.split('/').slice(0, 2).join('/')))];

/** @type {Map<string, Array<{ status?: string; title?: string }>>} */
const collected = new Map();
for (const pkg of packages) {
  const reportPath = path.join(root, pkg, 'vitest-shard-report.json');
  if (!existsSync(reportPath)) {
    fail(
      `${pkg} wrote no vitest-shard-report.json — the json reporter passthrough is broken, or its suite never started.`
    );
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    fail(
      `${reportPath} is not readable JSON (${String(error)}); refusing to certify what it says.`
    );
  }
  if (!Array.isArray(report?.testResults)) fail(`${reportPath} has no testResults array.`);
  for (const suite of report.testResults) {
    const rel = path.relative(root, String(suite.name)).split(path.sep).join('/');
    collected.set(rel, Array.isArray(suite.assertionResults) ? suite.assertionResults : []);
  }
}

const problems = [];
for (const file of planned) {
  const tests = collected.get(file);
  if (tests === undefined) {
    problems.push(`${file}: never collected`);
    continue;
  }
  if (tests.length === 0) {
    problems.push(`${file}: collected with no tests`);
    continue;
  }
  const notRun = tests.filter((test) => test.status !== 'passed' && test.status !== 'failed');
  if (notRun.length > 0) {
    problems.push(
      `${file}: ${notRun.length} of ${tests.length} test(s) did not run (${[
        ...new Set(notRun.map((test) => test.status)),
      ].join(', ')}). A missing binary skips the whole file.`
    );
  }
}
const plannedSet = new Set(planned);
for (const file of collected.keys()) {
  if (!plannedSet.has(file)) problems.push(`${file}: collected but not planned`);
}

if (problems.length > 0) {
  fail(
    `the binary suites did not all run as planned:\n${problems
      .map((line) => `  ${line}`)
      .join(
        '\n'
      )}\nEvery planned *.binary.test.ts must run here with no skipped test; the shards no longer run them.`
  );
}

const files = [...collected.keys()].sort();
writeFileSync(outPath, `${files.join('\n')}\n`);
const testCount = [...collected.values()].reduce((sum, tests) => sum + tests.length, 0);
process.stdout.write(
  `assert-binary-suites-ran: all ${files.length} planned binary suite(s) ran, ${testCount} test(s), none skipped.\n`
);
