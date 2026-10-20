/**
 * Re-seat P0, driven through the real {@link RoomService} and dispatcher with
 * only the turn runner and the mover's ports scripted. QA's matrix:
 *
 * - a limit hit (before the turn or mid-turn) moves the seat and answers the
 *   same message again, once, with one room line;
 * - a turn that already posted is continued, never answered twice;
 * - an account at 95% moves the seat before the turn;
 * - a DM works the same way;
 * - every account limited: one out-of-usage line with the soonest reset, no loop;
 * - an expired seat starts fresh with its own line;
 * - a room with outsiders hears no account names (Security Must 7);
 * - the re-run keeps the original trigger's ceiling (Security Must 3);
 * - one Activity entry per move (Security Must 6).
 */
import { describe, expect, it } from 'vitest';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { SessionSettings } from '@dorkos/shared/schemas';
import type { RoomTurnRequest } from '../../room-turn-port.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import type { RankedAccount } from '../../../core/usage/account-ranking.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  type ScriptedTurnRunner,
} from '../../__tests__/room-test-harness.js';
import { RoomSeatMover, type ReseatActivity } from '../seat-mover.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana' },
  '/agents/bo': { name: 'bo' },
});
const SOON = () => new Date(Date.now() + 60 * 60_000).toISOString();

interface Account {
  id: string;
  fiveHour?: number;
  /** The account runs out when a turn runs on it, resetting at this time. */
  limitedUntil?: string | null;
  /** The usage store already knows it is out, before any turn. */
  knownOut?: boolean;
}

function ranked(account: Account, hit = false): RankedAccount {
  const limited = account.limitedUntil !== undefined && (hit || account.knownOut === true);
  return {
    runtime: 'claude-code',
    id: account.id,
    label: account.id[0]!.toUpperCase() + account.id.slice(1),
    color: '#000000',
    eligible: !limited,
    reason: '',
    usage: {
      runtime: 'claude-code',
      accountId: account.id,
      path: `/accounts/${account.id}`,
      label: account.id[0]!.toUpperCase() + account.id.slice(1),
      color: '#000000',
      subscriptionType: null,
      plan: null,
      credits: null,
      spend: null,
      windows: [
        {
          key: 'five_hour',
          label: '5-hour window',
          usedPct: account.fiveHour ?? 10,
          resetsAt: null,
          status: null,
          expired: false,
          observedAt: new Date().toISOString(),
          source: 'sdk_usage',
        },
      ],
      state: limited ? 'limited' : 'ok',
      limit: limited ? { window: 'five_hour', resetsAt: account.limitedUntil ?? null } : null,
      updatedAt: null,
    } as AccountUsage,
  };
}

interface Setup {
  /** The accounts, in core's order, the seat's own first. */
  accounts: Account[];
  /** What each turn does. */
  turn: (request: RoomTurnRequest, n: number) => 'fail' | 'answer' | 'post-then-fail' | 'quiet';
  dm?: boolean;
  outsiders?: boolean;
  stranded?: boolean;
  /** The session the seat is already bound to, so the seat has a transcript. */
  bound?: boolean;
  /** The runtime the seat's sessions run on (default Claude Code). */
  runtime?: string;
  /** Holds the move's summary until the test lets it go, to act mid-move. */
  summaryGate?: Promise<void>;
}

