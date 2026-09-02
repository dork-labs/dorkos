/**
 * Drift guard: every local `turbo --affected` invocation must pin TURBO_SCM_BASE.
 *
 * Turbo's default diff base is the LOCAL `main` branch. On this repo's machines
 * that ref only moves when a human pulls, while every worktree branch is cut
 * straight from `origin/main` — so it trails by dozens of commits and the diff
 * sweeps in everybody else's merges. The gates then read as scoped while
 * resolving to nearly everything: measured 2026-09-02 with the local ref ten
 * commits behind, a root-files-only tree resolved to 24 packages / 57 tasks /
 * 23 suites, which is byte-for-byte what `turbo test` with no `--affected` at
 * all resolves to. Pinned to `origin/main` the same tree resolves to the `//`
 * package and zero suites.
 *
 * DOR-833 pinned the two pre-commit commands; DOR-1717 pinned the pre-push test
 * gate and the root `verify` script. This file exists because dropping the pin
 * is INVISIBLE: the commands still run, still exit 0, still print an affected
 * set. Nothing goes red — the gates just quietly go back to scoping nothing,
 * which is the failure the tickets were opened about in the first place. There
 * is no other test in the repo that would notice.
 *
 * WHY A VITEST TEST RATHER THAN A SHELL FIXTURE — the same reasoning
 * `shell-suite-parity.test.ts` beside it gives: `scripts/vitest.config.ts` globs
 * every `*.test.ts` under a `__tests__` directory, and that run is the last link
 * of `test:scripts` (what `pnpm verify` runs) and the final `harness` step of
 * `.github/workflows/scripts-test.yml`. A `scripts/test-*.sh` would have to name
 * itself in the `test:scripts` chain and in the workflow's step list to run at
 * all; this file registers itself in both with no wiring.
 *
 * `lefthook.yml` was added to that workflow's path filters in the same change,
 * because a PR that edits ONLY `lefthook.yml` — the exact regression this guards
 * — did not previously trigger the job that runs this file.
 *
 * The invariant is deliberately stated over the whole of both files rather than
 * over four named commands: a fifth `--affected` call site added later inherits
 * the requirement instead of silently escaping it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** One shell command extracted from a config file, with a label for failures. */
interface Command {
  /** Where it came from, e.g. `lefthook.yml pre-commit.lint`. */
  label: string;
  /** The command text as the shell will receive it. */
  text: string;
}

/**
 * Every `run:` command in lefthook.yml, inline (`run: cmd`) and block
 * (`run: |`) alike, labelled with its enclosing hook and command name.
 *
 * Deliberately a small scanner rather than a YAML dependency: `scripts/` has no
 * package.json and the `scripts-test` workflow runs this file without a
 * `pnpm install`, so it may not import anything outside node's stdlib.
 */
function lefthookCommands(yaml: string): Command[] {
  const out: Command[] = [];
  const lines = yaml.split('\n');
  let hook = '?';
  let command = '?';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    // `pre-commit:` / `pre-push:` at column 0.
    const hookMatch = /^([a-z-]+):\s*$/.exec(line);
    if (hookMatch) {
      hook = hookMatch[1] as string;
      continue;
    }

    // A command name is the only 4-space-indented key under `commands:`.
    const commandMatch = /^ {4}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (commandMatch) {
      command = commandMatch[1] as string;
      continue;
    }

    const runMatch = /^(\s*)run:\s*(.*)$/.exec(line);
    if (!runMatch) continue;

    const indent = (runMatch[1] as string).length;
    const rest = (runMatch[2] as string).trim();
    const label = `lefthook.yml ${hook}.${command}`;

    if (rest !== '|' && rest !== '|-' && rest !== '>' && rest !== '>-') {
      out.push({ label, text: rest });
      continue;
    }

    // Block scalar: consume every following line indented deeper than `run:`.
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as string;
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
      body.push(next);
      i = j;
    }
    out.push({ label, text: body.join('\n') });
  }

  return out;
}

