// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AgentDialog } from '../ui/AgentDialog';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// Mock matchMedia for responsive components
beforeEach(() => {
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
  name: 'test-agent',
  description: 'A mock agent for testing',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
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

/**
 * Helper to scope queries to the first dialog with data-testid="agent-dialog".
 * ResponsiveDialog renders both a Dialog and a Drawer, so multiple elements may exist.
 */
async function findDialog() {
  const dialogs = await screen.findAllByTestId('agent-dialog');
  return dialogs[0];
}

describe('AgentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dialog with agent name when open and agent exists', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(mockAgent),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <AgentDialog projectPath="/projects/myapp" open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    const dialog = await findDialog();
    expect(within(dialog).getByText('test-agent')).toBeInTheDocument();
    expect(within(dialog).getByText('Agent configuration')).toBeInTheDocument();
  });

  it('shows "No agent registered" when agent is null', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(null),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <AgentDialog projectPath="/projects/no-agent" open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    // The null-agent fallback renders in both Dialog and Drawer, so use findAllByText
    const matches = await screen.findAllByText('No agent registered');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('renders all 4 tab triggers', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(mockAgent),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <AgentDialog projectPath="/projects/myapp" open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    const dialog = await findDialog();
    // Dialog element has aria-hidden in portaled context, use hidden: true to access roles
    expect(within(dialog).getByRole('tab', { name: 'Identity', hidden: true })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Persona', hidden: true })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('tab', { name: 'Capabilities', hidden: true })
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('tab', { name: 'Connections', hidden: true })
    ).toBeInTheDocument();
  });

  it('shows name input in Identity tab', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(mockAgent),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <AgentDialog projectPath="/projects/myapp" open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    const dialog = await findDialog();
    const nameInput = within(dialog).getByPlaceholderText('Agent name');
    expect(nameInput).toBeInTheDocument();
    expect(nameInput).toHaveValue('test-agent');
  });

  it('shows color preset buttons', async () => {
    const transport = createMockTransport({
      getAgentByPath: vi.fn().mockResolvedValue(mockAgent),
    });
    const Wrapper = createWrapper(transport);

    render(
      <Wrapper>
        <AgentDialog projectPath="/projects/myapp" open={true} onOpenChange={vi.fn()} />
      </Wrapper>
    );

    const dialog = await findDialog();
    const colorButtons = within(dialog).getAllByLabelText(/Select color #/);
    expect(colorButtons).toHaveLength(10);
  });
});
