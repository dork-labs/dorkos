import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { pulseRuns } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../../task-store.js';
import { scheduledPromptsFor } from '../scheduled-prompts.js';

describe('scheduledPromptsFor', () => {
  it('answers only the schedules that ran in this chat, once each', () => {
    const db = createTestDb();
    const store = new TaskStore(db);
    const input = { description: 't', cron: '* * * * *' };
    const here = store.createTask({
      ...input,
      name: 'Here',
      prompt: 'Do this',
      filePath: '/tmp/tasks/here/SKILL.md',
    });
    const there = store.createTask({
      ...input,
      name: 'There',
      prompt: 'Do that',
      filePath: '/tmp/tasks/there/SKILL.md',
    });
    const inChat = (taskId: string, sessionId: string) => {
      const run = store.createRun(taskId, 'scheduled');
      db.update(pulseRuns).set({ sessionId }).where(eq(pulseRuns.id, run.id)).run();
    };
    inChat(here.id, 'chat-1');
    inChat(here.id, 'chat-1');
    inChat(there.id, 'chat-2');

    expect(scheduledPromptsFor(db, ['chat-1'])).toEqual([{ prompt: 'Do this', name: 'Here' }]);
    expect(scheduledPromptsFor(db, [])).toEqual([]);
  });
});
