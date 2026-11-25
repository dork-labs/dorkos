/**
 * `chat_send` names a chat by its id or an agent by its Mesh id, never by a
 * relay address (DOR-5201). It never publishes on the relay bus: a send is
 * dispatched through the sessions launch path (`chat-message-service.ts`), so
 * a chat's relay address (`relay.agent.<runtime>.<sessionId>`) is read as a
 * chat id like any other, which no chat has, and refused.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionFacts } from '../../../extensions/agent-send/agent-send-defaults.js';
import { resolveChatTarget, type ChatTargetDeps } from '../chat-target.js';
import type { ChatMessageStore } from '../chat-message-store.js';

/** The person's own chat with another agent: one `chat_send` may write into by its id. */
const PERSON_CHAT = '00000000-0000-4000-8000-00000000b001';
const CALLER = { sessionId: '00000000-0000-4000-8000-00000000b002', agentPath: '/made-up/rio' };

function deps(): ChatTargetDeps & { describeSession: ReturnType<typeof vi.fn> } {
  const describeSession = vi.fn(async (sessionId: string): Promise<SessionFacts> => ({
    bound: sessionId === PERSON_CHAT,
    launchOrigin: sessionId === PERSON_CHAT ? 'interactive' : null,
    agentPath: sessionId === PERSON_CHAT ? '/made-up/juno' : null,
    startedByExtension: null,
    roomBound: false,
  }));
  return {
    store: { dmChat: () => null } as unknown as ChatMessageStore,
    meshCore: () => ({ get: () => undefined, getProjectPath: () => undefined }) as never,
    describeSession,
    canonicalId: async (sessionId) => sessionId,
  };
}

describe('a chat_send to a chat’s relay address', () => {
  it.each([
    `relay.agent.claude-code.${PERSON_CHAT}`,
    `relay.agent.default.${PERSON_CHAT}`,
    `relay.agent.${PERSON_CHAT}`,
  ])('reads %s as a chat id no chat has, and refuses it', async (to) => {
    const d = deps();
    await expect(resolveChatTarget(d, CALLER, to, undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(d.describeSession).toHaveBeenCalledWith(to);
    expect(d.describeSession).not.toHaveBeenCalledWith(PERSON_CHAT);
  });
});
