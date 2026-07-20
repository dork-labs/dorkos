/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { PackageTypeSchema } from '@dorkos/marketplace';
import {
  INSTALL_ROOT_DIR_BY_TYPE,
  INSTALL_ROOT_DIRS,
  INSTALL_ROOTS_WITH_TYPE,
  installRootDirForType,
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
});
