/**
 * Every Activity event lands in the audit log (spec `audit-trail` §3.5), through
 * the real `ActivityService` and the real database: one audit row per Activity
 * row, keyed on stable ids, linked back.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, auditEvents, type Db } from '@dorkos/db';
import { ActivityService } from '../../activity/activity-service.js';
import { AuditLog } from '../audit-log.js';
import { AccountIds } from '../account-ids.js';
import { createActivityTee, operationFor, outcomeFor } from '../activity-tee.js';

const AGENT_PATH = '/projects/scout';
const AGENT_ID = '01SCOUTAGENTULID0000000000';

describe('the Activity tee', () => {
  let db: Db;
  let activity: ActivityService;
  let log: AuditLog;

  beforeEach(() => {
    db = createTestDb();
    const now = new Date().toISOString();
    db.insert(agents)
      .values({
        id: AGENT_ID,
        name: 'scout',
        runtime: 'claude-code',
        projectPath: AGENT_PATH,
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    activity = new ActivityService(db);
    log = new AuditLog(db);
    const ids = new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null });
    activity.observe(createActivityTee(log, ids));
  });

  it('copies each Activity event into the audit log exactly once, linked back', async () => {
    await activity.emit({
      actorType: 'agent',
      actorId: AGENT_PATH,
      actorLabel: 'Scout',
      category: 'agent',
      eventType: 'agent.session_started',
      resourceType: 'agent',
      resourceId: AGENT_PATH,
      resourceLabel: 'Scout',
      summary: 'Scout started a chat',
      metadata: { sessionId: 'sess-1' },
    });

    const [activityRow] = (await activity.list({ limit: 10 })).items;
    const rows = log.verify();
    expect(rows).toMatchObject({ ok: true, checked: 1 });
    const [stored] = db.select().from(auditEvents).all();
    expect(stored).toMatchObject({
      actorId: AGENT_ID,
      actorKind: 'agent',
      actorName: 'Scout',
      action: 'agent.session_started',
      operation: 'create',
      outcome: 'ok',
      targetType: 'agent',
      targetId: AGENT_ID,
      sessionId: 'sess-1',
      visibility: 'space',
    });
    expect(JSON.parse(stored!.links!)).toEqual({ activityId: activityRow!.id });
    expect(JSON.stringify(stored)).not.toContain(AGENT_PATH);
  });

  it('names the person at this computer by the owner id, never "You"', async () => {
    await activity.emit({
      actorType: 'user',
      actorLabel: 'You',
      category: 'config',
      eventType: 'config.binding_deleted',
      summary: 'You removed a binding',
    });
    const [stored] = db.select().from(auditEvents).all();
    expect(stored).toMatchObject({
      actorId: 'install:inst-1',
      actorKind: 'person',
      operation: 'remove',
    });
  });

  it('keeps an unidentified caller apart from DorkOS itself', async () => {
    await activity.emit({
      actorType: 'system',
      actorLabel: 'Unidentified caller',
      category: 'agent',
      eventType: 'capability.invoked',
      summary: 'An unidentified caller ran something',
    });
    await activity.emit({
      actorType: 'system',
      actorLabel: 'System',
      category: 'system',
      eventType: 'system.started',
      summary: 'DorkOS started',
    });
    const stored = db.select().from(auditEvents).all();
    expect(stored.map((r) => [r.actorId, r.actorKind])).toEqual([
      ['unidentified', 'external'],
      ['system', 'system'],
    ]);
  });

  it('reads operation and outcome off the verb', () => {
    expect(operationFor('relay.adapter_added')).toBe('create');
    expect(operationFor('tasks.task_deleted')).toBe('remove');
    expect(operationFor('tasks.run_cancelled')).toBe('execute');
    expect(operationFor('capability.invoked')).toBe('execute');
    expect(operationFor('tasks.task_paused')).toBe('modify');
    expect(outcomeFor('relay.message_failed')).toBe('failed');
    expect(outcomeFor('capability.request_refused')).toBe('refused');
    expect(outcomeFor('tasks.task_approved')).toBe('ok');
  });
});
