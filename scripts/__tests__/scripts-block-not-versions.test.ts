/**
 * Guard: a `scripts` entry must be a command line, never a bumped-dependency
 * version string (DOR-1879).
 *
 * The root `package.json` had TWO keys named `knip`: one in `scripts`
 * (`"knip": "knip"`, the dead-code-detection command AGENTS.md documents as
 * `pnpm knip`) and one in `devDependencies` (`"knip": "^6.32.3"`, the actual
 * dependency). Dependabot PR #1577 (commit `d931dadf0`, 2026-09-06) tried to
 * bump knip 6.32.3 -> 6.34.0 and matched the wrong occurrence of the
 * duplicated key: it rewrote `scripts.knip` to `"^6.34.0"` and left
 * `devDependencies.knip` — and the lockfile — untouched. `pnpm knip` then
 * tried to execute a program literally named `^6.34.0` ("command not found"),
 * while the dependency itself never moved. Nothing type-checked or linted the
 * mistake; it surfaced only when someone next ran the documented command.
 *
 * WHY THIS FILE EXISTS RATHER THAN A COMMENT IN package.json. JSON has no
 * comment syntax, so there is nowhere in the file itself to write "this key
 * is a script, not a version." And nothing else executes every script to
 * notice a bad one: `pnpm install` only reads the dependency blocks, and CI
 * never runs `pnpm knip` (it needs built dists and is excluded from the
 * verification gate — see AGENTS.md). The only way this class of mistake goes
 * red on the PR that causes it, instead of on the next person's terminal, is
 * a static check over every manifest's `scripts` block.
 *
 * Two independent assertions, because either alone would have missed half of
 * #1577:
 *  1. No script value LOOKS like a semver range (`^6.34.0`, `6.34.0`, ...). A
 *     real script is a command line; a bare version is never one.
 *  2. Where a `scripts` key and a dependency key share a name, the script's
 *     value must not equal that dependency's version string. This is the
 *     precise shape of the misfire — a bump landing on the wrong occurrence
 *     of a duplicated key — and it would have caught #1577 even if a future
 *     version string somehow slipped past assertion 1. All four dependency
 *     blocks are read for this — `dependencies`, `devDependencies`,
 *     `optionalDependencies` and `peerDependencies` — because the collision
 *     this guards against can land in any of them (`apps/desktop` and four
 *     `packages/*` manifests declare `optionalDependencies` or
 *     `peerDependencies` today, and the failure shape there is identical). A
 *     name declared in more than one block is checked against whichever
 *     block was read last in that list; no manifest in this workspace does
 *     that today.
 *
 * Walks every workspace manifest — the root plus `apps/*` and `packages/*` —
 * which is exactly the set `.github/workflows/scripts-test.yml`'s path filter
 * already names (`package.json`, one level under `apps`, one level under
 * `packages`), so this file runs on any PR that touches one.
 *
 * STDLIB ONLY, like its neighbours here: this file imports nothing outside
 * `node:*` and `vitest` — `scripts/` has no package.json of its own, and
 * keeping the dependency surface at zero is what lets these guards run in the
 * cheapest possible job.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** A scripts value that looks like a semver range rather than a command line. */
const VERSION_LIKE = /^[\^~]?\d+\.\d+\.\d+/;

/** Every workspace manifest path, plus the repo root. */
function manifestPaths(): string[] {
  const dirs = ['.'];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(group, entry.name));
    }
  }
  return dirs
    .map((dir) => path.join(dir, 'package.json'))
    .filter((rel) => existsSync(path.join(repoRoot, rel)));
}

/** One manifest's scripts block, plus every dependency version it declares. */
interface Manifest {
  /** Repo-relative path, e.g. `apps/server/package.json`. */
  rel: string;
  scripts: Record<string, string>;
  /**
   * `dependencies`, `devDependencies`, `optionalDependencies` and
   * `peerDependencies` merged, keyed by package name.
   */
  depVersions: Map<string, string>;
}

function readManifests(): Manifest[] {
  return manifestPaths().map((rel) => {
    const parsed = JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8')) as Record<
      string,
      unknown
    >;
    const scripts = (parsed.scripts as Record<string, string> | undefined) ?? {};
    const depVersions = new Map<string, string>();
    for (const block of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const deps = parsed[block] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [name, version] of Object.entries(deps)) {
        depVersions.set(name, version);
      }
    }
    return { rel, scripts, depVersions };
  });
}

const manifests = readManifests();

describe('a package.json script is never a version string', () => {
  it('finds manifests to check', () => {
    // Anti-vacuity: if the workspace scan silently returned nothing, both
    // assertions below would pass while checking nothing at all.
    expect(manifests.length).toBeGreaterThan(0);
    expect(manifests.some((m) => m.rel === 'package.json')).toBe(true);
  });

  it('never declares a scripts value that looks like a semver range', () => {
    const offenders: string[] = [];
    for (const { rel, scripts } of manifests) {
      for (const [name, value] of Object.entries(scripts)) {
        if (VERSION_LIKE.test(value)) {
          offenders.push(`${rel}: scripts.${name} = "${value}"`);
        }
      }
    }
    expect(
      offenders,
      'these scripts hold a version string instead of a command — a dependency bump landed ' +
        "on the wrong occurrence of a duplicated key (see this file's header, DOR-1879):"
    ).toEqual([]);
  });

  it('never lets a script collide with the version of a same-named dependency', () => {
    // The precise shape of #1577: a `scripts` key and a `dependencies` /
    // `devDependencies` key shared a name, and the bump rewrote the wrong one.
    const offenders: string[] = [];
    for (const { rel, scripts, depVersions } of manifests) {
      for (const [name, value] of Object.entries(scripts)) {
        const depVersion = depVersions.get(name);
        if (depVersion !== undefined && value === depVersion) {
          offenders.push(`${rel}: scripts.${name} = "${value}" equals the dependency version`);
        }
      }
    }
    expect(
      offenders,
      'a scripts key holds the exact version string of a same-named dependency — this is the ' +
        'precise shape of the #1577 misfire (DOR-1879):'
    ).toEqual([]);
  });
});
