// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import {
  ResponsiveSheet,
  ResponsiveSheetTrigger,
  ResponsiveSheetContent,
  ResponsiveSheetHeader,
  ResponsiveSheetTitle,
  ResponsiveSheetDescription,
  ResponsiveSheetClose,
} from '../responsive-sheet';

// Mock useIsMobile to control desktop/mobile rendering. The component imports
// from '../model' which resolves to the shared/model barrel.
const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => mockUseIsMobile(),
}));

// Mock the underlying Sheet primitives to render simple DOM elements for
// testing, following the same pattern as responsive-dialog.test.tsx and
// responsive-popover.test.tsx.
vi.mock('../sheet', () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open !== false ? <div data-testid="sheet-root">{children}</div> : null,
  SheetTrigger: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button data-testid="sheet-trigger" {...props}>
      {children}
    </button>
  ),
  SheetClose: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button data-testid="sheet-close" {...props}>
      {children}
    </button>
  ),
  SheetContent: ({
    children,
    className,
    side,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode; side?: string }) => (
    <div data-testid="sheet-content" data-side={side} className={className} {...props}>
      {children}
    </div>
  ),
  SheetHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="sheet-header" {...props}>
      {children}
    </div>
  ),
  SheetFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="sheet-footer" {...props}>
      {children}
    </div>
  ),
  SheetTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <span data-testid="sheet-title" {...props}>
      {children}
    </span>
  ),
  SheetDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p data-testid="sheet-description" {...props}>
      {children}
    </p>
  ),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mockUseIsMobile.mockReturnValue(false);
  vi.clearAllMocks();
});

describe('ResponsiveSheetContent', () => {
  it('carries the desktop width class when useIsMobile is false', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent>content</ResponsiveSheetContent>
      </ResponsiveSheet>
    );

    const content = screen.getByTestId('sheet-content');
    expect(content.className).toContain('sm:max-w-md');
    expect(content.className).not.toContain('w-full');
  });

  it('carries the mobile full-width class when useIsMobile is true', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent>content</ResponsiveSheetContent>
      </ResponsiveSheet>
    );

    const content = screen.getByTestId('sheet-content');
    expect(content.className).toContain('w-full');
    expect(content.className).toContain('sm:max-w-full');
  });

  it('always renders side="right", on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent>content</ResponsiveSheetContent>
      </ResponsiveSheet>
    );
    expect(screen.getByTestId('sheet-content')).toHaveAttribute('data-side', 'right');
  });

  it('always renders side="right", on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent>content</ResponsiveSheetContent>
      </ResponsiveSheet>
    );
    expect(screen.getByTestId('sheet-content')).toHaveAttribute('data-side', 'right');
  });

  it('lets a caller className override the computed width via tailwind-merge', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent className="sm:max-w-full">content</ResponsiveSheetContent>
      </ResponsiveSheet>
    );

    const content = screen.getByTestId('sheet-content');
    // Desktop's computed sm:max-w-md is overridden by the caller's sm:max-w-full.
    expect(content.className).toContain('sm:max-w-full');
    expect(content.className).not.toContain('max-w-md');
  });

  it('merges a caller className that does not conflict with the width', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent className="bg-sidebar p-0">content</ResponsiveSheetContent>
      </ResponsiveSheet>
    );

    const content = screen.getByTestId('sheet-content');
    expect(content.className).toContain('bg-sidebar');
    expect(content.className).toContain('p-0');
    expect(content.className).toContain('sm:max-w-md');
  });
});

describe('the Sheet parts re-exported for API symmetry with the other Responsive* families', () => {
  it('ResponsiveSheetTrigger renders a trigger', () => {
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetTrigger>Open</ResponsiveSheetTrigger>
        <ResponsiveSheetContent>content</ResponsiveSheetContent>
      </ResponsiveSheet>
    );
    expect(screen.getByTestId('sheet-trigger')).toBeInTheDocument();
  });

  it('ResponsiveSheetHeader, ResponsiveSheetTitle and ResponsiveSheetDescription render', () => {
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent>
          <ResponsiveSheetHeader>
            <ResponsiveSheetTitle>Title</ResponsiveSheetTitle>
            <ResponsiveSheetDescription>Description</ResponsiveSheetDescription>
          </ResponsiveSheetHeader>
        </ResponsiveSheetContent>
      </ResponsiveSheet>
    );
    expect(screen.getByTestId('sheet-header')).toBeInTheDocument();
    expect(screen.getByTestId('sheet-title')).toHaveTextContent('Title');
    expect(screen.getByTestId('sheet-description')).toHaveTextContent('Description');
  });

  it('ResponsiveSheetClose renders a close control', () => {
    render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent>
          <ResponsiveSheetClose>Close</ResponsiveSheetClose>
        </ResponsiveSheetContent>
      </ResponsiveSheet>
    );
    expect(screen.getByTestId('sheet-close')).toBeInTheDocument();
  });

  it('ResponsiveSheet renders nothing when closed', () => {
    const { container } = render(
      <ResponsiveSheet open={false}>
        <ResponsiveSheetContent>content</ResponsiveSheetContent>
      </ResponsiveSheet>
    );
    expect(container.innerHTML).toBe('');
  });
});
