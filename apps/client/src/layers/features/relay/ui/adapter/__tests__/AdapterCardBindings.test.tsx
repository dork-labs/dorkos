/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AdapterCardBindings } from '../AdapterCardBindings';
import type { AdapterBinding, CatalogInstance } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Mock child components that depend on entity hooks
// ---------------------------------------------------------------------------

vi.mock('../AdapterBindingRow', () => ({
  AdapterBindingRow: ({
    agentName,
    sessionStrategy,
    chatId,
  }: {
    agentName: string;
    sessionStrategy: string;
    chatId?: string;
  }) => (
    <span data-testid="binding-row">
      {agentName}
      {sessionStrategy !== 'per-chat' && ` (${sessionStrategy})`}
      {chatId ? ` [${chatId}]` : null}
    </span>
  ),
}));

vi.mock('../../QuickBindingPopover', () => ({
  QuickBindingPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const connectedInstance: CatalogInstance = {
  id: 'tg-main',
  enabled: true,
  status: {
    id: 'tg-main',
    type: 'telegram',
    displayName: 'Main Telegram',
    state: 'connected',
    messageCount: { inbound: 10, outbound: 5 },
    errorCount: 0,
  },
};

function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: 'b1',
    adapterId: 'tg-main',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: '',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as AdapterBinding;
}

function makeBoundRow(overrides: Record<string, unknown> = {}) {
  const bindingId = (overrides.bindingId as string) ?? 'b1';
  return {
    bindingId,
    agentName: 'Alpha Bot',
    sessionStrategy: 'per-chat',
    binding: makeBinding({ id: bindingId }),
    ...overrides,
  };
}

function defaultProps(overrides: Partial<Parameters<typeof AdapterCardBindings>[0]> = {}) {
  return {
    instance: connectedInstance,
    isBuiltinClaude: false,
    boundAgentRows: [],
    totalAgentCount: 3,
    isConnected: true,
    hasBindings: false,
    onEditBinding: vi.fn(),
    onQuickBind: vi.fn().mockResolvedValue(undefined),
    onAdvancedBind: vi.fn(),
    createBindingPending: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterCardBindings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // -------------------------------------------------------------------------
  // CCA summary
  // -------------------------------------------------------------------------

  it('shows "Serving N agents" for built-in Claude adapter', () => {
    render(
      <AdapterCardBindings {...defaultProps({ isBuiltinClaude: true, totalAgentCount: 5 })} />
    );
    expect(screen.getByText(/Serving 5 agents/)).toBeInTheDocument();
  });

  it('shows singular "agent" when CCA serves exactly 1', () => {
    render(
      <AdapterCardBindings {...defaultProps({ isBuiltinClaude: true, totalAgentCount: 1 })} />
    );
    expect(screen.getByText(/Serving 1 agent/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Binding rows
  // -------------------------------------------------------------------------

  it('renders binding rows when hasBindings is true', () => {
    const rows = [
      makeBoundRow({ bindingId: 'b1', agentName: 'Alpha Bot' }),
      makeBoundRow({ bindingId: 'b2', agentName: 'Beta Bot' }),
    ];

    render(
      <AdapterCardBindings
        {...defaultProps({
          boundAgentRows: rows,
          hasBindings: true,
        })}
      />
    );

    expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
    expect(screen.getByText('Beta Bot')).toBeInTheDocument();
  });

  it('calls onEditBinding when a binding row is clicked', () => {
    const onEditBinding = vi.fn();
    const binding = makeBinding({ id: 'b1' });
    const row = makeBoundRow({ bindingId: 'b1', agentName: 'Alpha Bot' });

    render(
      <AdapterCardBindings
        {...defaultProps({
          boundAgentRows: [row],
          hasBindings: true,
          onEditBinding,
        })}
      />
    );

    fireEvent.click(screen.getByText('Alpha Bot'));
    expect(onEditBinding).toHaveBeenCalledWith(binding);
  });

  // -------------------------------------------------------------------------
  // Overflow / "Show N more"
  // -------------------------------------------------------------------------

  it('shows "Show N more" when bindings exceed 3', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeBoundRow({ bindingId: `b${i}`, agentName: `Agent ${i}` })
    );

    render(
      <AdapterCardBindings
        {...defaultProps({
          boundAgentRows: rows,
          hasBindings: true,
        })}
      />
    );

    expect(screen.getByText('Show 2 more')).toBeInTheDocument();
    // Only first 3 visible
    expect(screen.getByText('Agent 0')).toBeInTheDocument();
    expect(screen.getByText('Agent 1')).toBeInTheDocument();
    expect(screen.getByText('Agent 2')).toBeInTheDocument();
    expect(screen.queryByText('Agent 3')).not.toBeInTheDocument();
  });

  it('expands to show all bindings when "Show N more" is clicked', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeBoundRow({ bindingId: `b${i}`, agentName: `Agent ${i}` })
    );

    render(
      <AdapterCardBindings
        {...defaultProps({
          boundAgentRows: rows,
          hasBindings: true,
        })}
      />
    );

    fireEvent.click(screen.getByText('Show 2 more'));

    expect(screen.getByText('Agent 3')).toBeInTheDocument();
    expect(screen.getByText('Agent 4')).toBeInTheDocument();
    expect(screen.getByText('Show less')).toBeInTheDocument();
  });

  it('collapses back when "Show less" is clicked', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeBoundRow({ bindingId: `b${i}`, agentName: `Agent ${i}` })
    );

    render(
      <AdapterCardBindings
        {...defaultProps({
          boundAgentRows: rows,
          hasBindings: true,
        })}
      />
    );

    fireEvent.click(screen.getByText('Show 2 more'));
    fireEvent.click(screen.getByText('Show less'));

    expect(screen.queryByText('Agent 3')).not.toBeInTheDocument();
    expect(screen.getByText('Show 2 more')).toBeInTheDocument();
  });

  it('does not show overflow link when bindings are 3 or fewer', () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeBoundRow({ bindingId: `b${i}`, agentName: `Agent ${i}` })
    );

    render(
      <AdapterCardBindings
        {...defaultProps({
          boundAgentRows: rows,
          hasBindings: true,
        })}
      />
    );

    expect(screen.queryByText(/Show \d+ more/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // No-bindings state (connected, not CCA)
  // -------------------------------------------------------------------------

  it('shows "add channel" button when connected with no bindings', () => {
    render(<AdapterCardBindings {...defaultProps()} />);
    expect(screen.getByRole('button', { name: /add channel/i })).toBeInTheDocument();
  });

  it('renders nothing when disconnected with no bindings', () => {
    const { container } = render(<AdapterCardBindings {...defaultProps({ isConnected: false })} />);
    // Should not show add channel or any binding rows
    expect(screen.queryByRole('button', { name: /add channel/i })).not.toBeInTheDocument();
    // The container should have the wrapper div but no meaningful children
    expect(container.querySelector('[data-testid="binding-row"]')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // "add channel" button when bindings exist
  // -------------------------------------------------------------------------

  it('shows "add channel" button even when bindings exist', () => {
    const rows = [makeBoundRow()];

    render(
      <AdapterCardBindings
        {...defaultProps({
          boundAgentRows: rows,
          hasBindings: true,
        })}
      />
    );

    expect(screen.getByRole('button', { name: /add channel/i })).toBeInTheDocument();
  });
});
