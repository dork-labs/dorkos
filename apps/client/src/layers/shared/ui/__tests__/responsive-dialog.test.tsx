// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogClose,
  ResponsiveDialogBody,
  ResponsiveDialogFullscreenToggle,
  useResponsiveDialog,
} from '../responsive-dialog';

// Mock useIsMobile to control desktop/mobile rendering.
// The component imports from '../model' which resolves to the shared/model barrel.
const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => mockUseIsMobile(),
}));

// Mock Radix Dialog to render simple DOM elements for testing
vi.mock('../dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open !== false ? <div data-testid="dialog-root">{children}</div> : null,
  DialogTrigger: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button data-testid="dialog-trigger" {...props}>
      {children}
    </button>
  ),
  DialogContent: ({
    children,
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) => (
    <div data-testid="dialog-content" className={className} {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="dialog-header" {...props}>
      {children}
    </div>
  ),
  DialogTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 data-testid="dialog-title" {...props}>
      {children}
    </h2>
  ),
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p data-testid="dialog-description" {...props}>
      {children}
    </p>
  ),
  DialogFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="dialog-footer" {...props}>
      {children}
    </div>
  ),
  DialogClose: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button data-testid="dialog-close" {...props}>
      {children}
    </button>
  ),
}));

// Mock Vaul Drawer to render simple DOM elements for testing
vi.mock('../drawer', () => ({
  Drawer: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open !== false ? <div data-testid="drawer-root">{children}</div> : null,
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
  DrawerHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="drawer-header" {...props}>
      {children}
    </div>
  ),
  DrawerTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 data-testid="drawer-title" {...props}>
      {children}
    </h2>
  ),
  DrawerDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p data-testid="drawer-description" {...props}>
      {children}
    </p>
  ),
  DrawerFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="drawer-footer" {...props}>
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
}));

/** Renders context values into the DOM for assertion. */
function ContextSpy() {
  const { isDesktop, isFullscreen } = useResponsiveDialog();
  return (
    <>
      <span data-testid="is-desktop">{String(isDesktop)}</span>
      <span data-testid="fs-state">{String(isFullscreen)}</span>
    </>
  );
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mockUseIsMobile.mockReturnValue(false);
});

describe('ResponsiveDialog', () => {
  it('renders Dialog on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent>content</ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    expect(screen.getByTestId('dialog-root')).toBeInTheDocument();
    expect(screen.queryByTestId('drawer-root')).not.toBeInTheDocument();
  });

  it('renders Drawer on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent>content</ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    expect(screen.getByTestId('drawer-root')).toBeInTheDocument();
    expect(screen.queryByTestId('dialog-root')).not.toBeInTheDocument();
  });
});

describe('ResponsiveDialogContent', () => {
  it('forwards props to DialogContent on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent data-testid="custom-id" aria-describedby="desc">
          content
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    const content = screen.getByTestId('custom-id');
    expect(content).toBeInTheDocument();
    expect(content).toHaveAttribute('aria-describedby', 'desc');
  });

  it('forwards props to DrawerContent on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent data-testid="custom-id" aria-describedby="desc">
          content
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    const content = screen.getByTestId('custom-id');
    expect(content).toBeInTheDocument();
    expect(content).toHaveAttribute('aria-describedby', 'desc');
  });
});

describe('useResponsiveDialog', () => {
  it('throws when used outside a ResponsiveDialog', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function TestComponent() {
      useResponsiveDialog();
      return null;
    }

    expect(() => render(<TestComponent />)).toThrow(
      'useResponsiveDialog must be used within a <ResponsiveDialog>'
    );
    spy.mockRestore();
  });

  it('returns isDesktop=true on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveDialog open>
        <ContextSpy />
      </ResponsiveDialog>
    );
    expect(screen.getByTestId('is-desktop').textContent).toBe('true');
    expect(screen.getByTestId('fs-state').textContent).toBe('false');
  });

  it('returns isDesktop=false on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsiveDialog open>
        <ContextSpy />
      </ResponsiveDialog>
    );
    expect(screen.getByTestId('is-desktop').textContent).toBe('false');
    expect(screen.getByTestId('fs-state').textContent).toBe('false');
  });
});

