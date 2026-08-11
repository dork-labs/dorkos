// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentListItem } from '../ui/AgentListItem';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: () => false };
});

vi.mock('@/layers/entities/agent', () => ({
  AgentIdentity: ({ name, emoji }: { name: string; emoji: string }) => (
    <span data-testid="agent-identity">
      <span>{emoji}</span>
      <span>{name}</span>
    </span>
  ),
}));

interface MockAgentStatus {
  kind: 'idle' | 'streaming' | 'pendingApproval' | 'error' | 'unseen';
  color: string;
  pulse: boolean;
  label: string;
}

const mockAgentStatus = vi.fn<() => MockAgentStatus>(() => ({
  kind: 'idle',
  color: 'rgba(128,128,128,0.08)',
  pulse: false,
  label: 'Idle',
}));

vi.mock('@/layers/entities/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/session')>();
  return {
    ...actual,
    useAgentHottestStatus: () => mockAgentStatus(),
    usePulseMotion: () => ({ animate: undefined, transition: undefined }),
  };
});

const mockLiveCount = vi.fn<() => number>(() => 0);

vi.mock('../model/use-live-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model/use-live-sessions')>();
  return { ...actual, useLiveSessionCount: () => mockLiveCount() };
});

// The switcher is `SessionSwitcher.test.tsx`'s subject. Here it is a marker, so
// these cases assert that the chip OPENS it without standing up a transport, a
// query client and a Radix portal to do it. `LiveSessionsChip` stays real: the
// row draws it twice and the two copies must be the same width.
vi.mock('../ui/SessionSwitcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/SessionSwitcher')>();
  return {
    ...actual,
    SessionSwitcher: ({ open, agentPath }: { open: boolean; agentPath: string }) =>
      open ? <div data-testid="session-switcher">{agentPath}</div> : null,
  };
});

vi.mock('../ui/AgentRowMenuItems', () => ({
  // The row's menu reads `ui.sidebar` through the config entity, which needs a
  // transport this file deliberately does not stand up. The menu's own contents
  // are `AgentRowMenuItems.test.tsx`'s subject; here it is just "there is a
  // menu", so an empty list keeps the row's chrome honest (no ⋮ with nothing
  // behind it) without dragging a query client into every case.
  useAgentRowMenuNodes: () => [],
}));

