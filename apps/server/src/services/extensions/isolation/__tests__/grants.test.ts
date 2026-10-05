/**
 * The pure rules behind the fixed grants (DOR-2686 task 3.3): the self-check
 * verdict, the scrubbed environment, and the IPC message shapes the host
 * accepts from an untrusted child.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ancestorsOf, buildChildEnv, selfCheckPassed } from '../grants.js';
import { isChildMessage, type PermissionReport } from '../ipc-protocol.js';
import { unpackedPath } from '../child-entry.js';

const PASSING: PermissionReport = {
  present: true,
  readsBootstrap: true,
  fsWriteRoot: false,
  fsReadRoot: false,
  readsDorkHome: false,
  inspector: false,
  readableAncestors: [],
  child: false,
  worker: false,
  addon: false,
  wasi: false,
};

describe('selfCheckPassed', () => {
  // Purpose: only a report with the model on, the positive control true, and
  // every capability off passes; flipping any one field fails it.
  it('requires every field', () => {
    expect(selfCheckPassed({ type: 'hello', node: 'v24', permission: PASSING })).toBe(true);
    for (const key of Object.keys(PASSING) as (keyof PermissionReport)[]) {
      if (key === 'readableAncestors') continue;
      const flipped = { ...PASSING, [key]: !PASSING[key] };
      expect(selfCheckPassed({ type: 'hello', node: 'v24', permission: flipped })).toBe(false);
    }
    // One readable folder above a grant fails it too.
    expect(
      selfCheckPassed({
        type: 'hello',
        node: 'v24',
        permission: { ...PASSING, readableAncestors: ['/'] },
      })
    ).toBe(false);
  });
});

describe('ancestorsOf', () => {
  // Purpose: every folder above every grant, the root included, once each,
  // and never a grant itself.
  it('lists each folder above the grants once', () => {
    expect(ancestorsOf(['/a/b/run', '/a/c/files']).sort()).toEqual(['/', '/a', '/a/b', '/a/c']);
    expect(ancestorsOf(['/a/b', '/a/b/c'])).not.toContain('/a/b');
  });
});

describe('buildChildEnv', () => {
  // Purpose: nothing but locale, time zone, the files folder and the id.
  it('copies nothing else from the host', () => {
    const env = buildChildEnv(
      'mail',
      '/data/files',
      {
        PATH: '/usr/bin',
        NODE_OPTIONS: '--inspect',
        ANTHROPIC_API_KEY: 'k',
        TZ: 'UTC',
        LANG: 'en_US.UTF-8',
        LC_TIME: 'C',
        NODE_ENV: 'production',
      },
      false
    );
    expect(env).toEqual({
      NODE_ENV: 'production',
      TZ: 'UTC',
      LANG: 'en_US.UTF-8',
      LC_TIME: 'C',
      HOME: '/data/files',
      USERPROFILE: '/data/files',
      TMPDIR: '/data/files/.tmp',
      TMP: '/data/files/.tmp',
      TEMP: '/data/files/.tmp',
      DORKOS_EXT_ID: 'mail',
    });
    expect(buildChildEnv('mail', '/d', {}, true).ELECTRON_RUN_AS_NODE).toBe('1');
    // The Windows folder, which Winsock needs, is the one other thing carried.
    expect(
      buildChildEnv('mail', '/d', { SystemRoot: 'C:\\Windows', USERNAME: 'x' }, false)
    ).toMatchObject({
      SystemRoot: 'C:\\Windows',
    });
    expect(buildChildEnv('mail', '/d', { USERNAME: 'x' }, false).USERNAME).toBeUndefined();
  });
});

describe('isChildMessage', () => {
  // Purpose: the host accepts only well-formed messages from the child.
  it('accepts good shapes and refuses bad ones', () => {
    expect(isChildMessage({ type: 'hello', node: 'v1', permission: PASSING })).toBe(true);
    expect(isChildMessage({ type: 'pong', n: 3 })).toBe(true);
    expect(
      isChildMessage({
        type: 'run-spawn',
        rid: 1,
        file: 'git',
        args: ['status'],
        cwd: null,
        env: null,
        stdin: false,
      })
    ).toBe(true);
    expect(isChildMessage({ type: 'run-stdin', rid: 1, chunk: new Uint8Array(1) })).toBe(true);
    for (const bad of [
      null,
      'pong',
      { type: 'pong', n: -1 },
      { type: 'hello', node: 'v1', permission: { ...PASSING, child: 'no' } },
      { type: 'run-spawn', rid: 1, file: 'git', args: [1], cwd: null, env: null, stdin: false },
      { type: 'run-spawn', rid: 1, file: 'git', args: [], cwd: null, env: { A: 1 }, stdin: false },
      { type: 'run-stdin', rid: 1, chunk: 'text' },
      { type: 'call', id: 1 },
    ]) {
      expect(isChildMessage(bad)).toBe(false);
    }
  });
});

describe('unpackedPath', () => {
  // Purpose: a path inside app.asar maps to its unpacked twin when it exists
  // (the permission model grants real files, not archive entries)...
  it('maps into app.asar.unpacked when the twin exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'asar-'));
    try {
      const twin = path.join(root, 'app.asar.unpacked', 'dist', 'server', 'x.cjs');
      await fs.mkdir(path.dirname(twin), { recursive: true });
      await fs.writeFile(twin, '');
      expect(unpackedPath(path.join(root, 'app.asar', 'dist', 'server', 'x.cjs'))).toBe(twin);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // ...and only then.
  it('leaves paths alone when no unpacked twin exists', () => {
    expect(unpackedPath('/Applications/X.app/Contents/Resources/app.asar/dist/server/x.cjs')).toBe(
      '/Applications/X.app/Contents/Resources/app.asar/dist/server/x.cjs'
    );
    expect(unpackedPath('/tmp/not-asar/x.cjs')).toBe('/tmp/not-asar/x.cjs');
  });
});
