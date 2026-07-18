import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';
import {
  executeUiCommand,
  type DispatcherContext,
  type DispatcherStore,
} from '@/layers/shared/lib';
import { switchAgentCwd, type SwitchAgentCwdStore } from '../lib/switch-agent-cwd';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeStore(overrides: Partial<SwitchAgentCwdStore> = {}): SwitchAgentCwdStore {
  return {
    selectedCwd: null,
    setSelectedCwd: vi.fn(),
    setPreviousCwd: vi.fn(),
    ...overrides,
  };
}

/** Seed the sessions cache for a directory with a minimal Session shape. */
function seedSession(queryClient: QueryClient, dir: string, id: string): void {
  queryClient.setQueryData(['sessions', dir], [{ id }] as Session[]);
}

describe('switchAgentCwd', () => {
  it('persists the target directory as the selected cwd', () => {
    const store = makeStore();
    const navigate = vi.fn();
    switchAgentCwd('/home/user/project', {
      store,
      queryClient: new QueryClient(),
      navigate,
    });
    expect(store.setSelectedCwd).toHaveBeenCalledWith('/home/user/project');
  });

  it('records the current directory as the switch-back target when it differs', () => {
    const store = makeStore({ selectedCwd: '/home/user/old' });
    switchAgentCwd('/home/user/new', {
      store,
      queryClient: new QueryClient(),
      navigate: vi.fn(),
    });
    expect(store.setPreviousCwd).toHaveBeenCalledWith('/home/user/old');
  });

  it('does not record a switch-back target when already in the directory', () => {
    const store = makeStore({ selectedCwd: '/home/user/same' });
    switchAgentCwd('/home/user/same', {
      store,
      queryClient: new QueryClient(),
      navigate: vi.fn(),
    });
    expect(store.setPreviousCwd).not.toHaveBeenCalled();
  });

  it('does not record a switch-back target when no directory is active', () => {
    const store = makeStore({ selectedCwd: null });
    switchAgentCwd('/home/user/project', {
      store,
      queryClient: new QueryClient(),
      navigate: vi.fn(),
    });
    expect(store.setPreviousCwd).not.toHaveBeenCalled();
  });

  it('navigates reusing the most-recent cached session for the directory', () => {
    const queryClient = new QueryClient();
    seedSession(queryClient, '/home/user/project', 'sess-cached');
    const navigate = vi.fn();
    switchAgentCwd('/home/user/project', { store: makeStore(), queryClient, navigate });
    expect(navigate).toHaveBeenCalledWith({ dir: '/home/user/project', session: 'sess-cached' });
  });

  it('navigates with a fresh session id when none is cached', () => {
    const navigate = vi.fn();
    switchAgentCwd('/home/user/project', {
      store: makeStore(),
      queryClient: new QueryClient(),
      navigate,
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const arg = navigate.mock.calls[0][0] as { dir: string; session: string };
    expect(arg.dir).toBe('/home/user/project');
    expect(arg.session).toMatch(UUID_RE);
  });
});

describe('executeUiCommand switch_agent → switchAgentCwd (wired path)', () => {
  it('dispatching switch_agent switches the cwd and navigates', () => {
    // Compose the dispatcher with the exact wiring main.tsx installs: the
    // context's switchAgent delegates to switchAgentCwd. This proves the
    // control_ui switch_agent command now produces a real cwd switch rather
    // than the pre-DOR-354 no-op.
    const store = makeStore({ selectedCwd: '/home/user/old' });
    const queryClient = new QueryClient();
    seedSession(queryClient, '/home/user/new', 'sess-new');
    const navigate = vi.fn();

    const ctx: DispatcherContext = {
      // switch_agent never reads the dispatcher store; a bare stub is honest here.
      store: {} as DispatcherStore,
      setTheme: vi.fn(),
      switchAgent: (cwd) => switchAgentCwd(cwd, { store, queryClient, navigate }),
    };

    executeUiCommand(ctx, { action: 'switch_agent', cwd: '/home/user/new' }, 'agent');

    expect(store.setPreviousCwd).toHaveBeenCalledWith('/home/user/old');
    expect(store.setSelectedCwd).toHaveBeenCalledWith('/home/user/new');
    expect(navigate).toHaveBeenCalledWith({ dir: '/home/user/new', session: 'sess-new' });
  });
});
