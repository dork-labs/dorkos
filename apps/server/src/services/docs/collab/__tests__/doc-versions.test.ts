/**
 * Saved doc versions (DOR-2984): newest first, bounded per doc, never the same
 * bytes twice in a row, and nothing outside the store can be named.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocVersionStore } from '../doc-versions.js';

const AGENT = { kind: 'agent' as const, name: 'Ada' };
const scope = { docKey: 'a'.repeat(32) };
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'doc-versions-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('DocVersionStore', () => {
  it('keeps versions newest first, with who changed the doc next', async () => {
    const store = new DocVersionStore(root);
    const first = await store.keep(scope, 'one\n', AGENT);
    const second = await store.keep(scope, 'two\n', { kind: 'disk' });
    const listed = await store.list(scope);
    expect(listed.map((version) => version.id)).toEqual([second!.id, first!.id]);
    expect(listed[1]).toMatchObject({ changedBy: AGENT, bytes: 4 });
    expect(await store.read(scope, first!.id)).toBe('one\n');
  });

  it('does not keep the same bytes twice in a row', async () => {
    const store = new DocVersionStore(root);
    await store.keep(scope, 'same\n', AGENT);
    expect(await store.keep(scope, 'same\n', AGENT)).toBeNull();
    expect(await store.list(scope)).toHaveLength(1);
  });

  it('keeps only the newest few per doc', async () => {
    const store = new DocVersionStore(root, 3);
    for (const n of [1, 2, 3, 4, 5]) await store.keep(scope, `v${n}\n`, AGENT);
    const listed = await store.list(scope);
    expect(listed).toHaveLength(3);
    expect(await store.read(scope, listed[2]!.id)).toBe('v3\n');
  });

  it('reads nothing for an id that is not one of its own', async () => {
    const store = new DocVersionStore(root);
    expect(await store.read(scope, '../../etc/passwd')).toBeNull();
    expect(await store.read(scope, '01JZZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull();
    expect(await store.list({ docKey: 'b'.repeat(32) })).toEqual([]);
  });
});

describe('DocVersionStore bounds', () => {
  it('holds every doc together to a byte cap, oldest first', async () => {
    const store = new DocVersionStore(root, 10, 12);
    const a = { docKey: 'a'.repeat(32) };
    const b = { docKey: 'b'.repeat(32) };
    await store.keep(a, 'aaaa1\n', AGENT);
    await store.keep(b, 'bbbb1\n', AGENT);
    await store.keep(a, 'aaaa2\n', AGENT);
    const total = [...(await store.list(a)), ...(await store.list(b))];
    expect(total.reduce((sum, v) => sum + v.bytes, 0)).toBeLessThanOrEqual(12);
    expect(await store.list(b)).toHaveLength(1);
  });

  it('sweeps the versions of a doc whose file is gone and that nobody touched for a while', async () => {
    const store = new DocVersionStore(root);
    const file = path.join(root, 'gone.md');
    await store.keep({ docKey: 'c'.repeat(32), file }, 'old\n', AGENT);
    expect(await store.sweep(60_000)).toBe(0);
    expect(await store.sweep(-1)).toBe(1);
    expect(await store.list({ docKey: 'c'.repeat(32) })).toEqual([]);
  });

  it('marks unsaved edits as such', async () => {
    const store = new DocVersionStore(root);
    const kept = await store.keep(scope, 'draft\n', { kind: 'person' }, 'unsaved-edits');
    expect(kept?.reason).toBe('unsaved-edits');
  });
});
