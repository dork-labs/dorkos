import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'fs/promises';
import fs from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Hoisted holder so the config-dir mock can be pointed at a per-test temp dir.
const hoisted = vi.hoisted(() => ({ configDir: '' }));

// The SDK title lookup is irrelevant to hidden-session filtering; stub it so
// extraction falls back to the first-message title with no real SDK I/O.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getSessionInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../claude-config-dir.js', () => ({
  resolveClaudeConfigDir: () => hoisted.configDir,
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue(undefined),
}));

import { TranscriptReader } from '../transcript-reader.js';
import { TRANSCRIPT } from '../../../../../config/constants.js';

/** A realistic head/user JSONL line carrying title, cwd, and a timestamp. */
function userLine(text = 'hello', cwd = '/work/hidden', isSidechain?: boolean): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: '2026-07-01T00:00:00.000Z',
    cwd,
    ...(isSidechain !== undefined ? { isSidechain } : {}),
  });
}

/** An assistant JSONL line carrying a model, matching a normal turn. */
function assistantLine(): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-4-6' },
    timestamp: '2026-07-01T00:05:00.000Z',
  });
}

/**
 * A non-conversational bookkeeping record — the shape observed in the wild
 * for phantom "empty" sessions (queue-operation, mode, last-prompt,
 * custom-title, …). Never `user` or `assistant`, so it never counts toward
 * `sawConversation`.
 */
function bookkeepingLine(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, timestamp: '2026-07-01T00:00:00.000Z', ...extra });
}

/** A filler bookkeeping line padded to a fixed byte size, for oversized fixtures. */
function paddedBookkeepingLine(index: number, padTo: number): string {
  const base = { type: 'queue-operation', op: 'noop', index };
  const json = JSON.stringify(base);
  const padding = 'x'.repeat(Math.max(0, padTo - json.length));
  return JSON.stringify({ ...base, pad: padding });
}

async function writeTranscript(dir: string, sessionId: string, lines: string[]): Promise<string> {
  const filePath = join(dir, `${sessionId}.jsonl`);
  await writeFile(filePath, lines.join('\n') + '\n');
  return filePath;
}

describe('TranscriptReader hidden-session filtering (DOR-410)', () => {
  let reader: TranscriptReader;
  let dir: string;

  beforeEach(async () => {
    reader = new TranscriptReader();
    dir = await mkdtemp(join(tmpdir(), 'transcript-hidden-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('confirms the configured head buffer size the size guard relies on', () => {
    // Purpose: the oversized-fixture test below manufactures a file larger
    // than this constant; pin the value so a future tuning of the constant
    // fails loudly here instead of silently breaking that fixture's premise.
    expect(TRANSCRIPT.HEAD_BUFFER_BYTES).toBe(8192);
  });

  it('excludes a whole-file sidechain (subagent) transcript from the list', async () => {
    await writeTranscript(dir, 'sess-sidechain', [
      userLine('do the subtask', '/work/hidden', true),
      assistantLine(),
    ]);

    const sessions = await reader.listSessionsInDir(dir);
    expect(sessions.find((s) => s.id === 'sess-sidechain')).toBeUndefined();
  });

  it('excludes a small transcript containing only non-conversational bookkeeping records', async () => {
    // Purpose: the real-world "phantom Session 3f2a…" row — a ~1KB transcript
    // with queue-operation/mode/last-prompt/custom-title records and zero
    // user/assistant turns.
    await writeTranscript(dir, 'sess-empty', [
      bookkeepingLine('queue-operation', { op: 'enqueue' }),
      bookkeepingLine('mode', { mode: 'default' }),
      bookkeepingLine('last-prompt', { prompt: 'unused' }),
      bookkeepingLine('custom-title', { title: 'untitled' }),
    ]);

    const sessions = await reader.listSessionsInDir(dir);
    expect(sessions.find((s) => s.id === 'sess-empty')).toBeUndefined();
  });

  it('still lists a normal session with a real user/assistant exchange', async () => {
    await writeTranscript(dir, 'sess-normal', [userLine('what is the plan?'), assistantLine()]);

    const sessions = await reader.listSessionsInDir(dir);
    const session = sessions.find((s) => s.id === 'sess-normal');
    expect(session).toBeDefined();
    expect(session?.title).toBe('what is the plan?');
  });

  it('still lists an oversized transcript with no user message inside the head buffer (provable-emptiness size guard)', async () => {
    // Purpose: emptiness is only provable when the WHOLE file fit inside the
    // head read. A transcript larger than HEAD_BUFFER_BYTES whose head sample
    // never encounters a user/assistant record must NOT be hidden — otherwise
    // this would regress the oversized-head attribution behavior (ADR
    // 260707-193314).
    const padTo = 220;
    const lineCount = Math.ceil((TRANSCRIPT.HEAD_BUFFER_BYTES * 1.5) / padTo);
    const lines = Array.from({ length: lineCount }, (_, i) => paddedBookkeepingLine(i, padTo));

    const filePath = await writeTranscript(dir, 'sess-oversized', lines);
    const size = (await fs.stat(filePath)).size;
    expect(size).toBeGreaterThan(TRANSCRIPT.HEAD_BUFFER_BYTES);

    const sessions = await reader.listSessionsInDir(dir);
    expect(sessions.find((s) => s.id === 'sess-oversized')).toBeDefined();
  });

  it('getSession still returns a hidden (sidechain) session when fetched directly by id', async () => {
    const vaultRoot = '/work/hidden-getsession';
    const slug = vaultRoot.replace(/[^a-zA-Z0-9-]/g, '-');
    hoisted.configDir = dir;
    const projectDir = join(dir, 'projects', slug);
    await mkdir(projectDir, { recursive: true });
    await writeTranscript(projectDir, 'sess-hidden-direct', [
      userLine('subtask via getSession', vaultRoot, true),
      assistantLine(),
    ]);

    // Confirm it is indeed excluded from the list...
    const listed = await reader.listSessionsInDir(projectDir);
    expect(listed.find((s) => s.id === 'sess-hidden-direct')).toBeUndefined();

    // ...yet still resolvable by id — getSession is deliberately unfiltered.
    const session = await reader.getSession(vaultRoot, 'sess-hidden-direct');
    expect(session?.id).toBe('sess-hidden-direct');
  });

  it('re-surfaces a previously-empty transcript once it gains a user message (mtime cache invalidation)', async () => {
    const filePath = await writeTranscript(dir, 'sess-fills-in', [
      bookkeepingLine('queue-operation', { op: 'enqueue' }),
      bookkeepingLine('mode', { mode: 'default' }),
    ]);

    const firstList = await reader.listSessionsInDir(dir);
    expect(firstList.find((s) => s.id === 'sess-fills-in')).toBeUndefined();

    // Same mtime, second call: still cached as hidden, no re-read of the file.
    const openSpy = vi.spyOn(fs, 'open');
    const secondList = await reader.listSessionsInDir(dir);
    expect(secondList.find((s) => s.id === 'sess-fills-in')).toBeUndefined();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();

    // The transcript gains a real turn and its mtime advances.
    await writeFile(
      filePath,
      [
        bookkeepingLine('queue-operation', { op: 'enqueue' }),
        bookkeepingLine('mode', { mode: 'default' }),
        userLine('now there is a real message'),
        assistantLine(),
      ].join('\n') + '\n'
    );
    await utimes(filePath, new Date(), new Date(Date.now() + 10_000));

    const thirdList = await reader.listSessionsInDir(dir);
    const session = thirdList.find((s) => s.id === 'sess-fills-in');
    expect(session).toBeDefined();
    expect(session?.title).toBe('now there is a real message');
  });
});
