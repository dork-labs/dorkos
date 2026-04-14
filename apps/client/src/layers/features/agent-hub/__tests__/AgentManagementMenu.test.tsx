/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockUnregisterMutate = vi.fn();
const mockRegisterMutate = vi.fn();
const mockDenyMutate = vi.fn();
const mockClearDenialMutate = vi.fn();
let mockDeniedData: { denied: { path: string }[] } = { denied: [] };

vi.mock('@/layers/entities/mesh', () => ({
  useUnregisterAgent: () => ({ mutate: mockUnregisterMutate }),
  useRegisterAgent: () => ({ mutate: mockRegisterMutate }),
  useDenyAgent: () => ({ mutate: mockDenyMutate }),
  useClearDenial: () => ({ mutate: mockClearDenialMutate }),
  useDeniedAgents: () => ({ data: mockDeniedData }),
}));

const mockAgent = {
  id: 'agent-1',
  name: 'Test Agent',
  displayName: 'Test Agent',
  runtime: 'claude-code',
  isSystem: false,
};

vi.mock('../model/agent-hub-context', () => ({
  useAgentHubContext: () => ({
    agent: mockAgent,
    projectPath: '/home/user/project',
  }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

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
// Import component and mocked modules after mocks
// ---------------------------------------------------------------------------

import { AgentManagementMenu } from '../ui/AgentManagementMenu';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/** Open the Radix dropdown menu with the full pointer sequence required by jsdom. */
async function openMenu() {
  const trigger = screen.getByRole('button', { name: /agent management actions/i });
  await act(async () => {
    fireEvent.pointerDown(trigger);
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  // Reset shared mock state
  mockAgent.isSystem = false;
  mockAgent.displayName = 'Test Agent';
  mockDeniedData = { denied: [] };
});

describe('AgentManagementMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders kebab trigger button', () => {
    render(<AgentManagementMenu onDeleteRequest={vi.fn()} />, { wrapper: createWrapper() });
    expect(screen.getByRole('button', { name: /agent management actions/i })).toBeInTheDocument();
  });

  it('renders Block, Unregister, and Delete items for regular agents', async () => {
    render(<AgentManagementMenu onDeleteRequest={vi.fn()} />, { wrapper: createWrapper() });
    await openMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /block/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('menuitem', { name: /unregister/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete agent/i })).toBeInTheDocument();
  });

  it('hides destructive items for system agents', async () => {
    mockAgent.isSystem = true as unknown as boolean;

    render(<AgentManagementMenu onDeleteRequest={vi.fn()} />, { wrapper: createWrapper() });
    await openMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /system agent/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('menuitem', { name: /block/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /unregister/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /delete agent/i })).not.toBeInTheDocument();
  });

  it('shows "Unblock" when agent is in the denied list', async () => {
    mockDeniedData = { denied: [{ path: '/home/user/project' }] };

    render(<AgentManagementMenu onDeleteRequest={vi.fn()} />, { wrapper: createWrapper() });
    await openMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /unblock/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('menuitem', { name: /^block$/i })).not.toBeInTheDocument();
  });

  it('calls onDeleteRequest when Delete Agent & Data is clicked', async () => {
    const onDeleteRequest = vi.fn();
    render(<AgentManagementMenu onDeleteRequest={onDeleteRequest} />, {
      wrapper: createWrapper(),
    });
    await openMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /delete agent/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /delete agent/i }));
    });
    expect(onDeleteRequest).toHaveBeenCalled();
  });

  it('calls unregister mutation when Unregister is clicked', async () => {
    render(<AgentManagementMenu onDeleteRequest={vi.fn()} />, { wrapper: createWrapper() });
    await openMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /unregister/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /unregister/i }));
    });
    expect(mockUnregisterMutate).toHaveBeenCalledWith('agent-1', expect.any(Object));
  });

  it('shows toast with undo action on successful unregister', async () => {
    mockUnregisterMutate.mockImplementation((_id: string, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });

    render(<AgentManagementMenu onDeleteRequest={vi.fn()} />, { wrapper: createWrapper() });
    await openMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /unregister/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /unregister/i }));
    });

    expect(toast).toHaveBeenCalledWith(
      'Agent Test Agent unregistered',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Undo' }),
        duration: 5000,
      })
    );
  });

  it('calls deny mutation when Block is clicked', async () => {
    render(<AgentManagementMenu onDeleteRequest={vi.fn()} />, { wrapper: createWrapper() });
    await openMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /block/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /block/i }));
    });
    expect(mockDenyMutate).toHaveBeenCalledWith(
      { path: '/home/user/project', reason: 'Blocked via Agent Hub' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('calls clearDenial mutation when Unblock is clicked', async () => {
    mockDeniedData = { denied: [{ path: '/home/user/project' }] };

    render(<AgentManagementMenu onDeleteRequest={vi.fn()} />, { wrapper: createWrapper() });
    await openMenu();

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /unblock/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /unblock/i }));
    });
    expect(mockClearDenialMutate).toHaveBeenCalledWith(
      '/home/user/project',
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });
});
