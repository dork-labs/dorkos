// @vitest-environment jsdom
/**
 * Chat's composer, serialized — proof the migration moved no markup.
 *
 * Chat is the REFERENCE chrome for the composer family, so its markup is the
 * one thing the migration is not allowed to touch. The baselines in
 * `__baselines__/` were captured from the UNMIGRATED `SessionComposer` and
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
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { createRef } from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

/**
 * The queue panel's own subtree, which DOR-1133 deliberately rewrote.
 *
 * The rows gained a move-earlier control, a note for a message another window
 * queued, and a slot for a delivery notice; Send-next replaced the old
 * blocked-with-a-reason Send-now, because the server dispatches the queue and
 * "next" is the earliest a message can go. Their markup contract lives in
 * `QueuePanel.test.tsx`, which is where it belongs — this file is about the
 * COMPOSER's markup.
 *
 * The panel's PLACEMENT is still pinned, and by this filter rather than in spite
 * of it: the prefix is the path the baseline puts the panel at, so a panel that
 * moved would report its diffs outside the prefix and fail here.
 */
const QUEUE_PANEL_SUBTREE = 'div > div > div[2] > div[1]';

/** The diff, with the two reviewed exemptions accounted for. */
function beyondTheComposerCardAttr(diff: readonly DomDiffEntry[]): string {
  return formatDomDiff(
    diff.filter(
      (entry) =>
        formatDomDiff([entry]) !== COMPOSER_CARD_ATTR_DIFF &&
        !entry.path.startsWith(QUEUE_PANEL_SUBTREE)
    )
  );
}

vi.mock('@/layers/features/chat/ui/status/ChatStatusSection', () => ({
  ChatStatusSection: () => <div data-testid="chat-status" />,
}));

vi.mock('@/layers/features/ask', () => ({
  ApprovalPrompt: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="tool-approval">{toolCallId}</div>
  ),
  QuestionPrompt: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="question-prompt">{toolCallId}</div>
  ),
  AskStack: () => null,
}));

vi.mock('@/layers/features/commands', () => ({ CommandPalette: () => null }));
vi.mock('@/layers/features/files', () => ({ FilePalette: () => null }));

vi.mock('@/layers/features/chat/model/use-background-tasks', () => ({
  useBackgroundTasks: () => [],
}));

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

// This file renders the REAL composer to assert DOM parity, so its runtime
// capabilities are stubbed to a steer-capable runtime rather than fetched.
vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: () => ({ supportsSteer: true, supportsContextStaging: true }),
}));

import { SessionComposerBench } from '@/test-helpers/session-composer';
import { useSessionStreamStore } from '@/layers/entities/session';
import { configKeys } from '@/layers/entities/config';
import { TransportProvider } from '@/layers/shared/model';
import type { ToolCallState } from '@/layers/shared/model/chat-message-types';
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
    enqueueContent: vi.fn().mockResolvedValue(true),
    steerContent: vi.fn().mockResolvedValue(true),
    addContextContent: vi.fn().mockResolvedValue(true),
    tryNativeCommand: vi.fn(() => ({ handled: false }) as const),
    commandPending: false,
    status: 'idle' as 'idle' | 'streaming' | 'error',
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

/**
 * Mount the container under the app's providers, returning the RTL container.
 *
 * The `QueryClientProvider` is here because the container now reads
 * `ui.composer.richText` through `useConfig` (DOR-948). It renders NO DOM of its
 * own, so the baselines are untouched by its arrival — which the flag-off five
 * diffing empty against files recorded long before it is the proof of.
 *
 * ## Why the config is SEEDED and not merely resolved
 *
 * The preference is now default-ON (owner decision, 2026-08-12), so a container
 * that waits for config renders the RICH field first and swaps to the plain one
 * a tick later. That swap is invisible to a person and fatal to a DOM
 * photograph: the mount-time auto-focus lands on whichever field existed at
 * mount, and jsdom cannot focus a `contenteditable`, so the composer's focus
 * ring — and therefore three class tokens in every baseline — came out
 * different depending on load ORDER.
 *
 * Seeding the answer into the query cache before the first render removes the
 * swap entirely: each test renders the one field it is about, once. That is
 * also the honest photograph, because the state being pinned is the resting
 * state, not the transition.
 *
 * @param props - The container's props for this state.
 * @param richText - Whether the composer formats as you type. `false` is the
 *   flag-off path the original five baselines pin.
 */
