/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { CanvasDocRoute, CanvasDocRouteReview } from '@dorkos/shared/canvas-doc-routes';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { CanvasDocRoutes } from '../ui/doc-routes/CanvasDocRoutes';

const LIMITS = { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 };
const route = (overrides: Partial<CanvasDocRoute> = {}): CanvasDocRoute => ({
  id: 'helper',
  on: 'task.*',
  to: 'agent:atlas',
  turn: 'immediate',
  destination: { kind: 'agent', agentId: 'atlas', agentName: 'Atlas' },
  needsPerson: true,
  state: 'no_grant',
  grant: null,
  waiting: null,
  ...overrides,
});
const granted = (expiresAt = '2026-10-18T15:00:00.000Z'): CanvasDocRoute =>
  route({
    state: 'granted',
    grant: {
      grantId: 'grant-1',
      allowedTypes: ['task.*'],
      limits: LIMITS,
      createdAt: '2026-10-17T15:00:00.000Z',
      expiresAt,
      revokedAt: null,
      approvedBy: 'person',
    },
  });

let transport: Transport;
function show(routes: CanvasDocRoute[]) {
  vi.mocked(transport.getCanvasDocRoutes).mockResolvedValue({ documentId: 'doc-1', routes });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <CanvasDocRoutes documentId="doc-1" />
      </TransportProvider>
    </QueryClientProvider>
  );
}
async function openPanel() {
  fireEvent.click(await screen.findByTestId('doc-routes-trigger'));
  return screen.findByTestId('doc-routes-panel');
}

