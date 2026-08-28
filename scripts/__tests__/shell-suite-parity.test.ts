/**
 * Drift guard for the two lists that decide which shell fixture suites run.
 *
 * The suites under `scripts/` belong to no pnpm workspace, so turbo's
 * affected-only run cannot reach them and each one has to be named by hand in
 * two unrelated files: `test:scripts` in the root `package.json` (what
 * `pnpm verify` runs before you push) and the step list in
 * `.github/workflows/scripts-test.yml` (what CI runs on the PR). Nothing
 * connected the two, so they drifted — which is the whole of DOR-1515.
 *
 * The concrete drift found on 2026-08-24: the workflow ran ELEVEN suites and
 * `test:scripts` ran TEN. Missing locally was `test-process-guard.sh`, the
 * fixture suite for the hook enforcing AGENTS.md Hard Rule 7 (`pkill`/`killall`
 * refusal) — added to the workflow when the hook landed, never added to
 * `test:scripts`. So the safety control whose entire job is to stop one agent
 * killing another agent's dev server had no local gate at all: `pnpm verify`
 * came back green having never executed it, and the first anyone would learn of
 * a broken matcher was a red check on the PR.
 *
 * That gap is worth a line of package.json. The MECHANISM that produced it is
 * worth this file: add a twelfth suite to one side only and the same hole opens
 * again, silently, and nobody finds out until the next red-in-CI-green-locally
 * surprise.
 *
 * Same shape of guard as `vitest-projects.test.ts` beside it, for the same
 * reason: two places must agree, agreement is invisible from either place
 * alone, and forgetting is a mistake nobody makes on purpose — so it has to
 * fail here rather than be remembered.
 *
 * WHY A VITEST TEST RATHER THAN A SHELL FIXTURE. A guard against list drift
 * that has to be added to both lists is one more thing that can drift out of
 * them; a `scripts/test-suite-parity.sh` would have to name itself in the very
 * lists it polices. This file registers itself instead. `scripts/vitest.config.ts`
 * globs every `.test.ts` file under a `__tests__` directory, and that run is the
 * last link of `test:scripts` locally and the final `harness` step in the workflow
 * (`pnpm exec vitest run --config scripts/vitest.config.ts`), so a new test file
 * here is picked up by both sides with no wiring — the guard cannot be omitted
 * from the thing it guards.
 *
 * Both inputs are also inside the workflow's own path filter (`scripts/**`,
 * `package.json`, `.github/workflows/scripts-test.yml`), so a PR that edits
 * either list triggers the job that runs this check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOW_REL = '.github/workflows/scripts-test.yml';

/** Every `scripts/test-*.sh` invocation in a chunk of text, deduped and sorted. */
function suiteNames(text: string): string[] {
  const matches = text.matchAll(/bash\s+scripts\/(test-[A-Za-z0-9._-]+\.sh)/g);
  return [...new Set([...matches].map((m) => m[1] as string))].sort();
}

/** The suites `pnpm verify` runs, read from the real `test:scripts` chain. */
function localSuites(): string[] {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const chain = pkg.scripts?.['test:scripts'];
  // Not a soft check: if the script is renamed away, every assertion below
  // would compare CI against an empty set and pass by vacuum.
  expect(chain, 'root package.json has no `test:scripts` script').toBeTypeOf('string');
  return suiteNames(chain as string);
}

/**
 * The suites CI runs, read from the whole workflow file rather than one job's
 * block. `scripts-test.yml` splits its suites across TWO jobs on purpose —
 * `fixtures` skips `pnpm install` to stay a few seconds long, `harness` pays for
 * a node_modules because `test-homedir-guard.sh` lints through the real server
 * ESLint config — so a reader that scoped itself to one job would report the
 * other job's ten suites as missing. Scanning the file end to end cannot make
 * that mistake, because it never looks at job boundaries at all.
 *
 * Comment lines are dropped first. The file is heavily commented and those
 * comments name the scripts they justify; counting one would be a false GREEN,
 * the only error direction that matters here. The remaining risk is the
 * opposite one — a suite invoked in some form this regex misses reads as
 * "missing from CI", a false RED that announces itself with the suite's name
 * and gets fixed in a minute.
 */
function ciSuites(): string[] {
  const raw = readFileSync(path.join(repoRoot, WORKFLOW_REL), 'utf8');
  const withoutComments = raw
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  return suiteNames(withoutComments);
}

/** Every shell fixture suite that exists on disk under `scripts/`. */
function suitesOnDisk(): string[] {
  return readdirSync(path.join(repoRoot, 'scripts'))
    .filter((name) => /^test-[A-Za-z0-9._-]+\.sh$/.test(name))
    .sort();
}

describe('shell fixture suite lists', () => {
  const local = localSuites();
  const ci = ciSuites();

  it('`pnpm verify` runs every suite CI runs', () => {
    const missing = ci.filter((s) => !local.includes(s));
    expect(
      missing,
      `${WORKFLOW_REL} runs ${missing.length} suite(s) that root package.json's ` +
        `\`test:scripts\` does not: ${missing.join(', ')}. Each one can go red in CI ` +
        `having been green under \`pnpm verify\` (DOR-1515). Fix by adding ` +
        `${missing.map((s) => `\`bash scripts/${s} &&\``).join(' ')} to \`test:scripts\`.`
    ).toEqual([]);
  });

  it('CI runs every suite `pnpm verify` runs', () => {
    const missing = local.filter((s) => !ci.includes(s));
    expect(
      missing,
      `root package.json's \`test:scripts\` runs ${missing.length} suite(s) that ` +
        `${WORKFLOW_REL} does not: ${missing.join(', ')}. Each one is enforced only on ` +
        `the machine that remembers to run it, so it gates nothing on a PR (DOR-1515). ` +
        `Fix by adding a step running each to the \`fixtures\` job, or to \`harness\` if ` +
        `it needs a node_modules.`
    ).toEqual([]);
  });

  it('every suite on disk is wired into both lists', () => {
    // The third drift direction: a suite written and wired nowhere runs for
    // nobody, and the two assertions above agree with each other about it.
    const wired = new Set([...local, ...ci]);
    const orphans = suitesOnDisk().filter((s) => !wired.has(s));
    expect(
      orphans,
      `scripts/ contains ${orphans.length} fixture suite(s) that neither ` +
        `\`test:scripts\` nor ${WORKFLOW_REL} runs: ${orphans.join(', ')}. A suite ` +
        `nobody runs is not a gate (DOR-1515). Wire each into both, or delete it.`
    ).toEqual([]);
  });
});
