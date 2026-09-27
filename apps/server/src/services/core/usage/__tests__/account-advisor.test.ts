import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AccountAdvisor } from '@dorkos/extension-api/server';
import { SEED_CONTEXT_MAX_LENGTH } from '@dorkos/shared/schemas';
import {
  ADVISOR_TIMEOUT_MS,
  MAX_RANKING_REASON_LENGTH,
  __resetAccountAdvisorForTests,
  accountAdvisorOwner,
  callAdvisor,
  hasAccountAdvisor,
  invokeAdvisor,
  registerAccountAdvisor,
  validateAdvisorRanking,
  validateCarryOverSeed,
  validateLimitedPlan,
} from '../account-advisor.js';
import { logger } from '../../../../lib/logger.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ctx = { purpose: 'launch', caller: 'agent', cwd: '/w', runtime: 'claude-code' } as const;

function advisor(overrides: Partial<AccountAdvisor> = {}): AccountAdvisor {
  return { rank: () => ({ accounts: [], recommendedId: null }), ...overrides };
}

beforeEach(() => {
  __resetAccountAdvisorForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerAccountAdvisor: one advisor at a time', () => {
  it('a second registration replaces the first and warns naming both owners', async () => {
    const first = advisor({ rank: () => ({ accounts: [], recommendedId: 'first' }) });
    const second = advisor({ rank: () => ({ accounts: [], recommendedId: 'second' }) });
    registerAccountAdvisor('flow', first);
    registerAccountAdvisor('other-ext', second);

    expect(accountAdvisorOwner()).toBe('other-ext');
    expect((await callAdvisor('rank', [], ctx))?.recommendedId).toBe('second');
    const warning = vi
      .mocked(logger.warn)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(warning).toContain('other-ext');
    expect(warning).toContain('flow');
  });

  it('a stale unregister does not remove the advisor that replaced it', () => {
    const unregisterFirst = registerAccountAdvisor('flow', advisor());
    registerAccountAdvisor('other-ext', advisor());
    unregisterFirst();
    expect(accountAdvisorOwner()).toBe('other-ext');
  });

  it('its own unregister removes it', () => {
    const unregister = registerAccountAdvisor('flow', advisor());
    unregister();
    expect(hasAccountAdvisor()).toBe(false);
  });

  it('refuses an advisor with no rank function', () => {
    expect(() => registerAccountAdvisor('flow', {} as AccountAdvisor)).toThrow(TypeError);
    expect(hasAccountAdvisor()).toBe(false);
  });
});

