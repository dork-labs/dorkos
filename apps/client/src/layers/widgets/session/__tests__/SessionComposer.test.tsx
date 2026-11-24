// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
const { mockLimitComposer } = vi.hoisted(() => ({
  mockLimitComposer: vi.fn(() => ({ canSubmit: true, placeholder: null as string | null })),
}));
vi.mock('@/layers/features/browser-handoff', () => ({ BrowserHandoffCard: () => null }));
vi.mock('@/layers/features/continue-on-account', () => ({
  AccountLimitBanner: () => null,
  AccountLimitMarker: () => null,
  useLimitComposer: mockLimitComposer,
  useSessionHasLimit: () => false,
}));

vi.mock('@/layers/features/composer', async (importActual) => {
  const actual = await importActual<typeof import('@/layers/features/composer')>();
  return {
    Composer: {
      Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      OverlayLane: actual.Composer.OverlayLane,
      Input: vi.fn(() => <div data-testid="chat-input">Composer.Input</div>),
      Attachments: vi.fn(() => <div data-testid="file-chips">Composer.Attachments</div>),
      ClearArmedHint: actual.Composer.ClearArmedHint,
    },
  };
});

vi.mock('@/layers/features/chat/ui/status/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status">ChatStatusSection</div>,
}));

vi.mock('@/layers/features/chat/ui/input/QueuePanel', () => ({
  QueuePanel: vi.fn(() => <div data-testid="queue-panel">QueuePanel</div>),
}));

vi.mock('@/layers/features/ask', () => ({
  ApprovalPrompt: vi.fn(({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="tool-approval">ToolApproval-{toolCallId}</div>
  )),
  QuestionPrompt: vi.fn(({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="question-prompt">QuestionPrompt-{toolCallId}</div>
  )),
  AskStack: () => null,
  useAnswerAsk: () => ({
    answer: vi.fn(),
    answerAll: vi.fn(),
    isAnswering: false,
    error: null,
  }),
  groupAsks: () => [],
}));

vi.mock('@/layers/features/slash-commands', () => ({
  SlashCommandList: () => null,
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

// `useChatQueue` is deliberately NOT mocked: it is the only thing that writes the
// composer, so stubbing it would make the cross-session guards unfalsifiable.
vi.mock('@/layers/features/chat/model/use-background-tasks', () => ({
  useBackgroundTasks: () => [],
}));

const mockTransport = vi.hoisted(() => ({
  stopTask: vi.fn(),
  updateQueuedMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/layers/shared/model', () => ({
  useAppStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ isTextStreaming: false })
  ),
  useTransport: () => mockTransport,
}));

const mockComposerRichText = vi.fn(() => false);
vi.mock('@/layers/entities/config', () => ({
  useComposerRichText: () => mockComposerRichText(),
}));

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

const mockCapabilities = vi.hoisted(() => ({
  value: { supportsSteer: true, supportsContextStaging: true } as
    { supportsSteer: boolean; supportsContextStaging: boolean } | undefined,
}));
vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: () => mockCapabilities.value,
}));

import { SessionComposerBench } from '@/test-helpers/session-composer';
import type { StopOutcome } from '@/layers/features/chat';
import { Composer } from '@/layers/features/composer';
import { QueuePanel } from '@/layers/features/chat/ui/input/QueuePanel';
import { useSessionStreamStore, useSessionChatStore } from '@/layers/entities/session';
import type { ToolCallState } from '@/layers/shared/model/chat-message-types';
import { createRef, useCallback, type ComponentProps } from 'react';

function ControlledStopComposer(
  props: Omit<ComponentProps<typeof SessionComposerBench>, 'input' | 'setInput'>
) {
  const sessionId = props.sessionId ?? 'test-session';
  const input = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.input ?? '', [sessionId])
  );
  const setInput = useCallback(
    (value: string) => {
      useSessionChatStore.getState().updateSession(sessionId, { input: value });
    },
    [sessionId]
  );
  return (
    <SessionComposerBench {...props} sessionId={sessionId} input={input} setInput={setInput} />
  );
}

/** Props the (mocked) `Composer.Input` was last rendered with. */
function lastChatInputProps() {
  return vi.mocked(Composer.Input).mock.calls.at(-1)![0];
}

function seedQueue(...contents: string[]) {
  const store = useSessionStreamStore.getState();
  store.applyEvent('test-session', {
    seq: 1,
    type: 'status_change',
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'streaming',
      lastError: null,
    },
  });
  store.applyEvent('test-session', {
    seq: 2,
    type: 'queue_update',
    queue: contents.map((content, i) => ({
      id: `q${i}`,
      content,
      disposition: 'queue' as const,
      enqueuedAt: 1_000,
      enqueuedBy: 'window-a',
    })),
  });
}