vi.mock('../ui/AgentActivityBadge', () => ({
  // Mirrors the real component's contract: idle renders nothing, so tests
  // can assert badge suppression the same way the real DOT_COLOR map does.
  AgentActivityBadge: ({ status, label }: { status: string; label: string }) =>
    status === 'idle' ? null : <span data-testid="activity-badge">{label}</span>,
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProps(overrides: Partial<Parameters<typeof AgentListItem>[0]> = {}) {
  return {
    path: '/agents/test-agent',
    agent: null,
    visual: { color: '#aaaaaa', emoji: '🤖' },
    isActive: false,
    onSelect: vi.fn(),
    onOpenProfile: vi.fn(),
    onRequestNewGroup: vi.fn(),
    onSessionClick: vi.fn(),
    onNewSession: vi.fn(),
    ...overrides,
  };
}

function renderItem(overrides: Partial<Parameters<typeof AgentListItem>[0]> = {}) {
  const props = buildProps(overrides);
  const result = render(
    <TooltipProvider>
      <SidebarProvider>
        <AgentListItem {...props} />
      </SidebarProvider>
    </TooltipProvider>
  );
  return { ...result, props };
}

function row() {
  return screen.getByTestId('agent-identity').closest('[data-slot="agent-list-item"]')!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentListItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentStatus.mockReturnValue({
      kind: 'idle',
      color: 'rgba(128,128,128,0.08)',
      pulse: false,
      label: 'Idle',
    });
    mockLiveCount.mockReturnValue(0);
  });

  // --- Rendering ---

  it('renders the agent display name from path fallback', () => {
    renderItem();
    expect(screen.getByText('test-agent')).toBeInTheDocument();
  });

  it('uses displayName prop when provided', () => {
    renderItem({ displayName: 'Custom Name' });
    expect(screen.getByText('Custom Name')).toBeInTheDocument();
  });

  it('renders the activity badge for a non-idle status', () => {
    mockAgentStatus.mockReturnValue({
      kind: 'streaming',
      color: 'rgb(34,197,94)',
      pulse: true,
      label: 'Working',
    });
    renderItem();
    expect(screen.getByTestId('activity-badge')).toHaveTextContent('Working');
  });

  it('renders no activity badge for an idle status', () => {
    renderItem();
    expect(screen.queryByTestId('activity-badge')).not.toBeInTheDocument();
  });

  // --- Row click behavior (BC-34) ---

  it('opens the conversation on click, whether or not the agent is already active', () => {
    const { props } = renderItem({ isActive: false });
    fireEvent.click(row());
    expect(props.onSelect).toHaveBeenCalledTimes(1);

    cleanup();
    const active = renderItem({ isActive: true });
    fireEvent.click(row());
    // An agent is a teammate, not a folder: the row has no expanded state to
    // toggle into, so the second press does the same thing as the first.
    expect(active.props.onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders no expansion panel — there is nothing to unfold', () => {
    const { container } = renderItem({ isActive: true });
    const listItem = container.querySelector('[data-slot="agent-list-item"]')!.closest('li')!;
    // The row's own wrapper is the only child. A panel would be a second one.
    expect(listItem.children).toHaveLength(1);
  });

  // --- The "N live" chip (BC-35) ---

  it('shows no chip while fewer than two sessions are live', () => {
    mockLiveCount.mockReturnValue(1);
    renderItem();
    expect(screen.queryByRole('button', { name: /session switcher/i })).not.toBeInTheDocument();
  });

  it('shows the chip with its count once two sessions run concurrently', () => {
    mockLiveCount.mockReturnValue(2);
    renderItem();
    const chip = screen.getByRole('button', { name: /session switcher/i });
    expect(chip).toHaveAccessibleName(expect.stringContaining('2 live sessions'));
    expect(chip).toHaveTextContent('2 live');
  });

  it('the chip replaces the activity dot rather than doubling it', () => {
    mockAgentStatus.mockReturnValue({
      kind: 'streaming',
      color: 'rgb(34,197,94)',
      pulse: true,
      label: 'Working',
    });
    mockLiveCount.mockReturnValue(3);
    renderItem();
    expect(screen.getByRole('button', { name: /session switcher/i })).toBeInTheDocument();
    expect(screen.queryByTestId('activity-badge')).not.toBeInTheDocument();
  });

  it('opens the switcher from the chip, and only from the chip', () => {
    mockLiveCount.mockReturnValue(2);
    const { props } = renderItem();
    expect(screen.queryByTestId('session-switcher')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /session switcher/i }));
    expect(screen.getByTestId('session-switcher')).toHaveTextContent('/agents/test-agent');
    // The chip is a satellite, not a nested button: pressing it must not also
    // fire the row underneath.
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('withholds the chip from a muted agent even while its work is live', () => {
    mockLiveCount.mockReturnValue(4);
    renderItem({ isMuted: true });
    expect(screen.queryByRole('button', { name: /session switcher/i })).not.toBeInTheDocument();
  });

  // --- Accessibility ---

  it('does not nest interactive role="button" elements', () => {
    mockLiveCount.mockReturnValue(2);
    const { container } = renderItem({ isActive: true });
    const rowButton = container.querySelector('[data-slot="agent-list-item"]')!;
    expect(rowButton).not.toHaveAttribute('role', 'button');
    expect(rowButton.querySelector('button')).toBeNull();
  });

  // --- Mute (DOR-339) ---

  describe('muted rendering', () => {
    it('is not dimmed and shows no mute glyph by default', () => {
      const { container } = renderItem();
      // The dimming rides the row's outer wrapper — the same element the drag
      // layer binds to — so the row and its menu chrome dim together.
      const dimmed = container
        .querySelector('[data-slot="agent-list-item"]')!
        .closest('li')!.firstElementChild!;
      expect(dimmed.className).not.toContain('opacity-60');
      expect(screen.queryByLabelText('Muted')).not.toBeInTheDocument();
    });

    it('dims the row and shows a mute glyph when muted', () => {
      const { container } = renderItem({ isMuted: true });
      const dimmed = container
        .querySelector('[data-slot="agent-list-item"]')!
        .closest('li')!.firstElementChild!;
      expect(dimmed.className).toContain('opacity-60');
      expect(screen.getByLabelText('Muted')).toBeInTheDocument();
    });

    it('drops the activity badge for a muted agent even while it is working', () => {
      mockAgentStatus.mockReturnValue({
        kind: 'streaming',
        color: 'rgb(34,197,94)',
        pulse: true,
        label: 'Working',
      });
      renderItem({ isMuted: true });
      expect(screen.queryByTestId('activity-badge')).not.toBeInTheDocument();
    });

    it('the row stays clickable while muted', () => {
      const { props } = renderItem({ isMuted: true, isActive: false });
      fireEvent.click(row());
      expect(props.onSelect).toHaveBeenCalledTimes(1);
    });
  });
});
