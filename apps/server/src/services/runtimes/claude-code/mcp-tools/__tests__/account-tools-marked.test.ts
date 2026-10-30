/**
 * The account tools refuse a turn that read words DorkOS can't vouch for,
 * ceiling or not (Security on #3201, DOR-3289): a room turn with a stranger's
 * line in view is marked (`outsiderInView`) but carries no ceiling, and the
 * answer holds account ids, plan, credits and spend. In a chat set to Full
 * autonomy the mark refuses nothing (DOR-3412): the read runs and writes one
 * Activity line.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marksForTurn } from '../../../../core/turn-power/turn-marks.js';
import {
  noteChosenTurn,
  resetChosenTurns,
  setMarkedFullActivity,
} from '../../../../core/turn-power/full-autonomy.js';

vi.mock('../../../../core/turn-power/turn-levels.js', () => ({
  // The turn the room runner starts with a stranger's line in view.
  marksOf: (sessionId: string | undefined) =>
    sessionId?.startsWith('marked-turn')
      ? marksForTurn({ roomTurn: { outsiderInView: true } } as never)
      : {},
}));
vi.mock('../../../../core/usage/current-usage-store.js', () => ({
  getAccountUsageStore: () => ({ list: () => [{ id: 'acct', plan: 'max' }] }),
}));
vi.mock('../../accounts/account-probe.js', () => ({
  probeAccount: vi.fn(async () => ({ probe: 'ok' })),
  UnknownAccountError: class extends Error {},
  AccountUsageUnavailableError: class extends Error {},
}));

import { getAccountTools } from '../account-tools.js';

type Handler = (
  args: Record<string, unknown>,
  extra: unknown
) => Promise<{ isError?: boolean; content: { text: string }[] }>;

/** The two tools' handlers, as a session with this calling turn builds them. */
function handlersFor(sessionId: string) {
  const tools = getAccountTools({} as never, () => ({ sessionId, agentPath: '/agents/ana' }));
  const byName = Object.fromEntries(
    tools.map((t) => [(t as { name: string }).name, (t as { handler: Handler }).handler])
  );
  return { usage: byName.accounts_usage!, probe: byName.accounts_probe! };
}

const FULL = { asks: 'never', reach: 'everything' } as const;
const ASK_FIRST = { asks: 'always', reach: 'everything' } as const;

const emit = vi.fn(async () => undefined);
beforeEach(() => {
  emit.mockClear();
  setMarkedFullActivity({ emit } as never);
});
afterEach(() => {
  resetChosenTurns();
  setMarkedFullActivity(undefined);
});

describe('the account tools in a marked turn', () => {
  it('refuses both on a turn a stranger’s line marked, with no ceiling', async () => {
    const { usage, probe } = handlersFor('marked-turn');
    const read = await usage({}, {});
    expect(read.isError).toBe(true);
    expect(read.content[0]!.text).toContain('MARKED_TURN');
    expect((await probe({ account: 'acct' }, {})).isError).toBe(true);
  });

  it('refuses both in a marked chat set below Full, and writes no Activity line', async () => {
    noteChosenTurn('marked-turn-ask', ASK_FIRST as never, false);
    const { usage, probe } = handlersFor('marked-turn-ask');
    expect((await usage({}, {})).content[0]!.text).toContain('MARKED_TURN');
    expect((await probe({ account: 'acct' }, {})).isError).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it('answers both in a marked chat set to Full, with one Activity line each (DOR-3412)', async () => {
    noteChosenTurn('marked-turn-full', FULL as never, false);
    const { usage, probe } = handlersFor('marked-turn-full');
    const read = await usage({}, {});
    expect(read.isError).toBeFalsy();
    expect(read.content[0]!.text).toContain('acct');
    expect((await probe({ account: 'acct' }, {})).isError).toBeFalsy();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(
      emit.mock.calls.map((c) => (c as unknown as [{ resourceId: string }])[0].resourceId)
    ).toEqual(['accounts_usage', 'accounts_probe']);
    expect((emit.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      eventType: 'agent.marked_full_action',
      actorId: '/agents/ana',
      metadata: { sessionId: 'marked-turn-full' },
    });
  });

  it('writes no Activity line for an unmarked turn in a Full chat', async () => {
    noteChosenTurn('own-turn', FULL as never, false);
    const { usage } = handlersFor('own-turn');
    expect((await usage({}, {})).isError).toBeFalsy();
    expect(emit).not.toHaveBeenCalled();
  });

  it('answers on an unmarked turn', async () => {
    const { usage, probe } = handlersFor('own-turn');
    expect((await usage({}, {})).isError).toBeFalsy();
    expect((await probe({ account: 'acct' }, {})).isError).toBeFalsy();
  });

  it('answers on the external server, which has no turn', async () => {
    const tools = getAccountTools({} as never);
    const usage = (tools[0] as unknown as { handler: Handler }).handler;
    expect((await usage({}, {})).isError).toBeFalsy();
  });
});
