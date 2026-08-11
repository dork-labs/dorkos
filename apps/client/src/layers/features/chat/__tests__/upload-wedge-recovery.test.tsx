// @vitest-environment jsdom
/**
 * A stalled attachment upload must not wedge the composer (DOR-494).
 *
 * The subject is the whole composer, not the upload hook: the wedge only exists
 * once `isUploading` reaches the action button and the Enter rule, so the real
 * `useFileUpload`, the real `Composer.Input`/`InputActionButton` and the real
 * `Composer.Attachments` are all mounted here. Only the network is faked.
 *
 * What the fake stands in for is a contract proven separately: the HTTP
 * transport rejects an aborted upload with `UPLOAD_CANCELED_MESSAGE` and a
 * silent one with `UPLOAD_STALLED_MESSAGE`, asserted against the real
 * `XMLHttpRequest` wiring in
 * `shared/lib/transport/__tests__/upload-methods.test.ts`.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UploadResult } from '@dorkos/shared/types';

vi.mock('../ui/status/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status" />,
}));

vi.mock('../model/use-background-tasks', () => ({
  useBackgroundTasks: () => [],
}));

vi.mock('@/layers/features/commands', () => ({ CommandPalette: () => null }));
vi.mock('@/layers/features/files', () => ({ FilePalette: () => null }));

vi.mock('react-dropzone', () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
  }),
}));

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null }),
  useAgentVisual: () => ({ color: '#3b82f6', emoji: '' }),
}));

// Only the read-hooks the container calls are stubbed; the app store keeps its
// real shape apart from the two fields this tree reads.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...original,
    useAppStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({ isTextStreaming: false, selectedCwd: '/test/project' })
    ),
  };
});

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => ['/test/project', vi.fn()],
  useSessionChatState: () => ({ messages: [] }),
  useSessionStreamState: () => ({
    messages: [],
    inProgressTurn: [],
    status: null,
    pendingInteractions: [],
    lastAppliedSeq: 0,
    streamReadyCursor: null,
    connectionState: 'connected',
  }),
}));

import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { UPLOAD_CANCELED_MESSAGE, UPLOAD_STALLED_MESSAGE } from '@/layers/shared/lib';
import { ChatInputContainer } from '../ui/input/ChatInputContainer';
import { useFileUpload } from '../model/use-file-upload';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    // Desktop: fine pointer, wide viewport — Enter sends.
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('(any-pointer: fine)'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(document, 'execCommand', {
    writable: true,
    configurable: true,
    value: vi.fn(() => true),
  });
});

let mockTransport: ReturnType<typeof createMockTransport>;
let queryClient: QueryClient;

/** The `handleSubmit` the composer reached, counted. */
const onSend = vi.fn();

/**
 * The composer wired the way `ChatPanel` wires it: the real upload hook feeding
 * the real container. `handleSubmit` mirrors the send path — it starts the
 * attachment upload and returns, exactly as `use-session-submit` does through
 * `transformContent`.
 */
function Composer({ attachment }: { attachment: File }) {
  const fileUpload = useFileUpload();
  const [input, setInput] = useState('');

  return (
    <>
      <button type="button" onClick={() => fileUpload.addFiles([attachment])}>
        attach
      </button>
      <ChatInputContainer
        chatInputRef={React.createRef()}
        input={input}
        setInput={setInput}
        autocomplete={
          {
            commands: { show: false, filtered: [], selectedIndex: -1 },
            files: { show: false, filtered: [], selectedIndex: -1 },
            handleInputChange: setInput,
            handleCommandSelect: vi.fn(),
            handleFileSelect: vi.fn(),
            handleArrowUp: vi.fn(),
            handleArrowDown: vi.fn(),
            handleKeyboardSelect: vi.fn(),
            handleCursorChange: vi.fn(),
            dismissPalettes: vi.fn(),
            isPaletteOpen: false,
            paletteHasResults: false,
            activeDescendantId: undefined,
            paletteListboxId: undefined,
          } as never
        }
        handleSubmit={() => {
          onSend();
          void fileUpload.uploadAndGetPaths().catch(() => {});
        }}
        enqueueContent={vi.fn().mockResolvedValue(true)}
        tryNativeCommand={vi.fn(() => ({ handled: false }) as never)}
        commandPending={false}
        status="idle"
        sessionBusy={false}
        stop={vi.fn()}
        sessionId="test-session"
        sessionStatus={null}
        fileUpload={{
          pendingFiles: fileUpload.pendingFiles,
          onFilesSelected: fileUpload.addFiles,
          onFileRemove: fileUpload.removeFile,
          onFileRetry: fileUpload.retryFile,
          onUploadCancel: fileUpload.cancelUpload,
          isUploading: fileUpload.isUploading,
          hasFailedUpload: fileUpload.hasFailedUpload,
        }}
        interaction={{
          active: null,
          pendingApprovals: [],
          focusedOptionIndex: 0,
          onToolRef: vi.fn(),
          onToolDecided: vi.fn(),
        }}
        sync={{ connectionState: 'connected' }}
      />
    </>
  );
}

