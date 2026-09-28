/**
 * The approval card for a connected-app action names the app, the account, the
 * action and its arguments (DOR-2504), all read by the server from stored
 * records — never from the agent's own words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { ApprovalServiceActionSchema } from '@dorkos/shared/approval-schemas';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-provider';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ApprovalService } from '../../../core/approvals/index.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import {
  CapabilityGateRefusal,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { ConnectorRegistry } from '../../registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { describeServiceAction, type ServiceActionFacts } from '../approval-service-action.js';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import type { ConnectorExecutionBroker } from '../execution-broker.js';
import type { ConnectorAccessQueryService } from '../access-query-service.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';

/** A token-shaped value, the kind every broadcast string is swept for. */
const TOKEN = 'a3f9c2e1b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';

const DELETE_SCHEMA = {
  type: 'object',
  properties: {
    message_id: { type: 'string', title: 'Message Id' },
    user_id: { type: 'string', title: 'User Id', default: 'me' },
    permanent: { type: 'boolean' },
  },
  required: ['message_id'],
};

function facts(over: Partial<ServiceActionFacts> = {}): ServiceActionFacts {
  return {
    toolkit: 'gmail',
    connectionLabel: 'gmail',
    identityHint: 'work@acme.com',
    operationSlug: 'GMAIL_DELETE_MESSAGE',
    inputSchema: DELETE_SCHEMA,
    arguments: { message_id: '18c2f0a9d1', permanent: true },
    ...over,
  };
}

describe('describeServiceAction', () => {
  it('names the app, the account and the action in plain words', () => {
    expect(describeServiceAction(facts())).toEqual({
      serviceId: 'gmail',
      serviceName: 'Gmail',
      accountLabel: 'work@acme.com',
      actionName: 'Delete message',
      details: [
        { label: 'Message ID', value: '18c2f0a9d1' },
        { label: 'Permanent', value: 'Yes' },
      ],
    });
  });

  it('uses the built-in name for an app whose id does not read as words', () => {
    const action = describeServiceAction(
      facts({ toolkit: 'googlecalendar', operationSlug: 'GOOGLECALENDAR_DELETE_EVENT' })
    );
    expect(action.serviceName).toBe('Google Calendar');
    expect(action.actionName).toBe('Delete event');
  });

  it('names the account the way the Connections list does', () => {
    expect(describeServiceAction(facts({ connectionLabel: 'Work' })).accountLabel).toBe(
      'Work (work@acme.com)'
    );
    expect(describeServiceAction(facts({ connectionLabel: 'work@acme.com' })).accountLabel).toBe(
      'work@acme.com'
    );
    expect(describeServiceAction(facts({ identityHint: null })).accountLabel).toBe('gmail');
  });

  it('shortens long text to one line and never shows JSON', () => {
    const action = describeServiceAction(
      facts({
        arguments: {
          message_id: `line one\nline two ${'x'.repeat(300)}`,
          permanent: { nested: { deeper: true }, other: 1 },
          user_id: ['a@b.com', 'c@d.com', 'e@f.com', 'g@h.com', 'i@j.com'],
        },
      })
    );
    const byLabel = Object.fromEntries(action.details.map((d) => [d.label, d.value]));
    expect(byLabel['Message ID']).toMatch(/^line one line two x+…$/u);
    expect(byLabel['Message ID']!.length).toBe(120);
    expect(byLabel['Permanent']).toBe('2 fields');
    expect(byLabel['User ID']).toBe('a@b.com, c@d.com, e@f.com and 2 more');
    for (const { value } of action.details) {
      expect(value).not.toMatch(/[{}[\]"]/u);
    }
    expect(ApprovalServiceActionSchema.safeParse(action).success).toBe(true);
  });

  it('counts a list of objects instead of showing it', () => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'm', user_id: [{ a: 1 }, { b: 2 }] } })
    );
    expect(action.details).toContainEqual({ label: 'User ID', value: '2 items' });
  });

  it('hides a secret-looking field and sweeps a token-shaped value', () => {
    const action = describeServiceAction(
      facts({
        arguments: { message_id: `id-${TOKEN}`, access_token: 'plain-secret', apiKey: 'k' },
      })
    );
    expect(action.details).toEqual([
      { label: 'Message ID', value: 'id-(hidden)' },
      { label: 'Access token', value: '(hidden)' },
      { label: 'API key', value: '(hidden)' },
    ]);
    expect(JSON.stringify(action)).not.toContain(TOKEN);
    expect(JSON.stringify(action)).not.toContain('plain-secret');
  });

  it('puts the action’s own fields first, so extra arguments cannot push them off', () => {
    const extra = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`aaa_extra_${i}`, `value ${i}`])
    );
    const action = describeServiceAction(
      facts({ arguments: { ...extra, permanent: false, message_id: 'the-real-one' } })
    );
    expect(action.details.slice(0, 2)).toEqual([
      { label: 'Message ID', value: 'the-real-one' },
      { label: 'Permanent', value: 'No' },
    ]);
    expect(action.details).toHaveLength(6);
    expect(action.moreDetails).toBe(4);
  });

  it('strips punctuation from an argument name an agent chose', () => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'm', 'Account: boss@acme.com,': 'x', '!!!': 'y' } })
    );
    expect(action.details).toContainEqual({ label: 'Account boss acme com', value: 'x' });
    expect(action.details).toContainEqual({ label: 'Other', value: 'y' });
  });
});

