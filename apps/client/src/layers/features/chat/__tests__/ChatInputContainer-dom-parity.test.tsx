// @vitest-environment jsdom
/**
 * Chat's composer, serialized — proof the migration moved no markup.
 *
 * Chat is the REFERENCE chrome for the composer family, so its markup is the
 * one thing the migration is not allowed to touch. The baselines in
 * `__baselines__/` were captured from the UNMIGRATED `ChatInputContainer` and
 * committed before the move (`247ac851a`); this file now renders the MIGRATED
 * container — composing `Composer.Root` and `Composer.OverlayLane` — against
 * them, and every one of the five states diffs EMPTY (spec `composer-parity`,
 * task 2.4).
 *
 * That is the whole evidentiary weight of this file, and it rests on the
 * baselines predating the change. Do NOT re-record them: `matchDomBaseline`
 * refuses to invent a missing baseline for the same reason, and a baseline
 * recorded after the migration would only assert that the new code equals
 * itself. If a diff appears here, the migration moved something — fix the
 * component, not the baseline.
 *
 * What is real here matters as much as what is stubbed. `ChatInput`,
 * `FileChipBar`, `QueuePanel`, `ClearArmedHint` and `react-dropzone` all run for
 * real, because they are the markup that moves. Two things are stubbed, and
 * both for the same reason — they render a clock:
 *
 * - `ChatStatusSection` reads live session/git/usage state through a dozen
 *   hooks, and this migration never touches it.
 * - `ToolApproval` / `QuestionPrompt` paint an expiry countdown, so a real one
 *   serializes differently depending on how long the test took.
 *
 * The `.chat-input-container` class is in the diff surface on purpose. It is
 * the hook for a safe-area rule in `index.css` (`@supports (padding-bottom:
 * env(safe-area-inset-bottom))`), so it is the one token whose loss changes the
 * rendered composer on a notched phone and NOTHING else in the tree — no
 * attribute, no element, no other class.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { createRef } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { createMockTransport } from '@dorkos/test-utils';
import {
  serializeDom,
  matchDomBaseline,
  formatDomDiff,
  type DomDiffEntry,
} from '@/test-helpers/dom-parity';

/**
 * The one difference the baselines are allowed to have grown since.
 *
 * DOR-947 stamps `data-composer-card` on `Composer.Root`'s card so
 * `useFeedKeyboardNav` can treat a composer as ONE destination — Ctrl+End lands
 * in the text field rather than on whichever control the markup puts first.
 * It is inert: no styling, no behaviour of its own, one attribute on the node
 * every baseline already has. Everything else must still diff empty.
 */
const COMPOSER_CARD_ATTR_DIFF = 'div > div: [attr-added] attribute data-composer-card="" added';

/** The diff, with that one reviewed attribute accounted for. */
function beyondTheComposerCardAttr(diff: readonly DomDiffEntry[]): string {
  return formatDomDiff(diff.filter((entry) => formatDomDiff([entry]) !== COMPOSER_CARD_ATTR_DIFF));
}

vi.mock('../ui/status/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status" />,
}));

vi.mock('../ui/tools/ToolApproval', () => ({
  ToolApproval: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="tool-approval">{toolCallId}</div>
  ),
}));

vi.mock('../ui/tools/QuestionPrompt', () => ({
  QuestionPrompt: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="question-prompt">{toolCallId}</div>
  ),
}));

vi.mock('@/layers/features/commands', () => ({ CommandPalette: () => null }));
vi.mock('@/layers/features/files', () => ({ FilePalette: () => null }));

vi.mock('../model/use-background-tasks', () => ({ useBackgroundTasks: () => [] }));

vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: null }),
  useAgentVisual: () => ({ color: '#3b82f6', emoji: '' }),
}));

// The three read-hooks the container itself calls. Everything else in the
// session entity — the stream store the real `useChatQueue` writes through —
// stays real, so a queued state is produced the way the app produces one.
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
import { useSessionStreamStore } from '@/layers/entities/session';
import { TransportProvider } from '@/layers/shared/model';
import type { ToolCallState } from '../model/chat-types';
import type { PendingFile } from '@/layers/features/composer';

