/**
 * End to end through the real connected-app send (DOR-4587): the real `connectors.execute_write`
 * capability, its real preflight against a provider the server can reach, and the permission
 * gate. A turn at Full that read a mini app's words (the outsider mark) or answered a relay of
 * them (the outside-words note) gets a card for a Gmail send, and nothing reaches the provider.
 * The same send from a clean turn at Full reaches the provider with no card.
 *
 * Pinned here because a run whose provider cannot be reached is refused by the preflight before
 * the gate ever decides, which says nothing about the gate either way.
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
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';
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
const AGENT = {
  agentPath: '/agents/agent-a',
  displayName: 'Wren',
  createdAt: '2026-11-16T12:00:00.000Z',
};
const SEND_SCHEMA = {
  type: 'object',
  properties: {
    recipient_email: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['recipient_email'],
};

let counter = 0;
const fresh = () => `real-preflight-${(counter += 1)}`;

/** Run one turn in a chat set to Full autonomy, marked when `opts` carries a mark. */
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

describe('a Gmail send through the real preflight, at Full', () => {
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  const execute = vi.fn(async () => {
    throw new Error('reached the provider');
  });

  beforeEach(() => {
    execute.mockClear();
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
        createdAt: '2026-11-16T12:00:00.000Z',
        updatedAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: SEND_REVISION_ID,
        providerInstanceId: provider.instanceId,
        toolkit: 'gmail',
        operationSlug: 'GMAIL_SEND_EMAIL',
        toolkitVersion: '2026-09-01',
        schemaHash: `sha256:${SEND_REVISION_ID}`,
        providerRevisionRef: `provider-${SEND_REVISION_ID}`,
        capabilityClassification: 'write' as const,
        retryPolicy: 'never' as const,
        inputSchemaJson: JSON.stringify(SEND_SCHEMA),
        discoveredAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: `grant-${SEND_REVISION_ID}`,
        subjectType: 'agent' as const,
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: SEND_REVISION_ID,
        createdBy: 'operator',
        createdAt: '2026-11-16T12:00:00.000Z',
      })
      .run();
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

  /** Send one made-up email from the chat; the outcome and whether a card is waiting. */
  async function send(sessionId: string) {
    const outcome = await registry
      .invoke(
        'connectors.execute_write',
        {
          connectionId: CONNECTION_ID,
          operationRevisionId: SEND_REVISION_ID,
          arguments: { recipient_email: 'ann@example.com', subject: 'Garden', body: 'Made up.' },
        },
        {
          serverPrincipal: createServerPrincipal({
            kind: 'agent',
            owner: OWNER,
            agentId: 'agent-a',
            agentPath: AGENT.agentPath,
          }),
          identity: AGENT,
          sessionId,
        }
      )
      .then(
        () => 'ran',
        (error: unknown) =>
          (error as { decision?: { outcome?: string } }).decision?.outcome ?? String(error)
      );
    return { outcome, cards: approvals.listPending().length };
  }

  it('cards a turn carrying the outsider mark, and nothing reaches the provider', async () => {
    const chat = fresh();
    await ranAtFull(chat, { carriedMarks: { outsider: true } });
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('cards a turn that answered a relay of outside words, and nothing reaches the provider', async () => {
    const chat = fresh();
    noteRoomTurnWords(chat, true);
    await ranAtFull(chat);
    expect(await send(chat)).toEqual({ outcome: 'approval_required', cards: 1 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets a clean turn reach the provider with no card', async () => {
    const chat = fresh();
    await ranAtFull(chat);
    const { cards } = await send(chat);
    expect(cards).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
