/**
 * Drift guard: local vitest runs stay capped, and CI stays uncapped (DOR-2160).
 *
 * Vitest defaults to one worker per core, so one run on this 14-core machine is
 * 14 workers and nothing capped it. Measured with three worktrees' suites live:
 * 53 vitest processes holding 10.0 GB, 187 node processes holding 17.2 GB, swap
 * 10.6 GB of 12.3 GB. The cap halves the memory one run needs.
 *
 * BOTH REGRESSIONS ARE SILENT, which is why this file exists.
 *
 *   * The cap disappears. Every suite still passes, a little more of the time
 *     is spent paging, and the box goes back to swapping. Nothing goes red.
 *
 *   * The cap reaches CI. Also silent, and worse in the direction we care
 *     about: the queue's wall time is an SLO we are actively trying to improve,
 *     and quartering the workers on a small runner would make it worse while
 *     every check stayed green. `CI` is set by GitHub Actions on every runner.
 *
 * TWO MECHANISMS, because there are two entry points and they do not share a
 * config. `pnpm vitest run <path>` from the repo root loads the root
 * `vitest.config.ts`; the turbo path (`pnpm test`, `pnpm verify`) runs each
 * package's OWN config in its own process, so the root scripts export
 * `VITEST_MAX_WORKERS`, which vitest reads at config-resolve time whatever
 * config it loads. Both are pinned below, including that they agree on the
 * number — two places that must match, where the mismatch is invisible from
 * either one alone.
 *
 * WHY A VITEST TEST RATHER THAN A SHELL FIXTURE — the same reasoning its
 * neighbours give: `scripts/vitest.config.ts` globs every `*.test.ts` under a
 * `__tests__` directory, and that run is the last link of `test:scripts` and
 * the final `harness` step of `scripts-test.yml`, so this file registers itself
 * in both with no wiring.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const configText = readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** The one number the whole policy is expressed in, read off the root config. */
const declared = /^const LOCAL_MAX_WORKERS = (\d+);$/m.exec(configText);

describe('the root config caps local runs', () => {
  it('declares a cap at all', () => {
    // Without this, every assertion below passes vacuously the day the constant
    // is renamed — the exact way a guard dies quietly.
    expect(declared, 'vitest.config.ts no longer declares LOCAL_MAX_WORKERS').not.toBeNull();
    expect(Number(declared![1])).toBeGreaterThan(0);
    expect(
      Number(declared![1]),
      'a cap at or above the core count of the machine this was written for caps nothing'
    ).toBeLessThan(14);
  });

  it('applies the cap only when CI is unset', () => {
    // The spelling matters: `maxWorkers: process.env.CI ? undefined : N` would
    // ALSO be correct, but `...(process.env.CI ? {} : {...})` is what is there,
    // and either way the property must be absent under CI rather than set to a
    // falsy value that a future vitest might coerce.
    expect(configText).toMatch(
      /\.\.\.\(process\.env\.CI \? \{\} : \{ maxWorkers: LOCAL_MAX_WORKERS \}\)/
    );
  });
});

describe('the turbo entry points carry the same cap', () => {
  // `pnpm vitest run <path>` and `pnpm test` load different configs, so a cap
  // in one is not a cap in the other.
  it.each(['test', 'verify'])('the root `%s` script sets VITEST_MAX_WORKERS', (name) => {
    expect(
      pkg.scripts[name],
      `the root \`${name}\` script no longer sets VITEST_MAX_WORKERS, so the turbo path runs ` +
        'one worker per core again while `pnpm vitest run` stays capped — the two halves ' +
        'disagreeing is worse than neither, because the fast path looks fixed.'
    ).toContain('VITEST_MAX_WORKERS=');
  });

  it('sets the same number the root config declares', () => {
    // Two places that must agree, with no way to notice from either alone.
    for (const name of ['test', 'verify']) {
      const n = /VITEST_MAX_WORKERS=\$\(test -n "\$CI" \|\| echo (\d+)\)/.exec(
        pkg.scripts[name] as string
      );
      expect(n, `the \`${name}\` script's cap is not in the expected CI-gated form`).not.toBeNull();
      expect(Number(n![1]), `\`${name}\` caps at a different number than vitest.config.ts`).toBe(
        Number(declared![1])
      );
    }
  });

  it('the shell gate really does yield the cap locally and nothing under CI', () => {
    // The assertions above are string matching; this one runs the expression.
    // An empty value is what vitest reads as "no cap" (`if (process.env.X)`),
    // so the CI case must produce an empty string, not the literal "0" and not
    // the word "true".
    //
    // The child's environment is built from nothing rather than inherited, so
    // the case that must produce an empty string cannot be rescued by a `CI`
    // this process happens to carry — which is exactly what would happen if
    // this suite were ever run on a CI runner.
    const run = (ci?: string) =>
      execFileSync('sh', ['-c', 'test -n "$CI" || echo 4'], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', ...(ci === undefined ? {} : { CI: ci }) },
      }).trim();
    expect(run()).toBe(String(declared![1]));
    expect(run('true')).toBe('');
  });
});