function open(setup: Setup) {
  const settings = new Map<string, SessionSettings>();
  const activity: ReseatActivity[] = [];
  const stranded = new Set<string>();
  /** Accounts a turn has run out on: the store knows them as out from then on. */
  const hit = new Set<string>();
  /** Sessions a turn has run on: only those have a transcript, as in production. */
  const ran = new Set<string>(['old-seat']);
  let moved = 0;
  const accountOfSession = (sessionId: string): string =>
    activity.find((a) => a.toSessionId === sessionId)?.toAccountId ?? setup.accounts[0]!.id;
  let calls = 0;
  const runner: ScriptedTurnRunner = outcomeRunner((request) => {
    calls += 1;
    const what = setup.turn(request, calls);
    if (request.sessionId !== null) ran.add(request.sessionId);
    if (what === 'answer') {
      runner.sayInRoom(request, 'done');
      return { text: 'done' };
    }
    if (what === 'post-then-fail') runner.sayInRoom(request, 'half an answer');
    if (what === 'quiet') return { text: null };
    hit.add(accountOfSession(request.sessionId ?? ''));
    return { text: null, unanswered: 'failed' };
  });
  // eslint-disable-next-line prefer-const
  let harness: ReturnType<typeof createRoomHarness>;
  const mover = new RoomSeatMover({
    rebind: (roomId, authorId, sessionId) =>
      harness.store.rebindRoomSession(roomId, authorId, sessionId),
    runtimeOf: async () => setup.runtime ?? 'claude-code',
    newSeatRuntime: async () => setup.runtime ?? 'claude-code',
    settingsOf: async (id) => settings.get(id) ?? null,
    saveSettings: async (id, value) => {
      settings.set(id, value);
    },
    declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
    effectiveModeOf: async () => undefined,
    accountOf: async (_runtime, sessionId) => {
      const id = accountOfSession(sessionId);
      const row = ranked(
        setup.accounts.find((a) => a.id === id)!,
        hit.has(id)
      );
      return { id, label: row.label, usage: row.usage };
    },
    ranking: async () => setup.accounts.map((a) => ranked(a, hit.has(a.id))),
    transcriptState: async (seat) =>
      seat.sessionId === null
        ? 'unknown'
        : stranded.has(seat.sessionId)
          ? 'missing'
          : ran.has(seat.sessionId)
            ? 'present'
            : 'unknown',
    summaryOf: async () => {
      await setup.summaryGate;
      return 'SUMMARY OF THE OLD SESSION';
    },
    recordActivity: (entry) => activity.push(entry),
    newSessionId: () => `moved-${(moved += 1)}`,
  });
  harness = createRoomHarness({
    agents: AGENTS,
    runner,
    // The shipped value. A re-run is still a turn the cascade guard counts, so
    // a turn that posted before it ran out needs room for one more, as it has
    // on a real install; re-seating never raises the cap.
    maxTurnsPerAgentPerCascade: 10,
    usageLimitFor: (sessionId) => {
      const id = accountOfSession(sessionId);
      const account = setup.accounts.find((a) => a.id === id);
      return account?.limitedUntil !== undefined && hit.has(id)
        ? { resetsAt: account.limitedUntil }
        : null;
    },
    seatMover: () => mover,
    roomHasOutsiders: () => setup.outsiders === true,
  });
  const room = harness.service.createRoom(
    setup.dm
      ? { kind: 'dm', title: 'Ana', members: [], agentPaths: ['/agents/ana'] }
      : { kind: 'channel', title: 'Work', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
    harness.human
  );
  const ana = harness.authors.resolveAgent('/agents/ana', 'ana').id;
  const bo = harness.authors.resolveAgent('/agents/bo', 'bo').id;
  if (setup.bound || setup.stranded) {
    harness.store.bindRoomSession(room.id, ana, 'old-seat', new Date().toISOString());
    settings.set('old-seat', { permissionMode: 'acceptEdits', model: 'opus' });
    if (setup.stranded) stranded.add('old-seat');
  }
  const notices = () =>
    harness.service
      .listEntries(room.id, harness.human, { limit: 200 })
      .filter((e) => e.kind === 'notice')
      .map((e) => ({ text: e.body.text, notice: e.body.notice }));
  const posts = (text: string) =>
    harness.service
      .listEntries(room.id, harness.human, { limit: 200 })
      .filter((e) => e.kind !== 'notice' && e.body.text === text);
  return { harness, room, ana, bo, runner, activity, settings, notices, posts };
}

describe('a seat whose account runs out', () => {
  it('moves to the account with room and answers the same message on the new seat', async () => {
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request) => (request.sessionId === 'old-seat' ? 'fail' : 'answer'),
    });
    const asked = w.harness.service.post(w.room.id, {
      authorId: w.harness.human,
      text: '@ana what is next?',
    });
    await w.harness.service.triggersIdle();

    expect(w.runner.turns.map((t) => t.sessionId)).toEqual(['old-seat', 'moved-1']);
    const rerun = w.runner.turns[1]!;
    expect(rerun.prompt).toBe(asked.body.text);
    expect(rerun.accountHint).toBe('claude3');
    expect(rerun.seedContext).toContain('SUMMARY OF THE OLD SESSION');
    expect(w.harness.store.getRoomSession(w.room.id, w.ana)).toBe('moved-1');
    expect(w.notices()).toEqual([
      {
        text: "ana ran out of usage on Claude4, so it's continuing on Claude3.",
        notice: 'agent_reseated',
      },
    ]);
    expect(w.posts('done')).toHaveLength(1);
  });

  it('copies the old seat’s settings onto the new one before its first turn (Must 1)', async () => {
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request) => (request.sessionId === 'old-seat' ? 'fail' : 'answer'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.settings.get('moved-1')).toEqual({ permissionMode: 'acceptEdits', model: 'opus' });
  });

  it('re-runs under the original trigger’s ceiling (Must 3)', async () => {
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request) => (request.sessionId === 'old-seat' ? 'fail' : 'answer'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    const [first, rerun] = w.runner.turns;
    expect(rerun!.permissionCeiling).toEqual(first!.permissionCeiling);
    expect(rerun!.externalAuthor).toBe(first!.externalAuthor);
  });

  it('records one Activity entry for the move (Must 6)', async () => {
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request) => (request.sessionId === 'old-seat' ? 'fail' : 'answer'),
    });
    const asked = w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.activity).toEqual([
      expect.objectContaining({
        trigger: 'limit',
        roomId: w.room.id,
        authorId: w.ana,
        entryId: asked.id,
        fromSessionId: 'old-seat',
        toSessionId: 'moved-1',
        fromAccountId: 'claude4',
        toAccountId: 'claude3',
      }),
    ]);
  });

  it('continues a message the failed turn already posted to, and never answers it twice', async () => {
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request) => (request.sessionId === 'old-seat' ? 'post-then-fail' : 'answer'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns[1]!.seedContext).toContain('Do not answer it again');
  });

  it('moves a seat at most once per message: a second limit gets the out-of-usage line', async () => {
    const w = open({
      accounts: [
        { id: 'claude4', limitedUntil: SOON() },
        { id: 'claude3', limitedUntil: SOON() },
      ],
      bound: true,
      turn: () => 'fail',
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns).toHaveLength(2);
    expect(w.activity).toHaveLength(1);
    expect(w.notices().map((n) => n.notice)).toEqual(['agent_reseated', 'turn_failed']);
  });

  it('with every account out, says so once with the soonest reset, and does not loop', async () => {
    const soonest = new Date(Date.now() + 30 * 60_000).toISOString();
    const w = open({
      accounts: [
        { id: 'claude4', limitedUntil: SOON() },
        { id: 'claude3', limitedUntil: soonest, knownOut: true },
      ],
      bound: true,
      turn: () => 'fail',
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns).toHaveLength(1);
    expect(w.activity).toEqual([]);
    const lines = w.notices();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.notice).toBe('turn_failed');
    expect(lines[0]!.text).toMatch(
      /^ana is out of usage until .+, and no other account has any left/
    );
  });

  it('works the same in a DM', async () => {
    const w = open({
      dm: true,
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request) => (request.sessionId === 'old-seat' ? 'fail' : 'answer'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: 'what is next?' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns.map((t) => t.sessionId)).toEqual(['old-seat', 'moved-1']);
    expect(w.notices().map((n) => n.notice)).toEqual(['agent_reseated']);
  });

  it('names no account in a room with outsiders (Must 7)', async () => {
    const w = open({
      outsiders: true,
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request) => (request.sessionId === 'old-seat' ? 'fail' : 'answer'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.notices()).toEqual([
      { text: 'ana switched accounts to keep answering.', notice: 'agent_reseated' },
    ]);
  });
});

describe('before a turn', () => {
  it('moves a seat whose account is at 95% and runs the turn on the new seat', async () => {
    const w = open({
      accounts: [{ id: 'claude4', fiveHour: 96 }, { id: 'claude3' }],
      bound: true,
      turn: () => 'answer',
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns.map((t) => t.sessionId)).toEqual(['moved-1']);
    expect(w.runner.turns[0]!.accountHint).toBe('claude3');
    expect(w.notices()).toEqual([
      {
        text: 'ana is continuing on Claude3, because Claude4 is almost out of usage.',
        notice: 'agent_reseated',
      },
    ]);
  });

  it('leaves a seat at 95% where it is when no other account has room', async () => {
    const w = open({
      accounts: [
        { id: 'claude4', fiveHour: 96 },
        { id: 'claude3', fiveHour: 99 },
      ],
      bound: true,
      turn: () => 'answer',
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns.map((t) => t.sessionId)).toEqual(['old-seat']);
    expect(w.notices()).toEqual([]);
  });

  it('starts an expired seat fresh in the same seat, with its own line and no account change', async () => {
    const w = open({
      accounts: [{ id: 'claude4' }, { id: 'claude3' }],
      stranded: true,
      turn: () => 'answer',
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns.map((t) => t.sessionId)).toEqual(['moved-1']);
    expect(w.runner.turns[0]!.accountHint).toBeUndefined();
    expect(w.notices()).toEqual([
      {
        text: 'ana started a fresh chat here. Its earlier one had expired.',
        notice: 'agent_reseated',
      },
    ]);
    expect(w.activity).toEqual([expect.objectContaining({ trigger: 'stranded' })]);
  });

  it('does nothing for a seat whose account has room', async () => {
    const w = open({
      accounts: [{ id: 'claude4' }, { id: 'claude3' }],
      bound: true,
      turn: () => 'answer',
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns.map((t) => t.sessionId)).toEqual(['old-seat']);
    expect(w.activity).toEqual([]);
  });
});

describe('by hand (rooms.reseat)', () => {
  it('lets a person move an agent, with one line naming who did it', async () => {
    const w = open({
      accounts: [{ id: 'claude4' }, { id: 'claude3' }],
      bound: true,
      turn: () => 'answer',
    });
    const moved = await w.harness.service.reseatAgent(w.room.id, w.ana, w.harness.human, {
      accountId: 'claude3',
    });
    expect(moved).toEqual({ sessionId: 'moved-1' });
    expect(w.harness.store.getRoomSession(w.room.id, w.ana)).toBe('moved-1');
    const lines = w.notices();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.notice).toBe('agent_reseated');
    expect(lines[0]!.text).toMatch(/ moved ana to Claude3\.$/);
    expect(w.activity).toEqual([
      expect.objectContaining({ trigger: 'person', toAccountId: 'claude3' }),
    ]);

    // Its next turn starts on the new account.
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns.map((t) => [t.sessionId, t.accountHint])).toEqual([
      ['moved-1', 'claude3'],
    ]);
  });

  it('refuses an agent, even for its own seat, while agents are switched off (Must 5)', async () => {
    const w = open({
      accounts: [{ id: 'claude4' }, { id: 'claude3' }],
      bound: true,
      turn: () => 'answer',
    });
    await expect(w.harness.service.reseatAgent(w.room.id, w.ana, w.ana)).rejects.toMatchObject({
      code: 'PEOPLE_ONLY',
    });
    await expect(w.harness.service.reseatAgent(w.room.id, w.ana, w.bo)).rejects.toMatchObject({
      code: 'PEOPLE_ONLY',
    });
    expect(w.activity).toEqual([]);
    expect(w.notices()).toEqual([]);
  });

  it('says so when no account can take the agent', async () => {
    const w = open({
      accounts: [{ id: 'claude4' }, { id: 'claude3', fiveHour: 99 }],
      bound: true,
      turn: () => 'answer',
    });
    await expect(
      w.harness.service.reseatAgent(w.room.id, w.ana, w.harness.human)
    ).rejects.toMatchObject({ code: 'NO_ACCOUNT_LEFT' });
  });

  it('lists where the agent could move, without the account it is on', async () => {
    const w = open({
      accounts: [{ id: 'claude4' }, { id: 'claude3' }, { id: 'claude2', fiveHour: 99 }],
      bound: true,
      turn: () => 'answer',
    });
    const options = await w.harness.service.reseatOptions(w.room.id, w.ana, w.harness.human);
    expect(options.seated).toBe(true);
    expect(options.current).toEqual({ id: 'claude4', label: 'Claude4' });
    expect(options.accounts.map((a) => [a.id, a.eligible, a.reason])).toEqual([
      ['claude3', true, ''],
      ['claude2', false, 'Almost out of usage'],
    ]);
  });

  it('says the agent has no seat yet when it has not answered in the room', async () => {
    const w = open({ accounts: [{ id: 'claude4' }, { id: 'claude3' }], turn: () => 'answer' });
    const options = await w.harness.service.reseatOptions(w.room.id, w.ana, w.harness.human);
    expect(options).toEqual({ current: null, accounts: [], seated: false });
  });
});

describe('the review’s edge cases', () => {
  it('a re-run that continues an answer and adds nothing is not called a decline', async () => {
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request) => (request.sessionId === 'old-seat' ? 'post-then-fail' : 'quiet'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.runner.turns).toHaveLength(2);
    expect(w.notices().map((n) => n.notice)).toEqual(['agent_reseated']);
  });

  it('Stop pressed while the seat moves: the move is said, and nothing answers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      summaryGate: gate,
      turn: (request) => (request.sessionId === 'old-seat' ? 'fail' : 'answer'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await w.harness.service.haltAgent(w.room.id, w.ana, w.harness.human);
    release();
    await w.harness.service.triggersIdle();
    expect(w.runner.turns).toHaveLength(1);
    expect(w.posts('done')).toHaveLength(0);
    expect(w.notices().map((n) => n.notice)).toContain('agent_reseated');
  });

  it('a by-hand move while the seat moves on its own is refused as working', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }, { id: 'claude2' }],
      bound: true,
      summaryGate: gate,
      turn: (request) => (request.sessionId === 'old-seat' ? 'fail' : 'answer'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      w.harness.service.reseatAgent(w.room.id, w.ana, w.harness.human, { accountId: 'claude2' })
    ).rejects.toMatchObject({ code: 'AGENT_WORKING' });
    release();
    await w.harness.service.triggersIdle();
    expect(w.activity).toHaveLength(1);
  });

  it('a by-hand move for an agent that has not answered here yet says there is nothing to move', async () => {
    const w = open({ accounts: [{ id: 'claude4' }, { id: 'claude3' }], turn: () => 'answer' });
    await expect(
      w.harness.service.reseatAgent(w.room.id, w.ana, w.harness.human)
    ).rejects.toMatchObject({ code: 'NOTHING_TO_MOVE' });
    expect(w.notices()).toEqual([]);
  });

  it('a limit on a runtime that cannot move keeps today’s line, with no claim about other accounts', async () => {
    const w = open({
      runtime: 'opencode',
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: () => 'fail',
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    const lines = w.notices();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).not.toContain('no other account');
  });

  it('a moved seat that has not run yet is not taken for an expired one', async () => {
    const w = open({
      accounts: [{ id: 'claude4', limitedUntil: SOON() }, { id: 'claude3' }],
      bound: true,
      turn: (request, n) => (n === 1 ? 'fail' : 'answer'),
    });
    w.harness.service.post(w.room.id, { authorId: w.harness.human, text: '@ana go' });
    await w.harness.service.triggersIdle();
    expect(w.activity.map((a) => a.trigger)).toEqual(['limit']);
  });
});
