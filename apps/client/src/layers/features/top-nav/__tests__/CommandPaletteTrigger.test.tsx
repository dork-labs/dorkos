// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { CommandPaletteTrigger } from '../ui/CommandPaletteTrigger';

// Mock app store
const mockSetGlobalPaletteOpen = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
    };
    return selector ? selector(state) : state;
  },
}));

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
    vi.clearAllMocks();
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
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(true);
  });

  it('has correct aria-label', () => {
    render(<CommandPaletteTrigger />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Open command palette')).toBeInTheDocument();
  });
});
