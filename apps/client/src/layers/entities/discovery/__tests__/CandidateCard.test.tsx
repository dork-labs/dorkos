/**
 * `CandidateCard` hands its root node to whoever renders it.
 *
 * `DiscoveryView` renders these inside `AnimatePresence mode="popLayout"`,
 * which pops an exiting card out of the layout flow by writing `position:
 * absolute` onto its DOM node — and it can only reach that node through a ref
 * the card forwards. The card did not forward one, so the mode was inert: an
 * approved card kept its grid slot for the length of its exit and the cards
 * below it sat still instead of closing the gap (DOR-1815).
 *
 * Nothing reports that. `popLayout` does not warn, the exit animation still
 * plays, and the only symptom is that the list looks slow. So the ref is what
 * this asserts — the mechanism, not the appearance.
 *
 * @module entities/discovery/__tests__/CandidateCard
 */
import { createRef } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiscoveryCandidate } from '@dorkos/shared/mesh-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { CandidateCard } from '../ui/CandidateCard';

afterEach(cleanup);

const CANDIDATE: DiscoveryCandidate = {
  path: '/Users/someone/code/scout',
  strategy: 'claude-code',
  hints: {
    suggestedName: 'Scout',
    detectedRuntime: 'claude-code',
    inferredCapabilities: ['research'],
    description: 'Reads the repo and answers questions about it.',
  },
  discoveredAt: '2026-09-06T00:00:00.000Z',
};

describe('CandidateCard', () => {
  it('forwards its ref to the card element popLayout has to move', () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <TooltipProvider>
        <CandidateCard ref={ref} candidate={CANDIDATE} onApprove={vi.fn()} />
      </TooltipProvider>
    );

    const card = container.querySelector('[data-slot="candidate-card"]');
    expect(card).not.toBeNull();
    // Same node, not merely a node: `popLayout` writes `position: absolute`
    // onto whatever this ref holds, so pointing it anywhere else is the same
    // as not forwarding it at all.
    expect(ref.current).toBe(card);
  });

  it('keeps a failed project actionable with a retry button', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <TooltipProvider>
        <CandidateCard candidate={CANDIDATE} onApprove={onApprove} registrationFailed />
      </TooltipProvider>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t add this project. Try again.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onApprove).toHaveBeenCalledWith(CANDIDATE);
  });

  it('disables every action while the project is being added', () => {
    const { container } = render(
      <TooltipProvider>
        <CandidateCard
          candidate={CANDIDATE}
          onApprove={vi.fn()}
          onSkip={vi.fn()}
          onDeny={vi.fn()}
          registrationPending
        />
      </TooltipProvider>
    );

    expect(container.querySelector('[data-slot="candidate-card"]')).toHaveAttribute(
      'aria-busy',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled();
  });
});
