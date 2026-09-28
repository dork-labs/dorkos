/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConnectionEventDefinitionPage,
  ConnectorReceiveScope,
} from '@dorkos/shared/connector-event-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { gmailFilterSchema } from './event-filter-fixtures';
import { AgentRequestEventScopes } from '../ui/AgentRequestEventScopes';

// Radix Select reads pointer capture, which jsdom does not implement.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const AGENT = { id: 'agent-1', displayName: 'Researcher' };

type DefinitionItem = ConnectionEventDefinitionPage['definitions'][number];

function definition(
  overrides: Partial<DefinitionItem> & Pick<DefinitionItem, 'id'>
): DefinitionItem {
  return {
    eventType: 'gmail.message_received',
    displayName: 'New email',
    toolkit: 'gmail',
    toolkitVersion: '2026-09-01',
    definitionHash: `sha256:${'1'.repeat(64)}`,
    filterSchema: {},
    payloadSchema: {},
    deliveryMode: 'webhook',
    expectedCadenceSeconds: null,
    ...overrides,
  };
}

function transportWith(definitions: DefinitionItem[]): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getConnectionEventSource).mockResolvedValue({
    setupMode: 'managed',
    configured: false,
    endpoint: null,
    reason: null,
  });
  vi.mocked(transport.listConnectionEventDefinitions).mockResolvedValue({ definitions });
  return transport;
}

/** Render the updates picker and return the latest scopes it reported (`null` = incomplete). */
function renderScopes(transport: Transport, requestedEvents: string[]) {
  const onChange = vi.fn<(scopes: ConnectorReceiveScope[] | null) => void>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <AgentRequestEventScopes
          connectionId="connection-1"
          requestedEvents={requestedEvents}
          agent={AGENT}
          onChange={onChange}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { latest: () => onChange.mock.calls.at(-1)?.[0] };
}

describe('AgentRequestEventScopes', () => {
  it('reports one exact scope per requested event, only once every field is filled', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      definition({
        id: 'definition-1',
        filterSchema: {
          type: 'object',
          properties: { folder: { type: 'string', title: 'Folder' } },
          required: ['folder'],
        },
      }),
    ]);
    const { latest } = renderScopes(transport, ['gmail.message_received']);

    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(latest()).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Folder' }), 'inbox');

    await waitFor(() =>
      expect(latest()).toEqual([
        {
          connectionId: 'connection-1',
          definitionId: 'definition-1',
          filter: { folder: 'inbox' },
          agentId: 'agent-1',
          destination: { kind: 'agent', id: 'agent-1' },
        },
      ])
    );
    // Choosing never subscribes anything before the person answers.
    expect(transport.createConnectionEventSubscription).not.toHaveBeenCalled();
  });

  it('includes defaults and an explicit blank in the exact scope', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      definition({
        id: 'definition-defaults',
        filterSchema: gmailFilterSchema,
        deliveryMode: 'polling',
      }),
    ]);
    const { latest } = renderScopes(transport, ['gmail.message_received']);

    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(screen.getByRole('textbox', { name: 'Labels' })).toHaveValue('INBOX');
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('');
    expect(screen.getByRole('spinbutton', { name: 'Interval' })).toHaveValue(1.5);
    await user.clear(screen.getByRole('textbox', { name: 'Labels' }));
    await user.type(screen.getByRole('textbox', { name: 'Labels' }), 'owner-label');

    await waitFor(() =>
      expect(latest()).toEqual([
        expect.objectContaining({
          definitionId: 'definition-defaults',
          filter: { interval: 1.5, labelIds: 'owner-label', query: '', userId: 'me' },
        }),
      ])
    );
  });

  it('stays incomplete until every requested event has a scope', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      definition({ id: 'definition-1' }),
      definition({
        id: 'definition-2',
        eventType: 'gmail.mailbox_changed',
        displayName: 'Mailbox changed',
        definitionHash: `sha256:${'2'.repeat(64)}`,
      }),
    ]);
    const { latest } = renderScopes(transport, ['gmail.message_received', 'gmail.mailbox_changed']);

    const activity = await screen.findAllByRole('combobox', { name: 'Account activity' });
    await user.click(activity[0]!);
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(latest()).toBeNull();
    await user.click(activity[1]!);
    await user.click(await screen.findByRole('option', { name: 'Mailbox changed' }));
    await waitFor(() => expect(latest()).toHaveLength(2));
  });

  it('refuses an update whose filter cannot be shown safely', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      definition({
        id: 'definition-unsupported',
        filterSchema: {
          type: 'object',
          properties: {},
          patternProperties: { '.*': { type: 'string' } },
        },
      }),
    ]);
    const { latest } = renderScopes(transport, ['gmail.message_received']);

    await user.click(await screen.findByRole('combobox', { name: 'Account activity' }));
    await user.click(await screen.findByRole('option', { name: 'New email' }));
    expect(
      screen.getByText('This notification needs filter controls this app cannot safely show yet.')
    ).toBeVisible();
    expect(latest()).toBeNull();
  });

  it('uses the server’s delivery setup and never offers updates nobody asked for', async () => {
    const user = userEvent.setup();
    const transport = transportWith([
      definition({ id: 'definition-requested' }),
      definition({
        id: 'definition-unrequested',
        eventType: 'gmail.draft_created',
        displayName: 'Draft created',
      }),
    ]);
    vi.mocked(transport.getConnectionEventSource).mockResolvedValue({
      setupMode: 'unavailable',
      configured: false,
      endpoint: null,
      reason: 'Notifications are unavailable for this account.',
    });
    const { latest } = renderScopes(transport, ['gmail.message_received']);

    expect(
      await screen.findByText('Notifications are unavailable for this account.')
    ).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Account activity' }));
    expect(await screen.findByRole('option', { name: 'New email' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Draft created' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'New email' }));
    expect(latest()).toBeNull();
  });

  it('loads later pages before calling an update unavailable', async () => {
    const user = userEvent.setup();
    const transport = transportWith([]);
    vi.mocked(transport.listConnectionEventDefinitions)
      .mockResolvedValueOnce({ definitions: [], nextCursor: 'definitions-2' })
      .mockResolvedValueOnce({
        definitions: [definition({ id: 'definition-later', deliveryMode: 'unknown' })],
      });
    renderScopes(transport, ['gmail.message_received']);

    expect(
      await screen.findByText('Load more notification options to finish this request.')
    ).toBeVisible();
    expect(screen.queryByText('This account does not currently offer this activity.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load more notification options' }));
    expect(await screen.findByRole('combobox', { name: 'Account activity' })).toBeVisible();
    expect(transport.listConnectionEventDefinitions).toHaveBeenNthCalledWith(
      2,
      'connection-1',
      'definitions-2'
    );
  });
});
