// @vitest-environment jsdom
/**
 * The card family's three promises, drawn against real components.
 *
 * 1. `A` and `D` answer a card only while focus is INSIDE it — the promise the
 *    design screen asked for by name, because an Ask that lands while somebody
 *    is typing must not swallow a letter.
 * 2. The receipt replaces the actions in the same commit, so there is never a
 *    button that does nothing.
 * 3. A burst from one agent is one decision; two agents are two.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Move the key handler onto `document` → "types the letter instead" fails,
 *   because the keystroke on the body answers the prompt.
 * - Render the receipt beside the actions rather than instead of them → "the
 *   buttons are gone in the same commit" finds an Allow.
 * - Drop the tool from `groupAsks`'s signature → "two tools are two decisions"
 *   collapses into one stack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { clearAskReceipts, recordAskReceipt } from '@/layers/entities/attention';
import { InteractionAsk } from '../ui/InteractionAsk';
import { AskList } from '../ui/AskList';
import { groupAsks } from '../lib/group-asks';

const NOW = Date.parse('2026-08-18T10:00:00.000Z');

/** A permission prompt from one session. */
function ask(
  id: string,
  overrides: {
    sessionId?: string;
    cwd?: string;
    toolName?: string;
    interaction?: Partial<Extract<PendingInteractionDTO, { type: 'approval' }>>;
  } = {}
): InteractionPendingEvent {
  return {
    sessionId: overrides.sessionId ?? 'session-1',
    cwd: overrides.cwd ?? '/projects/meeting-notes',
    interaction: {
      type: 'approval',
      id,
      startedAt: NOW,
      remainingMs: 600_000,
      timeoutMs: 600_000,
      toolName: overrides.toolName ?? 'Read',
      input: JSON.stringify({ file_path: `/projects/meeting-notes/${id}.md` }),
      hasSuggestions: false,
      ...overrides.interaction,
    },
  };
}

let transport: ReturnType<typeof createMockTransport>;

/** Everything a card needs around it, and nothing else. */
function wrap(children: ReactNode) {
  transport = createMockTransport();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <TransportProvider transport={transport}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </TransportProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  clearAskReceipts();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the Ask card', () => {
  it('answers on A only when the card has focus, and types the letter otherwise', async () => {
    wrap(<InteractionAsk ask={ask('tc-1')} />);

    // A keystroke somewhere else entirely — the composer, the page — is not an
    // answer, and this is the whole reason the handler is on the card.
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(transport.approveTool).not.toHaveBeenCalled();

    const card = screen.getByTestId('interaction-ask');
    act(() => card.focus());
    fireEvent.keyDown(card, { key: 'a' });

    await waitFor(() => expect(transport.approveTool).toHaveBeenCalledWith('session-1', 'tc-1'));
  });

  it('refuses on D, under the same rule', async () => {
    wrap(<InteractionAsk ask={ask('tc-2')} />);
    fireEvent.keyDown(document.body, { key: 'd' });
    expect(transport.denyTool).not.toHaveBeenCalled();

    const card = screen.getByTestId('interaction-ask');
    act(() => card.focus());
    fireEvent.keyDown(card, { key: 'd' });

    await waitFor(() => expect(transport.denyTool).toHaveBeenCalledWith('session-1', 'tc-2'));
  });

  it('never swallows a letter typed into a field inside it', () => {
    // Belt and braces for the same promise: a deny-reason field is a field, and
    // `a` and `d` are letters in it.
    wrap(<InteractionAsk ask={ask('tc-3')} />);
    const card = screen.getByTestId('interaction-ask');
    const field = document.createElement('input');
    card.appendChild(field);

    fireEvent.keyDown(field, { key: 'a' });

    expect(transport.approveTool).not.toHaveBeenCalled();
  });

  it('replaces the buttons with a receipt in the same commit', async () => {
    wrap(<InteractionAsk ask={ask('tc-4')} />);
    expect(screen.getByText('Allow')).toBeDefined();

    act(() =>
      recordAskReceipt('tc-4', {
        outcome: 'answered',
        resolvedAt: '2026-08-18T10:02:00.000Z',
        resolvedBy: 'Dorian',
        byThisWindow: false,
      })
    );

    await waitFor(() => expect(screen.queryByText('Allow')).toBeNull());
    expect(screen.getByText(/Already answered by Dorian/)).toBeDefined();
    expect(screen.queryByText('Deny')).toBeNull();
  });

  it('says what happened for every way a prompt can end', async () => {
    const cases: Array<[Parameters<typeof recordAskReceipt>[1], RegExp]> = [
      [{ outcome: 'expired', resolvedAt: '', byThisWindow: false }, /Nobody answered in time/],
      [{ outcome: 'cancelled', resolvedAt: '', byThisWindow: false }, /No longer needed/],
      [
        { outcome: 'answered', resolvedAt: '', byThisWindow: true, decision: 'allowed' },
        /You allowed this/,
      ],
      [
        { outcome: 'answered', resolvedAt: '', byThisWindow: true, decision: 'denied' },
        /You said no/,
      ],
      [{ outcome: 'answered', resolvedAt: '', byThisWindow: false }, /Already answered/],
    ];

    for (const [receipt, line] of cases) {
      clearAskReceipts();
      const view = wrap(<InteractionAsk ask={ask('tc-end')} />);
      act(() => recordAskReceipt('tc-end', receipt));
      await waitFor(() => expect(screen.getByText(line)).toBeDefined());
      view.unmount();
    }
  });
});

