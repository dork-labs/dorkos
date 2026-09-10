// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { FeedbackDialog } from '../ui/FeedbackDialog';
import { __resetBreadcrumbsForTests, addBreadcrumb } from '@/layers/shared/lib/breadcrumbs';
import { setPlatformAdapter } from '@/layers/shared/lib';
import { ImageCompressError } from '@/layers/shared/lib/image-compress';

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

// Compression needs a canvas raster backend jsdom does not have, so the encode
// step is a controllable stub. `ImageCompressError` stays REAL, so the mapping
// from a refusal's reason to what the user is told is exercised for real.
const compressImage = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/lib/image-compress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib/image-compress')>()),
  compressImage,
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
  // And back to the standalone web surface, whatever an embed test set.
  setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
});

function renderDialog(
  transport = createMockTransport(),
  props?: {
    currentUser?: { email: string; name?: string } | null;
    initialScreenshotDataUrl?: string;
    /**
     * Mount closed, so the caller can drive the closed -> open transition the
     * real host always drives. The prefill props are read on that transition.
     */
    startClosed?: boolean;
  }
) {
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <FeedbackDialog
          open={open}
          onOpenChange={onOpenChange}
          currentUser={props?.currentUser ?? null}
          initialScreenshotDataUrl={props?.initialScreenshotDataUrl}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(ui(!props?.startClosed));
  return { onOpenChange, setOpen: (open: boolean) => rerender(ui(open)) };
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
      expect(toast.error).toHaveBeenCalledWith('Couldn’t send. Try the GitHub option.')
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
    expect(submitted.screenshot).toBeUndefined();
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

  describe('screenshot attachment (feedback-attachments PR 2)', () => {
    const SHOT = 'data:image/webp;base64,COMPRESSED';

    /** A file the picker/paste/drop paths hand over; its bytes are never read. */
    function imageFile(type = 'image/png'): File {
      return new File(['bytes'], 'shot.png', { type });
    }

    /** Reveal the collapsed Attachments & details panel the screenshot slot lives in. */
    function openPanel(): void {
      fireEvent.click(screen.getByRole('button', { name: /attachments & details/i }));
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
      openPanel();
      const file = imageFile();
      fireEvent.change(screen.getByLabelText('Add screenshot'), { target: { files: [file] } });

      await screen.findByAltText('The screenshot you attached');
      // The picked file is what went to the compressor — not some other blob.
      expect(compressImage).toHaveBeenCalledWith(file);

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      // Exactly `{ dataUrl }`: the wire schema is strict, and `hasScreenshot` is
      // the SERVER's to derive — a client that set it would be rejected.
      expect(sendFeedback.mock.calls[0][0].screenshot).toEqual({ dataUrl: SHOT });
    });

    it('attaches a pasted image and reveals it, even with the panel collapsed', async () => {
      renderDialog();
      const file = imageFile();
      // ⌘V works anywhere on the dialog, including with the panel shut — an
      // image that lands invisibly is one the pasting user cannot confirm.
      expect(screen.queryByLabelText('Add screenshot')).not.toBeInTheDocument();

      fireEvent.paste(screen.getByRole('dialog'), {
        clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
      });

      expect(await screen.findByAltText('The screenshot you attached')).toBeInTheDocument();
      expect(compressImage).toHaveBeenCalledWith(file);
    });

    it('ignores a paste that carried no file at all (someone pasting text)', async () => {
      renderDialog();

      fireEvent.paste(screen.getByRole('dialog'), {
        clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
      });

      await act(async () => {});
      expect(compressImage).not.toHaveBeenCalled();
      // Pasting text into the message box must not scold anyone.
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('picks the image out of a paste that carried other files beside it', async () => {
      renderDialog();
      const notAnImage = new File(['x'], 'notes.txt', { type: 'text/plain' });
      const image = imageFile();

      fireEvent.paste(screen.getByRole('dialog'), {
        clipboardData: {
          items: [
            { kind: 'file', type: 'text/plain', getAsFile: () => notAnImage },
            { kind: 'file', type: 'image/png', getAsFile: () => image },
          ],
        },
      });

      // Taking the first file rather than the first IMAGE would refuse a paste
      // that plainly contained a picture.
      await screen.findByAltText('The screenshot you attached');
      expect(compressImage).toHaveBeenCalledWith(image);
    });

    it('picks the image out of a drop that carried other files beside it', async () => {
      renderDialog();
      const notAnImage = new File(['x'], 'notes.txt', { type: 'text/plain' });
      const image = imageFile();

      fireEvent.drop(screen.getByRole('dialog'), {
        dataTransfer: fileTransfer([notAnImage, image]),
      });

      await screen.findByAltText('The screenshot you attached');
      expect(compressImage).toHaveBeenCalledWith(image);
    });

    it('refuses a non-image forced through the file picker', async () => {
      renderDialog();
      openPanel();

      // `accept="image/*"` is a filter, not a gate — a file picker will still
      // hand over anything the user insists on.
      fireEvent.change(screen.getByLabelText('Add screenshot'), {
        target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
      });

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only images can be attached.'));
      expect(compressImage).not.toHaveBeenCalled();
    });

    it('reveals the drop target while a file drag is still in the air', async () => {
      renderDialog();
      // Nothing dropped yet, so nothing is attached to reveal the panel — this
      // is the drag treatment doing it, and it is the only cue that the dialog
      // will take the drop at all.
      fireEvent.dragEnter(screen.getByRole('dialog'), {
        dataTransfer: fileTransfer([imageFile()]),
      });

      expect(await screen.findByText('Drop to attach')).toBeInTheDocument();
    });

    it('attaches a dropped image and opens the panel so the user can see it land', async () => {
      renderDialog();
      const dialog = screen.getByRole('dialog');
      const file = imageFile('image/jpeg');
      // The panel starts collapsed — a drop with nowhere visible to land is the
      // usual reason a drag looks like it "did nothing".
      expect(screen.queryByLabelText('Add screenshot')).not.toBeInTheDocument();

      fireEvent.dragEnter(dialog, { dataTransfer: fileTransfer([file]) });
      fireEvent.drop(dialog, { dataTransfer: fileTransfer([file]) });

      expect(await screen.findByAltText('The screenshot you attached')).toBeInTheDocument();
      expect(compressImage).toHaveBeenCalledWith(file);
    });

    it('leaves a drag carrying no files alone', async () => {
      renderDialog();
      const dialog = screen.getByRole('dialog');

      // Control first: a file drag DOES produce the treatment, so the absence
      // asserted below is a real difference and not a selector that never matches.
      fireEvent.dragEnter(dialog, { dataTransfer: fileTransfer([imageFile()]) });
      expect(await screen.findByText('Drop to attach')).toBeInTheDocument();
      fireEvent.dragLeave(dialog, { dataTransfer: fileTransfer([imageFile()]) });
      await waitFor(() => expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument());

      fireEvent.dragEnter(dialog, {
        dataTransfer: { types: ['application/x-dorkos-file-path'], files: [] },
      });

      await act(async () => {});
      // An in-app path drag is never claimed, so no treatment appears for it.
      expect(screen.queryByText('Drop to attach')).not.toBeInTheDocument();
    });

    it('refuses a dropped file that is not an image, and says so', async () => {
      renderDialog();
      const notAnImage = new File(['x'], 'notes.txt', { type: 'text/plain' });

      fireEvent.drop(screen.getByRole('dialog'), { dataTransfer: fileTransfer([notAnImage]) });

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Only images can be attached.'));
      expect(compressImage).not.toHaveBeenCalled();
    });

    it('turns a too-large refusal into a visible toast and attaches nothing', async () => {
      compressImage.mockRejectedValue(new ImageCompressError('too-large', 'over the cap'));
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'here is a picture' },
      });
      openPanel();
      fireEvent.change(screen.getByLabelText('Add screenshot'), {
        target: { files: [imageFile()] },
      });

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'That image is too big to send. Try cropping it to just the part that matters.'
        )
      );
      expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
      expect(sendFeedback.mock.calls[0][0].screenshot).toBeUndefined();
    });

    it('says something different when the image simply could not be read', async () => {
      compressImage.mockRejectedValue(new ImageCompressError('unreadable', 'bad bytes'));
      renderDialog();
      openPanel();

      fireEvent.change(screen.getByLabelText('Add screenshot'), {
        target: { files: [imageFile()] },
      });

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Couldn’t read that image. Try a PNG or JPEG.')
      );
    });

    it('removing the screenshot takes it off the submission', async () => {
      const transport = createMockTransport();
      const sendFeedback = vi.mocked(transport.sendFeedback).mockResolvedValue({ ok: true });
      renderDialog(transport);

      fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
        target: { value: 'never mind the picture' },
      });
      openPanel();
      fireEvent.change(screen.getByLabelText('Add screenshot'), {
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
      openPanel();
      fireEvent.change(screen.getByLabelText('Add screenshot'), {
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

    it('adds a Screenshot tab to the full preview only once one is attached', async () => {
      renderDialog();
      openPanel();
      fireEvent.click(screen.getAllByRole('button', { name: 'View full preview' })[0]);
      expect(screen.queryByRole('tab', { name: 'Screenshot' })).not.toBeInTheDocument();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

      fireEvent.change(screen.getByLabelText('Add screenshot'), {
        target: { files: [imageFile()] },
      });
      await screen.findByAltText('The screenshot you attached');
      fireEvent.click(screen.getByRole('button', { name: 'View full screenshot' }));

      const tab = await screen.findByRole('tab', { name: 'Screenshot' });
      expect(tab).toBeInTheDocument();
    });

    it('summarises the attachment on the collapsed panel', async () => {
      renderDialog();
      openPanel();
      fireEvent.change(screen.getByLabelText('Add screenshot'), {
        target: { files: [imageFile()] },
      });

      expect(await screen.findByText(/Screenshot on/)).toBeInTheDocument();
    });

    it('drops the screenshot when the dialog is closed and reopened', async () => {
      const { setOpen } = renderDialog();
      openPanel();
      fireEvent.change(screen.getByLabelText('Add screenshot'), {
        target: { files: [imageFile()] },
      });
      await screen.findByAltText('The screenshot you attached');

      setOpen(false);
      setOpen(true);

      // A picture from the last report riding along with the next one would be
      // an attachment nobody chose.
      openPanel();
      expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();
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
        openPanel();

        // Attach one, let it land, then start a REPLACEMENT and remove during it.
        fireEvent.change(screen.getByLabelText('Add screenshot'), {
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
        openPanel();
        fireEvent.change(screen.getByLabelText('Add screenshot'), {
          target: { files: [imageFile()] },
        });

        // The host keeps this dialog mounted and only toggles `open`, so hook
        // state genuinely survives the close — the in-flight promise with it.
        setOpen(false);
        setOpen(true);
        await act(async () => settlers[0].resolve('data:image/webp;base64,STALE'));

        // Read the COLLAPSED panel's summary, not the panel's contents: clicking
        // the panel open here would toggle shut whatever the attach opened, and
        // the thumbnail would be missing whether or not the leak happened.
        expect(screen.queryByText(/Screenshot on/)).not.toBeInTheDocument();

        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'a fresh report' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
        expect(sendFeedback.mock.calls[0][0].screenshot).toBeUndefined();
      });

      it('stays quiet when a superseded attach fails after a newer one landed', async () => {
        const settlers = deferredCompress();
        renderDialog();
        openPanel();

        pasteImage(imageFile());
        pasteImage(imageFile());
        await act(async () => settlers[1].resolve('data:image/webp;base64,SECOND'));
        await act(async () =>
          settlers[0].reject(new ImageCompressError('too-large', 'stale failure'))
        );

        // The picture on screen is fine; a toast about the one it replaced is a
        // complaint about nothing the user can see or act on.
        expect(toast.error).not.toHaveBeenCalled();
        expect(await screen.findByAltText('The screenshot you attached')).toHaveAttribute(
          'src',
          'data:image/webp;base64,SECOND'
        );
      });

      it('keeps Send disabled until the LAST of two rapid attaches finishes', async () => {
        const settlers = deferredCompress();
        renderDialog();
        fireEvent.change(screen.getByPlaceholderText(/what works, what does not/i), {
          target: { value: 'two at once' },
        });
        openPanel();

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

      it('shows the last attach, not whichever promise happened to land last', async () => {
        const settlers = deferredCompress();
        renderDialog();
        openPanel();

        pasteImage(imageFile());
        pasteImage(imageFile());
        // Out-of-order resolution: the SECOND finishes, then the first.
        await act(async () => settlers[1].resolve('data:image/webp;base64,SECOND'));
        await act(async () => settlers[0].resolve('data:image/webp;base64,FIRST'));

        expect(await screen.findByAltText('The screenshot you attached')).toHaveAttribute(
          'src',
          'data:image/webp;base64,SECOND'
        );
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

      it('drops one that is over the cap', () => {
        openWith(`data:image/png;base64,${'A'.repeat(600_001)}`);

        // Over-cap here would 400 at intake with a toast that names nothing.
        expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();
        expect(warn).toHaveBeenCalled();
      });

      it('never holds one on a transport that cannot send it', () => {
        setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
        openWith('data:image/png;base64,GIVEN');

        // The embed renders no screenshot slot, so the absent thumbnail proves
        // nothing on its own. What IS observable is the panel: a stored image
        // forces it open, and here it must stay shut over an empty panel.
        expect(screen.queryByLabelText('Diagnostics')).not.toBeInTheDocument();
        expect(screen.queryByAltText('The screenshot you attached')).not.toBeInTheDocument();
      });

      it('reveals the attachments panel on a surface that CAN show it', () => {
        // The control for the assertion above: same prop, non-embedded surface,
        // and the panel does open.
        openWith('data:image/png;base64,GIVEN');
        expect(screen.getByLabelText('Diagnostics')).toBeInTheDocument();
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

    it('leaves an ordinary drag on the page alone while the dialog is open', () => {
      renderDialog();

      // Only file drags are swallowed; anything else on the page keeps working.
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', {
        value: { types: ['text/plain'], files: [] },
      });
      document.body.dispatchEvent(drop);

      expect(drop.defaultPrevented).toBe(false);
    });

    it('stops refusing page drops once the dialog closes', () => {
      const { setOpen } = renderDialog();
      setOpen(false);

      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', {
        value: { types: ['Files'], files: [] },
      });
      document.body.dispatchEvent(drop);

      // The guard is scoped to the dialog being open — dropping a file on the
      // app at any other time behaves as it always has.
      expect(drop.defaultPrevented).toBe(false);
    });

    it('leaves page drops alone under the in-process (Obsidian) transport', () => {
      // No capture there, so no reason to claim the window's drops — the embed
      // is a pane inside someone else's app, whose own drag-and-drop must work.
      setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
      renderDialog();

      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [] } });
      document.body.dispatchEvent(drop);

      expect(drop.defaultPrevented).toBe(false);
    });

    it('offers no capture at all under the in-process (Obsidian) transport', async () => {
      setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
      renderDialog();
      openPanel();

      expect(screen.queryByLabelText('Add screenshot')).not.toBeInTheDocument();
      expect(screen.queryByText('Point at element (coming soon)')).not.toBeInTheDocument();

      // And the paste path is gone with it — that transport drops the field.
      fireEvent.paste(screen.getByRole('dialog'), {
        clipboardData: {
          items: [{ kind: 'file', type: 'image/png', getAsFile: () => imageFile() }],
        },
      });
      await act(async () => {});
      expect(compressImage).not.toHaveBeenCalled();
    });
  });
});
