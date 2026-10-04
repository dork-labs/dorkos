/**
 * Finding the file to fork (DOR-2686 task 3.1): a shipped build's sibling
 * `extension-child.cjs` wins; in development the bootstrap source is bundled
 * into the data directory, once, and the result is a runnable child; a
 * bundled build missing its child refuses rather than guessing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHILD_ENTRY_FILE, resolveChildEntry } from '../child-entry.js';

describe('resolveChildEntry', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'child-entry-')));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Purpose: in a shipped build the sibling file is used as is.
  it('uses the shipped sibling', async () => {
    const dist = path.join(tmp, 'dist', 'server');
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, CHILD_ENTRY_FILE), '');
    const moduleUrl = pathToFileURL(path.join(dist, 'index.js')).href;
    expect(await resolveChildEntry(tmp, moduleUrl)).toBe(path.join(dist, CHILD_ENTRY_FILE));
  });

  // Purpose: a bundled build without its child refuses (never runs something else).
  it('refuses when a bundled build lacks the child', async () => {
    const moduleUrl = pathToFileURL(path.join(tmp, 'index.js')).href;
    await expect(resolveChildEntry(tmp, moduleUrl)).rejects.toThrow(CHILD_ENTRY_FILE);
  });

  // Purpose: in development the source is bundled once into the data
  // directory, and the bundle is a child that sends its self-check first.
  it('bundles the source in development, once, into a runnable child', async () => {
    const dorkHome = path.join(tmp, '.dork');
    const first = await resolveChildEntry(dorkHome);
    expect(first.startsWith(path.join(dorkHome, 'cache', 'extensions', 'isolation'))).toBe(true);
    expect(await resolveChildEntry(dorkHome)).toBe(first);
    const child = fork(first, [], {
      execArgv: ['--permission', `--allow-fs-read=${first}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
      const hello = await new Promise((resolve) => child.once('message', resolve));
      expect(hello).toMatchObject({
        type: 'hello',
        permission: { present: true, readsBootstrap: true, child: false, worker: false },
      });
    } finally {
      child.kill('SIGKILL');
    }
  });
});
