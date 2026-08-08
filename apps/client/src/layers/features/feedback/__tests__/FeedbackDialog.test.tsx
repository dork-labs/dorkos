// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { FeedbackDialog } from '../ui/FeedbackDialog';
import { __resetBreadcrumbsForTests, addBreadcrumb } from '@/layers/shared/lib/breadcrumbs';

// The submit hook reads the current route via useRouterState (pathname + search).
// A mutable object lets a test put us on a session route to exercise the
// Conversation toggle without a second module mock.
const routerState = vi.hoisted(() => ({
  location: { pathname: '/team', search: {} as Record<string, unknown> },
}));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: (opts?: { select?: (s: unknown) => unknown }) =>
    opts?.select ? opts.select(routerState) : undefined,
}));

// Toasts — assert the honest success/error paths without a real toaster.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset the route to the default (non-session) location for the next test.
  routerState.location = { pathname: '/team', search: {} };
});

function renderDialog(
  transport = createMockTransport(),
  props?: { currentUser?: { email: string; name?: string } | null }
) {
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <FeedbackDialog open onOpenChange={onOpenChange} currentUser={props?.currentUser ?? null} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { onOpenChange };
}

describe('FeedbackDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetBreadcrumbsForTests();
  });

  it('sends the submission through the transport, tagged with kind and route', async () => {
    const transport = createMockTransport();
    const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
    const { onOpenChange } = renderDialog(transport);

    fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
      target: { value: 'Love the new sidebar' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
    expect(sendFeedback.mock.calls[0][0]).toMatchObject({
      kind: 'feedback',
      message: 'Love the new sidebar',
      route: '/team',
    });
    // Feedback kind attaches nothing extra by default.
    expect(sendFeedback.mock.calls[0][0].diagnostics).toBeUndefined();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith('Thanks, sent.');
  });

  it('sends the selected kind (Bug)', async () => {
    const transport = createMockTransport();
    const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
    renderDialog(transport);

    fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
    fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
      target: { value: 'It crashed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
    expect(sendFeedback.mock.calls[0][0]).toMatchObject({ kind: 'bug', message: 'It crashed' });
  });

  it('on a failed send, toasts the GitHub-fallback error and keeps the dialog open', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: false });
    const { onOpenChange } = renderDialog(transport);

    fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
      target: { value: 'something' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't send. Try the GitHub option.")
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('disables Send until a message is typed', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('attaches diagnostics + asks for server logs for a Bug (both default-on)', async () => {
    addBreadcrumb('console_error', 'TypeError: boom');
    const transport = createMockTransport();
    const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
    renderDialog(transport);

    // Diagnostics reads the config query synchronously at submit time, so let
    // it resolve before interacting.
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    await act(async () => {});

    fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
    fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
      target: { value: 'It crashed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
    const submitted = sendFeedback.mock.calls[0][0];
    expect(submitted.diagnostics?.clientReport).toMatchObject({
      version: '1.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code'],
    });
    expect(submitted.diagnostics?.breadcrumbs).toEqual([
      expect.objectContaining({ kind: 'console_error', message: 'TypeError: boom' }),
    ]);
    // Bug + diagnostics on → the client asks the server to gather a log excerpt.
    expect(submitted.includeServerLogs).toBe(true);
    // The client never sends the transcript or a screenshot itself.
    expect(submitted.transcriptExcerpt).toBeUndefined();
    expect(submitted.screenshotUploadId).toBeUndefined();
    // No session in context → no conversation attachment.
    expect(submitted.includeTranscript).toBeUndefined();
    expect(submitted.sessionId).toBeUndefined();
  });

  it('does NOT attach diagnostics for a non-bug submission', async () => {
    const transport = createMockTransport();
    const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
    renderDialog(transport);

    fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
      target: { value: 'Love the new sidebar' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
    expect(sendFeedback.mock.calls[0][0].diagnostics).toBeUndefined();
    expect(sendFeedback.mock.calls[0][0].includeServerLogs).toBeUndefined();
  });

  describe('identity + anonymous (design-decisions §3)', () => {
    it('shows the identity line only when a signed-in user is resolvable', () => {
      renderDialog(createMockTransport(), { currentUser: { email: 'dorian@example.com' } });
      expect(screen.getByText('Sending as dorian@example.com')).toBeInTheDocument();
    });

    it('does not show an identity line when signed out', () => {
      renderDialog(createMockTransport(), { currentUser: null });
      expect(screen.queryByText(/Sending as/)).not.toBeInTheDocument();
    });

    it('sends anonymous:true after toggling "Send anonymously", and back off with "Use my account"', async () => {
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport, { currentUser: { email: 'dorian@example.com' } });

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'hi' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send anonymously' }));
      expect(screen.getByText('Sending anonymously')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      expect(sendFeedback.mock.calls[0][0].anonymous).toBe(true);
    });

    it('does not set anonymous when the toggle is left off', async () => {
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport, { currentUser: { email: 'dorian@example.com' } });

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'hi' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      expect(sendFeedback.mock.calls[0][0].anonymous).toBeUndefined();
    });
  });

  describe('conversation attachment (only on a session route)', () => {
    it('offers a Conversation toggle and attaches the session transcript for a Bug', async () => {
      routerState.location = { pathname: '/session', search: { session: 'sess_1' } };
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
      fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
        target: { value: 'It crashed' },
      });
      // Expand the collapsed Attachments & details panel to reach the toggles.
      fireEvent.click(screen.getByRole('button', { name: /attachments & details/i }));
      // The Conversation toggle exists on a session route.
      expect(screen.getByLabelText('Conversation')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      expect(sendFeedback.mock.calls[0][0]).toMatchObject({
        sessionId: 'sess_1',
        includeTranscript: true,
      });
    });

    it('has no Conversation toggle off a session route', () => {
      renderDialog();
      expect(screen.queryByLabelText('Conversation')).not.toBeInTheDocument();
    });
  });
});
