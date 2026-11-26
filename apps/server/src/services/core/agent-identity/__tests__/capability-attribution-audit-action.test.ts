/**
 * A capability that declares an `auditAction` is recorded the way the
 * hand-registered tool gate records a tool (`mcp-tool-gate.ts`), so a tool that
 * moves onto the registry keeps the audit rows people filter on (spec
 * `computer-side-starts-alone` §5.1, step C8). One without it records exactly
 * what it did before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { activityEvents, auditEvents, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { ActivityService } from '../../../activity/activity-service.js';
import { composeRegistry, defineCapability } from '../../capabilities/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../capabilities/permission-enforcement.js';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../../mcp-tool-gate.js';
import {
  initApprovalSubjectResolvers,
  resetApprovalSubjectResolvers,
} from '../../approvals/approval-subject.js';
import { createCapabilityAttributionObserver } from '../capability-attribution.js';
import type { AgentIdentity } from '../agent-identity-service.js';
import { wireAuditTrail } from '../../../audit/wire-audit-trail.js';
import { resetAuditTrail } from '../../../audit/audit-trail.js';

const IDENTITY: AgentIdentity = {
  agentPath: '/made-up/agents/researcher',
  displayName: 'Researcher',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A capability standing in for `tasks_delete` once it moves, keeping its audit name. */
function deleteTask(fail = false) {
  return defineCapability({
    id: 'probe.delete_task',
    title: 'Delete a scheduled task',
    description: 'A probe for a hand tool that moved onto the registry.',
    tier: 'destructive',
    area: 'tasks',
    approvalDisplayFields: ['id'],
    approvalSubject: { field: 'id', kind: 'task' },
    auditAction: 'mcp.tasks_delete',
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    surfaces: {},
    invoke: async () => {
      if (fail) throw new Error('the task store is closed');
      return { ok: true };
    },
  });
}

const readTask = defineCapability({
  id: 'probe.read_task',
  title: 'Read a scheduled task',
  description: 'A probe read that kept its audit name.',
  tier: 'observe',
  area: 'tasks',
  auditAction: 'mcp.tasks_get',
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  surfaces: {},
  invoke: async () => ({ ok: true }),
});

const plainChange = defineCapability({
  id: 'probe.change',
  title: 'Change a thing',
  description: 'A probe with no audit name of its own.',
  tier: 'act',
  area: null,
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  surfaces: {},
  invoke: async () => ({ ok: true }),
});

/** A fresh audit trail, a registry on it, and the hand tool `tasks_delete` behind its gate. */
function world(opts: { fail?: boolean } = {}) {
  const db = createTestDb();
  const activity = new ActivityService(db);
  wireAuditTrail({ db, activity, installId: 'inst-1', readOwnerAccount: () => null });
  initApprovalSubjectResolvers({ task: (id) => (id === 't1' ? 'Morning digest' : undefined) });
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  initCapabilityTierGate({ approvals: new ApprovalService(db) });
  initPermissionGate({
    readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
  });
  const registry = composeRegistry(
    [{ name: 'probe', capabilities: [deleteTask(opts.fail), readTask, plainChange] }],
    { logger: noopLogger },
    createCapabilityAttributionObserver(activity)
  );
  const handTool: SdkMcpTool = {
    name: 'tasks_delete',
    description: 'probe',
    inputSchema: {},
    handler: (async () => {
      if (opts.fail) throw new Error('the task store is closed');
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    }) as unknown as SdkMcpTool['handler'],
  };
  const [gated] = gateHandRegisteredMcpTools(
    [handTool],
    async () => ({ identity: IDENTITY }),
    undefined,
    () => ({ sessionId })
  );
  return {
    db,
    registry,
    hand: (args: Record<string, unknown>) =>
      gated!.handler(args as never, {}) as Promise<CallToolResult>,
  };
}

/** The audit rows, without what differs per write (ids, times, the chain). */
function auditRows(db: Db) {
  return db
    .select()
    .from(auditEvents)
    .all()
    .map((row) => ({
      action: row.action,
      operation: row.operation,
      actorKind: row.actorKind,
      actorName: row.actorName,
      source: row.source,
      sessionId: row.sessionId,
      targetType: row.targetType,
      targetId: row.targetId,
      targetName: row.targetName,
      outcome: row.outcome,
      summary: row.summary,
    }));
}

/**
 * Each test's own chat. A probe id is not in the read table, so a call through
 * the registry marks its chat as having read outside words, and the next
 * destructive call in that chat would ask.
 */
let sessionId = '';
let chats = 0;
const inSession = () => ({ identity: IDENTITY, mcpServer: 'in-session' as const, sessionId });

beforeEach(() => {
  chats += 1;
  sessionId = `ses-${chats}`;
});

afterEach(() => {
  resetAuditTrail();
  resetApprovalSubjectResolvers();
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
});

describe('a capability with an auditAction', () => {
  it('records its call exactly as the hand gate records the tool it replaces', async () => {
    const before = world();
    await before.hand({ id: 't1' });
    await flush();
    const handRow = auditRows(before.db).find((row) => row.action === 'mcp.tasks_delete');

    const after = world();
    await after.registry.invoke('probe.delete_task', { id: 't1' }, inSession());
    await flush();
    const rows = auditRows(after.db);

    expect(handRow).toMatchObject({
      operation: 'remove',
      actorKind: 'agent',
      sessionId,
      targetName: 'Morning digest',
      outcome: 'ok',
      summary: 'Ran Delete a scheduled task on Morning digest',
    });
    expect(rows.find((row) => row.action === 'mcp.tasks_delete')).toEqual(handRow);
    // Recorded once, under its own name: no `capability.invoked` row beside it.
    expect(rows.map((row) => row.action)).not.toContain('capability.invoked');
  });

  it('records a failed call under the same name, as the hand gate does', async () => {
    const before = world({ fail: true });
    await expect(before.hand({ id: 't1' })).rejects.toThrow('the task store is closed');
    const after = world({ fail: true });
    await expect(
      after.registry.invoke('probe.delete_task', { id: 't1' }, inSession())
    ).rejects.toThrow('the task store is closed');
    await flush();

    const failed = (db: Db) => auditRows(db).find((row) => row.action === 'mcp.tasks_delete');
    expect(failed(after.db)).toMatchObject({ outcome: 'failed' });
    expect(failed(after.db)).toEqual(failed(before.db));
  });

  it('records a read as nothing, as the hand gate does', async () => {
    const { db, registry } = world();
    await registry.invoke('probe.read_task', { id: 't1' }, inSession());
    await flush();
    expect(auditRows(db)).toEqual([]);
    expect(db.select().from(activityEvents).all()).toEqual([]);
  });
});

describe('a capability without an auditAction', () => {
  it('is recorded as before: through Activity, as `capability.invoked`', async () => {
    const { db, registry } = world();
    await registry.invoke('probe.change', {}, inSession());
    await flush();
    expect(auditRows(db).map((row) => [row.action, row.actorKind])).toEqual([
      ['capability.invoked', 'agent'],
    ]);
    expect(db.select().from(activityEvents).all()).toHaveLength(1);
  });
});