const SESSION_ID = 'parity-session';

/** A stub autocomplete: every palette closed, every handler counted. */
function makeAutocomplete() {
  return {
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
    paletteHasResults: false,
    activeDescendantId: undefined,
    paletteListboxId: undefined,
  };
}

/** The fixed prop fixture every state varies from. */
function baseProps(autocomplete = makeAutocomplete()) {
  return {
    chatInputRef: createRef<null>(),
    input: '',
    autocomplete: autocomplete as never,
    handleSubmit: vi.fn(),
    submitContent: vi.fn(),
    tryNativeCommand: vi.fn(() => ({ handled: false }) as const),
    commandPending: false,
    status: 'idle' as 'idle' | 'streaming' | 'error',
    sessionBusy: false,
    stop: vi.fn(),
    setInput: vi.fn(),
    sessionId: SESSION_ID,
    sessionStatus: null,
    fileUpload: {
      pendingFiles: [] as PendingFile[],
      onFilesSelected: vi.fn(),
      onFileRemove: vi.fn(),
      onFileRetry: vi.fn(),
      onUploadCancel: vi.fn(),
      isUploading: false,
      hasFailedUpload: false,
    },
    interaction: {
      active: null as ToolCallState | null,
      pendingApprovals: [] as ToolCallState[],
      focusedOptionIndex: 0,
      onToolRef: vi.fn(),
      onToolDecided: vi.fn(),
    },
    sync: { connectionState: 'connected' as const },
  };
}

/** A pending attachment. Never an image — an image chip mints an object URL. */
function pendingFile(id: string, status: PendingFile['status'], error?: string): PendingFile {
  return {
    id,
    file: new File(['x'], `${id}.txt`, { type: 'text/plain' }),
    status,
    progress: status === 'uploaded' ? 100 : 0,
    ...(error === undefined ? {} : { error }),
  };
}

type Props = ReturnType<typeof baseProps>;

/** Mount the container under the app's provider, returning the RTL container. */
function mount(props: Props) {
  const transport = createMockTransport();
  return render(
    <TransportProvider transport={transport}>
      <ChatInputContainer {...props} />
    </TransportProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  // The stream store is module state: a queue seeded by one case must not
  // decide what the next one serializes.
  useSessionStreamStore.getState().clearQueue(SESSION_ID);
});

describe('ChatInputContainer — serialized-DOM parity against the pre-migration baselines', () => {
  it('1. idle — nothing pending, nothing queued, nothing streaming', () => {
    const { container } = mount(baseProps());

    const diff = matchDomBaseline(
      import.meta.url,
      'chat-input-container.idle',
      serializeDom(container)
    );
    expect(beyondTheComposerCardAttr(diff)).toBe('');
  });

  it('2. streaming with two queued messages', () => {
    // Seeded through the real store, so the real `useChatQueue` derives the
    // panel the same way a mid-turn Enter does.
    act(() => {
      useSessionStreamStore.getState().enqueueMessage(SESSION_ID, 'first queued');
      useSessionStreamStore.getState().enqueueMessage(SESSION_ID, 'second queued');
    });

    const { container } = mount({ ...baseProps(), status: 'streaming' });

    // The state exists to put ScanLine, QueuePanel and the queue-aware
    // placeholder in the tree — if any of them is missing the baseline is
    // recording an idle composer under a streaming name.
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-label',
      'Compose another — 2 queued'
    );

    const diff = matchDomBaseline(
      import.meta.url,
      'chat-input-container.streaming-queue',
      serializeDom(container)
    );
    expect(beyondTheComposerCardAttr(diff)).toBe('');
  });

  it('3. two pending attachments, one failed', () => {
    const props = baseProps();
    const { container } = mount({
      ...props,
      input: 'have a look at this',
      fileUpload: {
        ...props.fileUpload,
        pendingFiles: [
          pendingFile('file-ok', 'uploaded'),
          pendingFile('file-bad', 'error', 'Upload failed'),
        ],
        hasFailedUpload: true,
      },
    });

    // The `canSubmit={!hasFailedUpload}` gate, visible in the DOM rather than
    // in a prop: the send is closed while an attachment is broken.
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();

    const diff = matchDomBaseline(
      import.meta.url,
      'chat-input-container.failed-attachment',
      serializeDom(container)
    );
    expect(beyondTheComposerCardAttr(diff)).toBe('');
  });

  it('4. clear armed — the overlay lane carrying the hint', () => {
    const { container } = mount({ ...baseProps(), input: 'a draft worth keeping' });

    // Raised the way a person raises it: one bare Escape on a composer with
    // text in it and a reachable Clear button.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.getByTestId('clear-armed-hint')).toBeInTheDocument();

    const diff = matchDomBaseline(
      import.meta.url,
      'chat-input-container.clear-armed',
      serializeDom(container)
    );
    expect(beyondTheComposerCardAttr(diff)).toBe('');
  });

  it('5. an active interaction — the InteractiveInputPanel branch', () => {
    const props = baseProps();
    const active: ToolCallState = {
      toolCallId: 'tc-parity',
      toolName: 'Write',
      input: '{}',
      status: 'pending',
      interactiveType: 'approval',
    };
    const { container } = mount({
      ...props,
      interaction: { ...props.interaction, active, pendingApprovals: [active] },
    });

    // This branch never moves in the migration, so it has to be in the tree for
    // its baseline to mean anything.
    expect(screen.getByTestId('tool-approval')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    const diff = matchDomBaseline(
      import.meta.url,
      'chat-input-container.interactive',
      serializeDom(container)
    );
    expect(beyondTheComposerCardAttr(diff)).toBe('');
  });
});

