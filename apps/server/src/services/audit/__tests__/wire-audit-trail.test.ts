/**
 * The audit trail as startup builds it (spec `audit-trail`): Activity is teed
 * in, the chain is checked, and a broken chain does not stop startup.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents } from '@dorkos/db';
import { ActivityService } from '../../activity/activity-service.js';
import { wireAuditTrail } from '../wire-audit-trail.js';

describe('wireAuditTrail', () => {
  it('copies Activity into the audit log under the install owner', async () => {
    const db = createTestDb();
    const activity = new ActivityService(db);
    const { log } = wireAuditTrail({
      db,
      activity,
      installId: 'inst-1',
      readOwnerAccount: () => null,
    });
    await activity.emit({
      actorType: 'user',
      actorLabel: 'You',
      category: 'config',
      eventType: 'config.binding_created',
      summary: 'You added a binding',
    });
    expect(db.select().from(auditEvents).all()).toMatchObject([
      { actorId: 'install:inst-1', action: 'config.binding_created' },
    ]);
    expect(log.verify()).toMatchObject({ ok: true, checked: 1 });
  });

  it('starts over a broken chain without throwing', () => {
    const db = createTestDb();
    const first = wireAuditTrail({
      db,
      activity: new ActivityService(db),
      installId: 'inst-1',
      readOwnerAccount: () => null,
    });
    first.log.record({
      actor: first.accounts.system(),
      source: { surface: 'system' },
      action: 'system.started',
      operation: 'execute',
      outcome: 'ok',
      summary: 'DorkOS started',
    });
    db.$client.exec('DROP TRIGGER audit_events_append_only_update');
    db.$client.exec("UPDATE audit_events SET summary = 'edited'");
    expect(() =>
      wireAuditTrail({
        db,
        activity: new ActivityService(db),
        installId: 'inst-1',
        readOwnerAccount: () => null,
      })
    ).not.toThrow();
  });
});
