/**
 * Registry invocations in the audit log (spec `audit-trail` PR2): an
 * unidentified change reaches the audit log without touching the Activity
 * feed, an identified one is recorded exactly once, and what a capability
 * records while it runs names the agent that called it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { activityEvents, auditEvents, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { ActivityService } from '../../../activity/activity-service.js';
import {
  composeRegistry,
  defineCapability,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import { createCapabilityAttributionObserver } from '../capability-attribution.js';
import type { AgentIdentity } from '../agent-identity-service.js';
import { wireAuditTrail } from '../../../audit/wire-audit-trail.js';
import { recordAudit, resetAuditTrail } from '../../../audit/audit-trail.js';
import { runWithAuditActor } from '../../../audit/audit-context.js';

const IDENTITY: AgentIdentity = {
  agentPath: '/projects/researcher',
  displayName: 'Researcher',
  createdAt: new Date().toISOString(),
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('capability calls in the audit log', () => {
  let db: Db;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    db = createTestDb();
    const activity = new ActivityService(db);
    wireAuditTrail({ db, activity, installId: 'inst-1', readOwnerAccount: () => null });
    registry = composeRegistry(
      [
        {
          name: 'demo',
          capabilities: [
            defineCapability({
              id: 'demo.change',
              title: 'Change a thing',
              description: 'Changes something reversible, and records a write of its own.',
              tier: 'act',
              area: null,
              input: z.object({}),
              output: z.object({ ok: z.boolean() }),
              surfaces: {},
              invoke: async () => {
                recordAudit({
                  action: 'demo.wrote',
                  operation: 'modify',
                  outcome: 'ok',
                  summary: 'Wrote',
                });
                return { ok: true };
              },
            }),
            defineCapability({
              id: 'demo.read',
              title: 'Read a thing',
              description: 'Reads.',
              tier: 'observe',
              area: null,
              input: z.object({}),
              output: z.object({ ok: z.boolean() }),
              surfaces: {},
              invoke: async () => ({ ok: true }),
            }),
          ],
        },
      ],
      { logger: noopLogger },
      createCapabilityAttributionObserver(activity)
    );
  });

  afterEach(() => resetAuditTrail());

  const audit = () =>
    db
      .select()
      .from(auditEvents)
      .all()
      .map((row) => [row.action, row.actorKind, row.actorId]);

  it('records an unidentified change in the audit log, under the request actor, and not in Activity', async () => {
    const owner = {
      actor: { accountId: 'install:inst-1', kind: 'person' as const, name: 'Owner' },
      surface: 'app' as const,
    };
    await runWithAuditActor(owner, () => registry.invoke('demo.change', {}));
    await flush();

    expect(db.select().from(activityEvents).all()).toHaveLength(0);
    expect(audit()).toEqual([
      ['demo.wrote', 'person', 'install:inst-1'],
      ['capability.invoked', 'person', 'install:inst-1'],
    ]);
  });

  it('records an identified change once, through Activity, and names the agent for its writes', async () => {
    const owner = {
      actor: { accountId: 'install:inst-1', kind: 'person' as const, name: 'Owner' },
      surface: 'app' as const,
    };
    // The person's scope surrounds the call (their message started the turn).
    await runWithAuditActor(owner, () =>
      registry.invoke('demo.change', {}, { identity: IDENTITY })
    );
    await flush();

    const rows = audit();
    expect(rows.filter(([action]) => action === 'capability.invoked')).toHaveLength(1);
    expect(rows.map(([action, kind]) => [action, kind])).toEqual([
      ['demo.wrote', 'agent'],
      ['capability.invoked', 'agent'],
    ]);
  });

  it('records an unidentified read as nothing', async () => {
    await registry.invoke('demo.read', {});
    await flush();
    expect(audit()).toEqual([]);
  });
});
