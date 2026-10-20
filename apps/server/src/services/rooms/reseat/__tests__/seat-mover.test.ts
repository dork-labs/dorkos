/**
 * The seat mover on its own: what one move writes and carries (Security Musts
 * 1, 2 and 4), and the rules that keep it to once per message and one launch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CREDITS_ACCOUNT_ID, type AccountUsage } from '@dorkos/shared/account-usage';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import type { RankedAccount } from '../../../core/usage/account-ranking.js';
import { postLevelFor, recordTurnLevels } from '../../../core/turn-power/turn-levels.js';
import { resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';
import {
  AGENT_MAY_RESEAT_OWN_SEAT,
  mayReseatByHand,
  RoomSeatMover,
  type ReseatActivity,
  type SeatMoverDeps,
} from '../seat-mover.js';

function row(
  id: string,
  opts: { limited?: boolean; fiveHour?: number; noAutoMove?: true } = {}
): RankedAccount {
  return {
    runtime: 'claude-code',
    id,
    label: id,
    color: '#000000',
    eligible: !opts.limited,
    reason: '',
    ...(opts.noAutoMove ? { noAutoMove: true as const } : {}),
    usage: {
      accountId: id,
      label: id,
      path: `/accounts/${id}`,
      windows: [
        {
          key: 'five_hour',
          label: '5-hour',
          usedPct: opts.fiveHour ?? 10,
          resetsAt: null,
          status: null,
          expired: false,
          observedAt: '2026-10-20T00:00:00.000Z',
          source: 'sdk_usage',
        },
      ],
      state: opts.limited ? 'limited' : 'ok',
      limit: opts.limited ? { window: 'five_hour', resetsAt: null } : null,
    } as AccountUsage,
  };
}

function mover(overrides: Partial<SeatMoverDeps> = {}) {
  const settings = new Map<string, SessionSettings>();
  const bound = new Map<string, string>();
  const activity: ReseatActivity[] = [];
  const ranking = [row('claude4', { limited: true }), row('claude3')];
  const m = new RoomSeatMover({
    rebind: (roomId, authorId, sessionId) => {
      bound.set(`${roomId}/${authorId}`, sessionId);
      return true;
    },
    runtimeOf: async () => 'claude-code',
    newSeatRuntime: async () => 'claude-code',
    settingsOf: async (id) => settings.get(id) ?? null,
    saveSettings: async (id, value) => {
      settings.set(id, value);
    },
    declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes,
    effectiveModeOf: async () => undefined,
    accountOf: async () => ({ id: 'claude4', label: 'claude4', usage: ranking[0]!.usage }),
    ranking: async () => ranking,
    transcriptState: async () => 'present',
    summaryOf: async () => 'SUMMARY',
    recordActivity: (entry) => activity.push(entry),
    newSessionId: () => 'new-seat',
    ...overrides,
  });
  return { m, settings, bound, activity };
}

const SEAT = { roomId: 'room-1', authorId: 'ana', agentPath: '/agents/ana', sessionId: 'old-seat' };
const OPTS = { alreadyPosted: false, hideAccounts: false };

afterEach(() => resetOutsiderTurns());

describe('RoomSeatMover', () => {
  it('carries a marked seat’s marks, so the new seat’s posts still cap the agent they wake (Must 2)', async () => {
    const runtime = recordTurnLevels(
      {
        type: 'claude-code',
        getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
        async *sendMessage(): AsyncGenerator<StreamEvent> {
          yield { type: 'done', data: {} } as StreamEvent;
        },
      } as unknown as AgentRuntime,
      () => 'bypassPermissions'
    );
    for await (const _ of runtime.sendMessage('old-seat', 'hi', {
      permissionCeiling: { asks: 'always', reach: 'edit', outsider: true },
    })) {
      // drain
    }
    const { m } = mover();

    await m.afterLimit(SEAT, 'entry-1', OPTS);

    expect(postLevelFor(['new-seat'])).toMatchObject({ asks: 'always', outsider: true });
  });

  it('moves a seat that stored no mode at the level it ran at: an agent at Full stays Full (Must 1)', async () => {
    const asked: Array<[string, string]> = [];
    const { m, settings } = mover({
      effectiveModeOf: async (seat, runtime) => {
        asked.push([seat.agentPath, runtime]);
        return 'bypassPermissions';
      },
    });
    await m.afterLimit(SEAT, 'entry-1', OPTS);
    expect(asked).toEqual([['/agents/ana', 'claude-code']]);
    expect(settings.get('new-seat')).toEqual({ permissionMode: 'bypassPermissions' });
  });

  it('keeps a person-set level below Full, never asking the agent’s level (Must 1)', async () => {
    let asked = false;
    const { m, settings } = mover({
      settingsOf: async (id) => (id === 'old-seat' ? { permissionMode: 'acceptEdits' } : null),
      effectiveModeOf: async () => {
        asked = true;
        return 'bypassPermissions';
      },
    });
    await m.afterLimit(SEAT, 'entry-1', OPTS);
    expect(settings.get('new-seat')).toEqual({ permissionMode: 'acceptEdits' });
    expect(asked).toBe(false);
  });

  it('pins the runtime default only when the seat’s level is unknown (Must 1)', async () => {
    const { m, settings } = mover();
    await m.afterLimit(SEAT, 'entry-1', OPTS);
    expect(settings.get('new-seat')).toEqual({
      permissionMode: CLAUDE_CODE_CAPABILITIES.permissionModes!.default,
    });
  });

  it('moves a seat once per message, and keeps its launch until a turn on it has launched', async () => {
    const { m } = mover();
    expect((await m.afterLimit(SEAT, 'entry-1', OPTS)).kind).toBe('moved');
    expect((await m.afterLimit(SEAT, 'entry-1', OPTS)).kind).toBe('already-moved');
    // Read, not spent: a turn refused before launch leaves it for the next.
    expect(m.pendingLaunch('room-1', 'ana', 'new-seat')).toMatchObject({ accountHint: 'claude3' });
    expect(m.pendingLaunch('room-1', 'ana', 'new-seat')).toMatchObject({ accountHint: 'claude3' });
    m.settleLaunch('room-1', 'ana', 'new-seat');
    expect(m.pendingLaunch('room-1', 'ana', 'new-seat')).toBeUndefined();
  });

  it('keeps no launch for a seat that has moved on since', async () => {
    const { m } = mover();
    await m.afterLimit(SEAT, 'entry-1', OPTS);
    expect(m.pendingLaunch('room-1', 'ana', 'some-other-session')).toBeUndefined();
  });

  it('does not move a seat whose agent now runs on another program (Must 1)', async () => {
    const { m, settings } = mover({ newSeatRuntime: async () => 'codex' });
    expect((await m.afterLimit(SEAT, 'entry-1', OPTS)).kind).toBe('cannot-move');
    expect(settings.size).toBe(0);
    // And it did not use the message's one move.
    expect(m.mayMoveFor(SEAT, 'entry-1')).toBe(true);
  });

  it('does not move a seat when nobody can say which account it is on', async () => {
    const { m } = mover({ accountOf: async () => ({ id: null, label: null, usage: null }) });
    expect((await m.afterLimit(SEAT, 'entry-1', OPTS)).kind).toBe('cannot-move');
  });

  it('does not move a seat on a runtime whose accounts never run out', async () => {
    const { m } = mover({ runtimeOf: async () => 'opencode' });
    expect((await m.afterLimit(SEAT, 'entry-1', OPTS)).kind).toBe('cannot-move');
  });

  it('names no account in the summary when the room has outsiders (Must 7)', async () => {
    const asked: Array<{ accountLabel: string; accountPath: string | null }> = [];
    const { m } = mover({
      summaryOf: async (input) => {
        asked.push(input);
        return 'SUMMARY';
      },
    });
    await m.afterLimit(SEAT, 'entry-1', { alreadyPosted: false, hideAccounts: true });
    expect(asked).toEqual([
      expect.objectContaining({ accountLabel: 'its previous account', accountPath: null }),
    ]);
  });

  it('counts a move before the turn against the message, so a limit later does not move it again', async () => {
    const ranking = [row('claude4', { fiveHour: 97 }), row('claude3'), row('claude2')];
    const { m } = mover({
      ranking: async () => ranking,
      accountOf: async () => ({ id: 'claude4', label: 'claude4', usage: ranking[0]!.usage }),
    });
    expect(await m.beforeTurn(SEAT, 'entry-1', { hideAccounts: false })).not.toBeNull();
    expect((await m.afterLimit({ ...SEAT, sessionId: 'new-seat' }, 'entry-1', OPTS)).kind).toBe(
      'already-moved'
    );
  });

  it('never moves a seat ahead of its first turn: the room’s new-session rules apply', async () => {
    const { m } = mover({ transcriptState: async () => 'unknown' });
    expect(await m.beforeTurn(SEAT, 'entry-1', { hideAccounts: false })).toBeNull();
  });

  it('by hand: refuses DorkOS credits and an account that cannot take work', async () => {
    const credits = row(CREDITS_ACCOUNT_ID);
    const { m } = mover({
      ranking: async () => [row('claude4'), credits, row('claude2', { fiveHour: 99 })],
    });
    expect(
      await m.byHand(SEAT, { accountId: CREDITS_ACCOUNT_ID, by: 'Dorian', hideAccounts: false })
    ).toBeNull();
    expect(
      await m.byHand(SEAT, { accountId: 'claude2', by: 'Dorian', hideAccounts: false })
    ).toBeNull();
    expect(
      await m.byHand({ ...SEAT, sessionId: null }, { by: 'Dorian', hideAccounts: false })
    ).toBe('nothing-to-move');
  });

  it('by hand: moves to the named account and says who did it', async () => {
    const { m, activity } = mover();
    const move = await m.byHand(SEAT, { accountId: 'claude3', by: 'Dorian', hideAccounts: false });
    expect(move).toMatchObject({ reason: { kind: 'by-hand', by: 'Dorian', to: 'claude3' } });
    expect(activity).toEqual([expect.objectContaining({ trigger: 'person', by: 'Dorian' })]);
  });

  it('never moves a seat onto a kept-out account on its own, before a turn or after a limit', async () => {
    const ranking = [
      row('claude4', { fiveHour: 97 }),
      row('claude-ab1', { noAutoMove: true, fiveHour: 0 }),
      row('claude3', { fiveHour: 60 }),
    ];
    const { m } = mover({
      ranking: async () => ranking,
      accountOf: async () => ({ id: 'claude4', label: 'claude4', usage: ranking[0]!.usage }),
    });
    await m.beforeTurn(SEAT, 'entry-1', { hideAccounts: false });
    expect(m.pendingLaunch('room-1', 'ana', 'new-seat')).toMatchObject({ accountHint: 'claude3' });

    const only = mover({
      ranking: async () => [
        row('claude4', { limited: true }),
        row('claude-ab1', { noAutoMove: true }),
      ],
    });
    expect((await only.m.afterLimit(SEAT, 'entry-2', OPTS)).kind).toBe('none');
  });

  it('by hand: moves to a kept-out account a person names, but never picks it as the best', async () => {
    const ranking = [
      row('claude4', { limited: true }),
      row('claude-ab1', { noAutoMove: true }),
      row('claude3'),
    ];
    const named = mover({ ranking: async () => ranking });
    const move = await named.m.byHand(SEAT, {
      accountId: 'claude-ab1',
      by: 'Dorian',
      hideAccounts: false,
    });
    expect(move).toMatchObject({ reason: { kind: 'by-hand', to: 'claude-ab1' } });

    const best = mover({ ranking: async () => ranking });
    await best.m.byHand(SEAT, { by: 'Dorian', hideAccounts: false });
    expect(best.m.pendingLaunch('room-1', 'ana', 'new-seat')).toMatchObject({
      accountHint: 'claude3',
    });

    // And the picker still lists it, so a person can choose it.
    const { accounts } = await best.m.options(SEAT);
    expect(accounts.map((a) => a.id)).toContain('claude-ab1');
  });

  it('offers every allowed account but the seat’s own, marking which can take work', async () => {
    const { m } = mover({
      ranking: async () => [
        row('claude4'),
        row(CREDITS_ACCOUNT_ID),
        row('claude3'),
        row('claude2', { limited: true }),
      ],
    });
    const { accounts } = await m.options(SEAT);
    expect(accounts.map((a) => [a.id, a.eligible])).toEqual([
      ['claude3', true],
      ['claude2', false],
    ]);
  });
});

describe('mayReseatByHand (Must 5)', () => {
  const person = { callerIsPerson: true, callerId: 'kai', seatAuthorId: 'ana', markedTurn: false };
  const agentOwn = {
    callerIsPerson: false,
    callerId: 'ana',
    seatAuthorId: 'ana',
    markedTurn: false,
  };

  it('ships with agents switched off, pending Dorian’s yes', () => {
    expect(AGENT_MAY_RESEAT_OWN_SEAT).toBe(false);
  });

  it('lets a person move any seat, and no agent move any seat, as shipped', () => {
    expect(mayReseatByHand(person)).toBe(true);
    expect(mayReseatByHand({ ...person, markedTurn: true })).toBe(true);
    expect(mayReseatByHand(agentOwn)).toBe(false);
  });

  it('with agents switched on: only an agent’s own seat, and never from a marked turn', () => {
    expect(mayReseatByHand(agentOwn, true)).toBe(true);
    expect(mayReseatByHand({ ...agentOwn, seatAuthorId: 'bo' }, true)).toBe(false);
    expect(mayReseatByHand({ ...agentOwn, markedTurn: true }, true)).toBe(false);
  });
});
