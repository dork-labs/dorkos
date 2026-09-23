/**
 * The tenant isolation receipt (`specs/community-tenancy-contract/05-isolation-receipt.md`)
 * maps every adversarial-matrix row and every task 4.2 criterion to named tests.
 * This module decides whether each cited test really ran and passed, from the
 * report the test runner wrote, never from the test's source text:
 *
 * - `pg`: real PostgreSQL files, read from `vitest-pg-report.json` after `test:pg`.
 * - `browser`: Playwright specs, read from `browser-report.json` after `test:browser`.
 * - `unit`: ordinary unit files, run here with a JSON reporter and then read.
 *
 * A test inside `describe.skip`, behind a false condition, or commented out
 * never appears as passed in a report, so it cannot count as proof.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The runner whose report decides whether a cited test passed. */
export type ProofRunner = 'pg' | 'browser' | 'unit';

/** One cited test: a repo-relative file and the exact title written in it. */
export interface Proof {
  file: string;
  title: string;
}

/** One receipt section: a quoted requirement and the tests that prove it. */
export interface ReceiptEntry {
  id: string;
  requirement: string;
  proofs: Proof[];
}

/** One test outcome from a runner report, keyed by a path that ends in the repo-relative file. */
export interface ReportedTest {
  file: string;
  title: string;
  passed: boolean;
}

/** Repository root, three levels above this script. */
export const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const specDir = resolve(repoRoot, 'specs/community-tenancy-contract');

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Classify a cited file by the runner that executes it; files no runner executes are refused. */
export function runnerFor(file: string): ProofRunner {
  if (/^apps\/community\/src\/.+\.integration\.test\.ts$/.test(file)) return 'pg';
  if (/^apps\/community\/browser-tests\/.+\.spec\.ts$/.test(file)) return 'browser';
  if (
    /^apps\/(community|server)\/src\/.+\.test\.tsx?$/.test(file) &&
    !/\.(integration|s3)\.test\.tsx?$/.test(file)
  )
    return 'unit';
  throw new Error(`No receipt runner executes ${file}`);
}

/** The matrix bullets from the spec and the acceptance criteria of task 4.2, prefixed M/U. */
export function readRequirements(): string[] {
  const spec = readFileSync(resolve(specDir, '02-specification.md'), 'utf8');
  const section = /^## Adversarial verification matrix\n([\s\S]*?)(?=^## )/m.exec(spec);
  if (!section) throw new Error('The specification has no adversarial verification matrix');
  const matrix = section[1]
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => `M:${normalize(line.slice(2))}`);
  const tasks = JSON.parse(readFileSync(resolve(specDir, '03-tasks.json'), 'utf8')) as {
    tasks: { id: string; description: string }[];
  };
  const task = tasks.tasks.find((candidate) => candidate.id === '4.2');
  if (!task) throw new Error('Task 4.2 is missing from 03-tasks.json');
  const criteria = (task.description.split('Acceptance criteria:')[1] ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => `U:${normalize(line.slice(2))}`);
  return [...matrix, ...criteria];
}

