// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentHeader } from '../ui/AgentHeader';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// Mock useIsMobile — desktop by default
const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model/use-is-mobile', () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

// Mock app-store to capture setGlobalPaletteOpen calls
const mockSetGlobalPaletteOpen = vi.fn();
vi.mock('@/layers/shared/model/app-store', () => ({
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
};

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('AgentHeader', () => {
  let mockTransport: Transport;
  const onOpenPicker = vi.fn();
  const onOpenAgentDialog = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
    mockUseIsMobile.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders agent name, description, and Switch button when agent exists', async () => {
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(mockAgent);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText('backend-bot')).toBeInTheDocument();
    });
    expect(screen.getByText('REST API expert')).toBeInTheDocument();
    expect(screen.getByLabelText('Switch agent')).toBeInTheDocument();
  });

  it('renders "+ Agent" button and Switch button when no agent', async () => {
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(null);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Create agent for this directory')).toBeInTheDocument();
    });
    expect(screen.queryByText('backend-bot')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Open command palette')).toBeInTheDocument();
  });

  it('clicking agent identity area calls onOpenAgentDialog on desktop', async () => {
    mockUseIsMobile.mockReturnValue(false);
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(mockAgent);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText('backend-bot')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(/Agent settings for/));
    expect(onOpenAgentDialog).toHaveBeenCalledOnce();
  });

  it('clicking agent identity area opens palette on mobile', async () => {
    mockUseIsMobile.mockReturnValue(true);
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(mockAgent);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText('backend-bot')).toBeInTheDocument();
    });

    // On mobile, the identity button has a specific aria-label including the agent name
    fireEvent.click(screen.getByLabelText('Switch agent (current: backend-bot)'));
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(true);
    expect(onOpenAgentDialog).not.toHaveBeenCalled();
  });

  it('clicking gear icon calls onOpenAgentDialog', async () => {
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(mockAgent);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText('backend-bot')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Agent settings'));
    expect(onOpenAgentDialog).toHaveBeenCalled();
  });

  it('clicking Switch button calls setGlobalPaletteOpen(true) when agent exists', async () => {
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(mockAgent);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText('backend-bot')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Switch agent'));
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(true);
  });

  it('clicking directory button calls onOpenPicker when no agent', async () => {
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(null);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Create agent for this directory')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Change working directory'));
    expect(onOpenPicker).toHaveBeenCalledOnce();
  });

  it('clicking Switch button opens palette when no agent', async () => {
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(null);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Create agent for this directory')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Open command palette'));
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(true);
  });

  it('clicking "+ Agent" calls createAgent mutation', async () => {
    vi.mocked(mockTransport.getAgentByPath).mockResolvedValue(null);
    vi.mocked(mockTransport.createAgent).mockResolvedValue(mockAgent);
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Create agent for this directory')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Create agent for this directory'));

    await waitFor(() => {
      expect(mockTransport.createAgent).toHaveBeenCalledWith('/project', undefined, undefined, undefined);
    });
  });

  it('does not show agent content during loading', () => {
    vi.mocked(mockTransport.getAgentByPath).mockReturnValue(new Promise(() => {}));
    const Wrapper = createWrapper(mockTransport);

    render(
      <Wrapper>
        <AgentHeader cwd="/project" onOpenPicker={onOpenPicker} onOpenAgentDialog={onOpenAgentDialog} />
      </Wrapper>
    );

    expect(screen.queryByText('backend-bot')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Create agent for this directory')).not.toBeInTheDocument();
  });
});
