// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
// Mock child components to isolate SessionComposer behavior
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
vi.mock('@/layers/features/chat/model/use-background-tasks', () => ({
  useBackgroundTasks: () => [],
}));

// Hoisted (not a bare object literal) so the Stop-vs-PATCH-race suite below can
// swap `updateQueuedMessage`'s implementation per test — a promise it resolves
// or rejects on its own schedule, to drive the PATCH-wins/PATCH-loses ordering
// against Stop's `outcome.cancelled` independently. Every other suite in this
// file only needs it to exist.
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

// Only the read-hooks the container itself calls are stubbed. Everything else —
// the session stores, `useSessionQueue`, `useSessionAwaitingDecision` — stays
// real, so the un-mocked `useChatQueue` above operates on real state.
// `useSessionRuntime` is stubbed to a fixed runtime so its real body does not
// reach the session-list search chain this file does not mount.
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

// What the resolved runtime can do mid-turn. Mutable so a test can model a
// steer-capable runtime (claude-code) or a queue-only one (codex/opencode) and
// assert the container hides the extras rather than greying them.
const mockCapabilities = vi.hoisted(() => ({
  value: { supportsSteer: true, supportsContextStaging: true } as
    | { supportsSteer: boolean; supportsContextStaging: boolean }
    | undefined,
}));
vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: () => mockCapabilities.value,
}));

import { SessionComposerBench } from '@/test-helpers/session-composer';
import { Composer } from '@/layers/features/composer';
import { QueuePanel } from '@/layers/features/chat/ui/input/QueuePanel';
import { useSessionStreamStore, useSessionChatStore } from '@/layers/entities/session';
import type { ToolCallState } from '@/layers/shared/model/chat-message-types';
import { createRef, useCallback, type ComponentProps } from 'react';

/**
 * The composer's `input`/`setInput` wired THROUGH the real per-session store —
 * exactly the pairing `ChatPanel` hands it (`useSessionStoreActions.setInput`
 * is `(value) => useSessionChatStore.getState().updateSession(sid, { input:
 * value })`, and `input` is that same session's live field). Every other test
 * in this file passes a static `input` string and a bare `vi.fn()` `setInput`
 * — a faithful stand-in for "what did the container tell its parent to do,"
 * but blind to what the container's OWN reads and writes do to the store in
 * between (DOR-1323 fix-round finding 2): `commitEditInPlace`'s early-return
 * on an empty `input` never fires here, because `input` genuinely tracks what
 * was last written, so a mutant that deleted the commit call is NOT reachable
 * from this bench alone.
 */
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

/**
 * Put messages on the session's queue the way the server does — a `queue_update`
 * on the durable stream — with the session streaming, because a queue is only
 * WAITING while there is a turn to wait behind.
 */
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

/**
 * Publish the server's per-session answer to "could a message sent now cut into
 * this session's live turn" — a `status_change` on the durable stream, exactly
 * as the dispatcher sends it (DOR-1268).
 */
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

afterEach(() => {
  cleanup();
  // The stream store is module state shared across tests — a queue seeded by one
  // case must not decide whether the panel renders in the next.
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  // The chat store holds composer drafts; a draft seeded by one case must not
  // leak into the next (the Stop-restore cases below write it).
  useSessionChatStore.setState({ sessions: {} });
});

