/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/agent', () => ({
  useAgentVisual: (_agent: unknown, path: string) => ({
    color: '#ff6b6b',
    emoji: path === '/projects/test' ? '🤖' : '⚡',
  }),
}));

vi.mock('@/layers/shared/ui', () => ({
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({
    children,
    onClick,
    className,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    className?: string;
  }) => (
    <button onClick={onClick} className={className}>
      {children}
    </button>
  ),
}));

import { RecentAgentItem } from '../ui/RecentAgentItem';

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'agent-1',
    name: 'Researcher',
    icon: '🤖',
    color: '#ff6b6b',
    projectPath: '/projects/test',
    ...overrides,
  } as AgentManifest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecentAgentItem', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders agent name when agent data exists', () => {
    render(<RecentAgentItem path="/projects/test" agent={makeAgent()} onClick={vi.fn()} />);
    expect(screen.getByText('Researcher')).toBeInTheDocument();
  });

  it('falls back to path basename when agent is null', () => {
    render(<RecentAgentItem path="/projects/my-app" agent={null} onClick={vi.fn()} />);
    expect(screen.getByText('my-app')).toBeInTheDocument();
  });

  it('calls onClick handler when clicked', () => {
    const onClick = vi.fn();
    render(<RecentAgentItem path="/projects/test" agent={makeAgent()} onClick={onClick} />);

    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders color dot', () => {
    const { container } = render(
      <RecentAgentItem path="/projects/test" agent={makeAgent()} onClick={vi.fn()} />
    );
    const dot = container.querySelector('.rounded-full');
    expect(dot).toBeInTheDocument();
  });

  it('has truncate class on display name for long names', () => {
    const { container } = render(
      <RecentAgentItem
        path="/projects/test"
        agent={makeAgent({ name: 'Very Long Agent Name That Should Be Truncated' })}
        onClick={vi.fn()}
      />
    );
    const nameEl = container.querySelector('.truncate');
    expect(nameEl).toBeInTheDocument();
  });
});
