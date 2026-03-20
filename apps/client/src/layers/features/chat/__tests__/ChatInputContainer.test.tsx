// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
// Mock child components to isolate ChatInputContainer behavior
vi.mock('../ui/ChatInput', () => ({
  ChatInput: vi.fn(() => <div data-testid="chat-input">ChatInput</div>),
}));

vi.mock('../ui/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status">ChatStatusSection</div>,
}));

vi.mock('../ui/FileChipBar', () => ({
  FileChipBar: () => <div data-testid="file-chips">FileChipBar</div>,
}));

vi.mock('../ui/QueuePanel', () => ({
  QueuePanel: () => <div data-testid="queue-panel">QueuePanel</div>,
}));

vi.mock('../ui/ToolApproval', () => ({
  ToolApproval: vi.fn(({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="tool-approval">ToolApproval-{toolCallId}</div>
  )),
}));

vi.mock('../ui/QuestionPrompt', () => ({
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

vi.mock('@/layers/shared/model', () => ({
  useAppStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ isTextStreaming: false })
  ),
}));

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null }),
  useAgentVisual: () => ({ color: '#3b82f6', emoji: '' }),
}));

vi.mock('@/layers/entities/session', () => ({
  useDirectoryState: () => [null, vi.fn()],
}));

import { ChatInputContainer } from '../ui/ChatInputContainer';
import type { ToolCallState } from '../model/chat-types';
import { createRef } from 'react';

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
    handleChipClick: vi.fn(),
    dismissPalettes: vi.fn(),
    isPaletteOpen: false,
    activeDescendantId: undefined,
  } as never,
  handleSubmit: vi.fn(),
  status: 'idle' as const,
  sessionBusy: false,
  stop: vi.fn(),
  setInput: vi.fn(),
  sessionId: 'test-session',
  sessionStatus: null,
  pendingFiles: [],
  onFilesSelected: vi.fn(),
  onFileRemove: vi.fn(),
  isUploading: false,
  queue: [],
  editingIndex: null,
  onQueue: vi.fn(),
  onQueueRemove: vi.fn(),
  onQueueEdit: vi.fn(),
  onQueueSaveEdit: vi.fn(),
  onQueueCancelEdit: vi.fn(),
  onQueueNavigateUp: vi.fn(),
  onQueueNavigateDown: vi.fn(),
  presenceInfo: null,
  presencePulse: false,
  activeInteraction: null,
  focusedOptionIndex: 0,
  onToolRef: vi.fn(),
  onToolDecided: vi.fn(),
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
    const interaction: ToolCallState = {
      toolCallId: 'tc-1',
      toolName: 'Write',
      input: '{}',
      status: 'pending',
      interactiveType: 'approval',
    };
    render(<ChatInputContainer {...baseProps} activeInteraction={interaction} />);
    expect(screen.getByTestId('tool-approval')).toBeInTheDocument();
    expect(screen.getByText('ToolApproval-tc-1')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
  });

  it('renders QuestionPrompt in interactive mode for question type', () => {
    const interaction: ToolCallState = {
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
    render(<ChatInputContainer {...baseProps} activeInteraction={interaction} />);
    expect(screen.getByTestId('question-prompt')).toBeInTheDocument();
    expect(screen.getByText('QuestionPrompt-tc-2')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
  });

  it('hides normal-mode elements during interactive mode', () => {
    const interaction: ToolCallState = {
      toolCallId: 'tc-3',
      toolName: 'Write',
      input: '{}',
      status: 'pending',
      interactiveType: 'approval',
    };
    render(<ChatInputContainer {...baseProps} activeInteraction={interaction} />);
    expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-panel')).not.toBeInTheDocument();
  });
});
