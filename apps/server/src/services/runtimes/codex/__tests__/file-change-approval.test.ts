import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileChangeMayAsk } from '../policy/file-change-approval.js';
import type { ProtectedPathRoots } from '../../shared/policy/protected-path-check.js';

const roots: ProtectedPathRoots = {
  cwd: '/project',
  data: '/data',
  home: '/home',
  accounts: ['/account'],
  agentFolders: ['/project'],
  agentHomes: ['/agents/a'],
};
const patch = (file: unknown, kind: unknown = { type: 'update' }) => ({
  path: file,
  kind,
  diff: '',
});
const input = (...changes: unknown[]) => JSON.stringify({ changes });
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('native file-change approval policy', () => {
  it.each(['add', 'update', 'delete'])(
    'allows an ordinary %s without changing approval semantics',
    (type) => {
      expect(fileChangeMayAsk(input(patch('source.ts', { type })), roots)).toBe(true);
    }
  );
  it.each(['add', 'update', 'delete'])(
    'refuses protected %s and mixed patches as a whole',
    (type) => {
      expect(
        fileChangeMayAsk(input(patch('source.ts'), patch('/data/config.json', { type })), roots)
      ).toBe(false);
    }
  );
  it('checks both rename paths and normalized traversal', () => {
    expect(
      fileChangeMayAsk(
        input(patch('source.ts', { type: 'update', move_path: '../data/config.json' })),
        roots
      )
    ).toBe(false);
    expect(
      fileChangeMayAsk(
        input(patch('/data/host.key', { type: 'update', move_path: 'source.ts' })),
        roots
      )
    ).toBe(false);
    expect(
      fileChangeMayAsk(
        input(patch('../other/source.ts', { type: 'update', move_path: 'renamed.ts' })),
        roots
      )
    ).toBe(true);
  });
  it('retains secret protection at Full and does not forbid ordinary git metadata', () => {
    expect(fileChangeMayAsk(input(patch('/data/host.key')), { ...roots, full: true })).toBe(false);
    expect(fileChangeMayAsk(input(patch('.git/config')), { ...roots, full: true })).toBe(true);
  });
  it.each([
    undefined,
    '',
    '{',
    'null',
    '{}',
    '{"changes":[]}',
    input(null),
    input({ path: 'a', kind: { type: 'update' } }),
    input({ ...patch('a'), diff: {} }),
    input(patch('a', { type: 'add', move_path: null })),
    input(patch('')),
    input(patch('a', { type: 'unknown' })),
    input(patch('a', { type: 'update', move_path: 3 })),
  ])('refuses unattributable input %s', (value) => {
    expect(fileChangeMayAsk(value, roots)).toBe(false);
  });
  it('keeps Git metadata read-only below Full without denying its Full write', () => {
    const change = input(patch('.git/info/new-file'));
    expect(fileChangeMayAsk(change, roots, ['/project/.git'])).toBe(false);
    expect(fileChangeMayAsk(change, roots, [])).toBe(true);
  });
  it('checks metadata aliases before resolving parent segments', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patch-metadata-')));
    temps.push(dir);
    const metadata = path.join(dir, 'metadata');
    fs.mkdirSync(path.join(metadata, 'nested'), { recursive: true });
    fs.symlinkSync(path.join(metadata, 'nested'), path.join(dir, 'alias'));
    const local = { ...roots, cwd: dir, agentFolders: [dir] };
    expect(fileChangeMayAsk(input(patch('alias/../new-file')), local, [metadata])).toBe(false);
    expect(fileChangeMayAsk(input(patch('alias/../new-file')), local, [])).toBe(true);
  });
  it('requires active turn roots rather than an implicit default', () => {
    expect(fileChangeMayAsk(input(patch('ordinary.ts')), undefined)).toBe(false);
  });
  it('resolves symlink destinations and refuses uncheckable loops', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patch-approval-')));
    temps.push(dir);
    const secret = path.join(dir, 'host.key');
    fs.writeFileSync(secret, 'fake');
    fs.symlinkSync(secret, path.join(dir, 'source.ts'));
    const local = { ...roots, cwd: dir, data: dir, agentFolders: [dir] };
    expect(fileChangeMayAsk(input(patch('source.ts')), local)).toBe(false);
    fs.symlinkSync('loop', path.join(dir, 'loop'));
    expect(fileChangeMayAsk(input(patch('loop/new.ts')), local)).toBe(false);
  });
});
