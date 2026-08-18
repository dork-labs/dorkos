/**
 * @vitest-environment jsdom
 *
 * A tray the reader opened while the turn was working is still open after the
 * turn finishes (DOR-827).
 *
 * This drives the real seam rather than a re-enactment of it. The events go into
 * the real stream store; the store's own `setHistoryMessages` performs the
 * turn-end reconcile exactly as `use-turn-end-reconcile` does once the history
 * reload lands; `selectRenderedMessages` projects it; `buildListRows` derives
 * the React keys; and the rows are keyed by them the way `MessageList` keys its
 * virtual rows. That chain is the bug: the running turn renders under a
 * synthetic id, history hands back the real one, and React tears the row down
 * mid-read. The only thing left out is the virtualizer itself, which measures
 * the row but does not decide its identity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { HistoryMessage, MessagePart } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { useSessionStreamStore, useSessionStreamState } from '@/layers/entities/session';
import { useAppStore, type MessageAuthor } from '@/layers/shared/model';
import { setPlatformAdapter } from '@/layers/shared/lib';
import { buildListRows } from '../lib/build-list-rows';
import { selectRenderedMessages } from '../model/stream/derive-rendered-state';
import { SessionMessage } from '../ui/message';
import { useTrayExpansionStore } from '../model/view/use-tray-expansion';
import { Conversation } from '@/layers/features/conversation';
import { SESSION_CAPABILITIES } from '../config/session-capabilities';

const SESSION_ID = 'session-under-test';
const NOW = Date.parse('2026-08-01T12:00:00Z');

/** Five files, so one chip is absorbed into the pile and the pile is clickable. */
const FILES = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

/** The tool each file was touched with — a mix, so a verb filter has work to do. */
const TOOLS = ['Read', 'Read', 'Read', 'Read', 'Write'];

/** The author every message in this transcript is attributed to. */
const AUTHOR: MessageAuthor = { kind: 'agent', id: 'agent-1', displayName: 'Test Agent' };

/** One tool call, as the durable stream delivers it. */
function readEvent(index: number): SessionEvent {
  return {
    seq: index + 2,
    type: 'tool_call',
    toolCallId: `toolu_${index}`,
    toolName: TOOLS[index]!,
    input: JSON.stringify({ file_path: `/repo/src/${FILES[index]}`, content: 'x' }),
    status: 'complete',
  };
}

/** The same tool calls as the transcript records them, under the turn's real id. */
function settledHistory(): HistoryMessage[] {
  const parts: MessagePart[] = FILES.map((file, index) => ({
    type: 'tool_call',
    toolCallId: `toolu_${index}`,
    toolName: TOOLS[index]!,
    input: JSON.stringify({ file_path: `/repo/src/${file}`, content: 'x' }),
    status: 'complete',
  }));
  return [
    {
      id: 'real-transcript-uuid',
      role: 'assistant',
      content: '',
      parts,
      timestamp: '2026-08-01T11:59:00Z',
    },
  ];
}

/**
 * The transcript, rendered the way `MessageList` renders it: rows built by
 * `buildListRows`, each keyed by the key that function produced.
 *
 * The key is also written to the DOM so the test can SEE the swap happen —
 * without that, a test asserting the tray survived would pass just as happily
 * against a row that never changed identity at all.
 */
function Transcript() {
  const stream = useSessionStreamState(SESSION_ID);
  const rows = buildListRows(selectRenderedMessages(stream, []), {
    resolveAuthor: () => AUTHOR,
    now: NOW,
  });
  return (
    // The conversation a session page mounts — the row reads its capabilities
    // from it.
    <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
      {rows.map((row) =>
        row.kind === 'message' && row.message.role === 'assistant' ? (
          <div key={row.key} data-testid="assistant-row" data-row-key={row.key}>
            <SessionMessage
              message={row.message}
              grouping={row.grouping}
              author={row.author}
              sessionId={SESSION_ID}
            />
          </div>
        ) : null
      )}
    </Conversation.Root>
  );
}

/** The row key currently on screen — the identity React is reconciling by. */
function rowKey(): string | undefined {
  return screen.getByTestId('assistant-row').dataset.rowKey;
}

/** The roster's chip labels, in the order the tray is currently listing them. */
function rosterLabels(): string[] {
  return within(screen.getByTestId('chip-tray-roster'))
    .getAllByTestId('touch-chip')
    .map((node) => node.textContent ?? '');
}

beforeEach(() => {
  useSessionStreamStore.getState().removeSession(SESSION_ID);
  useTrayExpansionStore.setState({ views: {} });
  useAppStore.setState({ sessionId: SESSION_ID, openDocuments: [], canvasOpen: false });
  setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ sessionId: null });
});

