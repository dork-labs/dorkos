/**
 * Fixtures for the Connections showcases: a person with Gmail twice, Notion
 * signed out, Calendar paused, Drive shared with every agent, a Telegram bot with someone waiting, and the
 * popular apps the catalog always lists.
 */
import type {
  ConnectorCatalogService,
  ConnectorConnectionDetail,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import type {
  ConnectorReconciliationPreview,
  ConnectorUsageItem,
} from '@dorkos/shared/connector-schemas';
import type { AdapterBinding, CatalogEntry } from '@dorkos/shared/relay-schemas';

/** One connected account, healthy unless overridden. */
export function mockConnection(
  over: Partial<ConnectorConnectionSummary> = {}
): ConnectorConnectionSummary {
  return {
    connectionId: 'conn-gmail-personal' as ConnectorConnectionSummary['connectionId'],
    providerInstanceId: 'provider-1' as ConnectorConnectionSummary['providerInstanceId'],
    toolkit: 'gmail',
    label: 'personal',
    identityHint: 'you@gmail.com',
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'managed',
    custody: 'managed',
    payer: 'dorkos_managed',
    agentCount: 2,
    everyAgent: null,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 16, attemptCount: 16 },
    warnings: [],
    ...over,
  };
}

/** The accounts behind "Yours": every account state the list can show. */
export const MOCK_CONNECTIONS: ConnectorConnectionSummary[] = [
  mockConnection({}),
  mockConnection({
    connectionId: 'conn-gmail-work' as ConnectorConnectionSummary['connectionId'],
    label: 'work',
    identityHint: 'work@acme.com',
    agentCount: 0,
  }),
  mockConnection({
    connectionId: 'conn-notion' as ConnectorConnectionSummary['connectionId'],
    toolkit: 'notion',
    label: 'Acme workspace',
    identityHint: null,
    authenticationStatus: 'expired',
  }),
  mockConnection({
    connectionId: 'conn-calendar' as ConnectorConnectionSummary['connectionId'],
    toolkit: 'googlecalendar',
    identityHint: 'you@gmail.com',
    lifecycle: 'paused',
  }),
  mockConnection({
    connectionId: 'conn-drive' as ConnectorConnectionSummary['connectionId'],
    toolkit: 'googledrive',
    label: 'googledrive',
    identityHint: 'you@gmail.com',
    agentCount: 0,
    everyAgent: { operationRevisionIds: ['drive-list-v1'], classifications: ['read'] },
  }),
  mockConnection({
    connectionId: 'conn-linear' as ConnectorConnectionSummary['connectionId'],
    toolkit: 'linear',
    identityHint: 'you@acme.com',
    reconciliationStatus: 'migration_needs_reconcile',
  }),
];

function builtIn(
  serviceSlug: string,
  displayName: string,
  description: string,
  category: ConnectorCatalogService['category'],
  uses: { account?: boolean; chat?: boolean } = { account: true }
): ConnectorCatalogService {
  return {
    serviceSlug,
    displayName,
    iconKey: serviceSlug,
    description,
    category,
    popular: true,
    intents: [
      ...(uses.chat
        ? [
            {
              kind: 'messages' as const,
              displayName: `Messages through a ${displayName} bot`,
              relayAdapterType: serviceSlug,
            },
          ]
        : []),
      ...(uses.account
        ? [{ kind: 'account' as const, displayName: `Use a ${displayName} account`, routes: [] }]
        : []),
    ],
  };
}

/** The popular apps the catalog always lists, plus the Webhook developer tool. */
export const MOCK_CATALOG_SERVICES: ConnectorCatalogService[] = [
  builtIn('gmail', 'Gmail', 'Read, search and send email.', 'email'),
  builtIn('googlecalendar', 'Google Calendar', 'See your schedule and add events.', 'calendar'),
  builtIn('slack', 'Slack', 'Talk to your agents in Slack, or let them post as you.', 'chat', {
    account: true,
    chat: true,
  }),
  builtIn('telegram', 'Telegram', 'Talk to your agents through your own Telegram bot.', 'chat', {
    chat: true,
  }),
  builtIn('notion', 'Notion', 'Search, read and write pages and databases.', 'docs'),
  builtIn('github', 'GitHub', 'Work with issues, pull requests and code.', 'code'),
  builtIn('linear', 'Linear', 'Create, update and track issues.', 'tasks'),
  builtIn(
    'webhook',
    'Webhook',
    'Send and receive messages over signed web requests.',
    'developer',
    {
      chat: true,
    }
  ),
];

