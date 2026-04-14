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
const mockDeleteMutate = vi.fn();
let mockDeniedData: { denied: { path: string }[] } = { denied: [] };

vi.mock('@/layers/entities/mesh', () => ({
  useUnregisterAgent: () => ({ mutate: mockUnregisterMutate }),
  useRegisterAgent: () => ({ mutate: mockRegisterMutate }),
  useDenyAgent: () => ({ mutate: mockDenyMutate }),
  useClearDenial: () => ({ mutate: mockClearDenialMutate }),
  useDeniedAgents: () => ({ data: mockDeniedData }),
  useDeleteAgentData: () => ({ mutate: mockDeleteMutate }),
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

/** Open the management dialog by clicking the kebab trigger. */
async function openDialog() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /agent management actions/i }));
  });
  await waitFor(() => {
    expect(screen.getByText(/manage test agent/i)).toBeInTheDocument();
  });
}

/** Click an action card by its title text. */
async function clickAction(title: string) {
  const titleEl = screen.getByText(title);
  const button = titleEl.closest('button')!;
  await act(async () => {
    fireEvent.click(button);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  mockAgent.isSystem = false;
  mockAgent.displayName = 'Test Agent';
  mockDeniedData = { denied: [] };
});

describe('AgentManagementMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders kebab trigger button', () => {
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    expect(screen.getByRole('button', { name: /agent management actions/i })).toBeInTheDocument();
  });

  it('shows action cards with descriptions for regular agents', async () => {
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();

    expect(screen.getByText('Block')).toBeInTheDocument();
    expect(screen.getByText(/hide this agent/i)).toBeInTheDocument();
    expect(screen.getByText('Unregister')).toBeInTheDocument();
    expect(screen.getByText(/remove this agent from your list/i)).toBeInTheDocument();
    expect(screen.getByText('Delete Agent & Data')).toBeInTheDocument();
    expect(screen.getByText(/permanently erase/i)).toBeInTheDocument();
  });

  it('shows system agent message instead of actions', async () => {
    mockAgent.isSystem = true as unknown as boolean;
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();

    expect(screen.getByText(/cannot be blocked/i)).toBeInTheDocument();
    expect(screen.queryByText('Block')).not.toBeInTheDocument();
    expect(screen.queryByText('Unregister')).not.toBeInTheDocument();
  });

  it('shows Unblock card when agent is in the denied list', async () => {
    mockDeniedData = { denied: [{ path: '/home/user/project' }] };
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();

    expect(screen.getByText('Unblock')).toBeInTheDocument();
    expect(screen.getByText(/discovered again/i)).toBeInTheDocument();
    expect(screen.queryByText('Block')).not.toBeInTheDocument();
  });

  it('shows Block confirmation and calls deny mutation on confirm', async () => {
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();
    await clickAction('Block');

    await waitFor(() => {
      expect(screen.getByText(/Block Test Agent\?/)).toBeInTheDocument();
    });
    expect(screen.getByText(/hidden from future scans/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^block$/i }));
    });

    expect(mockDenyMutate).toHaveBeenCalledWith(
      { path: '/home/user/project', reason: 'Blocked via Agent Hub' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('shows Unblock confirmation and calls clearDenial on confirm', async () => {
    mockDeniedData = { denied: [{ path: '/home/user/project' }] };
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();
    await clickAction('Unblock');

    await waitFor(() => {
      expect(screen.getByText(/Unblock Test Agent\?/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^unblock$/i }));
    });

    expect(mockClearDenialMutate).toHaveBeenCalledWith(
      '/home/user/project',
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('shows Unregister confirmation and calls mutation on confirm', async () => {
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();
    await clickAction('Unregister');

    await waitFor(() => {
      expect(screen.getByText(/Unregister Test Agent\?/)).toBeInTheDocument();
    });
    expect(screen.getByText(/disappear from your list/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^unregister$/i }));
    });

    expect(mockUnregisterMutate).toHaveBeenCalledWith('agent-1', expect.any(Object));
  });

  it('shows toast with undo action on successful unregister', async () => {
    mockUnregisterMutate.mockImplementation((_id: string, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });

    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();
    await clickAction('Unregister');

    await waitFor(() => {
      expect(screen.getByText(/Unregister Test Agent\?/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^unregister$/i }));
    });

    expect(toast).toHaveBeenCalledWith(
      'Agent Test Agent unregistered',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Undo' }),
        duration: 5000,
      })
    );
  });

  it('shows Delete confirmation with type-to-confirm input', async () => {
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();
    await clickAction('Delete Agent & Data');

    await waitFor(() => {
      expect(screen.getByText(/Delete Test Agent\?/)).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-confirm-input')).toBeInTheDocument();

    const deleteBtn = screen.getByRole('button', { name: /delete agent/i });
    expect(deleteBtn).toBeDisabled();
  });

  it('enables delete button only when name matches and calls mutation', async () => {
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();
    await clickAction('Delete Agent & Data');

    await waitFor(() => {
      expect(screen.getByTestId('delete-confirm-input')).toBeInTheDocument();
    });

    const input = screen.getByTestId('delete-confirm-input');
    const deleteBtn = screen.getByRole('button', { name: /delete agent/i });

    // Wrong name — still disabled
    await act(async () => {
      fireEvent.change(input, { target: { value: 'wrong name' } });
    });
    expect(deleteBtn).toBeDisabled();

    // Correct name — enabled
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Test Agent' } });
    });
    expect(deleteBtn).toBeEnabled();

    await act(async () => {
      fireEvent.click(deleteBtn);
    });
    expect(mockDeleteMutate).toHaveBeenCalledWith('agent-1', expect.any(Object));
  });

  it('back button returns to actions step from confirmation', async () => {
    render(<AgentManagementMenu />, { wrapper: createWrapper() });
    await openDialog();
    await clickAction('Block');

    await waitFor(() => {
      expect(screen.getByText(/Block Test Agent\?/)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /back to actions/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/manage test agent/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Block')).toBeInTheDocument();
  });
});
