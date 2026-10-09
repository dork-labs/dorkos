/** @vitest-environment jsdom */
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type {
  CanvasChannelManagementSnapshot,
  CanvasChannelTokenResponse,
} from '@dorkos/shared/canvas-channel-schemas';
import { CanvasDocControls } from '../ui/doc-channel/CanvasDocControls';

const owner = vi.hoisted(() => ({ transport: null as unknown }));
vi.mock('@/layers/shared/model', () => ({ useTransport: () => owner.transport }));
vi.mock('@/layers/shared/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/ui')>()),
  ResponsiveDialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResponsiveDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResponsiveDialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  ResponsiveDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  ResponsiveDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
afterEach(cleanup);
const snapshot: CanvasChannelManagementSnapshot = {
  documentId: 'doc',
  generation: 'a'.repeat(64),
  declaration: { routes: [] },
  routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'Approval needed' },
  grants: [],
  grantsTruncated: false,
  tokens: [],
  tokensTruncated: false,
  reviews: [
    {
      batchId: 'batch',
      batchGeneration: '33333333-2222-4333-8444-555555555555',
      routeId: 'route',
      grantId: 'grant',
      status: 'expired',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      reason: null,
      requiresExplicitReview: true,
    },
  ],
  reviewsTruncated: false,
};
const issued: CanvasChannelTokenResponse = {
  tokenId: 'token',
  documentId: 'doc',
  allowedTypes: ['task.comment'],
  directions: ['upstream'],
  permissions: ['ingest'],
  creatorId: 'owner',
  createdAt: '2026-10-05T00:00:00Z',
  expiresAt: '2099-10-06T12:00:00Z',
  token: `dct_${'A'.repeat(43)}`,
};
function setup(issue = vi.fn().mockResolvedValue(issued), management = snapshot) {
  const transport = createMockTransport({
    getCanvasDocManagement: vi.fn().mockResolvedValue(management),
    issueCanvasDocToken: issue,
    revokeCanvasDocToken: vi
      .fn()
      .mockResolvedValue({ tokenId: 'token', revokedAt: '2026-10-05T12:00:00Z' }),
  });
  owner.transport = transport;
  const close = vi.fn();
  const view = render(<CanvasDocControls documentId="doc" onClose={close} />);
  return { transport, close, view };
}
async function chooseScope() {
  await screen.findByText('No routes declared. Events do not create a route automatically.');
  fireEvent.change(screen.getByLabelText('Exact event types, comma separated'), {
    target: { value: 'task.comment' },
  });
  fireEvent.change(screen.getByLabelText('Expiry (ISO date with time zone)'), {
    target: { value: issued.expiresAt },
  });
  fireEvent.click(screen.getByLabelText('upstream'));
  fireEvent.click(screen.getByLabelText('ingest'));
}
describe('document controls', () => {
  it('mints only the explicit scope and clears a one-time credential on close', async () => {
    const { transport, close } = setup();
    await chooseScope();
    fireEvent.click(screen.getByText('Create token'));
    await screen.findByDisplayValue(issued.token);
    expect(transport.issueCanvasDocToken).toHaveBeenCalledWith(
      {
        documentId: 'doc',
        allowedTypes: ['task.comment'],
        directions: ['upstream'],
        permissions: ['ingest'],
        expiresAt: issued.expiresAt,
      },
      []
    );
    expect(screen.getByRole('button', { name: /replay/i })).toBeDisabled();
    expect(transport.replayCanvasDocBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Close document controls'));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByDisplayValue(issued.token)).not.toBeInTheDocument();
  });
  it('keeps close responsive while a mint is pending and drops the retired result', async () => {
    let resolve: ((value: CanvasChannelTokenResponse) => void) | undefined;
    const issue = vi.fn(
      () =>
        new Promise<CanvasChannelTokenResponse>((done) => {
          resolve = done;
        })
    );
    const { close } = setup(issue);
    await chooseScope();
    fireEvent.click(screen.getByText('Create token'));
    fireEvent.click(screen.getByText('Close document controls'));
    expect(close).toHaveBeenCalledOnce();
    resolve?.(issued);
    await waitFor(() => expect(screen.queryByDisplayValue(issued.token)).not.toBeInTheDocument());
  });
  it('drops a pending mint across a same-document transport replacement', async () => {
    let resolve: ((value: CanvasChannelTokenResponse) => void) | undefined;
    const { view } = setup(
      vi.fn(
        () =>
          new Promise<CanvasChannelTokenResponse>((done) => {
            resolve = done;
          })
      )
    );
    await chooseScope();
    fireEvent.click(screen.getByText('Create token'));
    owner.transport = createMockTransport({
      getCanvasDocManagement: vi.fn().mockResolvedValue(snapshot),
    });
    view.rerender(<CanvasDocControls documentId="doc" onClose={() => {}} />);
    await screen.findByText('No routes declared. Events do not create a route automatically.');
    resolve?.(issued);
    await waitFor(() => expect(screen.queryByDisplayValue(issued.token)).not.toBeInTheDocument());
    expect(screen.getByLabelText('Exact event types, comma separated')).toHaveValue('');
  });
  it('clears a revealed token and drops old snapshot data on document replacement', async () => {
    const { view, transport } = setup();
    await chooseScope();
    fireEvent.click(screen.getByText('Create token'));
    await screen.findByDisplayValue(issued.token);
    vi.mocked(transport.getCanvasDocManagement).mockImplementation(() => new Promise(() => {}));
    view.rerender(<CanvasDocControls documentId="other" onClose={() => {}} />);
    expect(screen.queryByDisplayValue(issued.token)).not.toBeInTheDocument();
    expect(
      screen.queryByText('No routes declared. Events do not create a route automatically.')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });
  it('updates an existing token from the genuine revoke acknowledgement despite an offline list', async () => {
    const metadata: CanvasChannelManagementSnapshot['tokens'][number] = {
      tokenId: issued.tokenId,
      documentId: issued.documentId,
      allowedTypes: issued.allowedTypes,
      directions: issued.directions,
      permissions: issued.permissions,
      creatorId: issued.creatorId,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      revokedAt: null,
    };
    const { transport } = setup(undefined, { ...snapshot, tokens: [metadata] });
    await screen.findByText('token: task.comment; Expires ' + issued.expiresAt);
    vi.mocked(transport.getCanvasDocManagement).mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByText('Revoke token'));
    await screen.findByText(
      'Token revoked. The current token list could not be refreshed. Close and reopen to retry.'
    );
    expect(screen.getByRole('status')).toHaveTextContent('Token revoked.');
    expect(screen.getByText('token: task.comment; Revoked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke token' })).toBeDisabled();
    expect(
      screen.queryByText('token: task.comment; Expires ' + issued.expiresAt)
    ).not.toBeInTheDocument();
  });
  it('clears the displayed credential before an authenticated revoke', async () => {
    const { transport } = setup();
    await chooseScope();
    fireEvent.click(screen.getByText('Create token'));
    await screen.findByDisplayValue(issued.token);
    fireEvent.click(screen.getByText('Revoke new token'));
    expect(screen.queryByDisplayValue(issued.token)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(transport.revokeCanvasDocToken).toHaveBeenCalledWith('doc', 'token')
    );
  });
});

