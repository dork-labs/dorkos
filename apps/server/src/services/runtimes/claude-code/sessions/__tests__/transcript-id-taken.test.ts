/**
 * `transcriptIdTaken` finds an id in any project folder of any account
 * (DOR-2712), so a new session is never launched under an id a transcript
 * already has.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => ({ value: [] as string[] }));
vi.mock('../../claude-config-dir.js', () => ({
  resolveClaudeRootSet: () => roots.value,
}));

import { transcriptIdTaken } from '../session-root-index.js';

const ID = '7c5bd7f6-c9f7-4aa8-93e4-fb6569782567';
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-id-taken-'));
  roots.value = [path.join(tmp, 'account-a'), path.join(tmp, 'account-b')];
  await fs.mkdir(path.join(tmp, 'account-a', 'projects', '-some-project'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('transcriptIdTaken', () => {
  it('is false when no account has the id', async () => {
    expect(await transcriptIdTaken(ID)).toBe(false);
  });

  it('finds the id in another project folder of a second account', async () => {
    const dir = path.join(tmp, 'account-b', 'projects', '-another-folder');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${ID}.jsonl`), '');

    expect(await transcriptIdTaken(ID)).toBe(true);
  });
});
