import type { ElementType, ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The composer's action button dims itself through motion, not through a class.
 *
 * **jsdom cannot see the thing this guards.** The repo-wide motion mock in
 * `test-setup.ts` strips every motion prop before the element reaches the DOM,
 * and real motion never commits a frame in jsdom either — so the rendered
 * button carries no inline `opacity` at all and any assertion on computed style
 * passes just as happily against the bug. The browser proof lives in
 * `apps/e2e/tests/rooms/room-conversation.spec.ts`, which reads the real
 * `getComputedStyle` in Chromium.
 *
 * What this file adds is the fast half: it swaps in its own motion mock that
 * RECORDS the `animate` target, so re-introducing a constant `opacity: 1` — the
 * exact shape of DOR-850, where a blocked Send was inert but looked live — goes
 * red in a second rather than waiting for the browser gate.
 */

/** The `animate` target of the last-rendered action button, by accessible name. */
const animateByLabel = new Map<string, Record<string, unknown>>();

// RENDER-ONLY mock: it records `animate` targets and forwards the display
// props, but deliberately drops handlers (`onClick`, `type`, gestures). Do not
// add click/submit assertions to this file against this mock; they would pass
// with nothing wired. Behavior lives in ComposerInput's own tests.
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    button: ({
      animate,
      children,
      'aria-label': ariaLabel,
      className,
      disabled,
    }: {
      animate?: Record<string, unknown>;
      children?: ReactNode;
      'aria-label'?: string;
      className?: string;
      disabled?: boolean;
    }) => {
      if (ariaLabel !== undefined && animate !== undefined) animateByLabel.set(ariaLabel, animate);
      return (
        <button type="button" aria-label={ariaLabel} className={className} disabled={disabled}>
          {children}
        </button>
      );
    },
    // Not exercised by this component today, but a shadow missing `create` is
    // exactly the "breaks on any new gen-ui import edge" shape DOR-1416 found
    // 41 of — see test-setup.ts's own `motion.create` handling.
    create: (Component: ElementType) => Component,
  },
}));

const { InputActionButton } = await import('../ui/InputActionButton');

const baseProps = {
  hasText: true,
  isStreaming: false,
  editingQueueItem: false,
  queueDepth: 0,
  isTouchOnly: false,
  onSubmit: () => {},
};

beforeEach(() => {
  animateByLabel.clear();
});

describe('InputActionButton — the blocked send looks blocked (DOR-850)', () => {
  it('animates to half opacity when the target is not ready', () => {
    render(<InputActionButton {...baseProps} submitDisabled />);

    expect(screen.getByLabelText('Send message')).toHaveProperty('disabled', true);
    expect(animateByLabel.get('Send message')).toEqual({ opacity: 0.5, scale: 1 });
  });

  it('animates to full opacity when the send is live', () => {
    render(<InputActionButton {...baseProps} />);

    expect(screen.getByLabelText('Send message')).toHaveProperty('disabled', false);
    expect(animateByLabel.get('Send message')).toEqual({ opacity: 1, scale: 1 });
  });

  it('leaves no opacity class behind to fight the animated value', () => {
    render(<InputActionButton {...baseProps} submitDisabled />);

    const button = screen.getByLabelText('Send message');
    expect(button.className).toContain('pointer-events-none');
    expect(button.className).not.toContain('opacity-');
  });
});

describe('InputActionButton — Stop already sent shows "Stopping…" and takes no more clicks (DOR-1300)', () => {
  it('renders a live-region "Stopping…" status, not a clickable Stop, once the request is pending', () => {
    render(<InputActionButton {...baseProps} isStreaming stopPending hasText={false} />);

    // A `role="status"` region, matching the other progress states this
    // button already draws (`dispatching`, `cancel-upload`) — not a button a
    // second click could reach at all.
    expect(screen.getByRole('status')).toHaveTextContent('Stopping…');
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
  });

  it('hides the dedicated red-square Stop once the click lands, so only one control ever claims the pending state', () => {
    // Before the click: streaming + text draws the dedicated square Stop
    // alongside the main Queue button.
    const { rerender } = render(
      <InputActionButton {...baseProps} isStreaming hasText stopPending={false} />
    );
    expect(screen.getByLabelText('Stop generating')).toBeInTheDocument();

    // The click landed — `stopPending` flips. The dedicated square must be
    // GONE (not merely disabled): re-gut the `!stopPending` guard on it and
    // this assertion goes red while the "Stopping…" status assertion above
    // still passes, so the two together are what pin the hide.
    rerender(<InputActionButton {...baseProps} isStreaming hasText stopPending />);
    expect(screen.queryByLabelText('Stop generating')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Stopping…');
  });

  it('a pending Stop beats Queue for the main button, even with text in the box', () => {
    // hasText + isStreaming alone would resolve to 'queue' (Clock icon) — the
    // pending Stop has to win the SAME slot, or a person mid-Stop sees an
    // active Queue button and a vanished (not merely dimmed) Stop.
    render(<InputActionButton {...baseProps} isStreaming hasText stopPending />);

    expect(screen.getByRole('status')).toHaveTextContent('Stopping…');
    expect(screen.queryByRole('button', { name: 'Queue message' })).not.toBeInTheDocument();
  });
});
