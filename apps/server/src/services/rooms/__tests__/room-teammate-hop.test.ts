/**
 * Pins the fix for the one-hop teammate laundering (DOR-3036), through the REAL room service, store,
 * author registry and trigger dispatcher; only the turn runner stands in, and it builds the
 * runtime's options with the same functions the production runner calls (`turnBoundsOf`,
 * `roomTurnMarksOf`).
 *
 * A turn counts as a teammate's only if a message it ANSWERS was written by a teammate, or its
 * post carries the mark. A teammate wakes Ana. Ana's post mentions Bo, and Bo answers Ana, an agent
 * on this machine. Ana's post keeps her turn's level, which carries the teammate's mark, so Bo's
 * turn still counts against the space's monthly limit. The mark lowers nothing (DOR-3440).
 *
 * The teammate here is a space member posting into a plain channel: a `community` author is a
 * teammate anywhere (`space-teammates.ts`), so the harness needs no space mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { lastTurnLevelOf, recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import {
  meterTeammateTurns,
  setTeammateTurnCostSink,
} from '../../core/turn-power/teammate-turn-cost.js';
import { roomTurnMarksOf, turnBoundsOf } from '../limits/teammate-turn.js';
import type { RoomService } from '../room-service.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  settleUntil,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

/** The runtime every turn goes through, wrapped the way the registry wraps it. */
function decoratedRuntime(): AgentRuntime {
  const fake = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(): AsyncGenerator<StreamEvent> {
      yield {
        type: 'session_status',
        data: { turnCostUsd: 0.25 },
      } as unknown as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return meterTeammateTurns(recordTurnLevels(fake, () => 'bypassPermissions'));
}

/** The options the production room runner sends for this request (`room-turn-runner.ts`). */
function optsFor(request: RoomTurnRequest): MessageOpts {
  return {
    roomTurn: {
      roomId: request.room.id,
      authorId: request.authorId,
      turnId: `turn-${request.agentPath}`,
      agentPath: request.agentPath,
      ...roomTurnMarksOf(request),
    },
    ...turnBoundsOf(request),
  } as MessageOpts;
}

async function drain(stream: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of stream) {
    // drain
  }
}

let minted = 0;

describe('a teammate wakes Ana, and Ana’s post wakes Bo (DOR-3036)', () => {
  let service: RoomService;
  let channel: RoomWithRoster;
  let runtime: AgentRuntime;
  const seen: RoomTurnRequest[] = [];
  const sessionOf = new Map<string, string>();
  const turnsOf = (agentPath: string) => seen.filter((r) => r.agentPath === agentPath);

  beforeEach(() => {
    seen.length = 0;
    sessionOf.clear();
    runtime = decoratedRuntime();
    const runner = outcomeRunner((request) => {
      seen.push(request);
      const sessionId = request.sessionId!;
      sessionOf.set(request.agentPath, sessionId);
      // Every turn goes through the decorated runtime, so its level is recorded at the call.
      void drain(runtime.sendMessage(sessionId, request.prompt, optsFor(request)));
      if (request.agentPath === '/agents/ana') {
        // Ana answers with a post that mentions Bo, through the tool, from her verified session.
        service.postFromTool(request.room.id, {
          authorId: request.authorId,
          text: '@bo can you check the build?',
          callerSessionId: sessionId,
        });
      }
      return { text: null };
    });
    // A session id per turn, minted before the runner reports it, so Ana's post can name it.
    const run = runner.run.bind(runner);
    runner.run = (request) =>
      run({ ...request, sessionId: request.sessionId ?? `hop-${(minted += 1)}` });
    const harness = createRoomHarness({ agents, runner });
    service = harness.service;
    channel = service.createRoom(
      { kind: 'channel', title: 'Team', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      harness.human
    );
    const teammate = harness.authors.resolveExternal({
      platformType: 'community',
      instanceId: 'remote_team_space',
      platformUserId: 'remote-priya',
      displayName: 'Priya',
    });
    service.addMember(channel.id, harness.human, { authorId: teammate.id });
    service.post(channel.id, { authorId: teammate.id, text: '@ana ask around about the build' });
  });

  afterEach(() => setTeammateTurnCostSink(null));

  it('Ana’s turn is a teammate turn, and Bo carries the mark, at no lower a level', async () => {
    await settleUntil(() => turnsOf('/agents/bo').length === 1, 'Bo was asked by Ana');
    const ana = turnsOf('/agents/ana')[0]!;
    expect(ana.teammate).toBe(true);
    const origin = { roomId: channel.id, authorId: ana.entry.authorId };
    const record = { asks: 'never', reach: 'everything', teammate: [origin] };
    expect(ana.permissionCeiling).toEqual(record);

    const bo = turnsOf('/agents/bo')[0]!;
    expect(bo.permissionCeiling).toEqual(record);
    const level = lastTurnLevelOf(sessionOf.get('/agents/bo')!);
    expect(level).toMatchObject(record);
    expect(level?.outsider).toBeUndefined();
  });

  it('Bo’s turn is sent as any other, with its words still read as words only', async () => {
    await settleUntil(() => turnsOf('/agents/bo').length === 1, 'Bo was asked by Ana');
    const opts = optsFor(turnsOf('/agents/bo')[0]!);
    expect(opts.roomTurn).toMatchObject({ teammate: true, untrustedText: true });
    expect(opts.unattended).toBeUndefined();
  });

  it('Bo’s turn counts against the teammate’s monthly limit', async () => {
    await settleUntil(() => turnsOf('/agents/bo').length === 1, 'Bo was asked by Ana');
    const sink = vi.fn();
    setTeammateTurnCostSink(sink);
    const bo = turnsOf('/agents/bo')[0]!;
    await drain(runtime.sendMessage(sessionOf.get('/agents/bo')!, bo.prompt, optsFor(bo)));
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.25 }));
  });
});
