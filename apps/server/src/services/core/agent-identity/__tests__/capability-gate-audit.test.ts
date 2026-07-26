/**
 * What the Activity feed says about a call nobody was asked about
 * (spec `agent-approval-settings` §3.6).
 *
 * This is the answer to the question a standing permission creates: what did my
 * agent do while I was not being asked? A window in which DorkOS goes quiet must not
 * also be a window in which it goes blind, so the gate writes one
 * `capability.auto_approved` line every time a permission lets a destructive call
 * through.
 *
 * ## Where the line comes from, and why that placement matters
 *
 * It is written by the GATE's observer, not the registry's attribution observer.
 * The gate has three callers and the attribution observer only sees one of them:
 * the 47 hand-registered MCP tools never reach `registry.invoke`, so an attribution
 * observer would have missed every one of them. Putting the line at the gate covers
 * all three surfaces by construction.
 *
 * The cost of that choice is stated here rather than left to be discovered: on a
 * registry-borne surface an auto-approved destructive call produces TWO rows, and
 * the last case in this file asserts both. They say different things — "you were not
 * asked about this" and "it ran" (or "it failed") — and the second is the only one
 * that can report a failure, because the gate decides before the work starts.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createTestDb } from '@dorkos/test-utils/db';
import { activityEvents, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';

import { ActivityService } from '../../../activity/activity-service.js';
import {
  composeRegistry,
  defineCapability,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type CapabilityDeps,
  type CapabilityRegistry,
} from '../../capabilities/index.js';
import { enforceCapabilityTier } from '../../capabilities/tier-enforcement.js';
import { gatedActionForMcpTool } from '../../mcp-tool-tiers.js';
import { ApprovalGrantService, ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { createCapabilityAttributionObserver } from '../capability-attribution.js';
import { createCapabilityGateAuditObserver } from '../capability-gate-audit.js';
import type { AgentIdentity } from '../agent-identity-service.js';

const IDENTITY: AgentIdentity = {
  agentPath: '/projects/researcher',
  displayName: 'Researcher',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

/** The destructive capability every case reaches for. */
const DESTROY = defineCapability({
  id: 'demo.destroy',
  title: 'Destroy a thing',
  description: 'Cannot be undone.',
  tier: 'destructive',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  surfaces: {},
  invoke: async () => ({ ok: true }),
});

describe('the gate records a call a standing permission let through', () => {
  let db: Db;
  let grants: ApprovalGrantService;
  let activity: ActivityService;

  /** Activity writes are fire-and-forget; let the microtask queue drain. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    db = createTestDb();
    grants = new ApprovalGrantService(db);
    activity = new ActivityService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({
      approvals: new ApprovalService(db),
      onAttempt: createCapabilityGateAuditObserver(activity),
      standingGrants: {
        enabled: () => true,
        findLive: (agentPath, capabilityId) => grants.findLive(agentPath, capabilityId),
      },
    });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  /** Open a permission covering the destructive capability. */
  function permit() {
    return grants.create({
      agentPath: IDENTITY.agentPath,
      capabilityId: DESTROY.id,
      grantedBy: 'user_owner',
      posture: 'signed-in-operator',
      windowMinutes: 480,
    });
  }

  /** Reach the gate the way the hand-registered MCP tools do: directly. */
  function gateDirectly() {
    return enforceCapabilityTier({
      action: DESTROY,
      input: {},
      identity: IDENTITY,
      retryChannel: 'mcp-argument',
    });
  }

  it('writes one auto_approved row naming the agent, the action, and the permission', async () => {
    const row = permit();

    expect(gateDirectly().outcome).toBe('allowed');
    await flush();

    const rows = db.select().from(activityEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'agent',
      actorId: '/projects/researcher',
      actorLabel: 'Researcher',
      category: 'agent',
      eventType: 'capability.auto_approved',
      resourceType: 'capability',
      resourceId: 'demo.destroy',
      resourceLabel: 'Destroy a thing',
      summary: 'Researcher ran Destroy a thing under a standing permission you granted',
    });
    expect(JSON.parse(rows[0].metadata!)).toEqual({
      capabilityId: 'demo.destroy',
      tier: 'destructive',
      grantId: row.id,
    });
  });

  it('covers the hand-registered MCP tools too, which no attribution observer sees', async () => {
    // The reason the line lives at the gate. These 47 tools are not registry
    // capabilities, so they never reach `registry.invoke` and never reach the
    // attribution observer — an approved `tasks_delete` used to leave a "waiting for
    // approval" line and then silence about the deletion itself.
    grants.create({
      agentPath: IDENTITY.agentPath,
      capabilityId: 'tasks_delete',
      grantedBy: 'user_owner',
      posture: 'signed-in-operator',
      windowMinutes: 480,
    });

    // The REAL table, not a hand-built literal. A literal would keep this test green
    // if `tasks_delete` were demoted to `act` tomorrow — the tool would stop being
    // gated at all and the claim in this test's name would quietly stop being true.
    const action = gatedActionForMcpTool('tasks_delete');
    expect(action.tier, 'this case only says anything while the tool is gated').toBe('destructive');

    const decision = enforceCapabilityTier({
      action,
      input: { id: 'task_01' },
      identity: IDENTITY,
      retryChannel: 'mcp-argument',
    });
    await flush();

    expect(decision.outcome).toBe('allowed');
    const rows = db.select().from(activityEvents).all();
    expect(rows.map((r) => r.eventType)).toEqual(['capability.auto_approved']);
    expect(rows[0].resourceId).toBe('tasks_delete');
    expect(rows[0].resourceLabel).toBe(action.title);
  });

  it('writes nothing extra when the same call has to ask a person', async () => {
    expect(gateDirectly().outcome).toBe('approval_required');
    await flush();

    const rows = db.select().from(activityEvents).all();
    expect(rows.map((r) => r.eventType)).toEqual(['capability.approval_required']);
  });

  it('says the person was not asked AND says the call ran, on a registry surface', async () => {
    // Both observers wired, which is the production shape for anything reachable
    // through `registry.invoke`. Two rows, deliberately: only the gate knows nobody
    // was asked, and only the attribution observer can report the outcome.
    const deps: CapabilityDeps = { logger: noopLogger };
    const registry: CapabilityRegistry = composeRegistry(
      [{ name: 'demo', capabilities: [DESTROY] }],
      deps,
      createCapabilityAttributionObserver(activity)
    );
    const row = permit();

    await registry.invoke(DESTROY.id, {}, { identity: IDENTITY });
    await flush();

    const rows = db.select().from(activityEvents).all();
    expect(rows.map((r) => r.eventType)).toEqual([
      'capability.auto_approved',
      'capability.invoked',
    ]);
    // The invocation row names the permission rather than an approval id, so the two
    // proofs of consent stay distinguishable in the feed.
    expect(JSON.parse(rows[1].metadata!)).toEqual({
      capabilityId: 'demo.destroy',
      tier: 'destructive',
      grantId: row.id,
    });
  });
});
