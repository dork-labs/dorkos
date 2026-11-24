// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { REPLY_EMAIL_STORAGE_KEY } from '../lib/reply-email';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { FeedbackDialog } from '../ui/FeedbackDialog';
import { __resetBreadcrumbsForTests, addBreadcrumb } from '@/layers/shared/lib/breadcrumbs';

import { ImageCompressError } from '@/layers/shared/lib/image-compress';
import { AppCaptureError } from '@/layers/shared/lib/app-capture';

// The submit hook reads the current route via useRouterState (pathname, the
// parsed search, and the serialized `searchStr`). A mutable object lets a test
// put us on a session route to exercise the Conversation toggle without a second
// module mock.
const routerState = vi.hoisted(() => ({
  location: { pathname: '/team', search: {} as Record<string, unknown> },
}));
// The thank-you toast's "Your reports" action navigates; this is where it goes.
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
  useRouterState: (opts?: { select?: (s: unknown) => unknown }) => {
    // `searchStr` is DERIVED from `search` here, exactly as the real router
    // derives it, rather than being a third field a test has to remember to set.
    // Setting only one of the two is how a mock starts describing a location the
    // router could never produce — a pathname with query params that the
    // serialized string does not contain.
    const query = new URLSearchParams(
      Object.entries(routerState.location.search).map(([key, value]) => [key, String(value)])
    ).toString();
    const state = {
      location: { ...routerState.location, searchStr: query ? `?${query}` : '' },
    };
    return opts?.select ? opts.select(state) : undefined;
  },
}));

// Toasts — assert the honest success/error paths without a real toaster.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// Compression needs a canvas raster backend jsdom does not have, so the encode
// step is a controllable stub. `ImageCompressError` stays REAL, so the mapping
// from a refusal's reason to what the user is told is exercised for real.
const compressImage = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/lib/image-compress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/image-compress')>()),
  compressImage,
}));

// Same for the one-click capture: neither engine behind it runs in jsdom (no
// compositor, no rasterizer), so what it produces is a stub. `AppCaptureError`
// stays REAL, so the mapping from a refusal's reason to what the user is told is
// exercised for real — the capture's own behaviour is covered next door in
// `shared/lib/__tests__/app-capture.test.ts`.
const captureAppView = vi.hoisted(() => vi.fn());
const captureAppShot = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/lib/app-capture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/app-capture')>()),
  captureAppView,
  captureAppShot,
}));

// And the crop on the end of the pointing gesture. Its arithmetic is pure and
// is checked exhaustively in `element-crop.test.ts`; the DRAWING needs an image
// decoder and a 2d canvas context, neither of which jsdom has, so what it
// produces is a stub here. What this file is for is the round trip either side
// of it: the dialog stepping aside, what comes back, and what survives.
const cropShotToElement = vi.hoisted(() => vi.fn());
vi.mock('../lib/element-crop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/element-crop')>()),
  cropShotToElement,
}));

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
  // A remembered reply address must not leak from one test into the next.
  localStorage.clear();
});

