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

  /**
   * The seam these shims describe is not only a typing problem — it decides
   * WHICH OBJECT the CLI is holding.
   *
   * `../server/index.js` is external: at runtime it is the separately-bundled
   * server, so its exports are live state from the process the server runs in.
   * Every other `../server/**` specifier is INLINED into `dist/bin/cli.js`
   * instead, giving the CLI its own private copy of that module. For a module
   * that only computes, or whose truth is a file on disk, a private copy is
   * fine. For one that CONSTRUCTS a long-lived object at module scope, it is a
   * silent bug: the CLI gets a second instance that nothing ever drives.
   *
   * That is exactly what happened to the tunnel printout (DOR-1745) — the CLI
   * subscribed to a `TunnelManager` no tunnel was ever started on, so
   * `dorkos --tunnel` never printed its address. The fix was to take the live
   * manager off `../server/index.js`, and this test keeps the next module of
   * that shape from being reached for the same way.
   *
   * WHAT THIS CANNOT SEE: state a module declares but leaves for an initializer
   * to fill (`export let configManager`, which the CLI deliberately builds its
   * own of, from the same file on disk). Those fail loudly and immediately when
   * read uninitialized, rather than quietly answering about the wrong instance.
   */
  it.each([...expectedShims()].filter(([shim]) => shim !== 'index.d.ts'))(
    '%s does not construct a singleton the CLI would get a dead copy of',
    (_shim, target) => {
      const source = readFileSync(path.join(ROOT, target.replace(/\.js$/, '.ts')), 'utf-8');
      const singletons = [...source.matchAll(/^export const (\w+)(?::[^=]+)? = new \w/gm)].map(
        ([, name]) => name
      );
      expect(
        singletons,
        `${target} constructs a module-scope singleton, and the CLI imports it through a ` +
          `specifier that esbuild INLINES — so the CLI would hold its own dead copy, not the ` +
          `one the running server drives (DOR-1745).\n` +
          `Export what the CLI needs from apps/server/src/index.ts instead, and read it off ` +
          `the module that \`await import('../server/index.js')\` returns.`
      ).toEqual([]);
    }
  );
});
