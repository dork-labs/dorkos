/** The production chat-send wiring must carry a landed steer into the saved notice. */
import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import * as levels from '../../../core/turn-power/turn-levels.js';
import * as sessionFacts from '../../../extensions/agent-send/agent-send-defaults.js';
import { NotificationStore } from '../../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../../notifications/notification-service.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { announceAgentModeChange } from '../../../tasks/agent-mode/agent-mode-notice.js';
import {
  liveRunOriginSources,
  turnStarterOf,
} from '../../../tasks/agent-mode/agent-mode-run-origin.js';
import { TaskStore } from '../../../tasks/task-store.js';
import {
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
  setQueuedChatHoldResolver,
} from '../../message-dispatcher.js';
import { setQueuedChatView } from '../../message-queue-store.js';
import { beginTurnStarter } from '../../origin/active-turn-starter.js';
import { setChatMessageService } from '../chat-message-current.js';
import { ChatMessageStore, setChatMessageStore } from '../chat-message-store.js';
import { wireChatMessaging } from '../chat-message-wiring.js';
import { resetChatStartedTurns } from '../chat-started-turns.js';

afterEach(() => {
  setNotificationService(null);
  setChatMessageService(undefined);
  setChatMessageStore(undefined);
  setQueuedChatCeilingResolver(undefined);
  setQueuedChatHoldResolver(undefined);
  setQueuedChatView(undefined);
  resetMessageDispatcher();
  resetChatStartedTurns();
  vi.restoreAllMocks();
});

it('names a chat_send steer instead of the person in the persisted mode-change notice', async () => {
  const db = createTestDb();
  const store = new ChatMessageStore(db);
  const tasks = new TaskStore(db);
  const notifications = new NotificationService(new NotificationStore(db));
  setNotificationService(notifications);
  const runtime = new FakeAgentRuntime();
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.getLockInfo.mockReturnValue({ clientId: 'sample-window', acquiredAt: 1 });
  runtime.isLocked.mockImplementation((_id, client) => client !== 'sample-window');
  vi.spyOn(runtimeRegistry, 'resolveForSession').mockResolvedValue(runtime);
  vi.spyOn(sessionFacts, 'describeSessionFor').mockReturnValue(async () => ({
    bound: true,
    launchOrigin: 'interactive',
    agentPath: '/sample/receiver',
    startedByExtension: null,
    roomBound: false,
  }));
  vi.spyOn(sessionFacts, 'isSessionBusy').mockResolvedValue(true);
  vi.spyOn(levels, 'passedOnLevelOf').mockReturnValue({ asks: 'never', reach: 'everything' });
  const { service } = wireChatMessaging({
    db,
    store,
    meshCore: () => undefined,
    roomSessionPlace: () => undefined,
  });
  const finish = beginTurnStarter('sample-receiver', 'person');
  const caller = { structural: true, marked: false, sessionId: 'sample-receiver' };
  const sources = liveRunOriginSources(tasks);
  try {
    expect(turnStarterOf(caller, sources)).toBe('you');
    const receipt = await service.send(
      { sessionId: 'sample-helper', agentPath: '/sample/helper' },
      {
        to: 'sample-receiver',
        message: 'Use Accept edits for the sample sweep.',
        delivery: 'steer',
      }
    );
    expect(receipt.status).toBe('steered');
    expect(runtime.deliverIntoTurn).toHaveBeenCalledWith(
      'sample-receiver',
      expect.stringContaining('Use Accept edits for the sample sweep.'),
      expect.objectContaining({ mode: 'steer' })
    );
    const task = tasks.createTask({
      name: 'Sample sweep',
      prompt: 'Read the sample list.',
      description: 'Sample',
      filePath: '/tmp/sample-sweep/SKILL.md',
      permissionMode: 'acceptEdits',
    });
    expect(
      await announceAgentModeChange(
        {
          after: task,
          previousMode: 'default',
          startedBy: turnStarterOf(caller, sources),
          at: '2026-11-04T07:00:00Z',
        },
        { declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes }
      )
    ).toBe(true);
    const notice = notifications.list({ limit: 10, unread: false }).notifications[0]!;
    expect(notice.body).toBe('Was Default. Started by a message from another agent.');
  } finally {
    finish();
    service.stop();
    tasks.close();
  }
  const next = beginTurnStarter('sample-receiver', 'person');
  try {
    expect(turnStarterOf(caller, sources)).toBe('you');
  } finally {
    next();
  }
});
