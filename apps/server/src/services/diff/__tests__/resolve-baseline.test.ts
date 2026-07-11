import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveTextBaseline } from '../resolve-baseline.js';
import { editBaselineStore } from '../edit-baseline.js';

const execFileAsync = promisify(execFile);
const SESSION = 'resolve-sess';

/** Initialize a throwaway git repo with one committed file. */
async function initGitRepo(dir: string, file: string, content: string): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, file), content);
  await execFileAsync('git', ['add', file], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

describe('resolveTextBaseline — resolution ladder', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-')));
  });
  afterEach(async () => {
    editBaselineStore.clearSession(SESSION);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('prefers the session snapshot over HEAD', async () => {
    const file = path.join(dir, 'a.ts');
    await initGitRepo(dir, 'a.ts', 'HEAD version\n');
    await fs.writeFile(file, 'snapshot version\n');
    await editBaselineStore.captureFromDisk(SESSION, file);
    await fs.writeFile(file, 'current version\n');

    const res = await resolveTextBaseline(dir, file, SESSION, 'session');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.baseline).toBe('snapshot version\n');
    expect(res.response.current).toBe('current version\n');
    expect(res.response.capturedFrom).toBe('pre-tool');
  });

  it('falls back to git HEAD when no snapshot exists', async () => {
    const file = path.join(dir, 'a.ts');
    await initGitRepo(dir, 'a.ts', 'HEAD version\n');
    await fs.writeFile(file, 'current version\n');

    const res = await resolveTextBaseline(dir, file, SESSION, 'session');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.baseline).toBe('HEAD version\n');
    expect(res.response.capturedFrom).toBe('head');
  });

  it('falls back to an empty base for an untracked, unsnapshotted file (Write-first)', async () => {
    const file = path.join(dir, 'untracked.ts');
    await initGitRepo(dir, 'other.ts', 'x\n');
    await fs.writeFile(file, 'brand new\n');

    const res = await resolveTextBaseline(dir, file, SESSION, 'session');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.baseline).toBe('');
    expect(res.response.capturedFrom).toBe('empty');
  });

  it('mode=head forces the git-HEAD compare even when a snapshot exists', async () => {
    const file = path.join(dir, 'a.ts');
    await initGitRepo(dir, 'a.ts', 'HEAD version\n');
    await fs.writeFile(file, 'snapshot version\n');
    await editBaselineStore.captureFromDisk(SESSION, file);
    await fs.writeFile(file, 'current version\n');

    const res = await resolveTextBaseline(dir, file, SESSION, 'head');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.baseline).toBe('HEAD version\n');
    expect(res.response.capturedFrom).toBe('head');
  });

  it('rejects a binary file (BINARY_FILE)', async () => {
    const file = path.join(dir, 'logo.bin');
    await fs.writeFile(file, Buffer.from([0x00, 0x01, 0x00]));
    const res = await resolveTextBaseline(dir, file, SESSION, 'session');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('BINARY_FILE');
  });

  it('treats a deleted file as a full removal (empty current)', async () => {
    const file = path.join(dir, 'gone.ts');
    await initGitRepo(dir, 'gone.ts', 'was here\n');
    await fs.rm(file);
    const res = await resolveTextBaseline(dir, file, SESSION, 'session');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.response.current).toBe('');
    expect(res.response.baseline).toBe('was here\n');
  });
});
