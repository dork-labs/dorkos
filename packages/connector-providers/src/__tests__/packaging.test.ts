/**
 * The packaging invariants that make this package publishable on its own.
 *
 * This package has to install from public npm into a checkout that has none of
 * this monorepo in it, so every one of these is load-bearing rather than
 * stylistic:
 *
 *   - **One workspace dependency, and only a published one.** The managed
 *     wire schemas name a connection grant by the cloud contract's own
 *     subject schema, so `@dork-labs/cloud-api` is a runtime dependency. It is
 *     itself published, in version lockstep with this package, and
 *     `pnpm publish` rewrites its `workspace:*` range to that exact version.
 *     No other workspace package may appear in `dependencies`,
 *     `peerDependencies` or `optionalDependencies`, or be reachable from an
 *     import in `src/`. Checked three ways, including against the workspace
 *     lockfile, because an unpublished `workspace:*` entry resolves fine here
 *     and fails only for whoever installs the published tarball. The cloud
 *     contract must never depend back on this package or on `@dorkos/shared`,
 *     or the two published packages would form a cycle. The other runtime
 *     dependency is the vendor SDK this package exists to confine, at an exact
 *     pin.
 *   - **`zod` is a peer.** A consumer that already has `zod` must get one copy,
 *     not two: two copies mean two `instanceof z.ZodType` answers and schemas
 *     that silently stop recognising each other.
 *   - **Version lockstep with the CLI and `@dork-labs/cloud-api`.** All three
 *     carry the app version and are published together or not at all.
 *   - **`publishConfig.access: public`**, without which the first publish of a
 *     scoped package is refused.
 *
 * Tooling-only devDependencies on the workspace's shared ESLint and TypeScript
 * configs are the deliberate exception: npm strips `devDependencies` from a
 * published tarball, so they cannot reach a consumer, and vendoring two config
 * files to avoid them would take this package out of the repo's lint and
 * typecheck conventions for no gain a consumer can observe.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/** The one workspace package this one may depend on: published, in version lockstep. */
const PUBLISHED_WORKSPACE_DEPENDENCY = '@dork-labs/cloud-api';

