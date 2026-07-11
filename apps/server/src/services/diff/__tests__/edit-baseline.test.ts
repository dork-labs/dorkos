import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditBaselineStore } from '../edit-baseline.js';

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
});