/** Chat apps set up: a Telegram bot DorkBot answers, and a paused Slack bot. */
export const MOCK_CHAT_APPS: CatalogEntry[] = [
  {
    manifest: {
      type: 'telegram',
      displayName: 'Telegram',
      description: 'Send and receive messages via Telegram bots.',
      iconId: 'telegram',
      category: 'messaging',
      builtin: true,
      multiInstance: false,
      configFields: [],
    },
    instances: [
      {
        id: 'telegram-1',
        enabled: true,
        label: '@lifeos_bot',
        status: {
          id: 'telegram-1',
          type: 'telegram',
          displayName: 'Telegram',
          state: 'connected',
          messageCount: { inbound: 128, outbound: 94 },
          errorCount: 0,
        },
      },
    ],
  },
  {
    manifest: {
      type: 'slack',
      displayName: 'Slack',
      description: 'Send and receive messages in Slack.',
      iconId: 'slack',
      category: 'messaging',
      builtin: true,
      multiInstance: false,
      configFields: [],
    },
    instances: [
      {
        id: 'slack-1',
        enabled: false,
        label: 'Acme',
        status: {
          id: 'slack-1',
          type: 'slack',
          displayName: 'Slack',
          state: 'disconnected',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
        },
      },
    ],
  },
];

/** DorkBot answers the Telegram bot. */
export const MOCK_CHAT_BINDINGS: AdapterBinding[] = [
  {
    id: 'binding-telegram',
    adapterId: 'telegram-1',
    agentId: 'dorkbot',
    sessionStrategy: 'per-chat',
    label: '',
    canInitiate: false,
    canReply: true,
    canReceive: true,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
  } as AdapterBinding,
];

/** Agent names for the fixtures. */
export const MOCK_AGENT_NAMES: Record<string, string> = {
  dorkbot: 'DorkBot',
  mailroom: 'mailroom',
};

/** The Gmail account's panel detail: DorkBot and mailroom can use it. */
export function mockConnectionDetail(
  connection: ConnectorConnectionSummary = MOCK_CONNECTIONS[0]
): ConnectorConnectionDetail {
  return {
    connection,
    provider: {
      providerInstanceId: connection.providerInstanceId,
      displayName: 'Composio',
      mode: 'managed',
      custody: 'managed',
      payer: 'dorkos_managed',
      capabilities: {
        catalog: { status: 'available' },
        authentication: { status: 'available' },
        accounts: { status: 'available' },
        operations: { status: 'available' },
        execution: { status: 'available' },
        triggers: { status: 'unsupported', reason: 'Not available yet.' },
      },
      disclosure: 'Composio keeps your login access in its own secure vault.',
    },
    agents: [
      {
        agentId: 'dorkbot',
        displayName: 'DorkBot',
        operationRevisionIds: ['send-v1'],
        classifications: ['read', 'write'],
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
      },
      {
        agentId: 'mailroom',
        displayName: 'mailroom',
        operationRevisionIds: ['list-v1'],
        classifications: ['read'],
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
      },
    ],
    sessions: { affectedCount: 1 },
    subscriptions: {
      totalCount: 0,
      activeCount: 0,
      capability: { status: 'unsupported', reason: 'Not available yet.' },
    },
  };
}

function usage(
  index: number,
  agentId: string,
  operationSlug: string,
  hoursAgo: number
): ConnectorUsageItem {
  return {
    logicalOperationId: `op-${index}`,
    attemptIndex: 1,
    surface: 'mcp',
    actorKind: 'agent',
    agentId,
    connectionId: 'conn-gmail-personal' as ConnectorUsageItem['connectionId'],
    toolkit: 'gmail',
    operationRevisionId: `${operationSlug}-v1`,
    operationSlug,
    payer: 'dorkos_managed',
    outcome: 'success',
    startedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    completedAt: new Date(Date.now() - hoursAgo * 3_600_000 + 2_000).toISOString(),
  };
}

/** What agents did with Gmail lately. */
export const MOCK_GMAIL_USAGE: ConnectorUsageItem[] = [
  usage(1, 'dorkbot', 'GMAIL_FETCH_EMAILS', 2),
  usage(2, 'mailroom', 'GMAIL_FETCH_EMAILS', 20),
  usage(3, 'dorkbot', 'GMAIL_SEND_EMAIL', 70),
  usage(4, 'dorkbot', 'GMAIL_CREATE_EMAIL_DRAFT', 90),
];

/** What the "Who can use it?" card reads for the Gmail account: DorkBot and mailroom. */
export function mockAccessPreview(connectionId: string): ConnectorReconciliationPreview {
  const candidate = (id: string, classification: 'read' | 'write') => ({
    operationRevisionId: id,
    toolkit: 'gmail',
    operationSlug: `gmail.${id}`,
    toolkitVersion: '2026-09-01',
    capabilityClassification: classification,
    retryPolicy: 'never' as const,
    inputSchema: {},
    supported: true,
  });
  return {
    previewId: `preview-${connectionId}`,
    connection: {
      connectionId: connectionId as never,
      toolkit: 'gmail',
      label: 'personal',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [candidate('list-v1', 'read'), candidate('send-v1', 'write')],
    agents: [
      { agentId: 'dorkbot', displayName: 'DorkBot' },
      { agentId: 'mailroom', displayName: 'mailroom' },
    ],
    currentGrants: [
      { agentId: 'dorkbot', operationRevisionIds: ['list-v1', 'send-v1'] },
      { agentId: 'mailroom', operationRevisionIds: ['list-v1'] },
    ],
    everyAgent: { available: true, operationRevisionIds: [] },
    catalogComplete: true,
    createdAt: '2026-09-26T00:00:00.000Z',
    expiresAt: '2099-09-26T00:00:00.000Z',
  };
}
