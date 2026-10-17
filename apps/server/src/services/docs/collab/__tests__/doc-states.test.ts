/**
 * Saved live-doc states (DOR-2984): loaded only for the file they were saved
 * with, held to a total size with the docs touched longest ago going first,
 * and swept once their file has been gone a while.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocStateStore } from '../doc-states.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'doc-states-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const key = (c: string) => c.repeat(32);
const saved = (bytes: number) => ({
  generation: 'g1',
  hash: 'h1',
  state: new Uint8Array(bytes),
  fileState: new Uint8Array(bytes),
});

describe('DocStateStore', () => {
  it('loads a state only for the file hash it was saved with', async () => {
    const store = new DocStateStore(root);
    const file = path.join(root, 'a.md');
    writeFileSync(file, 'x');
    await store.save(key('a'), file, saved(4));
    expect(await store.load(key('a'), 'h1')).toMatchObject({ generation: 'g1' });
    expect(await store.load(key('a'), 'another-hash')).toBeNull();
  });

  it('holds every doc together to its cap, removing the docs saved longest ago', async () => {
    const store = new DocStateStore(root, 1_000);
    const file = path.join(root, 'a.md');
    writeFileSync(file, 'x');
    await store.save(key('a'), file, saved(300));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save(key('b'), file, saved(300));
    expect(await store.load(key('a'), 'h1')).toBeNull();
    expect(await store.load(key('b'), 'h1')).not.toBeNull();
  });

  it('sweeps the state of a doc whose file is gone', async () => {
    const store = new DocStateStore(root);
    await store.save(key('c'), path.join(root, 'gone.md'), saved(4));
    expect(await store.sweep(60_000)).toBe(0);
    expect(await store.sweep(-1)).toBe(1);
    expect(await store.load(key('c'), 'h1')).toBeNull();
  });
});