beforeEach(() => {
  transport = createMockTransport();
  vi.mocked(transport.reviewCanvasDocRoute).mockImplementation(
    async (documentId, routeId, request): Promise<CanvasDocRouteReview> => ({
      documentId,
      routeId,
      on: 'task.*',
      destination: { kind: 'agent', agentId: 'atlas', agentName: 'Atlas' },
      allowedTypes: ['task.*'],
      limits: LIMITS,
      expiresAt: request.expiresAt,
      reviewHash: 'b'.repeat(64),
    })
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CanvasDocRoutes', () => {
  it('draws nothing for a document that declares no routes', async () => {
    show([]);
    await waitFor(() => expect(transport.getCanvasDocRoutes).toHaveBeenCalledWith('doc-1'));
    expect(screen.queryByTestId('doc-routes-bar')).toBeNull();
  });

  it('draws nothing when the document has no channel at all', async () => {
    vi.mocked(transport.getCanvasDocRoutes).mockRejectedValue(
      Object.assign(new Error('gone'), { status: 404 })
    );
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <CanvasDocRoutes documentId="doc-1" />
        </TransportProvider>
      </QueryClientProvider>
    );
    await waitFor(() => expect(transport.getCanvasDocRoutes).toHaveBeenCalled());
    expect(screen.queryByTestId('doc-routes-bar')).toBeNull();
  });

  it('shows a declared route as off, never on by silence', async () => {
    show([route()]);
    expect(await screen.findByTestId('doc-routes-trigger')).toHaveAccessibleName(
      'Event routes: Off'
    );
    const panel = await openPanel();
    const row = within(panel).getByTestId('doc-route-helper');
    expect(row).toHaveAttribute('data-state', 'no_grant');
    expect(within(row).getByText('To Atlas')).toBeInTheDocument();
    expect(within(row).getByText('Off')).toBeInTheDocument();
    expect(within(row).getByText('Needs your approval to start work.')).toBeInTheDocument();
  });

  it('shows the server’s exact details, then approves only the reviewed hash', async () => {
    vi.mocked(transport.approveCanvasDocRoute).mockImplementation(async () => {
      // The server now answers the granted route on every read, as it would.
      vi.mocked(transport.getCanvasDocRoutes).mockResolvedValue({
        documentId: 'doc-1',
        routes: [granted()],
      });
      return { route: granted() };
    });
    show([route()]);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId('doc-route-review-button-helper'));
    const review = await within(panel).findByTestId('doc-route-review-helper');
    expect(await within(review).findByText('task.*')).toBeInTheDocument();
    expect(within(review).getByText('To Atlas')).toBeInTheDocument();
    expect(within(review).getByText('10 turns an hour · 60 events a minute')).toBeInTheDocument();
    const [, , reviewed] = vi.mocked(transport.reviewCanvasDocRoute).mock.calls[0]!;
    fireEvent.click(within(review).getByTestId('doc-route-allow-helper'));
    await waitFor(() =>
      expect(transport.approveCanvasDocRoute).toHaveBeenCalledWith('doc-1', 'helper', {
        expiresAt: reviewed.expiresAt,
        reviewHash: 'b'.repeat(64),
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('helper is on.');
    expect(within(panel).getByTestId('doc-route-state-helper')).toHaveTextContent('On');
  });

  it('reviews again when the end time changes, and allows nothing until it arrives', async () => {
    show([route()]);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId('doc-route-review-button-helper'));
    await within(await within(panel).findByTestId('doc-route-review-helper')).findByText('task.*');
    fireEvent.click(within(panel).getByRole('radio', { name: '1 week' }));
    await waitFor(() => expect(transport.reviewCanvasDocRoute).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(transport.reviewCanvasDocRoute).mock.calls;
    expect(Date.parse(second![2].expiresAt)).toBeGreaterThan(Date.parse(first![2].expiresAt));
  });

  it('says why an approval was refused and keeps the review open', async () => {
    vi.mocked(transport.approveCanvasDocRoute).mockRejectedValue(
      Object.assign(new Error('changed'), { code: 'ROUTE_CHANGED', status: 409 })
    );
    show([route()]);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId('doc-route-review-button-helper'));
    await within(await within(panel).findByTestId('doc-route-review-helper')).findByText('task.*');
    fireEvent.click(within(panel).getByTestId('doc-route-allow-helper'));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'This route changed. Review it again.'
    );
    expect(within(panel).getByTestId('doc-route-review-helper')).toBeInTheDocument();
  });

  it('shows a review refusal with a way to retry', async () => {
    vi.mocked(transport.reviewCanvasDocRoute).mockRejectedValue(
      Object.assign(new Error('no target'), { code: 'TARGET_UNAVAILABLE', status: 403 })
    );
    show([route()]);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId('doc-route-review-button-helper'));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'The agent for this route isn’t available.'
    );
    expect(within(panel).getByTestId('doc-route-allow-helper')).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('turns a granted route off and announces it', async () => {
    const revoked = route({
      state: 'revoked',
      grant: { ...granted().grant!, revokedAt: '2026-10-17T16:00:00.000Z' },
    });
    vi.mocked(transport.revokeCanvasDocRoute).mockImplementation(async () => {
      vi.mocked(transport.getCanvasDocRoutes).mockResolvedValue({
        documentId: 'doc-1',
        routes: [revoked],
      });
      return { route: revoked };
    });
    show([granted()]);
    expect(await screen.findByTestId('doc-routes-trigger')).toHaveAccessibleName(
      'Event routes: 1 on'
    );
    const panel = await openPanel();
    expect(within(panel).getByText('10 turns an hour · 60 events a minute')).toBeInTheDocument();
    fireEvent.click(within(panel).getByTestId('doc-route-turn-off-helper'));
    await waitFor(() =>
      expect(transport.revokeCanvasDocRoute).toHaveBeenCalledWith('doc-1', 'helper', 'grant-1')
    );
    expect(await screen.findByRole('status')).toHaveTextContent('helper is off.');
    expect(within(panel).getByTestId('doc-route-state-helper')).toHaveTextContent('Turned off');
  });

  it('flags a route an agent is waiting on in the header', async () => {
    show([
      route({
        state: 'waiting',
        waiting: { approvalId: 'a1', expiresAt: '2026-10-17T18:00:00.000Z' },
      }),
    ]);
    expect(await screen.findByTestId('doc-routes-trigger')).toHaveAccessibleName(
      'Event routes: 1 waiting'
    );
    const panel = await openPanel();
    expect(within(panel).getByText('An agent asked for this route.')).toBeInTheDocument();
  });

  it('labels suspended and expired routes so they read as needing a new approval', async () => {
    show([
      route({ id: 'a', state: 'suspended', grant: granted().grant }),
      route({ id: 'b', state: 'expired', grant: granted('2026-10-01T10:00:00.000Z').grant }),
    ]);
    const panel = await openPanel();
    expect(within(panel).getByTestId('doc-route-state-a')).toHaveTextContent('Paused');
    expect(within(panel).getByTestId('doc-route-state-b')).toHaveTextContent('Ended');
    expect(within(panel).getByTestId('doc-route-review-button-b')).toBeEnabled();
  });

  it('holds every change while the browser is offline', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    show([route(), route({ id: 'on', grant: granted().grant, state: 'granted' })]);
    const panel = await openPanel();
    expect(within(panel).getByTestId('doc-routes-offline')).toBeInTheDocument();
    expect(within(panel).getByTestId('doc-route-review-button-helper')).toBeDisabled();
    expect(within(panel).getByTestId('doc-route-turn-off-on')).toBeDisabled();
    online.mockRestore();
  });
});
