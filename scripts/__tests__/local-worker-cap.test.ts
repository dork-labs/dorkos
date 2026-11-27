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
 * `vitest.config.ts`; the turbo path (`pnpm test`, `pnpm check verify`) runs each
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
  // Run each entry point's actual shell assignment in a clean environment.
  // Checking just that the caller exported a value misses a later overwrite.
  describe.each(['test', 'check:verify:turbo', 'check:preopen:turbo'])('%s', (name) => {
    const resolveCap = (env: Record<string, string>) => {
      const assignment = /VITEST_MAX_WORKERS=\$\([^)]*\)/.exec(pkg.scripts[name]!);
      expect(assignment, `${name} must select a worker cap for Turbo`).not.toBeNull();
      return execFileSync('sh', ['-c', `${assignment![0]}; printf '%s' "$VITEST_MAX_WORKERS"`], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', ...env },
      });
    };

    it('uses the root default with no lower local cap', () => {
      for (const cap of ['', '4', '8', '0', '-1', 'invalid']) {
        expect(resolveCap({ VITEST_MAX_WORKERS: cap })).toBe(declared![1]);
      }
      expect(resolveCap({})).toBe(declared![1]);
    });

    it.each(['1', '2', '3'])('honors an explicit lower local cap of %s', (cap) => {
      expect(resolveCap({ VITEST_MAX_WORKERS: cap })).toBe(cap);
    });

    it('leaves CI uncapped with or without a caller override', () => {
      expect(resolveCap({ CI: 'true' })).toBe('');
      expect(resolveCap({ CI: 'true', VITEST_MAX_WORKERS: '2' })).toBe('');
    });
  });
});