describe('what the card says', () => {
  it('shows what the prompt itself said, not only the headline', () => {
    // The inline card in the transcript has always drawn these; a fleet-wide
    // card that showed only the headline asked a person to approve a file it
    // would not name.
    wrap(
      <InteractionAsk
        ask={ask('tc-detail', {
          interaction: {
            displayName: 'Write',
            toolName: 'Write',
            description: '/tmp/p3-review.md',
            decisionReason: 'Path is outside allowed working directories',
          },
        })}
        agentName="Meeting Notes"
      />
    );

    expect(screen.getByText('/tmp/p3-review.md')).toBeDefined();
    expect(screen.getByText('Path is outside allowed working directories')).toBeDefined();
  });

  it('counts down from when the prompt STARTED, not from what was left when it arrived', () => {
    // `remainingMs` is the budget minus the time already spent. Anchoring to it
    // makes a prompt six minutes into its ten read as four minutes of budget —
    // and anything past half way is born expired. Seeded defect: anchor to
    // `startedAt + remainingMs` and this reads "expired".
    wrap(
      <InteractionAsk
        ask={ask('tc-clock', {
          interaction: {
            startedAt: NOW - 6 * 60_000,
            remainingMs: 4 * 60_000,
            timeoutMs: 10 * 60_000,
          },
        })}
        agentName="Meeting Notes"
      />
    );

    expect(screen.getByText('4 min left')).toBeDefined();
  });

  it('counts a question down too, which had no budget on the wire at all', () => {
    wrap(
      <InteractionAsk
        ask={{
          sessionId: 'session-1',
          cwd: '/projects/meeting-notes',
          interaction: {
            type: 'question',
            id: 'q-clock',
            startedAt: NOW - 6 * 60_000,
            remainingMs: 4 * 60_000,
            timeoutMs: 10 * 60_000,
            questions: [],
          },
        }}
        agentName="Meeting Notes"
      />
    );

    expect(screen.getByText('4 min left')).toBeDefined();
  });
});

describe('a burst', () => {
  it('collapses one agent’s same-tool prompts into one card with Allow all', async () => {
    wrap(<AskList asks={[ask('tc-1'), ask('tc-2'), ask('tc-3')]} />);

    const stack = screen.getByTestId('ask-stack');
    expect(stack.dataset.askCount).toBe('3');
    expect(screen.queryByTestId('interaction-ask')).toBeNull();

    fireEvent.click(screen.getByText('Allow all'));

    await waitFor(() =>
      expect(transport.batchApprove).toHaveBeenCalledWith('session-1', ['tc-1', 'tc-2', 'tc-3'])
    );
  });

  it('never stacks two agents, because that is two decisions', () => {
    wrap(
      <AskList
        asks={[ask('tc-1'), ask('tc-2', { sessionId: 'session-2', cwd: '/projects/mio' })]}
      />
    );

    expect(screen.queryByTestId('ask-stack')).toBeNull();
    expect(screen.getAllByTestId('interaction-ask')).toHaveLength(2);
  });

  it('never stacks two tools, because Allow all over a read and a delete is not one answer', () => {
    const grouped = groupAsks([
      ask('tc-1', { toolName: 'Read' }),
      ask('tc-2', { toolName: 'Bash' }),
    ]);

    expect(grouped.map((group) => group.kind)).toEqual(['single', 'single']);
  });

  it('says how many are waiting rather than hiding the rest', () => {
    // Seven prompts, six cards, and the seventh SAID — a hidden prompt is an
    // agent parked with no way for anyone to know.
    const many = Array.from({ length: 7 }, (_, index) =>
      ask(`tc-${index}`, { sessionId: `session-${index}`, cwd: `/projects/agent-${index}` })
    );

    wrap(<AskList asks={many} />);

    expect(screen.getAllByTestId('interaction-ask')).toHaveLength(6);
    expect(screen.getByText(/1 more is waiting/)).toBeDefined();
  });
});
