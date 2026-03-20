// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionHeader } from '../ui/SessionHeader';
import { TooltipProvider } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentVisual } from '@/layers/entities/agent';

// Mock app store (used by AgentIdentityChip and CommandPaletteTrigger)
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      openGlobalPaletteWithSearch: vi.fn(),
      setGlobalPaletteOpen: vi.fn(),
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
  name: 'TestAgent',
  description: 'A test agent',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2026-01-01T00:00:00Z',
  registeredBy: 'dorkos-ui',
  personaEnabled: false,
  enabledToolGroups: {},
};

const mockVisual: AgentVisual = {
  color: 'hsl(200, 70%, 55%)',
  emoji: '🤖',
};

function renderWithTooltip(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('SessionHeader', () => {
  it('renders AgentIdentityChip with agent name', () => {
    renderWithTooltip(<SessionHeader agent={mockAgent} visual={mockVisual} isStreaming={false} />);
    expect(screen.getByText('TestAgent')).toBeInTheDocument();
  });

  it('renders CommandPaletteTrigger', () => {
    renderWithTooltip(<SessionHeader agent={mockAgent} visual={mockVisual} isStreaming={false} />);
    // getAllByLabelText handles the case where TooltipProvider renders multiple trigger elements
    const triggers = screen.getAllByLabelText('Open command palette');
    expect(triggers.length).toBeGreaterThanOrEqual(1);
  });

  it('shows "No agent" when agent is null', () => {
    renderWithTooltip(<SessionHeader agent={null} visual={mockVisual} isStreaming={false} />);
    expect(screen.getByText('No agent')).toBeInTheDocument();
  });
});
