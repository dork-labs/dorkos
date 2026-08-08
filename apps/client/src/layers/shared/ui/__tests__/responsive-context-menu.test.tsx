/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
