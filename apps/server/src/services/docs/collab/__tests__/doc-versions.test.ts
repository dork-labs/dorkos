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