/** Parse the receipt's `### M1` / `### U1` sections. */
export function readReceipt(
  text = readFileSync(resolve(specDir, '05-isolation-receipt.md'), 'utf8')
) {
  const entries: ReceiptEntry[] = [];
  let current: ReceiptEntry | undefined;
  for (const line of text.split('\n')) {
    const heading = /^### ([MU]\d+)$/.exec(line);
    if (heading) {
      current = { id: heading[1], requirement: '', proofs: [] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('> ')) current.requirement = normalize(line.slice(2));
    const proof = /^- `([^`]+)` — (.+)$/.exec(line);
    if (proof) current.proofs.push({ file: proof[1], title: proof[2].trim() });
  }
  return entries;
}

/** Match a cited title against reported titles; `${…}` in a cited template matches any text. */
export function titleMatches(cited: string, reported: string): boolean {
  const pattern = cited
    .split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  return new RegExp(`^${pattern}$`).test(reported);
}

/**
 * Require every cited proof for `runner` to appear in `reported` and to have
 * passed. A template title must match at least one reported test, and every
 * test it matches must have passed. Returns how many proofs were checked.
 */
export function assertProofsPassed(
  entries: ReceiptEntry[],
  runner: ProofRunner,
  reported: ReportedTest[]
): number {
  let checked = 0;
  for (const entry of entries) {
    for (const proof of entry.proofs) {
      if (runnerFor(proof.file) !== runner) continue;
      const matches = reported.filter((test) => {
        const reportedFile = test.file.replaceAll('\\', '/');
        return (
          (reportedFile === proof.file || reportedFile.endsWith(`/${proof.file}`)) &&
          titleMatches(proof.title, test.title)
        );
      });
      if (!matches.length)
        throw new Error(`${entry.id}: "${proof.title}" did not run in ${proof.file}`);
      if (matches.some((test) => !test.passed))
        throw new Error(`${entry.id}: "${proof.title}" did not pass in ${proof.file}`);
      checked += 1;
    }
  }
  return checked;
}

/** Flatten a Vitest JSON report; only `passed` counts. */
export function vitestResults(report: {
  testResults: { name: string; assertionResults: { title: string; status: string }[] }[];
}): ReportedTest[] {
  return report.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({
      file: file.name,
      title: test.title,
      passed: test.status === 'passed',
    }))
  );
}

interface PlaywrightSuite {
  file: string;
  specs: {
    title: string;
    file: string;
    tests: { status: string; results: { status: string }[] }[];
  }[];
  suites?: PlaywrightSuite[];
}

/** Flatten a Playwright JSON report; a spec passes only if every run of it passed as expected. */
export function playwrightResults(report: { suites: PlaywrightSuite[] }): ReportedTest[] {
  const results: ReportedTest[] = [];
  const visit = (suites: PlaywrightSuite[]) => {
    for (const suite of suites) {
      for (const spec of suite.specs) {
        results.push({
          file: `apps/community/browser-tests/${spec.file}`,
          title: spec.title,
          passed:
            spec.tests.length > 0 &&
            spec.tests.every(
              (test) =>
                test.status === 'expected' &&
                test.results.length > 0 &&
                test.results.every((result) => result.status === 'passed')
            ),
        });
      }
      visit(suite.suites ?? []);
    }
  };
  visit(report.suites);
  return results;
}

/** Run the cited unit files once per package with a JSON reporter and return what ran. */
function runUnitProofs(entries: ReceiptEntry[]): ReportedTest[] {
  const byPackage = new Map<string, Set<string>>();
  for (const proof of entries.flatMap((entry) => entry.proofs)) {
    if (runnerFor(proof.file) !== 'unit') continue;
    const [, app, ...rest] = proof.file.split('/');
    const files = byPackage.get(app) ?? new Set<string>();
    files.add(rest.join('/'));
    byPackage.set(app, files);
  }
  const results: ReportedTest[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'tenancy-receipt-'));
  try {
    for (const [app, files] of byPackage) {
      const output = join(directory, `${app}.json`);
      spawnSync(
        'pnpm',
        ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${output}`, ...files],
        { cwd: resolve(repoRoot, 'apps', app), stdio: 'inherit', env: process.env }
      );
      // A failing run still writes its report; the assertion below names the failure.
      results.push(...vitestResults(JSON.parse(readFileSync(output, 'utf8'))));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return results;
}

function main(modes: string[]) {
  const entries = readReceipt();
  for (const mode of modes) {
    let checked: number;
    if (mode === 'pg') {
      const report = JSON.parse(
        readFileSync(new URL('../vitest-pg-report.json', import.meta.url), 'utf8')
      );
      checked = assertProofsPassed(entries, 'pg', vitestResults(report));
    } else if (mode === 'browser') {
      const report = JSON.parse(
        readFileSync(new URL('../browser-report.json', import.meta.url), 'utf8')
      );
      checked = assertProofsPassed(entries, 'browser', playwrightResults(report));
    } else if (mode === 'unit') {
      checked = assertProofsPassed(entries, 'unit', runUnitProofs(entries));
    } else {
      throw new Error(`Unknown receipt mode: ${mode}`);
    }
    process.stdout.write(`tenancy-receipt: ${checked} ${mode} proofs ran and passed.\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
