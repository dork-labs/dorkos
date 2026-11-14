/**
 * Room turns from bridged people and non-owner humans carry the outsider mark
 * behind DORKOS_MARK_STRANGER_TURNS, without receiving a permission ceiling or
 * losing the agent's Full level (DOR-3858).
 */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { env } from '../../../env.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { lastTurnLevelOf, recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { turnBoundsOf } from '../limits/teammate-turn.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  settleUntil,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
});

interface ObservedTurn {
  prompt: string;
  carriedOutsider?: true;
  permissionCeiling: RoomTurnRequest['permissionCeiling'];
  level: TurnPermissionLevel;
}

/** Run a room scenario with the boot flag temporarily set to `enabled`. */
async function withFlag<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const key = 'DORKOS_MARK_STRANGER_TURNS';
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value: enabled });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  }
}

/** Post as the owner, a teammate, and a bridged Telegram person, then return their turns. */
async function roomTurns(enabled: boolean): Promise<ObservedTurn[]> {
  return withFlag(enabled, async () => {
    const observed: ObservedTurn[] = [];
    let serial = 0;
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
    const runner = outcomeRunner((request) => {
      const sessionId = `room-stranger-mark-${(serial += 1)}`;
      runtime.sendMessage(sessionId, request.prompt, turnBoundsOf(request));
      observed.push({
        prompt: request.prompt,
        ...(request.carriedOutsider ? { carriedOutsider: true } : {}),
        permissionCeiling: request.permissionCeiling,
        level: lastTurnLevelOf(sessionId)!,
      });
      return { text: null, sessionId };
    });
    const harness = createRoomHarness({ agents, runner, ownerUserId: 'owner-account' });
    const teammate = harness.authors.resolve({
      kind: 'human',
      naturalKey: 'user:teammate-account',
      displayName: 'Taylor',
    });
    const bridged = harness.authors.resolveExternal({
      platformType: 'telegram',
      instanceId: 'bot-example',
      platformUserId: 'platform-person-7',
      displayName: 'River',
    });
    // A linked phone is attribution only. Rooms cannot prove its connection
    // allowlist, so Security's conservative rule still marks it.
    harness.authors.linkToOwner(bridged.id, 'owner-account');
    const room = harness.service.createRoom(
      { kind: 'channel', title: 'Launch', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    harness.service.addMember(room.id, harness.human, { authorId: teammate.id });
    harness.service.addMember(room.id, harness.human, { authorId: bridged.id });

    harness.service.post(room.id, { authorId: harness.human, text: '@ana owner message' });
    await settleUntil(() => observed.length === 1, 'owner turn');
    harness.service.post(room.id, { authorId: teammate.id, text: '@ana teammate message' });
    await settleUntil(() => observed.length === 2, 'teammate turn');
    harness.service.post(room.id, { authorId: bridged.id, text: '@ana bridged message' });
    await settleUntil(() => observed.length === 3, 'bridged turn');

    return observed;
  });
}

describe('room stranger marks (DOR-3858)', () => {
  it('marks no room turn while the flag is off', async () => {
    const turns = await roomTurns(false);

    expect(turns.map((turn) => turn.carriedOutsider)).toEqual([undefined, undefined, undefined]);
    expect(turns.every((turn) => turn.permissionCeiling === undefined)).toBe(true);
    expect(turns.map((turn) => turn.level)).toEqual([
      { asks: 'never', reach: 'everything' },
      { asks: 'never', reach: 'everything' },
      { asks: 'never', reach: 'everything' },
    ]);
  });

  it('marks a non-owner human and a bridged author, but not the owner', async () => {
    const turns = await roomTurns(true);

    expect(turns.map((turn) => [turn.prompt, turn.carriedOutsider])).toEqual([
      ['@ana owner message', undefined],
      ['@ana teammate message', true],
      ['@ana bridged message', true],
    ]);
    expect(turns.every((turn) => turn.permissionCeiling === undefined)).toBe(true);
    expect(turns.map((turn) => turn.level)).toEqual([
      { asks: 'never', reach: 'everything' },
      { asks: 'never', reach: 'everything', outsider: true },
      { asks: 'never', reach: 'everything', outsider: true },
    ]);
  });
});
