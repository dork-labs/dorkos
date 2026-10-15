/**
 * A turn that read a stranger's words may post a few messages into a room and
 * no more; our own agents' turns are never counted (DOR-2739, ADR
 * 261006-225605). Through the REAL room service, store and author registry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { OUTSIDER_TURN_LIMIT, resetOutsiderOutput } from '../../core/turn-power/outsider-output.js';
import { noteTurnOrigin, resetOutsiderTurns } from '../../session/origin/outsider-turns.js';
import type { TurnOrigin } from '../../session/origin/turn-origin.js';
import type { RoomService } from '../room-service.js';
import { agentLookupFor, createRoomHarness, outcomeRunner } from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
});

/** Record a turn on `sessionId` and what started it, as the binding call and the registry do. */
async function ranTurn(sessionId: string, origin: TurnOrigin): Promise<void> {
  noteTurnOrigin(sessionId, origin);
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
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

describe('posts from a turn a stranger started', () => {
  let service: RoomService;
  let channel: RoomWithRoster;
  let ana: string;

  beforeEach(() => {
    resetOutsiderOutput();
    resetOutsiderTurns();
    const harness = createRoomHarness({ agents, runner: outcomeRunner(() => ({ text: null })) });
    service = harness.service;
    channel = service.createRoom(
      { kind: 'channel', title: 'Support', members: [], agentPaths: ['/agents/ana'] },
      harness.human
    );
    ana = harness.authors.resolveAgent('/agents/ana', 'Ana').id;
  });

  const post = (callerSessionId: string, n: number) =>
    service.postFromTool(channel.id, { authorId: ana, text: `line ${n}`, callerSessionId });

  it('lands a few, then refuses the next with TOO_MANY_POSTS_THIS_TURN', async () => {
    await ranTurn('stranger-turn', { kind: 'room', externalAuthor: true });
    for (let n = 0; n < OUTSIDER_TURN_LIMIT; n += 1) post('stranger-turn', n);
    expect(() => post('stranger-turn', OUTSIDER_TURN_LIMIT)).toThrow(
      expect.objectContaining({ code: 'TOO_MANY_POSTS_THIS_TURN' })
    );
  });

  it('never counts a turn its own people started', async () => {
    await ranTurn('own-turn', { kind: 'room', externalAuthor: false });
    for (let n = 0; n < OUTSIDER_TURN_LIMIT * 4; n += 1) {
      expect(() => post('own-turn', n)).not.toThrow();
    }
  });

  it('spends nothing on a post refused for another reason', async () => {
    await ranTurn('stranger-typo', { kind: 'relay-binding' });
    expect(() =>
      service.postFromTool(channel.id, {
        authorId: ana,
        text: 'answering a message that is not there',
        replyTo: 'no-such-entry',
        callerSessionId: 'stranger-typo',
      })
    ).toThrow();
    for (let n = 0; n < OUTSIDER_TURN_LIMIT; n += 1) {
      expect(() => post('stranger-typo', n)).not.toThrow();
    }
  });
});
