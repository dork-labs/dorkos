// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
// Mock child components to isolate ChatInputContainer behavior
// The composer barrel is mocked as one object: `Composer.Input` and
// `Composer.Attachments` are stand-ins so this file tests the container's
// orchestration, while `Composer.ClearArmedHint` stays REAL — the armed-clear
// assertions below read its own testid.
vi.mock('@/layers/features/composer', async (importActual) => {
  const actual = await importActual<typeof import('@/layers/features/composer')>();
  return {
    Composer: {
      // Root is a pass-through: this file asserts what the container puts
      // INSIDE the card, never the card's own chrome, and a real Root would
      // mount react-dropzone's document listeners for no assertion's benefit.
      // A stub that dropped `children` would render an empty composer, so it
      // forwards them.
      Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      // OverlayLane stays REAL. The armed-clear test below finds the lane by
      // its own positioning classes and asserts the hint is inside it — against
      // a stub it would be asserting on a copy of the lane, which proves
      // nothing about where the hint actually lands.
      OverlayLane: actual.Composer.OverlayLane,
      Input: vi.fn(() => <div data-testid="chat-input">Composer.Input</div>),
      Attachments: vi.fn(() => <div data-testid="file-chips">Composer.Attachments</div>),
      ClearArmedHint: actual.Composer.ClearArmedHint,
    },
  };
});

vi.mock('../ui/status/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status">ChatStatusSection</div>,
}));

vi.mock('../ui/input/QueuePanel', () => ({
  QueuePanel: vi.fn(() => <div data-testid="queue-panel">QueuePanel</div>),
}));

vi.mock('../ui/tools/ToolApproval', () => ({
  ToolApproval: vi.fn(({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="tool-approval">ToolApproval-{toolCallId}</div>
  )),
}));

vi.mock('../ui/tools/QuestionPrompt', () => ({
  QuestionPrompt: vi.fn(({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="question-prompt">QuestionPrompt-{toolCallId}</div>
  )),
}));

vi.mock('@/layers/features/commands', () => ({
  CommandPalette: () => null,
}));

vi.mock('@/layers/features/files', () => ({
  FilePalette: () => null,
}));

vi.mock('react-dropzone', () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
  }),
}));

// `useChatQueue` is deliberately NOT mocked: it is the only thing in this tree
// that can write the composer, so stubbing it made the cross-session-leak guard
// below unfalsifiable — it asserted that a function nothing could call was never
// called. The real hook runs against the real session stores (below).
vi.mock('../model/use-background-tasks', () => ({
  useBackgroundTasks: () => [],
}));

vi.mock('@/layers/shared/model', () => ({
  useAppStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ isTextStreaming: false })
  ),
  useTransport: () => ({
    stopTask: vi.fn(),
  }),
}));

// The composer preference (DOR-948). Stubbed rather than driven through a real
// config query because this file mocks the transport down to `stopTask`; what
// is under test is that the container PASSES what the hook answers, not how the
// hook reads config (that is `use-composer-prefs.test.tsx`).
const mockComposerRichText = vi.fn(() => false);
vi.mock('@/layers/entities/config', () => ({
  useComposerRichText: () => mockComposerRichText(),
}));

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null }),
  useAgentVisual: () => ({ color: '#3b82f6', emoji: '' }),
}));

// Only the three read-hooks the container itself calls are stubbed. Everything
// else — the session stores, `useSessionQueue`, `useSessionAwaitingDecision` —
// stays real, so the un-mocked `useChatQueue` above operates on real state.
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => [null, vi.fn()],
  useSessionChatState: () => ({ messages: [] }),
  useSessionStreamState: () => ({
    messages: [],
    inProgressTurn: [],
    status: null,
    pendingInteractions: [],
    lastAppliedSeq: 0,
    streamReadyCursor: null,
    connectionState: 'connecting',
  }),
}));

import { ChatInputContainer } from '../ui/input/ChatInputContainer';
import { Composer } from '@/layers/features/composer';
import { QueuePanel } from '../ui/input/QueuePanel';
import { useSessionStreamStore } from '@/layers/entities/session';
import type { ToolCallState } from '../model/chat-types';
import { createRef } from 'react';

/** Props the (mocked) `Composer.Input` was last rendered with. */
function lastChatInputProps() {
  return vi.mocked(Composer.Input).mock.calls.at(-1)![0];
}

