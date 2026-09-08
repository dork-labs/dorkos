/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectionEventDefinitionPage,
  ConnectionEventSubscription,
} from '@dorkos/shared/connector-event-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { gmailFilterSchema } from './event-filter-fixtures';
import { ConnectionNotifications } from '../ui/ConnectionNotifications';

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const agent: TeamMember = {
  id: 'agent-a',
  kind: 'agent',
  displayName: 'Researcher',
  handle: 'researcher',
  isSelf: false,
  ownerId: null,
  origin: 'local',
  agent: {
    manifestId: 'agent-a',
    runtime: 'claude-code',
    healthStatus: 'active',
    recentlyActive: true,
    activity: { working: null, lastActiveAt: null },
    isDefault: true,
    isSystem: false,
    registeredAt: '2026-09-01T00:00:00.000Z',
  },
};

const definition: ConnectionEventDefinitionPage['definitions'][number] = {
  id: 'definition-a',
  eventType: 'gmail.message.received',
  displayName: 'New email',
  toolkit: 'gmail',
  toolkitVersion: '2026-09-01',
  definitionHash: `sha256:${'a'.repeat(64)}`,
  filterSchema: {
    type: 'object',
    properties: { folder: { type: 'string', title: 'Folder' } },
    required: ['folder'],
  },
  payloadSchema: {},
  deliveryMode: 'webhook',
  expectedCadenceSeconds: null,
};

function subscription(
  over: Partial<ConnectionEventSubscription> = {}
): ConnectionEventSubscription {
  return {
    id: 'subscription-a',
    connectionId: 'connection-a' as never,
    definitionId: definition.id,
    eventType: definition.eventType,
    displayName: definition.displayName,
    deliveryMode: 'webhook',
    expectedCadenceSeconds: null,
    agentId: agent.id,
    destination: { kind: 'agent', id: agent.id },
    filter: { folder: 'inbox' },
    scopeVersion: 1,
    state: 'active',
    ...over,
  };
}