describe('SessionComposer mode switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders normal mode when no activeInteraction', () => {
    render(<SessionComposerBench {...baseProps} />);
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
    render(<SessionComposerBench {...baseProps} />);
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
      <SessionComposerBench
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
      <SessionComposerBench
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
      <SessionComposerBench
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves the send enabled while every attachment is healthy', () => {
    render(<SessionComposerBench {...baseProps} input="have a look at this" />);
    expect(lastChatInputProps().canSubmit).toBe(true);
  });

  it('withholds the send while an attachment failed to upload', () => {
    // ComposerInput.test.tsx pins what canSubmit={false} does: the send button reads
    // disabled, Enter does not submit, and the textarea stays typeable — so the
    // person keeps their words instead of watching them go out attachment-less.
    render(
      <SessionComposerBench
        {...baseProps}
        input="have a look at this"
        fileUpload={{ ...baseProps.fileUpload, hasFailedUpload: true }}
      />
    );
    expect(lastChatInputProps().canSubmit).toBe(false);
  });

  it('gives the composer a real name in the one mode where Enter stops meaning send', () => {
    // Editing returned '' for the placeholder, and that string is the field's
    // aria-label — so in the single mode whose behavior differs (Enter saves)
    // the composer announced nothing at all.
    seedQueue('first queued', 'second queued');
    render(<SessionComposerBench {...baseProps} />);

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
    seedQueue('queued while armed');
    const { container } = render(<SessionComposerBench {...baseProps} />);

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

  it('closes the box and names the way out when no conversation is selected', () => {
    // The Obsidian embed's first load, exactly: `app-store` seeds
    // `sessionId: null`, nothing auto-mints one, and the composer is on screen
    // the whole time. Enter used to reach `postMessage(null, …)`, which the
    // route answers `400 INVALID_SESSION_ID` — after the composer had already
    // been emptied, so the words were gone and all that came back was "Could
    // not send message".
    //
    // **Seeded defect:** put `canSend: true` back in `useSessionTarget` and
    // this goes red on both assertions.
    render(<SessionComposerBench {...baseProps} sessionId="" input="hello?" />);

    const props = lastChatInputProps();
    expect(props.canSubmit).toBe(false);
    // Its own sentence, never the room's "Still opening this conversation…":
    // nothing is opening, and there is a way out to name.
    expect(props.canSubmitReason).toBe('Pick a conversation, or start a new one.');
  });

  it('sends nothing at all when no conversation is selected', () => {
    // The other half: the reason is drawn AND the send is genuinely closed.
    // Reason-without-refusal would be a label over a live box.
    const submit = vi.fn();
    const enqueue = vi.fn().mockResolvedValue(true);
    render(
      <SessionComposerBench
        {...baseProps}
        sessionId=""
        input="hello?"
        submit={submit}
        enqueue={enqueue}
      />
    );

    lastChatInputProps().onSubmit!();

    expect(submit).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps the queue panel out of the tree entirely when nothing is queued', () => {
    // The presence guard lives at the call site so AnimatePresence can watch the
    // panel leave; a panel that merely renders null never animates out.
    render(<SessionComposerBench {...baseProps} />);
    expect(vi.mocked(QueuePanel)).not.toHaveBeenCalled();
  });
});