/** Every script in the root package.json, labelled by script name. */
function rootScripts(json: string): Command[] {
  const pkg = JSON.parse(json) as { scripts?: Record<string, string> };
  return Object.entries(pkg.scripts ?? {}).map(([name, text]) => ({
    label: `package.json scripts.${name}`,
    text,
  }));
}

/**
 * The commands that must carry a pin: those invoking turbo with `--affected`.
 *
 * `.github/workflows/**` is out of scope on purpose — CI sets TURBO_SCM_BASE
 * from the PR's own base ref as a job-level `env:`, which this shape cannot see
 * and does not need to.
 */
function affectedCommands(commands: Command[]): Command[] {
  return commands.filter((c) => c.text.includes('--affected'));
}

/** Whether a command assigns TURBO_SCM_BASE before its first `--affected`. */
function pinsBase(text: string): boolean {
  const assignment = text.indexOf('TURBO_SCM_BASE=');
  if (assignment === -1) return false;
  return assignment < text.indexOf('--affected');
}

const lefthookText = readFileSync(path.join(repoRoot, 'lefthook.yml'), 'utf8');
const packageText = readFileSync(path.join(repoRoot, 'package.json'), 'utf8');

describe('local turbo --affected gates pin their diff base', () => {
  it('finds the call sites at all', () => {
    // Without this, every assertion below passes vacuously the day someone
    // renames a hook or the scanner stops matching — the exact way a guard
    // dies quietly. Four known sites today: pre-commit lint, pre-commit
    // typecheck, pre-push tests, and `pnpm verify`.
    const sites = affectedCommands([
      ...lefthookCommands(lefthookText),
      ...rootScripts(packageText),
    ]);
    expect(sites.map((s) => s.label).sort()).toEqual([
      'lefthook.yml pre-commit.lint',
      'lefthook.yml pre-commit.typecheck',
      'lefthook.yml pre-push.tests',
      'package.json scripts.verify',
    ]);
  });

  it.each([
    ['lefthook.yml', () => lefthookCommands(lefthookText)],
    ['package.json', () => rootScripts(packageText)],
  ])('every --affected command in %s pins TURBO_SCM_BASE', (_file, load) => {
    for (const command of affectedCommands(load())) {
      expect(
        pinsBase(command.text),
        `${command.label} runs turbo --affected without pinning TURBO_SCM_BASE to origin/main — see DOR-833 / DOR-1717`
      ).toBe(true);
    }
  });

  it('resolves the base to origin/main, with a fallback for a clone that has no origin', () => {
    for (const command of affectedCommands([
      ...lefthookCommands(lefthookText),
      ...rootScripts(packageText),
    ])) {
      expect(command.text, command.label).toContain(
        'TURBO_SCM_BASE="$(git rev-parse --verify --quiet origin/main || echo main)"'
      );
    }
  });

  // The three assertions above are only worth their lines if they can fail.
  // These pin the checker against the exact mutants that would otherwise slip
  // past: the pre-DOR-1717 command, a pin placed after the flag it is supposed
  // to govern, and a pin naming the local ref the whole fix exists to avoid.
  it('rejects the unpinned command shapes it exists to catch', () => {
    expect(pinsBase('VITEST_RETRY=2 pnpm exec dotenv -- turbo test --affected -- --run')).toBe(
      false
    );
    expect(pinsBase('turbo lint --affected; TURBO_SCM_BASE=origin/main')).toBe(false);
    expect(pinsBase('TURBO_SCM_BASE=origin/main pnpm exec turbo lint --affected')).toBe(true);
  });

  it('reads block scalars, not just inline commands', () => {
    // The pre-push gate is a `run: |` block, so a scanner that only handled
    // inline `run:` values would silently drop the one site DOR-1717 fixed.
    const prePush = lefthookCommands(lefthookText).find(
      (c) => c.label === 'lefthook.yml pre-push.tests'
    );
    expect(prePush?.text).toContain('Delete-only push');
    expect(prePush?.text).toContain('turbo test --affected');
  });
});
