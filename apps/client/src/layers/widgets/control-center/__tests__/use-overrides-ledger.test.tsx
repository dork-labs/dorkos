// @vitest-environment jsdom
/**
 * The overrides ledger's composition — the honesty section of the Control Center
 * (spec `full-power-defaults`, D7). Isolated from the transport: the entity and
 * navigation hooks are mocked so the test drives exactly the divergence logic
 * and the deep-link wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';

const useConfig = vi.fn();
const useRuntimeCapabilities = vi.fn();
const getRuntimeDescriptor = vi.fn((runtime: string) => ({ label: `Runtime:${runtime}` }));
const useSessions = vi.fn();
const useTasks = vi.fn();
const useTasksEnabled = vi.fn(() => true);
const useBindings = vi.fn();
const navigate = vi.fn();
const openSettings = vi.fn();
const openConnections = vi.fn();
const setControlCenterOpen = vi.fn();

vi.mock('@/layers/entities/config', () => ({ useConfig: () => useConfig() }));
vi.mock('@/layers/entities/runtime', () => ({
  useRuntimeCapabilities: () => useRuntimeCapabilities(),
  getRuntimeDescriptor: (runtime: string) => getRuntimeDescriptor(runtime),
}));
vi.mock('@/layers/entities/session', () => ({ useSessions: () => useSessions() }));
vi.mock('@/layers/entities/tasks', () => ({
  useTasks: () => useTasks(),
  useTasksEnabled: () => useTasksEnabled(),
}));
vi.mock('@/layers/entities/binding', () => ({ useBindings: () => useBindings() }));
vi.mock('@/layers/shared/model', () => ({
  useSafeNavigate: () => navigate,
  useOpenConnections: () => openConnections,
  useSettingsDeepLink: () => ({ open: openSettings }),
  useAppStore: (selector: (s: { setControlCenterOpen: typeof setControlCenterOpen }) => unknown) =>
    selector({ setControlCenterOpen }),
}));

import { useOverridesLedger } from '../model/use-overrides-ledger';

const DESCRIPTORS: PermissionModeDescriptor[] = [
  { id: 'default', label: 'Ask', stop: 'ask', asks: 'always', reach: 'edit', promise: 'Asks.' },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Acts.',
  },
  {
    id: 'bypassPermissions',
    label: 'Full autonomy',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything.',
  },
];

/** Global stop resolves to 'ask' (default runtime's default mode is `default`). */
function seedCaps() {
  useRuntimeCapabilities.mockReturnValue({
    data: {
      defaultRuntime: 'claude-code',
      capabilities: {
        'claude-code': {
          permissionModes: { supported: true, default: 'default', values: DESCRIPTORS },
        },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useTasksEnabled.mockReturnValue(true);
  // Empty everything by default; each test seeds what it needs.
  useConfig.mockReturnValue({
    data: { executionDefaults: { runtime: 'claude-code', trustStop: 'ask', perRuntime: [] } },
  });
  useSessions.mockReturnValue({ sessions: [] });
  useTasks.mockReturnValue({ data: [] });
  useBindings.mockReturnValue({ data: [] });
  seedCaps();
});

describe('useOverridesLedger', () => {
  it('reports isResolving until config and capabilities have loaded', () => {
    useRuntimeCapabilities.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useOverridesLedger());
    expect(result.current.isResolving).toBe(true);
    expect(result.current.isEmpty).toBe(false);
    expect(result.current.rows).toHaveLength(0);
  });

  it('shows the calm empty state when nothing diverges from the dial', () => {
    const { result } = renderHook(() => useOverridesLedger());
    expect(result.current.isResolving).toBe(false);
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.rows).toHaveLength(0);
  });

  it('builds one row each for a runtime override, a divergent session, a task and a binding', () => {
    useConfig.mockReturnValue({
      data: {
        executionDefaults: {
          runtime: 'claude-code',
          trustStop: 'ask',
          perRuntime: [{ runtime: 'codex', trustStop: 'autonomy' }],
        },
      },
    });
    useSessions.mockReturnValue({
      sessions: [
        {
          id: 's1',
          title: 'My session',
          runtime: 'claude-code',
          permissionMode: 'bypassPermissions',
          cwd: '/repo',
        },
      ],
    });
    useTasks.mockReturnValue({
      data: [{ id: 't1', name: 'Nightly', permissionMode: 'bypassPermissions' }],
    });
    useBindings.mockReturnValue({
      data: [
        { id: 'b1', label: 'Deploys', adapterId: 'slack', permissionMode: 'bypassPermissions' },
      ],
    });

    const { result } = renderHook(() => useOverridesLedger());
    const kinds = result.current.rows.map((r) => r.kind);
    expect(kinds).toEqual(['runtime', 'session', 'task', 'binding']);
    expect(result.current.isEmpty).toBe(false);

    // Each row deep-links to its owning surface.
    result.current.rows.find((r) => r.kind === 'runtime')?.onOpen?.();
    expect(openSettings).toHaveBeenCalledWith('runtimes');
    result.current.rows.find((r) => r.kind === 'session')?.onOpen?.();
    expect(navigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 's1', dir: '/repo' },
    });
    result.current.rows.find((r) => r.kind === 'task')?.onOpen?.();
    expect(navigate).toHaveBeenCalledWith({ to: '/tasks' });
    result.current.rows.find((r) => r.kind === 'binding')?.onOpen?.();
    expect(openConnections).toHaveBeenCalledWith('messaging');

    // Every deep link closes the modal flyout BEFORE it navigates — a link that
    // left it open lands the person on a page still locked behind
    // `body { pointer-events: none }` (or stacks a second modal over it).
    expect(setControlCenterOpen).toHaveBeenCalledTimes(4);
    expect(setControlCenterOpen).toHaveBeenCalledWith(false);
  });

  it('does NOT list a runtime, session, task or binding that sits at the global stop', () => {
    // A per-runtime override EQUAL to the global stop is not an exception. Global
    // is `ask` (the seeded default), so a runtime override at `ask` must produce
    // no row — the same rule the session/task/binding branches apply.
    useConfig.mockReturnValue({
      data: {
        executionDefaults: {
          runtime: 'claude-code',
          trustStop: 'ask',
          perRuntime: [{ runtime: 'codex', trustStop: 'ask' }],
        },
      },
    });
    useSessions.mockReturnValue({
      sessions: [{ id: 's1', title: 'Quiet', runtime: 'claude-code', permissionMode: 'default' }],
    });
    useTasks.mockReturnValue({
      data: [{ id: 't1', name: 'Quiet task', permissionMode: 'default' }],
    });
    useBindings.mockReturnValue({
      data: [{ id: 'b1', label: 'Quiet bind', adapterId: 'x', permissionMode: 'default' }],
    });

    const { result } = renderHook(() => useOverridesLedger());
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.isEmpty).toBe(true);
  });
});
