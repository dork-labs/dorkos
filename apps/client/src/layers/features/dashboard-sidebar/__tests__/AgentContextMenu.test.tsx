import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentContextMenu } from '../ui/AgentContextMenu';

// ContextMenu relies on pointer events and ResizeObserver — mock both for jsdom.
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Radix portals attach to document.body; explicit cleanup ensures no DOM bleed
// between tests when menus are left open.
afterEach(() => {
  cleanup();
});

const defaultProps = {
  agentPath: '/agents/test',
  isPinned: false,
  onTogglePin: vi.fn(),
  onManage: vi.fn(),
  onEditSettings: vi.fn(),
  onNewSession: vi.fn(),
};

/** Return the non-aria-hidden trigger when Radix clones the trigger into a portal wrapper. */
function getTrigger(container: HTMLElement) {
  // Radix may render two copies of the trigger: one in the portal (aria-hidden)
  // and one in the actual DOM. Target the one directly inside our render root.
  return container.querySelector('[data-testid="trigger"]') as HTMLElement;
}

describe('AgentContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children without opening menu by default', () => {
    const { container } = render(
      <AgentContextMenu {...defaultProps}>
        <div data-testid="child">Agent Row</div>
      </AgentContextMenu>
    );

    expect(container.querySelector('[data-testid="child"]')).toBeInTheDocument();
    // Menu content is rendered in a portal only after trigger — not visible yet
    expect(screen.queryByText('Pin agent')).not.toBeInTheDocument();
  });

  it('opens context menu and shows "Pin agent" when isPinned is false', () => {
    const { container } = render(
      <AgentContextMenu {...defaultProps} isPinned={false}>
        <div data-testid="trigger">Agent Row</div>
      </AgentContextMenu>
    );

    fireEvent.contextMenu(getTrigger(container));

    expect(screen.getByText('Pin agent')).toBeInTheDocument();
    expect(screen.queryByText('Unpin agent')).not.toBeInTheDocument();
  });

  it('opens context menu and shows "Unpin agent" when isPinned is true', () => {
    const { container } = render(
      <AgentContextMenu {...defaultProps} isPinned={true}>
        <div data-testid="trigger">Agent Row</div>
      </AgentContextMenu>
    );

    fireEvent.contextMenu(getTrigger(container));

    expect(screen.getByText('Unpin agent')).toBeInTheDocument();
    expect(screen.queryByText('Pin agent')).not.toBeInTheDocument();
  });

  it('shows all menu items after right-click', () => {
    const { container } = render(
      <AgentContextMenu {...defaultProps}>
        <div data-testid="trigger">Agent Row</div>
      </AgentContextMenu>
    );

    fireEvent.contextMenu(getTrigger(container));

    expect(screen.getByText('Pin agent')).toBeInTheDocument();
    expect(screen.getByText('Manage agent')).toBeInTheDocument();
    expect(screen.getByText('Edit settings')).toBeInTheDocument();
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('calls onTogglePin when pin item is clicked', () => {
    const onTogglePin = vi.fn();
    const { container } = render(
      <AgentContextMenu {...defaultProps} onTogglePin={onTogglePin}>
        <div data-testid="trigger">Agent Row</div>
      </AgentContextMenu>
    );

    fireEvent.contextMenu(getTrigger(container));
    fireEvent.click(screen.getByText('Pin agent'));

    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('calls onManage when "Manage agent" is clicked', () => {
    const onManage = vi.fn();
    const { container } = render(
      <AgentContextMenu {...defaultProps} onManage={onManage}>
        <div data-testid="trigger">Agent Row</div>
      </AgentContextMenu>
    );

    fireEvent.contextMenu(getTrigger(container));
    fireEvent.click(screen.getByText('Manage agent'));

    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it('calls onEditSettings when "Edit settings" is clicked', () => {
    const onEditSettings = vi.fn();
    const { container } = render(
      <AgentContextMenu {...defaultProps} onEditSettings={onEditSettings}>
        <div data-testid="trigger">Agent Row</div>
      </AgentContextMenu>
    );

    fireEvent.contextMenu(getTrigger(container));
    fireEvent.click(screen.getByText('Edit settings'));

    expect(onEditSettings).toHaveBeenCalledTimes(1);
  });

  it('calls onNewSession when "New session" is clicked', () => {
    const onNewSession = vi.fn();
    const { container } = render(
      <AgentContextMenu {...defaultProps} onNewSession={onNewSession}>
        <div data-testid="trigger">Agent Row</div>
      </AgentContextMenu>
    );

    fireEvent.contextMenu(getTrigger(container));
    fireEvent.click(screen.getByText('New session'));

    expect(onNewSession).toHaveBeenCalledTimes(1);
  });
});
