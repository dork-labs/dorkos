import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the declaration mirror in `packages/cli/server/` against the esbuild
 * rewrite it stands for.
 *
 * The CLI reaches the server through specifiers that only resolve in the
 * published dist layout (`../server/services/core/config-manager.js`, and so
 * on). `scripts/build.ts` resolves them at bundle time with
 * `serverServicesRedirectPlugin`; tsc cannot use that plugin and cannot use
 * tsconfig `paths` either — `paths` is never consulted for relative specifiers
 * — so `packages/cli/server/**.d.ts` reproduces the layout on disk instead.
 *
 * Two mechanisms describing one mapping will drift, and the drift is silent in
 * the worst direction: tsc would go on passing while checking a program that is
 * not the one being shipped. So this test re-derives the mapping from the CLI
 * source and asserts the mirror matches it exactly — no missing shim, no shim
 * pointing at the wrong module, no shim left behind after its import is gone.
 *
 * WHAT THIS CANNOT SEE: a dynamic import whose specifier is a variable rather
 * than a literal (`await import(someServerPath)`). Nothing catches that one —
 * tsc cannot resolve it either, and esbuild's redirect plugin cannot rewrite
 * it, so it would survive the build and then fail at a user's install, where
 * `dist/server/` contains only `index.js`. Do not write one; there are none
 * today. A literal specifier is what makes every other mechanism here work.
 */
const CLI_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = path.resolve(CLI_PKG, '../..');
const SHIM_DIR = path.join(CLI_PKG, 'server');

/** Every `.ts` file under a directory, recursively. */
function walkTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTs(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every file under a directory, recursively. */
function walkAll(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkAll(full) : [full];
  });
}

/**
 * Collect the `../server/**` specifiers the CLI source imports, mapped to the
 * source module each one must resolve to.
 *
 * The `../server/services/` arm applies the same rewrite as
 * `serverServicesRedirectPlugin` — depth-insensitive, `.js` swapped for `.ts`.
 * Everything else lands on `apps/server/src/<remainder>`, which is right for
 * both of the remaining cases: `../server/lib/` is redirected by that same
 * plugin, and `../server/index.js` is the one specifier esbuild leaves
 * external, where at runtime it is the sibling bundle of
 * `apps/server/src/index.ts`.
 *
 * @returns Map from shim path (relative to `packages/cli/server/`) to the
 *   repo-relative server source it must re-export.
 */
function expectedShims(): Map<string, string> {
  const expected = new Map<string, string>();
  for (const file of walkTs(path.join(CLI_PKG, 'src'))) {
    const source = readFileSync(file, 'utf-8');
    // Anchored on `from` / `import(` so prose about a specifier is not mistaken
    // for one — including the prose in this file.
    const imports = source.matchAll(/(?:from|import)\s*\(?\s*['"]((?:\.\.\/)+server\/[^'"]+)['"]/g);
    for (const [, specifier] of imports) {
      const remainder = specifier.replace(/^(?:\.\.\/)+server\//, '');
      const services = remainder.match(/^services\/(.+)\.js$/);
      expected.set(
        remainder.replace(/\.js$/, '.d.ts'),
        services
          ? `apps/server/src/services/${services[1]}.js`
          : `apps/server/src/${remainder.replace(/\.js$/, '')}.js`
      );
    }
  }
  return expected;
}

describe('server declaration mirror', () => {
  const expected = expectedShims();

  it('finds the server imports it is supposed to be guarding', () => {
    // A regex that silently matches nothing would make every other assertion
    // here vacuously true.
    expect(expected.size).toBeGreaterThanOrEqual(6);
    expect([...expected.keys()]).toContain('services/core/config-manager.d.ts');
    expect([...expected.keys()]).toContain('index.d.ts');
  });

  it.each([...expectedShims()])('%s re-exports %s', (shim, target) => {
    const shimPath = path.join(SHIM_DIR, shim);
    expect(
      existsSync(shimPath),
      `Missing declaration mirror for a '../server/**' import.\n` +
        `Create packages/cli/server/${shim} containing:\n` +
        `  export * from '${path.relative(path.dirname(shimPath), path.join(ROOT, target))}';`
    ).toBe(true);

    // Resolve the shim's own re-export and compare absolute paths, so a shim
    // that points at a real-but-wrong module fails just as loudly as a missing
    // one.
    const reexport = readFileSync(shimPath, 'utf-8').match(/export \* from '([^']+)';/);
    expect(reexport, `${shim} has no 'export * from' line`).not.toBeNull();
    expect(path.resolve(path.dirname(shimPath), reexport![1])).toBe(path.join(ROOT, target));
  });

  it('has no shim without a matching import', () => {
    const orphans = walkAll(SHIM_DIR)
      .map((file) => path.relative(SHIM_DIR, file))
      .filter((file) => !expected.has(file));
    expect(orphans, 'Delete these — nothing in src/ imports them any more').toEqual([]);
  });
});
