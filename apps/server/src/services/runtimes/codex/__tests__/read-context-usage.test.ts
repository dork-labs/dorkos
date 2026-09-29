/**
 * `CodexRuntime.readContextUsage`: a session opened with no stored context
 * reading takes its rollout's last `token_count` (spec `claude-account-fleet`
 * §6 U), found through the session's bound thread.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { CodexRuntime } from '../codex-runtime.js';
import { CodexThreadMap } from '../thread-map.js';

const readCodexTurnContextUsage = vi.hoisted(() => vi.fn());
vi.mock('../turn-context-usage.js', () => ({ readCodexTurnContextUsage }));
vi.mock('../check-dependencies.js', () => ({
  checkCodexDependencies: vi.fn(() => []),
  resolveCodexBinaryPath: vi.fn(async () => '/bin/codex'),
}));

describe('CodexRuntime.readContextUsage', () => {
  let threadMap: CodexThreadMap;
  let runtime: CodexRuntime;

  beforeEach(() => {
    readCodexTurnContextUsage.mockReset();
    threadMap = new CodexThreadMap(createTestDb());
    runtime = new CodexRuntime({ threadMap, resolveBinary: async () => '/bin/codex' });
  });

  it("reads the bound thread's rollout at rest (no live-turn bound)", async () => {
    threadMap.setThreadId('s1', '01a082ce-2b72-71d2-be38-aa8425f13650');
    readCodexTurnContextUsage.mockResolvedValue({
      contextTokens: 9_000,
      contextMaxTokens: 258_400,
    });

    await expect(runtime.readContextUsage('s1', undefined)).resolves.toEqual({
      contextTokens: 9_000,
      contextMaxTokens: 258_400,
    });
    const [options] = readCodexTurnContextUsage.mock.calls[0]!;
    expect(options).toMatchObject({ threadId: '01a082ce-2b72-71d2-be38-aa8425f13650' });
    expect(options.turnStartedAtMs).toBeUndefined();
  });

  it('answers null for a session that never started a thread', async () => {
    await expect(runtime.readContextUsage('never', undefined)).resolves.toBeNull();
    expect(readCodexTurnContextUsage).not.toHaveBeenCalled();
  });
});
