/**
 * The "is this link DorkOS's own" path check, judged the same on Windows as
 * on POSIX (#3761 `harness-windows`). Windows spells one folder several ways:
 * backslashes or slashes, any drive-letter case, and a `\\?\` long-path
 * prefix that `readlink` can return.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInside, ownerFolderUnder } from '../link-owner.js';

const win = path.win32;
const ROOT = 'C:\\Users\\ana\\.dork\\plugins';

describe('isInside on Windows paths', () => {
  it.each([
    ['the same casing', 'C:\\Users\\ana\\.dork\\plugins\\acme\\skills\\c'],
    ['a lower-case drive', 'c:\\Users\\ana\\.dork\\plugins\\acme\\skills\\c'],
    ['different folder casing', 'C:\\USERS\\Ana\\.DORK\\Plugins\\acme'],
    ['forward slashes', 'C:/Users/ana/.dork/plugins/acme'],
    ['a long-path prefix', '\\\\?\\C:\\Users\\ana\\.dork\\plugins\\acme'],
    ['the root itself', 'c:\\users\\ana\\.dork\\plugins\\'],
  ])('counts %s as inside', (_label, child) => {
    expect(isInside(child, ROOT, win)).toBe(true);
  });

  it.each([
    ['a neighbouring folder', 'C:\\Users\\ana\\.dork\\plugins-old\\acme'],
    ['another drive', 'D:\\Users\\ana\\.dork\\plugins\\acme'],
    ['a parent', 'C:\\Users\\ana\\.dork'],
  ])('does not count %s', (_label, child) => {
    expect(isInside(child, ROOT, win)).toBe(false);
  });
});

describe('ownerFolderUnder', () => {
  it('names the package folder on Windows, as spelled on disk', () => {
    expect(ownerFolderUnder('c:\\users\\ana\\.dork\\plugins\\Acme\\skills\\c', ROOT, win)).toBe(
      'Acme'
    );
    expect(ownerFolderUnder('\\\\?\\C:\\Users\\ana\\.dork\\plugins\\acme', ROOT, win)).toBe('acme');
  });

  it('names nothing outside the root, or for the root itself', () => {
    expect(ownerFolderUnder('C:\\Users\\ana\\dotfiles\\a', ROOT, win)).toBeUndefined();
    expect(ownerFolderUnder(ROOT, ROOT, win)).toBeUndefined();
  });

  it('keeps POSIX paths case-sensitive', () => {
    expect(isInside('/home/ana/.dork/Plugins/acme', '/home/ana/.dork/plugins', path.posix)).toBe(
      false
    );
    expect(
      ownerFolderUnder('/home/ana/.dork/plugins/acme/x', '/home/ana/.dork/plugins', path.posix)
    ).toBe('acme');
  });
});
