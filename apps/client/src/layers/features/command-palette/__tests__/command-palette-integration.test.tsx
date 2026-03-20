/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CommandPaletteDialog } from '../ui/CommandPaletteDialog';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

// jsdom does not implement ResizeObserver (required by cmdk CommandList)
globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// jsdom does not implement scrollIntoView (used by cmdk when filtering items)
Element.prototype.scrollIntoView = vi.fn();

// --- matchMedia mock (required for ResponsiveDialog / Radix viewport checks) ---
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

afterEach(cleanup);

// --- Shared mock fns ---

const mockSetGlobalPaletteOpen = vi.fn();
const mockSetSettingsOpen = vi.fn();
const mockSetPulseOpen = vi.fn();
const mockSetRelayOpen = vi.fn();
const mockSetMeshOpen = vi.fn();
const mockSetPickerOpen = vi.fn();
const mockSetTheme = vi.fn();

let mockGlobalPaletteOpen = true;
let mockTheme = 'light';

const mockSetPreviousCwd = vi.fn();

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      globalPaletteOpen: mockGlobalPaletteOpen,
      setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
      toggleGlobalPalette: vi.fn(),
      setSettingsOpen: mockSetSettingsOpen,
      setPulseOpen: mockSetPulseOpen,
      setRelayOpen: mockSetRelayOpen,
      setMeshOpen: mockSetMeshOpen,
      setPickerOpen: mockSetPickerOpen,
      setPreviousCwd: mockSetPreviousCwd,
      globalPaletteInitialSearch: null,
      clearGlobalPaletteInitialSearch: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
  useIsMobile: () => false,
}));

const mockSetDir = vi.fn();
let mockSelectedCwd: string | null = '/projects/current';

vi.mock('@/layers/entities/session', () => ({
  useDirectoryState: () => [mockSelectedCwd, mockSetDir],
}));

// --- Use REAL useAgentFrecency (tests localStorage integration) ---
// No mock for '../model/use-agent-frecency' — the real hook is used.

// --- Mock usePaletteItems with configurable agents ---

const mockAgents: AgentPathEntry[] = [
  { id: 'agent-1', name: 'Auth Service', projectPath: '/projects/auth' },
  { id: 'agent-2', name: 'API Gateway', projectPath: '/projects/gateway' },
  { id: 'agent-3', name: 'Frontend App', projectPath: '/projects/current' },
];

let mockPaletteRecentAgents: AgentPathEntry[] = [mockAgents[2], mockAgents[0]];
let mockPaletteAllAgents: AgentPathEntry[] = mockAgents;

vi.mock('../model/use-palette-items', () => ({
  usePaletteItems: () => {
    const features = [
      { id: 'pulse', label: 'Pulse Scheduler', icon: 'Clock', action: 'openPulse' },
      { id: 'relay', label: 'Relay Messaging', icon: 'Radio', action: 'openRelay' },
      { id: 'mesh', label: 'Mesh Network', icon: 'Globe', action: 'openMesh' },
      { id: 'settings', label: 'Settings', icon: 'Settings', action: 'openSettings' },
    ];
    const commands = [{ name: '/deploy', description: 'Deploy service' }];
    const quickActions = [
      { id: 'new-session', label: 'New Session', icon: 'Plus', action: 'newSession' },
      { id: 'discover', label: 'Discover Agents', icon: 'Search', action: 'discoverAgents' },
      { id: 'browse', label: 'Browse Filesystem', icon: 'FolderOpen', action: 'browseFilesystem' },
      { id: 'theme', label: 'Toggle Theme', icon: 'Moon', action: 'toggleTheme' },
    ];
    return {
      recentAgents: mockPaletteRecentAgents,
      allAgents: mockPaletteAllAgents,
      features,
      commands,
      quickActions,
      searchableItems: [
        ...mockPaletteAllAgents.map((a: AgentPathEntry) => ({
          id: a.id,
          name: a.name,
          type: 'agent',
          keywords: [a.projectPath],
          data: a,
        })),
        ...features.map((f) => ({ id: f.id, name: f.label, type: 'feature', data: f })),
        ...commands.map((c) => ({ id: `cmd-${c.name}`, name: c.name, type: 'command', data: c })),
        ...quickActions.map((q) => ({ id: q.id, name: q.label, type: 'quick-action', data: q })),
      ],
      suggestions: [],
      isLoading: false,
    };
  },
}));