function renderNotifications(
  transport: Transport,
  connectionId = 'connection-a',
  members: TeamMember[] = [agent]
) {
  vi.mocked(transport.getTeamRoster).mockResolvedValue({ members });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ConnectionNotifications connectionId={connectionId} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return {
    ...view,
    rerenderConnection(nextConnectionId: string) {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <ConnectionNotifications connectionId={nextConnectionId} />
          </TransportProvider>
        </QueryClientProvider>
      );
    },
  };
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(await screen.findByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('ConnectionNotifications', () => {
  it('submits validated defaults exactly and keeps owner edits across rerenders', async () => {
    const user = userEvent.setup();
    const create = vi
      .fn()
      .mockResolvedValue({ status: 'active', subscriptionId: 'subscription-a' });
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({
        definitions: [{ ...definition, filterSchema: gmailFilterSchema, deliveryMode: 'polling' }],
      }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      createConnectionEventSubscription: create,
    });
    const view = renderNotifications(transport);
    await choose(user, 'Account activity', 'New email');
    expect(screen.getByRole('spinbutton', { name: 'Interval' })).toHaveValue(1.5);
    expect(screen.getByRole('textbox', { name: 'Labels' })).toHaveValue('INBOX');
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'User' })).toHaveValue('me');
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveAccessibleDescription(
      expect.stringContaining('Examples (not selected)')
    );
    expect(screen.getByText('Check timing is unavailable')).toBeVisible();
    await user.clear(screen.getByRole('spinbutton', { name: 'Interval' }));
    expect(screen.getByRole('button', { name: 'Set up notification' })).toBeDisabled();
    await user.type(screen.getByRole('spinbutton', { name: 'Interval' }), '1.5');
    await user.clear(screen.getByRole('textbox', { name: 'Labels' }));
    await user.type(screen.getByRole('textbox', { name: 'User' }), '-edited');
    view.rerenderConnection('connection-a');
    await choose(user, 'Agent', 'Researcher');
    expect(screen.getByRole('textbox', { name: 'User' })).toHaveValue('me-edited');
    await user.click(screen.getByRole('button', { name: 'Set up notification' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        'connection-a',
        expect.objectContaining({
          definitionId: 'definition-a',
          agentId: 'agent-a',
          destination: { kind: 'agent', id: 'agent-a' },
          filter: { interval: 1.5, labelIds: '', query: '', userId: 'me-edited' },
        })
      )
    );
  });

  it('renders an empty enum default as a real choice and submits it exactly', async () => {
    const user = userEvent.setup();
    const create = vi
      .fn()
      .mockResolvedValue({ status: 'active', subscriptionId: 'subscription-a' });
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({
        definitions: [
          {
            ...definition,
            filterSchema: {
              type: 'object',
              properties: {
                folder: { type: 'string', title: 'Folder', enum: ['', 'inbox'], default: '' },
              },
            },
          },
        ],
      }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      createConnectionEventSubscription: create,
    });
    renderNotifications(transport);
    await choose(user, 'Account activity', 'New email');
    expect(screen.getByRole('combobox', { name: 'Folder' })).toHaveTextContent('Leave blank');
    await choose(user, 'Folder', 'inbox');
    await choose(user, 'Folder', 'Leave blank');
    await choose(user, 'Agent', 'Researcher');
    await user.click(screen.getByRole('button', { name: 'Set up notification' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        'connection-a',
        expect.objectContaining({ filter: { folder: '' } })
      )
    );
  });

  it('shows pending, active, and revoked history across explicit pages', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi
        .fn()
        .mockResolvedValue({ definitions: [] } satisfies ConnectionEventDefinitionPage),
      listConnectionEventSubscriptions: vi
        .fn()
        .mockResolvedValueOnce({
          subscriptions: [subscription(), subscription({ id: 'subscription-p', state: 'pending' })],
          nextCursor: 'page-2',
        })
        .mockResolvedValueOnce({
          subscriptions: [subscription({ id: 'subscription-r', state: 'revoked' })],
        }),
    });

    renderNotifications(transport);

    expect(await screen.findByText('Delivery is managed by DorkOS')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more notifications' }));
    expect(await screen.findByText('revoked')).toBeInTheDocument();
    expect(transport.listConnectionEventSubscriptions).toHaveBeenNthCalledWith(
      2,
      'connection-a',
      'page-2'
    );
  });

  it('loads later discovery pages instead of hiding available activity', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi
        .fn()
        .mockResolvedValueOnce({ definitions: [], nextCursor: 'definitions-2' })
        .mockResolvedValueOnce({ definitions: [definition] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
    });

    renderNotifications(transport);
    await user.click(await screen.findByRole('button', { name: 'Load more activity' }));
    expect(await screen.findByRole('combobox', { name: 'Account activity' })).toBeInTheDocument();
    expect(transport.listConnectionEventDefinitions).toHaveBeenNthCalledWith(
      2,
      'connection-a',
      'definitions-2'
    );
  });

  it('keeps one request id across retry and leaves existing service triggers alone', async () => {
    const user = userEvent.setup();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(subscription({ state: 'pending' }));
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [definition] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      createConnectionEventSubscription: create,
    });

    renderNotifications(transport);
    await screen.findByText('No notifications set up.');
    await choose(user, 'Account activity', 'New email');
    await choose(user, 'Agent', 'Researcher');
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), 'inbox');
    await user.click(screen.getByRole('button', { name: 'Set up notification' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('retry the same decision');
    await user.click(screen.getByRole('button', { name: 'Set up notification' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const first = create.mock.calls[0]?.[1];
    const second = create.mock.calls[1]?.[1];
    expect(first).toEqual(
      expect.objectContaining({
        definitionId: 'definition-a',
        agentId: 'agent-a',
        destination: { kind: 'agent', id: 'agent-a' },
        filter: { folder: 'inbox' },
        manageExistingTrigger: false,
      })
    );
    expect(first.requestId).toBe(second.requestId);
  });

  it('starts a fresh consent identity after the mounted sheet switches accounts', async () => {
    const user = userEvent.setup();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(subscription({ connectionId: 'connection-b' as never }));
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [definition] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      createConnectionEventSubscription: create,
    });
    const view = renderNotifications(transport);

    await choose(user, 'Account activity', 'New email');
    await choose(user, 'Agent', 'Researcher');
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), 'inbox');
    await user.click(screen.getByRole('button', { name: 'Set up notification' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('retry the same decision');

    view.rerenderConnection('connection-b');
    await choose(user, 'Account activity', 'New email');
    await choose(user, 'Agent', 'Researcher');
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), 'inbox');
    await user.click(screen.getByRole('button', { name: 'Set up notification' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0]?.[0]).toBe('connection-a');
    expect(create.mock.calls[1]?.[0]).toBe('connection-b');
    expect(create.mock.calls[1]?.[1].requestId).not.toBe(create.mock.calls[0]?.[1].requestId);
  });

  it('clears write-only setup fields after the mounted sheet switches accounts', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'byo_webhook',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
    });
    const view = renderNotifications(transport);

    await user.type(
      await screen.findByRole('textbox', { name: 'Public DorkOS address' }),
      'https://account-a.example'
    );
    await user.type(screen.getByLabelText('Signing secret'), 'account-a-secret');

    view.rerenderConnection('connection-b');
    expect(await screen.findByRole('textbox', { name: 'Public DorkOS address' })).toHaveValue('');
    expect(screen.getByLabelText('Signing secret')).toHaveValue('');
  });

  it('ignores an earlier account response after the mounted sheet switches accounts', async () => {
    const user = userEvent.setup();
    let finish!: (value: ConnectionEventSubscription) => void;
    const create = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [definition] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      createConnectionEventSubscription: create,
    });
    const view = renderNotifications(transport);

    await choose(user, 'Account activity', 'New email');
    await choose(user, 'Agent', 'Researcher');
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), 'inbox');
    await user.click(screen.getByRole('button', { name: 'Set up notification' }));

    view.rerenderConnection('connection-b');
    await choose(user, 'Account activity', 'New email');
    await choose(user, 'Agent', 'Researcher');
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), 'archive');
    finish(subscription({ connectionId: 'connection-a' as never }));

    expect(await screen.findByRole('combobox', { name: 'Account activity' })).toHaveTextContent(
      'New email'
    );
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('archive');
  });

  it('allows consent when delivery timing is unknown and keeps that uncertainty visible', async () => {
    const user = userEvent.setup();
    const create = vi.fn().mockResolvedValue(subscription({ deliveryMode: 'unknown' }));
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({
        definitions: [{ ...definition, deliveryMode: 'unknown', filterSchema: {} }],
      }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      createConnectionEventSubscription: create,
    });

    renderNotifications(transport);
    await choose(user, 'Account activity', 'New email');
    await choose(user, 'Agent', 'Researcher');
    expect(screen.getByText('Delivery timing is unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Setup may remain pending/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up notification' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
  });

  it('distinguishes same-event scopes and removes the exact selected subscription', async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockResolvedValue(undefined);
    const duplicateNameAgent: TeamMember = {
      ...agent,
      id: 'agent-b',
      handle: 'researcher-b',
      agent: { ...agent.agent!, manifestId: 'agent-b', isDefault: false },
    };
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({
        subscriptions: [
          subscription({
            destination: { kind: 'room', id: 'room-a' },
            filter: {},
          }),
          subscription({
            id: 'subscription-b',
            agentId: 'agent-b',
            destination: { kind: 'channel', id: 'channel-missing' },
            filter: {},
          }),
        ],
      }),
      listMemberRooms: vi.fn().mockResolvedValue({
        rooms: [
          { id: 'room-a', name: 'Updates', slug: 'updates', kind: 'channel', memberCount: 2 },
        ],
      }),
      deleteConnectionEventSubscription: remove,
    });

    renderNotifications(transport, 'connection-a', [agent, duplicateNameAgent]);
    expect(
      await screen.findByText('For Researcher (agent-a) · Room #updates (room-a) · No filter')
    ).toBeInTheDocument();
    expect(
      screen.getByText('For Researcher (agent-b) · Messaging channel channel-missing · No filter')
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'Remove New email: For Researcher (agent-b) · Messaging channel channel-missing · No filter',
      })
    );
    expect(remove).toHaveBeenCalledWith('connection-a', 'subscription-b');
  });

  it('keeps string filters distinct from neighboring fields in visible and accessible scope', async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockResolvedValue(undefined);
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({
        subscriptions: [
          subscription({ id: 'subscription-joined', filter: { folder: 'inbox, unread: true' } }),
          subscription({
            id: 'subscription-fields',
            filter: { unread: true, folder: 'inbox' },
          }),
        ],
      }),
      deleteConnectionEventSubscription: remove,
    });

    renderNotifications(transport);
    expect(
      await screen.findByText(
        'For Researcher (agent-a) · Agent Researcher (agent-a) · Filter {"folder":"inbox, unread: true"}'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'For Researcher (agent-a) · Agent Researcher (agent-a) · Filter {"folder":"inbox","unread":true}'
      )
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'Remove New email: For Researcher (agent-a) · Agent Researcher (agent-a) · Filter {"folder":"inbox","unread":true}',
      })
    );
    expect(remove).toHaveBeenCalledWith('connection-a', 'subscription-fields');
  });

  it('reloads the exact subscription list after a revoke response is lost', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ subscriptions: [subscription()] })
      .mockResolvedValue({ subscriptions: [subscription({ state: 'revoked' })] });
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'managed',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [] }),
      listConnectionEventSubscriptions: list,
      deleteConnectionEventSubscription: vi.fn().mockRejectedValue(new Error('response lost')),
    });

    renderNotifications(transport);
    await user.click(
      await screen.findByRole('button', {
        name: 'Remove New email: For Researcher (agent-a) · Agent Researcher (agent-a) · Filter {"folder":"inbox"}',
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'couldn’t confirm whether that notification was removed'
    );
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
    expect(list.mock.calls.every(([connectionId]) => connectionId === 'connection-a')).toBe(true);
    expect(await screen.findByText('revoked')).toBeInTheDocument();
  });

  it.each([
    {
      kind: 'room' as const,
      option: '#updates',
      destinationId: 'room-a',
      transport: {
        listMemberRooms: vi.fn().mockResolvedValue({
          rooms: [
            { id: 'room-a', name: 'Updates', slug: 'updates', kind: 'channel', memberCount: 2 },
          ],
        }),
      },
    },
    {
      kind: 'channel' as const,
      option: 'Operator alerts',
      destinationId: '11111111-1111-4111-8111-111111111111',
      transport: {
        getBindings: vi.fn().mockResolvedValue([
          {
            id: '11111111-1111-4111-8111-111111111111',
            adapterId: 'telegram-a',
            agentId: 'agent-a',
            chatId: 'chat-a',
            sessionStrategy: 'per-chat',
            label: 'Operator alerts',
            permissionMode: 'default',
            enabled: true,
            canInitiate: true,
            canReply: true,
            canReceive: true,
            notifyOnTaskComplete: true,
            bridge: 'off',
            roomId: null,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            adapterId: 'telegram-a',
            agentId: 'agent-a',
            chatId: 'chat-b',
            sessionStrategy: 'per-chat',
            label: 'Read only',
            permissionMode: 'default',
            enabled: true,
            canInitiate: false,
            canReply: true,
            canReceive: true,
            notifyOnTaskComplete: true,
            bridge: 'off',
            roomId: null,
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        ]),
        listRelayAdapters: vi.fn().mockResolvedValue([
          {
            config: {
              id: 'telegram-a',
              type: 'telegram',
              enabled: true,
              config: { botToken: 'redacted' },
            },
            status: {
              id: 'telegram-a',
              type: 'telegram',
              displayName: 'Telegram',
              state: 'connected',
              messageCount: { inbound: 0, outbound: 0 },
              errorCount: 0,
            },
          },
        ]),
      },
    },
  ])(
    'uses only the selected agent’s authorized $kind destination',
    async ({ kind, option, destinationId, transport: destinationTransport }) => {
      const user = userEvent.setup();
      const create = vi
        .fn()
        .mockResolvedValue(subscription({ destination: { kind, id: destinationId } }));
      const noFilterDefinition = { ...definition, filterSchema: {} };
      const transport = createMockTransport({
        getConnectionEventSource: vi.fn().mockResolvedValue({
          setupMode: 'managed',
          configured: false,
          endpoint: null,
          reason: null,
        }),
        listConnectionEventDefinitions: vi
          .fn()
          .mockResolvedValue({ definitions: [noFilterDefinition] }),
        listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
        createConnectionEventSubscription: create,
        ...destinationTransport,
      });

      renderNotifications(transport);
      await screen.findByText('No notifications set up.');
      await choose(user, 'Account activity', 'New email');
      await choose(user, 'Agent', 'Researcher');
      await choose(user, 'Send to', kind === 'room' ? 'Room' : 'Messaging channel');
      if (kind === 'channel') {
        await user.click(screen.getByRole('combobox', { name: 'Messaging channel' }));
        expect(await screen.findByRole('option', { name: option })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: 'Read only' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('option', { name: option }));
      } else {
        await choose(user, 'Room', option);
      }
      await user.click(screen.getByRole('button', { name: 'Set up notification' }));

      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(create.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ agentId: 'agent-a', destination: { kind, id: destinationId } })
      );
    }
  );

  it('uses server-declared BYO setup and clears the write-only secret before the response', async () => {
    const user = userEvent.setup();
    let finish!: (value: {
      setupMode: 'byo_webhook';
      configured: true;
      endpoint: string;
      reason: null;
    }) => void;
    const configure = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'byo_webhook',
        configured: false,
        endpoint: null,
        reason: null,
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      configureConnectionEventSource: configure,
    });

    renderNotifications(transport);
    await user.type(
      await screen.findByRole('textbox', { name: 'Public DorkOS address' }),
      'https://dork.example'
    );
    const secret = screen.getByLabelText('Signing secret');
    await user.type(secret, '0123456789abcdef');
    await user.click(screen.getByRole('button', { name: 'Save setup' }));
    expect(secret).toHaveValue('');
    expect(configure).toHaveBeenCalledWith('connection-a', {
      publicOrigin: 'https://dork.example',
      webhookSecret: '0123456789abcdef',
    });

    finish({
      setupMode: 'byo_webhook',
      configured: true,
      endpoint: 'https://dork.example/api/connectors/webhooks/composio',
      reason: null,
    });
    expect(await screen.findByText(/api\/connectors\/webhooks\/composio/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('0123456789abcdef')).not.toBeInTheDocument();
  });

  it('hides signing controls when the server declares source setup unavailable', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectionEventSource: vi.fn().mockResolvedValue({
        setupMode: 'unavailable',
        configured: false,
        endpoint: null,
        reason: 'This service cannot receive notifications.',
      }),
      listConnectionEventDefinitions: vi.fn().mockResolvedValue({ definitions: [definition] }),
      listConnectionEventSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
    });

    renderNotifications(transport);
    expect(
      await screen.findByText('This service cannot receive notifications.')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Signing secret')).not.toBeInTheDocument();
    await choose(user, 'Account activity', 'New email');
    await choose(user, 'Agent', 'Researcher');
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), 'inbox');
    expect(screen.getByRole('button', { name: 'Set up notification' })).toBeDisabled();
  });
});
