/**
 * Agents taking connection access away (spec `agent-grant-autonomy` phase 2),
 * over one real database: own narrowing always works; narrowing another agent
 * needs a reason, an allowed turn and the hourly budget, raises a Needs-you
 * item, and a person can undo it. One test per refusal (§7, E3).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionGrantChanges,
  connectionGrantExclusions,
  connections,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  AccessNarrowingError,
  AccessNarrowingService,
  isNarrowing,
  readAccessState,
  validReason,
  type NarrowCaller,
} from '../access/access-narrowing.js';
import type { AccessChangeEvents, DescribedAccessChange } from '../access/access-change-events.js';
import { listAccessChangesForOwner } from '../access/access-change-ledger.js';
import type { TurnGateRefusal } from '../access/turn-gate.js';
import { ConnectorExecutionAuthorizationService } from '../execution/authorization-service.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import { ConnectorReconciliationService } from '../reconciliation-service.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
const AGENTS = new Set(['pm', 'flow-snapshot', 'agent-b']);
const START = new Date('2026-11-08T12:00:00.000Z');
const REASON = "It wasn't using it.";

function caller(agentId: string): NarrowCaller {
  return {
    agentId,
    agentPath: `/agents/${agentId}`,
    sessionId: `session-${agentId}`,
    owner: OWNER,
  };
}

describe('agents taking access away', () => {
  let db: Db;
  let clock: Date;
  let gate: TurnGateRefusal | null;
  let gateCalls: number;
  let events: { changed: DescribedAccessChange[]; refused: string[]; undone: string[] };
  let narrowing: AccessNarrowingService;
  let reconciliation: ConnectorReconciliationService;
  let authorization: ConnectorExecutionAuthorizationService;
  let nextId: number;
  let read: string;
  let write: string;

  beforeEach(async () => {
    db = createDb(':memory:');
    runMigrations(db);
    clock = START;
    gate = null;
    gateCalls = 0;
    nextId = 0;
    events = { changed: [], refused: [], undone: [] };
    const provider = new FakeConnectorProvider({
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
      refused: (input) => events.refused.push(input.code),
      undone: (input) => events.undone.push(input.changeId),
    };
    narrowing = new AccessNarrowingService({
      db,
      ownsAgent,
      events: recorder,
      turnGate: () => {
        gateCalls += 1;
        return gate;
      },
      now: () => clock,
      createId: () => `change-${++nextId}`,
    });

    // Every agent gets Read; agent-b and flow-snapshot also get Read and write by name.
    const snapshot: ConnectorReconciliationPreview = await reconciliation.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
    const revision = (slug: string) =>
      snapshot.candidates.find((entry) => entry.operationSlug === slug)!.operationRevisionId;
    read = revision('gmail.read');
    write = revision('gmail.write');
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [
        { agentId: 'agent-b', operationRevisionIds: [read, write], level: 'read-write' },
        { agentId: 'flow-snapshot', operationRevisionIds: [read, write], level: 'read-write' },
      ],
      everyAgent: { operationRevisionIds: [read] },
    });
  });

  async function code(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return error instanceof AccessNarrowingError ? error.code : String(error);
    }
  }

  function execute(agentId: string, revision: string, kind: 'read' | 'write') {
    return authorization.prepare({
      capabilityId: `connectors.execute_${kind}`,
      principal: createServerPrincipal({
        kind: 'agent',
        owner: OWNER,
        agentId,
        agentPath: `/agents/${agentId}`,
      }),
      target: ConnectorExecutionTargetSchema.parse({
        connectionId: CONNECTION_ID,
        operationRevisionId: revision,
        arguments: {},
      }),
    });
  }

  function ledger() {
    return db.select().from(connectionGrantChanges).all();
  }

  describe('own access (N1: always allowed)', () => {
    it('lowers its own access to Read from any turn, without consulting the turn gate', async () => {
      gate = 'GRANT_MARKED_TURN';
      const result = await narrowing.narrow(caller('flow-snapshot'), {
        targetAgentId: 'flow-snapshot',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'read' },
      });
      expect(result.changed).toBe(true);
      expect(gateCalls).toBe(0);
      expect(readAccessState(db, 'flow-snapshot', CONNECTION_ID)).toEqual({
        level: 'read',
        revisionIds: [read],
        excluded: false,
      });
      expect(await code(execute('flow-snapshot', write, 'write'))).not.toBeUndefined();
      expect(events.changed[0]).toMatchObject({ kind: 'narrow_own', needsYou: false });
    });

    it('leaves itself out of the share from an agent-started turn (flow-snapshot drops the share)', async () => {
      gate = 'GRANT_AGENT_STARTED';
      await narrowing.narrow(caller('flow-snapshot'), {
        targetAgentId: 'flow-snapshot',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'none' },
      });
      await narrowing.narrow(caller('flow-snapshot'), {
        targetAgentId: 'flow-snapshot',
        connectionId: CONNECTION_ID,
        change: { kind: 'leave_out' },
      });
      expect(readAccessState(db, 'flow-snapshot', CONNECTION_ID).excluded).toBe(true);
      expect(await code(execute('flow-snapshot', read, 'read'))).not.toBeUndefined();
      await expect(execute('pm', read, 'read')).resolves.toBeDefined();
      expect(gateCalls).toBe(0);
    });

    it('never counts toward the hourly budget', async () => {
      const changes = [
        { kind: 'remove', operationRevisionIds: [write] },
        { kind: 'leave_out' },
        { kind: 'level', to: 'read' },
        { kind: 'level', to: 'none' },
      ] as const;
      for (const change of changes) {
        await narrowing.narrow(caller('agent-b'), {
          targetAgentId: 'agent-b',
          connectionId: CONNECTION_ID,
          change,
        });
      }
      expect(ledger().filter((row) => row.outcome === 'refused')).toEqual([]);
      expect(gateCalls).toBe(0);
    });
  });

  describe("another agent's access", () => {
    const other = (
      change: Parameters<AccessNarrowingService['narrow']>[1]['change'],
      reason?: string
    ) =>
      narrowing.narrow(caller('pm'), {
        targetAgentId: 'agent-b',
        connectionId: CONNECTION_ID,
        change,
        ...(reason !== undefined ? { reason } : {}),
      });

    it.each([
      ['missing', undefined],
      ['empty', '   '],
      ['multi-line', 'first line\nsecond line'],
      [
        '16 words',
        'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen',
      ],
    ])('refuses a %s reason before anything is written', async (_name, reason) => {
      expect(await code(other({ kind: 'level', to: 'read' }, reason))).toBe(
        'GRANT_REASON_REQUIRED'
      );
      expect(ledger()).toEqual([]);
      expect(gateCalls).toBe(0);
    });

    it('takes a 15-word reason, keeps it only on the ledger row, and raises Needs-you', async () => {
      const fifteen =
        'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
      const result = await other({ kind: 'level', to: 'read' }, fifteen);
      expect(result.changed).toBe(true);
      expect(ledger()).toEqual([
        expect.objectContaining({ kind: 'narrow_other', outcome: 'applied', reason: fifteen }),
      ]);
      expect(events.changed).toHaveLength(1);
      expect(events.changed[0]).toMatchObject({ needsYou: true, targetAgentId: 'agent-b' });
      // The reason never reaches Activity, a notification or anything an agent reads.
      expect(JSON.stringify(events.changed[0])).not.toContain('one two');
      expect(events.changed[0]!.summary((id) => id)).not.toContain('one two');
    });

    it.each(['GRANT_MARKED_TURN', 'GRANT_AGENT_STARTED', 'GRANT_MARKS_UNREADABLE'] as const)(
      'refuses in a %s turn, records the refusal, and changes nothing',
      async (refusal) => {
        gate = refusal;
        const before = readAccessState(db, 'agent-b', CONNECTION_ID);
        expect(await code(other({ kind: 'level', to: 'none' }, REASON))).toBe(refusal);
        expect(readAccessState(db, 'agent-b', CONNECTION_ID)).toEqual(before);
        expect(ledger()).toEqual([
          expect.objectContaining({ outcome: 'refused', refusalCode: refusal, actorId: 'pm' }),
        ]);
        expect(events.refused).toEqual([refusal]);
        expect(events.changed).toEqual([]);
      }
    );

    it('allows 3 an hour, refuses the 4th with GRANT_NARROW_RATE, and rolls after 60 minutes', async () => {
      await other({ kind: 'remove', operationRevisionIds: [write] }, REASON);
      await other({ kind: 'level', to: 'none' }, REASON);
      await other({ kind: 'leave_out' }, REASON);
      expect(await code(other({ kind: 'leave_out' }, REASON))).toBe('GRANT_NARROW_RATE');
      expect(ledger().filter((row) => row.refusalCode === 'GRANT_NARROW_RATE')).toHaveLength(1);

      clock = new Date(START.getTime() + 61 * 60_000);
      await narrowing.narrow(caller('pm'), {
        targetAgentId: 'flow-snapshot',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'read' },
        reason: REASON,
      });
      expect(events.changed).toHaveLength(4);
    });

    it('leaves another agent out of the share; it keeps only what it was given by name', async () => {
      await other({ kind: 'level', to: 'none' }, REASON);
      await other({ kind: 'leave_out' }, REASON);
      expect(await code(execute('agent-b', read, 'read'))).not.toBeUndefined();
      expect(db.select().from(connectionGrantExclusions).all()).toEqual([
        expect.objectContaining({ agentId: 'agent-b', createdBy: 'agent:pm', revokedAt: null }),
      ]);
      expect(events.changed.map((change) => change.kind)).toEqual([
        'narrow_other',
        'exclude_other',
      ]);
    });

    it('says when there is nothing of its own to narrow', async () => {
      expect(
        await code(
          narrowing.narrow(caller('pm'), {
            targetAgentId: 'pm',
            connectionId: CONNECTION_ID,
            change: { kind: 'level', to: 'none' },
          })
        )
      ).toBe('GRANT_NOTHING_TO_NARROW');
    });

    it("refuses an agent or app the owner doesn't have", async () => {
      expect(
        await code(
          narrowing.narrow(caller('pm'), {
            targetAgentId: 'nobody',
            connectionId: CONNECTION_ID,
            change: { kind: 'leave_out' },
            reason: REASON,
          })
        )
      ).toBe('GRANT_NOT_FOUND');
      expect(
        await code(
          narrowing.narrow(caller('pm'), {
            targetAgentId: 'agent-b',
            connectionId: 'connection-z',
            change: { kind: 'leave_out' },
            reason: REASON,
          })
        )
      ).toBe('GRANT_NOT_FOUND');
    });
  });

  describe("a person's Undo", () => {
    it('puts back what was taken, including letting the agent back into the share', async () => {
      const lowered = await narrowing.narrow(caller('pm'), {
        targetAgentId: 'agent-b',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'none' },
        reason: REASON,
      });
      const left = await narrowing.narrow(caller('pm'), {
        targetAgentId: 'agent-b',
        connectionId: CONNECTION_ID,
        change: { kind: 'leave_out' },
        reason: REASON,
      });
      await narrowing.undo(OWNER, left.changeId!);
      await narrowing.undo(OWNER, lowered.changeId!);
      expect(readAccessState(db, 'agent-b', CONNECTION_ID)).toEqual({
        level: 'read-write',
        revisionIds: [read, write].sort(),
        excluded: false,
      });
      await expect(execute('agent-b', write, 'write')).resolves.toBeDefined();
      expect(events.undone).toEqual([left.changeId, lowered.changeId]);
      expect(await code(narrowing.undo(OWNER, lowered.changeId!))).toBe('UNDO_NOT_FOUND');
    });

    it('refuses with UNDO_STALE when access changed since', async () => {
      const lowered = await narrowing.narrow(caller('pm'), {
        targetAgentId: 'agent-b',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'read' },
        reason: REASON,
      });
      await narrowing.narrow(caller('agent-b'), {
        targetAgentId: 'agent-b',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'none' },
      });
      expect(await code(narrowing.undo(OWNER, lowered.changeId!))).toBe('UNDO_STALE');
    });

    it('gives the person every change with the reason exactly as written', async () => {
      const written = 'See [link](https://example.com) and <b>bold</b>';
      await narrowing.narrow(caller('pm'), {
        targetAgentId: 'agent-b',
        connectionId: CONNECTION_ID,
        change: { kind: 'level', to: 'read' },
        reason: written,
      });
      expect(listAccessChangesForOwner(db, OWNER)).toEqual([
        expect.objectContaining({ actorId: 'pm', targetAgentId: 'agent-b', reason: written }),
      ]);
      expect(
        listAccessChangesForOwner(db, { kind: 'local_install', installationId: 'other' })
      ).toEqual([]);
    });
  });

  describe('the narrowing property', () => {
    it('never lets a change add an action, raise a level, or lift an exclusion', () => {
      const before = { level: 'read' as const, revisionIds: ['a'], excluded: true };
      expect(isNarrowing(before, { ...before, revisionIds: ['a', 'b'] })).toBe(false);
      expect(isNarrowing(before, { ...before, level: 'read-write' })).toBe(false);
      expect(isNarrowing(before, { ...before, excluded: false })).toBe(false);
      expect(isNarrowing(before, { level: null, revisionIds: [], excluded: true })).toBe(true);
    });

    it('accepts one line of at most 15 words', () => {
      expect(validReason('ok')).toBe('ok');
      expect(validReason('a\u2028b')).toBeNull();
      expect(validReason(undefined)).toBeNull();
    });
  });
});
