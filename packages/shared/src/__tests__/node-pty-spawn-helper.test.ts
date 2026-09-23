import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureNodePtySpawnHelperExecutable } from '../node-pty-spawn-helper.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-helper-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'index.js'), '');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Lay a helper down at `relative` with `mode`, as node-pty's published tarball does. */
function helperAt(relative: string, mode: number): string {
  const helper = path.join(root, relative);
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, '');
  fs.chmodSync(helper, mode);
  return helper;
}

/** Run against the fake package, resolving node-pty to its entry file. */
function ensure(platform: NodeJS.Platform = 'darwin') {
  return ensureNodePtySpawnHelperExecutable({
    resolveFrom: import.meta.url,
    platform,
    arch: 'arm64',
    resolve: () => path.join(root, 'lib', 'index.js'),
  });
}

describe('ensureNodePtySpawnHelperExecutable', () => {
  it('makes a published 0644 prebuilt helper executable', () => {
    const helper = helperAt('prebuilds/darwin-arm64/spawn-helper', 0o644);
    expect(ensure()).toEqual({ status: 'healed', helper });
    expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('leaves an already-executable helper alone', () => {
    const helper = helperAt('prebuilds/darwin-arm64/spawn-helper', 0o700);
    expect(ensure()).toEqual({ status: 'executable', helper });
    expect(fs.statSync(helper).mode & 0o777).toBe(0o700);
  });

  it('falls back to a source-built helper', () => {
    const helper = helperAt('build/Release/spawn-helper', 0o644);
    expect(ensure()).toEqual({ status: 'healed', helper });
  });

  it('reports a missing helper without throwing', () => {
    expect(ensure()).toEqual({ status: 'not-found' });
  });

  it('does nothing on Windows, which has no helper', () => {
    const helper = helperAt('prebuilds/win32-arm64/spawn-helper', 0o644);
    expect(ensure('win32')).toEqual({ status: 'not-applicable' });
    expect(fs.statSync(helper).mode & 0o777).toBe(0o644);
  });

  it('reports an unresolvable node-pty instead of throwing', () => {
    const result = ensureNodePtySpawnHelperExecutable({
      resolveFrom: import.meta.url,
      platform: 'darwin',
      resolve: () => {
        throw new Error('Cannot find module');
      },
    });
    expect(result.status).toBe('unresolved');
  });
});