describe('the chip tray across turn end', () => {
  it('stays open when the turn finishes and the message trades its id', async () => {
    const user = userEvent.setup();
    const store = useSessionStreamStore.getState();

    act(() => {
      store.applyEvent(SESSION_ID, { seq: 1, type: 'turn_start' });
      for (let i = 0; i < FILES.length; i++) store.applyEvent(SESSION_ID, readEvent(i));
    });

    render(<Transcript />);

    // Working: the live row, with the fifth touch absorbed into the pile.
    expect(rowKey()).toBe('msg-__in_progress_turn__');
    expect(screen.getByTestId('chip-live-row')).toBeInTheDocument();

    await user.click(screen.getByTestId('chip-pile'));
    expect(screen.getByTestId('chip-tray')).toBeInTheDocument();

    // The turn ends, and the reconcile folds canonical history in — the same
    // update that drops the in-progress bubble, which is how production does it.
    act(() => {
      store.applyEvent(SESSION_ID, { seq: 99, type: 'turn_end', terminalReason: 'completed' });
      store.setHistoryMessages(SESSION_ID, settledHistory());
    });

    // The row really did change identity: this is a remount, not a re-render.
    expect(rowKey()).toBe('msg-real-transcript-uuid');
    expect(screen.queryByTestId('chip-live-row')).toBeNull();
    expect(screen.getByTestId('chip-summary-line')).toBeInTheDocument();

    // …and the tray the reader opened is still open behind the settled line.
    expect(screen.getByTestId('chip-tray')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'hide' })).toBeInTheDocument();
  });

  it('keeps the order and the filter the reader chose, not just the open tray', async () => {
    const user = userEvent.setup();
    const store = useSessionStreamStore.getState();

    act(() => {
      store.applyEvent(SESSION_ID, { seq: 1, type: 'turn_start' });
      for (let i = 0; i < FILES.length; i++) store.applyEvent(SESSION_ID, readEvent(i));
    });
    render(<Transcript />);
    await user.click(screen.getByTestId('chip-pile'));

    // Grouped is the default, and it puts the four reads before the write.
    expect(rosterLabels()[0]).toContain('a.ts');
    await user.click(screen.getByRole('radio', { name: 'Chronological' }));
    await user.click(screen.getByTestId('chip-filter-read'));

    const arranged = rosterLabels();
    expect(arranged).toHaveLength(4);
    expect(arranged.join(' ')).not.toContain('e.ts');

    act(() => {
      store.applyEvent(SESSION_ID, { seq: 99, type: 'turn_end', terminalReason: 'completed' });
      store.setHistoryMessages(SESSION_ID, settledHistory());
    });

    // The row was rebuilt under a new id — and the roster did not re-sort or
    // un-narrow itself while the reader was looking at it.
    expect(rowKey()).toBe('msg-real-transcript-uuid');
    expect(rosterLabels()).toEqual(arranged);
    expect(screen.getByRole('radio', { name: 'Chronological' })).toBeChecked();
    expect(screen.getByTestId('chip-filter-read')).toHaveAttribute('aria-pressed', 'true');
  });

  it('closes on the reader’s word after the swap, not on the swap', async () => {
    const user = userEvent.setup();
    const store = useSessionStreamStore.getState();

    act(() => {
      store.applyEvent(SESSION_ID, { seq: 1, type: 'turn_start' });
      for (let i = 0; i < FILES.length; i++) store.applyEvent(SESSION_ID, readEvent(i));
    });
    render(<Transcript />);
    await user.click(screen.getByTestId('chip-pile'));

    act(() => {
      store.applyEvent(SESSION_ID, { seq: 99, type: 'turn_end', terminalReason: 'completed' });
      store.setHistoryMessages(SESSION_ID, settledHistory());
    });

    await user.click(screen.getByRole('button', { name: 'hide' }));
    expect(screen.queryByTestId('chip-tray')).toBeNull();
    expect(screen.getByRole('button', { name: 'show all' })).toBeInTheDocument();
  });

  it('leaves a tray the reader never opened shut across the swap', async () => {
    const store = useSessionStreamStore.getState();

    act(() => {
      store.applyEvent(SESSION_ID, { seq: 1, type: 'turn_start' });
      for (let i = 0; i < FILES.length; i++) store.applyEvent(SESSION_ID, readEvent(i));
    });
    render(<Transcript />);
    expect(screen.queryByTestId('chip-tray')).toBeNull();

    act(() => {
      store.applyEvent(SESSION_ID, { seq: 99, type: 'turn_end', terminalReason: 'completed' });
      store.setHistoryMessages(SESSION_ID, settledHistory());
    });

    expect(rowKey()).toBe('msg-real-transcript-uuid');
    expect(screen.queryByTestId('chip-tray')).toBeNull();
  });
});
