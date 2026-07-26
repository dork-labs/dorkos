// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
// Mock child components to isolate ChatInputContainer behavior
vi.mock('../ui/input/ChatInput', () => ({
  ChatInput: vi.fn(() => <div data-testid="chat-input">ChatInput</div>),
}));

vi.mock('../ui/status/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status">ChatStatusSection</div>,
}));

vi.mock('../ui/input/FileChipBar', () => ({
  FileChipBar: vi.fn(() => <div data-testid="file-chips">FileChipBar</div>),
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

vi.mock('../model/use-chat-queue', () => ({
  useChatQueue: () => ({
    queue: [],
    editingIndex: null,
    sendBlockedReason: null,
    handleQueue: vi.fn(),
    handleQueueEdit: vi.fn(),
    handleQueueSaveEdit: vi.fn(),
    handleQueueCancelEdit: vi.fn(),
    handleQueueRemove: vi.fn(),
    handleQueueSend: vi.fn(),
    handleQueueNavigateUp: vi.fn(),
    handleQueueNavigateDown: vi.fn(),
  }),
}));

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

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null }),
  useAgentVisual: () => ({ color: '#3b82f6', emoji: '' }),
}));

vi.mock('@/layers/entities/session', () => ({
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
import { ChatInput } from '../ui/input/ChatInput';
import { QueuePanel } from '../ui/input/QueuePanel';
import type { ToolCallState } from '../model/chat-types';
import { createRef } from 'react';

/** Props the (mocked) ChatInput was last rendered with. */
function lastChatInputProps() {
  return vi.mocked(ChatInput).mock.calls.at(-1)![0];
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
    // ChatInput.test.tsx pins what canSubmit={false} does: the send button reads
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
    render(
      <ChatInputContainer
        {...baseProps}
        fileUpload={{ ...baseProps.fileUpload, hasFailedUpload: true }}
      />
    );

    const panelProps = vi.mocked(QueuePanel).mock.calls.at(-1)![0];
    expect(panelProps.sendBlockedReason).toBe('An attachment did not upload');
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
