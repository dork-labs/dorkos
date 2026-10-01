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
import type { Problem } from '@dork-labs/cloud-api';
import type { CloudCommunityMove } from '@dorkos/shared/cloud-schemas';
import startFixture from '@dork-labs/cloud-api/fixtures/v1/communities/start.json' with { type: 'json' };
import moveImportingFixture from '@dork-labs/cloud-api/fixtures/v1/communities/move-importing.json' with { type: 'json' };
import nameTakenProblem from '@dork-labs/cloud-api/fixtures/v1/problem/community-name-taken.json' with { type: 'json' };
import { TransportProvider } from '@/layers/shared/model';
import { CommunityHostingDialogs, type CommunityHostingDialog } from '../index';

const mockOpenExternalLink = vi.fn((_href: string) => true);
const mockWindowGo = vi.fn((_href: string) => true);
const mockWindowClose = vi.fn();
let mockPopupBlocked = false;
const mockOpenLater = vi.fn(() =>
  mockPopupBlocked ? null : { go: mockWindowGo, close: mockWindowClose }
);
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openExternalLink: (href: string) => mockOpenExternalLink(href),
  openExternalWindowLater: () => mockOpenLater(),
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
  mockPopupBlocked = false;
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
          entry={{ allowance: null, unfinishedMoveId: null, hasHosted: false }}
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
    // The window opens in the press itself, before the link is fetched.
    expect(mockOpenLater).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockWindowGo).toHaveBeenCalledWith(CLAIM_URL));
    expect(mockOpenExternalLink).not.toHaveBeenCalledWith(CLAIM_URL);
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

  // Purpose: a blocked window must not be reported as opened, and must not
  // spend a claim link. Fails if the link is fetched anyway.
  it('says so when the browser blocks the window, and fetches nothing', async () => {
    mockPopupBlocked = true;
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
    fireEvent.click(await screen.findByRole('button', { name: /Open in your browser/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your browser blocked the new window.'
    );
    expect(transport.getHostedCommunityClaimLink).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Open in your browser/ })).toBeInTheDocument();
  });

  it('closes the waiting window when the claim link is refused', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunity).mockResolvedValue({
      ok: true,
      community: community as never,
      claimReady: false,
    });
    vi.mocked(transport.listHostedCommunities).mockResolvedValue({
      available: true,
      communities: [community as never],
      moves: [],
      allowance: null,
    });
    vi.mocked(transport.getHostedCommunityClaimLink).mockResolvedValue({
      ok: false,
      problem: { code: 'conflict', status: 409, title: 'Not waiting for an owner.' } as never,
    });
    renderDialogs(transport, { kind: 'start' });
    fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'Night shift' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start community' }));
    fireEvent.click(await screen.findByRole('button', { name: /Open in your browser/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not waiting for an owner.');
    expect(mockWindowClose).toHaveBeenCalled();
    expect(mockWindowGo).not.toHaveBeenCalled();
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

  /** Choose `file`, name the community and press Start moving. */
  function startMoving(file: File) {
    fireEvent.click(screen.getByRole('button', { name: 'I have the file' }));
    fireEvent.change(screen.getByLabelText('Export file'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Community name'), { target: { value: 'Old garden' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start moving' }));
  }

  // Purpose (DOR-2610): a file that won't fit on this computer is refused
  // before a byte is sent, with the server's own words and numbers. Fails if
  // the app uploads first, or asks about any size but the file's.
  it('asks whether the file fits first, and sends nothing when it does not', async () => {
    const transport = linkedTransport();
    const noRoom =
      'This computer doesn’t have room to hold the export. It needs 2.1 GB free and has 1.4 GB. Free up some space, then try again.';
    vi.mocked(transport.checkHostedCommunityMoveRoom).mockResolvedValue({
      ok: false,
      message: noRoom,
    });
    renderDialogs(transport, { kind: 'move', moveId: null });
    const file = new File(['PK export'], 'old-garden.zip', { type: 'application/zip' });
    startMoving(file);

    expect(await screen.findByText(noRoom)).toBeInTheDocument();
    expect(transport.checkHostedCommunityMoveRoom).toHaveBeenCalledWith(
      file.size,
      expect.any(AbortSignal)
    );
    expect(transport.startHostedCommunityMove).not.toHaveBeenCalled();
  });

  // Purpose (DOR-2611): after a refusal that left no move (here, too big for
  // the new host, which cancelled the move it had just made), pressing Start
  // again with the same file and name must make a fresh move and hear the
  // reason again, not replay the cancelled one. Fails if the key is reused.
  it('starts afresh after a refusal, instead of replaying the refused move', async () => {
    const transport = linkedTransport();
    const tooLarge =
      'This export is too large for the new host. It is 9 bytes, and the most the host takes is 8 bytes.';
    vi.mocked(transport.startHostedCommunityMove).mockResolvedValue({
      ok: false,
      message: tooLarge,
    });
    renderDialogs(transport, { kind: 'move', moveId: null });
    startMoving(new File(['PK export'], 'old-garden.zip', { type: 'application/zip' }));
    expect(await screen.findByText(tooLarge)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start moving' }));
    await waitFor(() => expect(transport.startHostedCommunityMove).toHaveBeenCalledTimes(2));
    const [first, second] = vi
      .mocked(transport.startHostedCommunityMove)
      .mock.calls.map((call) => call[1].idempotencyKey);
    expect(second).not.toBe(first);
  });

  /** The idempotency keys every start has sent, in order. */
  function sentKeys(transport: Transport) {
    return vi
      .mocked(transport.startHostedCommunityMove)
      .mock.calls.map((call) => call[1].idempotencyKey);
  }

  // Purpose (DOR-2611): "Start again" after a move was cancelled (or failed)
  // must make a new move. Fails if the key of the finished move is reused:
  // the service would replay it and the app would show the same end again.
  it('starts a new move after Start again on a cancelled move', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunityMove).mockResolvedValue({ ok: true, move: importing });
    vi.mocked(transport.getHostedCommunityMove).mockResolvedValue({
      available: true,
      move: { ...importing, state: 'cancelled', pollAfterMs: null },
    });
    renderDialogs(transport, { kind: 'move', moveId: null });
    startMoving(new File(['PK export'], 'old-garden.zip', { type: 'application/zip' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start moving' }));

    await waitFor(() => expect(transport.startHostedCommunityMove).toHaveBeenCalledTimes(2));
    const [first, second] = sentKeys(transport);
    expect(second).not.toBe(first);
  });

  // Purpose (DOR-2611): a cancel while the file is going up leaves no move (the
  // local server cancels one whose browser left), so the next Start must not
  // replay it. Fails if a cancelled send keeps the key.
  it('starts a new move after the person cancels the upload', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunityMove).mockImplementationOnce(
      (_file, _input, _progress, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('Upload canceled')))
        )
    );
    vi.mocked(transport.startHostedCommunityMove).mockResolvedValueOnce({
      ok: false,
      message: 'That file is empty. Choose the export you saved.',
    });
    renderDialogs(transport, { kind: 'move', moveId: null });
    startMoving(new File(['PK export'], 'old-garden.zip', { type: 'application/zip' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start moving' }));

    await waitFor(() => expect(transport.startHostedCommunityMove).toHaveBeenCalledTimes(2));
    const [first, second] = sentKeys(transport);
    expect(second).not.toBe(first);
  });

  // Purpose (DOR-2610): pressing Cancel while the app is still asking about
  // room stops everything quietly. Fails if a refusal that arrives after the
  // cancel is shown, or the file is sent anyway.
  it('says nothing and sends nothing when cancelled during the room check', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.checkHostedCommunityMoveRoom).mockImplementation(
      (_bytes, signal) =>
        new Promise((resolve) =>
          signal?.addEventListener('abort', () =>
            resolve({ ok: false, message: 'This computer doesn’t have room to hold the export.' })
          )
        )
    );
    renderDialogs(transport, { kind: 'move', moveId: null });
    startMoving(new File(['PK export'], 'old-garden.zip', { type: 'application/zip' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await screen.findByRole('button', { name: 'Start moving' });
    expect(screen.queryByText(/doesn’t have room/)).not.toBeInTheDocument();
    expect(transport.startHostedCommunityMove).not.toHaveBeenCalled();
  });

  // Purpose (DOR-2611): a refusal marked `mayExist` (the account could not be
  // reached, answered with a server error, or a cancel did not go through)
  // may have left a move, so starting again must reuse the key and pick it up
  // rather than make a second one. Fails if every refusal resets the key.
  it('keeps the same key when the refusal says the move may exist', async () => {
    const transport = linkedTransport();
    const unavailable = {
      code: 'temporarily_unavailable',
      status: 503,
      title: 'Try again shortly.',
    };
    vi.mocked(transport.startHostedCommunityMove)
      .mockResolvedValueOnce({
        ok: false,
        message: 'Couldn’t reach your DorkOS account. Try again.',
        mayExist: true,
      })
      .mockResolvedValueOnce({
        ok: false,
        problem: unavailable as Problem,
        mayExist: true,
      })
      .mockResolvedValue({ ok: false, message: 'The file didn’t arrive. Try again.' });
    renderDialogs(transport, { kind: 'move', moveId: null });
    startMoving(new File(['PK export'], 'old-garden.zip', { type: 'application/zip' }));
    await screen.findByText('Couldn’t reach your DorkOS account. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Start moving' }));
    await waitFor(() => expect(transport.startHostedCommunityMove).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'Start moving' }));
    await waitFor(() => expect(transport.startHostedCommunityMove).toHaveBeenCalledTimes(3));

    const [first, second, third] = sentKeys(transport);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  // Purpose (DOR-2611): a send that broke or went silent (not a cancel) never
  // heard back, so the move may exist; the next Start must reuse the key.
  // Fails if the catch clears the key for anything but a cancel.
  it('keeps the same key when the send breaks without a cancel', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.startHostedCommunityMove)
      .mockRejectedValueOnce(new Error('Upload failed'))
      .mockResolvedValue({ ok: false, message: 'The file didn’t arrive. Try again.' });
    renderDialogs(transport, { kind: 'move', moveId: null });
    startMoving(new File(['PK export'], 'old-garden.zip', { type: 'application/zip' }));
    await screen.findByText('Couldn’t reach your DorkOS account. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Start moving' }));
    await waitFor(() => expect(transport.startHostedCommunityMove).toHaveBeenCalledTimes(2));

    const [first, second] = sentKeys(transport);
    expect(second).toBe(first);
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
