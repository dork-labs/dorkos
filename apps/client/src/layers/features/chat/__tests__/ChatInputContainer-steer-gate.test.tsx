// @vitest-environment jsdom
/**
 * The Steer row, end to end, in the DOM (DOR-1268).
 *
 * `ChatInputContainer.test.tsx` proves what the container DECIDES — it reads the
 * props handed to a stubbed `Composer.Input`. That is the right shape for a
 * container test and it cannot see the thing a person actually experiences:
 * whether a Steer row is in the menu. So this file stubs nothing between the
 * decision and the markup. The real `Composer.Input`, the real split-action
 * button and the real `DispositionMenu` all run, and the assertion is a query
 * for the row itself.
 *
 * Two things are mocked, and neither is on the path under test. The menu's
 * portal primitives render inline (the pattern every other menu test here uses)
 * so the rows are in the tree without opening anything — the question is which
 * rows EXIST, not how Radix animates. And the container's read-hooks are
 * stubbed down to the two answers that decide this: what the runtime declares,
 * and what the session says about itself.
 */
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

// The menu's rows live behind a Radix portal that only mounts when opened.
// Rendered inline instead — `importActual` keeps every other shared/ui export
// real, because the composer's own chrome is on this path and must not be
// replaced by a stub.
vi.mock('@/layers/shared/ui', async (importActual) => {
  const actual = await importActual<typeof import('@/layers/shared/ui')>();
  return {
    ...actual,
    ResponsiveDropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ResponsiveDropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    ResponsiveDropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ResponsiveDropdownMenuItem: ({
      children,
      onSelect,
    }: {
      children: ReactNode;
      onSelect?: () => void;
    }) => (
      <button type="button" onClick={onSelect}>
        {children}
      </button>
    ),
  };
});

vi.mock('../ui/status/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status" />,
}));
vi.mock('../ui/input/QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('@/layers/features/ask', () => ({
  ApprovalPrompt: () => null,
  QuestionPrompt: () => null,
  AskStack: () => null,
  useAnswerAsk: () => ({
    answer: vi.fn(),
    answerAll: vi.fn(),
    isAnswering: false,
    error: null,
  }),
  groupAsks: () => [],
}));
vi.mock('@/layers/features/commands', () => ({ CommandPalette: () => null }));
vi.mock('@/layers/features/files', () => ({ FilePalette: () => null }));
vi.mock('react-dropzone', () => ({
  useDropzone: () => ({ getRootProps: () => ({}), getInputProps: () => ({}), isDragActive: false }),
}));
vi.mock('../model/use-background-tasks', () => ({ useBackgroundTasks: () => [] }));
// Partial: the real composer reads pointer/viewport hooks from this barrel, and
// replacing the whole thing would take the component under test down with it.
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useAppStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ isTextStreaming: false })
  ),
  useTransport: () => ({ stopTask: vi.fn() }),
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

// A steer-CAPABLE runtime throughout. That is the whole point: every case below
// keeps `supportsSteer: true`, so the only thing that can move the Steer row is
// the session's own answer.
vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: () => ({ supportsSteer: true, supportsContextStaging: true }),
}));

import { ChatInputContainer } from '../ui/input/ChatInputContainer';
import { useSessionStreamStore, useSessionChatStore } from '@/layers/entities/session';

// A plain desktop — the composer reads pointer capabilities to decide what Enter
// means, and a coarse pointer hides the chords this menu sits beside.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
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
});

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionChatStore.setState({ sessions: {} });
});
afterEach(() => cleanup());

/** The server's per-session verdict, as a `status_change` on the durable stream. */
function seedSteerable(steerable: boolean) {
  useSessionStreamStore
    .getState()
    .applyEvent('test-session', { seq: 1, type: 'status_change', status: { steerable } });
}

const baseProps = {
  chatInputRef: React.createRef<null>(),
  // A turn is RUNNING and there is text to send — the only state in which the
  // composer offers any of this. Idle shows a plain Send and no caret at all.
  input: 'Also check the tests',
  status: 'streaming' as const,
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
  enqueueContent: vi.fn().mockResolvedValue(true),
  steerContent: vi.fn().mockResolvedValue(true),
  addContextContent: vi.fn().mockResolvedValue(true),
  tryNativeCommand: vi.fn(() => ({ handled: false }) as const),
  commandPending: false,
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
  sync: { connectionState: 'connected' as const },
};

/** The Steer row, if the composer offered one. */
function steerRow() {
  return screen.queryByRole('button', { name: 'Steer' });
}

/** The Add context row, if the composer offered one. */
function addContextRow() {
  return screen.queryByRole('button', { name: 'Add context' });
}

describe('the Steer row is in the DOM only when this chat could really cut in', () => {
  it('is absent on a steer-capable runtime whose session cannot cut in (DOR-1268)', () => {
    seedSteerable(false);
    render(<ChatInputContainer {...baseProps} />);

    // The caret is still there — Add context needs no open turn to join, so the
    // menu is not empty. What is gone is the promise that could not be kept.
    expect(screen.getByRole('button', { name: 'More ways to send' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add context' })).toBeTruthy();
    expect(steerRow()).toBeNull();
  });

  it('is present when the session says it can cut in', () => {
    seedSteerable(true);
    render(<ChatInputContainer {...baseProps} />);
    expect(steerRow()).toBeTruthy();
  });

  it('is present when the session gives no answer, deferring to the runtime', () => {
    // Absent means "no per-session answer" — a runtime whose steering is uniform
    // never sets the field, and reading its silence as "no" would hide a row
    // that works.
    render(<ChatInputContainer {...baseProps} />);
    expect(steerRow()).toBeTruthy();
  });
});

describe('the Add context row stays offered on both paths (DOR-1307)', () => {
  // Steer and Add context are gated differently ON PURPOSE, and the difference
  // is what each `false` costs the person. A steer that cannot cut in is a dead
  // button, so the row goes. A stage that cannot reach the transcript is FOLDED
  // into the next turn and lands anyway, so hiding the row would take away
  // something that works. The fix for DOR-1307 was in the server's routing, not
  // in what the composer offers, and these two cases hold that line: they go red
  // if a later change gates Add context on the same per-session answer as Steer.
  it('is offered on the resume path, where a stage folds into the next turn', () => {
    seedSteerable(false);
    render(<ChatInputContainer {...baseProps} />);

    expect(addContextRow()).toBeTruthy();
    // The pairing is the point: same session, same instant, one row gone and the
    // other kept.
    expect(steerRow()).toBeNull();
  });

  it('is offered on a session holding its agent open, where a stage lands natively', () => {
    seedSteerable(true);
    render(<ChatInputContainer {...baseProps} />);

    expect(addContextRow()).toBeTruthy();
    expect(steerRow()).toBeTruthy();
  });
});
