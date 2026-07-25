import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { activityEvents, type Db } from '@dorkos/db';
import { ActivityService } from '../../../activity/activity-service.js';
import { composeRegistry, defineCapability } from '../../capabilities/index.js';
import type { CapabilityDeps, CapabilityRegistry } from '../../capabilities/index.js';
import { createCapabilityAttributionObserver } from '../capability-attribution.js';
import type { AgentIdentity } from '../agent-identity-service.js';
import { noopLogger } from '@dorkos/shared/logger';

const IDENTITY: AgentIdentity = {
  agentPath: '/projects/researcher',
  displayName: 'Researcher',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

/** A registry with one passing and one throwing capability. */
function buildRegistry(activityService: ActivityService): CapabilityRegistry {
  const deps: CapabilityDeps = { logger: noopLogger };
  return composeRegistry(
    [
      {
        name: 'demo',
        capabilities: [
          defineCapability({
            id: 'demo.read',
            title: 'Read a thing',
            description: 'Reads.',
            tier: 'observe',
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            surfaces: {},
            invoke: async () => ({ ok: true }),
          }),
          defineCapability({
            id: 'demo.explode',
            title: 'Explode',
            description: 'Throws.',
            tier: 'destructive',
            input: z.object({}),
            output: z.unknown(),
            surfaces: {},
            invoke: async () => {
              throw new Error('boom');
            },
          }),
        ],
      },
    ],
    deps,
    createCapabilityAttributionObserver(activityService)
  );
}

describe('capability attribution', () => {
  let db: Db;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = buildRegistry(new ActivityService(db));
  });

  /** Activity writes are fire-and-forget; let the microtask queue drain. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('attributes an identified agent invocation in the Activity feed', async () => {
    await registry.invoke('demo.read', {}, { identity: IDENTITY });
    await flush();

    const rows = db.select().from(activityEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'agent',
      actorId: '/projects/researcher',
      actorLabel: 'Researcher',
      category: 'agent',
      eventType: 'capability.invoked',
      resourceType: 'capability',
      resourceId: 'demo.read',
      resourceLabel: 'Read a thing',
    });
    expect(JSON.parse(rows[0].metadata!)).toEqual({ capabilityId: 'demo.read', tier: 'observe' });
  });

  it('audits a failed attempt too, and still propagates the error', async () => {
    await expect(registry.invoke('demo.explode', {}, { identity: IDENTITY })).rejects.toThrow(
      'boom'
    );
    await flush();

    const rows = db.select().from(activityEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'agent',
      actorId: '/projects/researcher',
      eventType: 'capability.failed',
      resourceId: 'demo.explode',
    });
  });

  it('falls back to the directory name when the identity has no display name', async () => {
    await registry.invoke('demo.read', {}, { identity: { ...IDENTITY, displayName: '' } });
    await flush();

    const [row] = db.select().from(activityEvents).all();
    expect(row.actorLabel).toBe('researcher');
  });

  // ── The unattributed path must stay exactly as it was ─────────────────────

  it('writes NOTHING when the call carries no identity', async () => {
    const result = await registry.invoke('demo.read', {});
    await flush();

    expect(result).toEqual({ ok: true });
    expect(db.select().from(activityEvents).all()).toHaveLength(0);
  });

  it('writes nothing when a context is supplied without an identity', async () => {
    await registry.invoke('demo.read', {}, {});
    await flush();

    expect(db.select().from(activityEvents).all()).toHaveLength(0);
  });

  it('returns the capability result unchanged when attributed', async () => {
    const attributed = await registry.invoke('demo.read', {}, { identity: IDENTITY });
    const anonymous = await registry.invoke('demo.read', {});

    expect(attributed).toEqual(anonymous);
  });

  it('does not let an observer failure break the invocation', async () => {
    const exploding = composeRegistry(
      [
        {
          name: 'demo',
          capabilities: [
            defineCapability({
              id: 'demo.read',
              title: 'Read a thing',
              description: 'Reads.',
              tier: 'observe',
              input: z.object({}),
              output: z.object({ ok: z.boolean() }),
              surfaces: {},
              invoke: async () => ({ ok: true }),
            }),
          ],
        },
      ],
      { logger: noopLogger },
      () => {
        throw new Error('observer exploded');
      }
    );

    await expect(exploding.invoke('demo.read', {}, { identity: IDENTITY })).resolves.toEqual({
      ok: true,
    });
  });
});
