/** The scripted echo must not disguise a refused room post as an agent declining. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import { TestModeRuntime } from '../test-mode-runtime.js';
import { scenarioStore } from '../scenario-store.js';

// Only the posting boundary stands in: the runtime, scenario and room's
// dispatcher are real. A refused remote post can return either false or text.
const { sayInRoom } = vi.hoisted(() => ({
  sayInRoom: vi.fn<(...args: unknown[]) => Promise<true | false | string>>(),
}));
vi.mock('../room-reply-scenarios.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../room-reply-scenarios.js')>()),
  sayInRoom,
}));

afterEach(() => {
  scenarioStore.reset();
  sayInRoom.mockReset();
});

describe('simple-text room echoes', () => {
  it.each([false, 'Space access refused'] as const)(
    'fails the turn instead of reporting agent_declined when posting returns %s',
    async (refusal) => {
      sayInRoom.mockResolvedValue(refusal);
      const runtime = new TestModeRuntime();
      const events: StreamEvent[] = [];
      const runner = outcomeRunner(() => ({ text: null }));
      runner.run = async (request) => {
        const sessionId = request.sessionId ?? 'echo-room-refused';
        request.onSessionBound(sessionId);
        for await (const event of runtime.sendMessage(sessionId, request.prompt, {
          cwd: request.cwd,
          roomTurn: {
            roomId: request.room.id,
            authorId: request.authorId,
            turnId: request.entry.id,
          },
        })) {
          events.push(event);
        }
        return { sessionId, text: 'Echo: @echo please answer' };
      };
      const { service, human } = createRoomHarness({
        agents: agentLookupFor({
          '/agents/echo': { name: 'echo', displayName: 'Echo', responseMode: 'always' },
        }),
        runner,
      });
      const room = service.createRoom(
        { kind: 'channel', title: 'Echo regression', members: [], agentPaths: ['/agents/echo'] },
        human
      );

      service.post(room.id, { authorId: human, text: '@echo please answer' });
      await service.triggersIdle();

      expect(sayInRoom).toHaveBeenCalledOnce();
      const notices = service
        .listEntries(room.id, human, { limit: 100 })
        .filter((entry) => entry.kind === 'notice')
        .map((entry) => entry.body.notice);
      expect(notices).toContain('turn_failed');
      expect(notices).not.toContain('agent_declined');
      expect(events.some((event) => event.type === 'text_delta' || event.type === 'done')).toBe(
        false
      );
    }
  );

  it.each([undefined, { roomTurn: { roomId: 'room', authorId: 'echo', turnId: 'turn' } }])(
    'still echoes when the post succeeds or no room was requested (%j)',
    async (opts) => {
      sayInRoom.mockResolvedValue(opts ? true : false);
      const events: StreamEvent[] = [];
      for await (const event of new TestModeRuntime().sendMessage(
        'echo-success',
        'hello',
        opts as MessageOpts | undefined
      )) {
        events.push(event);
      }
      expect(events.filter((event) => event.type === 'text_delta')).toEqual([
        { type: 'text_delta', data: { text: 'Echo: hello' } },
      ]);
      expect(events.at(-1)?.type).toBe('done');
    }
  );
});
