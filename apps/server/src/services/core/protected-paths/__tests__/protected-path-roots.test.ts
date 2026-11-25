/**
 * Core takes the Claude account folders from whoever registered them, and refuses
 * rather than unprotects when nobody has (DOR-4928): an empty list would leave every
 * account folder's sign-in readable by an agent's tools.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { protectedPathRefusal } from '../protected-file-guard.js';
import { protectedPathRoots, setProtectedAccountRoots } from '../protected-path-roots.js';
import { isProtectedLaunchFolder } from '../../../session/launch/launch-caller.js';

const ACCOUNT = path.join(os.tmpdir(), 'dor-4928-claude-account');
const PLAIN = path.join(os.tmpdir(), 'dor-4928-plain-project');

describe('protected roots before and after the account folders are registered', () => {
  // One `it`, in order: the registration is module state and cannot be taken back.
  it('refuses every path until registered, then reads the registered folders fresh', () => {
    // Purpose: fails if an unregistered server answers with no account folders, which
    // unprotects them, instead of refusing what it cannot check.
    expect(() => protectedPathRoots(PLAIN)).toThrow(/not registered/u);
    expect(protectedPathRefusal(path.join(PLAIN, 'notes.md'), PLAIN)?.code).toBe('PROTECTED_FILE');
    expect(isProtectedLaunchFolder(PLAIN)).toBe(true);

    let folders = [ACCOUNT];
    setProtectedAccountRoots(() => folders);
    expect(protectedPathRoots(PLAIN).accounts).toEqual([ACCOUNT]);
    expect(protectedPathRefusal(path.join(ACCOUNT, 'backups', 'old.json'), PLAIN)?.code).toBe(
      'PROTECTED_FILE'
    );
    expect(protectedPathRefusal(path.join(PLAIN, 'notes.md'), PLAIN)).toBeNull();
    folders = [];
    expect(protectedPathRoots(PLAIN).accounts).toEqual([]);
    // A caller that names the folders itself does not need the registration.
    expect(protectedPathRoots(PLAIN, undefined, undefined, [PLAIN]).accounts).toEqual([PLAIN]);
  });
});