// Turn completion is not application acknowledgement, and partial ACK names only its stored input.
it('displays original handled and rejected inputs separately from an unacknowledged completed turn', async () => {
  const input = (eventId: string, ackOutcome: 'handled' | 'rejected' | null) => ({
    eventId,
    routeId: 'route',
    batchId: 'batch',
    status: 'turn_done' as const,
    turnId: 'turn',
    reason: null,
    updatedAt: '2026-10-01T00:00:00Z',
    ackOutcome,
    ackEvidenceStatus: ackOutcome === null ? ('none' as const) : ('verified' as const),
    acknowledgedAt: ackOutcome === null ? null : '2026-10-01T00:00:01Z',
  });
  setup(undefined, {
    ...snapshot,
    reviews: [
      {
        ...snapshot.reviews[0]!,
        status: 'turn_done',
        requiresExplicitReview: false,
        inputs: [
          input('11111111-2222-4333-8444-555555555551', 'handled'),
          input('11111111-2222-4333-8444-555555555552', null),
          input('11111111-2222-4333-8444-555555555553', 'rejected'),
          {
            ...input('11111111-2222-4333-8444-555555555554', 'handled'),
            ackEvidenceStatus: 'unavailable',
          },
        ],
        inputsTruncated: true,
      },
    ],
  });
  await screen.findByText('route: Turn status: turn_done');
  expect(
    screen.getByText(
      'Input 11111111-2222-4333-8444-555555555551: Handled at 2026-10-01T00:00:01Z. Delivery status: turn_done.'
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      'Input 11111111-2222-4333-8444-555555555552: Not acknowledged. Delivery status: turn_done.'
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      'Input 11111111-2222-4333-8444-555555555553: Rejected at 2026-10-01T00:00:01Z. Delivery status: turn_done.'
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      'Input 11111111-2222-4333-8444-555555555554: Acknowledgement evidence unavailable. Delivery status: turn_done.'
    )
  ).toBeInTheDocument();
  expect(screen.getByText(/Input list incomplete/)).toBeInTheDocument();
});