// Mock usePaletteSearch: passthrough all items so existing rendering assertions hold.
// Prefix filtering (@ / >) is preserved so mode-switching tests work correctly.
vi.mock('../model/use-palette-search', () => ({
  usePaletteSearch: (items: Array<{ id: string; type: string; name: string }>, search: string) => {
    const prefix = search.startsWith('@') ? '@' : search.startsWith('>') ? '>' : null;
    const term = prefix ? search.slice(1) : search;
    const filtered =
      prefix === '@'
        ? items.filter((i) => i.type === 'agent')
        : prefix === '>'
          ? items.filter((i) => i.type === 'command')
          : items;
    return { results: filtered.map((item) => ({ item, matches: undefined })), prefix, term };
  },
  parsePrefix: (search: string) => {
    if (search.startsWith('@')) return { prefix: '@', term: search.slice(1) };
    if (search.startsWith('>')) return { prefix: '>', term: search.slice(1) };
    return { prefix: null, term: search };
  },
}));

vi.mock('../model/use-global-palette', () => ({
  useGlobalPalette: () => ({
    globalPaletteOpen: mockGlobalPaletteOpen,
    setGlobalPaletteOpen: mockSetGlobalPaletteOpen,
    toggleGlobalPalette: vi.fn(),
  }),
}));

// Mock usePreviewData so AgentPreviewPanel doesn't call real entity hooks
vi.mock('../model/use-preview-data', () => ({
  usePreviewData: () => ({
    sessionCount: 0,
    recentSessions: [],
    health: null,
  }),
}));

// Mock motion/react to render plain elements (avoids animation-related test issues)
vi.mock('motion/react', () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) =>
      React.createElement('div', props, children),
    span: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & { children?: React.ReactNode }) =>
      React.createElement('span', props, children),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
  LayoutGroup: ({ children }: { children?: React.ReactNode }) => children,
}));

