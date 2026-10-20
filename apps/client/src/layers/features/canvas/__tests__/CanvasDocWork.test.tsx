/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type {
  CanvasDocRoute,
  CanvasDocWorkChange,
  CanvasDocWorkItem,
} from '@dorkos/shared/canvas-doc-routes';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { CanvasDocRoutes } from '../ui/doc-routes/CanvasDocRoutes';

const route: CanvasDocRoute = {
  id: 'tasks',
  on: 'task.*',
  to: 'agent:owner',
  turn: 'coalesce',
  destination: { kind: 'owner', agentId: 'scout', agentName: 'Scout' },
  needsPerson: false,
  state: 'granted',
  grant: null,
  waiting: null,
};
const item = (overrides: Partial<CanvasDocWorkItem> = {}): CanvasDocWorkItem => ({
  batchId: 'batch-1',
  routeId: 'tasks',
  status: 'expired',
  eventCount: 3,
  since: new Date(Date.now() - 3_600_000).toISOString(),
  replay: 'ready',
  ...overrides,
});
const changed = (work: CanvasDocWorkItem, action: 'replayed' | 'cleared'): CanvasDocWorkChange => ({
  batchId: work.batchId,
  routeId: work.routeId,
  action,
  previousStatus: work.status,
  nextBatchId: action === 'replayed' ? 'batch-2' : null,
});

let transport: Transport;
function show(items: CanvasDocWorkItem[], routes: CanvasDocRoute[] = [route]) {
  vi.mocked(transport.getCanvasDocRoutes).mockResolvedValue({ documentId: 'doc-1', routes });
  vi.mocked(transport.getCanvasDocWork).mockResolvedValue({ documentId: 'doc-1', items });
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
  fireEvent.click(await screen.findByTestId('doc-work-trigger'));
  return screen.findByTestId('doc-work-panel');
}
/** After a change, the server answers the list without that work, as it would. */
function emptyAfter() {
  vi.mocked(transport.getCanvasDocWork).mockResolvedValue({ documentId: 'doc-1', items: [] });
}

