import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditBaselineStore } from '../edit-baseline.js';
import { FILE_LIMITS } from '../../../config/constants.js';

describe('EditBaselineStore', () => {
  let dir: string;
  let store: EditBaselineStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-'));
    store = new EditBaselineStore();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('captures the current disk bytes as the baseline (first touch)', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'const a = 1;\n');
    await store.captureFromDisk('s1', file);
    expect(store.get('s1', file)?.bytes.toString('utf8')).toBe('const a = 1;\n');
    expect(store.get('s1', file)?.capturedFrom).toBe('pre-tool');
  });

  it('is first-touch-wins — a second capture after the file changed is a no-op', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'v1\n');
    await store.captureFromDisk('s1', file);
    await fs.writeFile(file, 'v2\n');
    await store.captureFromDisk('s1', file);
    expect(store.get('s1', file)?.bytes.toString('utf8')).toBe('v1\n');
  });

  it('captures an empty baseline for a Write-first (not-yet-existing) file', async () => {
    const file = path.join(dir, 'new.ts');
    await store.captureFromDisk('s1', file);
    expect(store.get('s1', file)?.bytes.length).toBe(0);
    expect(store.get('s1', file)?.capturedFrom).toBe('pre-tool');
  });

  it('advance sets the baseline to current disk', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'v1\n');
    await store.captureFromDisk('s1', file);
    await fs.writeFile(file, 'v2\n');
    await store.advance('s1', file);
    expect(store.get('s1', file)?.bytes.toString('utf8')).toBe('v2\n');
  });

  it('advance is a no-op when no baseline exists for the pair', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'v1\n');
    await store.advance('s1', file);
    expect(store.get('s1', file)).toBeUndefined();
  });

  it('clearSession drops every baseline for a session only', async () => {
    const a = path.join(dir, 'a.ts');
    const b = path.join(dir, 'b.ts');
    await fs.writeFile(a, 'a\n');
    await fs.writeFile(b, 'b\n');
    await store.captureFromDisk('s1', a);
    await store.captureFromDisk('s2', b);
    store.clearSession('s1');
    expect(store.get('s1', a)).toBeUndefined();
    expect(store.get('s2', b)?.bytes.toString('utf8')).toBe('b\n');
  });

  it('listPending returns only paths whose baseline differs from disk', async () => {
    const changed = path.join(dir, 'changed.ts');
    const same = path.join(dir, 'same.ts');
    await fs.writeFile(changed, 'v1\n');
    await fs.writeFile(same, 'same\n');
    await store.captureFromDisk('s1', changed);
    await store.captureFromDisk('s1', same);
    await fs.writeFile(changed, 'v2\n');
    const pending = await store.listPending('s1');
    expect(pending).toContain(changed);
    expect(pending).not.toContain(same);
  });

  it('captureFromToolInput reconstructs the pre-image from an Edit (Fallback A)', async () => {
    const file = path.join(dir, 'a.ts');
    // Post-edit disk content; the Edit swapped `1` for `2`.
    await fs.writeFile(file, 'const a = 2;\n');
    await store.captureFromToolInput('s1', file, 'Edit', {
      file_path: file,
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
    expect(store.get('s1', file)?.bytes.toString('utf8')).toBe('const a = 1;\n');
    expect(store.get('s1', file)?.capturedFrom).toBe('reconstructed');
  });

  it('captureFromToolInput is a no-op for a non-reversible Write', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'whatever\n');
    await store.captureFromToolInput('s1', file, 'Write', {
      file_path: file,
      content: 'whatever\n',
    });
    expect(store.get('s1', file)).toBeUndefined();
  });
  it('stores an oversize marker (no bytes) for a file past the text cap', async () => {
    const file = path.join(dir, 'huge.txt');
    // Sparse-extend past the 5 MB cap without materializing the bytes.
    const handle = await fs.open(file, 'w');
    await handle.truncate(FILE_LIMITS.MAX_TEXT_FILE_BYTES + 1);
    await handle.close();

    await store.captureFromDisk('s1', file);
    const baseline = store.get('s1', file);
    expect(baseline?.oversize).toBe(true);
    // The pre-image was deliberately NOT buffered.
    expect(baseline?.bytes.length).toBe(0);
  });

  it('an oversize entry is always pending (agent touched it; bytes are uncomparable)', async () => {
    const file = path.join(dir, 'huge.txt');
    const handle = await fs.open(file, 'w');
    await handle.truncate(FILE_LIMITS.MAX_TEXT_FILE_BYTES + 1);
    await handle.close();

    await store.captureFromDisk('s1', file);
    expect(await store.listPending('s1')).toContain(file);
  });

  it('skips capture for a directory target (falls back to the resolve ladder)', async () => {
    const sub = path.join(dir, 'subdir');
    await fs.mkdir(sub);
    expect(await store.captureFromDisk('s1', sub)).toBe(false);
    expect(store.get('s1', sub)).toBeUndefined();
  });

  it('enforces the per-session byte budget by evicting the OLDEST baselines', async () => {
    const budgeted = new EditBaselineStore(10);
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    await fs.writeFile(a, 'aaaaaa'); // 6 bytes
    await fs.writeFile(b, 'bbbbbb'); // 6 bytes -> 12 total, over the 10-byte budget

    await budgeted.captureFromDisk('s1', a);
    // Ensure a strictly later capturedAt for the second capture.
    await new Promise((r) => setTimeout(r, 2));
    await budgeted.captureFromDisk('s1', b);

    // The oldest (a) was evicted; the newest (b) survives.
    expect(budgeted.get('s1', a)).toBeUndefined();
    expect(budgeted.get('s1', b)?.bytes.toString('utf8')).toBe('bbbbbb');
  });

  it('budget accounting survives advance (replaced bytes are re-counted, not leaked)', async () => {
    const budgeted = new EditBaselineStore(20);
    const a = path.join(dir, 'a.txt');
    await fs.writeFile(a, 'aaaaaaaaaaaaaaa'); // 15 bytes
    await budgeted.captureFromDisk('s1', a);

    // Shrink the file, advance -- accounting drops to 3 bytes, so a later
    // 15-byte capture fits without evicting `a`.
    await fs.writeFile(a, 'aaa');
    await budgeted.advance('s1', a);

    const b = path.join(dir, 'b.txt');
    await fs.writeFile(b, 'bbbbbbbbbbbbbbb'); // 15 bytes -> 18 total <= 20
    await budgeted.captureFromDisk('s1', b);

    expect(budgeted.get('s1', a)?.bytes.toString('utf8')).toBe('aaa');
    expect(budgeted.get('s1', b)?.bytes.toString('utf8')).toBe('bbbbbbbbbbbbbbb');
  });
});