const packageRoot = path.resolve(import.meta.dirname, '..', '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: { access?: string };
  files?: string[];
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

/** Every `.ts` file under `src/`, excluding tests. */
function sourceFiles(dir = path.join(packageRoot, 'src'), found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      sourceFiles(path.join(dir, entry.name), found);
    } else if (entry.name.endsWith('.ts')) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

describe('packaging', () => {
  it('is published, scoped and public', () => {
    expect(manifest.name).toBe('@dork-labs/connector-providers');
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig?.access).toBe('public');
  });

  it('ships built declarations for every subpath, never TypeScript source', () => {
    expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(manifest.exports?.['./package.json']).toBe('./package.json');
    const subpaths = Object.entries(manifest.exports ?? {}).filter(
      ([key]) => key !== './package.json'
    );
    expect(subpaths.map(([key]) => key)).toEqual([
      '.',
      './composio',
      './connector-schemas',
      './connector-event-schemas',
      './connector-events',
      './connector-provider',
      './connector-authentication-setup',
      './stable-stringify',
      './connector-arguments',
      './connector-managed-schemas',
      './connector-managed-discovery-schemas',
      './connector-managed-usage-schemas',
    ]);
    for (const [key, target] of subpaths) {
      const stem = key === '.' ? 'index' : key === './composio' ? 'composio/index' : key.slice(2);
      expect(target, key).toEqual({
        types: `./dist/${stem}.d.ts`,
        default: `./dist/${stem}.js`,
      });
      // The source file the subpath is compiled from exists, so a renamed
      // module cannot leave a subpath that resolves to nothing.
      expect(existsSync(path.join(packageRoot, 'src', `${stem}.ts`)), key).toBe(true);
    }
  });

  // Emptying `dist/` is a publish concern, so it lives in `prepublishOnly` and
  // never in `build`. `build` runs while other things read `dist/`: every API
  // leg of the browser suite boots through `turbo run build`, beside two Vite
  // dev servers whose startup dependency scan resolves this package through
  // `exports` -> `dist/`. A `build` that deletes `dist/` first leaves it absent
  // for the whole `tsc` run; a scan landing in that window aborts, and every
  // dependency is then discovered at runtime, re-optimized and force-reloaded
  // under whichever test runs first (the queue's `browser-test` red of
  // 2026-09-27: duplicate React copies, "Cannot read properties of null
  // (reading 'useMemo')").
  it('empties dist/ only for a publish, never on an ordinary build', () => {
    const scripts = manifest.scripts ?? {};
    expect(scripts.build, 'build must leave the existing dist/ in place').not.toMatch(
      /\bclean\b|rmSync|\brm\b|rimraf/
    );
    expect(scripts.prepublishOnly).toMatch(/^pnpm run clean && pnpm run build$/);
    expect(scripts.clean).toMatch(/rmSync\('dist'/);
  });

  it('declares zod as a peer, and only the vendor SDK and the cloud contract at runtime', () => {
    // Exact pin: the adapters are written against this SDK's precise shapes.
    // The cloud contract is published in lockstep; `pnpm publish` pins it exactly.
    expect(manifest.dependencies ?? {}).toEqual({
      '@composio/core': '0.21.0',
      '@dork-labs/cloud-api': 'workspace:*',
    });
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(['zod']);
    // Also a devDependency, so the package builds and tests here without a
    // consumer supplying one.
    expect(manifest.devDependencies?.zod).toBeDefined();
  });

  it('has no workspace dependency a consumer could see, except the published cloud contract', () => {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (field === 'dependencies' && name === PUBLISHED_WORKSPACE_DEPENDENCY) continue;
        expect(range, `${field}.${name} uses the workspace protocol`).not.toMatch(/^workspace:/);
        expect(name, `${field}.${name} is a workspace package`).not.toMatch(/^@dorkos\//);
      }
    }
  });

  it('imports nothing from the workspace in its published source', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1];
        if (specifier.startsWith('@dorkos/'))
          offenders.push(`${path.basename(file)} -> ${specifier}`);
        if (specifier.startsWith('@dork-labs/') && specifier !== PUBLISHED_WORKSPACE_DEPENDENCY)
          offenders.push(`${path.basename(file)} -> ${specifier}`);
        if (specifier.startsWith('../../'))
          offenders.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('publishes from an empty dist, but never empties dist on an ordinary build', () => {
    // Publish: tsc never removes an output whose source is gone and `files`
    // ships all of dist/, so a stale file would ride along (it did, in 0.87.0).
    expect(manifest.scripts?.prepublishOnly).toBe('pnpm run clean && pnpm run build');
    // …and `clean` really empties dist/, or the publish step above cleans nothing.
    expect(manifest.scripts?.clean).toMatch(/rmSync\('dist',\{recursive:true,force:true\}\)/);
    // Build: several turbo processes build this package at once (every e2e leg
    // runs its own `turbo run build`) while a Vite dev server is already
    // resolving imports from dist/. A build that deletes dist/ first leaves the
    // package unresolvable for a moment; Vite's dependency scan fails on it,
    // discovers dependencies late and re-optimizes under a loaded page, which
    // ends with two copies of React and stalled the merge queue's browser suite.
    expect(manifest.scripts?.build).toBe('tsc -p tsconfig.build.json');
  });

  it('resolves to no workspace link in the lockfile', () => {
    // The lockfile is the only place that can prove what pnpm actually wired
    // up, as opposed to what package.json asked for.
    const lock = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    const start = lock.indexOf('\n  packages/connector-providers:');
    expect(start, 'packages/connector-providers has no importer in the lockfile').toBeGreaterThan(
      -1
    );
    const rest = lock.slice(start + 1);
    const end = rest.search(/\n {2}[^ \n][^\n]*:\n/);
    const section = end === -1 ? rest : rest.slice(0, end);

    // At runtime the only `link:` is the published cloud contract. Otherwise
    // only `devDependencies` may carry one — the shared ESLint and TypeScript
    // configs, which npm strips from the published tarball.
    const [runtimeBlock, devBlock = ''] = section.split(/\n {4}devDependencies:/);
    const runtimeLinks = runtimeBlock.split('\n').filter((line) => line.includes('link:'));
    expect(runtimeLinks.map((line) => line.trim())).toEqual(['version: link:../cloud-api']);
    for (const line of devBlock.split('\n')) {
      if (!line.includes('link:')) continue;
      expect(line).toMatch(/link:\.\.\/(eslint-config|typescript-config)/);
    }
  });

  it('depends on a cloud contract that depends on nothing in this workspace', () => {
    // Either direction of a workspace edge between the two published packages
    // would make them a cycle neither could be installed from npm without.
    const cloudApi = JSON.parse(
      readFileSync(path.join(repoRoot, 'packages', 'cloud-api', 'package.json'), 'utf8')
    ) as Pick<typeof manifest, 'name' | 'dependencies' | 'peerDependencies'>;
    expect(cloudApi.name).toBe(PUBLISHED_WORKSPACE_DEPENDENCY);
    for (const deps of [cloudApi.dependencies, cloudApi.peerDependencies]) {
      for (const [name, range] of Object.entries(deps ?? {})) {
        expect(range, name).not.toMatch(/^workspace:/);
        expect(name).not.toMatch(/^@dorkos\/|^@dork-labs\//);
      }
    }
  });
});

describe('version lockstep', () => {
  it('matches the CLI, the repo VERSION file and @dork-labs/cloud-api exactly', () => {
    // Published atomically with the app and the cloud contract, or not at all.
    // `/system:release` bumps all of them together; a hosted service pins both
    // packages to one release, so the two must never drift apart.
    const version = readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
    const cli = JSON.parse(
      readFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')
    ) as { version: string };
    const cloudApi = JSON.parse(
      readFileSync(path.join(repoRoot, 'packages', 'cloud-api', 'package.json'), 'utf8')
    ) as { name: string; version: string };
    expect(cloudApi.name).toBe('@dork-labs/cloud-api');
    expect(manifest.version).toBe(cloudApi.version);
    expect(manifest.version).toBe(cli.version);
    expect(manifest.version).toBe(version);
  });

  it('is pre-1.0, which is what makes the version advice in the README true', () => {
    // On a `0.x` version npm reads `^0.97.0` as `>=0.97.0 <0.98.0`, and lockstep
    // bumps this package's minor on every app release.
    expect(manifest.version.startsWith('0.')).toBe(true);
  });
});
