import { describe, expect, it } from 'vitest';
import type {
  ConnectorCatalogService,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import type { AdapterBinding, CatalogEntry, CatalogInstance } from '@dorkos/shared/relay-schemas';
import {
  accountRow,
  appsOnShelf,
  buildYourApps,
  chatAppRow,
  ownedApps,
  remainingUses,
  rowMatches,
  shelvesFor,
  type YourAppsInput,
} from '../lib/app-list';

function connection(over: Partial<ConnectorConnectionSummary> = {}): ConnectorConnectionSummary {
  return {
    connectionId: 'c-gmail' as never,
    providerInstanceId: 'provider-1' as never,
    toolkit: 'gmail',
    label: 'gmail',
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
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
    ...over,
  };
}

function service(
  serviceSlug: string,
  over: Partial<ConnectorCatalogService> & { chat?: boolean; account?: boolean } = {}
): ConnectorCatalogService {
  const { chat = false, account = true, ...rest } = over;
  return {
    serviceSlug,
    displayName: serviceSlug.charAt(0).toUpperCase() + serviceSlug.slice(1),
    iconKey: serviceSlug,
    intents: [
      ...(chat
        ? [{ kind: 'messages' as const, displayName: 'Bot', relayAdapterType: serviceSlug }]
        : []),
      ...(account ? [{ kind: 'account' as const, displayName: 'Account', routes: [] }] : []),
    ],
    ...rest,
  };
}

function instance(over: Partial<CatalogInstance> = {}): CatalogInstance {
  return {
    id: 'telegram-1',
    enabled: true,
    label: '@lifeos_bot',
    status: {
      id: 'telegram-1',
      type: 'telegram',
      displayName: 'Telegram',
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    },
    ...over,
  };
}

function chatEntry(
  type: string,
  instances: CatalogInstance[],
  over: Partial<CatalogEntry['manifest']> = {}
): CatalogEntry {
  return {
    manifest: {
      type,
      displayName: type === 'claude-code' ? 'Claude Code' : 'Telegram',
      description: '',
      category: 'messaging',
      builtin: true,
      multiInstance: false,
      configFields: [],
      ...over,
    },
    instances,
  };
}

const binding = (adapterId: string, agentId: string): AdapterBinding =>
  ({ id: `${adapterId}-${agentId}`, adapterId, agentId }) as AdapterBinding;

const SERVICES = new Map([
  ['gmail', service('gmail', { displayName: 'Gmail', signInName: 'Google' })],
  ['notion', service('notion')],
]);

function input(over: Partial<YourAppsInput> = {}): YourAppsInput {
  return {
    connections: [],
    chatApps: [],
    bindings: [],
    waitingByChatApp: {},
    agentNames: { dorkbot: 'DorkBot', mailroom: 'mailroom' },
    services: SERVICES,
    ...over,
  };
}

describe('accountRow', () => {
  it('is ready only when every fact the server reports says agents can use it', () => {
    const row = accountRow(connection({ label: 'gmail' }), SERVICES);
    expect(row).toMatchObject({
      name: 'Gmail',
      tone: 'ready',
      action: null,
      account: 'you@gmail.com',
      detail: 'you@gmail.com · 2 agents',
    });
  });

  it.each([
    ['expired', 'sign-in-again'],
    ['revoked', 'sign-in-again'],
    ['pending', 'sign-in-again'],
  ] as const)('reads a %s sign-in as broken with "Sign in again"', (status, action) => {
    const row = accountRow(connection({ authenticationStatus: status }), SERVICES);
    expect(row.tone).toBe('broken');
    expect(row.action).toBe(action);
  });

  it('never reads a signed-out account as merely updating', () => {
    const row = accountRow(
      connection({ authenticationStatus: 'expired', authoritySync: { status: 'pending' } }),
      SERVICES
    );
    expect(row.tone).toBe('broken');
  });

  it('greys a paused account and offers Resume', () => {
    expect(accountRow(connection({ lifecycle: 'paused' }), SERVICES)).toMatchObject({
      tone: 'off',
      action: 'resume',
    });
  });

  it('says a disconnected account can’t be used, with no row action', () => {
    const row = accountRow(connection({ lifecycle: 'disconnected' }), SERVICES);
    expect(row.tone).toBe('off');
    expect(row.action).toBeNull();
    expect(row.detail).toContain('Disconnected');
  });

  it('asks for a review when actions changed or access failed to update', () => {
    expect(
      accountRow(connection({ reconciliationStatus: 'migration_needs_reconcile' }), SERVICES)
    ).toMatchObject({ tone: 'attention', action: 'review' });
    // Pinned: whatever the grants, never green until the server says ready.
    for (const over of [
      { agentCount: 0 },
      {
        agentCount: 0,
        everyAgent: { operationRevisionIds: ['op-1'], classifications: ['read' as const] },
      },
    ]) {
      expect(
        accountRow(
          connection({ reconciliationStatus: 'migration_needs_reconcile', ...over }),
          SERVICES
        )
      ).toMatchObject({ tone: 'attention', action: 'review' });
    }
    expect(
      accountRow(connection({ authoritySync: { status: 'failed', reason: 'x' } }), SERVICES)
    ).toMatchObject({ tone: 'broken', action: 'review' });
  });

  it('shows an access update in flight as busy, not ready', () => {
    const row = accountRow(connection({ authoritySync: { status: 'pending' } }), SERVICES);
    expect(row.tone).toBe('busy');
  });

  it('goes by the name the person gave it, keeping the address for the panel', () => {
    expect(accountRow(connection({ label: 'work' }), SERVICES)).toMatchObject({
      account: 'work',
      identity: 'you@gmail.com',
      detail: 'work · 2 agents',
    });
    // Unnamed, the label is just the app's id, so the address stands in.
    expect(accountRow(connection({ label: 'gmail' }), SERVICES)).toMatchObject({
      account: 'you@gmail.com',
      identity: null,
    });
  });

  it('reads "Every agent" instead of a count when the app is shared with every agent', () => {
    const row = accountRow(
      connection({
        agentCount: 0,
        everyAgent: { operationRevisionIds: ['op-1'], classifications: ['read'] },
      }),
      SERVICES
    );
    expect(row.detail).toBe('you@gmail.com · Every agent');
    expect(row.tone).toBe('ready');
  });

  it('says "No agents yet" and names an app the catalog doesn’t list', () => {
    const row = accountRow(
      connection({ toolkit: 'google_drive', agentCount: 0, identityHint: null, label: 'team' }),
      SERVICES
    );
    expect(row.name).toBe('Google Drive');
    expect(row.detail).toBe('team · No agents yet');
  });
});

describe('chatAppRow', () => {
  const entry = chatEntry('telegram', [instance()]);

  it('names who answers, and counts people waiting', () => {
    const row = chatAppRow(entry, instance(), {
      bindings: [binding('telegram-1', 'dorkbot')],
      agentNames: { dorkbot: 'DorkBot' },
      waitingByChatApp: { 'telegram-1': 1 },
    });
    expect(row).toMatchObject({
      kind: 'chat',
      tone: 'ready',
      detail: '@lifeos_bot · DorkBot answers',
      waiting: 1,
    });
  });

  it('says when nobody answers yet', () => {
    const row = chatAppRow(entry, instance(), {
      bindings: [],
      agentNames: {},
      waitingByChatApp: {},
    });
    expect(row).toMatchObject({ tone: 'attention', detail: '@lifeos_bot · No agent answers yet' });
  });

  it('marks a chat app DorkOS no longer offers', () => {
    const retired = chatEntry('telegram', [instance()], { deprecated: true });
    expect(
      chatAppRow(retired, instance(), { bindings: [], agentNames: {}, waitingByChatApp: {} })
        .deprecated
    ).toBe(true);
  });

  it('reads a failed bot as broken with Fix, and a disabled one as paused', () => {
    const broken = instance({ status: { ...instance().status, state: 'error' } });
    expect(
      chatAppRow(entry, broken, { bindings: [], agentNames: {}, waitingByChatApp: {} })
    ).toMatchObject({ tone: 'broken', action: 'fix' });
    expect(
      chatAppRow(entry, instance({ enabled: false }), {
        bindings: [],
        agentNames: {},
        waitingByChatApp: {},
      })
    ).toMatchObject({ tone: 'off', action: 'resume' });
  });
});

describe('buildYourApps', () => {
  it('gives a second account of the same app its own row', () => {
    const rows = buildYourApps(
      input({
        connections: [
          connection(),
          connection({ connectionId: 'c-gmail-2' as never, identityHint: 'work@acme.com' }),
        ],
      })
    );
    expect(rows.map((row) => row.name)).toEqual(['Gmail', 'Gmail']);
    expect(rows.map((row) => row.account)).toEqual(['you@gmail.com', 'work@acme.com']);
  });

  it('floats broken rows to the top and sinks paused ones', () => {
    const rows = buildYourApps(
      input({
        connections: [
          connection({ connectionId: 'paused' as never, lifecycle: 'paused', toolkit: 'aaa' }),
          connection({ connectionId: 'ok' as never }),
          connection({
            connectionId: 'broken' as never,
            toolkit: 'notion',
            authenticationStatus: 'expired',
          }),
        ],
      })
    );
    expect(rows.map((row) => row.id)).toEqual(['broken', 'ok', 'paused']);
  });

  it('never lists the internal agent relay', () => {
    const rows = buildYourApps(
      input({
        chatApps: [
          chatEntry('claude-code', [instance({ id: 'claude-code' })], { category: 'internal' }),
          chatEntry('telegram', [instance()]),
        ],
      })
    );
    expect(rows.map((row) => row.id)).toEqual(['telegram-1']);
  });

  it('puts a sign-in in progress first, naming whose page it is on', () => {
    const rows = buildYourApps(
      input({
        connections: [connection({ authenticationStatus: 'expired' })],
        pendingSignIn: { flowId: 'flow-1', toolkit: 'gmail' },
      })
    );
    expect(rows[0]).toMatchObject({
      id: 'flow-1',
      kind: 'connecting',
      action: 'cancel',
      detail: 'Waiting for you to finish signing in on Google…',
    });
  });
});

describe('what "All apps" still offers', () => {
  const slack = service('slack', { chat: true, account: true });
  const webhook = service('webhook', { chat: true, account: false });

  it('keeps an app until every one of its uses is set up', () => {
    const chatOnly = ownedApps([], [chatEntry('slack', [instance({ id: 'slack-1' })])]);
    expect(remainingUses(slack, chatOnly)).toEqual({ account: true, chatType: null });

    const both = ownedApps(
      [connection({ toolkit: 'slack' })],
      [chatEntry('slack', [instance({ id: 'slack-1' })])]
    );
    expect(remainingUses(slack, both)).toEqual({ account: false, chatType: null });
  });

  it('moves a chat app to "Yours" once it is set up, even one that allows more', () => {
    const owned = ownedApps(
      [],
      [chatEntry('webhook', [instance({ id: 'webhook-1' })], { multiInstance: true })]
    );
    expect(remainingUses(webhook, owned).chatType).toBeNull();
  });

  it('frees an app again once its only account is disconnected', () => {
    const owned = ownedApps([connection({ lifecycle: 'disconnected' })], []);
    expect(remainingUses(service('gmail'), owned).account).toBe(true);
  });
});

describe('shelves', () => {
  const apps = [
    service('gmail', { category: 'email', popular: true }),
    service('linear', { category: 'tasks', popular: true }),
    service('zoho', {}),
    service('webhook', { category: 'developer', popular: true }),
  ];

  it('draws a chip only for a shelf that has an app on it', () => {
    expect(shelvesFor(apps)).toEqual(['popular', 'email', 'tasks', 'all']);
  });

  it('keeps developer tools off every shelf', () => {
    expect(appsOnShelf(apps, 'popular').map((app) => app.serviceSlug)).toEqual(['gmail', 'linear']);
    expect(appsOnShelf(apps, 'all').map((app) => app.serviceSlug)).toEqual([
      'gmail',
      'linear',
      'zoho',
    ]);
    expect(appsOnShelf(apps, 'tasks').map((app) => app.serviceSlug)).toEqual(['linear']);
  });
});

describe('rowMatches', () => {
  it('finds a row by its name or its account', () => {
    const row = accountRow(connection(), SERVICES);
    expect(rowMatches(row, 'gma')).toBe(true);
    expect(rowMatches(row, 'you@')).toBe(true);
    expect(rowMatches(row, 'notion')).toBe(false);
    expect(rowMatches(row, '  ')).toBe(true);
  });
});
