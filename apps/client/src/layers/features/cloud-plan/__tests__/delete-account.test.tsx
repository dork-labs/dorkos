/**
 * @vitest-environment jsdom
 *
 * Deleting the DorkOS account from the app: what goes and what stays, a copy
 * first, a typed word, and honest result states. Asking deletes nothing (the
 * service emails a link), so the app says "check your email" and then watches
 * for the account to stop accepting this computer.
 *
 * Driven by the contract package's own synthetic fixtures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { CloudAccountDeletionResponse } from '@dorkos/shared/cloud-schemas';
import entitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-denominated.json' with { type: 'json' };
import deletionFixture from '@dork-labs/cloud-api/fixtures/v1/session/account-deletion.json' with { type: 'json' };
import conflictFixture from '@dork-labs/cloud-api/fixtures/v1/problem/account-deletion-conflict.json' with { type: 'json' };
import { TransportProvider } from '@/layers/shared/model';
import { cloudStatusKey } from '@/layers/features/cloud-link';
import { DeleteAccount } from '../ui/DeleteAccount';
import { DELETION_CHECK_INTERVAL_MS } from '../model/use-account-deletion';

const mockToastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args) },
}));

const mockOpenExternalLink = vi.fn((_href: string) => true);
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openExternalLink: (href: string) => mockOpenExternalLink(href),
}));

const LINKED = { linked: true, accountLabel: 'kai@example.invalid', lastHeartbeatAt: null };
const UNLINKED = { linked: false, accountLabel: null, lastHeartbeatAt: null };

function renderDelete(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <DeleteAccount />
      </TransportProvider>
    </QueryClientProvider>
  );
  return queryClient;
}

/** A linked account. */
function linkedTransport(): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getCloudPlan).mockResolvedValue({
    available: true,
    entitlements: entitlementsFixture as never,
    balance: null,
  });
  vi.mocked(transport.checkCloudLink).mockResolvedValue(LINKED);
  return transport;
}

/**
 * The fixture's link, with a deadline a day from now: the fixture's own date is
 * fixed, and a link whose deadline has passed reads as expired.
 */
function sentLink(confirmBy: string | null = new Date(Date.now() + 86_400_000).toISOString()) {
  return { ...deletionFixture, confirmBy };
}

const SENT = (): CloudAccountDeletionResponse => ({ ok: true, deletion: sentLink() });

/** Open the dialog and return it. */
async function openDialog() {
  await userEvent.click(await screen.findByRole('button', { name: 'Delete your DorkOS account…' }));
  return screen.findByRole('dialog');
}

/** Type the confirmation word and press the send button. */
async function confirmAndSend(dialog: HTMLElement, word = 'delete') {
  await userEvent.type(within(dialog).getByLabelText(/to confirm/i), word);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Email me the link' }));
}