function mount(props: Props, richText = false) {
  const config = { ui: { composer: { richText } } };
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(configKeys.current(), config);
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <SessionComposerBench {...props} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * Seed the session's queue the way the server does — a `queue_update` on the
 * durable stream, with the session streaming so the head counts as waiting.
 */
function seedQueue(...contents: string[]) {
  const store = useSessionStreamStore.getState();
  store.applyEvent(SESSION_ID, {
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
  store.applyEvent(SESSION_ID, {
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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  // The stream store is module state: a queue seeded by one case must not
  // decide what the next one serializes.
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

describe('SessionComposer — serialized-DOM parity against the pre-migration baselines', () => {
  it('1. idle — nothing pending, nothing queued, nothing streaming', () => {
    const { container } = mount(baseProps());

    const diff = matchDomBaseline(
      import.meta.url,
      'session-composer.idle',
      serializeDom(container)
    );
    expect(beyondTheComposerCardAttr(diff)).toBe('');
  });

  it('2. streaming with two queued messages', () => {
    // Seeded through the real store, so the real `useChatQueue` derives the
    // panel the same way a mid-turn Enter does.
    act(() => seedQueue('first queued', 'second queued'));

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
      'session-composer.streaming-queue',
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
      'session-composer.failed-attachment',
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
      'session-composer.clear-armed',
      serializeDom(container)
    );
    expect(beyondTheComposerCardAttr(diff)).toBe('');
  });

  it('5. an active interaction — the SessionAsks branch', () => {
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
      'session-composer.interactive',
      serializeDom(container)
    );
    expect(beyondTheComposerCardAttr(diff)).toBe('');
  });
});

/**
 * Mount with the preference ON and wait for the editor chunk to land.
 *
 * The field is lazy, so the composer is briefly the Suspense fallback — a plain
 * textarea. Serializing before it settles would record a flag-OFF tree under a
 * flag-on name. (The preference itself no longer arrives late: `mount` seeds it,
 * for the reasons given there.)
 *
 * @param props - The container's props for this state.
 */
async function mountRich(props: Props) {
  const rendered = mount(props, true);
  await waitFor(
    () => expect(rendered.container.querySelector('[contenteditable="true"]')).not.toBeNull(),
    { timeout: 10_000 }
  );
  return rendered;
}

/**
 * Load the editor chunk once, before any flag-on case renders.
 *
 * Without this, whether a case ever paints the Suspense fallback depends on
 * whether an earlier case in this FILE already resolved the lazy import — and
 * that decides where the mount-time auto-focus lands, which decides whether the
 * composer card carries its focus-ring classes. The first flag-on case was
 * therefore photographing a different tree from the other three, for a reason
 * that lives in module state rather than in the component.
 *
 * With the chunk warm, every case here renders the real field on the first
 * paint. jsdom cannot focus a `contenteditable`, so what these four record is an
 * UNFOCUSED composer — which is what the container genuinely renders, rather
 * than a ring inherited from a textarea that existed for one tick and was
 * replaced.
 *
 * Warmed by RENDERING one rather than by reaching for the module: `field/` is
 * internal to `features/composer` and nothing outside that slice may import a
 * path inside it, tests included.
 */
beforeAll(async () => {
  await mountRich(baseProps());
  cleanup();
});

/**
 * The flag-ON reference tree, and the ONE place in this spec where recording a
 * baseline is legitimate.
 *
 * Every other baseline in this repo predates the change it guards, which is
 * what gives it its weight. These four have no such ancestor: before DOR-948
 * there was no rich field to photograph. So they were recorded deliberately
 * with `DORKOS_RECORD_DOM_BASELINE=1`, once, and reviewed as the reference —
 * and from here they are no less frozen than the rest. If one of them starts
 * diffing, the field moved; fix the field, not the file.
 *
 * ## The one amendment since, and exactly what it was (2026-08-12)
 *
 * Making rich text default-ON changed which field the container renders FIRST,
 * and with it where the mount-time auto-focus lands. jsdom cannot focus a
 * `contenteditable`, so these four had been photographing a focus ring the rich
 * field never earned — it belonged to a textarea that existed for one tick,
 * was focused, and was replaced without a `blur` jsdom bothers to fire. All four
 * now record the composer card as unfocused.
 *
 * That was applied as a THREE-TOKEN edit per file (`border-ring`, `ring-[1px]`
 * and `ring-ring/75` out, `border-input` in) and NOT by re-running the recorder,
 * deliberately: `DORKOS_RECORD_DOM_BASELINE=1` also rewrites the queue-panel
 * subtree these baselines carry stale ON PURPOSE (see {@link QUEUE_PANEL_SUBTREE}
 * — the staleness is what the exemption is exempting), which would have
 * destroyed evidence while fixing a class list. The measured proof that the ring
 * was the ONLY difference is that the four cases' diffs, before the edit, were
 * twelve class-token entries and nothing else — no element, no attribute, no
 * text.
 *
 * ## The intended deltas from the flag-off tree, enumerated
 *
 * These are asserted POSITIVELY below rather than accepted as whatever
 * rendered:
 *
 * 1. `<textarea>` becomes `<div contenteditable="true">`, still
 *    `role="combobox"`, and gains `aria-multiline="true"` — a textarea is
 *    multiline by definition, a div has to say so.
 * 2. The placeholder moves from a native `placeholder` attribute to
 *    `aria-placeholder` plus a rendered element. The TEXT is identical; only
 *    the spelling changes.
 * 3. Inside the field, the document's own nodes (a paragraph, and whatever the
 *    markdown parsed into) instead of a value string on a form control.
 * 4. No inline `height` style: `use-textarea-resize` does not run on this path,
 *    a contenteditable grows on its own, and the 200 ms ease-down on empty was
 *    an artifact of setting that height imperatively. A recorded, intended
 *    delta from task 3.1.
 *
 * ## What is NOT allowed to differ
 *
 * Every other `aria-*` attribute on the field, value for value. That is not
 * checked here — it is checked exhaustively, across four prop shapes, by
 * `features/composer/__tests__/ComposerInput-aria-parity.test.tsx`, which
 * compares the two fields' attribute maps directly rather than hunting a
 * difference inside a large serialized diff. This file would be the worse
 * instrument for it, so it defers rather than duplicating.
 */
describe('SessionComposer — the flag-on reference tree', () => {
  it('1. idle, formatting on', async () => {
    const { container } = await mountRich(baseProps());

    const field = container.querySelector('[contenteditable="true"]')!;
    // Deltas 1 and 2, positively: the control changed shape but not identity.
    expect(field.getAttribute('role')).toBe('combobox');
    expect(field.getAttribute('aria-multiline')).toBe('true');
    // Chat idle draws an ANIMATED placeholder overlay, so the field's own
    // placeholder is empty on both paths and the name comes from `aria-label` —
    // exactly as the flag-off idle baseline records it (`placeholder: ""`,
    // `aria-label: "Send a message..."`). Delta 2 is visible in case 2 below,
    // where the queue-aware placeholder is real text.
    expect(field.getAttribute('aria-label')).toBe('Send a message...');
    expect(container.querySelector('textarea')).toBeNull();
    // Delta 4: nothing imperatively sizes this field.
    expect(field.getAttribute('style') ?? '').not.toContain('height');

    const diff = matchDomBaseline(
      import.meta.url,
      'session-composer.rich-text.idle',
      serializeDom(container)
    );
    expect(formatDomDiff(diff)).toBe('');
  });

  it('2. streaming with two queued messages, formatting on', async () => {
    act(() => seedQueue('first queued', 'second queued'));

    const { container } = await mountRich({ ...baseProps(), status: 'streaming' });

    // The same guard the flag-off case carries: the queue-aware placeholder has
    // to be there, or this is an idle composer under a streaming name. It now
    // rides `aria-placeholder`, which IS delta 2 shown working.
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'aria-placeholder',
      'Compose another — 2 queued'
    );

    const diff = matchDomBaseline(
      import.meta.url,
      'session-composer.rich-text.streaming-queue',
      serializeDom(container)
    );
    // The queue rows are exempt here for the same reviewed reason as in the
    // flag-off case — see {@link QUEUE_PANEL_SUBTREE}.
    expect(formatDomDiff(diff.filter((e) => !e.path.startsWith(QUEUE_PANEL_SUBTREE)))).toBe('');
  });

  it('3. two pending attachments, one failed, formatting on', async () => {
    const props = baseProps();
    const { container } = await mountRich({
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

    // The attachment chrome is outside the field, so the `canSubmit` gate must
    // behave identically with the field swapped — that is the point of the case.
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    // Delta 3: the draft is document nodes now, not a form-control value.
    expect(container.querySelector('[contenteditable="true"]')!.textContent).toBe(
      'have a look at this'
    );

    const diff = matchDomBaseline(
      import.meta.url,
      'session-composer.rich-text.failed-attachment',
      serializeDom(container)
    );
    expect(formatDomDiff(diff)).toBe('');
  });

  it('4. clear armed, formatting on', async () => {
    const { container } = await mountRich({
      ...baseProps(),
      input: 'a draft worth keeping',
    });

    // Raised the way a person raises it, on the rich field this time.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.getByTestId('clear-armed-hint')).toBeInTheDocument();

    const diff = matchDomBaseline(
      import.meta.url,
      'session-composer.rich-text.clear-armed',
      serializeDom(container)
    );
    expect(formatDomDiff(diff)).toBe('');
  });

  // There is deliberately no flag-on twin of the flag-off "interactive" case:
  // that branch renders the SessionAsks and no composer at all, so a
  // rich-text baseline of it would photograph the same tree under a second name.
});

describe('SessionComposer — the keyboard ladder, against the live component', () => {
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
