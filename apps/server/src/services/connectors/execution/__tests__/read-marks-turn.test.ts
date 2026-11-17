/**
 * A read through a connected app marks the turn it ran in (DOR-3969, spec §4.7): the mail, invite
 * or shared file it hands back is someone else's text. So a Gmail send later in that same turn at
 * Full gets a card, and nothing reaches the provider, through the real `connectors.execute_read`
 * and `connectors.execute_write` capabilities, their real preflight and the permission gate.
 *
 * The mark lasts until the chat's next real turn: a continuation (an approval's answer, a resume)
 * picks up the same words and keeps it. A caller that knows only the agent (external `/mcp`) sees
 * it too, until that chat's next turn starts.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-provider';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ApprovalService } from '../../../core/approvals/index.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { recordTurnLevels } from '../../../core/turn-power/turn-levels.js';
import { resetChosenTurns } from '../../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../../core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { ConnectorRegistry } from '../../registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import type { ConnectorExecutionBroker } from '../execution-broker.js';
import type { ConnectorAccessQueryService } from '../access-query-service.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const CONNECTION_ID = 'connection-a';
const SEND_REVISION_ID = 'revision-send';
const READ_REVISION_ID = 'revision-read';
const AGENT = {
  agentPath: '/agents/agent-a',
  displayName: 'Wren',
  createdAt: '2026-11-17T12:00:00.000Z',
};
const SCHEMA = {
  type: 'object',
  properties: {
    recipient_email: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    query: { type: 'string' },
  },
};

let counter = 0;
const fresh = () => `read-marks-${(counter += 1)}`;

/** Run one turn in a chat set to Full autonomy. */
async function ranAtFull(sessionId: string, opts?: MessageOpts) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

describe('a connected-app read marks the turn it ran in, at Full', () => {
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  let readFails = false;
  const sent = vi.fn();
  const execute = vi.fn(async (request: { capabilityId: string }) => {
    if (request.capabilityId === 'connectors.execute_read') {
      if (readFails) throw new Error('the app answered with an error');
      return {
        logicalOperationId: 'op-read',
        attemptCount: 1,
        result: { status: 'success', data: {} },
      };
    }
    sent();
    return {
      logicalOperationId: 'op-send',
      attemptCount: 1,
      result: { status: 'success', data: {} },
    };
  });

  /** A revision and the agent's grant to it. */
  function revision(
    id: string,
    slug: string,
    classification: 'read' | 'write',
    providerId: string
  ) {
    db.insert(connectorOperationRevisions)
      .values({
        id,
        providerInstanceId: providerId,
        toolkit: 'gmail',
        operationSlug: slug,
        toolkitVersion: '2026-09-01',
        schemaHash: `sha256:${id}`,
        providerRevisionRef: `provider-${id}`,
        capabilityClassification: classification,
        retryPolicy: 'never' as const,
        inputSchemaJson: JSON.stringify(SCHEMA),
        discoveredAt: '2026-11-17T12:00:00.000Z',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: `grant-${id}`,
        subjectType: 'agent' as const,
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: id,
        createdBy: 'operator',
        createdAt: '2026-11-17T12:00:00.000Z',
      })
      .run();
  }

  beforeEach(() => {
    execute.mockClear();
    sent.mockClear();
    readFails = false;
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    db = createDb(':memory:');
    runMigrations(db);
    const provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
    });
    const connectorRegistry = new ConnectorRegistry({ db });
    connectorRegistry.register(provider);
    db.update(connectorProviderInstances)
      .set({
        ownerKind: 'local_install',
        ownerId: OWNER.installationId,
        executionConfigDigest: 'material-a',
        executionConfigGeneration: 1,
      })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'provider-account-a' as ConnectorExternalAccountRef,
        toolkit: 'gmail',
        label: 'Work',
        identityHint: 'work@example.com',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: '2026-11-17T12:00:00.000Z',
        updatedAt: '2026-11-17T12:00:00.000Z',
      })
      .run();
    revision(SEND_REVISION_ID, 'GMAIL_SEND_EMAIL', 'write', provider.instanceId);
    revision(READ_REVISION_ID, 'GMAIL_FETCH_EMAILS', 'read', provider.instanceId);
    approvals = new ApprovalService(db, { describeCapability: (id) => registry.get(id) });
    initCapabilityTierGate({ approvals });
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    registry = composeRegistry([connectorExecutionDomain], {
      connectorExecutionDeps: {
        authorization: new ConnectorExecutionAuthorizationService(db, connectorRegistry, {
          ownsAgent: () => false,
        }),
        broker: { execute } as unknown as ConnectorExecutionBroker,
        access: {} as ConnectorAccessQueryService,
      },
    } as never);
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.restoreAllMocks();
  });

  /** The verified caller: the agent, in this chat, or (no chat) as the external server sees it. */
  function caller(sessionId: string | undefined) {
    return {
      serverPrincipal: createServerPrincipal({
        kind: 'agent',
        owner: OWNER,
        agentId: 'agent-a',
        agentPath: AGENT.agentPath,
      }),
      identity: AGENT,
      ...(sessionId !== undefined ? { sessionId } : {}),
    };
  }

  /** Read the inbox from the chat; resolves whether or not the app answered. */
  async function read(sessionId: string) {
    await registry
      .invoke(
        'connectors.execute_read',
        {
          connectionId: CONNECTION_ID,
          operationRevisionId: READ_REVISION_ID,
          arguments: { query: 'is:unread' },
        },
        caller(sessionId)
      )
      .catch(() => undefined);
  }

  /** Send one made-up email; the outcome and how many cards wait. */
  async function send(sessionId: string | undefined) {
    const outcome = await registry
      .invoke(
        'connectors.execute_write',
        {
          connectionId: CONNECTION_ID,
          operationRevisionId: SEND_REVISION_ID,
          arguments: { recipient_email: 'ann@example.com', subject: 'Garden', body: 'Made up.' },
        },
        caller(sessionId)
      )
      .then(
        () => 'ran',
        (error: unknown) =>
          (error as { decision?: { outcome?: string } }).decision?.outcome ?? String(error)
      );
    return { outcome, cards: approvals.listPending().length };
  }

  it('cards a send after a read in the same turn, and nothing is sent', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    expect(sent).not.toHaveBeenCalled();
  });

  it('cards a send after a read the app answered with an error', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    readFails = true;
    await read(chat);
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    expect(sent).not.toHaveBeenCalled();
  });

  it('lets a send from a turn that read nothing through, with no card', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    expect(await send(chat)).toEqual({ outcome: 'ran', cards: 0 });
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("ends with the chat's next real turn", async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    await ranAtFull(chat);
    expect(await send(chat)).toEqual({ outcome: 'ran', cards: 0 });
  });

  it('a continuation picks up the same words and keeps it', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    await ranAtFull(chat, { permissionCeiling: 'runtime-default', continuationHold: true });
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
  });

  it('marks the agent for a caller that names no chat, until that chat starts a new turn', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    await read(chat);
    expect(await send(undefined)).toEqual({ outcome: 'approval_required', cards: 1 });
    await ranAtFull(chat);
    const after = await send(undefined);
    expect(after.outcome).toBe('ran');
  });
});
