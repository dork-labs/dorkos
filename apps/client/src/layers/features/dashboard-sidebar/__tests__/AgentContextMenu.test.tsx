import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentContextMenu } from '../ui/AgentContextMenu';

// The wrapper renders the shared AgentRowMenuItems; mock it so this test stays
// focused on the ContextMenu wiring (item behavior is covered by its own test).
vi.mock('../ui/AgentRowMenuItems', () => ({
  AgentRowMenuItems: ({ variant, path }: { variant: string; path: string }) => (
    <div data-testid="row-menu-items">
      {variant}:{path}
    </div>
  ),
}));

// ContextMenu relies on pointer events and ResizeObserver — mock both for jsdom.
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
});

const defaultProps = {
  path: '/agents/api-server',
  onOpenProfile: vi.fn(),
  onNewSession: vi.fn(),
  onRequestNewGroup: vi.fn(),
};

/** Return the trigger element rendered directly inside our render root. */
function getTrigger(container: HTMLElement) {
  return container.querySelector('[data-testid="trigger"]') as HTMLElement;
}

describe('AgentContextMenu', () => {
  it('renders children without opening the menu by default', () => {
    const { container } = render(
      <AgentContextMenu {...defaultProps}>
        <div data-testid="child">Agent Row</div>
      </AgentContextMenu>
    );

    expect(container.querySelector('[data-testid="child"]')).toBeInTheDocument();
    expect(screen.queryByTestId('row-menu-items')).not.toBeInTheDocument();
  });

  it('opens on right-click and renders the shared items in the context variant', () => {
    const { container } = render(
      <AgentContextMenu {...defaultProps}>
        <div data-testid="trigger">Agent Row</div>
      </AgentContextMenu>
    );

    fireEvent.contextMenu(getTrigger(container));

    const items = screen.getByTestId('row-menu-items');
    expect(items).toBeInTheDocument();
    // Forwards the context variant and the agent path to the shared items.
    expect(items).toHaveTextContent('context:/agents/api-server');
  });
});
