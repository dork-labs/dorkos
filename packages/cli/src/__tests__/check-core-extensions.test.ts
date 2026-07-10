import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeDirent {
  name: string;
  isDirectory: () => boolean;
}

// Steer `readdirSync` per test — the only external call `checkCoreExtensions` makes.
const h = vi.hoisted(() => ({
  entries: [] as { name: string; isDirectory: () => boolean }[],
  throwOnRead: false,
}));

vi.mock('node:fs', () => ({
  readdirSync: () => {
    if (h.throwOnRead) throw new Error('ENOENT: no such file or directory');
    return h.entries;
  },
}));

const dir = (name: string): FakeDirent => ({ name, isDirectory: () => true });
const file = (name: string): FakeDirent => ({ name, isDirectory: () => false });

// Must import after mock setup
const { checkCoreExtensions } = await import('../check-core-extensions.js');

describe('checkCoreExtensions', () => {
  beforeEach(() => {
    h.entries = [];
    h.throwOnRead = false;
  });

  it('returns true when at least one extension directory is present', () => {
    h.entries = [dir('hello-world'), dir('linear-issues'), dir('marketplace')];

    expect(checkCoreExtensions()).toBe(true);
  });

  it('returns true when a mix of directories and stray files is present', () => {
    h.entries = [dir('marketplace'), file('.DS_Store')];

    expect(checkCoreExtensions()).toBe(true);
  });

  it('returns false when the directory exists but is empty', () => {
    h.entries = [];

    expect(checkCoreExtensions()).toBe(false);
  });

  it('returns false when the directory contains only stray files', () => {
    h.entries = [file('README.md')];

    expect(checkCoreExtensions()).toBe(false);
  });

  it('returns false when the source directory is missing (DOR-245 regression)', () => {
    h.throwOnRead = true;

    expect(checkCoreExtensions()).toBe(false);
  });
});
