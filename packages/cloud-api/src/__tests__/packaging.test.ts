/**
 * The packaging invariants that make this package publishable on its own.
 *
 * This package has to install from public npm into a checkout that has none of
 * this monorepo in it, so every one of these is load-bearing rather than
 * stylistic:
 *
 *   - **Zero workspace dependencies.** Not in `dependencies`, not in
 *     `peerDependencies`, not in `optionalDependencies`, and none reachable
 *     from an import in `src/`. Checked three ways, including against the
 *     workspace lockfile, because a `workspace:*` entry resolves fine here and
 *     fails only for whoever installs the published tarball.
 *   - **`zod` is a peer.** A consumer that already has `zod` must get one copy,
 *     not two: two copies mean two `instanceof z.ZodType` answers and schemas
 *     that silently stop recognising each other.
 *   - **Version lockstep with the CLI.** The contract version equals the app
 *     version, published atomically with it or not at all.
 *   - **`publishConfig.access: public`**, without which the first publish of a
 *     scoped package is refused.
 *
 * Tooling-only devDependencies on the workspace's shared ESLint and TypeScript
 * configs are the deliberate exception: npm strips `devDependencies` from a
 * published tarball, so they cannot reach a consumer, and vendoring two config
 * files to avoid them would take this package out of the repo's lint and
 * typecheck conventions for no gain a consumer can observe.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
    expect(manifest.name).toBe('@dork-labs/cloud-api');
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig?.access).toBe('public');
  });

  it('ships its declarations, its client and its fixtures', () => {
    expect(manifest.files).toContain('dist');
    expect(manifest.files).toContain('fixtures');
    expect(manifest.exports?.['.']).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
    expect(manifest.exports?.['./client']).toEqual({
      types: './dist/client.d.ts',
      default: './dist/client.js',
    });
  });

  it('declares zod as a peer and nothing as a runtime dependency', () => {
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(['zod']);
    // Also a devDependency, so the package builds and tests here without a
    // consumer supplying one.
    expect(manifest.devDependencies?.zod).toBeDefined();
  });

  it('has no workspace dependency of any kind a consumer could see', () => {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
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
        if (specifier.startsWith('../../'))
          offenders.push(`${path.basename(file)} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('resolves to no workspace link in the lockfile', () => {
    // The lockfile is the only place that can prove what pnpm actually wired
    // up, as opposed to what package.json asked for.
    const lock = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    const start = lock.indexOf('\n  packages/cloud-api:');
    expect(start, 'packages/cloud-api has no importer in the lockfile').toBeGreaterThan(-1);
    const rest = lock.slice(start + 1);
    const end = rest.search(/\n {2}[^ \n][^\n]*:\n/);
    const section = end === -1 ? rest : rest.slice(0, end);

    // Only `devDependencies` may carry a `link:` — the shared ESLint and
    // TypeScript configs, which npm strips from the published tarball.
    const runtimeBlock = section.split(/\n {4}devDependencies:/)[0];
    expect(runtimeBlock).not.toContain('link:');
    for (const line of section.split('\n')) {
      if (!line.includes('link:')) continue;
      expect(line).toMatch(/link:\.\.\/(eslint-config|typescript-config)/);
    }
  });
});

describe('version lockstep', () => {
  it('matches the CLI and the repo VERSION file exactly', () => {
    // The contract version equals the app version: published atomically with
    // it, or not at all. `/system:release` bumps all four together.
    const version = readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
    const cli = JSON.parse(
      readFileSync(path.join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')
    ) as { version: string };
    expect(manifest.version).toBe(cli.version);
    expect(manifest.version).toBe(version);
  });

  it('is pre-1.0, which is what makes the caret warning in the README true', () => {
    // On a `0.x` version npm reads `^0.75.0` as `>=0.75.0 <0.76.0`, and lockstep
    // bumps this package's minor on every app release — so a caret range locks a
    // consumer out of every future release. The README says to use
    // `">=0.75.0 <1"` or an exact pin; this asserts the premise still holds.
    expect(manifest.version.startsWith('0.')).toBe(true);
  });
});
