/**
 * A schedule whose runs go on DorkOS credits names a model credits serve, but
 * only once the service says which protocols its models are on (DOR-2636).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  launchAccount: 'default',
  verdict: { judged: true, refusal: null } as { judged: boolean; refusal?: string | null },
}));

vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefaultType: () => 'claude-code',
    has: (type: string) => ['claude-code', 'codex'].includes(type),
    get: (type: string) => ({
      getCapabilities: () =>
        type === 'claude-code' ? { credits: { protocol: 'anthropic-messages' } } : {},
    }),
  },
}));
vi.mock('../../../runtimes/claude-code/launch-account-check.js', () => ({
  checkClaudeLaunchAccount: vi.fn(async (opts: { hintId?: string }) => ({
    ok: true,
    root: '/x',
    accountId: opts.hintId ?? state.launchAccount,
  })),
}));
vi.mock('../../../core/cloud/credits-models.js', () => ({
  judgeCreditsModel: vi.fn(async () => state.verdict),
}));

import { judgeCreditsModel } from '../../../core/cloud/credits-models.js';
import { scheduleCreditsModelRefusal } from '../schedule-credits-model.js';

const NOT_COVERED = 'DorkOS credits don’t cover that model. Pick one from the model menu.';

beforeEach(() => {
  vi.clearAllMocks();
  state.launchAccount = 'default';
  state.verdict = { judged: true, refusal: NOT_COVERED };
});

describe('scheduleCreditsModelRefusal', () => {
  it('refuses a model credits do not serve when the schedule names credits', async () => {
    expect(
      await scheduleCreditsModelRefusal({
        model: 'opus',
        account: 'dorkos-credits',
        runtime: 'claude-code',
        folder: '/work',
      })
    ).toBe(NOT_COVERED);
  });

  it('follows the ladder when the schedule names no account (its agent, then the default)', async () => {
    state.launchAccount = 'dorkos-credits';
    expect(
      await scheduleCreditsModelRefusal({
        model: 'opus',
        account: null,
        runtime: null,
        folder: '/w',
      })
    ).toBe(NOT_COVERED);
  });

  it('judges nothing for a schedule on its own sign-in, or with no model', async () => {
    expect(
      await scheduleCreditsModelRefusal({
        model: 'opus',
        account: 'work',
        runtime: null,
        folder: '/w',
      })
    ).toBeNull();
    expect(
      await scheduleCreditsModelRefusal({
        model: undefined,
        account: 'dorkos-credits',
        runtime: null,
        folder: '/w',
      })
    ).toBeNull();
    expect(judgeCreditsModel).not.toHaveBeenCalled();
  });

  it('judges nothing while the service says nothing about protocols', async () => {
    // A refusal riding along must still be ignored while nothing was judged.
    state.verdict = { judged: false, refusal: NOT_COVERED };
    expect(
      await scheduleCreditsModelRefusal({
        model: 'opus',
        account: 'dorkos-credits',
        runtime: 'claude-code',
        folder: '/w',
      })
    ).toBeNull();
  });

  it('never judges a runtime that declares no credits protocol', async () => {
    expect(
      await scheduleCreditsModelRefusal({
        model: 'gpt-5',
        account: 'dorkos-credits',
        runtime: 'codex',
        folder: '/w',
      })
    ).toBeNull();
  });
});