beforeEach(() => {
  transport = createMockTransport();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CanvasDocWork', () => {
  it('shows nothing when there is no work to review', async () => {
    show([]);
    await waitFor(() => expect(transport.getCanvasDocWork).toHaveBeenCalledWith('doc-1'));
    expect(await screen.findByTestId('doc-routes-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-work-trigger')).toBeNull();
  });

  it('never asks for work on a document without routes', async () => {
    show([item()], []);
    await waitFor(() => expect(transport.getCanvasDocRoutes).toHaveBeenCalled());
    expect(transport.getCanvasDocWork).not.toHaveBeenCalled();
    expect(screen.queryByTestId('doc-work-trigger')).toBeNull();
  });

  it('shows expired and uncertain work beside the routes, and replays expired work in one step', async () => {
    const expired = item();
    const uncertain = item({ batchId: 'batch-u', status: 'in_doubt', eventCount: 1 });
    vi.mocked(transport.replayCanvasDocWork).mockImplementation(async () => {
      vi.mocked(transport.getCanvasDocWork).mockResolvedValue({
        documentId: 'doc-1',
        items: [uncertain],
      });
      return changed(expired, 'replayed');
    });
    show([expired, uncertain]);
    expect(await screen.findByTestId('doc-work-trigger')).toHaveAccessibleName(
      'Unfinished work: 2 to review'
    );
    const panel = await openPanel();
    const row = within(panel).getByTestId('doc-work-batch-1');
    expect(row).toHaveAttribute('data-status', 'expired');
    expect(within(row).getByText('To Scout')).toBeInTheDocument();
    expect(within(row).getByText('Never started')).toBeInTheDocument();
    expect(within(row).getByText(/3 events/)).toBeInTheDocument();
    expect(
      within(within(panel).getByTestId('doc-work-batch-u')).getByText('May have run')
    ).toBeInTheDocument();

    fireEvent.click(within(row).getByTestId('doc-work-replay-batch-1'));
    await waitFor(() =>
      expect(transport.replayCanvasDocWork).toHaveBeenCalledExactlyOnceWith('doc-1', 'batch-1', {})
    );
    await waitFor(() => expect(within(panel).queryByTestId('doc-work-batch-1')).toBeNull());
    expect(within(panel).getByTestId('doc-work-batch-u')).toBeInTheDocument();
    // The modal panel hides the header from the accessibility tree; read its text.
    expect(screen.getByTestId('doc-work-trigger')).toHaveTextContent('1 to review');
  });

  it('asks before running uncertain work again, and sends the confirmation only then', async () => {
    const uncertain = item({ status: 'in_doubt' });
    vi.mocked(transport.replayCanvasDocWork).mockResolvedValue(changed(uncertain, 'replayed'));
    show([uncertain]);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId('doc-work-replay-batch-1'));
    const confirm = within(panel).getByTestId('doc-work-confirm-batch-1');
    expect(
      within(confirm).getByText('It may repeat what the agent already did.')
    ).toBeInTheDocument();
    // The safe choice takes focus, never the one that repeats work.
    await waitFor(() => expect(within(confirm).getByText('Cancel')).toHaveFocus());
    expect(transport.replayCanvasDocWork).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByText('Cancel'));
    expect(within(panel).queryByTestId('doc-work-confirm-batch-1')).toBeNull();
    // Focus returns to the button that opened the step.
    await waitFor(() => expect(within(panel).getByTestId('doc-work-replay-batch-1')).toHaveFocus());
    expect(transport.replayCanvasDocWork).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByTestId('doc-work-replay-batch-1'));
    fireEvent.click(within(panel).getByTestId('doc-work-confirm-replay-batch-1'));
    await waitFor(() =>
      expect(transport.replayCanvasDocWork).toHaveBeenCalledExactlyOnceWith('doc-1', 'batch-1', {
        confirmRepeat: true,
      })
    );
  });

  it('clears work without running it, and the control goes away when none is left', async () => {
    const expired = item();
    vi.mocked(transport.clearCanvasDocWork).mockImplementation(async () => {
      emptyAfter();
      return changed(expired, 'cleared');
    });
    show([expired]);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId('doc-work-clear-batch-1'));
    await waitFor(() =>
      expect(transport.clearCanvasDocWork).toHaveBeenCalledExactlyOnceWith('doc-1', 'batch-1')
    );
    expect(transport.replayCanvasDocWork).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('doc-work-trigger')).toBeNull());
    expect(screen.getByText('Cleared: To Scout')).toBeInTheDocument();
  });

  it('says why work cannot run again and keeps Run again off', async () => {
    show([
      item({ replay: 'no_grant' }),
      item({ batchId: 'batch-b', status: 'in_doubt', replay: 'route_busy' }),
    ]);
    const panel = await openPanel();
    expect(within(panel).getByTestId('doc-work-replay-batch-1')).toBeDisabled();
    expect(within(panel).getByTestId('doc-work-blocked-batch-1')).toHaveTextContent(
      'This route is off. Allow it to run this again.'
    );
    expect(within(panel).getByTestId('doc-work-replay-batch-b')).toBeDisabled();
    expect(within(panel).getByTestId('doc-work-blocked-batch-b')).toHaveTextContent(
      'Newer work is waiting behind this. Clear it to continue.'
    );
    // Clearing stays open: it starts nothing.
    expect(within(panel).getByTestId('doc-work-clear-batch-b')).toBeEnabled();
  });

  it('neither replays nor clears uncertain work that may still be running', async () => {
    show([item({ status: 'in_doubt', replay: 'still_running' })]);
    const panel = await openPanel();
    expect(within(panel).getByTestId('doc-work-replay-batch-1')).toBeDisabled();
    expect(within(panel).getByTestId('doc-work-clear-batch-1')).toBeDisabled();
    expect(within(panel).getByTestId('doc-work-blocked-batch-1')).toHaveTextContent(
      'It may still be running. Check back once it stops.'
    );
  });

  it('shows the server’s refusal in plain words and keeps the work listed', async () => {
    vi.mocked(transport.replayCanvasDocWork).mockRejectedValue(
      Object.assign(new Error('refused'), { code: 'GRANT_REQUIRED', status: 409 })
    );
    vi.mocked(transport.clearCanvasDocWork).mockRejectedValue(new TypeError('Failed to fetch'));
    show([item()]);
    const panel = await openPanel();
    fireEvent.click(within(panel).getByTestId('doc-work-replay-batch-1'));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'This route is off. Allow it first.'
    );
    fireEvent.click(within(panel).getByTestId('doc-work-clear-batch-1'));
    await waitFor(() =>
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Couldn’t reach DorkOS. Check your connection.'
      )
    );
    expect(within(panel).getByTestId('doc-work-batch-1')).toBeInTheDocument();
  });
});
