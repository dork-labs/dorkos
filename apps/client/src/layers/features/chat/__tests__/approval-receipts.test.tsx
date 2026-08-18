// @vitest-environment jsdom
/**
 * The approval request → receipt lifecycle.
 *
 * Every assertion here runs through the REAL projection, so what it proves is
 * that the receipt is a property of the event stream rather than of a mounted
 * component: the same events always produce the same line, whether they arrive
 * live, on replay, or from a cold snapshot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useSessionStreamStore } from '@/layers/entities/session';
import {
  projectSessionMessages,
  projectInProgressTurn,
} from '../model/stream/project-session-turn';
import { collectApprovalReceipts, applyApprovalReceipts } from '../lib/carry-approval-receipts';
import { AssistantMessageContent } from '../ui/message/AssistantMessageContent';
import { MessageProvider } from '../ui/message/MessageContext';
import { InteractiveInputPanel } from '../ui/input/InteractiveInputPanel';

// Streamdown and the argument formatter are irrelevant to receipts and pull in
// heavy trees; everything else in the path is the real component.
vi.mock('../ui/message/StreamingText', () => ({
  StreamingText: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock('@/layers/shared/lib/tool-arguments-formatter', () => ({
  ToolArgumentsDisplay: () => <div data-testid="tool-args" />,
}));
// The App host owns an iframe and its own transport traffic; the parity test
// only needs to see whether one was asked for.
vi.mock('@/layers/features/mcp-apps', () => ({
  McpAppBlock: ({ uri }: { uri: string }) => <div data-testid="mcp-app-block" data-uri={uri} />,
}));

const APPROVAL_STARTED_AT = 1_700_000_000_000;
const TEN_MINUTES_MS = 600_000;

/**
 * The ask: agent wants to run a command, gated on the operator.
 *
 * The `tool_call` comes first because that is the order the runtime emits in —
 * and on the live path it is the ONLY one of the two that reaches the turn, the
 * approval arriving separately as a pending interaction.
 */
function approvalRequested(id: string, command = 'npm test', seq = 2): SessionEvent[] {
  return [
    {
      seq,
      type: 'tool_call',
      toolCallId: id,
      toolName: 'Bash',
      input: JSON.stringify({ command }),
      status: 'pending',
    },
    {
      seq: seq + 1,
      type: 'approval_required',
      id,
      toolName: 'Bash',
      input: JSON.stringify({ command }),
      startedAt: APPROVAL_STARTED_AT,
      remainingMs: TEN_MINUTES_MS,
      hasSuggestions: false,
    },
  ];
}

/** A turn that opens, then asks. */
function turnWithAsk(id: string, command = 'npm test'): SessionEvent[] {
  return [{ seq: 1, type: 'turn_start' }, ...approvalRequested(id, command)];
}

/** The answer, exactly as the server re-emits it onto the durable stream. */
function resolved(
  id: string,
  resolution: 'approved' | 'denied' | 'expired',
  at = APPROVAL_STARTED_AT + 5_000
): SessionEvent {
  // `kind` is what the server backfills from the entry it retires — the client
  // is told which interaction this was rather than guessing from the outcome.
  return { seq: 99, type: 'interaction_resolved', id, kind: 'approval', resolution, at };
}

/**
 * Renders the transcript and (while an interaction is pending) the input-zone
 * card, both driven by the projection of `events` — the same wiring ChatPanel
 * uses. Answering pushes the server's resolution event onto the stream.
 */
