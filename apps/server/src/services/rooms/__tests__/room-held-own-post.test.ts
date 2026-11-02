/**
 * A post a held turn writes never wakes its own agent (Security on #3280, DOR-3561): a Wi-Fi hold
 * rides on as a mark only into the work a turn starts, and a room post starts none for its author.
 * Not through a self-@mention, not as a reply in its own thread, and not even when the agent
 * answers every post (`always`). Driven through the REAL room service, store, author registry and
 * trigger dispatcher, with Ana's turn really held (`recordTurnLevels`); only the runner stands in.
 * Turn limits are off, as a person may set them, so the author rule is the only thing in the way.
 * The control: the same held turn naming another agent does wake that one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { marksOf, recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { marksHold } from '../../core/turn-power/turn-marks.js';
import type { RoomService } from '../room-service.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  settleUntil,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});

/** Run a turn on `sessionId` at `mode` under `opts`, as the registry's wrapper records it. */
async function ranAt(sessionId: string, mode: string, opts?: MessageOpts): Promise<void> {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => mode
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

describe('a held turn’s own room post', () => {
  let service: RoomService;
  let human: string;
  let channel: RoomWithRoster;
  const seen: RoomTurnRequest[] = [];
  const turnsOf = (agentPath: string) => seen.filter((r) => r.agentPath === agentPath);

  beforeEach(() => {
    seen.length = 0;
    const runner = outcomeRunner((request) => {
      seen.push(request);
      if (request.agentPath !== '/agents/ana' || !request.prompt.includes('go')) {
        return { text: null };
      }
      const said = (text: string, replyTo?: string) =>
        service.postFromTool(request.room.id, {
          authorId: request.authorId,
          text,
          callerSessionId: request.sessionId ?? undefined,
          ...(replyTo !== undefined ? { replyTo } : {}),
        });
      const root = said('@ana remember to check the build');
      said('@ana and the deploy', root.id);
      if (request.prompt.includes('bo')) said('@bo can you check the build?');
      return { text: null };
    });
    ({ service, human } = createRoomHarness({ agents, runner, turnLimitsEnabled: false }));
    channel = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
  });

  /** Bind Ana's chat, then run its next turn held, as one answering a Wi-Fi post does. */
  async function holdAna(): Promise<void> {
    service.post(channel.id, { authorId: human, text: '@ana hello' });
    await settleUntil(() => turnsOf('/agents/ana').length === 1, 'Ana was asked');
    const anaSession = turnsOf('/agents/ana')[0]!.sessionId!;
    await ranAt(anaSession, 'bypassPermissions', { permissionCeiling: 'runtime-default' });
    expect(marksHold(marksOf(anaSession, '/agents/ana'))).toBe(true);
  }

  it('wakes no seat of its own agent, through a self-@mention or its own thread', async () => {
    await holdAna();
    service.post(channel.id, { authorId: human, text: '@ana go' }, false, 'runtime-default');
    await settleUntil(() => turnsOf('/agents/ana').length === 2, 'Ana answered held');
    await service.triggersIdle();

    // The person's two posts, and nothing for the three Ana wrote herself.
    expect(turnsOf('/agents/ana')).toHaveLength(2);
  });

  it('still wakes another agent it names, so the trigger ran at all', async () => {
    await holdAna();
    service.post(
      channel.id,
      { authorId: human, text: '@ana go, ask bo' },
      false,
      'runtime-default'
    );
    await settleUntil(() => turnsOf('/agents/bo').length === 1, 'Bo was asked by Ana');
    await service.triggersIdle();

    expect(turnsOf('/agents/ana')).toHaveLength(2);
  });
});