function renderDialog(
  transport = createMockTransport(),
  props?: {
    currentUser?: { email: string; name?: string } | null;
    initialScreenshotDataUrl?: string;
    /** A crash stack trace, as the crash screen hands one in. */
    crashStack?: string;
    initialKind?: 'feedback' | 'bug' | 'idea';
    prefillMessage?: string;
    /**
     * Mount closed, so the caller can drive the closed -> open transition the
     * real host always drives. The prefill props are read on that transition.
     */
    startClosed?: boolean;
  }
) {
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // `TooltipProvider` is mounted once in `App.tsx`; the toolbar's tooltips need it.
  const ui = (open: boolean, overrides: { prefillMessage?: string; crashStack?: string } = {}) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <FeedbackDialog
            open={open}
            onOpenChange={onOpenChange}
            currentUser={props?.currentUser ?? null}
            initialScreenshotDataUrl={props?.initialScreenshotDataUrl}
            initialKind={props?.initialKind}
            prefillMessage={overrides.prefillMessage ?? props?.prefillMessage}
            // An open-time override (the crash screen's handoff) wins; the
            // mount-time prop is DOR-2230's way of handing one in.
            crashStack={overrides.crashStack ?? props?.crashStack}
          />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(ui(!props?.startClosed));
  return {
    onOpenChange,
    setOpen: (open: boolean, overrides?: { prefillMessage?: string; crashStack?: string }) =>
      rerender(ui(open, overrides)),
  };
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
    expect(toast.success).toHaveBeenCalledWith(
      'Sent. Thank you.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Your reports' }) })
    );
  });

  describe('the composer form (DOR-2232)', () => {
    /** Type into the message box, whatever it is currently asking. */
    function type(value: string): void {
      fireEvent.change(screen.getByLabelText('Your message'), { target: { value } });
    }

    describe('sending from the keyboard', () => {
      it.each([
        ['⌘↵', { metaKey: true }],
        ['Ctrl+↵', { ctrlKey: true }],
      ])('sends on %s', async (_label, modifier) => {
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        renderDialog(transport);
        type('quick one');

        fireEvent.keyDown(screen.getByLabelText('Your message'), { key: 'Enter', ...modifier });

        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      });

      it('leaves a plain Enter to the message box, for a new line', async () => {
        const transport = createMockTransport();
        renderDialog(transport);
        type('line one');

        fireEvent.keyDown(screen.getByLabelText('Your message'), { key: 'Enter' });

        await act(async () => {});
        expect(transport.sendFeedback).not.toHaveBeenCalled();
      });
    });

    describe('the draft survives an accidental close', () => {
      it('keeps the words, the kind and the chips when the dialog is reopened', () => {
        const { setOpen } = renderDialog();
        fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
        fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
        type('half written');

        setOpen(false);
        setOpen(true);

        expect(screen.getByLabelText('Your message')).toHaveValue('half written');
        expect(screen.getByRole('radio', { name: 'Bug' })).toBeChecked();
        expect(screen.getByRole('button', { name: 'Diagnostics' })).toHaveAttribute(
          'aria-pressed',
          'false'
        );
      });

      it('starts over once the report has gone', async () => {
        const transport = createMockTransport();
        vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        const { setOpen } = renderDialog(transport);
        type('sent already');
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(transport.sendFeedback).toHaveBeenCalledTimes(1));

        setOpen(false);
        setOpen(true);

        expect(screen.getByLabelText('Your message')).toHaveValue('');
      });

      it('keeps the draft after a send that failed', async () => {
        const transport = createMockTransport();
        vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: false });
        renderDialog(transport);
        type('try me again');
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalled());

        expect(screen.getByLabelText('Your message')).toHaveValue('try me again');
      });
    });

    describe('who we can reply to', () => {
      it('asks a signed-out reporter for an email, and sends it as the contact', async () => {
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        renderDialog(transport, { currentUser: null });
        type('no account here');

        fireEvent.change(screen.getByLabelText('Your email'), {
          target: { value: ' ike@example.com ' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].contact).toBe('ike@example.com');
        expect(toast.success).toHaveBeenCalledWith(
          'Sent. Thank you.',
          expect.objectContaining({
            description: 'DorkOS emails ike@example.com when the team acts on it.',
          })
        );
      });

      it('shows no email field to a signed-in reporter, and sends no contact', async () => {
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        renderDialog(transport, { currentUser: { email: 'kai@example.com' } });

        expect(screen.queryByLabelText('Your email')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
        type('signed in');
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].contact).toBeUndefined();
        expect(toast.success).toHaveBeenCalledWith(
          'Sent. Thank you.',
          expect.objectContaining({ description: 'DorkOS emails kai@example.com when it’s fixed.' })
        );
      });

      it('remembers the address for next time', async () => {
        const transport = createMockTransport();
        vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        renderDialog(transport, { currentUser: null });
        type('first report');
        fireEvent.change(screen.getByLabelText('Your email'), {
          target: { value: 'ike@example.com' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(transport.sendFeedback).toHaveBeenCalledTimes(1));
        cleanup();

        renderDialog(createMockTransport(), { currentUser: null });

        expect(localStorage.getItem(REPLY_EMAIL_STORAGE_KEY)).toBe('ike@example.com');
        expect(screen.getByLabelText('Your email')).toHaveValue('ike@example.com');
      });
    });

    describe('after it is sent', () => {
      it('catches the same report sent twice within a minute', async () => {
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        const { setOpen, onOpenChange } = renderDialog(transport);
        type('the list is blank');
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));

        setOpen(false);
        setOpen(true);
        type('the list is blank');
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Already sent a moment ago.'));
        expect(sendFeedback).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
      });
    });

    describe('review fixes', () => {
      it('does not send on ⌘↵ while an input method is composing', async () => {
        const transport = createMockTransport();
        renderDialog(transport);
        type('日本語');

        fireEvent.keyDown(screen.getByLabelText('Your message'), {
          key: 'Enter',
          metaKey: true,
          isComposing: true,
        });

        await act(async () => {});
        expect(transport.sendFeedback).not.toHaveBeenCalled();
      });

      it('keeps the crash stack when a crash report is closed and reopened', async () => {
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        const { setOpen } = renderDialog(transport, { startClosed: true });
        await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
        await act(async () => {});
        setOpen(true, { prefillMessage: 'The app crashed.', crashStack: 'Error: boom\n  at x' });

        // The host clears its prefill on close, so the reopen carries nothing.
        setOpen(false);
        setOpen(true);
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].diagnostics?.breadcrumbs).toEqual([
          expect.objectContaining({ message: 'Error: boom\n  at x' }),
        ]);
      });

      it('does not let Enter in the email field submit the form', () => {
        renderDialog(createMockTransport(), { currentUser: null });
        type('half done');

        const notPrevented = fireEvent.keyDown(screen.getByLabelText('Your email'), {
          key: 'Enter',
        });

        // `fireEvent` answers false when the default action (implicit form
        // submission) was prevented.
        expect(notPrevented).toBe(false);
      });

      it('focuses the message when it opens on a desktop', async () => {
        renderDialog();
        await waitFor(() => expect(screen.getByLabelText('Your message')).toHaveFocus());
      });
    });

    it('opens a prefilled GitHub issue from the footer, as a feature request for an idea', () => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      try {
        renderDialog();
        fireEvent.click(screen.getByRole('radio', { name: 'Idea' }));

        fireEvent.click(screen.getByRole('button', { name: 'Open one instead' }));

        expect(open).toHaveBeenCalledTimes(1);
        const url = String(open.mock.calls[0][0]);
        expect(url).toContain('github.com/dork-labs/dorkos/issues/new');
        expect(url).toContain('enhancement');
      } finally {
        open.mockRestore();
      }
    });
  });

  describe('triage context (DOR-1960)', () => {
    /** Type the message and press Send, returning the submission that went out. */
    async function sendAndCapture(transport = createMockTransport()) {
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      return sendFeedback.mock.calls[0][0];
    }

    it('records the page AND its query string, not just the pathname', async () => {
      // `/session` alone does not say WHICH conversation broke, which is the
      // whole reason a route is recorded. The query half is the identifying half.
      routerState.location = { pathname: '/session', search: { session: 'sess_abc123' } };
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'the composer froze' },
      });
      const submission = await sendAndCapture(transport);

      expect(submission.route).toBe('/session?session=sess_abc123');
      expect(sendFeedback).toHaveBeenCalledTimes(1);
    });

    it('never sends the working directory or the typed prompt in the route', async () => {
      // End-to-end through the real dialog and hook, because this is the leak
      // that matters: `router.tsx` writes the resolved absolute cwd into `?dir=`
      // on every /session navigation, and `route` rides OUTSIDE the Diagnostics
      // toggle. Asserted over the whole serialized submission, not just `route`.
      routerState.location = {
        pathname: '/session',
        search: {
          dir: '/Users/dorian/clients/acme',
          prompt: 'refactor my billing code',
          session: 'sess_abc123',
        },
      };
      const transport = createMockTransport();
      renderDialog(transport);

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'broke' },
      });
      const submission = await sendAndCapture(transport);

      expect(submission.route).toBe('/session?session=sess_abc123');
      const wire = JSON.stringify(submission);
      expect(wire).not.toContain('/Users/dorian');
      expect(wire).not.toContain('billing');
    });

    it('scrubs a crash stack like every other breadcrumb before it is sent (DOR-2230)', async () => {
      // A stack trace names files by their full path, home directory and all,
      // and it rides in the diagnostics beside the collected breadcrumbs — but
      // it is added here, not through `addBreadcrumb`, so it needs the scrub
      // explicitly.
      const transport = createMockTransport();
      const { setOpen } = renderDialog(transport, {
        startClosed: true,
        crashStack:
          'TypeError: boom\n    at render (/Users/someone/app/src/view.tsx:3:9) token=abc123secret',
      });
      setOpen(true);
      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'it crashed' },
      });

      const crumbs = (await sendAndCapture(transport)).diagnostics?.breadcrumbs ?? [];
      const stack = crumbs[crumbs.length - 1]?.message ?? '';

      expect(stack).toContain('TypeError: boom');
      expect(stack).toContain('~/app/src/view.tsx');
      expect(stack).not.toContain('/Users/someone');
      expect(stack).not.toContain('abc123secret');
    });

    it('attaches the window, browser, shell, theme, locale and timezone with diagnostics on', async () => {
      const transport = createMockTransport();
      renderDialog(transport);
      fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'the sidebar overlaps' },
      });

      const report = (await sendAndCapture(transport)).diagnostics?.clientReport;

      // jsdom's own window/navigator are the environment under test here, so
      // these are asserted as shapes rather than as this machine's literals.
      expect(report?.viewport).toEqual({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      });
      expect(report?.browser).toBe(navigator.userAgent);
      expect(report?.shell).toBe('browser');
      expect(report?.theme).toBe('light');
      expect(report?.locale).toBe(navigator.language);
      expect(report?.timezone).toEqual(expect.any(String));
    });

    it('sends none of it when the Diagnostics toggle is off', async () => {
      // The consent contract: these fields ride INSIDE the gated bundle, so
      // switching the toggle off must take every one of them with it — not
      // leave a viewport or a user agent riding along outside the gate.
      const transport = createMockTransport();
      renderDialog(transport);
      fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
      // A bug report turns diagnostics ON by default; switch it back off.
      fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
      expect(screen.getByRole('button', { name: 'Diagnostics' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
        target: { value: 'it broke' },
      });

      const submission = await sendAndCapture(transport);

      expect(submission.diagnostics).toBeUndefined();
      // Asserted over the WHOLE serialized submission, not field by field: a
      // field-by-field check only rules out the names it happens to list, while
      // this rules out the values reaching the wire by any route at all.
      const wire = JSON.stringify(submission);
      expect(wire).not.toContain(navigator.userAgent);
      expect(wire).not.toContain(String(window.innerWidth));
      expect(wire).not.toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
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
      expect(toast.error).toHaveBeenCalledWith(
        'Couldn’t send. Your words are still here. Try again or open a GitHub issue.'
      )
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('disables Send until a message is typed', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('scrolls the form body independently of the footer, so Send stays reachable (DOR-2076)', () => {
    // jsdom reports every box as 0×0 (testing.md), so the real "does it fit on
    // a short screen" claim is only settled by the Playwright screenshots this
    // ticket's browser pass took. What a unit test CAN pin is the structural
    // contract that makes that possible: the form fields sit inside the one
    // scrolling region (`ResponsiveDialogBody`, `overflow-y-auto`), and the
    // Send button sits outside it, in the fixed footer — so growing the fields
    // (thumbnails in the message box, the email field)
    // scrolls the fields and never pushes Send off screen. Reverting the
    // ResponsiveDialogBody wrapper back to a plain `<form>` div turns this red.
    renderDialog();

    const scrollRegion = screen
      .getByPlaceholderText(/what works, what does not/i)
      .closest('[data-slot="responsive-dialog-body"]');
    expect(scrollRegion).not.toBeNull();
    expect(scrollRegion).toHaveClass('overflow-y-auto');

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(scrollRegion).not.toContainElement(sendButton);
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
    expect(submitted.screenshot).toBeUndefined();
    // No session in context → no conversation attachment.
    expect(submitted.includeTranscript).toBeUndefined();
    expect(submitted.sessionId).toBeUndefined();
  });

  describe("the desktop shell's own log (DOR-2045)", () => {
    /**
     * Pretend to be the desktop app.
     *
     * `isDesktopShell()` feature-detects `getServerPort`, so a bridge without it
     * is not the shell however many other methods it carries — which is also how
     * a desktop build older than this one is modelled: bridge present,
     * `getShellLogExcerpt` absent.
     */
    function mountBridge(bridge: Partial<ElectronAPI>): void {
      (window as { electronAPI?: Partial<ElectronAPI> }).electronAPI = bridge;
    }

    afterEach(() => {
      delete (window as { electronAPI?: unknown }).electronAPI;
    });

    /** Type a bug message and press Send, returning what went out. */
    async function sendBug(transport = createMockTransport()) {
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);
      await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
      await act(async () => {});

      fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
      fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
        target: { value: 'the window keeps reloading itself' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      return sendFeedback.mock.calls[0][0];
    }

    it("attaches the shell's own log excerpt when running in the desktop app", async () => {
      const getShellLogExcerpt = vi
        .fn()
        .mockResolvedValue('2026-09-14 15:25:25.123 info [renderer] Reloading the window.');
      mountBridge({ getServerPort: () => 4242, getShellLogExcerpt });

      const submitted = await sendBug();

      expect(getShellLogExcerpt).toHaveBeenCalledTimes(1);
      expect(submitted.diagnostics?.shellLogExcerpt).toBe(
        '2026-09-14 15:25:25.123 info [renderer] Reloading the window.'
      );
    });

    it('sends the report anyway when the shell cannot produce an excerpt', async () => {
      // A desktop build older than this one has no such method, and a shell
      // whose log is unreadable answers `undefined`. Neither may cost a person
      // their bug report.
      mountBridge({ getServerPort: () => 4242 });

      const submitted = await sendBug();

      expect(submitted.diagnostics?.shellLogExcerpt).toBeUndefined();
      expect(submitted.includeServerLogs).toBe(true);
    });
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
      // The Conversation toggle exists on a session route.
      expect(screen.getByRole('button', { name: 'This chat' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      expect(sendFeedback.mock.calls[0][0]).toMatchObject({
        sessionId: 'sess_1',
        includeTranscript: true,
      });
    });

    it('has no Conversation toggle off a session route', () => {
      renderDialog();
      expect(screen.queryByRole('button', { name: 'This chat' })).not.toBeInTheDocument();
    });
  });

  describe('room attachment (DOR-2108)', () => {
    /** Write the report (its kind already picked) and send it. */
    async function sendBug(transport: ReturnType<typeof createMockTransport>): Promise<void> {
      fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
        target: { value: 'The board went blank' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(transport.sendFeedback).toHaveBeenCalledTimes(1));
    }

    it('attaches that room, and only that room, once the chip is on', async () => {
      routerState.location = { pathname: '/channels', search: { id: 'room_1' } };
      const transport = createMockTransport();
      vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
      fireEvent.click(screen.getByRole('button', { name: 'This room' }));
      await sendBug(transport);

      const submission = vi.mocked(transport.sendFeedback).mock.calls[0][0];
      expect(submission).toMatchObject({ roomId: 'room_1', includeTranscript: true });
      expect(submission.sessionId).toBeUndefined();
    });

    // The PM's Must: a room holds other people's words, so the chip never
    // starts on in one, whatever the kind, crash prefill or carried-over draft.
    it.each([
      ['a bug', { initialKind: 'bug' as const }],
      ['a crash report', { initialKind: 'bug' as const, crashStack: 'Error: boom\n  at x' }],
    ])('starts the room chip OFF for %s in a room with other people', (_label, props) => {
      routerState.location = { pathname: '/channels', search: { id: 'room_1' } };
      // Opened the way the host opens it, so the kind's defaults apply.
      renderDialog(createMockTransport(), { ...props, startClosed: true }).setOpen(true);
      expect(screen.getByRole('button', { name: 'This room' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      // A 1:1 chat keeps its own default: on for a bug.
      cleanup();
      routerState.location = { pathname: '/session', search: { session: 'sess_1' } };
      renderDialog(createMockTransport(), { ...props, startClosed: true }).setOpen(true);
      expect(screen.getByRole('button', { name: 'This chat' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    });

    it('does not carry "This chat" being on over to a room', () => {
      routerState.location = { pathname: '/session', search: { session: 'sess_1' } };
      const { setOpen } = renderDialog(createMockTransport(), {
        initialKind: 'bug',
        startClosed: true,
      });
      setOpen(true);
      fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
        target: { value: 'draft kept' },
      });
      expect(screen.getByRole('button', { name: 'This chat' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      setOpen(false);
      routerState.location = { pathname: '/channels', search: { id: 'room_1' } };
      setOpen(true);
      expect(screen.getByRole('button', { name: 'This room' })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });

    it('sends only up to the newest message the preview showed', async () => {
      routerState.location = { pathname: '/channels', search: { id: 'room_1' } };
      const transport = createMockTransport();
      vi.mocked(transport.previewRoomTranscript).mockResolvedValue({
        text: 'Sam: seen',
        throughSeq: 12,
      });
      vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
      fireEvent.click(screen.getByRole('button', { name: 'This room' }));
      fireEvent.click(screen.getByRole('button', { name: 'Preview this room' }));
      expect(await screen.findByText('Sam: seen')).toBeInTheDocument();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByText('Sam: seen')).not.toBeInTheDocument());

      await sendBug(transport);
      expect(vi.mocked(transport.sendFeedback).mock.calls[0][0]).toMatchObject({
        roomId: 'room_1',
        roomThroughSeq: 12,
        includeTranscript: true,
      });
    });
  });

  describe('screenshot attachment (feedback-attachments PR 2)', () => {
    const SHOT = 'data:image/webp;base64,COMPRESSED';

    /** A file the picker/paste/drop paths hand over; its bytes are never read. */
    function imageFile(type = 'image/png'): File {
      return new File(['bytes'], 'shot.png', { type });
    }

    /** A drag/drop event payload carrying real files from outside the app. */
    function fileTransfer(files: File[]) {
      return { types: ['Files'], files, dropEffect: 'none' };
    }

    /**
     * Paste an image onto the dialog. The route a REPLACEMENT takes: once an
     * image is attached the box becomes the thumbnail, so the file input is no
     * longer on screen, but ⌘V still works anywhere on the dialog.
     */
    function pasteImage(file: File): void {
      fireEvent.paste(screen.getByRole('dialog'), {
        clipboardData: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] },
      });
    }

    beforeEach(() => {
      compressImage.mockResolvedValue(SHOT);
    });

    it('sends the compressed data URL as the submission’s screenshot', async () => {
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'the sidebar looks wrong' },
      });
      const file = imageFile();
      fireEvent.change(screen.getByLabelText('Add an image'), { target: { files: [file] } });

      await screen.findByAltText('The screenshot you attached');
      // The picked file is what went to the compressor — not some other blob.
      expect(compressImage).toHaveBeenCalledWith(file);

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      // Exactly `{ dataUrl }`: the wire schema is strict, and `hasScreenshot` is
      // the SERVER's to derive — a client that set it would be rejected.
      expect(sendFeedback.mock.calls[0][0].screenshot).toEqual({ dataUrl: SHOT });
    });

    it('attaches a pasted image and shows it in the message box', async () => {
      renderDialog();
      const file = imageFile();
      // ⌘V works anywhere on the dialog, not only in the message box.

      fireEvent.paste(screen.getByRole('dialog'), {
        clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
      });

      expect(await screen.findByAltText('The screenshot you attached')).toBeInTheDocument();
      expect(compressImage).toHaveBeenCalledWith(file);
    });

    it('refuses a non-image forced through the file picker', async () => {
      renderDialog();

      // `accept="image/*"` is a filter, not a gate — a file picker will still
      // hand over anything the user insists on.
      fireEvent.change(screen.getByLabelText('Add an image'), {
        target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
      });

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only images can be attached.'));
      expect(compressImage).not.toHaveBeenCalled();
    });

    it('attaches a dropped image where the person can see it land', async () => {
      renderDialog();
      const dialog = screen.getByRole('dialog');
      const file = imageFile('image/jpeg');

      fireEvent.dragEnter(dialog, { dataTransfer: fileTransfer([file]) });
      fireEvent.drop(dialog, { dataTransfer: fileTransfer([file]) });

      expect(await screen.findByAltText('The screenshot you attached')).toBeInTheDocument();
      expect(compressImage).toHaveBeenCalledWith(file);
    });

    it('turns a too-large refusal into a visible toast and attaches nothing', async () => {
      compressImage.mockRejectedValue(new ImageCompressError('too-large', 'over the cap'));
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'here is a picture' },
      });
      fireEvent.change(screen.getByLabelText('Add an image'), {
        target: { files: [imageFile()] },
      });

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'That image is too big to send. Crop it to the part that matters.'
        )
      );
      expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      expect(sendFeedback.mock.calls[0][0].screenshot).toBeUndefined();
    });

    it('removing the screenshot takes it off the submission', async () => {
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'never mind the picture' },
      });
      fireEvent.change(screen.getByLabelText('Add an image'), {
        target: { files: [imageFile()] },
      });
      await screen.findByAltText('The screenshot you attached');

      fireEvent.click(screen.getByRole('button', { name: /remove screenshot/i }));
      expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      expect(sendFeedback.mock.calls[0][0].screenshot).toBeUndefined();
    });

    it('will not send while the image is still being prepared', async () => {
      let release: (dataUrl: string) => void = () => {};
      compressImage.mockReturnValue(
        new Promise<string>((resolve) => {
          release = resolve;
        })
      );
      renderDialog();

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'wait for me' },
      });
      fireEvent.change(screen.getByLabelText('Add an image'), {
        target: { files: [imageFile()] },
      });

      // Sending here would post the report WITHOUT the picture the user just
      // chose, and say nothing about it.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());

      await act(async () => {
        release(SHOT);
      });
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    });

    it('keeps the screenshot with the rest of the draft across a close and reopen', async () => {
      const { setOpen } = renderDialog();
      fireEvent.change(screen.getByLabelText('Add an image'), {
        target: { files: [imageFile()] },
      });
      await screen.findByAltText('The screenshot you attached');

      setOpen(false);
      setOpen(true);

      // Closing by accident must not cost the picture any more than the words.
      expect(screen.getByAltText('The screenshot you attached')).toBeInTheDocument();
    });

    it('drops the screenshot once the report has gone', async () => {
      const transport = createMockTransport();
      vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      const { setOpen } = renderDialog(transport);
      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'with a picture' },
      });
      fireEvent.change(screen.getByLabelText('Add an image'), {
        target: { files: [imageFile()] },
      });
      await screen.findByAltText('The screenshot you attached');
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(transport.sendFeedback).toHaveBeenCalledTimes(1));

      setOpen(false);
      setOpen(true);

      // A picture from the last report riding along with the next one would be
      // an attachment nobody chose.
      expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();
    });

    describe('one-click capture of the app view (PR 3)', () => {
      const CAPTURED = 'data:image/png;base64,CAPTURED';

      /** Click "Capture app" in the message box's toolbar. */
      function clickCapture(): void {
        fireEvent.click(screen.getByRole('button', { name: 'Capture app' }));
      }

      it('compresses the captured picture and sends it like any other', async () => {
        captureAppView.mockResolvedValue(CAPTURED);
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        renderDialog(transport);
        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'the sidebar looks wrong' },
        });

        clickCapture();

        await screen.findByAltText('The screenshot you attached');
        // Through the SAME compressor: the shell hands back a full-size PNG of a
        // retina window, several times what the wire accepts.
        expect(compressImage).toHaveBeenCalledWith(CAPTURED);

        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].screenshot).toEqual({ dataUrl: SHOT });
      });

      it('says the capture failed, and points at the way in that still works', async () => {
        captureAppView.mockRejectedValue(new AppCaptureError('failed', 'no frame'));
        renderDialog();

        clickCapture();

        await waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith(
            'Couldn’t capture the app view. You can still add a screenshot yourself.'
          )
        );
        expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();
      });

      it('holds Send while the capture is being taken', async () => {
        captureAppView.mockImplementation(() => new Promise<string>(() => {}));
        renderDialog();
        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'mid-capture' },
        });

        clickCapture();

        // Sending now would post the report without the picture the person is
        // waiting for.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
      });
    });

    describe('pointing at one element (PR 4)', () => {
      const CROPPED = 'data:image/webp;base64,CROPPED';
      /** Either attached picture: the element's own crop, or a screenshot. */
      const ANY_PICTURE = /^(The part you pointed at: |The screenshot you attached$)/;
      const SHOT_WITH_REGION = {
        dataUrl: 'data:image/png;base64,WHOLE',
        region: { left: 0, top: 0, width: 1024, height: 768 },
      };

      /** Something in the app to point at, outside the dialog's own tree. */
      function appElement(): Element {
        const app = document.createElement('div');
        app.id = 'root';
        // Icon-only, so the name comes from its own test id ("Nav toggle").
        app.innerHTML =
          '<button data-slot="sidebar-toggle" data-testid="nav-toggle"><svg></svg></button>';
        document.body.append(app);
        const target = app.querySelector('button');
        if (!target) throw new Error('the app must have something to point at');
        return target;
      }

      /** Step out of the dialog into the picker. */
      function startPointing(): void {
        fireEvent.click(screen.getByRole('button', { name: 'Point at it' }));
      }

      /** Click the picker at a point that resolves to `target`. */
      function pickElement(target: Element): void {
        Object.defineProperty(document, 'elementFromPoint', {
          configurable: true,
          writable: true,
          value: () => target,
        });
        fireEvent.click(screen.getByRole('dialog'), { clientX: 40, clientY: 40 });
      }

      beforeEach(() => {
        captureAppShot.mockResolvedValue(SHOT_WITH_REGION);
        cropShotToElement.mockResolvedValue(CROPPED);
      });

      it('gets the dialog out of the way so there is something to point at', async () => {
        renderDialog();

        startPointing();

        // The dialog IS what is standing in front of the bug. The picker takes
        // its place — one thing on screen at a time, so the person is never
        // aiming past a panel.
        expect(screen.queryByText('Send feedback')).not.toBeInTheDocument();
        expect(
          screen.getByText('Click the part that looks wrong. Esc to cancel.')
        ).toBeInTheDocument();
      });

      it('comes back with the picture, the kind, and the element’s name', async () => {
        const target = appElement();
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        renderDialog(transport);
        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'this control is dead' },
        });
        startPointing();

        pickElement(target);

        await screen.findByAltText(ANY_PICTURE);
        expect(cropShotToElement).toHaveBeenCalledWith(SHOT_WITH_REGION, target);
        // Pointing at something broken is a bug report.
        expect(screen.getByRole('radio', { name: 'Bug' })).toBeChecked();

        // Captioned with a name a person can read, not the selector.
        expect(screen.getByText('Nav toggle')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        const sent = sendFeedback.mock.calls[0][0];
        expect(sent.screenshot).toEqual({ dataUrl: CROPPED });
        expect(sent.kind).toBe('bug');
        // The element travels as its own field. The message is the person's
        // words and nothing else, because the report's title is built from it
        // (DOR-2232: five reports were titled `Element: [data-testid=…]`).
        expect(sent.message).toBe('this control is dead');
        expect(sent.element).toEqual({
          selector: '[data-testid="nav-toggle"]',
          slot: 'sidebar-toggle',
          testId: 'nav-toggle',
        });
      });

      it('leaves the half-written report exactly as it was when cancelled', async () => {
        renderDialog();
        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'changed my mind' },
        });
        startPointing();

        fireEvent.keyDown(document.body, { key: 'Escape' });

        // Not a fresh dialog: the same one, with everything still in it. A round
        // trip that resets the form makes the affordance not worth pressing.
        expect(screen.getByPlaceholderText(/what works, what does not/i)).toHaveValue(
          'changed my mind'
        );
        expect(screen.queryByAltText(ANY_PICTURE)).not.toBeInTheDocument();
        expect(captureAppShot).not.toHaveBeenCalled();
      });

      it('does not switch attachments back on that the person switched off', async () => {
        // Pointing changes the KIND, and `bug` brings diagnostics on with it —
        // but never over the top of a deliberate choice. Re-deriving the
        // defaults here re-enables a toggle someone had just turned off, which
        // is the one thing this dialog promises never to do
        // (feedback-attachments decision 12).
        const target = appElement();
        routerState.location = { pathname: '/session', search: { session: 'abc' } };
        renderDialog();
        // A bug report turns both on by default, which is the state a person has
        // to be IN before switching one off can mean anything.
        fireEvent.click(screen.getByRole('radio', { name: 'Bug' }));
        const diagnostics = screen.getByRole('button', { name: 'Diagnostics' });
        const conversation = screen.getByRole('button', { name: 'This chat' });
        expect(diagnostics).toHaveAttribute('aria-pressed', 'true');
        expect(conversation).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(diagnostics);
        fireEvent.click(conversation);
        expect(diagnostics).toHaveAttribute('aria-pressed', 'false');
        expect(conversation).toHaveAttribute('aria-pressed', 'false');

        startPointing();
        pickElement(target);
        await screen.findByAltText(ANY_PICTURE);

        expect(screen.getByRole('radio', { name: 'Bug' })).toBeChecked();
        expect(screen.getByRole('button', { name: 'Diagnostics' })).toHaveAttribute(
          'aria-pressed',
          'false'
        );
        expect(screen.getByRole('button', { name: 'This chat' })).toHaveAttribute(
          'aria-pressed',
          'false'
        );
      });

      it('never writes the element into the message, and asks about it instead', async () => {
        const target = appElement();
        renderDialog();
        startPointing();

        pickElement(target);

        await screen.findByAltText(ANY_PICTURE);
        const message = screen.getByPlaceholderText('What’s wrong with the nav toggle?');
        expect(message).toHaveValue('');
      });

      it('removes the element and its picture together', async () => {
        const target = appElement();
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        renderDialog(transport);
        startPointing();
        pickElement(target);
        await screen.findByAltText(ANY_PICTURE);

        fireEvent.click(screen.getByRole('button', { name: 'Remove nav toggle' }));

        expect(screen.queryByAltText(ANY_PICTURE)).not.toBeInTheDocument();
        expect(screen.queryByText('Nav toggle')).not.toBeInTheDocument();
        fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
          target: { value: 'never mind that part' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].element).toBeUndefined();
        expect(sendFeedback.mock.calls[0][0].screenshot).toBeUndefined();
      });

      it('drops the old crop before pointing again, so a failed capture cannot keep it', async () => {
        const first = appElement();
        renderDialog();
        startPointing();
        pickElement(first);
        await screen.findByAltText('The part you pointed at: Nav toggle');

        const second = document.createElement('div');
        second.setAttribute('data-testid', 'message-list');
        document.body.append(second);
        cropShotToElement.mockRejectedValueOnce(new AppCaptureError('failed', 'no frame'));
        fireEvent.click(screen.getByRole('button', { name: 'Point again' }));
        pickElement(second);

        await screen.findByText('Message list');
        // The new name, and no picture: the nav toggle's crop is not relabelled.
        expect(screen.queryByAltText(ANY_PICTURE)).not.toBeInTheDocument();
        expect(
          screen.getByRole('img', { name: 'The part you pointed at: Message list' })
        ).toBeInTheDocument();
      });

      it('lands the caret in the message when the dialog comes back', async () => {
        const target = appElement();
        renderDialog();
        fireEvent.change(screen.getByLabelText('Your message'), {
          target: { value: 'this one' },
        });
        startPointing();
        pickElement(target);
        await screen.findByAltText('The part you pointed at: Nav toggle');

        await waitFor(() => expect(screen.getByLabelText('Your message')).toHaveFocus());
      });

      // The narrow-viewport gate is the TOOLBAR's own branch, and is checked where
      // it lives (`ComposerToolbar.test.tsx`): flipping `matchMedia` here would
      // also swap this dialog for its drawer variant, and the test would then be
      // measuring the wrong thing.
    });

    describe('a compression still in flight (cancellation)', () => {
      /** A `compressImage` whose settlement the test controls, one call at a time. */
      function deferredCompress() {
        const settlers: { resolve: (dataUrl: string) => void; reject: (e: unknown) => void }[] = [];
        compressImage.mockImplementation(
          () => new Promise<string>((resolve, reject) => settlers.push({ resolve, reject }))
        );
        return settlers;
      }

      it('does not resurrect an image the user removed while it was encoding', async () => {
        const settlers = deferredCompress();
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        renderDialog(transport);
        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'never mind' },
        });

        // Attach one, let it land, then start a REPLACEMENT and remove during it.
        fireEvent.change(screen.getByLabelText('Add an image'), {
          target: { files: [imageFile()] },
        });
        await act(async () => settlers[0].resolve('data:image/webp;base64,FIRST'));
        await screen.findByAltText('The screenshot you attached');

        pasteImage(imageFile());
        fireEvent.click(screen.getByRole('button', { name: /remove screenshot/i }));
        await act(async () => settlers[1].resolve('data:image/webp;base64,SECOND'));

        // The removed image must stay removed — a promise landing after the
        // remove would put a picture back that the user believed was gone.
        expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].screenshot).toBeUndefined();
      });

      it('does not leak a mid-flight image into the next report after a reopen', async () => {
        const settlers = deferredCompress();
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        const { setOpen } = renderDialog(transport);
        fireEvent.change(screen.getByLabelText('Add an image'), {
          target: { files: [imageFile()] },
        });

        // The host keeps this dialog mounted and only toggles `open`, so hook
        // state genuinely survives the close — the in-flight promise with it.
        setOpen(false);
        setOpen(true);
        await act(async () => settlers[0].resolve('data:image/webp;base64,STALE'));

        expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();

        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'a fresh report' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].screenshot).toBeUndefined();
      });

      it('keeps Send disabled until the LAST of two rapid attaches finishes', async () => {
        const settlers = deferredCompress();
        renderDialog();
        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'two at once' },
        });

        pasteImage(imageFile());
        pasteImage(imageFile());
        await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());

        // The FIRST one landing must not re-open the gate: the second picture is
        // still encoding, and sending now would post the report without it.
        await act(async () => settlers[0].resolve('data:image/webp;base64,FIRST'));
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

        await act(async () => settlers[1].resolve('data:image/webp;base64,SECOND'));
        expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
      });
    });

    describe('an image handed in by a caller (initialScreenshotDataUrl)', () => {
      let warn: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      });

      afterEach(() => warn.mockRestore());

      /** Mount closed, then open — the transition the real host always drives. */
      function openWith(initialScreenshotDataUrl: string, transport = createMockTransport()) {
        const handle = renderDialog(transport, { initialScreenshotDataUrl, startClosed: true });
        handle.setOpen(true);
        return handle;
      }

      it('accepts one that is a bounded image and sends it', async () => {
        const transport = createMockTransport();
        const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
        openWith('data:image/png;base64,GIVEN', transport);

        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'from the pointer tool' },
        });
        expect(await screen.findByAltText('The screenshot you attached')).toHaveAttribute(
          'src',
          'data:image/png;base64,GIVEN'
        );

        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].screenshot).toEqual({
          dataUrl: 'data:image/png;base64,GIVEN',
        });
      });

      it('drops one that is not an image, rather than letting intake refuse it', () => {
        // A `data:text/html` here would be embedded verbatim in a Linear issue.
        openWith('data:text/html;base64,PHNjcmlwdD4=');

        expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();
        expect(warn).toHaveBeenCalled();
      });
    });

    it('refuses a file dropped anywhere else on the page while the dialog is open', () => {
      renderDialog();

      // A drop that misses the dialog by a few pixels hits the document, and a
      // browser's default action is to NAVIGATE to the file — replacing the app,
      // and the half-written report, with a file:/// view.
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', {
        value: { types: ['Files'], files: [] },
      });
      document.body.dispatchEvent(drop);

      expect(drop.defaultPrevented).toBe(true);
    });
  });
});
