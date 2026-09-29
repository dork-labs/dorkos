/**
 * `ClaudeCodeRuntime.readContextUsage`: a session opened with no stored context
 * reading takes the one its transcript tail already gives the session list
 * (spec `claude-account-fleet` §6 U). The tail read itself is pinned by
 * `sessions/__tests__/transcript-reader-tail.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '@dorkos/shared/types';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn(), renameSession: vi.fn() }));

import { TranscriptReader } from '../../../session/index.js';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';

function session(contextTokens?: number): Session {
  return {
    id: 's1',
    title: 't',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
}

describe('ClaudeCodeRuntime.readContextUsage', () => {
  let runtime: ClaudeCodeRuntime;

  beforeEach(() => {
    runtime = new ClaudeCodeRuntime('/tmp/dorkos-test', '/repo');
  });

  afterEach(() => vi.restoreAllMocks());

  it("answers the transcript tail's context tokens, with the window unknown", async () => {
    const read = vi.spyOn(TranscriptReader.prototype, 'getSession').mockResolvedValue(session(175));
    await expect(runtime.readContextUsage('s1', '/work/ctx')).resolves.toEqual({
      contextTokens: 175,
      contextMaxTokens: 0,
    });
    expect(read).toHaveBeenCalledWith('/work/ctx', 's1');
  });

  it('answers null when the tail has no usage, or the read fails', async () => {
    vi.spyOn(TranscriptReader.prototype, 'getSession').mockResolvedValueOnce(session());
    await expect(runtime.readContextUsage('s1', '/work/ctx')).resolves.toBeNull();
    vi.spyOn(TranscriptReader.prototype, 'getSession').mockRejectedValueOnce(new Error('gone'));
    await expect(runtime.readContextUsage('s1', '/work/ctx')).resolves.toBeNull();
  });
});
