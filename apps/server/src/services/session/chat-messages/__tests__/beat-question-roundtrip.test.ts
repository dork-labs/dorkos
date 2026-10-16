/**
 * A question asked from a heartbeat beat, walked end to end (2026-10-16, Cody's
 * beat): the beat asks a coordinator chat, the coordinator answers the beat by
 * its chat id, the answer lands in the asking agent's DM chat, and both the
 * beat and that DM chat can `chat_read` the coordinator's chat.
 *
 * The store, the queue and the reader rule are real; the launch path is a
 * stand-in that binds a new DM chat the way the dispatcher does.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { HistoryMessage } from '@dorkos/shared/types';

vi.mock('../../../audit/audit-trail.js', () => ({ recordAudit: vi.fn(), auditTrail: () => null }));

import type { DispatchSessionMessageResult } from '../../launch/launch-session.js';
import { MessageQueueStore, setMessageQueueStore } from '../../message-queue-store.js';
import type { SessionFacts } from '../../../extensions/agent-send/agent-send-defaults.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
} from '../../../audit/session-visibility.js';
import { ChatMessageStore } from '../chat-message-store.js';
import { ChatMessageService } from '../chat-message-service.js';
import { mayReadChat } from '../chat-message-wiring.js';
import { readChat, type ChatReadDeps } from '../chat-read.js';

const CODY = { id: 'agent-cody', projectPath: '/agents/cody', name: 'cody', displayName: 'Cody' };
const DORK = { id: 'agent-dork', projectPath: '/agents/dork', name: 'dork', displayName: 'DorkOS' };
const BEAT = { sessionId: 'beat-chat', agentPath: CODY.projectPath };
const COORDINATOR = { sessionId: 'coordinator-chat', agentPath: DORK.projectPath };

let store: ChatMessageStore;
let sessions: Map<string, SessionFacts>;

const bind = (id: string, launchOrigin: string, agentPath: string) =>
  sessions.set(id, {
    bound: true,
    launchOrigin,
    agentPath,
    startedByExtension: null,
    roomBound: false,
  });

function service(): ChatMessageService {
  return new ChatMessageService({
    store,
    meshCore: () =>
      ({
        get: (id: string) => [CODY, DORK].find((a) => a.id === id),
        getProjectPath: (id: string) => [CODY, DORK].find((a) => a.id === id)?.projectPath,
        listWithPaths: () => [CODY, DORK],
      }) as never,
    describeSession: async (id) =>
      sessions.get(id) ?? {
        bound: false,
        launchOrigin: null,
        agentPath: null,
        startedByExtension: null,
        roomBound: false,
      },
    chatTitle: async (id) => id,
    sessionCwd: async () => undefined,
    isBusy: async () => false,
    dispatch: async (opts) => {
      // A new id opens the receiving agent's DM chat, bound in its home.
      if (!sessions.has(opts.sessionId)) {
        bind(opts.sessionId, 'chat-message', opts.request.agentPath ?? '');
      }
      return {
        accepted: true,
        queued: false,
        queuePosition: 1,
        outcome: { messageId: opts.messageId, requested: 'queue', applied: 'queue' },
      } as DispatchSessionMessageResult;
    },
    steerInto: async () => false,
    canonicalId: async (id) => id,
    interruptTurn: async () => false,
    turnLevelOf: () => undefined,
    emitActivity: () => undefined,
    onLifecycle: () => () => undefined,
  });
}

beforeEach(() => {
  const db = createTestDb();
  store = new ChatMessageStore(db);
  setMessageQueueStore(new MessageQueueStore(db));
  sessions = new Map();
  bind(BEAT.sessionId, 'heartbeat', CODY.projectPath);
  bind(COORDINATOR.sessionId, 'chat-message', DORK.projectPath);
  // Both are agent work, readable by agents in the space; no person's own chat here.
  initSessionVisibility((ids) => new Map(ids.map((id) => [id, 'space'] as const)));
});

afterEach(() => {
  resetSessionVisibility();
});

it('a beat asks, the answer reaches the asking agent, and the asker can read who it asked', async () => {
  const chats = service();

  // 1. The beat asks the coordinator.
  const asked = await chats.send(BEAT, { to: COORDINATOR.sessionId, message: 'Which branch?' });
  expect(asked.chatId).toBe(COORDINATOR.sessionId);

  // 2. The beat reads the chat it asked, before any answer.
  expect(mayReadChat(store, BEAT, COORDINATOR.sessionId)).toBe(true);
  const history: HistoryMessage[] = [
    { id: 'h1', role: 'assistant', content: 'Looking into it.' } as HistoryMessage,
  ];
  const readDeps: ChatReadDeps = {
    store,
    mayRead: async (caller, target) => mayReadChat(store, caller, target),
    maySeeTitle: async () => true,
    history: async () => history,
    status: () => null,
    describe: async () => ({ title: 'Coordinator', agent: 'DorkOS' }),
    search: async () => [],
  };
  const read = await readChat(readDeps, BEAT, { chat: COORDINATOR.sessionId });
  expect(read.messages.map((m) => m.text)).toEqual(['Looking into it.']);

  // 3. The coordinator answers the beat by its chat id, as the stamp tells it to.
  const answer = await chats.send(COORDINATOR, {
    to: BEAT.sessionId,
    message: 'Use main.',
    replyTo: asked.messageId,
  });

  // 4. The answer lands in Cody's DM chat with the coordinator's agent, threaded.
  expect(answer.chatId).not.toBe(BEAT.sessionId);
  expect(sessions.get(answer.chatId)?.agentPath).toBe(CODY.projectPath);
  expect(store.dmChat(DORK.projectPath, CODY.id)).toBe(answer.chatId);
  expect(store.get(answer.messageId)?.replyToId).toBe(asked.messageId);
  expect(store.get(asked.messageId)?.status).toBe('replied');

  // 5. Where the answer landed, Cody can read the coordinator too.
  const dm = { sessionId: answer.chatId, agentPath: CODY.projectPath };
  expect(mayReadChat(store, dm, COORDINATOR.sessionId)).toBe(true);
});
