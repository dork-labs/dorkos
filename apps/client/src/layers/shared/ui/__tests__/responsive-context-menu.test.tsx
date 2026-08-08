/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  ResponsiveContextMenu,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuTrigger,
} from '../responsive-context-menu';

/**
 * `useIsMobile` reads a media query, so this is the switch between the two
 * branches: desktop renders a Radix context menu, mobile a drawer of buttons.
 */
function setViewport({ mobile }: { mobile: boolean }) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mobile,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => cleanup());

function Menu() {
  return (
    <ResponsiveContextMenu>
      <ResponsiveContextMenuTrigger asChild>
        <button type="button">Open</button>
      </ResponsiveContextMenuTrigger>
      <ResponsiveContextMenuContent>
        <ResponsiveContextMenuItem disabled onClick={vi.fn()}>
          Paste
        </ResponsiveContextMenuItem>
      </ResponsiveContextMenuContent>
    </ResponsiveContextMenu>
  );
}

/**
 * Where focus ends up is only visible once the close has fully settled: both
 * branches restore focus from a `setTimeout` queued while the menu unmounts, so
 * reading `activeElement` any earlier reads a state the user never sees. Two
 * trips through the macrotask queue clear that timer and anything it queues.
 */
async function settleClose() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * A menu with three items: one that focuses the box beside it, one that says it
 * will and then cannot, and one that never claimed to.
 */
function FocusMenu({ onAddToChat }: { onAddToChat?: () => void }) {
  return (
    <>
      <textarea aria-label="Message" />
      <ResponsiveContextMenu>
        <ResponsiveContextMenuTrigger asChild>
          <button type="button">Open</button>
        </ResponsiveContextMenuTrigger>
        <ResponsiveContextMenuContent>
          <ResponsiveContextMenuItem
            movesFocus
            onClick={() => {
              onAddToChat?.();
              screen.getByLabelText<HTMLTextAreaElement>('Message').focus();
            }}
          >
            Add to Chat
          </ResponsiveContextMenuItem>
          {/* Stands in for "Add to Chat" with no chat open: it only complains. */}
          <ResponsiveContextMenuItem movesFocus onClick={vi.fn()}>
            Add to Chat, no chat
          </ResponsiveContextMenuItem>
          <ResponsiveContextMenuItem onClick={vi.fn()}>Copy Path</ResponsiveContextMenuItem>
        </ResponsiveContextMenuContent>
      </ResponsiveContextMenu>
    </>
  );
}

describe('ResponsiveContextMenuItem', () => {
  it('dims a disabled item in the desktop menu', async () => {
    setViewport({ mobile: false });
    render(<Menu />);

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Paste')).toHaveAttribute('aria-disabled', 'true');
  });

  it('disables it in the mobile drawer too', async () => {
    // The drawer branch renders its own button rather than the Radix item, and
    // used to drop `disabled` on the floor — so an action dimmed on a desktop
    // was fully tappable on a phone.
    setViewport({ mobile: true });
    render(<Menu />);

    const trigger = screen.getByRole('button', { name: 'Open' });
    fireEvent.pointerDown(trigger, { pointerId: 1, button: 0 });
    // The drawer opens on a long press.
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(await screen.findByText('Paste')).toBeDisabled();
  });
});

describe('Focus after the menu closes', () => {
  it('leaves focus where the action put it (DOR-1038)', async () => {
    setViewport({ mobile: false });
    render(<FocusMenu />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();

    fireEvent.contextMenu(trigger);
    fireEvent.click(await screen.findByText('Add to Chat'));
    await settleClose();

    expect(document.activeElement).toBe(screen.getByLabelText('Message'));
  });

  it('still hands focus back to the trigger when the action moved none', async () => {
    setViewport({ mobile: false });
    render(<FocusMenu />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();

    fireEvent.contextMenu(trigger);
    fireEvent.click(await screen.findByText('Copy Path'));
    await settleClose();

    expect(document.activeElement).toBe(trigger);
  });

  it('hands focus back when a focus-moving action turns out to move none', async () => {
    // Asking to move focus is not the same as managing it: with no chat open,
    // "Add to Chat" only reports that, and a keyboard user must still land back
    // on the row rather than nowhere at all.
    setViewport({ mobile: false });
    render(<FocusMenu />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    trigger.focus();

    fireEvent.contextMenu(trigger);
    fireEvent.click(await screen.findByText('Add to Chat, no chat'));
    await settleClose();

    expect(document.activeElement).toBe(trigger);
  });

  it('waits for the drawer to start closing on a phone too', async () => {
    // The drawer traps focus exactly as the menu does, so the action has to wait
    // there as well. Where focus finally LANDS cannot be settled here: jsdom
    // never finishes vaul's slide-out transition, so the sheet is still mounted
    // when the test ends and the close-focus-restore never runs. What this pins
    // is the half that is observable — that the tap does not run the action on
    // the spot, while the drawer is still holding focus.
    setViewport({ mobile: true });
    const onAddToChat = vi.fn();
    render(<FocusMenu onAddToChat={onAddToChat} />);
    const trigger = screen.getByRole('button', { name: 'Open' });

    fireEvent.pointerDown(trigger, { pointerId: 1, button: 0 });
    // The drawer opens on a long press.
    await new Promise((resolve) => setTimeout(resolve, 600));
    fireEvent.click(await screen.findByText('Add to Chat'));

    expect(onAddToChat).not.toHaveBeenCalled();
    await waitFor(() => expect(onAddToChat).toHaveBeenCalled());
  });
});