describe('deleting the DorkOS account', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing, and asks for nothing, with no cloud account', async () => {
    const transport = createMockTransport();
    renderDelete(transport);
    await waitFor(() => expect(transport.getCloudPlan).toHaveBeenCalled());
    expect(screen.queryByText(/delete your dorkos account/i)).not.toBeInTheDocument();
    expect(transport.requestCloudAccountDeletion).not.toHaveBeenCalled();
  });

  it('says what goes and what stays, and offers a copy first', async () => {
    renderDelete(linkedTransport());
    const dialog = await openDialog();
    expect(within(dialog).getByText('Delete your DorkOS account?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Nothing is deleted until you follow the emailed link/)
    ).toBeInTheDocument();
    for (const goes of [/your plan/i, /credits/i, /seats/i]) {
      expect(within(dialog).getByText(goes)).toBeInTheDocument();
    }
    expect(within(dialog).getByText(/everything on this computer/i)).toBeInTheDocument();
    expect(within(dialog).getByText('Want a copy first?')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Export your account data' })
    ).toBeInTheDocument();
  });

  it('puts focus in the confirm field when it opens', async () => {
    renderDelete(linkedTransport());
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getByLabelText(/to confirm/i)).toHaveFocus());
  });

  it.each([
    ['Cancel', () => userEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
    ['Escape', () => userEvent.keyboard('{Escape}')],
  ])('returns focus to the button that opened it on %s', async (_how, close) => {
    renderDelete(linkedTransport());
    await openDialog();
    await close();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete your DorkOS account…' })).toHaveFocus()
    );
  });

  it('sends nothing until the word is typed', async () => {
    const transport = linkedTransport();
    renderDelete(transport);
    const dialog = await openDialog();
    const send = within(dialog).getByRole('button', { name: 'Email me the link' });
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'delet');
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/to confirm/i), '{Enter}');
    expect(transport.requestCloudAccountDeletion).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText(/to confirm/i), 'e');
    expect(send).not.toBeDisabled();
  });

  it('closes on a sent link and says to check the email, never that anything is gone', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue(SENT());
    renderDelete(transport);
    await confirmAndSend(await openDialog());

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Check your email.');
    expect(status).toHaveTextContent(deletionFixture.confirmationSentTo);
    expect(status).toHaveTextContent(/deleted only when you follow it/);
    expect(status).toHaveTextContent(/the link works until/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Focus lands on what happens next, not on the page.
    await waitFor(() => expect(status).toHaveFocus());
    expect(screen.queryByText(/account is deleted\./i)).not.toBeInTheDocument();
    expect(transport.requestCloudAccountDeletion).toHaveBeenCalledTimes(1);

    // A new link is one press away.
    await userEvent.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(transport.requestCloudAccountDeletion).toHaveBeenCalledTimes(2);
  });

  it('leaves out the deadline when the service sets none', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue({
      ok: true,
      deletion: sentLink(null),
    });
    renderDelete(transport);
    await confirmAndSend(await openDialog());
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/deleted only when you follow it\./);
    expect(status).not.toHaveTextContent(/works until/);
  });

  it('shows a refusal in the service`s own words, with its link, and keeps the dialog open', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue({
      ok: false,
      problem: conflictFixture as never,
    });
    renderDelete(transport);
    const dialog = await openDialog();
    await confirmAndSend(dialog);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(conflictFixture.title);
    expect(alert).toHaveTextContent(conflictFixture.detail);
    await userEvent.click(within(alert).getByRole('button', { name: conflictFixture.actionLabel }));
    expect(mockOpenExternalLink).toHaveBeenCalledWith(conflictFixture.actionUrl);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says plainly when the account does not offer deletion from the app yet', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue({
      ok: false,
      message: 'Deleting your account from the app isn’t available on your account yet.',
    });
    renderDelete(transport);
    const dialog = await openDialog();
    await confirmAndSend(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Deleting your account from the app isn’t available on your account yet.'
    );
  });

  it('says the account could not be reached when the request fails', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.requestCloudAccountDeletion).mockRejectedValue(new Error('offline'));
    renderDelete(transport);
    const dialog = await openDialog();
    await confirmAndSend(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Couldn’t reach your DorkOS account. Try again.'
    );
  });

  it('keeps the link that went out when a new one is refused, and says why', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue(SENT());
    renderDelete(transport);
    await confirmAndSend(await openDialog());
    await screen.findByRole('status');

    vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue({
      ok: false,
      problem: {
        code: 'rate_limited',
        status: 429,
        title: 'You asked for a link a moment ago.',
        retryAfterMs: 60_000,
      } as never,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Send a new link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You asked for a link a moment ago.'
    );
    // The first link still stands, and so does the watch on it.
    expect(screen.getByRole('status')).toHaveTextContent('Check your email.');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(transport.checkCloudLink).toHaveBeenCalled());
  });

  it('says the link expired at its deadline, stops watching, and offers a new one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const transport = linkedTransport();
    vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue({
      ok: true,
      deletion: sentLink(new Date(Date.now() + 5 * 60_000).toISOString()),
    });
    renderDelete(transport);
    await confirmAndSend(await openDialog());
    expect(await screen.findByRole('status')).toHaveTextContent('Check your email.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'The link has expired, so nothing was deleted.'
    );
    const checks = vi.mocked(transport.checkCloudLink).mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELETION_CHECK_INTERVAL_MS * 2);
    });
    expect(transport.checkCloudLink).toHaveBeenCalledTimes(checks);

    // A new link works again, and the watch comes back with it.
    vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue(SENT());
    await userEvent.click(screen.getByRole('button', { name: 'Send a new link' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Check your email.'));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(transport.checkCloudLink).toHaveBeenCalledTimes(checks + 1));
  });

  describe('noticing the deletion land', () => {
    it('asks nothing before a link is out', async () => {
      const transport = linkedTransport();
      renderDelete(transport);
      await screen.findByRole('button', { name: 'Delete your DorkOS account…' });
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(transport.checkCloudLink).not.toHaveBeenCalled();
    });

    it('on returning to the window, unlinks the view once the account no longer accepts this computer', async () => {
      const transport = linkedTransport();
      vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue(SENT());
      const cache = renderDelete(transport);
      cache.setQueryData(cloudStatusKey, LINKED);
      await confirmAndSend(await openDialog());
      await screen.findByRole('status');

      // Still accepted: nothing changes, nothing is said.
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(transport.checkCloudLink).toHaveBeenCalledTimes(1));
      expect(mockToastSuccess).not.toHaveBeenCalled();
      expect(cache.getQueryData(cloudStatusKey)).toEqual(LINKED);

      // The person followed the link: the account refuses this computer.
      const planReads = vi.mocked(transport.getCloudPlan).mock.calls.length;
      vi.mocked(transport.checkCloudLink).mockResolvedValue(UNLINKED);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
      expect(mockToastSuccess.mock.calls[0][0]).toBe('This computer is unlinked');
      expect(cache.getQueryData(cloudStatusKey)).toEqual(UNLINKED);
      // The note the server left is cleared, so the panel reads signed out.
      expect(transport.cancelCloudLink).toHaveBeenCalledTimes(1);
      // The account's figures are read again, so the tab drops them.
      await waitFor(() => expect(transport.getCloudPlan).toHaveBeenCalledTimes(planReads + 1));

      // Said once, and the watch is over.
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(transport.checkCloudLink).toHaveBeenCalledTimes(2);
      expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    });

    it('keeps watching when refreshing the account reads fails after a check', async () => {
      const transport = linkedTransport();
      vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue(SENT());
      const cache = renderDelete(transport);
      await confirmAndSend(await openDialog());
      await screen.findByRole('status');

      vi.mocked(transport.checkCloudLink).mockResolvedValue(UNLINKED);
      const invalidate = vi
        .spyOn(cache, 'invalidateQueries')
        .mockRejectedValueOnce(new Error('refetch failed'));
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(invalidate).toHaveBeenCalled());
      const checks = vi.mocked(transport.checkCloudLink).mock.calls.length;
      expect(mockToastSuccess).not.toHaveBeenCalled();

      // The watch is still live: the next return to the window asks again.
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => expect(transport.checkCloudLink).toHaveBeenCalledTimes(checks + 1));
      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
    });

    it('also checks on its own, once a minute, while the link is out', async () => {
      // Real time still passes, so the clicks below run; the minute is skipped.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const transport = linkedTransport();
      vi.mocked(transport.requestCloudAccountDeletion).mockResolvedValue(SENT());
      renderDelete(transport);
      await confirmAndSend(await openDialog());
      await screen.findByRole('status');

      // Focus moving as the dialog closes may already have asked once.
      const before = vi.mocked(transport.checkCloudLink).mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DELETION_CHECK_INTERVAL_MS - 1_000);
      });
      expect(transport.checkCloudLink).toHaveBeenCalledTimes(before);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(transport.checkCloudLink).toHaveBeenCalledTimes(before + 1);
    });
  });
});
