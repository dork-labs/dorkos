// @vitest-environment jsdom
/**
 * What a screen reader hears when a permission request is answered.
 *
 * The hook is exercised through a real live region so the assertions are about
 * text that actually rendered — the bug it exists to prevent was an
 * announcement written to a node that unmounted in the same commit, which every
 * assertion against component state would have called a pass.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { MessagePart } from '@dorkos/shared/types';
import { useApprovalAnnouncer } from '../model/stream/use-approval-announcer';

afterEach(cleanup);

/** An answered approval part, as the projection folds one. */
function answered(
  toolCallId: string,
  outcome: 'allowed' | 'denied' | 'expired',
  command = 'npm test'
): MessagePart {
  return {
    type: 'tool_call',
    toolCallId,
    toolName: 'Bash',
    input: JSON.stringify({ command }),
    status: outcome === 'allowed' ? 'complete' : 'error',
    interactiveType: 'approval',
    approvalOutcome: outcome,
    approvalResolvedAt: 1_700_000_005_000,
  };
}

const pending: MessagePart = {
  type: 'tool_call',
  toolCallId: 'tc-1',
  toolName: 'Bash',
  input: JSON.stringify({ command: 'npm test' }),
  status: 'pending',
  interactiveType: 'approval',
};

/** The region as the transcript renders it. */
function Announcer({ parts }: { parts: MessagePart[] }) {
  return (
    <div role="status" aria-live="polite" data-testid="approval-announcer">
      {useApprovalAnnouncer(parts)}
    </div>
  );
}

/** The text currently in the region, with the zero-width nonce stripped. */
function spoken(): string {
  return (screen.getByTestId('approval-announcer').textContent ?? '').replace(/\u200B/g, '');
}

describe('useApprovalAnnouncer', () => {
  it('says nothing until an answer lands', () => {
    const { rerender } = render(<Announcer parts={[pending]} />);
    expect(spoken()).toBe('');

    rerender(<Announcer parts={[answered('tc-1', 'allowed')]} />);
    expect(spoken()).toBe('Allowed Run "npm test". Recorded in the conversation.');
  });

  it('names a denial as a denial', () => {
    const { rerender } = render(<Announcer parts={[pending]} />);
    rerender(<Announcer parts={[answered('tc-1', 'denied')]} />);
    expect(spoken()).toContain('Denied Run "npm test"');
  });

  it('says an expired request was denied without an answer', () => {
    const { rerender } = render(<Announcer parts={[pending]} />);
    rerender(<Announcer parts={[answered('tc-1', 'expired')]} />);
    expect(spoken()).toContain('expired without an answer and was denied');
  });

  it('stays silent about answers that were already there when it mounted', () => {
    // Purpose: switching back to a conversation must not read out every
    // decision it has ever recorded.
    render(<Announcer parts={[answered('tc-1', 'allowed'), answered('tc-2', 'denied')]} />);
    expect(spoken()).toBe('');
  });

  it('counts a batch instead of reciting it', () => {
    const { rerender } = render(<Announcer parts={[pending]} />);
    rerender(
      <Announcer
        parts={[
          answered('tc-1', 'allowed', 'a'),
          answered('tc-2', 'allowed', 'b'),
          answered('tc-3', 'allowed', 'c'),
        ]}
      />
    );
    expect(spoken()).toBe('Answered 3 permission requests. Recorded in the conversation.');
  });

  it('does not repeat itself when the transcript re-renders', () => {
    // Purpose: a re-projection re-runs the effect with the same answer in it.
    // Announcing again would say the same decision twice.
    const { rerender } = render(<Announcer parts={[pending]} />);
    const settled = [answered('tc-1', 'allowed')];
    rerender(<Announcer parts={settled} />);
    expect(spoken()).not.toBe('');

    rerender(<Announcer parts={[...settled]} />);
    expect(spoken()).toBe('Allowed Run "npm test". Recorded in the conversation.');
  });

  it('empties itself so a later remount is silent', async () => {
    // Purpose: a live region holding its last sentence is read out whole the
    // next time it is added to the page. It has to spend its life empty.
    const { rerender } = render(<Announcer parts={[pending]} />);
    rerender(<Announcer parts={[answered('tc-1', 'allowed')]} />);
    expect(spoken()).not.toBe('');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4100));
    });
    expect(spoken()).toBe('');
  });
});
