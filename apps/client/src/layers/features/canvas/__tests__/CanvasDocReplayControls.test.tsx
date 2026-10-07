/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CanvasChannelManagementSnapshot,
  CanvasChannelBatchReplayRequest,
} from '@dorkos/shared/canvas-channel-schemas';
import { CanvasDocReplayControls } from '../ui/doc-channel/CanvasDocReplayControls';

const replay = vi.hoisted(() => vi.fn());
const transport = { replayCanvasDocBatch: replay };
vi.mock('@/layers/shared/model', () => ({ useTransport: () => transport }));
const snapshot: CanvasChannelManagementSnapshot = {
  documentId: 'doc',
  generation: 'a'.repeat(64),
  declaration: { routes: [] },
  routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'Approval needed' },
  grants: [
    {
      grantId: 'grant',
      revision: 1,
      routeId: 'route',
      allowedTypes: ['md.comment'],
      destination: 'agent:owner',
      expiresAt: '2099-01-01T00:00:00Z',
      revokedAt: null,
    },
  ],
  grantsTruncated: false,
  tokens: [],
  tokensTruncated: false,
  reviews: [
    {
      batchId: '11111111-2222-4333-8444-555555555555',
      batchGeneration: '22222222-2222-4333-8444-555555555555',
      routeId: 'route',
      grantId: 'grant',
      status: 'expired',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      reason: 'unadmitted_expiry',
      requiresExplicitReview: true,
      replayAvailable: true,
      replayUnavailableReason: null,
    },
  ],
  reviewsTruncated: false,
};
const result = (
  request: CanvasChannelBatchReplayRequest,
  status: 'pending' | 'duplicate' = 'pending'
) => ({
  documentId: request.documentId,
  eventId: request.eventId,
  previousBatchId: request.batchId,
  batchId: '33333333-2222-4333-8444-555555555555',
  generation: '44444444-2222-4333-8444-555555555555',
  status,
});
const choose = () => {
  fireEvent.change(screen.getByLabelText('Expired batch'), {
    target: { value: snapshot.reviews[0]!.batchId },
  });
  fireEvent.change(screen.getByLabelText('Current approval for replay'), {
    target: { value: 'grant' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
};
beforeEach(() => {
  replay.mockReset();
});
afterEach(cleanup);

describe('explicit replay UI DATA control', () => {
  it('requires an explicit eligible batch, current approval and review before making one original operation', async () => {
    const changed = vi.fn().mockResolvedValue(undefined),
      busy = vi.fn();
    replay.mockImplementation(async (request) => result(request));
    render(
      <CanvasDocReplayControls
        snapshot={snapshot}
        disabled={false}
        onBusyChange={busy}
        onChanged={changed}
      />
    );
    expect(screen.getByRole('button', { name: 'Replay reviewed expired work' })).toBeDisabled();
    expect(replay).not.toHaveBeenCalled();
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Replay reviewed expired work' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0]![0]).toMatchObject({
      documentId: 'doc',
      expectedGeneration: snapshot.generation,
      batchId: snapshot.reviews[0]!.batchId,
      expectedBatchGeneration: snapshot.reviews[0]!.batchGeneration,
      grantId: 'grant',
    });
    expect(Object.isFrozen(replay.mock.calls[0]![0])).toBe(true);
    expect(changed.mock.calls[0]![0]).toContain('does not mean a turn started');
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });
  it('never offers unavailable Room, uncertain or admitted review metadata as a replay permit', () => {
    render(
      <CanvasDocReplayControls
        snapshot={{
          ...snapshot,
          reviews: snapshot.reviews.map((row) => ({
            ...row,
            replayAvailable: false,
            replayUnavailableReason: 'Native Room requires review.',
          })),
        }}
        disabled={false}
        onBusyChange={vi.fn()}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByText('No expired work is available for review.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Replay reviewed expired work' })).toBeDisabled();
    expect(replay).not.toHaveBeenCalled();
  });
  it('retains the identical original request after a lost response and only inspects that operation on retry', async () => {
    const changed = vi.fn().mockResolvedValue(undefined);
    replay
      .mockRejectedValueOnce(undefined)
      .mockImplementationOnce(async (request) => result(request, 'duplicate'));
    render(
      <CanvasDocReplayControls
        snapshot={snapshot}
        disabled={false}
        onBusyChange={vi.fn()}
        onChanged={changed}
      />
    );
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Replay reviewed expired work' }));
    const retry = await screen.findByRole('button', { name: 'Retry original replay operation' });
    await waitFor(() => expect(retry).toBeEnabled());
    const original = replay.mock.calls[0]![0];
    expect(screen.getByLabelText('Expired batch')).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(replay.mock.calls[1]![0]).toBe(original);
    expect(changed.mock.calls[0]![0]).toContain('No second replay');
  });
  it('retires held results and original selection before a same-document generation replacement paints', async () => {
    let release!: (value: ReturnType<typeof result>) => void;
    replay.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const changed = vi.fn(),
      props = { disabled: false, onBusyChange: vi.fn(), onChanged: changed };
    const view = render(<CanvasDocReplayControls snapshot={snapshot} {...props} />);
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Replay reviewed expired work' }));
    const request = replay.mock.calls[0]![0];
    view.rerender(
      <CanvasDocReplayControls snapshot={{ ...snapshot, generation: 'b'.repeat(64) }} {...props} />
    );
    expect(screen.getByLabelText('Expired batch')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Retry original replay operation' })).toBeNull();
    await act(async () => {
      release(result(request));
    });
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByText(/Reviewed work is pending/)).toBeNull();
  });
  it('keeps a foreign operation reply unknown rather than announcing successful replay', async () => {
    const changed = vi.fn();
    replay.mockImplementation(async (request) => ({
      ...result(request),
      previousBatchId: 'foreign',
    }));
    render(
      <CanvasDocReplayControls
        snapshot={snapshot}
        disabled={false}
        onBusyChange={vi.fn()}
        onChanged={changed}
      />
    );
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Replay reviewed expired work' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry original replay operation' })).toBeEnabled()
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('could not be confirmed');
  });
});
