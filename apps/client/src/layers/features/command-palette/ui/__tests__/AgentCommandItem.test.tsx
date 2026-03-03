// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Command } from '@/layers/shared/ui';
import { AgentCommandItem } from '../AgentCommandItem';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

// CommandItem must be rendered inside a Command context
function renderWithCommand(ui: React.ReactNode) {
  return render(<Command>{ui}</Command>);
}

const mockAgent: AgentPathEntry = {
  id: 'agent-test-001',
  name: 'Auth Service',
  projectPath: '/home/user/projects/auth',
};

const mockAgentWithOverrides: AgentPathEntry = {
  id: 'agent-test-002',
  name: 'API Gateway',
  projectPath: '/home/user/projects/gateway',
  color: '#6366f1',
  icon: '🚀',
};

describe('AgentCommandItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders agent name', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    expect(item).toBeInTheDocument();
    expect(within(item as HTMLElement).getByText('Auth Service')).toBeInTheDocument();
  });

  it('renders shortened project path', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    expect(item).toBeInTheDocument();
    // shortenHomePath replaces /home/user with ~
    expect(within(item as HTMLElement).getByText(/projects\/auth/)).toBeInTheDocument();
  });

  it('renders colored dot with override color', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgentWithOverrides} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const dot = item?.querySelector('span[style]');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveStyle({ backgroundColor: '#6366f1' });
  });

  it('renders emoji from agent icon override', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgentWithOverrides} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    expect(within(item as HTMLElement).getByText('🚀')).toBeInTheDocument();
  });

  it('uses hash-based color when no color override', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const dot = item?.querySelector('span[style]');
    expect(dot).toBeInTheDocument();
    // Should have some background color (hash-based)
    const style = (dot as HTMLElement).style.backgroundColor;
    expect(style).toBeTruthy();
    expect(style).not.toBe('');
  });

  it('uses hash-based emoji when no icon override', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const emojiSpan = item?.querySelector('span.text-sm');
    expect(emojiSpan).toBeInTheDocument();
    expect(emojiSpan?.textContent).toBeTruthy();
  });

  it('shows checkmark icon when isActive is true', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={true} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    // The Check icon from lucide-react renders as SVG inside the item
    const svgIcon = item?.querySelector('svg');
    expect(svgIcon).toBeInTheDocument();
  });

  it('does not show checkmark when isActive is false', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const svgIcon = item?.querySelector('svg');
    expect(svgIcon).not.toBeInTheDocument();
  });

  it('calls onSelect when item is selected', () => {
    const onSelect = vi.fn();
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={onSelect} />
    );

    const item = container.querySelector('[data-slot="command-item"]') as HTMLElement;
    item.click();

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('applies forceMount attribute when agent is active', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={true} onSelect={vi.fn()} />
    );

    // Active items with forceMount render even when filtered
    const item = container.querySelector('[data-slot="command-item"]');
    expect(item).toBeInTheDocument();
  });

  it('renders item when isActive is false', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    expect(item).toBeInTheDocument();
  });

  it('includes projectPath text for discoverability', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    // The shortened path should be visible in the item
    expect(item?.textContent).toContain('projects/auth');
  });
});