describe('SessionComposer — sending takes the palette down with it (DOR-479)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // An open palette used to swallow Enter, and `onCommandSelect` closed the
  // panel on its way out after finding no row. Now that Enter falls through and
  // sends when there is nothing to pick, nothing else would take the "No
  // commands found." card down — `detectTrigger` only runs on typing or a caret
  // move — so it floated over the agent's reply until the next keystroke.
  it('dismisses the palettes when the composer submits, and sends the draft through the target', () => {
    // **Seeded defect:** point `submitAndDismiss` back at a `handleSubmit` prop
    // and `submit` is never called with the draft — the port would be bypassed
    // again, which is exactly what Known Issue 28 was. Run and red.
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

  it('dismisses the palettes when the composer queues mid-stream, and holds the draft through the target', async () => {
    // **Seeded defect:** give `useChatQueue` any `onEnqueue` other than the one
    // that calls `target.queue` and this goes red — the bench hands `enqueue`
    // to the TARGET and to nothing else, so the only way it can be reached is
    // through the port. That is the whole of Known Issue 28.
    const dismissPalettes = vi.fn();
    const enqueue = vi.fn().mockResolvedValue(true);
    render(
      <SessionComposerBench
        {...baseProps}
        autocomplete={{ ...(baseProps.autocomplete as object), dismissPalettes } as never}
        enqueue={enqueue}
        status="streaming"
        input="/zzz"
      />
    );

    await act(async () => {
      lastChatInputProps().onQueue!();
    });

    expect(dismissPalettes).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('/zzz');
  });
});

describe('SessionComposer — the composer only gets the verbs the runtime honours', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCapabilities.value = { supportsSteer: true, supportsContextStaging: true };
  });

  it('passes Steer and Add context when the runtime declares both (claude-code)', () => {
    render(<SessionComposerBench {...baseProps} status="streaming" input="Also check the tests" />);
    const props = lastChatInputProps();
    expect(props.onSteer).toBeInstanceOf(Function);
    expect(props.onStage).toBeInstanceOf(Function);
  });

  it('withholds BOTH on a queue-only runtime (codex / opencode)', () => {
    mockCapabilities.value = { supportsSteer: false, supportsContextStaging: false };
    render(<SessionComposerBench {...baseProps} status="streaming" input="Also check the tests" />);
    const props = lastChatInputProps();
    // Absent, not a no-op function the composer would then have to hide itself.
    expect(props.onSteer).toBeUndefined();
    expect(props.onStage).toBeUndefined();
  });

  it('withholds each verb independently', () => {
    mockCapabilities.value = { supportsSteer: true, supportsContextStaging: false };
    render(<SessionComposerBench {...baseProps} status="streaming" input="Also check the tests" />);
    const props = lastChatInputProps();
    expect(props.onSteer).toBeInstanceOf(Function);
    expect(props.onStage).toBeUndefined();
  });

  it('withholds both while the capabilities map is still loading', () => {
    mockCapabilities.value = undefined;
    render(<SessionComposerBench {...baseProps} status="streaming" input="Also check the tests" />);
    const props = lastChatInputProps();
    expect(props.onSteer).toBeUndefined();
    expect(props.onStage).toBeUndefined();
  });

  it('withholds Steer when THIS session cannot cut in, however capable the runtime is (DOR-1268)', () => {
    // claude-code declares steering for the adapter; a session that starts a
    // fresh agent process per message still has nothing to cut into. Offering
    // Steer here promised a cut-in and delivered an ordinary follow-up turn.
    seedSteerable(false);
    render(<SessionComposerBench {...baseProps} status="streaming" input="Also check the tests" />);
    const props = lastChatInputProps();
    expect(props.onSteer).toBeUndefined();
    // Add context is untouched by this — it needs no open turn to join.
    expect(props.onStage).toBeInstanceOf(Function);
  });

  it('offers Steer when the session says it can cut in', () => {
    seedSteerable(true);
    render(<SessionComposerBench {...baseProps} status="streaming" input="Also check the tests" />);
    expect(lastChatInputProps().onSteer).toBeInstanceOf(Function);
  });

  it('falls back to the runtime flag when the session gives no answer', () => {
    // A runtime whose steering is uniform across sessions never sets the field.
    // Reading its silence as "no" would hide a capability that works.
    render(<SessionComposerBench {...baseProps} status="streaming" input="Also check the tests" />);
    expect(lastChatInputProps().onSteer).toBeInstanceOf(Function);
  });

  it('routes the composer Steer action through the steer delivery, and clears', async () => {
    const steerContent = vi.fn().mockResolvedValue(true);
    const setInput = vi.fn();
    render(
      <SessionComposerBench
        {...baseProps}
        steerContent={steerContent}
        setInput={setInput}
        status="streaming"
        input="Also check the tests"
      />
    );
    await act(async () => {
      lastChatInputProps().onSteer!();
    });
    expect(steerContent).toHaveBeenCalledWith('Also check the tests');
  });
});

