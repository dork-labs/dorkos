/**
 * @vitest-environment jsdom
 *
 * The hosted-community dialogs end to end against a mock transport: what each
 * press sends, what comes back on screen, and where the one-time claim link is
 * allowed to go (the link seam, and nowhere else).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { CloudCommunityMove } from '@dorkos/shared/cloud-schemas';
import startFixture from '@dork-labs/cloud-api/fixtures/v1/communities/start.json' with { type: 'json' };
import moveImportingFixture from '@dork-labs/cloud-api/fixtures/v1/communities/move-importing.json' with { type: 'json' };
import nameTakenProblem from '@dork-labs/cloud-api/fixtures/v1/problem/community-name-taken.json' with { type: 'json' };
import { TransportProvider } from '@/layers/shared/model';
import { CommunityHostingDialogs, type CommunityHostingDialog } from '../index';

const mockOpenExternalLink = vi.fn((_href: string) => true);
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openExternalLink: (href: string) => mockOpenExternalLink(href),
}));
vi.mock('@/layers/entities/community', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/community')>()),
  useConfirmedCommunityAuthority: () => ({ ownerKey: 'owner', epoch: 1 }),
  withinCommunityAuthority: (_authority: unknown, run: () => unknown) => run(),
}));
vi.mock('@/layers/shared/lib/community-authority-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/community-authority-state')>()),
  isCommunityAuthorityCurrent: () => true,
}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CLAIM_URL = startFixture.claim.claimUrl;
const community = startFixture.community;

function renderDialogs(transport: Transport, dialog: CommunityHostingDialog) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onConnected = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <CommunityHostingDialogs
          entry={{ allowance: null, unfinishedMoveId: null, hasHosted: false, attentionCount: 0 }}
          dialog={dialog}
          onDialogChange={vi.fn()}
          installName="My DorkOS"
          onConnected={onConnected}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { client, onConnected };
}

function linkedTransport(): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getCloudStatus).mockResolvedValue({
    linked: true,
    accountLabel: null,
    lastHeartbeatAt: null,
  });
  vi.mocked(transport.checkHostedCommunityName).mockImplementation(async (name) => ({
    available: true,
    check: { name, available: true, reason: null },
  }));
  return transport;
}

describe('Start a community', () => {
  // Purpose: the whole happy path, and the claim link's only route. Fails if
  // the link is kept in the query cache, or if connecting uses anything but
  // the returned canonical link.
  it('starts, opens the claim link once, then connects with the community’s own link', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunity).mockResolvedValue({
      ok: true,
      community: community as never,
      claimReady: true,
    });
    vi.mocked(transport.listHostedCommunities).mockResolvedValue({
      available: true,
      communities: [community as never],
      moves: [],
      allowance: null,
    });
    vi.mocked(transport.getHostedCommunityClaimLink).mockResolvedValue({
      ok: true,
      claimUrl: CLAIM_URL,
      expiresAt: startFixture.claim.expiresAt,
    });
    const { client, onConnected } = renderDialogs(transport, { kind: 'start' });

    fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'Night shift' } });
    fireEvent.change(screen.getByLabelText(/Web address/), { target: { value: 'Night-Shift' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start community' }));
    await screen.findByRole('heading', { name: 'Make Night shift yours' });
    expect(transport.startHostedCommunity).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      name: 'Night shift',
      shortName: 'night-shift',
    });

    fireEvent.click(screen.getByRole('button', { name: /Open in your browser/ }));
    await waitFor(() => expect(mockOpenExternalLink).toHaveBeenCalledWith(CLAIM_URL));
    const cached = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data)
    );
    expect(cached).not.toContain(CLAIM_URL);
    expect(document.body.innerHTML).not.toContain(CLAIM_URL);

    // Claimed: the service now reports the community active.
    vi.mocked(transport.listHostedCommunities).mockResolvedValue({
      available: true,
      communities: [{ ...community, state: 'active' } as never],
      moves: [],
      allowance: null,
    });
    vi.mocked(transport.startCommunityConnection).mockResolvedValue({
      connection: { ref: 'ref-1' } as never,
      approvalUrl: 'https://community.example.invalid/approve/abc',
    });
    vi.mocked(transport.pollCommunityConnection).mockResolvedValue({
      connection: null,
      status: 'connected',
    });
    fireEvent.click(screen.getByRole('button', { name: 'I’ve finished' }));
    await screen.findByRole('heading', { name: 'Night shift is ready' });
    expect(transport.startCommunityConnection).toHaveBeenCalledWith({
      url: community.communityUrl,
      installName: 'My DorkOS',
    });
    expect(onConnected).toHaveBeenCalledWith('ref-1');
  });

  it('does not move on while the sign-in is unfinished', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunity).mockResolvedValue({
      ok: true,
      community: community as never,
      claimReady: true,
    });
    vi.mocked(transport.listHostedCommunities).mockResolvedValue({
      available: true,
      communities: [community as never],
      moves: [],
      allowance: null,
    });
    renderDialogs(transport, { kind: 'start' });
    fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'Night shift' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start community' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I’ve finished' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your sign-in isn’t finished yet.');
    expect(transport.startCommunityConnection).not.toHaveBeenCalled();
  });

  it('puts a taken web address on the field and keeps what was typed', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunity).mockResolvedValue({
      ok: false,
      problem: nameTakenProblem as never,
    });
    renderDialogs(transport, { kind: 'start' });
    fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(/Web address/), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start community' }));
    expect(await screen.findByText('That web address is taken.')).toBeInTheDocument();
    expect(screen.getByLabelText('Community name')).toHaveValue('Acme');
  });

  it('says the account could not be reached, and keeps the form', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunity).mockRejectedValue(new Error('offline'));
    renderDialogs(transport, { kind: 'start' });
    fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start community' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t reach your DorkOS account. Try again.'
    );
    expect(screen.getByLabelText('Community name')).toHaveValue('Acme');
  });
});

describe('Move a community here', () => {
  const importing = { ...(moveImportingFixture as unknown as CloudCommunityMove), upload: null };

  it('sends the file, then follows the move as the service reports it', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunityMove).mockResolvedValue({ ok: true, move: importing });
    vi.mocked(transport.getHostedCommunityMove).mockResolvedValue({
      available: true,
      move: importing,
    });
    renderDialogs(transport, { kind: 'move', moveId: null });

    fireEvent.click(screen.getByRole('button', { name: 'I have the file' }));
    const file = new File(['PK export'], 'old-garden.zip', { type: 'application/zip' });
    fireEvent.change(screen.getByLabelText('Export file'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'Old garden' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start moving' }));

    await screen.findByRole('heading', { name: 'Moving Old garden' });
    expect(transport.startHostedCommunityMove).toHaveBeenCalledWith(
      file,
      { idempotencyKey: expect.any(String), name: 'Old garden' },
      expect.any(Function),
      expect.any(AbortSignal)
    );
  });

  // Purpose: a move survives a reload because it is read from the service,
  // not remembered here. Fails if resuming needs anything but the move id.
  it('picks up an unfinished move from its id alone, and shows its failure', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.getHostedCommunityMove).mockResolvedValue({
      available: true,
      move: { ...importing, state: 'failed', failureCode: 'not_owner_export', pollAfterMs: null },
    });
    renderDialogs(transport, { kind: 'move', moveId: importing.moveId });
    expect(
      await screen.findByRole('heading', {
        name: 'This file is a personal export, not an owner export.',
      })
    ).toBeInTheDocument();
    expect(transport.getHostedCommunityMove).toHaveBeenCalledWith(importing.moveId);
  });

  it('cancels a move that is still importing', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.getHostedCommunityMove).mockResolvedValue({
      available: true,
      move: importing,
    });
    vi.mocked(transport.cancelHostedCommunityMove).mockResolvedValue({
      ok: true,
      move: { ...importing, state: 'cancelled', pollAfterMs: null },
    });
    renderDialogs(transport, { kind: 'move', moveId: importing.moveId });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel move' }));
    expect(await screen.findByRole('heading', { name: 'Move cancelled' })).toBeInTheDocument();
    expect(transport.cancelHostedCommunityMove).toHaveBeenCalledWith(importing.moveId);
  });
});
