import { describe, it, expect } from 'vitest';
import { freeCopyName } from '../lib/copy-name';

describe('freeCopyName', () => {
  it('leaves the name alone when the destination has no such entry', () => {
    expect(freeCopyName({ name: 'notes.md', isDir: false, taken: ['other.md'] })).toBe('notes.md');
  });

  it('suffixes a file before its extension', () => {
    expect(freeCopyName({ name: 'notes.md', isDir: false, taken: ['notes.md'] })).toBe(
      'notes copy.md'
    );
  });

  it('counts up past copies that are already there', () => {
    expect(
      freeCopyName({ name: 'notes.md', isDir: false, taken: ['notes.md', 'notes copy.md'] })
    ).toBe('notes copy 2.md');
    expect(
      freeCopyName({
        name: 'notes.md',
        isDir: false,
        taken: ['notes.md', 'notes copy.md', 'notes copy 2.md'],
      })
    ).toBe('notes copy 3.md');
  });

  it('fills the first gap in the ladder rather than always taking the next number', () => {
    expect(
      freeCopyName({ name: 'notes.md', isDir: false, taken: ['notes.md', 'notes copy 2.md'] })
    ).toBe('notes copy.md');
  });

  it('does not stack suffixes when copying a copy', () => {
    expect(freeCopyName({ name: 'notes copy.md', isDir: false, taken: ['notes copy.md'] })).toBe(
      'notes copy 2.md'
    );
    expect(
      freeCopyName({
        name: 'notes copy 2.md',
        isDir: false,
        taken: ['notes copy.md', 'notes copy 2.md'],
      })
    ).toBe('notes copy 3.md');
  });

  it('keeps a folder name whole, dots and all', () => {
    expect(freeCopyName({ name: 'my.stuff', isDir: true, taken: ['my.stuff'] })).toBe(
      'my.stuff copy'
    );
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(freeCopyName({ name: '.gitignore', isDir: false, taken: ['.gitignore'] })).toBe(
      '.gitignore copy'
    );
  });

  it('splits on the last dot of a multi-part extension', () => {
    expect(freeCopyName({ name: 'site.tar.gz', isDir: false, taken: ['site.tar.gz'] })).toBe(
      'site.tar copy.gz'
    );
  });

  it('handles a file with no extension at all', () => {
    expect(freeCopyName({ name: 'Makefile', isDir: false, taken: ['Makefile'] })).toBe(
      'Makefile copy'
    );
  });
});
