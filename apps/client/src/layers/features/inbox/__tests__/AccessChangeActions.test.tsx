/**
 * Undo and Keep the change on the Needs-you item for one agent taking another
 * agent's access away (spec `agent-grant-autonomy`, Security G2): the agent's
 * reason reads as plain text with its name on it, the line holds its height
 * while it loads, and Undo's result shows in place.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorAccessChange } from '@dorkos/shared/connector-exclusion-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '@/layers/shared/model';
import { InboxRow } from '../ui/InboxRow';

afterEach(cleanup);

const NOTICE: NotificationDTO = {
  id: '01JZR000000000000000000A',
  kind: 'connector.access_narrowed',
  tier: 'blocking',
  subject: { type: 'system', id: 'change-1' },
  title: 'DorkOS PM took Gmail (Work) access away from flow-snapshot',
  body: 'Undo puts it back.',
  actions: [
    { id: 'undo-access-change', label: 'Undo', style: 'neutral' },
    { id: 'keep-access-change', label: 'Keep the change', style: 'primary' },
  ],
  createdAt: new Date().toISOString(),
};

function change(reason: string | null): ConnectorAccessChange {
  return {
    changeId: 'change-1',
    kind: 'narrow_other',
    outcome: 'applied',
    refusalCode: null,
    actorKind: 'agent',
    actorId: 'agent-pm',
    targetAgentId: 'agent-flow',
    connectionId: 'connection-a',
    reason,
    undoOf: null,
    undoneBy: null,
    createdAt: new Date().toISOString(),
  };
}

function renderRow(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    listMeshAgents: vi.fn().mockResolvedValue({
      agents: [{ id: 'agent-pm', name: 'pm', displayName: 'DorkOS PM' }],
    }),
    ...overrides,
  });
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TransportProvider transport={transport}>
        <InboxRow notification={NOTICE} onOpen={() => {}} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('Undo on an agent’s access change', () => {
  it('shows the reason as the agent’s own words, as literal text', async () => {
    renderRow({
      getAccessChange: vi
        .fn()
        .mockResolvedValue(change('See [link](https://example.com) and <b>bold</b>')),
    });
    const line = await screen.findByText(/reason:/);
    expect(line).toHaveTextContent(
      'DorkOS PM’s reason: See [link](https://example.com) and <b>bold</b>'
    );
    // The agent’s own mark sits beside the name it gave itself, so a name like
    // "DorkOS" can’t pass as DorkOS’s own words.
    expect(
      line
        .closest('[data-slot="access-change-reason"]')
        ?.querySelector('[data-slot="access-change-actor"]')
    ).not.toBeNull();
    // Nothing in it became markup.
    expect(line.querySelector('a, b')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('holds the reason line’s height while it loads', () => {
    renderRow({ getAccessChange: vi.fn(() => new Promise<ConnectorAccessChange>(() => {})) });
    expect(document.querySelector('[data-slot="access-change-reason-loading"]')).not.toBeNull();
  });

  it('gives access back, and says so in place', async () => {
    const undo = vi.fn().mockResolvedValue({ changeId: 'change-1', undoId: 'undo-1' });
    renderRow({
      getAccessChange: vi.fn().mockResolvedValue(change('Not used.')),
      undoAccessChange: undo,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Access given back')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(undo).toHaveBeenCalledWith('change-1');
  });

  it('keeps the change by marking the item read', async () => {
    const markRead = vi.fn().mockResolvedValue({ updated: 1, unreadCount: 0 });
    renderRow({
      getAccessChange: vi.fn().mockResolvedValue(change(null)),
      markNotificationRead: markRead,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Keep the change' }));
    expect(await screen.findByText('Kept')).toBeInTheDocument();
    expect(markRead).toHaveBeenCalledWith('01JZR000000000000000000A');
  });

  it('refused because access changed since: says so where Undo was, and keeps focus there', async () => {
    renderRow({
      getAccessChange: vi.fn().mockResolvedValue(change('Not used.')),
      undoAccessChange: vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error('Access has changed since then. Set it on the Connections page instead.'),
            { status: 409, code: 'UNDO_STALE' }
          )
        ),
    });

    const undoButton = screen.getByRole('button', { name: 'Undo' });
    undoButton.focus();
    fireEvent.click(undoButton);
    const line = await screen.findByText(/Access changed since\./);
    expect(line).toHaveTextContent('Access changed since. Set it in Connections');
    expect(line).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    // Focus stays where Undo was: on the line, not jumped to the link.
    expect(line).toHaveFocus();
    expect(screen.getByRole('link', { name: 'Connections' })).toHaveAttribute(
      'href',
      '/connections'
    );
  });
});