describe('callAdvisor', () => {
  it('answers undefined with no advisor or no such method', async () => {
    expect(await callAdvisor('rank', [], ctx)).toBeUndefined();
    registerAccountAdvisor('flow', advisor());
    expect(await callAdvisor('carryOver', {} as never, 'work')).toBeUndefined();
  });

  it('answers undefined when the advisor throws, synchronously or not', async () => {
    registerAccountAdvisor(
      'flow',
      advisor({
        rank: () => {
          throw new Error('boom');
        },
        onLimited: async () => {
          throw new Error('boom');
        },
      })
    );
    expect(await callAdvisor('rank', [], ctx)).toBeUndefined();
    expect(await callAdvisor('onLimited', {} as never)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it(`gives up after ${ADVISOR_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    registerAccountAdvisor('flow', advisor({ rank: () => new Promise(() => {}) }));
    let settled = false;
    const call = callAdvisor('rank', [], ctx).then((answer) => {
      settled = true;
      return answer;
    });
    await vi.advanceTimersByTimeAsync(ADVISOR_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await call).toBeUndefined();
  });

  it('invokeAdvisor tells a void success from a hang, a throw or a missing method', async () => {
    vi.useFakeTimers();
    const info = { sessionId: 's', cwd: '/w', runtime: 'claude-code', accountId: 'work' };
    const target = { runtime: 'claude-code', accountId: 'client' };
    registerAccountAdvisor('flow', advisor({ move: async () => {}, cancelAuto: () => {} }));
    expect(await invokeAdvisor('move', info, target)).toBe(true);
    expect(await invokeAdvisor('cancelAuto', info)).toBe(true);
    expect(await invokeAdvisor('wait', info, null, false)).toBe(false);

    __resetAccountAdvisorForTests();
    registerAccountAdvisor(
      'flow',
      advisor({
        move: () => new Promise(() => {}),
        cancelAuto: () => {
          throw new Error('boom');
        },
      })
    );
    const move = invokeAdvisor('move', info, target);
    await vi.advanceTimersByTimeAsync(ADVISOR_TIMEOUT_MS);
    expect(await move).toBe(false);
    expect(await invokeAdvisor('cancelAuto', info)).toBe(false);
  });

  it('keeps answering and void methods apart at compile time', () => {
    // @ts-expect-error move answers nothing, so it goes through invokeAdvisor
    void callAdvisor('move', {} as never, {} as never);
    // @ts-expect-error rank answers a ranking, so it goes through callAdvisor
    void invokeAdvisor('rank', [], {} as never);
  });

  it('passes an answer inside the bound through', async () => {
    registerAccountAdvisor('flow', advisor({ onLimited: async () => ({ mode: 'ask' }) }));
    expect(await callAdvisor('onLimited', {} as never)).toEqual({ mode: 'ask' });
  });
});

describe('validateAdvisorRanking', () => {
  const known = new Set(['claude-code:work', 'claude-code:client', 'codex:default']);
  const opts = {
    runtime: 'claude-code',
    isKnown: (runtime: string, id: string) => known.has(`${runtime}:${id}`),
  };

  it('drops unknown ids, malformed rows and duplicates, and fills in the runtime', () => {
    const result = validateAdvisorRanking(
      {
        accounts: [
          { id: 'ghost', eligible: true, reason: 'x' },
          { id: 'work', eligible: true, reason: 'Main', badge: 'reserved' },
          { id: 'client', eligible: 'yes', reason: 'x' },
          { id: 'work', eligible: false, reason: 'dup' },
          { runtime: 'codex', id: 'default', eligible: true, reason: 'Fallback' },
        ],
        recommendedId: 'work',
      },
      opts
    );
    expect(result).toEqual({
      accounts: [
        { runtime: 'claude-code', id: 'work', eligible: true, reason: 'Main', badge: 'reserved' },
        { runtime: 'codex', id: 'default', eligible: true, reason: 'Fallback' },
      ],
      recommendedId: 'work',
    });
  });

  it('drops a recommendedId that names an ineligible row', () => {
    expect(
      validateAdvisorRanking(
        { accounts: [{ id: 'work', eligible: false, reason: 'Reserved' }], recommendedId: 'work' },
        opts
      )?.recommendedId
    ).toBeNull();
  });

  it("drops a recommendedId that only matches another runtime's row", () => {
    const withDefaults = {
      runtime: 'claude-code',
      isKnown: (runtime: string, id: string) => runtime === 'codex' && id === 'default',
    };
    expect(
      validateAdvisorRanking(
        {
          accounts: [{ runtime: 'codex', id: 'default', eligible: true, reason: 'Fallback' }],
          recommendedId: 'default',
        },
        withDefaults
      )?.recommendedId
    ).toBeNull();
  });

  it(`cuts a reason longer than ${MAX_RANKING_REASON_LENGTH} characters to fit, and logs it`, () => {
    const result = validateAdvisorRanking(
      { accounts: [{ id: 'work', eligible: true, reason: 'x'.repeat(500) }], recommendedId: null },
      opts
    );
    const reason = result?.accounts[0]?.reason ?? '';
    expect(Array.from(reason)).toHaveLength(MAX_RANKING_REASON_LENGTH);
    expect(reason.endsWith('\u2026')).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    const short = validateAdvisorRanking(
      { accounts: [{ id: 'work', eligible: true, reason: 'x'.repeat(200) }], recommendedId: null },
      opts
    );
    expect(short?.accounts[0]?.reason).toBe('x'.repeat(200));
  });

  it('cuts on code points, never leaving half an emoji', () => {
    // 198 ASCII characters, then emoji straddling the UTF-16 cut at 199.
    const reason = `${'x'.repeat(198)}${'\u{1F600}'.repeat(5)}`;
    const cut =
      validateAdvisorRanking(
        { accounts: [{ id: 'work', eligible: true, reason }], recommendedId: null },
        opts
      )?.accounts[0]?.reason ?? '';
    expect(cut).toBe(`${'x'.repeat(198)}\u{1F600}\u2026`);
    expect(Array.from(cut)).toHaveLength(MAX_RANKING_REASON_LENGTH);
    expect(cut).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    );
    // Exactly 200 code points (more UTF-16 units) is not cut.
    const exact = `${'x'.repeat(199)}\u{1F600}`;
    expect(
      validateAdvisorRanking(
        { accounts: [{ id: 'work', eligible: true, reason: exact }], recommendedId: null },
        opts
      )?.accounts[0]?.reason
    ).toBe(exact);
  });

  it('drops a recommendedId that names no kept row', () => {
    expect(
      validateAdvisorRanking({ accounts: [], recommendedId: 'ghost' }, opts)?.recommendedId
    ).toBeNull();
  });

  it('refuses an answer that is not a ranking', () => {
    expect(validateAdvisorRanking(null, opts)).toBeNull();
    expect(validateAdvisorRanking({ accounts: 'work' }, opts)).toBeNull();
  });
});

describe('validateLimitedPlan', () => {
  const opts = { limitedAccountId: 'work', isRegistered: (id: string) => id !== 'ghost' };

  it('clamps delaySeconds to 0..3600', () => {
    expect(validateLimitedPlan({ mode: 'auto', target: 'client', delaySeconds: -5 }, opts)).toEqual(
      { mode: 'auto', target: 'client', delaySeconds: 0 }
    );
    expect(
      validateLimitedPlan({ mode: 'auto', target: 'client', delaySeconds: 99_999 }, opts)
    ).toEqual({ mode: 'auto', target: 'client', delaySeconds: 3600 });
  });

  it('refuses an auto target that is unregistered or the limited account', () => {
    expect(
      validateLimitedPlan({ mode: 'auto', target: 'ghost', delaySeconds: 1 }, opts)
    ).toBeNull();
    expect(validateLimitedPlan({ mode: 'auto', target: 'work', delaySeconds: 1 }, opts)).toBeNull();
  });

  it('passes wait and ask through, and refuses nonsense', () => {
    expect(validateLimitedPlan({ mode: 'ask' }, opts)).toEqual({ mode: 'ask' });
    expect(validateLimitedPlan({ mode: 'wait', resumeAt: '2026-09-27T10:00:00Z' }, opts)).toEqual({
      mode: 'wait',
      resumeAt: '2026-09-27T10:00:00Z',
    });
    expect(validateLimitedPlan({ mode: 'wait', resumeAt: 'soon' }, opts)).toBeNull();
    expect(validateLimitedPlan({ mode: 'move' }, opts)).toBeNull();
  });
});

describe('validateCarryOverSeed', () => {
  it('refuses a seed longer than SEED_CONTEXT_MAX_LENGTH', () => {
    expect(
      validateCarryOverSeed({ seedContext: 'x'.repeat(SEED_CONTEXT_MAX_LENGTH + 1) })
    ).toBeNull();
  });

  it('keeps a seed within the limit', () => {
    const seed = { seedContext: 'x'.repeat(SEED_CONTEXT_MAX_LENGTH), prompt: 'Go on.' };
    expect(validateCarryOverSeed(seed)).toEqual(seed);
  });
});
