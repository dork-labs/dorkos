// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { CommandPaletteTrigger } from '../ui/CommandPaletteTrigger';

// The REAL app store: the palette renders on `globalPaletteOpen`, so a click is
// checked by that flag, not by which setter a fake store saw.

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

describe('CommandPaletteTrigger', () => {
  beforeEach(() => {
    useAppStore.setState({ globalPaletteOpen: false });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a button with search icon', () => {
    render(<CommandPaletteTrigger />, { wrapper: Wrapper });
    const button = screen.getByLabelText('Open command palette');
    expect(button).toBeInTheDocument();
    // Search icon is an SVG inside the button
    const svg = button.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('opens command palette on click', () => {
    render(<CommandPaletteTrigger />, { wrapper: Wrapper });
    fireEvent.click(screen.getByLabelText('Open command palette'));
    expect(useAppStore.getState().globalPaletteOpen).toBe(true);
    // Opening, not toggling: a second click must not shut it again.
    fireEvent.click(screen.getByLabelText('Open command palette'));
    expect(useAppStore.getState().globalPaletteOpen).toBe(true);
  });

  it('has correct aria-label', () => {
    render(<CommandPaletteTrigger />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Open command palette')).toBeInTheDocument();
  });
});