function seedSteerable(steerable: boolean) {
  useSessionStreamStore
    .getState()
    .applyEvent('test-session', { seq: 3, type: 'status_change', status: { steerable } });
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
  steerContent: vi.fn().mockResolvedValue(true),
  addContextContent: vi.fn().mockResolvedValue(true),
  tryNativeCommand: vi.fn(() => ({ handled: false }) as const),
  commandPending: false,
  status: 'idle' as const,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockCapabilities.value = { supportsSteer: true, supportsContextStaging: true };
  mockTransport.updateQueuedMessage.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionChatStore.setState({ sessions: {} });
});

describe('SessionComposer mode switching', () => {
  it('never writes to the composer input on interactive-mode transitions (F4)', () => {
    // F4: switching sessions mid-interaction once restored the old session's draft.
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
      <SessionComposerBench {...baseProps} input="session-A draft" setInput={setInput} />
    );
    rerender(
      <SessionComposerBench
        {...baseProps}
        input="session-A draft"
        setInput={setInput}
        interaction={{ ...baseProps.interaction, active: toolCall }}
      />
    );
    // Operator switches to session B (no interaction, empty composer) while
    // A's interaction is still pending.
    rerender(
      <SessionComposerBench {...baseProps} sessionId="other-session" input="" setInput={setInput} />
    );

    expect(setInput).not.toHaveBeenCalled();
  });
});

describe('SessionComposer — a failed attachment blocks the send (DOR-480)', () => {
  it('withholds the send while an attachment failed to upload', () => {
    render(
      <SessionComposerBench
        {...baseProps}
        input="have a look at this"
        fileUpload={{ ...baseProps.fileUpload, hasFailedUpload: true }}
      />
    );
    expect(lastChatInputProps().canSubmit).toBe(false);
  });
});

describe('SessionComposer — sending takes the palette down with it (DOR-479)', () => {
  // An open palette floated over the reply after Enter sent the draft.
  it('dismisses the palettes when the composer submits, and sends the draft through the target', () => {
    const dismissPalettes = vi.fn();
    const submit = vi.fn();
    render(
      <SessionComposerBench
        {...baseProps}
        autocomplete={{ ...(baseProps.autocomplete as object), dismissPalettes } as never}
        submit={submit}
        input="/zzz"
      />
    );

    lastChatInputProps().onSubmit!();

    expect(dismissPalettes).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith('/zzz');
  });
});

describe('SessionComposer — the composer only gets the verbs the runtime honours', () => {
  it('withholds Steer when THIS session cannot cut in, however capable the runtime is (DOR-1268)', () => {
    seedSteerable(false);
    render(<SessionComposerBench {...baseProps} status="streaming" input="Also check the tests" />);
    const props = lastChatInputProps();
    expect(props.onSteer).toBeUndefined();
    // Add context is untouched by this — it needs no open turn to join.
    expect(props.onStage).toBeInstanceOf(Function);
  });
});

