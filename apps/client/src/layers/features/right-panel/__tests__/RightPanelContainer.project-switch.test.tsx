/**
 * @vitest-environment jsdom
 */
/**
 * Switching to another project's chat with the right panel open (DOR-2579).
 *
 * Wires the REAL store, the real per-agent binding hook and the real container
 * together — only the panel library, the sheet and the extension registry are
 * stubbed — because the bug lived in the seam: the bind hydrated a never-seen
 * project as closed, the container collapsed the panel, and the collapse was
 * then written down as that project's layout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RightPanelContribution } from '@/layers/shared/model';

const { panelEvents } = vi.hoisted(() => ({ panelEvents: [] as string[] }));

// A panel stub that behaves like the real one where it matters here: it knows
// whether it is collapsed, and reports a collapse or expand through the same
// callbacks, so a panel shut by a project switch is visible to the test.
vi.mock('react-resizable-panels', async () => {
  const { useImperativeHandle, useRef } = await import('react');

  function MockPanel({
    children,
    id,
    ref,
    defaultSize,
    onCollapse,
    onExpand,
  }: React.PropsWithChildren<Record<string, unknown>>) {
    const collapsed = useRef(defaultSize === 0);
    useImperativeHandle(ref as React.Ref<unknown>, () => ({
      collapse: () => {
        if (collapsed.current) return;
        collapsed.current = true;
        panelEvents.push('collapse');
        (onCollapse as (() => void) | undefined)?.();
      },
      expand: () => {
        if (!collapsed.current) return;
        collapsed.current = false;
        panelEvents.push('expand');
        (onExpand as (() => void) | undefined)?.();
      },
      isCollapsed: () => collapsed.current,
      isExpanded: () => !collapsed.current,
      getSize: () => (collapsed.current ? 0 : 40),
      resize: () => {},
      getId: () => id ?? 'right-panel',
    }));
    return <div data-testid="right-panel">{children}</div>;
  }

  return {
    Panel: MockPanel,
    PanelResizeHandle: () => <div data-testid="resize-handle" />,
  };
});

vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const Passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  const SheetStub = ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div data-testid="sheet">{children}</div> : null;
  return {
    ...actual,
    ResponsiveSheet: SheetStub,
    ResponsiveSheetContent: Passthrough,
    ResponsiveSheetHeader: Passthrough,
    ResponsiveSheetTitle: Passthrough,
    ResponsiveSheetDescription: Passthrough,
    Tooltip: Passthrough,
    TooltipTrigger: Passthrough,
    TooltipContent: () => null,
    TooltipProvider: Passthrough,
  };
});

let mockIsBelowDesktop = false;
let mockContributions: RightPanelContribution[] = [];
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useIsMobile: () => mockIsBelowDesktop,
    useIsBelowDesktop: () => mockIsBelowDesktop,
    useSlotContributions: () => mockContributions,
    useTransport: () => ({ supportsTerminal: true }),
  };
});

vi.mock('../model/use-right-panel-sizing', () => ({
  useRightPanelSizing: () => ({ minPct: 20, defaultPct: 40 }),
}));

// The project you are in: its directory, and the agent registered there.
let mockCwd: string | null = null;
let mockAgentId: string | null = null;
vi.mock('@/layers/entities/session', () => ({
  useDirectoryState: () => [mockCwd, vi.fn()],
}));
vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: mockAgentId ? { id: mockAgentId } : null, isPending: false }),
}));

import { useAppStore } from '@/layers/shared/model';
import { RightPanelContainer } from '../ui/RightPanelContainer';
import { useRightPanelLayoutPersistence } from '../model/use-right-panel-persistence';

function contribution(
  id: string,
  overrides: Partial<RightPanelContribution> = {}
): RightPanelContribution {
  return {
    id,
    title: `Tab ${id}`,
    component: () => <div data-testid={`tab-content-${id}`}>Content {id}</div>,
    ...overrides,
  };
}

/** The session route as the shell mounts it: the binding hook beside the panel. */
function SessionShell() {
  useRightPanelLayoutPersistence();
  return <RightPanelContainer pathname="/session" />;
}

/** Point the app at another project, as opening one of its chats does. */
function enterProject(cwd: string, agentId: string) {
  mockCwd = cwd;
  mockAgentId = agentId;
  useAppStore.setState({ selectedCwd: cwd, currentAgentId: agentId });
}

/** Read the per-agent layout map the store persists. */
function storedLayouts(): Record<string, { open: boolean; activeTab: string | null }> {
  return JSON.parse(localStorage.getItem('dorkos-right-panel-layouts-v2') || '{}');
}

describe('RightPanelContainer — switching to another project’s chat (DOR-2579)', () => {
  beforeEach(() => {
    localStorage.clear();
    panelEvents.length = 0;
    mockIsBelowDesktop = false;
    useAppStore.setState({
      rightPanelOpen: false,
      activeRightPanelTab: null,
      rightPanelLayoutKey: null,
      requestedRightPanel: null,
      explicitAgentPath: null,
    });
    mockContributions = [
      contribution('pulse', { isGlobal: true }),
      contribution('profile'),
      contribution('flow'),
      // A tab only project A has.
      contribution('a-only', { visibleWhen: ({ cwd }) => cwd === '/repo/a' }),
    ];
    enterProject('/repo/a', 'agent-a');
  });

  afterEach(() => cleanup());

  /** Open the panel on a tab in project A, as a click would. */
  async function openInProjectA(tabId: string) {
    const view = render(<SessionShell />);
    // Let the container finish its first paint, so a collapse from here on is
    // reported the way it is in the app.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    act(() => {
      useAppStore.getState().setActiveRightPanelTab(tabId);
      useAppStore.getState().setRightPanelOpen(true);
    });
    expect(screen.getByTestId(`tab-content-${tabId}`)).toBeInTheDocument();
    panelEvents.length = 0;
    return view;
  }

  it('keeps the panel open on the same tab', async () => {
    const { rerender } = await openInProjectA('flow');

    act(() => enterProject('/repo/b', 'agent-b'));
    rerender(<SessionShell />);

    expect(useAppStore.getState().rightPanelLayoutKey).toBe('agent-b');
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(screen.getByTestId('tab-content-flow')).toBeInTheDocument();
    expect(panelEvents).not.toContain('collapse');
  });

  it('does not record the new project as closed', async () => {
    const { rerender } = await openInProjectA('flow');

    act(() => enterProject('/repo/b', 'agent-b'));
    rerender(<SessionShell />);

    expect(storedLayouts()['agent-b']?.open).not.toBe(false);
  });

  it('falls back to another tab when the new project lacks the open one', async () => {
    const { rerender } = await openInProjectA('a-only');

    act(() => enterProject('/repo/b', 'agent-b'));
    rerender(<SessionShell />);

    await waitFor(() => expect(screen.getByTestId('tab-content-profile')).toBeInTheDocument());
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(panelEvents).not.toContain('collapse');

    // Going back finds the tab you left it on.
    act(() => enterProject('/repo/a', 'agent-a'));
    rerender(<SessionShell />);
    await waitFor(() => expect(screen.getByTestId('tab-content-a-only')).toBeInTheDocument());
  });

  it('keeps the sheet open below desktop width', async () => {
    mockIsBelowDesktop = true;
    const { rerender } = await openInProjectA('flow');
    expect(screen.getByTestId('sheet')).toBeInTheDocument();

    act(() => enterProject('/repo/b', 'agent-b'));
    rerender(<SessionShell />);

    expect(screen.getByTestId('sheet')).toBeInTheDocument();
    expect(screen.getByTestId('tab-content-flow')).toBeInTheDocument();
  });
});
