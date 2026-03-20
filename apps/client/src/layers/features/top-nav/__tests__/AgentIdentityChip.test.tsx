// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AgentIdentityChip } from '../ui/AgentIdentityChip';
import { TooltipProvider } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentVisual } from '@/layers/entities/agent';

// Mock app store
const mockOpenGlobalPaletteWithSearch = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      openGlobalPaletteWithSearch: mockOpenGlobalPaletteWithSearch,
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

const mockAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'backend-bot',
  description: 'REST API expert',
  runtime: 'claude-code',
  capabilities: ['code-review'],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2026-01-01T00:00:00Z',
  registeredBy: 'dorkos-ui',
  personaEnabled: true,
  enabledToolGroups: {},
};

const mockVisual: AgentVisual = {
  color: '#6366f1',
  emoji: '🤖',
};

function Wrapper({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

describe('AgentIdentityChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders agent name when agent is configured', () => {
    render(<AgentIdentityChip agent={mockAgent} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('backend-bot')).toBeInTheDocument();
  });

  it('renders "No agent" when agent is null', () => {
    render(<AgentIdentityChip agent={null} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('No agent')).toBeInTheDocument();
  });

  it('opens command palette with @ prefix on click', () => {
    render(<AgentIdentityChip agent={mockAgent} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(screen.getByLabelText('backend-bot \u2014 switch agent'));
    expect(mockOpenGlobalPaletteWithSearch).toHaveBeenCalledWith('@');
  });

  it('opens command palette with @ prefix on click when no agent', () => {
    render(<AgentIdentityChip agent={null} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    fireEvent.click(screen.getByLabelText('Switch agent'));
    expect(mockOpenGlobalPaletteWithSearch).toHaveBeenCalledWith('@');
  });

  it('renders color dot with agent color', () => {
    const { container } = render(
      <AgentIdentityChip agent={mockAgent} visual={mockVisual} isStreaming={false} />,
      { wrapper: Wrapper }
    );
    // The color dot is a motion.span with inline backgroundColor style
    // Find the small dot element (size-2 rounded-full)
    const dots = container.querySelectorAll('[aria-hidden="true"]');
    // First aria-hidden element should be the color dot (before the chevron)
    expect(dots.length).toBeGreaterThanOrEqual(1);
  });

  it('renders dashed border dot when no agent', () => {
    const { container } = render(
      <AgentIdentityChip agent={null} visual={mockVisual} isStreaming={false} />,
      { wrapper: Wrapper }
    );
    const dashedDot = container.querySelector('.border-dashed');
    expect(dashedDot).toBeInTheDocument();
  });

  it('has correct aria-label when agent is configured', () => {
    render(<AgentIdentityChip agent={mockAgent} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByLabelText('backend-bot \u2014 switch agent')).toBeInTheDocument();
  });

  it('has correct aria-label when no agent', () => {
    render(<AgentIdentityChip agent={null} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByLabelText('Switch agent')).toBeInTheDocument();
  });

  it('renders agent emoji when agent is configured', () => {
    render(<AgentIdentityChip agent={mockAgent} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('🤖')).toBeInTheDocument();
  });

  it('does not render emoji when agent is null', () => {
    render(<AgentIdentityChip agent={null} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    expect(screen.queryByText('🤖')).not.toBeInTheDocument();
  });

  it('renders chevron icon', () => {
    render(<AgentIdentityChip agent={mockAgent} visual={mockVisual} isStreaming={false} />, {
      wrapper: Wrapper,
    });
    // ChevronDown is aria-hidden, verify the button contains more than just text
    const button = screen.getByLabelText('backend-bot \u2014 switch agent');
    expect(button).toBeInTheDocument();
    // The chevron SVG should be inside the button
    const svgs = button.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });
});