const baseProps = {
  chatInputRef: createRef<null>(),
  input: '',
  autocomplete: {
    commands: { show: false, filtered: [], selectedIndex: -1 },
    files: { show: false, filtered: [], selectedIndex: -1 },
    handleInputChange: vi.fn(),
    handleCommandSelect: vi.fn(),
    handleFileSelect: vi.fn(),
    handleArrowUp: vi.fn(),
    handleArrowDown: vi.fn(),
    handleKeyboardSelect: vi.fn(),
    handleCursorChange: vi.fn(),
    dismissPalettes: vi.fn(),
    isPaletteOpen: false,
    activeDescendantId: undefined,
  } as never,
  handleSubmit: vi.fn(),
  submitContent: vi.fn(),
  tryNativeCommand: vi.fn(() => ({ handled: false }) as const),
  commandPending: false,
  status: 'idle' as const,
  sessionBusy: false,
  stop: vi.fn(),
  setInput: vi.fn(),
  sessionId: 'test-session',
  sessionStatus: null,
  fileUpload: {
    pendingFiles: [],
    onFilesSelected: vi.fn(),
    onFileRemove: vi.fn(),
    onFileRetry: vi.fn(),
    onUploadCancel: vi.fn(),
    isUploading: false,
    hasFailedUpload: false,
  },
  interaction: {
    active: null,
    pendingApprovals: [],
    focusedOptionIndex: 0,
    onToolRef: vi.fn(),
    onToolDecided: vi.fn(),
  },
  sync: {
    connectionState: 'connected' as const,
  },
};

afterEach(() => {
  cleanup();
  // The stream store is module state shared across tests — a queue seeded by one
  // case must not decide whether the panel renders in the next.
  useSessionStreamStore.getState().clearQueue('test-session');
});

describe('ChatInputContainer mode switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders normal mode when no activeInteraction', () => {
    render(<ChatInputContainer {...baseProps} />);
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    expect(screen.getByTestId('chat-status')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-approval')).not.toBeInTheDocument();
    expect(screen.queryByTestId('question-prompt')).not.toBeInTheDocument();
  });

  it.each([
    ['off', false],
    ['on', true],
  ])('passes richText through from the preference when it is %s', (_label, stored) => {
    mockComposerRichText.mockReturnValue(stored);
    render(<ChatInputContainer {...baseProps} />);
    expect(lastChatInputProps().richText).toBe(stored);
  });

  it('renders ToolApproval in interactive mode for approval type', () => {
    const toolCall: ToolCallState = {
      toolCallId: 'tc-1',
      toolName: 'Write',
      input: '{}',
      status: 'pending',
      interactiveType: 'approval',
    };
    render(
      <ChatInputContainer
        {...baseProps}
        interaction={{ ...baseProps.interaction, active: toolCall }}
      />
    );
    expect(screen.getByTestId('tool-approval')).toBeInTheDocument();
    expect(screen.getByText('ToolApproval-tc-1')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
  });

  it('renders QuestionPrompt in interactive mode for question type', () => {
    const toolCall: ToolCallState = {
      toolCallId: 'tc-2',
      toolName: 'AskUser',
      input: '{}',
      status: 'pending',
      interactiveType: 'question',
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
          header: 'Q',
        },
      ],
    };
    render(
      <ChatInputContainer
        {...baseProps}
        interaction={{ ...baseProps.interaction, active: toolCall }}
      />
    );
    expect(screen.getByTestId('question-prompt')).toBeInTheDocument();
    expect(screen.getByText('QuestionPrompt-tc-2')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
  });

  it('hides normal-mode elements during interactive mode', () => {
    const toolCall: ToolCallState = {
      toolCallId: 'tc-3',
      toolName: 'Write',
      input: '{}',
      status: 'pending',
      interactiveType: 'approval',
    };
    render(
      <ChatInputContainer
        {...baseProps}
        interaction={{ ...baseProps.interaction, active: toolCall }}
      />
    );
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-panel')).not.toBeInTheDocument();
  });

  it('never writes to the composer input on interactive-mode transitions (F4)', () => {
    // The draft lives in the per-session store and survives the card swap on
    // its own. The retired useInteractiveDraft hook re-wrote the input on every
    // interactive-mode exit from a ref that was NOT session-scoped — switching
    // sessions while an interaction was active restored the OLD session's
    // draft into the NEW session's composer (acceptance run 20260610-173202,
    // F4). The container must not call setInput on these transitions at all.
    //
    // This only means anything with the real `useChatQueue` mounted (see the
    // mocks above): it owns every setInput call the container makes, so with it
    // stubbed the assertion could not have failed for any reason.
    const toolCall: ToolCallState = {
      toolCallId: 'tc-4',
      toolName: 'Write',
      input: '{}',
      status: 'pending',
      interactiveType: 'approval',
    };
    const setInput = vi.fn();

    // Session A: draft typed, then an interaction card swaps the composer out.
    const { rerender } = render(
      <ChatInputContainer {...baseProps} input="session-A draft" setInput={setInput} />
    );
    rerender(
      <ChatInputContainer
        {...baseProps}
        input="session-A draft"
        setInput={setInput}
        interaction={{ ...baseProps.interaction, active: toolCall }}
      />
    );
    // Operator switches to session B (no interaction, empty composer) while
    // A's interaction is still pending.
    rerender(
      <ChatInputContainer {...baseProps} sessionId="other-session" input="" setInput={setInput} />
    );

    expect(setInput).not.toHaveBeenCalled();
  });
});