function Lifecycle({ initialEvents }: { initialEvents: SessionEvent[] }) {
  const [events, setEvents] = useState(initialEvents);
  const messages = projectSessionMessages([], events, []);
  const assistant = messages[messages.length - 1];
  const pending = (assistant?.toolCalls ?? []).filter(
    (tc) => tc.interactiveType && tc.status === 'pending'
  );
  const active = pending[0] ?? null;

  const transport = {
    approveTool: async (_sessionId: string, toolCallId: string) => {
      act(() => setEvents((prev) => [...prev, resolved(toolCallId, 'approved')]));
      return { ok: true };
    },
    denyTool: async (_sessionId: string, toolCallId: string) => {
      act(() => setEvents((prev) => [...prev, resolved(toolCallId, 'denied')]));
      return { ok: true };
    },
    batchApprove: async (_sessionId: string, toolCallIds: string[]) => {
      act(() =>
        setEvents((prev) => [...prev, ...toolCallIds.map((id) => resolved(id, 'approved'))])
      );
      return { results: toolCallIds.map((toolCallId) => ({ toolCallId, ok: true })) };
    },
  } as unknown as Transport;

  return (
    <TransportProvider transport={transport}>
      <MessageProvider
        value={{
          sessionId: 'session-1',
          isStreaming: false,
          isLatestWidgetMessage: false,
          activeToolCallId: active?.toolCallId ?? null,
          onToolRef: undefined,
          focusedOptionIndex: -1,
          onToolDecided: undefined,
          inputZoneToolCallId: active?.toolCallId ?? null,
        }}
      >
        {assistant && <AssistantMessageContent message={assistant} />}
      </MessageProvider>
      {active && (
        <InteractiveInputPanel
          sessionId="session-1"
          activeInteraction={active}
          pendingApprovals={pending}
          focusedOptionIndex={-1}
          onToolRef={() => {}}
          onToolDecided={() => {}}
        />
      )}
    </TransportProvider>
  );
}

/** Render just the transcript for an already-settled event stream. */
function renderTranscript(events: SessionEvent[]) {
  const messages = projectSessionMessages([], events, []);
  const assistant = messages[messages.length - 1];
  return render(
    <MessageProvider
      value={{
        sessionId: 'session-1',
        isStreaming: false,
        isLatestWidgetMessage: false,
        activeToolCallId: null,
        onToolRef: undefined,
        focusedOptionIndex: -1,
        onToolDecided: undefined,
        inputZoneToolCallId: null,
      }}
    >
      <AssistantMessageContent message={assistant} />
    </MessageProvider>
  );
}

beforeEach(() => {
  useAppStore.getState().setAutoHideToolCalls(false);
});

afterEach(cleanup);

