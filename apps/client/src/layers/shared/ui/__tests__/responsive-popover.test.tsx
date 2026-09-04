// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  useResponsivePopover,
} from '../responsive-popover';

// Mock useIsMobile to control desktop/mobile rendering.
// The component imports from '../model' which resolves to the shared/model barrel.
const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => mockUseIsMobile(),
}));

// Mock Radix Popover to render simple DOM elements for testing
vi.mock('../popover', () => ({
  Popover: ({
    children,
    open,
    modal,
  }: {
    children: React.ReactNode;
    open?: boolean;
    modal?: boolean;
  }) =>
    open !== false ? (
      <div data-testid="popover-root" data-modal={String(modal)}>
        {children}
      </div>
    ) : null,
  PopoverTrigger: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button data-testid="popover-trigger" {...props}>
      {children}
    </button>
  ),
  PopoverContent: ({
    children,
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) => (
    <div data-testid="popover-content" className={className} {...props}>
      {children}
    </div>
  ),
}));

// Mock Drawer (vaul) components to render simple DOM elements for testing
vi.mock('../drawer', () => ({
  Drawer: ({
    children,
    open,
    modal,
  }: {
    children: React.ReactNode;
    open?: boolean;
    modal?: boolean;
  }) =>
    open !== false ? (
      <div data-testid="drawer-root" data-modal={String(modal)}>
        {children}
      </div>
    ) : null,
  DrawerTrigger: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button data-testid="drawer-trigger" {...props}>
      {children}
    </button>
  ),
  DrawerContent: ({
    children,
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) => (
    <div data-testid="drawer-content" className={className} {...props}>
      {children}
    </div>
  ),
  DrawerClose: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button data-testid="drawer-close" {...props}>
      {children}
    </button>
  ),
  DrawerHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="drawer-header" {...props}>
      {children}
    </div>
  ),
  DrawerDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p data-testid="drawer-description" {...props}>
      {children}
    </p>
  ),
  DrawerTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 data-testid="drawer-title" {...props}>
      {children}
    </h2>
  ),
}));

/** Renders context values into the DOM for assertion. */
function ContextSpy() {
  const { isDesktop } = useResponsivePopover();
  return <span data-testid="is-desktop">{String(isDesktop)}</span>;
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mockUseIsMobile.mockReturnValue(false);
});

describe('ResponsivePopover', () => {
  it('renders Popover on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>content</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('popover-root')).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-root')).not.toBeInTheDocument();
  });

  // `modal` is the whole reason a task picker traps focus instead of letting
  // Tab wander behind it, and it only works if it reaches the primitive. A
  // browser pass can confirm the trap today; nothing would catch someone
  // dropping the forward tomorrow, so pin it on both branches.
  it('forwards modal to Popover on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open modal>
        <ResponsivePopoverContent>content</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('popover-root')).toHaveAttribute('data-modal', 'true');
  });

  it('forwards modal to Drawer on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open modal>
        <ResponsivePopoverContent>content</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('drawer-root')).toHaveAttribute('data-modal', 'true');
  });

  it('leaves modal off when nobody asks for it, so existing popovers are unchanged', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>content</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('popover-root')).not.toHaveAttribute('data-modal', 'true');
  });

  it('renders Drawer on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>content</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('drawer-root')).toBeInTheDocument();
    expect(screen.queryByTestId('popover-root')).not.toBeInTheDocument();
  });
});

