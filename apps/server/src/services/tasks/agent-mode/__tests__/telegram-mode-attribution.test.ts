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
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';

afterEach(() => {
  setNotificationService(null);
  setSessionStartedByStore(undefined);
});

it.each([
  ['telegram', 'a Telegram message', false],
  ['slack', 'a Slack message', false],
  ['telegram', 'a Telegram message', true],
  ['slack', 'a Slack message', true],
] as const)(
  'DOR-3848: names %s (%s; room: %s) in the saved notice',
  async (starter, label, room) => {
    const db = createTestDb();
    const tasks = new TaskStore(db);
    // A binding message starts a regular relay chat, not a session_start chat.
    // Its empty started-by store is real; the notice reads these live sources.
    expect(relayTurnOrigin('relay.human.telegram.sample.sender')).toEqual({
      kind: 'relay-binding',
    });
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
    const seen: string[] = [];
    async function* changeMode() {
      const startedBy = turnStarterOf(
        { structural: true, marked: false, sessionId: 'telegram-probe' },
        liveRunOriginSources(tasks)
      );
      seen.push(startedBy);
      if (seen.length === 1)
        expect(
          await announceAgentModeChange(
            { after: task, previousMode: 'default', startedBy, at: '2026-11-03T12:00:00Z' },
            { declaredModes: () => CLAUDE_CODE_CAPABILITIES.permissionModes }
          )
        ).toBe(true);
      yield { type: 'done', data: {} } as StreamEvent;
    }
    const runtime = new FakeAgentRuntime();
    runtime.sendMessage.mockImplementation(changeMode);
    const registry = new RuntimeRegistry();
    registry.setDb(db);
    registry.register(runtime);
    const registered = registry.get(runtime.type);
    const opts: MessageOpts = room
      ? {
          roomTurn: {
            roomId: 'sample-room',
            authorId: 'sample-agent',
            turnId: 'sample-turn',
            turnStarter: starter,
          },
        }
      : { turnStarter: starter };
    for await (const _ of registered.sendMessage('telegram-probe', 'Read the sample list.', opts)) {
      /* consume */
    }
    const notice = notifications.list({ limit: 10, unread: false }).notifications[0]!;
    expect(notice.title).toBe('An agent set Sample sweep to Accept edits');
    expect(notice.body).toBe(`Was Default. Started by ${label}.`);
    expect(
      turnStarterOf(
        { structural: true, marked: false, sessionId: 'telegram-probe' },
        liveRunOriginSources(tasks)
      )
    ).toBe('something DorkOS couldn’t identify');
    for await (const _ of registered.sendMessage('telegram-probe', 'Read it again.', {
      turnStarter: 'person',
    })) {
      /* consume */
    }
    expect(seen).toEqual([label, 'you']);
    tasks.close();
  }
);