describe('approval receipts', () => {
  it('an approved request leaves an allowed receipt in the transcript', async () => {
    // Purpose: the pending card is a question and the receipt is the answer
    // kept. Before the answer the transcript holds only the waiting placeholder;
    // after it, a line naming what was allowed.
    render(<Lifecycle initialEvents={turnWithAsk('tc-1')} />);

    expect(screen.queryByTestId('approval-receipt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    const receipt = await screen.findByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('allowed');
    expect(receipt.textContent).toContain('You allowed');
    expect(receipt.textContent).toContain('Run "npm test"');
  });

  it('a denied request leaves a denied receipt, and no tool card for a tool that never ran', async () => {
    // Purpose: a denial is a decision worth keeping. The gated tool never ran,
    // so an error-status tool card below the receipt would be noise about a
    // failure that did not happen.
    render(<Lifecycle initialEvents={turnWithAsk('tc-1', 'rm -rf /')} />);

    fireEvent.click(screen.getByRole('button', { name: /deny/i }));

    const receipt = await screen.findByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('denied');
    expect(receipt.textContent).toContain('You denied');
    // The deny path tells the agent it was denied but carries no reason the
    // person gave, so the receipt does not claim one was passed along.
    expect(receipt.textContent).not.toContain('told why');
  });

  it('says the agent was told why, when a reason rode along with the denial', () => {
    // Purpose: the clause is earned, never decorative. It appears only because
    // the server said a reason was actually delivered to the agent — so a
    // reader can trust that the agent got an explanation and adjusted, rather
    // than being left to guess and retry.
    renderTranscript([
      ...turnWithAsk('tc-1', 'rm -rf /'),
      {
        seq: 99,
        type: 'interaction_resolved',
        id: 'tc-1',
        kind: 'approval',
        resolution: 'denied',
        at: APPROVAL_STARTED_AT + 5_000,
        reasonGiven: true,
      },
    ]);

    const receipt = screen.getByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('denied');
    expect(receipt.textContent).toContain('You denied');
    expect(receipt.textContent).toContain('agent was told why');
  });

  it('an expired request says how long it waited before being auto-denied', () => {
    // Purpose: nobody answered, so "You denied" would be a lie. The duration
    // comes from the interaction's own timer (asked → answered), so a changed
    // approval budget reads correctly instead of a baked-in 10 minutes.
    renderTranscript([
      ...turnWithAsk('tc-1'),
      resolved('tc-1', 'expired', APPROVAL_STARTED_AT + TEN_MINUTES_MS),
    ]);

    const receipt = screen.getByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('expired');
    expect(receipt.textContent).toContain('Expired — denied after 10:00');
    expect(receipt.textContent).not.toContain('You denied');
    // The clock answered on the person's behalf. Nobody told the agent
    // anything, so the reason clause must never appear here.
    expect(receipt.textContent).not.toContain('told why');
  });

  it('an abort withdraws the ask without inventing a receipt', () => {
    // Purpose: `cancelled` means the request was pulled before anyone could
    // answer it (a mid-turn steer superseded it). Recording that as a decision
    // would put an answer in the transcript that no one gave.
    renderTranscript([
      ...turnWithAsk('tc-1'),
      { seq: 99, type: 'interaction_resolved', id: 'tc-1', resolution: 'cancelled' },
    ]);

    expect(screen.queryByTestId('approval-receipt')).toBeNull();
  });

  it('the same events replayed produce the same receipt', () => {
    // Purpose: THE durability property. Receipts live on the projected part,
    // not in component state, so a reconnect replaying from Last-Event-ID (or a
    // cold snapshot carrying the turn) rebuilds the identical line.
    const events = [...turnWithAsk('tc-1'), resolved('tc-1', 'approved')];

    const first = renderTranscript(events);
    const before = screen.getByTestId('approval-receipt').textContent;
    first.unmount();

    // A fresh mount from the same stream — no memory of the earlier session.
    renderTranscript(events);
    expect(screen.getByTestId('approval-receipt').textContent).toBe(before);
  });

  it('a receipt survives events arriving after the answer', () => {
    // Purpose: the turn keeps streaming after an approval settles. The receipt
    // must not be a transient that the next fold overwrites.
    const settled: SessionEvent[] = [
      ...turnWithAsk('tc-1'),
      resolved('tc-1', 'approved'),
      { seq: 100, type: 'tool_result', toolCallId: 'tc-1', toolName: 'Bash', status: 'complete' },
      { seq: 101, type: 'text_delta', text: 'Tests passed.' },
    ];
    renderTranscript(settled);

    expect(screen.getByTestId('approval-receipt').getAttribute('data-outcome')).toBe('allowed');
    expect(screen.getByText('Tests passed.')).toBeDefined();
  });

  it('answering one queued request leaves its receipt and raises the next card', async () => {
    // Purpose: with a queue, the answered card must not take its successor with
    // it — the person sees one settled record and one new question, not a gap.
    const twoAsks: SessionEvent[] = [
      ...turnWithAsk('tc-1', 'npm test'),
      ...approvalRequested('tc-2', 'npm run build', 4),
    ];
    render(<Lifecycle initialEvents={twoAsks} />);

    // The first ask owns the input zone; the second waits in the transcript.
    // The burst card speaks for both of them — the batch bar's line, in the
    // card family's own words.
    expect(screen.getByText(/2 tools are waiting on you/)).toBeDefined();

    // Only the input-zone card is the keyboard target, so only its Approve
    // carries the Enter hint — that is the ask the person is being shown.
    const inputZoneApprove = screen
      .getAllByRole('button', { name: /approve/i })
      .find((button) => /Approve\s*Enter/.test(button.textContent ?? ''));
    fireEvent.click(inputZoneApprove!);

    await waitFor(() => {
      expect(screen.getByTestId('approval-receipt')).toBeDefined();
    });
    // The receipt names the answered ask; the survivor is still a live card.
    expect(screen.getByTestId('approval-receipt').textContent).toContain('Run "npm test"');
    expect(screen.getByRole('button', { name: /deny/i })).toBeDefined();
  });

  it('one batch answer reads as one line, with the individual asks behind an expander', async () => {
    // Purpose: "Approve all" resolves each request separately, but three
    // identical lines at the same second is noise. The combined line still owes
    // the reader the detail on demand.
    const threeAsks: SessionEvent[] = [
      { seq: 1, type: 'turn_start' },
      ...['tc-1', 'tc-2', 'tc-3'].flatMap((id, i) => approvalRequested(id, `step-${i}`, 2 + i * 2)),
    ];
    render(<Lifecycle initialEvents={threeAsks} />);

    fireEvent.click(screen.getByRole('button', { name: /allow all/i }));

    const receipt = await screen.findByTestId('approval-receipt');
    expect(receipt.textContent).toContain('You allowed 3 actions');
    expect(screen.queryByTestId('approval-receipt-items')).toBeNull();

    // Exact name: the turn's touch-chip strip carries a "show all" of its own.
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const items = screen.getByTestId('approval-receipt-items');
    expect(items.textContent).toContain('Run "step-0"');
    expect(items.textContent).toContain('Run "step-2"');
  });
});

describe('approval receipts across the turn-end reconcile', () => {
  const SESSION_ID = 'reconcile-session';

  /** Canonical history exactly as a runtime returns it: no trace of the ask. */
  function historyWithoutTheAsk(status: 'complete' | 'error', result: string): HistoryMessage[] {
    return [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'Bash',
            input: JSON.stringify({ command: 'npm test' }),
            status,
            result,
          },
        ],
        timestamp: '2026-07-31T14:32:00.000Z',
      },
    ];
  }

  /**
   * Drive the real reconcile shape: the settled turn's events go into the
   * store, the merge runs the way `useTurnEndReconcile` runs it, and
   * `setHistoryMessages` replaces the projection and clears the turn.
   */
  function reconcile(turn: SessionEvent[], history: HistoryMessage[]) {
    const store = useSessionStreamStore.getState();
    store.ensureSession(SESSION_ID);
    // Feed the turn through the real ingest so the store holds it the way a
    // live `/events` stream would — including routing `approval_required` to
    // `pendingInteractions` rather than into the turn.
    for (const event of turn) store.applyEvent(SESSION_ID, event);
    const held = useSessionStreamStore.getState().getSession(SESSION_ID);
    expect(held.inProgressTurn.length).toBeGreaterThan(0);
    const carried = collectApprovalReceipts(projectInProgressTurn(held.inProgressTurn));
    expect(carried.size).toBe(1);
    store.setHistoryMessages(SESSION_ID, applyApprovalReceipts(history, carried), {});
    const settled = useSessionStreamStore.getState().getSession(SESSION_ID);
    expect(settled.inProgressTurn).toHaveLength(0); // the projection really is gone
    return projectSessionMessages(settled.messages, settled.inProgressTurn, []);
  }

  afterEach(() => {
    useSessionStreamStore.getState().removeSession(SESSION_ID);
  });

  it('a denied receipt survives the reconcile, and no error card takes its place', () => {
    // Purpose: THE seam. Canonical history knows only that a tool errored, so
    // an unmerged reconcile both erased the receipt and put a red failure card
    // in the transcript for a tool that was never allowed to run.
    const turn: SessionEvent[] = [...turnWithAsk('tc-1'), resolved('tc-1', 'denied')];
    const messages = reconcile(turn, historyWithoutTheAsk('error', 'User denied tool execution'));

    render(
      <MessageProvider
        value={{
          sessionId: SESSION_ID,
          isStreaming: false,
          isLatestWidgetMessage: false,
          activeToolCallId: null,
          onToolRef: undefined,
          focusedOptionIndex: -1,
          onToolDecided: undefined,
          inputZoneToolCallId: null,
        }}
      >
        <AssistantMessageContent message={messages[0]} />
      </MessageProvider>
    );

    const receipt = screen.getByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('denied');
    // No CARD: a red failure card claims the tool ran and broke, and it never
    // ran. That is what this test has always been about.
    expect(screen.queryByTestId('tool-call-card')).toBeNull();
    // The sentence the model was handed still READS, quietly, under the
    // receipt. Suppressing it with the card threw away the only record of WHY a
    // refusal happened wherever that reason lived in the text — the person's own
    // words after "the user said:", or the command a permission rule blocked
    // (DOR-1293). A receipt may summarise the transcript; it may not delete it.
    expect(screen.getByText(/User denied tool execution/)).toBeDefined();
  });

  it('a receipt carried onto history survives the NEXT reload too', () => {
    // Purpose: a session reloads history once per turn. Carrying only from the
    // settling turn would keep each receipt for exactly one turn and then drop
    // it; the merge has to read what earlier reconciles already carried.
    const turn: SessionEvent[] = [...turnWithAsk('tc-1'), resolved('tc-1', 'approved')];
    const afterFirst = reconcile(turn, historyWithoutTheAsk('complete', 'ok'));
    expect(afterFirst[0].parts[0]).toMatchObject({ approvalOutcome: 'allowed' });

    // Second reload: fresh server history again, no turn events left to carry.
    const store = useSessionStreamStore.getState();
    const carried = collectApprovalReceipts(
      store.getSession(SESSION_ID).messages.flatMap((m) => m.parts ?? [])
    );
    store.setHistoryMessages(
      SESSION_ID,
      applyApprovalReceipts(historyWithoutTheAsk('complete', 'ok'), carried),
      {}
    );

    const reloaded = useSessionStreamStore.getState().getSession(SESSION_ID).messages;
    expect(reloaded[0].parts?.[0]).toMatchObject({
      approvalOutcome: 'allowed',
      interactiveType: 'approval',
    });
  });

  it('leaves history alone when the turn answered nothing', () => {
    // Purpose: the merge must be inert for the overwhelming majority of turns —
    // same references out, so it cannot invalidate memoized renders.
    const history = historyWithoutTheAsk('complete', 'ok');
    const merged = applyApprovalReceipts(history, collectApprovalReceipts([]));
    expect(merged).toBe(history);
  });
});

