import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

import {
  PLUGIN_RELOAD_CEILING_MS,
  PLUGIN_RELOAD_RECHECK_MS,
  PLUGIN_RELOAD_SILENT_TOKENS,
  PluginReloadScheduler,
  PluginReloadSessionGoneError,
  conversationTokens,
  pluginReloadIsWorthHolding,
  readCacheImpact,
  type PaidPluginReload,
  type PluginReloadCacheImpact,
} from '../messaging/plugin-reload-policy.js';

const IMPACT: PluginReloadCacheImpact = {
  mcpServersAdded: ['plugin:flow:linear'],
  mcpServersRemoved: [],
  lspToolChange: 'adds',
};

describe('pluginReloadIsWorthHolding', () => {
  // The threshold comparison is the whole policy, so both sides of it are
  // pinned: a mutation from `>=` to `>` or a nudged constant reds here.
  it('holds a conversation exactly at the threshold', () => {
    expect(pluginReloadIsWorthHolding(PLUGIN_RELOAD_SILENT_TOKENS)).toBe(true);
  });

  it('holds a conversation well above the threshold', () => {
    expect(pluginReloadIsWorthHolding(PLUGIN_RELOAD_SILENT_TOKENS * 10)).toBe(true);
  });
});

describe('readCacheImpact', () => {
  it('reads the three fields the CLI sends', () => {
    expect(
      readCacheImpact({
        mcp_servers_added: ['plugin:a:one'],
        mcp_servers_removed: ['plugin:b:two'],
        lsp_tool_change: 'may-remove',
      })
    ).toEqual({
      mcpServersAdded: ['plugin:a:one'],
      mcpServersRemoved: ['plugin:b:two'],
      lspToolChange: 'may-remove',
    });
  });
});

describe('conversationTokens', () => {
  it('sums the input-side terms of the last request', () => {
    expect(
      conversationTokens({
        lastRequestUsage: { inputTokens: 10, cacheReadTokens: 200, cacheCreationTokens: 3_000 },
      })
    ).toBe(3_210);
  });
});

describe('PluginReloadScheduler', () => {
  let now: number;
  /** What the runtime answers a recheck with: true once the reload was free. */
  let cacheWentCold: boolean;
  let recheck: ReturnType<typeof vi.fn<(sessionId: string) => Promise<boolean>>>;
  let applyNow: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
  let recordPaidReload: ReturnType<typeof vi.fn<(entry: PaidPluginReload) => void>>;
  let scheduler: PluginReloadScheduler;

  /** Move the clock and let every timer that came due run. */
  async function advance(ms: number): Promise<void> {
    now += ms;
    await vi.advanceTimersByTimeAsync(ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    cacheWentCold = false;
    recheck = vi
      .fn<(sessionId: string) => Promise<boolean>>()
      .mockImplementation(() => Promise.resolve(cacheWentCold));
    applyNow = vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined);
    recordPaidReload = vi.fn<(entry: PaidPluginReload) => void>();
    scheduler = new PluginReloadScheduler(
      {
        recheck: (id) => recheck(id),
        applyNow: (id) => applyNow(id),
        recordPaidReload: (entry) => recordPaidReload(entry),
      },
      () => now
    );
  });

  afterEach(() => {
    scheduler.cancelAll();
    vi.useRealTimers();
  });

  it('asks the runtime rather than applying, when the recheck comes due', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    expect(recheck).not.toHaveBeenCalled();

    await advance(PLUGIN_RELOAD_RECHECK_MS);

    expect(recheck).toHaveBeenCalledWith('s1');
    // Asking is the whole mechanism: nothing may be applied outright here.
    expect(applyNow).not.toHaveBeenCalled();
  });

  it('records a free reload when the runtime says it applied one', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    cacheWentCold = true;

    await advance(PLUGIN_RELOAD_RECHECK_MS);

    expect(recordPaidReload).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        deferred: true,
        release: 'cache-cold',
        contextTokens: 90_000,
        impact: IMPACT,
      })
    );
    expect(scheduler.isHolding('s1')).toBe(false);
  });

  // THE decisive test for the one-hour cache. A session can sit untouched for
  // an hour and still be warm on a Claude subscription (`Options.promptCacheTtl`
  // unset = automatic = 1h there), so any rule that concluded "idle past five
  // minutes, therefore cold" would apply here and file a record calling a paid
  // rebuild free. Only the runtime's own answer may end the wait.
  it('keeps waiting while the runtime still says the cache is warm, however long it has been idle', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    await advance(PLUGIN_RELOAD_RECHECK_MS * 2);

    expect(recheck).toHaveBeenCalledTimes(2);
    expect(applyNow).not.toHaveBeenCalled();
    expect(recordPaidReload).not.toHaveBeenCalled();
    expect(scheduler.isHolding('s1')).toBe(true);
  });

  it('pays at the ceiling when the cache never goes cold', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    await advance(PLUGIN_RELOAD_CEILING_MS);

    expect(applyNow).toHaveBeenCalledWith('s1');
    expect(recordPaidReload).toHaveBeenCalledWith(
      expect.objectContaining({ deferred: true, release: 'ceiling' })
    );
    expect(scheduler.isHolding('s1')).toBe(false);
  });

  it('records exactly one paid reload however many holds folded into the wait', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 91_000 });
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 92_000 });
    cacheWentCold = true;

    await advance(PLUGIN_RELOAD_RECHECK_MS);

    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recordPaidReload).toHaveBeenCalledTimes(1);
  });

  it('drops a held reload when the session ends, applying nothing and recording nothing', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    scheduler.cancel('s1');
    await advance(PLUGIN_RELOAD_CEILING_MS * 2);

    expect(recheck).not.toHaveBeenCalled();
    expect(applyNow).not.toHaveBeenCalled();
    expect(recordPaidReload).not.toHaveBeenCalled();
    expect(scheduler.isHolding('s1')).toBe(false);
  });

  it('records a hand-triggered reload as the paid end of the wait, and says so', () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    now += 120_000;
    expect(scheduler.settle('s1', 'hand-triggered')).toBe(true);

    expect(recordPaidReload).toHaveBeenCalledWith(
      expect.objectContaining({ deferred: true, release: 'hand-triggered', heldMs: 120_000 })
    );
    expect(scheduler.isHolding('s1')).toBe(false);
  });

  it('drops the wait when the session is gone, rather than asking a dead process again', async () => {
    recheck.mockRejectedValue(new PluginReloadSessionGoneError('s1'));
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    await advance(PLUGIN_RELOAD_RECHECK_MS);

    expect(scheduler.isHolding('s1')).toBe(false);
    expect(recordPaidReload).not.toHaveBeenCalled();
  });
});
