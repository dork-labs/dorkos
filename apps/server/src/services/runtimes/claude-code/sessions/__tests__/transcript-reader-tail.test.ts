import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'fs/promises';
import fs from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Hoisted holder so the config-dir mock can be pointed at a per-test temp dir.
const hoisted = vi.hoisted(() => ({ configDir: '' }));

// The SDK title lookup is irrelevant to the tail read; stub it so extraction
// falls back to the first-message title with no real SDK I/O.
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

/** A realistic head/user JSONL line carrying title, cwd, and a timestamp. */
function userLine(text = 'hello', cwd = '/work/ctx'): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: '2026-07-01T00:00:00.000Z',
    cwd,
  });
}

/** An assistant JSONL line carrying a model and a usage breakdown. */
function assistantLine(usage?: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-opus-4-6', ...(usage ? { usage } : {}) },
    timestamp: '2026-07-01T00:05:00.000Z',
  });
}

/** A `compact_boundary` system record with the given trigger + timestamp. */
function compactBoundaryLine(trigger: 'auto' | 'manual', timestamp: string): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger, preTokens: 100_000, postTokens: 20_000 },
    timestamp,
  });
}

async function writeTranscript(dir: string, sessionId: string, lines: string[]): Promise<string> {
  const filePath = join(dir, `${sessionId}.jsonl`);
  await writeFile(filePath, lines.join('\n') + '\n');
  return filePath;
}

describe('TranscriptReader tail read on the list path (fleet-context-health)', () => {
  let reader: TranscriptReader;
  let dir: string;

  beforeEach(async () => {
    reader = new TranscriptReader();
    dir = await mkdtemp(join(tmpdir(), 'transcript-tail-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('carries contextTokens from a tail whose last turn has usage', async () => {
    // Purpose: a closed-tab claude-code session must reach the list wire with a
    // best-effort reading summed by sumContextTokens (input + cache-read +
    // cache-creation).
    await writeTranscript(dir, 'sess-usage', [
      userLine(),
      assistantLine({
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 25,
      }),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.id).toBe('sess-usage');
    expect(session?.contextTokens).toBe(175);
  });

  it('derives lastAutoCompactAt from an auto-triggered compact_boundary in the tail', async () => {
    // Purpose: an auto-compaction visible in the readable tail drives the row's
    // discreet marker; its timestamp is the record's top-level timestamp.
    await writeTranscript(dir, 'sess-auto', [
      userLine(),
      compactBoundaryLine('auto', '2026-07-01T00:03:00.000Z'),
      assistantLine({ input_tokens: 10 }),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.lastAutoCompactAt).toBe('2026-07-01T00:03:00.000Z');
  });

  it('ignores a manual-only compaction (user-driven, not a pressure signal)', async () => {
    // Purpose: a manual compaction is deliberate housekeeping, not context
    // pressure — it must NOT populate the auto-compacted marker.
    await writeTranscript(dir, 'sess-manual', [
      userLine(),
      compactBoundaryLine('manual', '2026-07-01T00:03:00.000Z'),
      assistantLine({ input_tokens: 10 }),
    ]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.lastAutoCompactAt).toBeUndefined();
  });

  it('omits contextTokens when the tail has no usage (-> unknown downstream)', async () => {
    // Purpose: no readable token reading means an honest absent field, never a
    // fabricated 0 — the client renders "unknown".
    await writeTranscript(dir, 'sess-none', [userLine()]);

    const [session] = await reader.listSessionsInDir(dir);
    expect(session?.id).toBe('sess-none');
    expect(session?.contextTokens).toBeUndefined();
    expect(session?.lastAutoCompactAt).toBeUndefined();
  });

  it('serves an unchanged transcript from the mtime cache with no re-read, and re-reads after a bump', async () => {
    // Purpose: the added tail read is O(changed files) — a settled transcript
    // pays nothing beyond the fs.stat that keys the cache; only an mtime bump
    // (a new turn) re-opens the file.
    const filePath = await writeTranscript(dir, 'sess-cache', [
      userLine(),
      assistantLine({ input_tokens: 100 }),
    ]);
    const openSpy = vi.spyOn(fs, 'open');

    // First list: cache miss -> one head open + one tail open.
    await reader.listSessionsInDir(dir);
    expect(openSpy).toHaveBeenCalledTimes(2);

    // Second list, transcript untouched: cache hit -> no file opens at all.
    openSpy.mockClear();
    await reader.listSessionsInDir(dir);
    expect(openSpy).toHaveBeenCalledTimes(0);

    // Bump the mtime (a new turn appended): cache miss -> reads again.
    openSpy.mockClear();
    await utimes(filePath, new Date(), new Date(Date.now() + 10_000));
    await reader.listSessionsInDir(dir);
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it('getSession shares the single tail-read path and carries the same reading', async () => {
    // Purpose: getSession is now just extractSessionMeta (+ cwd attribution) —
    // no separate tail overlay — so a single-session read carries the exact same
    // contextTokens and auto-compaction marker the list row does.
    const vaultRoot = '/work/gs';
    const slug = vaultRoot.replace(/[^a-zA-Z0-9-]/g, '-');
    hoisted.configDir = dir;
    const projectDir = join(dir, 'projects', slug);
    await mkdir(projectDir, { recursive: true });
    await writeTranscript(projectDir, 'sess-gs', [
      userLine('gs', vaultRoot),
      compactBoundaryLine('auto', '2026-07-01T00:09:00.000Z'),
      assistantLine({ input_tokens: 200, cache_read_input_tokens: 40 }),
    ]);

    const session = await reader.getSession(vaultRoot, 'sess-gs');
    expect(session?.contextTokens).toBe(240);
    expect(session?.lastAutoCompactAt).toBe('2026-07-01T00:09:00.000Z');
  });
});