/**
 * A COLD OPEN: the session is reopened tomorrow, in a browser that remembers
 * nothing. No live events, no carried state — only the history the server
 * hands back. If the receipts are not in that history, they do not exist.
 */
describe('approval receipts on a cold open', () => {
  /**
   * History as a LOG-BACKED runtime reconstructs it, where the answer rides the
   * tool call itself (`reconstructHistoryFromEvents`, no `parts` on a clean
   * turn).
   */
  const LOG_BACKED_HISTORY: HistoryMessage[] = [
    { id: 'user-1', role: 'user', content: 'run the tests' },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Done.',
      toolCalls: [
        {
          toolCallId: 'tc-1',
          toolName: 'Bash',
          status: 'complete',
          input: JSON.stringify({ command: 'npm test' }),
          result: 'ok',
          approvalOutcome: 'allowed',
          approvalResolvedAt: APPROVAL_STARTED_AT + 5_000,
          approvalStartedAt: APPROVAL_STARTED_AT,
        },
      ],
    },
  ];

  /**
   * History as claude-code serves it: SDK JSONL parts with the recorded answers
   * overlaid back on (`overlayApprovalReceipts`).
   */
  const OVERLAID_HISTORY: HistoryMessage[] = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      parts: [
        {
          type: 'tool_call',
          toolCallId: 'tc-1',
          toolName: 'Bash',
          input: JSON.stringify({ command: 'rm -rf /' }),
          status: 'error',
          result: 'User denied tool execution',
          interactiveType: 'approval',
          approvalOutcome: 'denied',
          approvalResolvedAt: APPROVAL_STARTED_AT + 5_000,
          approvalStartedAt: APPROVAL_STARTED_AT,
        },
      ],
    },
  ];

  /** Project and render history with NO events at all — the cold path exactly. */
  function renderColdOpen(history: HistoryMessage[]) {
    const messages = projectSessionMessages(history, [], []);
    const assistant = messages[messages.length - 1];
    return render(
      <MessageProvider
        value={{
          sessionId: 'cold-session',
          isStreaming: false,
          isLatestWidgetMessage: false,
          activeToolCallId: null,
          onToolRef: undefined,
          focusedOptionIndex: -1,
          onToolDecided: undefined,
          inputZoneToolCallId: null,
        }}
      >
        <AssistantMessageContent message={assistant} />
      </MessageProvider>
    );
  }

  it('shows what was allowed, from history alone', () => {
    renderColdOpen(LOG_BACKED_HISTORY);

    const receipt = screen.getByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('allowed');
    expect(receipt.textContent).toContain('You allowed');
    expect(receipt.textContent).toContain('Run "npm test"');
  });

  it('shows what was denied, and no error card for a tool that never ran', () => {
    renderColdOpen(OVERLAID_HISTORY);

    const receipt = screen.getByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('denied');
    expect(screen.queryByTestId('tool-call-card')).toBeNull();
    // Kept readable rather than suppressed with the card — see the reconcile
    // suite's twin for why (DOR-1293).
    expect(screen.getByText(/User denied tool execution/)).toBeDefined();
  });

  it('says how long an expired request waited, a day later', () => {
    renderColdOpen([
      {
        ...LOG_BACKED_HISTORY[1],
        toolCalls: [
          {
            ...LOG_BACKED_HISTORY[1].toolCalls![0],
            approvalOutcome: 'expired',
            approvalResolvedAt: APPROVAL_STARTED_AT + TEN_MINUTES_MS,
          },
        ],
      },
    ]);

    const receipt = screen.getByTestId('approval-receipt');
    expect(receipt.textContent).toContain('Expired — denied after 10:00');
  });

  it('leaves an ordinary tool call alone', () => {
    // The overwhelming majority of history: nobody was asked anything, and a
    // receipt on a tool nobody gated would be an invented record.
    renderColdOpen([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done.',
        toolCalls: [{ toolCallId: 'tc-9', toolName: 'Bash', status: 'complete', result: 'ok' }],
      },
    ]);

    expect(screen.queryByTestId('approval-receipt')).toBeNull();
  });
});

