/**
 * Pre-tool baseline-capture dispatch (DOR-212).
 *
 * `createEditBaselineCapture` is the ONE preflight both pre-tool seams share
 * (the SDK PreToolUse hook and the `canUseTool` gate). A regression here
 * silently degrades every diff to the fallback base, so the dispatch itself is
 * pinned: edit-family tools capture (relative paths resolved against the
 * session cwd), non-edit tools never touch the store, and a failed disk
 * snapshot falls back to reconstruction from the tool input.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createEditBaselineCapture } from '../message-sender.js';
import { editBaselineStore } from '../../../../diff/index.js';

const SESSION = 'capture-sess';

describe('createEditBaselineCapture', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-'));
  });
  afterEach(async () => {
    editBaselineStore.clearSession(SESSION);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(['Edit', 'Write', 'MultiEdit'])(
    'captures the pre-image for a %s tool call (absolute path)',
    async (toolName) => {
      const file = path.join(dir, 'a.ts');
      await fs.writeFile(file, 'pre-edit\n');
      const capture = createEditBaselineCapture(SESSION, dir);

      await capture(toolName, { file_path: file });

      expect(editBaselineStore.get(SESSION, file)?.bytes.toString('utf8')).toBe('pre-edit\n');
      expect(editBaselineStore.get(SESSION, file)?.capturedFrom).toBe('pre-tool');
    }
  );

  it('captures for NotebookEdit via notebook_path', async () => {
    const file = path.join(dir, 'nb.ipynb');
    await fs.writeFile(file, '{"cells":[]}\n');
    const capture = createEditBaselineCapture(SESSION, dir);

    await capture('NotebookEdit', { notebook_path: file });

    expect(editBaselineStore.has(SESSION, file)).toBe(true);
  });

  it('resolves a relative file_path against the session cwd', async () => {
    const file = path.join(dir, 'src', 'a.ts');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'relative\n');
    const capture = createEditBaselineCapture(SESSION, dir);

    await capture('Edit', { file_path: 'src/a.ts' });

    expect(editBaselineStore.get(SESSION, file)?.bytes.toString('utf8')).toBe('relative\n');
  });

  it('never captures for a non-edit tool', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'content\n');
    const capture = createEditBaselineCapture(SESSION, dir);

    await capture('Bash', { command: `cat ${file}`, file_path: file });
    await capture('Read', { file_path: file });
    await capture('Grep', { pattern: 'x', path: file });

    expect(editBaselineStore.has(SESSION, file)).toBe(false);
  });

  it('is a no-op when the input carries no file path', async () => {
    const capture = createEditBaselineCapture(SESSION, dir);
    await expect(capture('Edit', {})).resolves.toBeUndefined();
  });

  it('first-touch-wins: a second edit to the same file keeps the first baseline', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'v1\n');
    const capture = createEditBaselineCapture(SESSION, dir);

    await capture('Edit', { file_path: file });
    await fs.writeFile(file, 'v2\n'); // the edit landed
    await capture('Edit', { file_path: file }); // hook + canUseTool double-fire

    expect(editBaselineStore.get(SESSION, file)?.bytes.toString('utf8')).toBe('v1\n');
  });

  it('falls back to reconstruction when the disk snapshot fails (directory target)', async () => {
    // A directory target makes captureFromDisk return false; the reconstruct
    // fallback then also declines (it stats a non-file) — the point pinned here
    // is that the dispatch tries the ladder and never throws into the tool path.
    const sub = path.join(dir, 'subdir');
    await fs.mkdir(sub);
    const capture = createEditBaselineCapture(SESSION, dir);

    await expect(capture('Edit', { file_path: sub })).resolves.toBeUndefined();
    expect(editBaselineStore.has(SESSION, sub)).toBe(false);
  });
});
