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
// Which Codex home a thread lives in decides where its rollout is read from.
const onCredits = vi.hoisted(() => ({ value: false }));
vi.mock('../credits-launch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../credits-launch.js')>()),
  threadRunsOnCredits: async () => onCredits.value,
}));
vi.mock('../codex-home.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex-home.js')>()),
  creditsCodexHome: () => '/dork/runtimes/codex/credits',
}));
vi.mock('../check-dependencies.js', () => ({
  checkCodexDependencies: vi.fn(() => []),
  resolveCodexBinaryPath: vi.fn(async () => '/bin/codex'),
}));

describe('CodexRuntime.readContextUsage', () => {
  let threadMap: CodexThreadMap;
  let runtime: CodexRuntime;

  beforeEach(() => {
    readCodexTurnContextUsage.mockReset();
    onCredits.value = false;
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
    expect(options.codexHome).toBeUndefined();
  });

  it('reads a credits thread’s rollout from the credits home', async () => {
    threadMap.setThreadId('s1', '01a082ce-2b72-71d2-be38-aa8425f13650');
    onCredits.value = true;
    readCodexTurnContextUsage.mockResolvedValue(null);
    await runtime.readContextUsage('s1', undefined);
    const [options] = readCodexTurnContextUsage.mock.calls[0]!;
    expect(options.codexHome).toBe('/dork/runtimes/codex/credits');
  });

  it('answers null for a session that never started a thread', async () => {
    await expect(runtime.readContextUsage('never', undefined)).resolves.toBeNull();
    expect(readCodexTurnContextUsage).not.toHaveBeenCalled();
  });
});
