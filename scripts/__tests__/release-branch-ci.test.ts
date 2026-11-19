/**
 * Pull requests into a release branch get the merge queue's full sweep and the
 * release-branch-contents rule (DOR-4639, decision DOR-4636).
 *
 * The step bodies are pinned by their own suites (no-code-scope-step,
 * pr-test-plan, binary-lane-job, community-packaged-scope-step, which all run
 * the bodies with `EVENT=release_pull_request`). This file pins the WIRING that
 * makes a release PR reach that value and the full side of every `if:`:
 *
 *   - every `if:` in test.yml and browser-test.yml that used to say "full on
 *     every event but a pull request" also says "or a pull request into
 *     release/", and the scoped PR legs say the negation;
 *   - every non-canary `EVENT:` in test.yml and docs-openapi-check.yml maps such
 *     a pull request to `release_pull_request`, and the canary guards keep the
 *     plain event name (they are byte-identical by their own test);
 *   - no `runs-on:` is widened: only merge_group may use the queue runner;
 *   - the release-branch-contents workflow passes untrusted values through
 *     `env:` only, and runs main's copy of the shell check and of DOR-4638's
 *     rule folder (packages/cli/scripts/release-branch/, check-picks.ts) on
 *     node 24, failing closed while main has no check-picks.ts;
 *   - fragment-present skips coverage on a release base only behind that rule.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const read = (name: string) => readFileSync(join(root, '.github/workflows', name), 'utf8');

const RELEASE = "startsWith(github.base_ref, 'release/')";
const MAPPED =
  "EVENT: ${{ github.event_name == 'pull_request' && startsWith(github.base_ref, 'release/') && 'release_pull_request' || github.event_name }}";

/** Non-comment lines. */
const code = (text: string) => text.split('\n').filter((line) => !/^\s*#/.test(line));

describe.each(['test.yml', 'browser-test.yml'])(
  '%s routes a release PR to the full sweep',
  (file) => {
    const lines = code(read(file));

    it('every full-sweep condition also admits a pull request into release/', () => {
      const full = lines.filter(
        (l) => /^\s*if:/.test(l) && l.includes("github.event_name != 'pull_request'")
      );
      expect(full.length).toBeGreaterThan(0);
      for (const line of full)
        expect(line).toContain(`github.event_name != 'pull_request' || ${RELEASE}`);
    });

    it('every scoped pull-request condition excludes a pull request into release/', () => {
      const scoped = lines.filter(
        (l) =>
          /^\s*if:/.test(l) &&
          l.includes("github.event_name == 'pull_request'") &&
          !l.includes("github.event_name == 'merge_group'")
      );
      expect(scoped.length).toBeGreaterThan(0);
      for (const line of scoped)
        expect(line).toContain(`github.event_name == 'pull_request' && !${RELEASE}`);
    });

    it('never widens runs-on to the queue runner', () => {
      for (const line of lines.filter((l) => /^\s*runs-on:/.test(l)))
        expect(line).not.toContain('base_ref');
    });
  }
);

describe.each(['test.yml', 'docs-openapi-check.yml'])(
  '%s step bodies see release_pull_request',
  (file) => {
    const lines = read(file).split('\n');

    it('maps every non-canary EVENT and leaves the canary guards alone', () => {
      let mapped = 0;
      lines.forEach((line, i) => {
        if (!/^\s+EVENT: /.test(line)) return;
        if (/^\s+REF: \$\{\{ github\.ref \}\}$/.test(lines[i + 1] ?? '')) {
          expect(line.trim()).toBe('EVENT: ${{ github.event_name }}');
        } else {
          expect(line.trim()).toBe(MAPPED);
          mapped += 1;
        }
      });
      expect(mapped).toBeGreaterThan(0);
    });
  }
);

describe('release-branch-contents.yml', () => {
  const text = read('release-branch-contents.yml');

  it('runs on pull requests into release/**, and nowhere else', () => {
    expect(text).toMatch(/^on:\n {2}pull_request:\n {4}branches: \['release\/\*\*'\]\n/m);
    expect(text).not.toMatch(/^ {2}(push|pull_request_target|merge_group|workflow_dispatch):/m);
  });

  it('never interpolates an expression into a shell body', () => {
    const runs = text.split(/\n\s+run: \|\n/).slice(1);
    expect(runs.length).toBeGreaterThan(0);
    for (const body of runs) {
      const block = body.split(/\n {6}- /)[0] ?? '';
      expect(block).not.toContain('${{');
    }
  });

  it("runs main's copy of the rule with a full-history checkout", () => {
    expect(text).toContain('git show origin/main:scripts/ci/release-branch-contents.sh');
    expect(text).not.toMatch(/bash scripts\/ci\/release-branch-contents\.sh/);
    expect(text).toMatch(/fetch-depth: 0/);
    expect(text).toMatch(/^ {10}BASE_REF: \$\{\{ github\.base_ref \}\}$/m);
  });

  it("hands the shell check main's copy of DOR-4638's rule folder, on node 24", () => {
    expectMainRule(text);
    expect(text).toMatch(
      /uses: actions\/setup-node@[0-9a-f]{40} # v[\d.]+\n\s+with:\n\s+node-version: '24'/
    );
  });
});

/** The rule is main's check-picks.ts folder, and its absence is exit 2, never a pass. */
function expectMainRule(text: string): void {
  expect(text).toContain(
    'git cat-file -e origin/main:packages/cli/scripts/release-branch/check-picks.ts'
  );
  expect(text).toContain('git archive origin/main packages/cli/scripts/release-branch |');
  expect(text).toContain('--rule-dir "$RUNNER_TEMP/release-branch-rule"');
  const missing = text.slice(text.indexOf('then', text.indexOf('git cat-file -e origin/main:')));
  expect(missing.slice(0, 400)).toMatch(/exit 2\n/);
  expect(text).not.toMatch(/--rule-dir (\.\/)?packages\/cli/);
}

describe('changelog-fragment-check.yml on a release base', () => {
  const text = read('changelog-fragment-check.yml');

  it("skips coverage there only after proving provenance with main's rule", () => {
    const prove = text.indexOf('- name: On a release branch, prove every commit came from main');
    const cover = text.indexOf('- name: Require a changelog fragment for every user-facing commit');
    expect(prove).toBeGreaterThan(-1);
    expect(cover).toBeGreaterThan(prove);
    const step = text.slice(prove, cover);
    expect(step).not.toMatch(/^\s+if:/m);
    expect(step).toContain('git show origin/main:scripts/ci/release-branch-contents.sh');
    expectMainRule(step);
    expect(text.slice(cover).split('\n')[1]).toContain(`!${RELEASE}`);
  });
});