function renderComposer() {
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <Composer attachment={new File(['hello'], 'notes.txt', { type: 'text/plain' })} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * Press Enter with the caret in the composer.
 *
 * The click is not decoration: every control this suite presses unmounts on the
 * state change it causes, which drops focus to `document.body`. A bare
 * `keyboard('{Enter}')` after one of those goes nowhere near the composer, so
 * "Enter did not send" would pass whether the composer was wedged or not.
 */
async function pressEnter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox'));
  await user.keyboard('{Enter}');
}

/** Attach a file, type a message, and press Enter — the send that starts the upload. */
async function startUpload(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'attach' }));
  await user.click(screen.getByRole('combobox'));
  await user.keyboard('look at this');
  await pressEnter(user);
  await waitFor(() => expect(screen.getByLabelText('Cancel upload')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mockTransport = createMockTransport();
});

afterEach(() => {
  cleanup();
});

describe('a stalled attachment upload does not wedge the composer', () => {
  it('offers a cancel that frees the composer, and the file is never sent', async () => {
    const user = userEvent.setup();
    // Never settles on its own — the wedge. Honours the abort signal the way
    // the HTTP transport does.
    let sawSignal: AbortSignal | undefined;
    mockTransport.uploadFiles = vi.fn(
      (_files, _cwd, _onProgress, signal?: AbortSignal) =>
        new Promise<UploadResult[]>((_resolve, reject) => {
          sawSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error(UPLOAD_CANCELED_MESSAGE)));
        })
    ) as typeof mockTransport.uploadFiles;

    renderComposer();
    await startUpload(user);

    // Wedged: the action button is a cancel-able progress control, and a second
    // Enter does not start a second send.
    expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument();
    await pressEnter(user);
    expect(onSend).toHaveBeenCalledTimes(1);

    await user.click(screen.getByLabelText('Cancel upload'));

    // The real request was aborted, not just the mutation state.
    expect(sawSignal?.aborted).toBe(true);
    // Nothing was sent: the transport was asked once, and no message went out.
    expect(mockTransport.uploadFiles).toHaveBeenCalledTimes(1);

    // The chip says what happened and offers both ways out.
    expect(await screen.findByText(UPLOAD_CANCELED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try uploading notes.txt again' })).toBeVisible();

    // The composer is no longer a spinner. The send stays deliberately blocked
    // while a chip is unresolved (DOR-480) — that is a stated refusal, not a hang.
    const sendButton = await screen.findByLabelText('Send message');
    expect(sendButton).toBeDisabled();
    await pressEnter(user);
    expect(onSend).toHaveBeenCalledTimes(1);

    // One click on the chip's X — the exit the chip advertises — and the
    // composer sends again.
    await user.click(screen.getByLabelText('Remove notes.txt'));
    await waitFor(() => expect(screen.getByLabelText('Send message')).toBeEnabled());
    await pressEnter(user);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('frees the composer when the upload times out', async () => {
    const user = userEvent.setup();
    // The transport's stall watchdog firing, as
    // `upload-methods.test.ts` proves it does after
    // `UPLOAD_STALL_TIMEOUT_MS` of silence.
    let failStalled!: () => void;
    mockTransport.uploadFiles = vi.fn(
      () =>
        new Promise<UploadResult[]>((_resolve, reject) => {
          failStalled = () => reject(new Error(UPLOAD_STALLED_MESSAGE));
        })
    ) as typeof mockTransport.uploadFiles;

    renderComposer();
    await startUpload(user);

    failStalled();

    expect(await screen.findByText(UPLOAD_STALLED_MESSAGE)).toBeInTheDocument();
    const sendButton = await screen.findByLabelText('Send message');
    expect(sendButton).toBeDisabled();

    await user.click(screen.getByLabelText('Remove notes.txt'));
    await waitFor(() => expect(screen.getByLabelText('Send message')).toBeEnabled());
    await pressEnter(user);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('cancels the upload from the chip, so removing a chip leaves nothing running', async () => {
    const user = userEvent.setup();
    let sawSignal: AbortSignal | undefined;
    mockTransport.uploadFiles = vi.fn(
      (_files, _cwd, _onProgress, signal?: AbortSignal) =>
        new Promise<UploadResult[]>((_resolve, reject) => {
          sawSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error(UPLOAD_CANCELED_MESSAGE)));
        })
    ) as typeof mockTransport.uploadFiles;

    renderComposer();
    await startUpload(user);

    // While the upload runs, the chip's control cancels it rather than dropping
    // the chip and leaving the request in flight.
    await user.click(screen.getByLabelText('Cancel upload of notes.txt'));

    expect(sawSignal?.aborted).toBe(true);
    expect(await screen.findByText(UPLOAD_CANCELED_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Send message')).toBeInTheDocument());
  });
});