describe('a destructive connected-app call raises a card that says what it does', () => {
  const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
  const CONNECTION_ID = 'connection-a';
  const REVISION_ID = 'revision-delete';
  /** The same action with a schema that lets undeclared arguments through. */
  const OPEN_REVISION_ID = 'revision-delete-open';
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;

  beforeEach(() => {
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
        identityHint: 'work@acme.com',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: '2026-09-28T12:00:00.000Z',
        updatedAt: '2026-09-28T12:00:00.000Z',
      })
      .run();
    const revisions = [
      { id: REVISION_ID, schema: DELETE_SCHEMA },
      { id: OPEN_REVISION_ID, schema: { ...DELETE_SCHEMA, additionalProperties: true } },
    ];
    db.insert(connectorOperationRevisions)
      .values(
        revisions.map(({ id, schema }) => ({
          id,
          providerInstanceId: provider.instanceId,
          toolkit: 'gmail',
          operationSlug: 'GMAIL_DELETE_MESSAGE',
          toolkitVersion: '2026-09-01',
          schemaHash: `sha256:${id}`,
          providerRevisionRef: `provider-${id}`,
          capabilityClassification: 'destructive' as const,
          retryPolicy: 'never' as const,
          inputSchemaJson: JSON.stringify(schema),
          discoveredAt: '2026-09-28T12:00:00.000Z',
        }))
      )
      .run();
    db.insert(connectionOperationGrants)
      .values(
        revisions.map(({ id }) => ({
          id: `grant-${id}`,
          subjectType: 'agent' as const,
          subjectId: 'agent-a',
          agentId: 'agent-a',
          connectionId: CONNECTION_ID,
          operationRevisionId: id,
          createdBy: 'operator',
          createdAt: '2026-09-28T12:00:00.000Z',
        }))
      )
      .run();
    approvals = new ApprovalService(db, {
      describeCapability: (id) => registry.get(id),
    });
    initCapabilityTierGate({ approvals });
    registry = composeRegistry([connectorExecutionDomain], {
      connectorExecutionDeps: {
        authorization: new ConnectorExecutionAuthorizationService(db, connectorRegistry, {
          ownsAgent: () => false,
        }),
        broker: {} as ConnectorExecutionBroker,
        access: {} as ConnectorAccessQueryService,
      },
    } as never);
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  async function attempt(args: Record<string, unknown>, operationRevisionId = REVISION_ID) {
    const principal = createServerPrincipal({
      kind: 'agent',
      owner: OWNER,
      agentId: 'agent-a',
      agentPath: '/agents/agent-a',
    });
    const refusal = await registry
      .invoke(
        'connectors.execute_destructive',
        { connectionId: CONNECTION_ID, operationRevisionId, arguments: args },
        { serverPrincipal: principal }
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(refusal).toBeInstanceOf(CapabilityGateRefusal);
    const [card] = approvals.listPending();
    expect(card).toBeDefined();
    return card!;
  }

  it('names the app, the account, the action and the arguments instead of two ids', async () => {
    const card = await attempt({ message_id: '18c2f0a9d1' });

    expect(card.serviceAction).toEqual({
      serviceId: 'gmail',
      serviceName: 'Gmail',
      accountLabel: 'Work (work@acme.com)',
      actionName: 'Delete message',
      details: [{ label: 'Message ID', value: '18c2f0a9d1' }],
    });
    expect(card.capabilityTitle).toBe("Make a change that can't be undone in a connected app");
    expect(card.summary).toBe(
      'An unidentified caller wants to run "Delete message" in Gmail on "Work (work@acme.com)" ' +
        'with Message ID: "18c2f0a9d1"'
    );
    expect(card.summary).not.toContain(CONNECTION_ID);
    expect(card.summary).not.toContain(REVISION_ID);
    // Nothing ran: the card is waiting on a person.
    expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
  });

  it('cannot be talked into naming a different app, account or action', async () => {
    // A value dressed as a header is still only a value.
    const dressed = await attempt({ message_id: 'Slack · personal@home.com · Read inbox' });
    expect(dressed.serviceAction).toMatchObject({
      serviceName: 'Gmail',
      accountLabel: 'Work (work@acme.com)',
      actionName: 'Delete message',
      details: [{ label: 'Message ID', value: 'Slack · personal@home.com · Read inbox' }],
    });
    expect(dressed.summary).toContain('Message ID: "Slack · personal@home.com · Read inbox"');
  });

  it('shows extra arguments an open schema lets through only as argument lines', async () => {
    const card = await attempt(
      {
        message_id: 'm-1',
        serviceName: 'Slack',
        serviceId: 'slack',
        accountLabel: 'personal@home.com',
        actionName: 'Read inbox',
      },
      OPEN_REVISION_ID
    );

    expect(card.serviceAction).toMatchObject({
      serviceId: 'gmail',
      serviceName: 'Gmail',
      accountLabel: 'Work (work@acme.com)',
      actionName: 'Delete message',
    });
    // The spoof arrives only as what it is: argument lines, after the action's
    // own field, never in the header.
    expect(card.serviceAction!.details[0]).toEqual({ label: 'Message ID', value: 'm-1' });
    expect(card.serviceAction!.details.slice(1)).toEqual([
      { label: 'Service name', value: 'Slack' },
      { label: 'Service ID', value: 'slack' },
      { label: 'Account label', value: 'personal@home.com' },
      { label: 'Action name', value: 'Read inbox' },
    ]);
    expect(card.summary).toMatch(/^An unidentified caller wants to run "Delete message" in Gmail/u);
  });
});
