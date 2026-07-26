import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { activityEvents, type Db } from '@dorkos/db';
import { ActivityService } from '../../../activity/activity-service.js';
import {
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  trustedCaller,
} from '../../capabilities/index.js';
import { ApprovalService, hashApprovalInput } from '../../approvals/index.js';
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
            id: 'demo.destroy',
            title: 'Destroy a thing',
            description: 'Cannot be undone.',
            tier: 'destructive',
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
  let approvals: ApprovalService;

  beforeEach(() => {
    db = createTestDb();
    registry = buildRegistry(new ActivityService(db));
    // The tier gate lives inside `registry.invoke` now (DOR-467), so a
    // destructive capability needs a real granted approval to reach its handler.
    approvals = new ApprovalService(db);
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
  });

  /**
   * Ask for an approval on `capabilityId` with an empty input, have a person
   * grant it, and return the token to spend — the exact sequence a caller
   * performs, rather than a hand-built approval the gate never issued.
   */
  function grantedTokenFor(capabilityId: string): { token: string; approvalId: string } {
    const ticket = approvals.request({
      capabilityId,
      inputHash: hashApprovalInput({}),
      summary: `A caller wants to run "${capabilityId}"`,
    });
    approvals.grant(ticket.approvalId);
    return { token: ticket.token, approvalId: ticket.approvalId };
  }

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
    const { token } = grantedTokenFor('demo.explode');
    await expect(
      registry.invoke('demo.explode', {}, { identity: IDENTITY, approvalToken: token })
    ).rejects.toThrow('boom');
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

  // ── …except for an irreversible action, which is ALWAYS recorded ───────────

  it('records an anonymous DESTRUCTIVE invocation that succeeded', async () => {
    // The defect this closes: the tier gate does not audit calls it allows (it
    // defers to this observer), and this observer used to bail on a missing
    // identity — so an anonymous destructive call that RAN produced a
    // `capability.approval_required` line and then silence about the irreversible
    // thing that happened.
    // The gate now lives inside `invoke` (DOR-467), so the approval has to be
    // real: ask for one, have a person grant it, then spend it on the retry —
    // which is exactly the sequence a caller performs.
    const ticket = grantedTokenFor('demo.destroy');

    await registry.invoke('demo.destroy', {}, { approvalToken: ticket.token });
    await flush();

    const rows = db.select().from(activityEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // `system`, not a nameless agent: the feed must not imply DorkOS knows who.
      actorType: 'system',
      actorId: null,
      actorLabel: 'Unidentified caller',
      eventType: 'capability.invoked',
      resourceId: 'demo.destroy',
    });
    expect(JSON.parse(rows[0].metadata!)).toEqual({
      capabilityId: 'demo.destroy',
      tier: 'destructive',
      approvalId: ticket.approvalId,
    });
  });

  it('records an anonymous DESTRUCTIVE invocation that failed', async () => {
    // A trusted caller — the person in their own cockpit — runs without an
    // approval, and the record still has to be written: this test is about the
    // OBSERVER not skipping an anonymous destructive call, not about the gate.
    const trusted = trustedCaller({
      agentIdentityPresented: false,
      approvalTokenPresented: false,
      loginEnabled: () => false,
    })!;
    await expect(registry.invoke('demo.explode', {}, { trusted })).rejects.toThrow('boom');
    await flush();

    const rows = db.select().from(activityEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'system',
      actorLabel: 'Unidentified caller',
      eventType: 'capability.failed',
      resourceId: 'demo.explode',
    });
  });

  it('still writes nothing for an anonymous act-tier call, which would just be noise', async () => {
    const actOnly = composeRegistry(
      [
        {
          name: 'demo',
          capabilities: [
            defineCapability({
              id: 'demo.change',
              title: 'Change a thing',
              description: 'Changes something reversible.',
              tier: 'act',
              input: z.object({}),
              output: z.object({ ok: z.boolean() }),
              surfaces: {},
              invoke: async () => ({ ok: true }),
            }),
          ],
        },
      ],
      { logger: noopLogger },
      createCapabilityAttributionObserver(new ActivityService(db))
    );

    await actOnly.invoke('demo.change', {});
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
