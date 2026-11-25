/**
 * Host symlinks under a computer's anchor (DOR-5251): a folder that leaves the
 * anchor through a link is refused whichever side names it, and one that stays
 * inside still maps. Real folders, because the rule is about real paths.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ComputerFolders } from '../folders.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dorkos-computer-folders-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const anchor = join(root, 'anchor');
const outside = join(root, 'outside');
mkdirSync(join(anchor, 'real'), { recursive: true });
mkdirSync(outside);
symlinkSync(outside, join(anchor, 'out'));
symlinkSync(join(anchor, 'real'), join(anchor, 'in'));
symlinkSync(join(root, 'missing'), join(anchor, 'dangling'));
const folders = new ComputerFolders(anchor, '/home/agent/project');

describe('ComputerFolders host symlinks', () => {
  it('maps a folder that does not exist on the host yet, and a link that stays inside', () => {
    expect(folders.toGuest(join(anchor, 'packages/api'))).toBe('/home/agent/project/packages/api');
    expect(folders.toHost('/home/agent/project/in/src')).toBe(join(anchor, 'in/src'));
  });

  it.each([
    ['a link leaving the anchor', 'out'],
    ['a folder under that link', 'out/src'],
    ['a dangling link', 'dangling'],
  ])('refuses %s in both directions', (_name, rest) => {
    expect(() => folders.toGuest(join(anchor, rest))).toThrow('DIRECTORY_REFUSED');
    expect(() => folders.toHost(`/home/agent/project/${rest}`)).toThrow('DIRECTORY_REFUSED');
  });
});