describe('ChatInputContainer — the keyboard ladder, against the live component', () => {
  // Deliberately NOT read off a snapshot: a serialized tree cannot tell you
  // what Enter does. These drive the mounted composer.

  beforeEach(() => {
    // jsdom has no editing pipeline, and the double-Escape wipe deliberately
    // goes through one so the draft stays a Cmd+Z away. A no-op is enough here:
    // what these assert is the host callback the wipe runs afterwards, and
    // `ChatInput.test.tsx` already pins the text the edit leaves behind.
    Object.defineProperty(document, 'execCommand', {
      writable: true,
      configurable: true,
      value: vi.fn(() => true),
    });
  });

  it('Enter submits exactly once', () => {
    const autocomplete = makeAutocomplete();
    const props = baseProps(autocomplete);
    mount({ ...props, input: 'ship it' });

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    expect(props.handleSubmit).toHaveBeenCalledTimes(1);
    // Sending takes any open palette down with it (DOR-479) — the same call,
    // in the same order, that the send goes through.
    expect(autocomplete.dismissPalettes).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter leaves the key to the browser and does not submit', () => {
    const props = baseProps();
    mount({ ...props, input: 'first line' });

    const field = screen.getByRole('combobox');
    const consumed = !fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });

    expect(props.handleSubmit).not.toHaveBeenCalled();
    // The composer must not call `preventDefault` — the newline IS the browser's
    // default action for Shift+Enter in a textarea, so consuming the key would
    // silently delete the capability.
    expect(consumed).toBe(false);
  });

  it('Escape with a palette open dismisses it and never arms the clear', () => {
    const props = baseProps();
    const autocomplete = { ...makeAutocomplete(), isPaletteOpen: true };
    mount({ ...props, input: '/dep', autocomplete: autocomplete as never });

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(autocomplete.dismissPalettes).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('clear-armed-hint')).not.toBeInTheDocument();
    expect(props.setInput).not.toHaveBeenCalled();
  });

  it('two bare Escapes clear the draft', () => {
    const props = baseProps();
    mount({ ...props, input: 'words worth losing on purpose' });

    const field = screen.getByRole('combobox');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.getByTestId('clear-armed-hint')).toBeInTheDocument();

    fireEvent.keyDown(field, { key: 'Escape' });

    // The wipe runs through the field's own editing pipeline (so it is one
    // Cmd+Z away) and then the host's `onClear`, which is what empties the
    // container's controlled value.
    expect(props.setInput).toHaveBeenCalledWith('');
  });
});