describe('approval receipts and MCP Apps', () => {
  /** A completed MCP tool whose result points at an inline App (SEP-1865). */
  const APP_TOOL = {
    toolCallId: 'tc-app',
    toolName: 'mcp__acme__render_chart',
    input: '{}',
    status: 'complete' as const,
    result: 'ok',
    ui: { resourceUri: 'ui://acme/chart' },
  };

  function renderParts(parts: HistoryMessage['parts']) {
    const messages = projectSessionMessages(
      [{ id: 'm1', role: 'assistant', content: '', parts, timestamp: '' }],
      [],
      []
    );
    return render(
      <MessageProvider
        value={{
          sessionId: 'session-1',
          isStreaming: false,
          isLatestWidgetMessage: false,
          activeToolCallId: null,
          onToolRef: undefined,
          focusedOptionIndex: -1,
          onToolDecided: undefined,
          inputZoneToolCallId: null,
        }}
      >
        <AssistantMessageContent message={messages[0]} />
      </MessageProvider>
    );
  }

  it('an approved MCP tool keeps the App an ungated one would have shown', () => {
    // Purpose: gating a tool behind a permission prompt must cost it nothing.
    // The approval and the tool result land on the SAME part, so the receipt
    // branch returning early silently swallowed the App block.
    const ungated = renderParts([{ type: 'tool_call', ...APP_TOOL }]);
    expect(screen.getAllByTestId('mcp-app-block')).toHaveLength(1);
    ungated.unmount();

    renderParts([
      {
        type: 'tool_call',
        ...APP_TOOL,
        interactiveType: 'approval',
        approvalOutcome: 'allowed',
        approvalResolvedAt: 1_700_000_005_000,
      },
    ]);
    expect(screen.getByTestId('approval-receipt')).toBeDefined();
    const app = screen.getAllByTestId('mcp-app-block');
    expect(app).toHaveLength(1);
    expect(app[0].getAttribute('data-uri')).toBe('ui://acme/chart');
  });

  it('a denied MCP tool shows no App — it never ran', () => {
    renderParts([
      {
        type: 'tool_call',
        ...APP_TOOL,
        status: 'error',
        interactiveType: 'approval',
        approvalOutcome: 'denied',
        approvalResolvedAt: 1_700_000_005_000,
      },
    ]);
    expect(screen.getByTestId('approval-receipt')).toBeDefined();
    expect(screen.queryByTestId('mcp-app-block')).toBeNull();
  });
});