describe('Command Palette Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockGlobalPaletteOpen = true;
    mockSelectedCwd = '/projects/current';
    mockTheme = 'light';
    mockPaletteRecentAgents = [mockAgents[2], mockAgents[0]];
    mockPaletteAllAgents = mockAgents;
  });

  // --- Full agent switching flow (two-step: click agent → sub-menu → Open Here) ---

  it('clicking an agent navigates to sub-menu; Open Here switches, records frecency, and closes', () => {
    render(<CommandPaletteDialog />);

    // Click on "Auth Service" agent to open sub-menu
    const item = screen.getByText('Auth Service').closest('[data-slot="command-item"]');
    expect(item).toBeTruthy();
    fireEvent.click(item as Element);

    // Sub-menu should appear
    expect(screen.getByText('Open Here')).toBeInTheDocument();

    // Click Open Here to complete the switch
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    fireEvent.click(openHereItem as Element);

    // Should set directory to the agent's project path
    expect(mockSetDir).toHaveBeenCalledWith('/projects/auth');

    // Should close the palette
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);

    // Should record frecency in localStorage (real hook)
    const stored = localStorage.getItem('dorkos:agent-frecency-v2');
    expect(stored).toBeTruthy();
    const entries = JSON.parse(stored!);
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'agent-1', totalCount: 1 })])
    );
  });

  it('records frecency correctly for the active agent via Open Here', () => {
    render(<CommandPaletteDialog />);

    // Click the active agent (Frontend App, which matches selectedCwd) to open sub-menu
    const item = screen.getAllByText('Frontend App')[0].closest('[data-slot="command-item"]');
    expect(item).toBeTruthy();
    fireEvent.click(item as Element);

    // Click Open Here
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    fireEvent.click(openHereItem as Element);

    expect(mockSetDir).toHaveBeenCalledWith('/projects/current');

    // Frecency recorded for agent-3
    const stored = localStorage.getItem('dorkos:agent-frecency-v2');
    const entries = JSON.parse(stored!);
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'agent-3', totalCount: 1 })])
    );
  });

  it('increments frecency count on repeated agent selection via Open Here', () => {
    const { unmount } = render(<CommandPaletteDialog />);

    // Select Auth Service via sub-menu twice
    const item1 = screen.getByText('Auth Service').closest('[data-slot="command-item"]');
    fireEvent.click(item1 as Element);
    fireEvent.click(screen.getByText('Open Here').closest('[data-slot="command-item"]') as Element);
    unmount();

    // Re-render and select again
    mockGlobalPaletteOpen = true;
    const { unmount: unmount2 } = render(<CommandPaletteDialog />);
    const item2 = screen.getByText('Auth Service').closest('[data-slot="command-item"]');
    fireEvent.click(item2 as Element);
    fireEvent.click(screen.getByText('Open Here').closest('[data-slot="command-item"]') as Element);
    unmount2();

    const stored = localStorage.getItem('dorkos:agent-frecency-v2');
    const entries = JSON.parse(stored!);
    const authEntry = entries.find((e: { agentId: string }) => e.agentId === 'agent-1');
    expect(authEntry.totalCount).toBe(2);
  });

  // --- @ prefix mode ---

  it('entering @ shows All Agents and hides other groups', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search agents, features, commands...');
    fireEvent.change(input, { target: { value: '@' } });

    // All Agents visible
    expect(screen.getByText('All Agents')).toBeInTheDocument();

    // Other groups hidden
    expect(screen.queryByText('Recent Agents')).not.toBeInTheDocument();
    expect(screen.queryByText('Features')).not.toBeInTheDocument();
    expect(screen.queryByText('Quick Actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  it('@ followed by agent name still shows All Agents group', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search agents, features, commands...');
    fireEvent.change(input, { target: { value: '@auth' } });

    expect(screen.getByText('All Agents')).toBeInTheDocument();
    expect(screen.queryByText('Features')).not.toBeInTheDocument();
  });

  it('selecting an agent from search mode opens sub-menu; Open Here records frecency and sets dir', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search agents, features, commands...');

    // Type a search query that matches an agent via cmdk's fuzzy filter
    fireEvent.change(input, { target: { value: 'API Gateway' } });

    // All Agents group should appear when searching
    expect(screen.getByText('All Agents')).toBeInTheDocument();

    // Click the agent to open sub-menu
    const item = screen.getByText('API Gateway').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    // Sub-menu should appear; click Open Here to complete the switch
    const openHereItem = screen.getByText('Open Here').closest('[data-slot="command-item"]');
    fireEvent.click(openHereItem as Element);

    expect(mockSetDir).toHaveBeenCalledWith('/projects/gateway');
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);

    const stored = localStorage.getItem('dorkos:agent-frecency-v2');
    const entries = JSON.parse(stored!);
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: 'agent-2' })])
    );
  });

  // --- Feature opening ---

  it('selecting Pulse Scheduler opens pulse dialog and closes palette', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getByText('Pulse Scheduler').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetPulseOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Relay Messaging opens relay dialog and closes palette', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getByText('Relay Messaging').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetRelayOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Mesh Network opens mesh panel and closes palette', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getByText('Mesh Network').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetMeshOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  it('selecting Settings opens settings dialog and closes palette', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getByText('Settings').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetSettingsOpen).toHaveBeenCalledWith(true);
    expect(mockSetGlobalPaletteOpen).toHaveBeenCalledWith(false);
  });

  // --- Quick actions ---

  it('Discover Agents opens mesh panel', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getByText('Discover Agents').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetMeshOpen).toHaveBeenCalledWith(true);
  });

  it('Browse Filesystem opens directory picker', () => {
    render(<CommandPaletteDialog />);
    const item = screen.getByText('Browse Filesystem').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetPickerOpen).toHaveBeenCalledWith(true);
  });

  it('Toggle Theme calls setTheme with opposite theme', () => {
    mockTheme = 'dark';
    render(<CommandPaletteDialog />);
    const item = screen.getByText('Toggle Theme').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);

    expect(mockSetTheme).toHaveBeenCalledWith('light');
  });

  // --- Search behavior ---

  it('typing a search query reveals Commands and All Agents groups', () => {
    render(<CommandPaletteDialog />);
    const input = screen.getByPlaceholderText('Search agents, features, commands...');
    fireEvent.change(input, { target: { value: 'deploy' } });

    expect(screen.getByText('Commands')).toBeInTheDocument();
    expect(screen.getByText('/deploy')).toBeInTheDocument();
    expect(screen.getByText('All Agents')).toBeInTheDocument();
  });

  it('Commands group is hidden when search is empty', () => {
    render(<CommandPaletteDialog />);
    expect(screen.queryByText('Commands')).not.toBeInTheDocument();
  });

  // --- Mesh always-on (no feature flag checks) ---

  it('renders agent data without any feature flag gating', () => {
    render(<CommandPaletteDialog />);

    // Agents from mesh appear directly without any "mesh disabled" message
    // getAllByText used because the selected agent name also appears in the preview panel
    expect(screen.getAllByText('Frontend App').length).toBeGreaterThan(0);
    expect(screen.getByText('Auth Service')).toBeInTheDocument();

    // Mesh is a feature option in the palette
    expect(screen.getByText('Mesh Network')).toBeInTheDocument();

    // No disabled-state messages
    expect(screen.queryByText(/mesh.*disabled/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/enable.*mesh/i)).not.toBeInTheDocument();
  });

  // --- Empty state ---

  it('renders correctly when no agents are registered', () => {
    mockPaletteRecentAgents = [];
    mockPaletteAllAgents = [];

    render(<CommandPaletteDialog />);

    // Recent Agents group should not appear (empty)
    expect(screen.queryByText('Recent Agents')).not.toBeInTheDocument();

    // Features and Quick Actions should still render
    expect(screen.getByText('Features')).toBeInTheDocument();
    expect(screen.getByText('Quick Actions')).toBeInTheDocument();
  });

  // --- Dialog closed state ---

  it('does not render any content when palette is closed', () => {
    mockGlobalPaletteOpen = false;
    render(<CommandPaletteDialog />);

    expect(
      screen.queryByPlaceholderText('Search agents, features, commands...')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Recent Agents')).not.toBeInTheDocument();
    expect(screen.queryByText('Features')).not.toBeInTheDocument();
  });

  // --- Frecency persists across re-renders ---

  it('frecency data persists in localStorage across palette close and reopen', () => {
    // First render: select an agent via sub-menu Open Here
    const { unmount } = render(<CommandPaletteDialog />);
    const item = screen.getByText('Auth Service').closest('[data-slot="command-item"]');
    fireEvent.click(item as Element);
    fireEvent.click(screen.getByText('Open Here').closest('[data-slot="command-item"]') as Element);
    unmount();

    // Verify localStorage has data
    const storedBefore = localStorage.getItem('dorkos:agent-frecency-v2');
    expect(storedBefore).toBeTruthy();

    // Second render: data should still be in localStorage
    mockGlobalPaletteOpen = true;
    render(<CommandPaletteDialog />);

    const storedAfter = localStorage.getItem('dorkos:agent-frecency-v2');
    expect(storedAfter).toBe(storedBefore);
  });
});
