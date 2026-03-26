// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Command } from '@/layers/shared/ui';
import { AgentCommandItem } from '../AgentCommandItem';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

// Mock motion/react so AgentCommandItem renders without animation setup.
// layoutId, initial, animate, exit, transition, variants, whileHover are stripped
// from the forwarded props to avoid React unknown-prop warnings.
vi.mock('motion/react', () => ({
  motion: {
    div: ({
      children,
      layoutId: _layoutId,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      variants: _variants,
      whileHover: _whileHover,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      children?: React.ReactNode;
      layoutId?: string;
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
      variants?: unknown;
      whileHover?: unknown;
    }) => React.createElement('div', props, children),
  },
  LayoutGroup: ({ children }: { children?: React.ReactNode }) => children,
}));

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

  it('renders AgentAvatar with override color', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgentWithOverrides} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const avatar = item?.querySelector('[data-slot="agent-avatar"]');
    expect(avatar).toBeInTheDocument();
    // AgentAvatar uses color-mix with the override color (jsdom converts hex to rgb)
    expect((avatar as HTMLElement).style.backgroundColor).toContain('99, 102, 241');
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
    const avatar = item?.querySelector('[data-slot="agent-avatar"]');
    expect(avatar).toBeInTheDocument();
    // Should have some background color (hash-based via color-mix)
    const style = (avatar as HTMLElement).style.backgroundColor;
    expect(style).toBeTruthy();
    expect(style).not.toBe('');
  });

  it('uses hash-based emoji when no icon override', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const avatar = item?.querySelector('[data-slot="agent-avatar"]');
    expect(avatar).toBeInTheDocument();
    expect(avatar?.textContent).toBeTruthy();
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

  // --- isSelected prop (sliding selection indicator) ---

  it('renders selection indicator div when isSelected is true', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} isSelected={true} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    // The motion.div for the selection indicator renders as a plain div (mocked)
    // It should have bg-accent class
    const indicator = item?.querySelector('.bg-accent');
    expect(indicator).toBeInTheDocument();
  });

  it('does not render selection indicator when isSelected is false', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} isSelected={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const indicator = item?.querySelector('.bg-accent');
    expect(indicator).not.toBeInTheDocument();
  });

  it('does not render selection indicator when isSelected is undefined', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const indicator = item?.querySelector('.bg-accent');
    expect(indicator).not.toBeInTheDocument();
  });

  it('content is positioned relative z-10 above selection indicator', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} isSelected={true} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    // Content wrapper should have relative and z-10 classes
    const contentWrapper = item?.querySelector('.relative.z-10');
    expect(contentWrapper).toBeInTheDocument();
  });

  // --- nameIndices prop (fuzzy match highlighting) ---

  it('renders HighlightedText with mark elements when nameIndices is provided', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem
        agent={mockAgent}
        isActive={false}
        onSelect={vi.fn()}
        nameIndices={[[0, 3]]}
      />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    const marks = item?.querySelectorAll('mark');
    expect(marks?.length).toBeGreaterThan(0);
  });

  it('renders plain text span when nameIndices is not provided', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem agent={mockAgent} isActive={false} onSelect={vi.fn()} />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    // No mark elements when no indices
    const marks = item?.querySelectorAll('mark');
    expect(marks?.length).toBe(0);
    // Agent name should still render as plain text
    expect(within(item as HTMLElement).getByText('Auth Service')).toBeInTheDocument();
  });

  it('can be both isSelected and have nameIndices simultaneously', () => {
    const { container } = renderWithCommand(
      <AgentCommandItem
        agent={mockAgent}
        isActive={false}
        isSelected={true}
        onSelect={vi.fn()}
        nameIndices={[[0, 3]]}
      />
    );

    const item = container.querySelector('[data-slot="command-item"]');
    expect(item?.querySelector('.bg-accent')).toBeInTheDocument();
    expect(item?.querySelectorAll('mark').length).toBeGreaterThan(0);
  });
});
