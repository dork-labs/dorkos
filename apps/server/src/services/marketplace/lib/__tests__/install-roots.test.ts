/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
// The narrow subpath, not the package root: this is a DRIFT GUARD over
// `PackageTypeSchema.options`, so it must read the schema from SOURCE (aliased in
// `apps/server/vitest.config.ts`). Aliasing the root would drag the whole
// marketplace index through every worker's transform; the subpath is zod and
// nothing else.
import { PackageTypeSchema } from '@dorkos/marketplace/package-types';
import {
  INSTALL_ROOT_DIR_BY_TYPE,
  INSTALL_ROOT_DIRS,
  INSTALL_ROOT_HOLDS_PACKAGES_ONLY,
  INSTALL_ROOTS_WITH_TYPE,
  installRootDirForType,
  installRootsUnder,
} from '../install-roots.js';

describe('install-roots', () => {
  it('maps every package type to an install root (no type left blind)', () => {
    // The whole point of this module: every marketplace package type must have
    // a declared install root, or it lands somewhere the scanners never look.
    for (const type of PackageTypeSchema.options) {
      expect(INSTALL_ROOT_DIR_BY_TYPE[type]).toBeTruthy();
    }
  });

  it('routes plugin/skill-pack/adapter to plugins, agent to agents, shape to shapes', () => {
    expect(installRootDirForType('plugin')).toBe('plugins');
    expect(installRootDirForType('skill-pack')).toBe('plugins');
    expect(installRootDirForType('adapter')).toBe('plugins');
    expect(installRootDirForType('agent')).toBe('agents');
    expect(installRootDirForType('shape')).toBe('shapes');
  });

  it('exposes the distinct set of roots including shapes/', () => {
    expect([...INSTALL_ROOT_DIRS]).toEqual(['plugins', 'agents', 'shapes']);
  });

  it('pairs each distinct root with a representative type', () => {
    expect(INSTALL_ROOTS_WITH_TYPE).toEqual([
      { dir: 'plugins', representativeType: 'plugin' },
      { dir: 'agents', representativeType: 'agent' },
      { dir: 'shapes', representativeType: 'shape' },
    ]);
  });

  it('keeps the distinct roots in lockstep with the type mapping', () => {
    const derived = new Set(Object.values(INSTALL_ROOT_DIR_BY_TYPE));
    expect(new Set(INSTALL_ROOT_DIRS)).toEqual(derived);
  });

  it('says which roots hold nothing but installs, and answers for every root', () => {
    // `agents/` is shared with the agents a person makes, so being in it is not
    // proof of being installed — the one root where a writer has to ask a second
    // question (DOR-1789).
    expect(INSTALL_ROOT_HOLDS_PACKAGES_ONLY).toEqual({
      plugins: true,
      agents: false,
      shapes: true,
    });
    for (const dir of INSTALL_ROOT_DIRS) {
      expect(typeof INSTALL_ROOT_HOLDS_PACKAGES_ONLY[dir]).toBe('boolean');
    }
  });

  it('carries that answer onto every root it resolves under a scope', () => {
    const roots = installRootsUnder('/scope');
    expect(roots.map((r) => [r.kind, r.packagesOnly])).toEqual([
      ['plugins', true],
      ['agents', false],
      ['shapes', true],
    ]);
  });
});
