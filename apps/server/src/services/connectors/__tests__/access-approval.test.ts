/**
 * An agent approving another agent's request for Read, and an agent's Undo
 * (spec `agent-grant-autonomy` §4.2, §4.3, phase 3), over one real database.
 * The six limits DorkOS can prove before DOR-3969 (§4.4) each have a test by
 * name, as do Security's Q3 and every refusal in §7 this path can give.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentApprovalOf } from '../access/access-change-ledger.js';
import {
  connectionAccessLevels,
  connectionGrantChanges,
  connectionOperationGrants,
  connections,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  AccessApprovalError,
  AccessApprovalService,
  type ApproverSnapshot,
  type PendingAgentRequest,
} from '../access/access-approval.js';
import {
  AccessNarrowingError,
  AccessNarrowingService,
  readAccessState,
  type NarrowCaller,
} from '../access/access-narrowing.js';
import type { AccessChangeEvents, DescribedAccessChange } from '../access/access-change-events.js';
import type { TurnGateRefusal } from '../access/turn-gate.js';
import { recordAccessLevel } from '../execution/access-levels.js';
import { ConnectorExecutionAuthorizationService } from '../execution/authorization-service.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import { ConnectorReconciliationService } from '../reconciliation-service.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
// pm holds Read at a level; agent-b and writer hold Read and write; exact holds
// one action by hand; newbie, outsider and asker hold only what the share gives.
const AGENTS = new Set(['pm', 'agent-b', 'writer', 'exact', 'newbie', 'outsider', 'asker']);
const START = new Date('2026-11-08T12:00:00.000Z');
const REASON = 'It asked for more than it needed.';

function caller(agentId: string): NarrowCaller {
  return {
    agentId,
    agentPath: `/agents/${agentId}`,
    sessionId: `session-${agentId}`,
    owner: OWNER,
  };
}

describe('agents approving read requests', () => {
  let db: Db;
  let gate: TurnGateRefusal | null;
  let nextId: number;
  let read: string;
  let write: string;
  let requests: Map<string, PendingAgentRequest>;
  let resolved: Array<{ requestId: string; connectionId: string }>;
  let events: {
    changed: DescribedAccessChange[];
    refused: Array<{ code: string; kind?: string }>;
    undone: Array<{ changeId: string; by?: string; needsYou?: boolean }>;
  };
  let approval: AccessApprovalService;
  let narrowing: AccessNarrowingService;
  /** The registry's names, as the approver snapshot reads them; tests rename agents in it. */
  const names = new Map<string, ApproverSnapshot>([
    ['pm', { displayName: 'DorkOS PM', color: '#7c5cff', icon: '🧭' }],
  ]);
  let authorization: ConnectorExecutionAuthorizationService;
  let provider: FakeConnectorProvider;
  let reconciliation: ConnectorReconciliationService;

  beforeEach(async () => {
    db = createDb(':memory:');
    runMigrations(db);
    gate = null;
    nextId = 0;
    resolved = [];
    events = { changed: [], refused: [], undone: [] };
    provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
      custody: 'self-host',
      toolkitVersion: 'v1',
    });
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
    });
    registry.register(provider, 'material-a');
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'external-a',
        toolkit: 'gmail',
        label: 'Work Gmail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: START.toISOString(),
        updatedAt: START.toISOString(),
      })
      .run();
    const ownsAgent = (_owner: unknown, agentId: string) => AGENTS.has(agentId);
    reconciliation = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => [...AGENTS].map((agentId) => ({ agentId, displayName: agentId })),
      now: () => START,
      createId: () => `generated-${++nextId}`,
    });
    authorization = new ConnectorExecutionAuthorizationService(db, registry, { ownsAgent });
    const recorder: AccessChangeEvents = {
      changed: (change) => events.changed.push(change),
      refused: (input) => events.refused.push({ code: input.code, kind: input.kind }),
      undone: (input) =>
        events.undone.push({
          changeId: input.changeId,
          by: input.by?.agentId,
          needsYou: input.needsYou,
        }),
    };
    requests = new Map([
      ['request-newbie', { agentId: 'newbie', serviceSlug: 'gmail', requestedAccess: 'read' }],
      ['request-pm', { agentId: 'pm', serviceSlug: 'gmail', requestedAccess: 'read' }],
      ['request-write', { agentId: 'newbie', serviceSlug: 'gmail', requestedAccess: 'read-write' }],
      ['request-outsider', { agentId: 'outsider', serviceSlug: 'gmail', requestedAccess: 'read' }],
    ]);
    approval = new AccessApprovalService({
      db,
      requests: {
        pending: (_owner, requestId) => requests.get(requestId) ?? null,
        resolveWithCurrentAccess: async (_owner, requestId, connectionId) => {
          resolved.push({ requestId, connectionId });
        },
      },
      events: recorder,
      turnGate: () => gate,
      approverSnapshot: (agentId) => names.get(agentId),
      now: () => START,
      createId: () => `change-${++nextId}`,
    });
    narrowing = new AccessNarrowingService({
      db,
      ownsAgent,
      events: recorder,
      turnGate: () => gate,
      now: () => START,
      createId: () => `change-${++nextId}`,
    });
    const snapshot = await reconciliation.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
    const revision = (slug: string) =>
      snapshot.candidates.find((entry) => entry.operationSlug === slug)!.operationRevisionId;
    read = revision('gmail.read');
    write = revision('gmail.write');
    // The share gives every agent the read action as exact actions, with no level.
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [
        { agentId: 'pm', operationRevisionIds: [read], level: 'read' },
        { agentId: 'agent-b', operationRevisionIds: [read, write], level: 'read-write' },
        { agentId: 'writer', operationRevisionIds: [read, write], level: 'read-write' },
        { agentId: 'exact', operationRevisionIds: [read] },
      ],
      everyAgent: { operationRevisionIds: [read] },
    });
  });

  async function code(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return error instanceof AccessApprovalError || error instanceof AccessNarrowingError
        ? error.code
        : String(error);
    }
  }

  function canRead(agentId: string) {
    return authorization
      .prepare({
        capabilityId: 'connectors.execute_read',
        principal: createServerPrincipal({
          kind: 'agent',
          owner: OWNER,
          agentId,
          agentPath: `/agents/${agentId}`,
        }),
        target: ConnectorExecutionTargetSchema.parse({
          connectionId: CONNECTION_ID,
          operationRevisionId: read,
          arguments: {},
        }),
      })
      .then(
        () => true,
        () => false
      );
  }

  function ledger() {
    return db.select().from(connectionGrantChanges).all();
  }

  function everyAgentGrants() {
    return db
      .select()
      .from(connectionOperationGrants)
      .where(eq(connectionOperationGrants.subjectType, 'every_agent'))
      .all();
  }

  function leaveOut(agentId: string) {
    return narrowing.narrow(caller(agentId), {
      targetAgentId: agentId,
      connectionId: CONNECTION_ID,
      change: { kind: 'leave_out' },
    });
  }

  it('gives the requester Read from what the approver holds, records it, and answers the request', async () => {
    const result = await approval.approve(caller('pm'), { requestId: 'request-newbie' });
    expect(result).toMatchObject({ connectionId: CONNECTION_ID, requestAnswered: true });
    expect(readAccessState(db, 'newbie', CONNECTION_ID)).toEqual({
      level: 'read',
      revisionIds: [read],
      excluded: false,
    });
    expect(resolved).toEqual([{ requestId: 'request-newbie', connectionId: CONNECTION_ID }]);
    expect(ledger()).toEqual([
      expect.objectContaining({
        id: result.changeId,
        kind: 'approve_read',
        outcome: 'applied',
        actorKind: 'agent',
        actorId: 'pm',
        targetAgentId: 'newbie',
        requestId: 'request-newbie',
      }),
    ]);
    expect(events.changed[0]).toMatchObject({ kind: 'approve_read', needsYou: false });
    expect(events.changed[0]!.summary((id) => id)).toBe(
      "pm approved newbie's read access to Gmail"
    );
  });

  // Security M1 on #3575: what the person's card reads, on the request itself.
  describe('the approval the person’s card shows', () => {
    afterEach(() => names.set('pm', { displayName: 'DorkOS PM', color: '#7c5cff', icon: '🧭' }));

    it('keeps the approver as it looked then, through a rename', async () => {
      await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      names.set('pm', { displayName: 'Definitely Dorian' });

      expect(agentApprovalOf(db, 'request-newbie')).toEqual({
        agentId: 'pm',
        displayName: 'DorkOS PM',
        color: '#7c5cff',
        icon: '🧭',
        approvedAt: START.toISOString(),
      });
    });

    it('is still found under a flood of 250 refused approvals (the M1 proof)', async () => {
      await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      for (let i = 0; i < 250; i++) {
        await code(approval.approve(caller('pm'), { requestId: 'request-pm' }));
      }
      expect(ledger().filter((row) => row.outcome === 'refused')).toHaveLength(250);
      expect(agentApprovalOf(db, 'request-newbie')).toMatchObject({ agentId: 'pm' });
    });

    it('says when the person undid it', async () => {
      const { changeId } = await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      await narrowing.undo(OWNER, changeId!);

      expect(agentApprovalOf(db, 'request-newbie')).toMatchObject({
        agentId: 'pm',
        undoneAt: START.toISOString(),
      });
    });

    it('is nothing for a request no agent approved, or only tried to', async () => {
      await code(approval.approve(caller('pm'), { requestId: 'request-pm' }));
      expect(agentApprovalOf(db, 'request-pm')).toBeUndefined();
      expect(agentApprovalOf(db, 'request-newbie')).toBeUndefined();
    });

    it('belongs to its own request only, and only to an agent’s approval', async () => {
      await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      expect(agentApprovalOf(db, 'request-outsider')).toBeUndefined();

      // A row a person wrote is never shown as an agent's approval.
      db.update(connectionGrantChanges)
        .set({ actorKind: 'person' })
        .where(eq(connectionGrantChanges.requestId, 'request-newbie'))
        .run();
      expect(agentApprovalOf(db, 'request-newbie')).toBeUndefined();
    });
  });

  describe('the six limits DorkOS can prove today (§4.4)', () => {
    it('1. refused in a turn another agent started (W3)', async () => {
      gate = 'GRANT_AGENT_STARTED';
      expect(await code(approval.approve(caller('pm'), { requestId: 'request-newbie' }))).toBe(
        'GRANT_AGENT_STARTED'
      );
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
      expect(resolved).toEqual([]);
    });

    it('2. refused for self-approval (W3)', async () => {
      expect(await code(approval.approve(caller('pm'), { requestId: 'request-pm' }))).toBe(
        'APPROVE_SELF'
      );
    });

    it('3. never writes an every-agent share (W1)', async () => {
      const before = everyAgentGrants();
      await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      expect(everyAgentGrants()).toEqual(before);
      expect(
        db
          .select()
          .from(connectionAccessLevels)
          .where(eq(connectionAccessLevels.subjectType, 'every_agent'))
          .all()
      ).toEqual([]);
    });

    it('4. refused above the approver’s own access (W1): hand-picked actions are not a level', async () => {
      expect(await code(approval.approve(caller('exact'), { requestId: 'request-newbie' }))).toBe(
        'APPROVE_ABOVE_OWN'
      );
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
    });

    it('5. refused for write (W2)', async () => {
      expect(await code(approval.approve(caller('pm'), { requestId: 'request-write' }))).toBe(
        'APPROVE_NOT_READ'
      );
    });

    it('6. refused in a turn DorkOS marks (outsider text, a Wi-Fi hold)', async () => {
      gate = 'GRANT_MARKED_TURN';
      expect(await code(approval.approve(caller('pm'), { requestId: 'request-newbie' }))).toBe(
        'GRANT_MARKED_TURN'
      );
    });
  });

  it('fails closed when the turn can’t be read (E2)', async () => {
    gate = 'GRANT_MARKS_UNREADABLE';
    expect(await code(approval.approve(caller('pm'), { requestId: 'request-newbie' }))).toBe(
      'GRANT_MARKS_UNREADABLE'
    );
  });

  it('refuses for an agent a person left out of the app (X2), before reading what the approver holds', async () => {
    await leaveOut('outsider');
    expect(await code(approval.approve(caller('pm'), { requestId: 'request-outsider' }))).toBe(
      'APPROVE_EXCLUDED'
    );
    expect(await canRead('outsider')).toBe(false);
  });

  it('Q3: an approver left out of the app holds nothing there, share or not', async () => {
    await leaveOut('outsider');
    expect(
      await code(
        approval.approve(caller('outsider'), {
          requestId: 'request-newbie',
          connectionId: CONNECTION_ID,
        })
      )
    ).toBe('APPROVE_NOT_HELD');
  });

  it('Q3: Read held through the every-agent share counts, at the share’s level', async () => {
    // Without the share's level, asker holds hand-picked actions only.
    expect(await code(approval.approve(caller('asker'), { requestId: 'request-newbie' }))).toBe(
      'APPROVE_ABOVE_OWN'
    );
    db.transaction((tx) =>
      recordAccessLevel(tx, {
        connectionId: CONNECTION_ID,
        subject: { kind: 'every_agent' },
        level: 'read',
        createdBy: 'install-a',
        now: START.toISOString(),
      })
    );
    await approval.approve(caller('asker'), { requestId: 'request-newbie' });
    expect(readAccessState(db, 'newbie', CONNECTION_ID).revisionIds).toEqual([read]);
  });

  it('records every refusal as a ledger row and an audit event', async () => {
    gate = 'GRANT_MARKED_TURN';
    await code(approval.approve(caller('pm'), { requestId: 'request-newbie' }));
    expect(ledger()).toEqual([
      expect.objectContaining({
        kind: 'approve_read',
        outcome: 'refused',
        refusalCode: 'GRANT_MARKED_TURN',
        actorId: 'pm',
        requestId: 'request-newbie',
      }),
    ]);
    expect(events.refused).toEqual([{ code: 'GRANT_MARKED_TURN', kind: 'approve_read' }]);
  });

  it('refuses a request that is no longer waiting', async () => {
    expect(await code(approval.approve(caller('pm'), { requestId: 'request-gone' }))).toBe(
      'APPROVE_NOT_FOUND'
    );
  });

  it('keeps the access and leaves the request for a person when answering it fails', async () => {
    const failing = new AccessApprovalService({
      db,
      requests: {
        pending: (_owner, requestId) => requests.get(requestId) ?? null,
        resolveWithCurrentAccess: vi.fn().mockRejectedValue(new Error('session_access_off')),
      },
      events: { changed: () => {}, refused: () => {}, undone: () => {} },
      turnGate: () => null,
      createId: () => `other-${++nextId}`,
    });
    const result = await failing.approve(caller('pm'), { requestId: 'request-newbie' });
    expect(result.requestAnswered).toBe(false);
    expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBe('read');
  });

  /** A second app on this owner, with pm at Read on it when `pmHolds`. */
  async function secondApp(id: string, toolkit: string, pmHolds: boolean) {
    const connectionId = ConnectionIdSchema.parse(id);
    db.insert(connections)
      .values({
        id: connectionId,
        providerInstanceId: provider.instanceId,
        externalAccountRef: `external-${id}`,
        toolkit,
        label: `Other ${toolkit}`,
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: START.toISOString(),
        updatedAt: START.toISOString(),
      })
      .run();
    if (!pmHolds) return connectionId;
    const snapshot = await reconciliation.preview(
      OWNER,
      { connectionId },
      new AbortController().signal
    );
    const reads = snapshot.candidates
      .filter((entry) => entry.operationSlug.endsWith('.read'))
      .map((entry) => entry.operationRevisionId);
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [{ agentId: 'pm', operationRevisionIds: reads, level: 'read' }],
    });
    return connectionId;
  }

  // DOR-4204: an action that spends money is never handed on by another agent, even when
  // the service calls it read-only and the approver holds it.
  it('never hands on an action that spends money', async () => {
    const connectionId = await secondApp('connection-apify', 'apify', false);
    const snapshot = await reconciliation.preview(
      OWNER,
      { connectionId },
      new AbortController().signal
    );
    const scrape = snapshot.candidates.find((c) => c.operationSlug === 'apify.read')!;
    expect(scrape.capabilityClassification).toBe('read');
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [{ agentId: 'pm', operationRevisionIds: [scrape.operationRevisionId] }],
    });
    requests.set('request-apify', {
      agentId: 'newbie',
      serviceSlug: 'apify',
      requestedAccess: 'read',
    });
    expect(await code(approval.approve(caller('pm'), { requestId: 'request-apify' }))).toBe(
      'APPROVE_NOT_HELD'
    );
    expect(readAccessState(db, 'newbie', connectionId).revisionIds).toEqual([]);
  });

  describe('which app (Security, on { requestId, connectionId? })', () => {
    it('refuses when the approver holds more than one app for the service and names none: never the first', async () => {
      const other = await secondApp('connection-b', 'gmail', true);
      expect(await code(approval.approve(caller('pm'), { requestId: 'request-newbie' }))).toBe(
        'APPROVE_CHOOSE_APP'
      );
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
      expect(readAccessState(db, 'newbie', other).level).toBeNull();
      expect(ledger().at(-1)).toMatchObject({
        outcome: 'refused',
        refusalCode: 'APPROVE_CHOOSE_APP',
      });
      // Named, it gives Read on that app only.
      await approval.approve(caller('pm'), { requestId: 'request-newbie', connectionId: other });
      expect(readAccessState(db, 'newbie', other).level).toBe('read');
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
    });

    it('refuses a named app for a different service', async () => {
      const slack = await secondApp('connection-slack', 'slack', true);
      expect(
        await code(
          approval.approve(caller('pm'), { requestId: 'request-newbie', connectionId: slack })
        )
      ).toBe('GRANT_NOT_FOUND');
      expect(readAccessState(db, 'newbie', slack).level).toBeNull();
    });

    it('refuses a named app of the service that the approver doesn’t hold', async () => {
      const other = await secondApp('connection-b', 'gmail', false);
      await leaveOut('pm');
      expect(
        await code(
          approval.approve(caller('pm'), { requestId: 'request-newbie', connectionId: other })
        )
      ).toBe('APPROVE_NOT_HELD');
    });
  });

  describe('the request is read again inside the write', () => {
    it('never approves the same request twice', async () => {
      await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      // The fake keeps saying it waits; the ledger is what refuses the second.
      expect(await code(approval.approve(caller('agent-b'), { requestId: 'request-newbie' }))).toBe(
        'APPROVE_NOT_FOUND'
      );
      expect(
        ledger().filter((row) => row.kind === 'approve_read' && row.outcome === 'applied')
      ).toHaveLength(1);
    });

    it('refuses a request answered or withdrawn after the first read, writing nothing', async () => {
      let reads = 0;
      const racing = new AccessApprovalService({
        db,
        requests: {
          pending: (_owner, requestId) =>
            ++reads === 1 ? (requests.get(requestId) ?? null) : null,
          resolveWithCurrentAccess: async () => {},
        },
        events: { changed: () => {}, refused: () => {}, undone: () => {} },
        turnGate: () => null,
        createId: () => `race-${++nextId}`,
      });
      expect(await code(racing.approve(caller('pm'), { requestId: 'request-newbie' }))).toBe(
        'APPROVE_NOT_FOUND'
      );
      expect(reads).toBe(2);
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
    });
  });

  describe('Security’s proofs from the PR C review', () => {
    it('M1 (P1): no agent reverses a person’s Undo, the approver included', async () => {
      const approved = await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      const personUndo = await narrowing.undo(OWNER, approved.changeId!);
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
      for (const agent of ['pm', 'agent-b']) {
        expect(await code(approval.undo(caller(agent), { changeId: personUndo.undoId }))).toBe(
          'UNDO_PERSON_ONLY'
        );
      }
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
      expect(ledger().at(-1)).toMatchObject({
        kind: 'undo',
        outcome: 'refused',
        refusalCode: 'UNDO_PERSON_ONLY',
        undoOf: personUndo.undoId,
      });
    });

    it('a person’s Undo is final: no agent approves that request again (DOR-4049)', async () => {
      const approved = await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      await narrowing.undo(OWNER, approved.changeId!);
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
      // The fake keeps saying the request waits; the undone approval still counts.
      for (const agent of ['pm', 'agent-b']) {
        expect(await code(approval.approve(caller(agent), { requestId: 'request-newbie' }))).toBe(
          'APPROVE_NOT_FOUND'
        );
      }
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
    });

    it('P2: two approvals racing on one request apply once', async () => {
      const results = await Promise.allSettled([
        approval.approve(caller('pm'), { requestId: 'request-newbie' }),
        approval.approve(caller('agent-b'), { requestId: 'request-newbie' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        ledger().filter((row) => row.kind === 'approve_read' && row.outcome === 'applied')
      ).toHaveLength(1);
    });

    it('S1 (P3): a read-write approver gives Read only: never its level, never a write action', async () => {
      await approval.approve(caller('agent-b'), { requestId: 'request-newbie' });
      const given = readAccessState(db, 'newbie', CONNECTION_ID);
      expect(given.level).toBe('read');
      expect(given.revisionIds).toEqual([read]);
      expect(given.revisionIds).not.toContain(write);
    });
  });

  describe('an agent’s Undo, checked as what it does (§4.3)', () => {
    async function narrowWriter() {
      // pm lowers writer from Read and write to Read: a narrowing of another agent.
      const result = await narrowing.narrow(caller('pm'), {
        targetAgentId: 'writer',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'read' },
        reason: REASON,
      });
      return result.changeId!;
    }

    it('refuses an agent putting back its own narrowing: that is self-approval', async () => {
      const own = await narrowing.narrow(caller('writer'), {
        targetAgentId: 'writer',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'read' },
      });
      expect(await code(approval.undo(caller('writer'), { changeId: own.changeId! }))).toBe(
        'APPROVE_SELF'
      );
    });

    it('putting another agent’s write access back is write approval: refused', async () => {
      const changeId = await narrowWriter();
      expect(await code(approval.undo(caller('agent-b'), { changeId }))).toBe('APPROVE_NOT_READ');
      expect(readAccessState(db, 'writer', CONNECTION_ID).level).toBe('read');
    });

    it('putting another agent’s Read back follows the approval rules', async () => {
      const gone = await narrowing.narrow(caller('pm'), {
        targetAgentId: 'exact',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'none' },
        reason: REASON,
      });
      gate = 'GRANT_MARKED_TURN';
      expect(await code(approval.undo(caller('agent-b'), { changeId: gone.changeId! }))).toBe(
        'GRANT_MARKED_TURN'
      );
      expect(readAccessState(db, 'exact', CONNECTION_ID).revisionIds).toEqual([]);
      gate = null;
      // An agent that holds nothing on the app can't give anything back there.
      await leaveOut('outsider');
      expect(await code(approval.undo(caller('outsider'), { changeId: gone.changeId! }))).toBe(
        'APPROVE_NOT_HELD'
      );
      await approval.undo(caller('agent-b'), { changeId: gone.changeId! });
      expect(readAccessState(db, 'exact', CONNECTION_ID).revisionIds).toEqual([read]);
      expect(events.undone.at(-1)).toEqual({
        changeId: gone.changeId,
        by: 'agent-b',
        needsYou: false,
      });
    });

    it('no agent lifts an exclusion, by Undo or otherwise', async () => {
      const gone = await narrowing.narrow(caller('pm'), {
        targetAgentId: 'newbie',
        connectionId: CONNECTION_ID,
        change: { kind: 'leave_out' },
        reason: REASON,
      });
      // Lifting an exclusion is a person's, whoever asks.
      expect(await code(approval.undo(caller('agent-b'), { changeId: gone.changeId! }))).toBe(
        'EXCLUSION_PERSON_ONLY'
      );
    });

    it('taking an approval back is a narrowing: needs a reason, a clean turn, and raises Needs-you', async () => {
      const given = await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      expect(await code(approval.undo(caller('agent-b'), { changeId: given.changeId! }))).toBe(
        'GRANT_REASON_REQUIRED'
      );
      gate = 'GRANT_AGENT_STARTED';
      expect(
        await code(approval.undo(caller('agent-b'), { changeId: given.changeId!, reason: REASON }))
      ).toBe('GRANT_AGENT_STARTED');
      gate = null;
      const undone = await approval.undo(caller('agent-b'), {
        changeId: given.changeId!,
        reason: REASON,
      });
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBeNull();
      expect(events.undone).toEqual([{ changeId: given.changeId, by: 'agent-b', needsYou: true }]);
      expect(ledger().find((row) => row.id === undone.undoId)).toMatchObject({
        kind: 'undo',
        actorKind: 'agent',
        actorId: 'agent-b',
        undoOf: given.changeId,
        reason: REASON,
      });
      // A person can put an agent's Undo back.
      await narrowing.undo(OWNER, undone.undoId);
      expect(readAccessState(db, 'newbie', CONNECTION_ID).level).toBe('read');
    });

    it('refuses when access changed since', async () => {
      const given = await approval.approve(caller('pm'), { requestId: 'request-newbie' });
      await narrowing.narrow(caller('newbie'), {
        targetAgentId: 'newbie',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'none' },
      });
      expect(
        await code(approval.undo(caller('agent-b'), { changeId: given.changeId!, reason: REASON }))
      ).toBe('UNDO_STALE');
    });
  });
});
