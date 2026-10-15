/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { CanvasChannelManagementSnapshot } from '@dorkos/shared/canvas-channel-schemas';
import { CanvasDocRouteControls } from '../ui/doc-channel/CanvasDocRouteControls';
const owner = vi.hoisted(() => ({ transport: null as unknown }));
vi.mock('@/layers/shared/model', () => ({ useTransport: () => owner.transport }));
afterEach(cleanup);
const snapshot: CanvasChannelManagementSnapshot = {
  documentId: 'doc',
  generation: 'a'.repeat(64),
  declaration: {
    routes: [
      {
        id: 'comments',
        on: 'task.*',
        to: 'agent:owner',
        turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
      },
    ],
  },
  routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'Approval needed' },
  grants: [],
  grantsTruncated: false,
  tokens: [],
  tokensTruncated: false,
  reviews: [],
  reviewsTruncated: false,
};
const ticket = { approvalId: 'approval', token: 'route-ticket', expiresAt: '2099-01-01T01:00:00Z' };
function setup() {
  const transport = createMockTransport({
    approveCanvasDocRoute: vi.fn().mockResolvedValue({ kind: 'approval_required', ticket }),
    listPendingApprovals: vi.fn().mockResolvedValue({
      approvals: [
        {
          approvalId: 'approval',
          capabilityId: 'ui.approve_doc_route',
          detail: '{"target":{"agentId":"actual-original-agent"}}',
        },
      ],
    }),
    grantApproval: vi
      .fn()
      .mockResolvedValue({ ok: true, approvalId: 'approval', outcome: 'granted' }),
    denyApproval: vi
      .fn()
      .mockResolvedValue({ ok: true, approvalId: 'approval', outcome: 'denied' }),
  });
  owner.transport = transport;
  const changed = vi.fn().mockResolvedValue(undefined),
    busy = vi.fn();
  const view = render(
    <CanvasDocRouteControls
      snapshot={snapshot}
      disabled={false}
      onBusyChange={busy}
      onChanged={changed}
    />
  );
  return { transport, changed, busy, view };
}
function choose() {
  fireEvent.change(screen.getByRole('combobox', { name: 'Declared route' }), {
    target: { value: 'comments' },
  });
  fireEvent.change(screen.getByLabelText('Approved event types, comma separated'), {
    target: { value: 'task.comment' },
  });
  fireEvent.change(screen.getByLabelText('Route expiry (ISO date with time zone)'), {
    target: { value: '2099-01-01T00:00:00Z' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Request exact route approval' }));
}
describe('explicit original route controls', () => {
  it('shows the actual server subject and retries only the same original request and route ticket', async () => {
    const { transport, changed } = setup();
    choose();
    await screen.findByDisplayValue('{"target":{"agentId":"actual-original-agent"}}');
    expect(transport.grantApproval).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Approved event types, comma separated')).toBeDisabled();
    vi.mocked(transport.approveCanvasDocRoute).mockResolvedValueOnce({
      kind: 'granted',
      grantId: 'grant',
      revision: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve once and apply exact request' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(transport.grantApproval).toHaveBeenCalledWith('approval');
    const calls = vi.mocked(transport.approveCanvasDocRoute).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(calls[0][0]);
    expect(calls[1][1]).toBe(ticket.token);
    expect(calls[0][0]).toEqual({
      documentId: 'doc',
      routeId: 'comments',
      allowedTypes: ['task.comment'],
      expiresAt: '2099-01-01T00:00:00Z',
    });
  });
  it('retains an offline ticket but disables approval until its actual subject is readable', async () => {
    const { transport } = setup();
    vi.mocked(transport.listPendingApprovals).mockRejectedValueOnce(new Error('offline'));
    choose();
    await screen.findByDisplayValue('Original subject unavailable. Reload it before approving.');
    expect(
      screen.getByRole('button', { name: 'Approve once and apply exact request' })
    ).toBeDisabled();
    expect(transport.grantApproval).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload original approval subject' }));
    await screen.findByDisplayValue('{"target":{"agentId":"actual-original-agent"}}');
    expect(transport.approveCanvasDocRoute).toHaveBeenCalledOnce();
  });
  it('denies the original ticket without consuming it or replaying any work', async () => {
    const { transport, changed } = setup();
    choose();
    await screen.findByDisplayValue('{"target":{"agentId":"actual-original-agent"}}');
    fireEvent.click(screen.getByRole('button', { name: 'Deny route approval' }));
    await screen.findByText('Approval denied. Existing grants are unchanged.');
    expect(transport.denyApproval).toHaveBeenCalledWith('approval');
    expect(transport.approveCanvasDocRoute).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });
  it('retires a held result and clears the old subject before a new generation paints', async () => {
    const { transport, view, changed } = setup();
    let resolve!: (value: Awaited<ReturnType<typeof transport.approveCanvasDocRoute>>) => void;
    vi.mocked(transport.approveCanvasDocRoute).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    choose();
    await waitFor(() => expect(transport.approveCanvasDocRoute).toHaveBeenCalledOnce());
    const next = { ...snapshot, generation: 'b'.repeat(64), declaration: { routes: [] } };
    view.rerender(
      <CanvasDocRouteControls
        snapshot={next}
        disabled={false}
        onBusyChange={() => {}}
        onChanged={changed}
      />
    );
    expect(screen.getByLabelText('Declared route')).toHaveValue('');
    expect(screen.getByLabelText('Approved event types, comma separated')).toHaveValue('');
    expect(screen.queryByLabelText('Original server route approval subject')).toBeNull();
    await act(async () => {
      resolve({ kind: 'approval_required', ticket });
    });
    expect(transport.listPendingApprovals).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Original server route approval subject')).toBeNull();
  });
  it('retires an old ticket result across a same-document transport switch', async () => {
    const { transport, view, changed } = setup();
    let resolve!: (value: Awaited<ReturnType<typeof transport.approveCanvasDocRoute>>) => void;
    vi.mocked(transport.approveCanvasDocRoute).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    choose();
    await waitFor(() => expect(transport.approveCanvasDocRoute).toHaveBeenCalledOnce());
    owner.transport = createMockTransport();
    view.rerender(
      <CanvasDocRouteControls
        snapshot={snapshot}
        disabled={false}
        onBusyChange={() => {}}
        onChanged={changed}
      />
    );
    await act(async () => {
      resolve({ kind: 'approval_required', ticket });
    });
    expect(screen.queryByLabelText('Original server route approval subject')).toBeNull();
    expect(transport.listPendingApprovals).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
