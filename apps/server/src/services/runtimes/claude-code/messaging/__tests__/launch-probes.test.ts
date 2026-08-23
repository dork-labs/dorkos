/**
 * The launch probes are bounded (DOR-1301).
 *
 * Nobody awaits these four, which is exactly why an unanswered one is easy to
 * miss: a probe sent to a subprocess that can no longer hear DorkOS leaves a
 * promise nothing will settle, holding its query and closures for the life of
 * the server, once per probe per launch. The bound cannot produce an answer —
 * it ends the wait, and says so in the log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../../../lib/logger.js';
import { LAUNCH_PROBE_ACK_TIMEOUT_MS } from '../../sessions/bounded-control.js';
import { fireLaunchProbes } from '../launch-probes.js';
import type { MessageSenderOpts } from '../message-sender-shared.js';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Every probe hangs — the shape of a query whose stdin DorkOS has ended. */
function deafProbeQuery() {
  const forever = () => new Promise<never>(() => {});
  return {
    supportedModels: vi.fn(forever),
    mcpServerStatus: vi.fn(forever),
    supportedCommands: vi.fn(forever),
    supportedAgents: vi.fn(forever),
  };
}

/** Callbacks that would be called if any probe ever answered. */
function callbacks() {
  return {
    onModelsReceived: vi.fn(),
    onMcpStatusReceived: vi.fn(),
    onCommandsReceived: vi.fn(),
    onSubagentsReceived: vi.fn(),
  } as unknown as MessageSenderOpts;
}

describe('fireLaunchProbes is bounded (DOR-1301)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops waiting on every probe a deaf subprocess never answers', async () => {
    const query = deafProbeQuery();

    fireLaunchProbes(query as never, callbacks());
    expect(vi.mocked(logger.debug)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LAUNCH_PROBE_ACK_TIMEOUT_MS);

    // Four probes fired, four waits ended, each saying which one it was.
    const probed = vi
      .mocked(logger.debug)
      .mock.calls.map(([message]) => message)
      .sort();
    expect(probed).toEqual([
      '[launch-probes] failed to fetch MCP server status',
      '[launch-probes] failed to fetch supported agents',
      '[launch-probes] failed to fetch supported commands',
      '[launch-probes] failed to fetch supported models',
    ]);
    // Nothing was learned, so no cache was told anything.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets an answering subprocess populate the caches without waiting on any clock', async () => {
    const query = {
      supportedModels: vi.fn().mockResolvedValue([{ value: 'claude-opus-4-6' }]),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      supportedCommands: vi.fn().mockResolvedValue([{ name: 'flow', description: 'd' }]),
      supportedAgents: vi.fn().mockResolvedValue([{ name: 'reviewer', description: 'd' }]),
    };
    const opts = callbacks();

    fireLaunchProbes(query as never, opts);
    await vi.advanceTimersByTimeAsync(0);

    expect(opts.onModelsReceived).toHaveBeenCalledWith([{ value: 'claude-opus-4-6' }]);
    expect(opts.onCommandsReceived).toHaveBeenCalledTimes(1);
    expect(opts.onSubagentsReceived).toHaveBeenCalledTimes(1);
    // No clock is left running behind answers that already arrived.
    expect(vi.getTimerCount()).toBe(0);
  });
});
