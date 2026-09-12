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

import { logger } from '../../../../lib/logger.js';
import {
  PLUGIN_RELOAD_CEILING_MS,
  PLUGIN_RELOAD_RECHECK_MS,
  PLUGIN_RELOAD_SILENT_TOKENS,
  PluginReloadScheduler,
  PluginReloadSessionGoneError,
  conversationTokens,
  logCacheImpactMeasurement,
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

  it('applies one token below the threshold', () => {
    expect(pluginReloadIsWorthHolding(PLUGIN_RELOAD_SILENT_TOKENS - 1)).toBe(false);
  });

  it('holds a conversation well above the threshold', () => {
    expect(pluginReloadIsWorthHolding(PLUGIN_RELOAD_SILENT_TOKENS * 10)).toBe(true);
  });

  it('applies at once when the size is unknown — a fresh session has no cache to protect', () => {
    expect(pluginReloadIsWorthHolding(undefined)).toBe(false);
  });

  it('applies at once on an empty conversation', () => {
    expect(pluginReloadIsWorthHolding(0)).toBe(false);
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

  it('survives a hold that carried no cache_impact at all', () => {
    expect(readCacheImpact(undefined)).toEqual({
      mcpServersAdded: [],
      mcpServersRemoved: [],
      lspToolChange: null,
    });
  });

  it('drops an lsp value outside the four the SDK declares', () => {
    expect(readCacheImpact({ lsp_tool_change: 'explodes' }).lspToolChange).toBeNull();
  });

  it('drops non-string entries from the server name lists', () => {
    expect(readCacheImpact({ mcp_servers_added: ['ok', 7, null] }).mcpServersAdded).toEqual(['ok']);
  });
});

describe('logCacheImpactMeasurement', () => {
  beforeEach(() => vi.mocked(logger.debug).mockClear());

  it('writes every hold check to debug, held or not, with the three fields', () => {
    logCacheImpactMeasurement({
      sessionId: 's1',
      held: false,
      contextTokens: 4_200,
      impact: undefined,
    });

    expect(logger.debug).toHaveBeenCalledWith(
      '[plugin-reload] cache-impact check',
      expect.objectContaining({
        sessionId: 's1',
        held: false,
        contextTokens: 4_200,
        mcpServersAdded: [],
        mcpServersRemoved: [],
        lspToolChange: null,
      })
    );
  });

  it('carries the impact fields when the reload was held', () => {
    logCacheImpactMeasurement({
      sessionId: 's1',
      held: true,
      contextTokens: 90_000,
      impact: IMPACT,
    });

    expect(logger.debug).toHaveBeenCalledWith(
      '[plugin-reload] cache-impact check',
      expect.objectContaining({
        held: true,
        mcpServersAdded: ['plugin:flow:linear'],
        lspToolChange: 'adds',
      })
    );
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

  it('answers unknown for a session that has completed no request', () => {
    expect(conversationTokens({})).toBeUndefined();
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

  it('asks again one interval later, not sooner and not once only', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    await advance(PLUGIN_RELOAD_RECHECK_MS);
    expect(recheck).toHaveBeenCalledTimes(1);
    await advance(PLUGIN_RELOAD_RECHECK_MS - 1_000);
    expect(recheck).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(recheck).toHaveBeenCalledTimes(2);
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

  it('never lets a second install push the ceiling out', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    for (let elapsed = 0; elapsed < PLUGIN_RELOAD_CEILING_MS; elapsed += 60_000) {
      await advance(60_000);
      if (elapsed < PLUGIN_RELOAD_CEILING_MS - 120_000) {
        scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 95_000 });
      }
    }

    expect(applyNow).toHaveBeenCalledTimes(1);
    expect(recordPaidReload).toHaveBeenCalledWith(
      expect.objectContaining({ release: 'ceiling', contextTokens: 95_000 })
    );
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

  it('never runs two rechecks at once, even when a hold lands mid-flight', async () => {
    let release!: (applied: boolean) => void;
    recheck.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    await advance(PLUGIN_RELOAD_RECHECK_MS);

    // A second install arrives while the first ask is still in the air. It must
    // not start a second round trip, and must not arm a second timer.
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    await advance(60_000);
    expect(recheck).toHaveBeenCalledTimes(1);

    // Once the first ask answers "still warm", the wait resumes from there.
    release(false);
    await advance(0);
    expect(recheck).toHaveBeenCalledTimes(1);
    await advance(PLUGIN_RELOAD_RECHECK_MS);
    expect(recheck).toHaveBeenCalledTimes(2);
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

  it('does not put a record back when the session ended mid-recheck', async () => {
    let release!: (applied: boolean) => void;
    recheck.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    await advance(PLUGIN_RELOAD_RECHECK_MS);

    scheduler.cancel('s1');
    release(false);
    await advance(PLUGIN_RELOAD_CEILING_MS * 2);

    expect(scheduler.isHolding('s1')).toBe(false);
    expect(applyNow).not.toHaveBeenCalled();
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

  it('answers false, and records nothing, when nothing was holding', () => {
    expect(scheduler.settle('never-held', 'hand-triggered')).toBe(false);
    expect(recordPaidReload).not.toHaveBeenCalled();
  });

  it('does not ask again after a hand trigger ended the wait', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    scheduler.settle('s1', 'hand-triggered');

    await advance(PLUGIN_RELOAD_CEILING_MS * 2);

    expect(recheck).not.toHaveBeenCalled();
    expect(applyNow).not.toHaveBeenCalled();
  });

  it('records nothing when the ceiling apply itself fails', async () => {
    applyNow.mockRejectedValue(new Error('subprocess gone'));
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    await advance(PLUGIN_RELOAD_CEILING_MS);

    expect(recordPaidReload).not.toHaveBeenCalled();
    expect(scheduler.isHolding('s1')).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Races around a round trip that is still in the air
  // ---------------------------------------------------------------------

  /** A scheduler whose recheck and apply settle only when the test says so. */
  function heldRoundTrip() {
    let releaseRecheck!: (applied: boolean) => void;
    let failRecheck!: (err: unknown) => void;
    let releaseApply!: () => void;
    recheck.mockImplementation(
      () =>
        new Promise<boolean>((resolve, reject) => {
          releaseRecheck = resolve;
          failRecheck = reject;
        })
    );
    applyNow.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseApply = resolve;
        })
    );
    return {
      releaseRecheck: (applied: boolean) => releaseRecheck(applied),
      failRecheck: (err: unknown) => failRecheck(err),
      releaseApply: () => releaseApply(),
    };
  }

  it('bills one reload once when a hand trigger lands during a recheck', async () => {
    // The person hits reload while the ask is still in the air. Both paths then
    // believe they ended the wait, and the feed would show the same reload
    // twice — once as hand-triggered, once as free.
    const flight = heldRoundTrip();
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    await advance(PLUGIN_RELOAD_RECHECK_MS);

    scheduler.settle('s1', 'hand-triggered');
    flight.releaseRecheck(true);
    await advance(0);

    expect(recordPaidReload.mock.calls.map(([entry]) => entry.release)).toEqual(['hand-triggered']);
  });

  it('records nothing when the session is evicted during a recheck that comes back free', async () => {
    const flight = heldRoundTrip();
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    await advance(PLUGIN_RELOAD_RECHECK_MS);

    scheduler.cancel('s1');
    flight.releaseRecheck(true);
    await advance(0);

    expect(recordPaidReload).not.toHaveBeenCalled();
  });

  it('records nothing when the session is evicted during the ceiling apply', async () => {
    // The rebuild is only ever charged on the session's NEXT turn, and an
    // evicted session has none — so a record here would bill a cost nobody pays.
    const flight = heldRoundTrip();
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    for (let elapsed = 0; elapsed < PLUGIN_RELOAD_CEILING_MS; elapsed += PLUGIN_RELOAD_RECHECK_MS) {
      await advance(PLUGIN_RELOAD_RECHECK_MS);
      flight.releaseRecheck(false);
      await advance(0);
    }
    expect(applyNow).toHaveBeenCalledTimes(1);

    scheduler.cancel('s1');
    flight.releaseApply();
    await advance(0);

    expect(recordPaidReload).not.toHaveBeenCalled();
  });

  it('keeps waiting when a recheck goes unanswered — a slow CLI is not a dead one', async () => {
    // `bounded-control.ts` is explicit that an unacked request says nothing
    // about whether the CLI is alive. Dropping the wait on one would leave this
    // warm process on a stale plugin set for the rest of its life, with nothing
    // scheduled to try again.
    const flight = heldRoundTrip();
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    await advance(PLUGIN_RELOAD_RECHECK_MS);

    flight.failRecheck(new Error('the CLI did not answer reloadPlugins within 8000ms'));
    await advance(0);

    expect(scheduler.isHolding('s1')).toBe(true);
    await advance(PLUGIN_RELOAD_RECHECK_MS);
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it('still stops at the ceiling when every recheck goes unanswered', async () => {
    recheck.mockRejectedValue(new Error('the CLI did not answer reloadPlugins within 8000ms'));
    applyNow.mockRejectedValue(new Error('the CLI did not answer reloadPlugins within 8000ms'));
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    await advance(PLUGIN_RELOAD_CEILING_MS + PLUGIN_RELOAD_RECHECK_MS);

    // Retrying an unanswered ask must not make the ceiling unbounded.
    expect(scheduler.isHolding('s1')).toBe(false);
    expect(recordPaidReload).not.toHaveBeenCalled();
  });

  it('drops the wait when the session is gone, rather than asking a dead process again', async () => {
    recheck.mockRejectedValue(new PluginReloadSessionGoneError('s1'));
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });

    await advance(PLUGIN_RELOAD_RECHECK_MS);

    expect(scheduler.isHolding('s1')).toBe(false);
    expect(recordPaidReload).not.toHaveBeenCalled();
  });

  it('carries the newest impact and size when a hold lands mid-recheck', async () => {
    const flight = heldRoundTrip();
    const second: PluginReloadCacheImpact = {
      mcpServersAdded: ['plugin:b:two'],
      mcpServersRemoved: [],
      lspToolChange: 'removes',
    };
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    await advance(PLUGIN_RELOAD_RECHECK_MS);

    scheduler.hold({ sessionId: 's1', impact: second, contextTokens: 120_000 });
    flight.releaseRecheck(false);
    await advance(0);
    await advance(PLUGIN_RELOAD_RECHECK_MS);
    flight.releaseRecheck(true);
    await advance(0);

    expect(recordPaidReload).toHaveBeenCalledWith(
      expect.objectContaining({ impact: second, contextTokens: 120_000 })
    );
  });

  it('keeps each session on its own clock', async () => {
    scheduler.hold({ sessionId: 's1', impact: IMPACT, contextTokens: 90_000 });
    scheduler.hold({ sessionId: 's2', impact: IMPACT, contextTokens: 90_000 });

    scheduler.cancel('s1');
    await advance(PLUGIN_RELOAD_RECHECK_MS);

    expect(recheck).toHaveBeenCalledTimes(1);
    expect(recheck).toHaveBeenCalledWith('s2');
  });
});
