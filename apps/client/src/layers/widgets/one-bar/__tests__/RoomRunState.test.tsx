// @vitest-environment jsdom
/**
 * The room's run state, and the no-layout-jump invariant it exists to keep
 * (spec `one-bar-header` I3).
 *
 * **What "no layout jump" means here, and what a unit test can prove about it.**
 * jsdom measures every element as 0x0, so nothing in this file asserts a width —
 * that is the browser gate's job. What it CAN prove is the mechanism, and the
 * mechanism is the whole difference: the controls are mounted whether or not
 * anything is running, so an agent picking something up changes only their
 * opacity. Revert this component to rendering them conditionally and the first
 * three cases below go red, which is exactly the change that would start shoving
 * the room's name sideways mid-read.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomRunState } from '../ui/RoomRunState';

const { working, mobile } = vi.hoisted(() => ({
  working: { count: 0 },
  mobile: { is: false },
}));
const halt = vi.hoisted(() => vi.fn());
const pending = vi.hoisted(() => ({ value: false }));

vi.mock('@/layers/entities/room', () => ({
  useOpenRoomWorking: () => working.count,
  useHaltRoom: () => ({ mutate: halt, isPending: pending.value }),
}));

// The viewport question, stubbed at the hook rather than at `matchMedia` so a
// test states the width class it means instead of a media-query string.
vi.mock('@/layers/shared/model', () => ({ useIsMobile: () => mobile.is }));

afterEach(() => {
  cleanup();
  working.count = 0;
  mobile.is = false;
  pending.value = false;
  vi.clearAllMocks();
});

function renderRunState() {
  return render(
    <TooltipProvider>
      <RoomRunState roomId="room-1" roomName="#general" />
    </TooltipProvider>
  );
}

describe('RoomRunState', () => {
  it('keeps both controls mounted while the room is idle, so their space is already spoken for', () => {
    // The reserved-space mechanism itself. A conditional render would leave
    // nothing in the document here, and the row would then grow by the width of
    // a chip and a button the moment an agent started.
    renderRunState();

    const slot = screen.getByTestId('room-run-state');
    expect(slot).toHaveAttribute('data-idle', 'true');
    expect(slot).toContainElement(screen.getByTestId('room-working-chip'));
    expect(slot).toContainElement(screen.getByTestId('room-halt'));
  });

  it('holds that space with the live count, not a spacer that could drift from it', () => {
    // The box is filled by the same chip that will be visible a moment later, so
    // what is reserved is exactly what arrives.
    renderRunState();
    expect(screen.getByTestId('room-working-chip')).toHaveTextContent('0');
  });

  it('takes the idle controls out of reach entirely — not merely out of sight', () => {
    // Invisible is not enough: a Stop that is transparent but still tabbable and
    // still clickable is a button that halts a room nobody asked to halt, and a
    // screen reader would announce a room as busy when it is not.
    renderRunState();
    expect(screen.getByTestId('room-run-state')).toHaveAttribute('inert');
  });

  it('lights up in place when an agent starts, changing nothing but its own opacity', () => {
    const { rerender } = renderRunState();
    const idle = screen.getByTestId('room-run-state');

    working.count = 2;
    rerender(
      <TooltipProvider>
        <RoomRunState roomId="room-1" roomName="#general" />
      </TooltipProvider>
    );

    // The SAME DOM node, not a fresh one: React reconciled it in place, which is
    // what makes the transition an opacity change rather than a re-layout.
    const busy = screen.getByTestId('room-run-state');
    expect(busy).toBe(idle);
    expect(busy).toHaveAttribute('data-idle', 'false');
    expect(busy).not.toHaveAttribute('inert');
  });

  it('says how many are working, in words a screen reader can use', () => {
    working.count = 1;
    renderRunState();
    expect(screen.getByLabelText('1 agent working')).toHaveTextContent('1');

    cleanup();
    working.count = 4;
    renderRunState();
    expect(screen.getByLabelText('4 agents working')).toHaveTextContent('4');
  });

  it('names the room it would stop, so the button is never ambiguous', async () => {
    const user = userEvent.setup();
    working.count = 2;
    renderRunState();

    await user.click(screen.getByRole('button', { name: 'Stop all agents in #general' }));
    expect(halt).toHaveBeenCalledWith({ roomId: 'room-1' });
  });

  it('draws nothing at all on a phone, reserving none of its width (spec §4)', () => {
    // **The one place the reserved slot is the wrong trade.** ~70px of a 390px
    // bar held open for something usually absent came straight out of the room's
    // name, which is the whole identity of the surface — measured, it clipped
    // names that otherwise fit. Nothing is drawn, so nothing can jump either.
    mobile.is = true;
    renderRunState();

    expect(screen.queryByTestId('room-run-state')).not.toBeInTheDocument();
  });

  it('draws nothing on a phone even while agents are working', () => {
    // The signal is not dropped, it MOVES: the members chip carries a dot and
    // says so in its accessible name, and the live lane's stop-all above the
    // composer is the reach that replaces this button.
    mobile.is = true;
    working.count = 3;
    renderRunState();

    expect(screen.queryByTestId('room-run-state')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-halt')).not.toBeInTheDocument();
  });

  it('holds the count box open for two digits, so 9 → 10 moves nothing', () => {
    // The residual jump the reserved slot would otherwise still have: a chip
    // sized to one digit widens when the count reaches ten, nudging everything
    // left of it. A floor on the number's box is what absorbs that.
    working.count = 9;
    renderRunState();

    expect(screen.getByText('9')).toHaveClass('min-w-[2ch]', 'tabular-nums');
  });

  it('cannot be pressed twice while the halt is still going out', () => {
    working.count = 2;
    pending.value = true;
    renderRunState();

    expect(screen.getByRole('button', { name: 'Stop all agents in #general' })).toBeDisabled();
  });
});
