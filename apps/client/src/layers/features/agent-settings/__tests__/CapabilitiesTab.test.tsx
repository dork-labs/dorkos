// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CapabilitiesTab } from '../ui/CapabilitiesTab';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const baseAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A mock agent',
  runtime: 'claude-code',
  capabilities: ['code-review', 'testing'],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
};

/**
 * Helper to scope queries to the rendered container, avoiding duplicates
 * from portal-based components or React strict mode.
 */
function renderTab(agent: AgentManifest, onUpdate: ReturnType<typeof vi.fn>) {
  const { container } = render(<CapabilitiesTab agent={agent} onUpdate={onUpdate} />);
  return within(container);
}

describe('CapabilitiesTab', () => {
  let onUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onUpdate = vi.fn();
  });

  it('renders existing capabilities as badges', () => {
    const view = renderTab(baseAgent, onUpdate);

    expect(view.getByText('code-review')).toBeInTheDocument();
    expect(view.getByText('testing')).toBeInTheDocument();
  });

  it('adds a capability when Enter is pressed', () => {
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Add capability and press Enter');
    fireEvent.change(input, { target: { value: 'deployment' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdate).toHaveBeenCalledWith({
      capabilities: ['code-review', 'testing', 'deployment'],
    });
  });

  it('does not add duplicate capabilities', () => {
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Add capability and press Enter');
    fireEvent.change(input, { target: { value: 'code-review' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does not add empty capabilities', () => {
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Add capability and press Enter');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('removes a capability when X button is clicked', () => {
    const view = renderTab(baseAgent, onUpdate);

    const removeBtn = view.getByLabelText('Remove code-review');
    fireEvent.click(removeBtn);

    expect(onUpdate).toHaveBeenCalledWith({
      capabilities: ['testing'],
    });
  });

  it('renders response mode dropdown with current value', () => {
    const view = renderTab(baseAgent, onUpdate);

    expect(view.getByText('Always respond')).toBeInTheDocument();
  });

  it('renders budget fields with default values', () => {
    const view = renderTab(baseAgent, onUpdate);

    const spinbuttons = view.getAllByRole('spinbutton');
    expect(spinbuttons).toHaveLength(2);
    expect(spinbuttons[0]).toHaveValue(5);
    expect(spinbuttons[1]).toHaveValue(100);
  });

  it('renders namespace input', () => {
    const view = renderTab(baseAgent, onUpdate);

    expect(view.getByPlaceholderText('Optional grouping namespace')).toBeInTheDocument();
  });

  it('debounces namespace input and calls onUpdate after delay', () => {
    vi.useFakeTimers();
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Optional grouping namespace');
    fireEvent.change(input, { target: { value: 'my-ns' } });

    // Should not fire immediately
    expect(onUpdate).not.toHaveBeenCalled();

    // After debounce, should fire
    vi.advanceTimersByTime(500);
    expect(onUpdate).toHaveBeenCalledWith({ namespace: 'my-ns' });

    vi.useRealTimers();
  });

  it('flushes namespace on blur without waiting for debounce', () => {
    vi.useFakeTimers();
    const view = renderTab(baseAgent, onUpdate);

    const input = view.getByPlaceholderText('Optional grouping namespace');
    fireEvent.change(input, { target: { value: 'blur-ns' } });
    fireEvent.blur(input);

    expect(onUpdate).toHaveBeenCalledWith({ namespace: 'blur-ns' });

    vi.useRealTimers();
  });
});
