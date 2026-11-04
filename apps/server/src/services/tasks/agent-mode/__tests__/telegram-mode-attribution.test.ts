import { afterEach, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../../task-store.js';
import { liveRunOriginSources, turnStarterOf } from '../agent-mode-run-origin.js';
import { announceAgentModeChange } from '../agent-mode-notice.js';
import { relayTurnOrigin } from '../../../session/origin/turn-origin.js';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../../session/origin/session-started-by-store.js';
import { NotificationStore } from '../../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../../notifications/notification-service.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';

afterEach(() => {
  setNotificationService(null);
  setSessionStartedByStore(undefined);
});

it('DOR-3848: records the current incorrect person attribution for a Telegram-started raise', async () => {
  const db = createTestDb();
  const tasks = new TaskStore(db);
  // A binding message starts a regular relay chat, not a session_start chat.
  // Its empty started-by store is real; the notice reads these live sources.
  expect(relayTurnOrigin('relay.human.telegram.sample.sender')).toEqual({ kind: 'relay-binding' });
  setSessionStartedByStore(new SessionStartedByStore(db));
  const notifications = new NotificationService(new NotificationStore(db));
  setNotificationService(notifications);
  const task = tasks.createTask({
    name: 'Sample sweep',
    prompt: 'Read the sample list.',
    description: 'Sample',
    filePath: '/tmp/sample-sweep/SKILL.md',
    permissionMode: 'acceptEdits',
  });
  const startedBy = turnStarterOf(
    { structural: true, marked: false, sessionId: 'telegram-probe' },
    liveRunOriginSources(tasks)
  );
  expect(
    await announceAgentModeChange(
      { after: task, previousMode: 'default', startedBy, at: '2026-11-03T12:00:00Z' },
      { declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes }
    )
  ).toBe(true);
  const notice = notifications.list({ limit: 10, unread: false }).notifications[0]!;
  // Characterization only: DOR-3848 is deliberately unfixed in this branch.
  expect(notice.title).toBe('An agent set Sample sweep to Accept edits');
  expect(notice.body).toBe('Was Default. Started by you.');
});