describe('ResponsivePopoverContent', () => {
  it('renders PopoverContent on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('popover-content')).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-content')).not.toBeInTheDocument();
  });

  it('renders DrawerContent on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('drawer-content')).toBeInTheDocument();
    expect(screen.queryByTestId('popover-content')).not.toBeInTheDocument();
  });

  it('applies w-80 base class to PopoverContent on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('popover-content').className).toContain('w-80');
  });

  it('merges custom className on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent className="p-4">inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('popover-content').className).toContain('p-4');
  });

  it('applies bottom drawer classes on mobile (ignoring caller className)', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent className="w-72">inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    const content = screen.getByTestId('drawer-content');
    expect(content.className).toContain('flex');
    expect(content.className).toContain('max-h-[90vh]');
    // Caller's width constraint should not be applied to drawer
    expect(content.className).not.toContain('w-72');
  });

  it('fills the screen on mobile when asked, instead of hugging its content', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open fullHeight>
        <ResponsivePopoverContent>inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    const content = screen.getByTestId('drawer-content');
    expect(content.className).toContain('h-[92dvh]');
    expect(content.className).not.toContain('max-h-[90vh]');
  });

  it('gives the full-height sheet a close button, because a phone has no Escape key', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open fullHeight>
        <ResponsivePopoverContent>inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('drawer-close')).toBeInTheDocument();
    // The accessible NAME, not a visually-hidden text node: the button is a
    // `Button` with an `aria-label` now, and the name is what a screen reader
    // actually reads either way.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('leaves a content-height sheet without one — nothing is covered to reach around', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.queryByTestId('drawer-close')).not.toBeInTheDocument();
  });

  it('can always scroll the full-height sheet, however little of it the keyboard leaves', () => {
    // vaul shrinks this sheet to whatever the software keyboard leaves — on a
    // landscape phone, barely 200px — and a flex column cannot shrink the
    // parts that do not shrink. Without a scroll of last resort the field and
    // the commit button are drawn OUTSIDE the sheet, behind the keyboard.
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open fullHeight>
        <ResponsivePopoverContent>inner</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    const body = screen.getByText('inner');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('min-h-0');
  });
});

describe('ResponsivePopoverTitle', () => {
  it('returns null on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>
          <ResponsivePopoverTitle>My Title</ResponsivePopoverTitle>
        </ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.queryByTestId('drawer-title')).not.toBeInTheDocument();
    expect(screen.queryByText('My Title')).not.toBeInTheDocument();
  });

  it('renders DrawerTitle on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>
          <ResponsivePopoverTitle>My Title</ResponsivePopoverTitle>
        </ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('drawer-title')).toBeInTheDocument();
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('trims its own chrome in a full-height sheet, and clears the close button', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open fullHeight>
        <ResponsivePopoverContent>
          <ResponsivePopoverTitle>Title</ResponsivePopoverTitle>
        </ResponsivePopoverContent>
      </ResponsivePopover>
    );
    const header = screen.getByTestId('drawer-header');
    // Right inset keeps ANY title clear of the close button, not just a short one.
    expect(header.className).toContain('pr-14');
    expect(header.className).toContain('shrink-0');
  });

  it('keeps the roomy heading when the sheet only hugs its content', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>
          <ResponsivePopoverTitle>Title</ResponsivePopoverTitle>
        </ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('drawer-header').className ?? '').not.toContain('pr-14');
  });

  it('wraps DrawerTitle in DrawerHeader on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverContent>
          <ResponsivePopoverTitle>Title</ResponsivePopoverTitle>
        </ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('drawer-header')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-title')).toBeInTheDocument();
  });
});

describe('useResponsivePopover', () => {
  it('throws when used outside a ResponsivePopover', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function TestComponent() {
      useResponsivePopover();
      return null;
    }

    expect(() => render(<TestComponent />)).toThrow(
      'useResponsivePopover must be used within a <ResponsivePopover>'
    );
    spy.mockRestore();
  });

  it('returns isDesktop=true on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open>
        <ContextSpy />
      </ResponsivePopover>
    );
    expect(screen.getByTestId('is-desktop').textContent).toBe('true');
  });

  it('returns isDesktop=false on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ContextSpy />
      </ResponsivePopover>
    );
    expect(screen.getByTestId('is-desktop').textContent).toBe('false');
  });
});

describe('ResponsivePopoverTrigger', () => {
  it('renders PopoverTrigger on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverTrigger>Open</ResponsivePopoverTrigger>
        <ResponsivePopoverContent>content</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('popover-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-trigger')).not.toBeInTheDocument();
  });

  it('renders DrawerTrigger on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsivePopover open>
        <ResponsivePopoverTrigger>Open</ResponsivePopoverTrigger>
        <ResponsivePopoverContent>content</ResponsivePopoverContent>
      </ResponsivePopover>
    );
    expect(screen.getByTestId('drawer-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('popover-trigger')).not.toBeInTheDocument();
  });
});

describe('displayNames', () => {
  it.each([
    ['ResponsivePopover', ResponsivePopover],
    ['ResponsivePopoverTrigger', ResponsivePopoverTrigger],
    ['ResponsivePopoverContent', ResponsivePopoverContent],
    ['ResponsivePopoverTitle', ResponsivePopoverTitle],
  ])('%s has displayName set', (name, component) => {
    expect(component.displayName).toBe(name);
  });
});
