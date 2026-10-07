/**
 * A schedule's firings are DorkOS's own, never the person who created it
 * (spec `audit-trail` PR2 review). A task is registered inside the creator's
 * request, and a timer keeps the scope it was created in for every later
 * firing, so without `outsideAuditScope` every run it ever made would name
 * them. This registers a real every-second cron INSIDE a person's scope and
 * reads the scope the firing actually runs in.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Task } from '@dorkos/shared/types';
import { TaskSchedulerService } from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';
import {
  currentAuditActor,
  runWithAuditActor,
  type AuditActorContext,
} from '../../audit/audit-context.js';

describe('scheduled firings and the audit scope', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fires outside the scope of the request that registered the task', async () => {
    const seen: (AuditActorContext | undefined)[] = [];
    vi.spyOn(
      TaskSchedulerService.prototype as unknown as { dispatch: () => Promise<void> },
      'dispatch'
    ).mockImplementation(async () => {
      seen.push(currentAuditActor());
    });
    const store = new TaskStore(createTestDb());
    const task = store.createTask({
      name: 'Every second',
      description: 'test',
      prompt: 'test',
      cron: '* * * * * *',
      filePath: '/tmp/tasks/every-second/SKILL.md',
    });
    const scheduler = new TaskSchedulerService(store, {} as never, {
      maxConcurrentRuns: 1,
      retentionCount: 100,
      mayFire: true,
      firingReason: 'test',
    });
    const creator: AuditActorContext = {
      actor: { accountId: 'install:inst-1', kind: 'person', name: 'Owner' },
      surface: 'app',
    };

    runWithAuditActor(creator, () => scheduler.registerTask(task as Task));
    try {
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 3000 });
    } finally {
      scheduler.unregisterTask(task.id);
    }

    expect(seen[0]).toBeUndefined();
  });
});