describe('ChatInputContainer — a failed attachment blocks the send (DOR-480)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves the send enabled while every attachment is healthy', () => {
    render(<ChatInputContainer {...baseProps} input="have a look at this" />);
    expect(lastChatInputProps().canSubmit).toBe(true);
  });

  it('withholds the send while an attachment failed to upload', () => {
    // ComposerInput.test.tsx pins what canSubmit={false} does: the send button reads
    // disabled, Enter does not submit, and the textarea stays typeable — so the
    // person keeps their words instead of watching them go out attachment-less.
    render(
      <ChatInputContainer
        {...baseProps}
        input="have a look at this"
        fileUpload={{ ...baseProps.fileUpload, hasFailedUpload: true }}
      />
    );
    expect(lastChatInputProps().canSubmit).toBe(false);
  });

  it('blocks a hand-send from the queue too, and says why', () => {
    // Without this the click dequeues, the upload throws inside the flush, the
    // restore fires, and the person gets a generic "Could not send message" for
    // a cause that was on screen the whole time.
    useSessionStreamStore.getState().enqueueMessage('test-session', 'queued while busy');
    render(
      <ChatInputContainer
        {...baseProps}
        fileUpload={{ ...baseProps.fileUpload, hasFailedUpload: true }}
      />
    );

    const panelProps = vi.mocked(QueuePanel).mock.calls.at(-1)![0];
    expect(panelProps.sendBlockedReason).toBe('An attachment did not upload');
  });

  it('gives the composer a real name in the one mode where Enter stops meaning send', () => {
    // Editing returned '' for the placeholder, and that string is the field's
    // aria-label — so in the single mode whose behavior differs (Enter saves)
    // the composer announced nothing at all.
    useSessionStreamStore.getState().enqueueMessage('test-session', 'first queued');
    useSessionStreamStore.getState().enqueueMessage('test-session', 'second queued');
    render(<ChatInputContainer {...baseProps} />);

    expect(lastChatInputProps().placeholder).toBe('Send a message...');

    const panelProps = vi.mocked(QueuePanel).mock.calls.at(-1)![0];
    act(() => panelProps.onEdit(panelProps.queue[1]!.id));

    expect(lastChatInputProps().placeholder).toBe(
      'Edit queued message 2 of 2 — press Enter to save'
    );
    expect(lastChatInputProps().editingPosition).toBe(2);
  });

  it('draws the armed-to-clear readout in the overlay lane, above the queue rows', () => {
    // The composer owns when the arm is raised; this component owns where it
    // reads out. Anchored inside the composer it landed on the bottom queue
    // row's Send-now and Remove buttons (measured in a browser) — the one way
    // out of a queue the flush pump cannot drain. The lane floats above the
    // whole card, so nothing it contains can cover a control.
    useSessionStreamStore.getState().enqueueMessage('test-session', 'queued while armed');
    const { container } = render(<ChatInputContainer {...baseProps} />);

    expect(screen.queryByTestId('clear-armed-hint')).not.toBeInTheDocument();

    act(() => lastChatInputProps().onClearArmedChange!(true));

    const hint = screen.getByTestId('clear-armed-hint');
    expect(hint).toBeInTheDocument();
    // The lane, not the composer: `bottom-full` on the card is what puts it
    // clear of everything stacked inside.
    const lane = container.querySelector('.absolute.right-0.bottom-full.left-0');
    expect(lane).not.toBeNull();
    expect(lane!.contains(hint)).toBe(true);

    act(() => lastChatInputProps().onClearArmedChange!(false));
    expect(screen.queryByTestId('clear-armed-hint')).not.toBeInTheDocument();
  });

  it('keeps the queue panel out of the tree entirely when nothing is queued', () => {
    // The presence guard lives at the call site so AnimatePresence can watch the
    // panel leave; a panel that merely renders null never animates out.
    render(<ChatInputContainer {...baseProps} />);
    expect(vi.mocked(QueuePanel)).not.toHaveBeenCalled();
  });
});

describe('ChatInputContainer — sending takes the palette down with it (DOR-479)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // An open palette used to swallow Enter, and `onCommandSelect` closed the
  // panel on its way out after finding no row. Now that Enter falls through and
  // sends when there is nothing to pick, nothing else would take the "No
  // commands found." card down — `detectTrigger` only runs on typing or a caret
  // move — so it floated over the agent's reply until the next keystroke.
  it('dismisses the palettes when the composer submits', () => {
    const dismissPalettes = vi.fn();
    const handleSubmit = vi.fn();
    render(
      <ChatInputContainer
        {...baseProps}
        autocomplete={{ ...(baseProps.autocomplete as object), dismissPalettes } as never}
        handleSubmit={handleSubmit}
        input="/zzz"
      />
    );

    lastChatInputProps().onSubmit!();

    expect(dismissPalettes).toHaveBeenCalledOnce();
    expect(handleSubmit).toHaveBeenCalledOnce();
  });

  it('dismisses the palettes when the composer queues mid-stream', () => {
    const dismissPalettes = vi.fn();
    render(
      <ChatInputContainer
        {...baseProps}
        autocomplete={{ ...(baseProps.autocomplete as object), dismissPalettes } as never}
        status="streaming"
        input="/zzz"
      />
    );

    lastChatInputProps().onQueue!();

    expect(dismissPalettes).toHaveBeenCalledOnce();
  });
});