describe('ResponsiveDialogBody', () => {
  it('renders with correct data-slot and classes', () => {
    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent>
          <ResponsiveDialogBody data-testid="body">body content</ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    const body = screen.getByTestId('body');
    expect(body).toHaveAttribute('data-slot', 'responsive-dialog-body');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('px-4');
  });

  it('merges custom className', () => {
    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent>
          <ResponsiveDialogBody data-testid="body" className="py-6">
            content
          </ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    const body = screen.getByTestId('body');
    expect(body.className).toContain('py-6');
  });
});

describe('ResponsiveDialogFullscreenToggle', () => {
  it('renders on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent>
          <ResponsiveDialogFullscreenToggle />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeInTheDocument();
  });

  it('returns null on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    const { container } = render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent>
          <ResponsiveDialogFullscreenToggle />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    expect(screen.queryByRole('button', { name: /fullscreen/i })).not.toBeInTheDocument();
    expect(container.querySelectorAll('[aria-label*="fullscreen"]')).toHaveLength(0);
  });

  it('toggles fullscreen state on click', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent>
          <ResponsiveDialogFullscreenToggle />
          <ContextSpy />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );

    expect(screen.getByTestId('fs-state').textContent).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    expect(screen.getByTestId('fs-state').textContent).toBe('true');
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument();
  });
});

describe('defaultFullscreen', () => {
  it('starts fullscreen when defaultFullscreen is true', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveDialog open defaultFullscreen>
        <ResponsiveDialogContent>
          <ContextSpy />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    expect(screen.getByTestId('fs-state').textContent).toBe('true');
  });

  it('isFullscreen is always false on mobile even with defaultFullscreen', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsiveDialog open defaultFullscreen>
        <ResponsiveDialogContent>
          <ContextSpy />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );
    expect(screen.getByTestId('fs-state').textContent).toBe('false');
  });

  it('resets fullscreen state when dialog closes', () => {
    mockUseIsMobile.mockReturnValue(false);

    function TestWrapper() {
      const [open, setOpen] = React.useState(true);
      return (
        <>
          <button data-testid="close-btn" onClick={() => setOpen(false)}>
            close
          </button>
          <button data-testid="open-btn" onClick={() => setOpen(true)}>
            open
          </button>
          <ResponsiveDialog open={open} onOpenChange={setOpen}>
            <ResponsiveDialogContent>
              <ResponsiveDialogFullscreenToggle />
              <ContextSpy />
            </ResponsiveDialogContent>
          </ResponsiveDialog>
        </>
      );
    }

    render(<TestWrapper />);
    expect(screen.getByTestId('fs-state').textContent).toBe('false');
  });
});

describe('fullscreen data attribute', () => {
  it('sets data-fullscreen on desktop content when fullscreen', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveDialog open defaultFullscreen>
        <ResponsiveDialogContent data-testid="content">
          <ResponsiveDialogFullscreenToggle />
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    );

    const content = screen.getByTestId('content');
    expect(content).toHaveAttribute('data-fullscreen');

    // Toggle off
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    expect(content).not.toHaveAttribute('data-fullscreen');
  });
});

describe('displayNames', () => {
  it.each([
    ['ResponsiveDialog', ResponsiveDialog],
    ['ResponsiveDialogTrigger', ResponsiveDialogTrigger],
    ['ResponsiveDialogContent', ResponsiveDialogContent],
    ['ResponsiveDialogHeader', ResponsiveDialogHeader],
    ['ResponsiveDialogTitle', ResponsiveDialogTitle],
    ['ResponsiveDialogDescription', ResponsiveDialogDescription],
    ['ResponsiveDialogFooter', ResponsiveDialogFooter],
    ['ResponsiveDialogClose', ResponsiveDialogClose],
    ['ResponsiveDialogBody', ResponsiveDialogBody],
    ['ResponsiveDialogFullscreenToggle', ResponsiveDialogFullscreenToggle],
  ])('%s has displayName set', (name, component) => {
    expect(component.displayName).toBe(name);
  });
});