describe('SessionComposer — Stop clears the queue (task 4.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks first and names the count when messages are queued, and does not stop yet', async () => {
    seedQueue('one', 'two', 'three');
    const stop = vi.fn().mockResolvedValue({ ok: true, cancelled: [] });
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    await act(async () => {
      lastChatInputProps().onStop!();
    });

    // Names the cost before it happens, and has not interrupted anything yet.
    expect(screen.getByText('Stop, and put 3 queued messages back?')).toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops immediately with no dialog when nothing is queued', async () => {
    const stop = vi.fn().mockResolvedValue({ ok: true, cancelled: [] });
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    await act(async () => {
      lastChatInputProps().onStop!();
    });

    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/queued message/)).not.toBeInTheDocument();
  });

  it('on confirm, stops and returns the queued text to the composer, in order', async () => {
    seedQueue('one', 'two');
    const stop = vi.fn().mockResolvedValue({
      ok: true,
      cancelled: [
        { id: 'q0', content: 'one', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
        { id: 'q1', content: 'two', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
      ],
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

    expect(stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(setInput).toHaveBeenCalledWith('one\n\ntwo'));
  });

  it('restores a queued edit exactly ONCE when Stop cancels the item under edit (DOR-1323)', async () => {
    // Reproduces the flag-on finding: queue a message, open its edit (the
    // composer now shows the item's own text as the "live" edit), then Stop
    // and confirm. The server hands back the whole cancelled queue — INCLUDING
    // the edited item, with the same text — and `restoreToComposer` used to
    // append that onto whatever the composer already held, landing the edited
    // item's words twice.
    //
    // `setInput` here writes THROUGH to the store, the way the real
    // session-chat hook wires it (`ChatPanel` hands this composer the same
    // `setInput` its `useSessionChat`/store pairing returns) — every other
    // case in this describe block uses a bare spy and drives the store by hand
    // instead, which cannot see this bug: it is specifically about what the
    // FIX's own `setInput(draftRef.current)` call does to the store that
    // `restoreToComposer` reads a moment later.
    seedQueue('one', 'two');
    const stop = vi.fn().mockResolvedValue({
      ok: true,
      cancelled: [
        { id: 'q0', content: 'one', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
        { id: 'q1', content: 'two', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
      ],
    });
    const setInput = vi.fn((value: string) => {
      useSessionChatStore.getState().updateSession('test-session', { input: value });
    });
    render(
      <SessionComposerBench {...baseProps} stop={stop} setInput={setInput} status="streaming" />
    );

    const panelProps = vi.mocked(QueuePanel).mock.calls.at(-1)![0];
    act(() => panelProps.onEdit(panelProps.queue[0]!.id));

    await act(async () => {
      lastChatInputProps().onStop!();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });

    expect(stop).toHaveBeenCalledTimes(1);
    // Exactly once, not 'one\n\none\n\ntwo'.
    await waitFor(() => expect(setInput).toHaveBeenCalledWith('one\n\ntwo'));
    expect(setInput).not.toHaveBeenCalledWith('one\n\none\n\ntwo');
  });

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
  // The PATCH `leaveQueueForStop` fires (`transport.updateQueuedMessage`) is
  // fire-and-forget and races the interrupt's queue cancellation. A round trip
  // that LOSES that race used to hand `restoreToComposer` the server's
  // PRE-edit snapshot, and it trusted it — silently discarding the rewrite,
  // which breaks `StopConfirmDialog`'s own promise ("Nothing you typed is
  // lost"). `pendingEditRef` closes it: the rewrite is captured locally the
  // instant Stop fires, before the PATCH is even sent, and substituted by id
  // into whatever `outcome.cancelled` reports — so the round trip's outcome
  // stops mattering for this one row.
  //
  // `ControlledStopComposer` is required here, not the bare-spy `setInput` the
  // rest of this file uses: `commitEditInPlace` (the PATCH's own trigger)
  // early-returns on an empty `input`, and a bare spy never feeds a rewrite
  // back into the `input` PROP the hook actually reads — only a store-backed
  // `input` does. Deleting `commitEditInPlace()` from `leaveQueue` stayed
  // green against every other test in this file for exactly this reason.
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport.updateQueuedMessage.mockReset().mockResolvedValue(undefined);
  });

  /** Open the second queued row's edit and overwrite its text. */
  function editSecondRowAndRewrite(rewrite: string): void {
    const panelProps = vi.mocked(QueuePanel).mock.calls.at(-1)![0];
    act(() => panelProps.onEdit(panelProps.queue[1]!.id));
    act(() => {
      useSessionChatStore.getState().updateSession('test-session', { input: rewrite });
    });
  }

  it('PATCH wins: commits the rewrite through the PATCH, then restores draft + queue + rewrite, each once', async () => {
    seedQueue('one', 'two');
    act(() => {
      useSessionChatStore.getState().updateSession('test-session', { input: 'hello draft' });
    });
    const stop = vi.fn().mockResolvedValue({
      ok: true,
      cancelled: [
        { id: 'q0', content: 'one', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
        // The server's snapshot already reflects the committed PATCH.
        {
          id: 'q1',
          content: 'TWO REWRITTEN',
          disposition: 'queue',
          enqueuedAt: 1,
          enqueuedBy: 'window-a',
        },
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

    // The commit half actually fired — this is what mutation-testing "delete
    // `commitEditInPlace()`" would silence.
    expect(mockTransport.updateQueuedMessage).toHaveBeenCalledWith('test-session', 'q1', {
      content: 'TWO REWRITTEN',
    });
    await waitFor(() =>
      expect(useSessionChatStore.getState().getSession('test-session').input).toBe(
        'hello draft\n\none\n\nTWO REWRITTEN'
      )
    );
  });

  it('PATCH loses: still restores the rewrite, not the stale pre-edit text, when the commit has not landed by the time Stop reports', async () => {
    seedQueue('one', 'two');
    act(() => {
      useSessionChatStore.getState().updateSession('test-session', { input: 'hello draft' });
    });
    // The PATCH never resolves inside this test's window — modeling "the
    // interrupt's queue cancellation is processed before the PATCH lands."
    mockTransport.updateQueuedMessage.mockImplementation(() => new Promise<void>(() => {}));
    const stop = vi.fn().mockResolvedValue({
      ok: true,
      cancelled: [
        { id: 'q0', content: 'one', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'window-a' },
        // STALE — the server's snapshot predates the PATCH, and carries the
        // ORIGINAL pre-edit text.
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
    // Local truth wins over the stale round trip: the rewrite survives, and
    // the parked draft is not clobbered either. Pre-fix this reads
    // 'hello draft\n\none\n\ntwo' — the rewrite silently lost.
    await waitFor(() =>
      expect(useSessionChatStore.getState().getSession('test-session').input).toBe(
        'hello draft\n\none\n\nTWO REWRITTEN'
      )
    );
  });

  it('still hands the parked draft back when the edited row left the queue first (DOR-1442)', async () => {
    // THE WINDOW. `editingIndex` is derived by looking `editingId` up in the
    // queue, so it goes null the moment the edited row leaves — dispatched as
    // the turn drained it, or removed from another window — while the cursor
    // is still open on that row and the composer is still holding its text.
    // Stop gated on the POSITION skipped `leaveQueueForStop` in exactly that
    // window, so the parked draft was never handed back and the row's words
    // stayed in the box as if they had been typed there.
    seedQueue('one', 'two');
    act(() => {
      useSessionChatStore.getState().updateSession('test-session', { input: 'hello draft' });
    });
    // The interrupt reports nothing cancelled, so `restoreToComposer` returns
    // early and what the composer ends up holding is the leave-queue handoff
    // alone. (Row `q0` is still queued below — it is this mock, not an empty
    // queue, that makes the restore step a no-op.)
    const stop = vi.fn().mockResolvedValue({ ok: true, cancelled: [] });
    render(<ControlledStopComposer {...baseProps} stop={stop} status="streaming" />);

    editSecondRowAndRewrite('TWO REWRITTEN');

    // The server says the edited row is gone: a fresh whole-queue update
    // without it, which is the only way the queue is ever published.
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

    // The draft the person parked when they opened the edit, back in the box.
    // Pre-fix this stays 'TWO REWRITTEN' — the draft dropped on the floor.
    await waitFor(() =>
      expect(useSessionChatStore.getState().getSession('test-session').input).toBe('hello draft')
    );
  });
});

describe('SessionComposer — Stop acknowledges instantly and cannot double-fire (DOR-1300)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('goes pending the instant Stop is clicked, and calls interrupt exactly once even if pressed again mid-flight', async () => {
    let resolveStop!: (v: { ok: boolean; cancelled: never[] }) => void;
    const stop = vi.fn(
      () =>
        new Promise<{ ok: boolean; cancelled: never[] }>((resolve) => {
          resolveStop = resolve;
        })
    );
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    // The pending flag flips synchronously on the click, before the request
    // has any chance to settle — this IS the "acknowledges instantly" property.
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
      resolveStop({ ok: true, cancelled: [] });
    });
  });

  it('clears pending once the turn actually settles (isStreaming flips), independent of when the interrupt response lands', async () => {
    let resolveStop!: (v: { ok: boolean; cancelled: never[] }) => void;
    const stop = vi.fn(
      () =>
        new Promise<{ ok: boolean; cancelled: never[] }>((resolve) => {
          resolveStop = resolve;
        })
    );
    const { rerender } = render(
      <SessionComposerBench {...baseProps} stop={stop} status="streaming" />
    );

    act(() => {
      lastChatInputProps().onStop!();
    });
    expect(lastChatInputProps().stopPending).toBe(true);

    // Case: the stream settles BEFORE the interrupt response lands — the
    // pending state ends with the settle, not the response, and a later
    // resolve must not flip it back on (no flicker).
    rerender(<SessionComposerBench {...baseProps} stop={stop} status="idle" />);
    expect(lastChatInputProps().stopPending).toBe(false);

    await act(async () => {
      resolveStop({ ok: true, cancelled: [] });
    });
    expect(lastChatInputProps().stopPending).toBe(false);
  });

  it('stays pending after a successful interrupt response until the stream settles', async () => {
    // Case: the response lands BEFORE turn_end — a successful `stop()` alone
    // must not clear pending, or a person watches the button go live again
    // while the agent is still winding down.
    const stop = vi.fn().mockResolvedValue({ ok: true, cancelled: [] });
    const { rerender } = render(
      <SessionComposerBench {...baseProps} stop={stop} status="streaming" />
    );

    await act(async () => {
      lastChatInputProps().onStop!();
    });
    expect(lastChatInputProps().stopPending).toBe(true);

    rerender(<SessionComposerBench {...baseProps} stop={stop} status="idle" />);
    expect(lastChatInputProps().stopPending).toBe(false);
  });

  it('re-enables Stop when the interrupt request itself fails outright (network, timeout), so the person can retry', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('network error'));
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    await act(async () => {
      lastChatInputProps().onStop!();
    });

    await waitFor(() => expect(lastChatInputProps().stopPending).toBe(false));
    // Free to retry: a fresh click reaches `stop` again.
    await act(async () => {
      lastChatInputProps().onStop!();
    });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('re-enables Stop when the server answers ok:false while the turn is still running', async () => {
    // The server 200s `{ ok: false }` on a race (turn already finished — the
    // common case, already covered above by the settle path) AND on a thrown
    // interrupt with the turn still alive. This test is the second case: the
    // turn is STILL streaming, so nothing else would ever release a pending
    // Stop — `performStop` has to read the failure itself and re-enable
    // (DOR-1300 S4). Delete this test's `ok: false` and turn it into
    // `ok: true` and it goes red: pending would then correctly stay latched
    // until the (never-arriving, in this test) settle.
    const stop = vi.fn().mockResolvedValue({ ok: false, cancelled: [] });
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    await act(async () => {
      lastChatInputProps().onStop!();
    });

    // Still streaming (status never changed) — `ok: false` alone is what
    // re-enabled it, not a settle this test never provided.
    await waitFor(() => expect(lastChatInputProps().stopPending).toBe(false));
    await act(async () => {
      lastChatInputProps().onStop!();
    });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('starts pending on CONFIRM, not on opening the confirm dialog', async () => {
    seedQueue('one');
    const stop = vi.fn().mockResolvedValue({ ok: true, cancelled: [] });
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    await act(async () => {
      lastChatInputProps().onStop!();
    });
    // The dialog is up, but nothing has been asked of the server yet.
    expect(screen.getByText(/Stop, and put 1 queued message back\?/)).toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();
    expect(lastChatInputProps().stopPending).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(lastChatInputProps().stopPending).toBe(true);
  });

  it('a same-tick double-press on the dialog Stop button fires only one interrupt (DOR-1300 B2)', async () => {
    // Radix keeps `AlertDialogAction`'s element mounted through its exit
    // animation, so nothing stops a fast double-press from reaching the SAME
    // handler twice before React gets a chance to re-render with the updated
    // pending state — jsdom cannot run the real ~200ms CSS exit transition
    // that opens this window (confirmed: the node is already detached from
    // `document.body` by the time a second, separately-flushed click would
    // land), so this reproduces the worst case that timing window permits
    // directly: both clicks dispatched in the SAME synchronous batch, so
    // `confirmStop` runs twice against the SAME pre-update `stopPending`
    // closure. A state-only guard (checking the `stopPending` value closed
    // over at render time) cannot tell these two calls apart — only a
    // synchronously-written lock can. Swap the `stopLockSessionIdRef.current`
    // check at the top of `confirmStop` back to a `stopPending`-only check
    // and this goes red.
    seedQueue('one');
    let resolveStop!: (v: { ok: boolean; cancelled: never[] }) => void;
    const stop = vi.fn(
      () =>
        new Promise<{ ok: boolean; cancelled: never[] }>((resolve) => {
          resolveStop = resolve;
        })
    );
    render(<SessionComposerBench {...baseProps} stop={stop} status="streaming" />);

    await act(async () => {
      lastChatInputProps().onStop!();
    });
    const confirmButton = screen.getByRole('button', { name: 'Stop' });

    act(() => {
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);
    });

    expect(stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStop({ ok: true, cancelled: [] });
    });
  });
});

describe('SessionComposer — a Stop pending on one session never leaks into another (DOR-1300 B1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not read as pending on session B after a Stop was clicked on session A and neither has settled', async () => {
    // `ChatPanel` re-renders this component with a new `sessionId` on a
    // session switch — no `key`, no unmount — so the reviewer's probe is
    // exactly this: rerender in place, never remount. A boolean pending flag
    // would survive the switch (it was never told which session it was for)
    // and read `true` on B, whose OWN Stop button never fired a single
    // request.
    let resolveStop!: (v: { ok: boolean; cancelled: never[] }) => void;
    const stop = vi.fn(
      () =>
        new Promise<{ ok: boolean; cancelled: never[] }>((resolve) => {
          resolveStop = resolve;
        })
    );
    const { rerender } = render(
      <SessionComposerBench {...baseProps} sessionId="session-a" stop={stop} status="streaming" />
    );

    act(() => {
      lastChatInputProps().onStop!();
    });
    expect(lastChatInputProps().stopPending).toBe(true);

    // Switch to session B — also streaming, also never had its own Stop
    // clicked — WITHOUT session A's interrupt ever settling.
    rerender(
      <SessionComposerBench {...baseProps} sessionId="session-b" stop={stop} status="streaming" />
    );

    expect(lastChatInputProps().stopPending).toBe(false);
    // And B's own Stop must actually work — the guard reading "pending" would
    // also have refused this click.
    act(() => {
      lastChatInputProps().onStop!();
    });
    expect(stop).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveStop({ ok: true, cancelled: [] });
    });
  });
});
