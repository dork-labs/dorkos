import { describe, it, expect } from 'vitest';
import { revealActionLabel, toAbsolutePath } from '../lib/paths';

describe('revealActionLabel', () => {
  it('names Finder on macOS', () => {
    expect(revealActionLabel('darwin-arm64')).toBe('Reveal in Finder');
  });

  it('names File Explorer on Windows', () => {
    expect(revealActionLabel('win32-x64')).toBe('Reveal in File Explorer');
  });

  it('falls back to a generic name everywhere else', () => {
    expect(revealActionLabel('linux-x64')).toBe('Show in File Manager');
    expect(revealActionLabel('freebsd-x64')).toBe('Show in File Manager');
  });

  it('falls back to the generic name before the server config has loaded', () => {
    expect(revealActionLabel(undefined)).toBe('Show in File Manager');
  });
});

describe('toAbsolutePath', () => {
  it('joins a POSIX working directory with a relative entry path', () => {
    expect(toAbsolutePath('/Users/kai/repo', 'src/index.ts')).toBe('/Users/kai/repo/src/index.ts');
  });

  it('does not double the separator on a trailing slash', () => {
    expect(toAbsolutePath('/Users/kai/repo/', 'README.md')).toBe('/Users/kai/repo/README.md');
  });

  it('spells a Windows path the way Windows spells it', () => {
    expect(toAbsolutePath('C:\\Users\\kai\\repo', 'src/index.ts')).toBe(
      'C:\\Users\\kai\\repo\\src\\index.ts'
    );
  });

  it('treats a path with any forward slash as POSIX', () => {
    // A POSIX file name may legally contain a backslash; the forward slash is
    // what settles it.
    expect(toAbsolutePath('/Users/kai/we\\ird', 'a.txt')).toBe('/Users/kai/we\\ird/a.txt');
  });
});
