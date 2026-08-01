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
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { projectSessionMessages } from '../model/stream/project-session-turn';
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

const APPROVAL_STARTED_AT = 1_700_000_000_000;
const TEN_MINUTES_MS = 600_000;

/** The ask: agent wants to run `npm test`, gated on the operator. */
function approvalRequested(id: string, command = 'npm test'): SessionEvent[] {
  return [
    { seq: 1, type: 'turn_start' },
    {
      seq: 2,
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

/** The answer, exactly as the server re-emits it onto the durable stream. */
function resolved(
  id: string,
  resolution: 'approved' | 'denied' | 'expired',
  at = APPROVAL_STARTED_AT + 5_000
): SessionEvent {
  return { seq: 99, type: 'interaction_resolved', id, resolution, at };
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
    // after it, a permanent line naming what was allowed.
    render(<Lifecycle initialEvents={approvalRequested('tc-1')} />);

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
    render(<Lifecycle initialEvents={approvalRequested('tc-1', 'rm -rf /')} />);

    fireEvent.click(screen.getByRole('button', { name: /deny/i }));

    const receipt = await screen.findByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('denied');
    expect(receipt.textContent).toContain('You denied');
    // The deny path tells the agent it was denied but carries no reason the
    // person gave, so the receipt does not claim one was passed along.
    expect(receipt.textContent).not.toContain('told why');
  });

  it('an expired request says how long it waited before being auto-denied', () => {
    // Purpose: nobody answered, so "You denied" would be a lie. The duration
    // comes from the interaction's own timer (asked → answered), so a changed
    // approval budget reads correctly instead of a baked-in 10 minutes.
    renderTranscript([
      ...approvalRequested('tc-1'),
      resolved('tc-1', 'expired', APPROVAL_STARTED_AT + TEN_MINUTES_MS),
    ]);

    const receipt = screen.getByTestId('approval-receipt');
    expect(receipt.getAttribute('data-outcome')).toBe('expired');
    expect(receipt.textContent).toContain('Expired — denied after 10:00');
    expect(receipt.textContent).not.toContain('You denied');
  });

  it('an abort withdraws the ask without inventing a receipt', () => {
    // Purpose: `cancelled` means the request was pulled before anyone could
    // answer it (a mid-turn steer superseded it). Recording that as a decision
    // would put an answer in the transcript that no one gave.
    renderTranscript([
      ...approvalRequested('tc-1'),
      { seq: 99, type: 'interaction_resolved', id: 'tc-1', resolution: 'cancelled' },
    ]);

    expect(screen.queryByTestId('approval-receipt')).toBeNull();
  });

  it('the same events replayed produce the same receipt', () => {
    // Purpose: THE durability property. Receipts live on the projected part,
    // not in component state, so a reconnect replaying from Last-Event-ID (or a
    // cold snapshot carrying the turn) rebuilds the identical line.
    const events = [...approvalRequested('tc-1'), resolved('tc-1', 'approved')];

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
      ...approvalRequested('tc-1'),
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
      ...approvalRequested('tc-1', 'npm test'),
      {
        seq: 3,
        type: 'approval_required',
        id: 'tc-2',
        toolName: 'Bash',
        input: JSON.stringify({ command: 'npm run build' }),
        startedAt: APPROVAL_STARTED_AT,
        remainingMs: TEN_MINUTES_MS,
        hasSuggestions: false,
      },
    ];
    render(<Lifecycle initialEvents={twoAsks} />);

    // The first ask owns the input zone; the second waits in the transcript.
    expect(screen.getByText(/2 tools awaiting approval/)).toBeDefined();

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
      ...['tc-1', 'tc-2', 'tc-3'].map(
        (id, i): SessionEvent => ({
          seq: 2 + i,
          type: 'approval_required',
          id,
          toolName: 'Bash',
          input: JSON.stringify({ command: `step-${i}` }),
          startedAt: APPROVAL_STARTED_AT,
          remainingMs: TEN_MINUTES_MS,
          hasSuggestions: false,
        })
      ),
    ];
    render(<Lifecycle initialEvents={threeAsks} />);

    fireEvent.click(screen.getByRole('button', { name: /approve all/i }));

    const receipt = await screen.findByTestId('approval-receipt');
    expect(receipt.textContent).toContain('You allowed 3 actions');
    expect(screen.queryByTestId('approval-receipt-items')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show/i }));
    const items = screen.getByTestId('approval-receipt-items');
    expect(items.textContent).toContain('Run "step-0"');
    expect(items.textContent).toContain('Run "step-2"');
  });
});
