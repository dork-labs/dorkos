/**
 * Power flows downstream, never up (spec `trusted-by-default-flip` §4), through
 * the REAL room service, store, author registry and trigger dispatcher — only
 * the turn runner stands in.
 *
 * An agent's post is kept with the level its turn ran at, and the turn that
 * post starts on another agent is held to it. Without that, a conversation set
 * to Full autonomy answers any agent that writes into it at Full autonomy, and
 * an agent a stranger's message woke could hand its stranger to a shell one hop
 * later.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels, resetTurnLevelsForTests } from '../../core/turn-power/turn-levels.js';
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

/** Record that a turn ran on `sessionId` at `mode`, as the registry's wrapper does. */
async function ranAt(sessionId: string, mode: string): Promise<void> {
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
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

describe('a turn another agent’s post starts', () => {
  let service: RoomService;
  let human: string;
  let channel: RoomWithRoster;
  const seen: RoomTurnRequest[] = [];
  const turnsOf = (agentPath: string) => seen.filter((r) => r.agentPath === agentPath);

  beforeEach(() => {
    resetTurnLevelsForTests();
    seen.length = 0;
    const runner = outcomeRunner((request) => {
      seen.push(request);
      if (request.agentPath === '/agents/ana' && request.prompt.includes('ask bo')) {
        service.postFromTool(request.room.id, {
          authorId: request.authorId,
          text: '@bo can you check the build?',
        });
      }
      return { text: null };
    });
    ({ service, human } = createRoomHarness({ agents, runner }));
    channel = service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
      human
    );
  });

  it('puts no bound on a person’s own message', async () => {
    service.post(channel.id, { authorId: human, text: '@ana hello' });
    await settleUntil(() => turnsOf('/agents/ana').length === 1, 'Ana was asked');
    expect(turnsOf('/agents/ana')[0]!.permissionCeiling).toBeUndefined();
  });

  it('is held to the level the posting agent’s turn ran at', async () => {
    // Ana's first turn binds her conversation; then her turns run at Accept edits.
    service.post(channel.id, { authorId: human, text: '@ana hello' });
    await settleUntil(() => turnsOf('/agents/ana').length === 1, 'Ana was asked');
    const anaSession = turnsOf('/agents/ana')[0]!.sessionId!;
    await ranAt(anaSession, 'acceptEdits');

    service.post(channel.id, { authorId: human, text: '@ana ask bo about the build' });
    await settleUntil(() => turnsOf('/agents/bo').length === 1, 'Bo was asked by Ana');

    expect(turnsOf('/agents/ana')[1]!.sessionId).toBe(anaSession);
    expect(turnsOf('/agents/bo')[0]!.permissionCeiling).toEqual({
      asks: 'when-risky',
      reach: 'edit',
    });
  });

  it('is held to the runtime default when the posting turn’s level was not kept', async () => {
    service.post(channel.id, { authorId: human, text: '@ana ask bo about the build' });
    await settleUntil(() => turnsOf('/agents/bo').length === 1, 'Bo was asked by Ana');
    expect(turnsOf('/agents/bo')[0]!.permissionCeiling).toBe('runtime-default');
  });
});