describe('SessionComposer — Stop clears the queue (task 4.7)', () => {
  it('preserves text typed WHILE the Stop is in flight, appending the cleared messages after it', async () => {
    // The data-safety guarantee stated directly: a person who keeps typing during
    // the interrupt round-trip must not lose those words, and the cleared messages
    // must land AFTER them. restoreToComposer reads the LIVE composer text from
    // the store, not a snapshot from before `stop()`; the store update below stands
    // in for that mid-flight typing. Reads a stale empty `input` closure ⇒ result
    // is just the messages (no draft); overwrites ⇒ the draft is gone — both red.
    seedQueue('one', 'two');
    const stop = vi.fn().mockImplementation(async () => {
      // The person types into the composer while the interrupt is in flight.
      act(() => {
        useSessionChatStore.getState().updateSession('test-session', {
          input: 'a thought I had mid-stop',
        });
      });
      return {
        ok: true,
        cancelled: [
          { id: 'q0', content: 'one', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
          { id: 'q1', content: 'two', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
        ],
      };
    });
    const setInput = vi.fn();
    render(
      <SessionComposerBench {...baseProps} stop={stop} setInput={setInput} status="streaming" />
    );

    await act(async () => {
      lastChatInputProps().onStop!();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });

    // Typed text first, then the cleared messages after it — nothing clobbered.
    await waitFor(() =>
      expect(setInput).toHaveBeenCalledWith('a thought I had mid-stop\n\none\n\ntwo')
    );
  });
});

describe('SessionComposer — Stop trusts the local rewrite over the queue PATCH (DOR-1323 fix round)', () => {
  // The PATCH races the interrupt's queue cancellation; a store-backed input
  // (ControlledStopComposer) is required, or commitEditInPlace never fires.

  /** Open the second queued row's edit and overwrite its text. */
  function editSecondRowAndRewrite(rewrite: string): void {
    const panelProps = vi.mocked(QueuePanel).mock.calls.at(-1)![0];
    act(() => panelProps.onEdit(panelProps.queue[1]!.id));
    act(() => {
      useSessionChatStore.getState().updateSession('test-session', { input: rewrite });
    });
  }

  it('PATCH loses: still restores the rewrite, not the stale pre-edit text, when the commit has not landed by the time Stop reports', async () => {
    seedQueue('one', 'two');
    act(() => {
      useSessionChatStore.getState().updateSession('test-session', { input: 'hello draft' });
    });
    mockTransport.updateQueuedMessage.mockImplementation(() => new Promise<void>(() => {}));
    const stop = vi.fn().mockResolvedValue({
      ok: true,
      cancelled: [
        { id: 'q0', content: 'one', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
        // Stale: the server's snapshot predates the PATCH.
        { id: 'q1', content: 'two', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
      ],
    });
    render(<ControlledStopComposer {...baseProps} stop={stop} status="streaming" />);

    editSecondRowAndRewrite('TWO REWRITTEN');

    await act(async () => {
      lastChatInputProps().onStop!();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });

    expect(mockTransport.updateQueuedMessage).toHaveBeenCalledWith('test-session', 'q1', {
      content: 'TWO REWRITTEN',
    });
    await waitFor(() =>
      expect(useSessionChatStore.getState().getSession('test-session').input).toBe(
        'hello draft\n\none\n\nTWO REWRITTEN'
      )
    );
  });

  it('still hands the parked draft back when the edited row left the queue first (DOR-1442)', async () => {
    // editingIndex goes null once the edited row leaves the queue; Stop must
    // still hand the parked draft back.
    seedQueue('one', 'two');
    act(() => {
      useSessionChatStore.getState().updateSession('test-session', { input: 'hello draft' });
    });
    const stop = vi.fn().mockResolvedValue({
      receipt: { outcome: 'acked' as const, runtime: 'claude-code' },
      cancelled: [],
    });
    render(<ControlledStopComposer {...baseProps} stop={stop} status="streaming" />);

    editSecondRowAndRewrite('TWO REWRITTEN');

    act(() => {
      useSessionStreamStore.getState().applyEvent('test-session', {
        seq: 4,
        type: 'queue_update',
        queue: [
          {
            id: 'q0',
            content: 'one',
            disposition: 'queue',
            enqueuedAt: 1_000,
            enqueuedBy: 'window-a',
          },
        ],
      });
    });

    await act(async () => {
      lastChatInputProps().onStop!();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });

    await waitFor(() =>
      expect(useSessionChatStore.getState().getSession('test-session').input).toBe('hello draft')
    );
  });
});

describe('SessionComposer — Stop acknowledges instantly and cannot double-fire (DOR-1300)', () => {
  it('goes pending the instant Stop is clicked, and calls interrupt exactly once even if pressed again mid-flight', async () => {
    let resolveStop!: (v: StopOutcome) => void;
    const stop = vi.fn(
      () =>
        new Promise<StopOutcome>((resolve) => {
          resolveStop = resolve;
        })
    );
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    act(() => {
      lastChatInputProps().onStop!();
    });
    expect(lastChatInputProps().stopPending).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);

    // A second click while the first interrupt is still in flight is a no-op:
    // remove the single-flight guard in `handleStop` and this count goes to 2.
    act(() => {
      lastChatInputProps().onStop!();
    });
    expect(stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStop({
        receipt: { outcome: 'acked' as const, runtime: 'claude-code' },
        cancelled: [],
      });
    });
  });
});

describe('SessionComposer — the Stop question goes away when its queue does (DOR-1443)', () => {
  /**
   * The server dispatching everything that was waiting, while the confirm is
   * on screen — a `queue_update` carrying an empty queue, exactly the event
   * the pump sends.
   */
  function drainQueue() {
    useSessionStreamStore
      .getState()
      .applyEvent('test-session', { seq: 3, type: 'queue_update', queue: [] });
  }

  it('closes itself once the queued messages it asked about have all dispatched', async () => {
    const stop = vi.fn().mockResolvedValue({
      receipt: { outcome: 'acked' as const, runtime: 'claude-code' },
      cancelled: [],
    });
    seedQueue('one', 'two');
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    await act(async () => {
      lastChatInputProps().onStop!();
    });
    expect(screen.getByText('Stop, and put 2 queued messages back?')).toBeInTheDocument();

    await act(async () => {
      drainQueue();
    });

    expect(screen.queryByText(/queued message/)).not.toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();
  });
});
