// @vitest-environment jsdom
/**
 * The composer under a chat drawn as a DM (DOR-3074): the room's box, with no
 * status line under it and no rotating hints in it, and slash commands kept.
 */
import React, { createRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/layers/features/continue-on-account', () => ({
  AccountLimitBanner: () => null,
  AccountLimitMarker: () => null,
  useLimitComposer: () => ({ canSubmit: true, placeholder: null }),
  useSessionHasLimit: () => false,
}));
vi.mock('@/layers/features/composer', async (importActual) => {
  const actual = await importActual<typeof import('@/layers/features/composer')>();
  return {
    Composer: {
      Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      OverlayLane: actual.Composer.OverlayLane,
      Input: vi.fn(() => <div data-testid="chat-input" />),
      Attachments: () => null,
      ClearArmedHint: actual.Composer.ClearArmedHint,
    },
  };
});
vi.mock('@/layers/features/chat/ui/status/ChatStatusSection', () => ({
  ChatStatusSection: ({ lineHidden }: { lineHidden?: boolean }) => (
    <div data-testid="chat-status" data-line-hidden={String(lineHidden === true)} />
  ),
}));
vi.mock('@/layers/features/slash-commands', () => ({
  SlashCommandList: () => <div data-testid="slash-commands" />,
}));
vi.mock('@/layers/features/files', () => ({ FilePalette: () => null }));
vi.mock('react-dropzone', () => ({
  useDropzone: () => ({ getRootProps: () => ({}), getInputProps: () => ({}), isDragActive: false }),
}));
vi.mock('@/layers/features/chat/model/use-background-tasks', () => ({
  useBackgroundTasks: () => [],
}));
vi.mock('@/layers/shared/model', () => ({
  useAppStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ isTextStreaming: false })
  ),
  useTransport: () => ({ stopTask: vi.fn(), updateQueuedMessage: vi.fn() }),
}));
vi.mock('@/layers/entities/config', () => ({ useComposerRichText: () => false }));
vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null }),
  useAgentVisual: () => ({ color: '#3b82f6', emoji: '' }),
}));
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useDirectoryState: () => [null, vi.fn()],
  useSessionChatState: () => ({ messages: [] }),
  useSessionRuntime: () => 'claude-code',
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
vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: () => ({ supportsSteer: true, supportsContextStaging: true }),
}));

import { SessionComposerBench } from '@/test-helpers/session-composer';
import { Composer } from '@/layers/features/composer';

const baseProps = {
  chatInputRef: createRef<null>(),
  input: '',
  autocomplete: {
    commands: { show: true, filtered: [], selectedIndex: -1 },
    files: { show: false, filtered: [], selectedIndex: -1 },
    handleInputChange: vi.fn(),
    handleCommandSelect: vi.fn(),
    handleFileSelect: vi.fn(),
    handleArrowUp: vi.fn(),
    handleArrowDown: vi.fn(),
    handleKeyboardSelect: vi.fn(),
    handleCursorChange: vi.fn(),
    dismissPalettes: vi.fn(),
    isPaletteOpen: true,
    activeDescendantId: undefined,
  } as never,
  steerContent: vi.fn().mockResolvedValue(true),
  addContextContent: vi.fn().mockResolvedValue(true),
  tryNativeCommand: vi.fn(() => ({ handled: false }) as const),
  commandPending: false,
  status: 'idle' as const,
  stop: vi.fn(),
  setInput: vi.fn(),
  sessionId: 'test-session',
  sessionStatus: null,
  interaction: {
    active: null,
    pendingApprovals: [],
    focusedOptionIndex: 0,
    onToolRef: vi.fn(),
    onToolDecided: vi.fn(),
  },
  sync: { connectionState: 'connected' as const },
};

/** Props the (mocked) `Composer.Input` was last rendered with. */
function lastInputProps() {
  return vi.mocked(Composer.Input).mock.calls.at(-1)![0] as {
    placeholderOverlay?: unknown;
    placeholder?: string;
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SessionComposer as a DM', () => {
  it('draws no status line and no rotating hints, and keeps slash commands', () => {
    render(<SessionComposerBench {...baseProps} asDirectMessage />);

    expect(screen.getByTestId('chat-status')).toHaveAttribute('data-line-hidden', 'true');
    expect(lastInputProps().placeholderOverlay).toBeNull();
    expect(screen.getByTestId('slash-commands')).toBeInTheDocument();
  });

  it('is today’s composer without it', () => {
    render(<SessionComposerBench {...baseProps} />);

    expect(screen.getByTestId('chat-status')).toHaveAttribute('data-line-hidden', 'false');
    expect(lastInputProps().placeholderOverlay).not.toBeNull();
  });
});
