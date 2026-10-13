import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, appendFile, copyFile, unlink, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const { getSessionInfo } = vi.hoisted(() => ({
  getSessionInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo }));
vi.mock('../../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue(undefined),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue(undefined),
}));

import { TranscriptReader } from '../../transcript-reader.js';

/**
 * Finding a session by id costs one walk of the accounts, not one per read
 * (DOR-2892). A chat opening used to walk every account's project folders up
 * to four times (detail, history, tasks, stream), about two hundred folders
 * each on a busy machine, and re-read the transcript's head and tail for every
 * detail fetch.
 *
 * The real filesystem and slug computation are used; only the SDK title lookup
 * and the boundary are stubbed. The count of transcript metadata reads is the
 * measurement: a walk opens one candidate per project folder.
 */
describe('TranscriptReader finds a session by id without re-walking', () => {
  const ORIGINAL = {
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  let tmp: string;
  let accountA: string;
  let accountB: string;
  let reader: TranscriptReader;
  let nextId = 0;
  let metaReads: ReturnType<typeof vi.spyOn>;

  async function seedSession(account: string, cwd: string): Promise<string> {
    nextId += 1;
    const sessionId = `bbbbbbbb-0000-4000-8000-${String(nextId).padStart(12, '0')}`;
    await mkdir(cwd, { recursive: true });
    const slugDir = join(account, 'projects', reader.getProjectSlug(cwd));
    await mkdir(slugDir, { recursive: true });
    await writeFile(
      join(slugDir, `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `working in ${cwd}` },
        timestamp: '2026-07-01T00:00:00.000Z',
        cwd,
      }) + '\n'
    );
    return sessionId;
  }

  /** Ten unrelated project folders, so a walk is visibly more than a probe. */
  async function seedNoise(account: string): Promise<void> {
    for (let i = 0; i < 10; i += 1) await seedSession(account, join(tmp, `noise-${i}`));
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'claude-locator-'));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    accountA = join(tmp, 'claude-active');
    accountB = join(tmp, '.claude');
    await mkdir(join(accountA, 'projects'), { recursive: true });
    await mkdir(join(accountB, 'projects'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = accountA;
    reader = new TranscriptReader();
    nextId = 0;
    getSessionInfo.mockClear();
    metaReads = vi.spyOn(reader as never, 'cachedMeta');
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['CLAUDE_CONFIG_DIR', ORIGINAL.configDir],
      ['HOME', ORIGINAL.home],
      ['USERPROFILE', ORIGINAL.userProfile],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('walks once, then reads only the remembered transcript', async () => {
    await seedNoise(accountA);
    const cwd = join(tmp, 'project');
    const id = await seedSession(accountB, cwd);

    await expect(reader.findSession(id)).resolves.toMatchObject({ id, cwd });
    // One candidate per project folder: ten noise folders plus the session's.
    expect(metaReads).toHaveBeenCalledTimes(11);

    metaReads.mockClear();
    await expect(reader.findSession(id)).resolves.toMatchObject({ id, cwd });
    expect(metaReads).toHaveBeenCalledTimes(1);
  });

  it('checks the caller’s directory in each account before any walk', async () => {
    await seedNoise(accountA);
    const cwd = join(tmp, 'hinted');
    const id = await seedSession(accountB, cwd);

    await expect(reader.findSession(id, { cwdHint: cwd })).resolves.toMatchObject({ id, cwd });
    // One probe per account (two here), never one per project folder.
    expect(metaReads).toHaveBeenCalledTimes(2);
  });

  it('answers with the recorded directory when the hint is wrong', async () => {
    const cwd = join(tmp, 'real');
    const wrong = join(tmp, 'elsewhere');
    await mkdir(wrong, { recursive: true });
    const id = await seedSession(accountA, cwd);

    await expect(reader.findSession(id, { cwdHint: wrong })).resolves.toMatchObject({ id, cwd });
  });

  it('forgets a remembered transcript once it is deleted', async () => {
    const cwd = join(tmp, 'gone');
    const id = await seedSession(accountA, cwd);
    await expect(reader.findSession(id)).resolves.toMatchObject({ id });

    await unlink(join(accountA, 'projects', reader.getProjectSlug(cwd), `${id}.jsonl`));
    await expect(reader.findSession(id)).resolves.toBeNull();
  });

  it('still refuses an id two accounts hold under the hinted project', async () => {
    const cwd = join(tmp, 'twice');
    const id = await seedSession(accountA, cwd);
    const slug = reader.getProjectSlug(cwd);
    await mkdir(join(accountB, 'projects', slug), { recursive: true });
    await copyFile(
      join(accountA, 'projects', slug, `${id}.jsonl`),
      join(accountB, 'projects', slug, `${id}.jsonl`)
    );
    await expect(reader.findSession(id, { cwdHint: cwd })).rejects.toMatchObject({
      code: 'SESSION_ID_AMBIGUOUS',
    });
  });

  it('never lets a directory a caller passed to getSession become the answer', async () => {
    // A head with no cwd: an oversized first record pushes it past the head read.
    // Two folders whose names share one project slug (`a/b` and `a-b`).
    const cwd = join(tmp, 'a', 'b');
    const other = join(tmp, 'a-b');
    await mkdir(cwd, { recursive: true });
    await mkdir(other, { recursive: true });
    expect(reader.getProjectSlug(other)).toBe(reader.getProjectSlug(cwd));
    const slugDir = join(accountA, 'projects', reader.getProjectSlug(cwd));
    await mkdir(slugDir, { recursive: true });
    const id = 'cccccccc-0000-4000-8000-000000000001';
    await writeFile(
      join(slugDir, `${id}.jsonl`),
      JSON.stringify({ type: 'file-history-snapshot', data: 'x'.repeat(300_000) }) +
        '\n' +
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, cwd }) +
        '\n'
    );

    // getSession attributes the head-less transcript to the folder it was asked about…
    await expect(reader.getSession(other, id)).resolves.toMatchObject({ cwd: other });
    await expect(reader.getSession(other, id)).resolves.toMatchObject({ cwd: other });
    // …and that attribution must not leak into the id lookup's answer.
    await expect(reader.findSession(id)).resolves.toMatchObject({ id, cwd });
    await expect(reader.findSession(id)).resolves.toMatchObject({ id, cwd });
  });

  it('stops answering from an account that is no longer configured', async () => {
    const cwd = join(tmp, 'dropped');
    const id = await seedSession(accountA, cwd);
    await expect(reader.findSession(id)).resolves.toMatchObject({ id });

    // The active account changes to a folder that does not hold the session.
    const accountC = join(tmp, 'claude-other');
    await mkdir(join(accountC, 'projects'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = accountC;
    await expect(reader.findSession(id)).resolves.toBeNull();
  });

  it('serves a repeat getSession from the metadata cache until the transcript changes', async () => {
    const cwd = join(tmp, 'detail');
    const id = await seedSession(accountA, cwd);

    await reader.getSession(cwd, id);
    await reader.getSession(cwd, id);
    // The SDK title lookup runs once per metadata extraction (active account).
    expect(getSessionInfo).toHaveBeenCalledTimes(1);

    const file = join(accountA, 'projects', reader.getProjectSlug(cwd), `${id}.jsonl`);
    await appendFile(file, JSON.stringify({ type: 'ai-title', aiTitle: 'Renamed' }) + '\n');
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    await expect(reader.getSession(cwd, id)).resolves.toMatchObject({ title: 'Renamed' });
    expect(getSessionInfo).toHaveBeenCalledTimes(2);
  });
});
