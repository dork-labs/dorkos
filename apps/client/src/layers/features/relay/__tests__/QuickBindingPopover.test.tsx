/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QuickBindingPopover } from '../ui/QuickBindingPopover';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseRegisteredAgents = vi.fn();
const mockUseBindings = vi.fn();

vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: (...args: unknown[]) => mockUseRegisteredAgents(...args),
}));

vi.mock('@/layers/entities/binding', () => ({
  useBindings: (...args: unknown[]) => mockUseBindings(...args),
}));

// Mock browser APIs needed by Popover and cmdk.
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

  // cmdk uses ResizeObserver internally.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  // cmdk calls scrollIntoView on highlighted items.
  Element.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const agents = [
  { id: 'agent-1', name: 'Alpha Bot' },
  { id: 'agent-2', name: 'Beta Bot' },
];

const makeBinding = (adapterId: string, agentId: string) => ({
  id: `${adapterId}-${agentId}`,
  adapterId,
  agentId,
  sessionStrategy: 'per-chat' as const,
  label: '',
  permissionMode: 'acceptEdits' as const,
  canInitiate: false,
  canReply: true,
  canReceive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps(overrides: Partial<Parameters<typeof QuickBindingPopover>[0]> = {}) {
  return {
    adapterId: 'tg-1',
    onQuickBind: vi.fn().mockResolvedValue(undefined),
    onAdvanced: vi.fn(),
    isPending: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuickBindingPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRegisteredAgents.mockReturnValue({ data: { agents } });
    mockUseBindings.mockReturnValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows agent list when popover is opened', async () => {
    render(
      <QuickBindingPopover {...defaultProps()}>
        <button>Add binding</button>
      </QuickBindingPopover>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
    });
  });

  it('shows empty state when no agents are registered', async () => {
    mockUseRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    render(
      <QuickBindingPopover {...defaultProps()}>
        <button>Add binding</button>
      </QuickBindingPopover>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    });

    await waitFor(() => {
      expect(screen.getByText('No agents registered')).toBeInTheDocument();
    });
  });

  it('calls onAdvanced when "Advanced…" is clicked', async () => {
    const onAdvanced = vi.fn();

    render(
      <QuickBindingPopover {...defaultProps({ onAdvanced })}>
        <button>Add binding</button>
      </QuickBindingPopover>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Advanced…')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Advanced…'));
    });

    expect(onAdvanced).toHaveBeenCalledTimes(1);
  });

  it('excludes agents already bound to the adapter', async () => {
    // agent-1 is already bound to adapter tg-1
    mockUseBindings.mockReturnValue({
      data: [makeBinding('tg-1', 'agent-1')],
    });

    render(
      <QuickBindingPopover {...defaultProps({ adapterId: 'tg-1' })}>
        <button>Add binding</button>
      </QuickBindingPopover>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    });

    await waitFor(() => {
      // agent-2 is not bound — should appear
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
    });

    // agent-1 is already bound to tg-1 — must not appear
    expect(screen.queryByText('Alpha Bot')).not.toBeInTheDocument();
  });

  it('shows all agents when none are bound to the adapter', async () => {
    // Binding exists for a different adapter — should not affect tg-1 list
    mockUseBindings.mockReturnValue({
      data: [makeBinding('tg-2', 'agent-1')],
    });

    render(
      <QuickBindingPopover {...defaultProps({ adapterId: 'tg-1' })}>
        <button>Add binding</button>
      </QuickBindingPopover>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
    });
  });

  it('shows empty state when all agents are already bound to the adapter', async () => {
    mockUseBindings.mockReturnValue({
      data: [makeBinding('tg-1', 'agent-1'), makeBinding('tg-1', 'agent-2')],
    });

    render(
      <QuickBindingPopover {...defaultProps({ adapterId: 'tg-1' })}>
        <button>Add binding</button>
      </QuickBindingPopover>
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    });

    await waitFor(() => {
      expect(screen.getByText('No agents registered')).toBeInTheDocument();
    });
  });
});
