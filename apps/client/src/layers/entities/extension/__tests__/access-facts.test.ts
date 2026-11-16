import { describe, expect, it } from 'vitest';
import {
  approvalChangeLine,
  extensionAccessFacts,
  isChangedSinceAllowed,
} from '../lib/access-facts';
import type { ExtensionPermissionView } from '../lib/permission-lines';

const BASE: ExtensionPermissionView = { runtime: 'in-process', net: [], run: [], agents: false };

describe('extensionAccessFacts', () => {
  // Purpose: the three facts read exactly as Security wrote them, and an
  // in-process extension never under-states its reach.
  it('says full access and any network for one that runs inside DorkOS', () => {
    expect(extensionAccessFacts(BASE)).toEqual([
      { label: 'Access', value: 'Runs inside DorkOS, with full access to this computer' },
      { label: 'Runs as', value: 'You' },
      { label: 'Network', value: 'Can reach anything this computer can' },
    ]);
  });

  it('says only Runs as for one with no server half, and nothing about its screens', () => {
    expect(extensionAccessFacts({ ...BASE, hasServer: false })).toEqual([
      { label: 'Runs as', value: 'You' },
    ]);
  });

  it('lists every host for one that runs on its own, or says it reaches nothing', () => {
    const own: ExtensionPermissionView = {
      ...BASE,
      runtime: 'subprocess',
      net: ['a.dev', 'b.dev'],
    };
    expect(extensionAccessFacts(own)[0]).toEqual({
      label: 'Access',
      value: 'Runs on its own, apart from DorkOS',
    });
    expect(extensionAccessFacts(own)[2]).toEqual({
      label: 'Network',
      value: 'Can reach',
      hosts: ['a.dev', 'b.dev'],
    });
    expect(extensionAccessFacts({ ...own, net: [] })[2]).toEqual({
      label: 'Network',
      value: 'Reaches nothing on the internet',
    });
  });
});

describe('approvalChangeLine', () => {
  const since = new Date().toISOString();

  // Purpose: what changed and when, in one line, naming at most three files.
  it('names both versions, three files and a count of the rest, and when', () => {
    const line = approvalChangeLine({
      updatedFrom: '1.0.0',
      version: '1.1.0',
      changedFiles: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'],
      since,
    });
    expect(line).toMatch(
      /^Version 1\.0\.0 → 1\.1\.0 · a\.js, b\.js, c\.js and 2 more files · Noticed /
    );
  });

  it('says only when, if neither the version nor the files are known', () => {
    expect(
      approvalChangeLine({ updatedFrom: null, version: '1.0.0', changedFiles: null, since })
    ).toMatch(/^Noticed /);
  });
});

describe('isChangedSinceAllowed', () => {
  it('is true for an update or changed files, and false for a first run', () => {
    expect(isChangedSinceAllowed({ updatedFrom: '1.0.0', changedFiles: null })).toBe(true);
    expect(isChangedSinceAllowed({ updatedFrom: null, changedFiles: [] })).toBe(true);
    expect(isChangedSinceAllowed({ updatedFrom: null, changedFiles: null })).toBe(false);
  });
});
