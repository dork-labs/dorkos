import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveBaselineBytes, revertToBaseline } from '../baseline-bytes.js';
import { editBaselineStore } from '../edit-baseline.js';

const execFileAsync = promisify(execFile);
const SESSION = 'bytes-sess';

/** A tiny valid PNG header + payload — enough to assert binary fidelity. */
const PNG_V1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PNG_V2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);

/** Initialize a throwaway git repo with one committed file. */
async function initGitRepo(dir: string, file: string, content: Buffer): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, file), content);
  await execFileAsync('git', ['add', file], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('resolveBaselineBytes / revertToBaseline', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bytes-')));
  });
  afterEach(async () => {
    editBaselineStore.clearSession(SESSION);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('resolves the snapshot bytes byte-for-byte (binary-safe)', async () => {
    const file = path.join(dir, 'logo.png');
    await fs.writeFile(file, PNG_V1);
    await editBaselineStore.captureFromDisk(SESSION, file);
    await fs.writeFile(file, PNG_V2); // the agent's edit landed

    const baseline = await resolveBaselineBytes(dir, file, SESSION);
    expect(baseline?.origin).toBe('pre-tool');
    expect(baseline?.bytes.equals(PNG_V1)).toBe(true);
  });

  it('falls back to git-HEAD bytes when no snapshot exists', async () => {
    const file = path.join(dir, 'logo.png');
    await initGitRepo(dir, 'logo.png', PNG_V1);
    await fs.writeFile(file, PNG_V2);

    const baseline = await resolveBaselineBytes(dir, file, SESSION);
    expect(baseline?.origin).toBe('head');
    expect(baseline?.bytes.equals(PNG_V1)).toBe(true);
  });

  it('skips an oversize snapshot marker (falls to HEAD), never its empty bytes', async () => {
    const file = path.join(dir, 'logo.png');
    await initGitRepo(dir, 'logo.png', PNG_V1);
    editBaselineStore.set(SESSION, file, {
      bytes: Buffer.alloc(0),
      capturedAt: Date.now(),
      capturedFrom: 'pre-tool',
      oversize: true,
    });
    await fs.writeFile(file, PNG_V2);

    const baseline = await resolveBaselineBytes(dir, file, SESSION);
    expect(baseline?.origin).toBe('head');
    expect(baseline?.bytes.equals(PNG_V1)).toBe(true);
  });

  it('returns null when there is no snapshot and no git history', async () => {
    const file = path.join(dir, 'logo.png');
    await fs.writeFile(file, PNG_V2);
    expect(await resolveBaselineBytes(dir, file, SESSION)).toBeNull();
  });

  it('revert restores the snapshot bytes to disk byte-for-byte', async () => {
    const file = path.join(dir, 'logo.png');
    await fs.writeFile(file, PNG_V1);
    await editBaselineStore.captureFromDisk(SESSION, file);
    await fs.writeFile(file, PNG_V2);

    expect(await revertToBaseline(dir, file, SESSION)).toBe('ok');
    expect((await fs.readFile(file)).equals(PNG_V1)).toBe(true);
  });

  it('revert refuses when no baseline exists (never deletes or empties)', async () => {
    const file = path.join(dir, 'logo.png');
    await fs.writeFile(file, PNG_V2);

    expect(await revertToBaseline(dir, file, SESSION)).toBe('no-baseline');
    // Disk untouched.
    expect((await fs.readFile(file)).equals(PNG_V2)).toBe(true);
  });

  it('revert refuses an empty baseline (a file the agent created this session)', async () => {
    const file = path.join(dir, 'logo.png');
    // Write-first capture of a not-yet-existing file stores an empty pre-image.
    await editBaselineStore.captureFromDisk(SESSION, file);
    await fs.writeFile(file, PNG_V2);

    expect(await revertToBaseline(dir, file, SESSION)).toBe('no-baseline');
    expect((await fs.readFile(file)).equals(PNG_V2)).toBe(true);
  });
});
