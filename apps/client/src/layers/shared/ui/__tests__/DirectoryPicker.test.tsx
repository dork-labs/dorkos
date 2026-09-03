/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { DirectoryPicker } from '../DirectoryPicker';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// Mock app-store (recentCwds)
vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      recentCwds: [
        { path: '/home/user/project-a', accessedAt: '2026-02-07T12:00:00Z' },
        { path: '/home/user/project-b', accessedAt: '2026-02-06T10:00:00Z' },
      ],
    };
    return selector ? selector(state) : state;
  },
}));

// The leaf modules, not the `shared/lib` barrel: inside `shared/` the barrel is
// not the way in (DOR-1761), so `DirectoryPicker` imports each of these from the
// module that holds it and a mock aimed at the barrel stands in for nothing.
vi.mock('@/layers/shared/lib/session-utils', () => ({
  formatRelativeTime: () => '1h ago',
  shortenHomePath: (p: string) => p.replace('/home/user', '~'),
}));
vi.mock('@/layers/shared/lib/constants', () => ({
  STORAGE_KEYS: { PICKER_VIEW: 'dorkos-picker-view' },
}));
vi.mock('@/layers/shared/lib/resolve-agent-visual', () => ({
  resolveAgentVisual: () => ({ color: 'hsl(200, 60%, 50%)', emoji: '🤖' }),
}));

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

let mockTransport: Transport;

function renderPicker(
  props: {
    onSelect?: (path: string) => void;
    initialPath?: string;
    resolvedAgents?: Record<string, unknown>;
  } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onSelect = props.onSelect ?? vi.fn();
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <DirectoryPicker
          open={true}
          onOpenChange={vi.fn()}
          onSelect={onSelect}
          initialPath={props.initialPath ?? '/home/user'}
          resolvedAgents={props.resolvedAgents as never}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Switch to browse view and wait for entries to appear. */
async function switchToBrowse() {
  fireEvent.click(screen.getByLabelText('Browse directories'));
  await waitFor(() => {
    expect(screen.getByText('Documents')).toBeDefined();
  });
}

describe('DirectoryPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransport = createMockTransport();
    vi.mocked(mockTransport.browseDirectory).mockResolvedValue({
      path: '/home/user',
      entries: [
        { name: 'Documents', path: '/home/user/Documents', isDirectory: true },
        { name: 'Projects', path: '/home/user/Projects', isDirectory: true },
      ],
      parent: '/',
    });
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders dialog title', () => {
    renderPicker();
    expect(screen.getByText('Select Working Directory')).toBeDefined();
  });

  it('shows directory entries after switching to browse view', async () => {
    // With recentCwds populated, the picker defaults to "recent" view
    // Switch to browse by clicking the Browse button
    renderPicker();

    fireEvent.click(screen.getByLabelText('Browse directories'));

    await waitFor(() => {
      expect(screen.getByText('Documents')).toBeDefined();
      expect(screen.getByText('Projects')).toBeDefined();
    });
  });

  it('calls onSelect when Select button is clicked in browse view', async () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    fireEvent.click(screen.getByLabelText('Browse directories'));

    await waitFor(() => {
      expect(screen.getByText('Documents')).toBeDefined();
    });

    fireEvent.click(screen.getByText('Select'));

    expect(onSelect).toHaveBeenCalledWith('/home/user');
  });

  it('shows recent directories in default view', () => {
    renderPicker();

    // Recent view is default when recentCwds has entries
    expect(screen.getByText('~/project-a')).toBeDefined();
    expect(screen.getByText('~/project-b')).toBeDefined();
  });

  it('calls onSelect when clicking a recent directory', () => {
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    fireEvent.click(screen.getByText('~/project-a'));

    expect(onSelect).toHaveBeenCalledWith('/home/user/project-a');
  });

  it('draws a recent folder’s agent as an agent, not a bare colour dot', () => {
    renderPicker({
      resolvedAgents: {
        '/home/user/project-a': { id: 'agent-1', name: 'api-bot', runtime: 'claude-code' },
        '/home/user/project-b': null,
      },
    });

    // The dialog renders in a portal, so the row is reached from its own text.
    const row = screen.getByText('api-bot').closest('button');
    // The shared disc told `kind="agent"` — this file is `shared/ui` and may
    // not reach `entities/agent`, so `kind` is how it says "agent" at all.
    const disc = row?.querySelector('[data-slot="identity-avatar"]');
    expect(disc).toBeTruthy();
    expect(disc?.className).toContain('rounded-md');
    expect(disc?.className).not.toContain('rounded-full');
    // Filled with the agent's own colour, and wearing the Bot mark — the two
    // things the hand-rolled `<span>` dot could not say.
    expect(disc?.getAttribute('style')).toContain('hsl(200, 60%, 50%)');
    expect(disc?.querySelector('[data-slot="identity-badge"]')).toBeTruthy();
  });

  // --- New folder tests ---

  describe('New folder', () => {
    it('renders New folder button in browse toolbar', async () => {
      renderPicker();
      await switchToBrowse();

      expect(screen.getByLabelText('New folder')).toBeDefined();
    });

    it('shows inline text input when New folder is clicked', async () => {
      renderPicker();
      await switchToBrowse();

      fireEvent.click(screen.getByLabelText('New folder'));

      const input = screen.getByLabelText('New folder name');
      expect(input).toBeDefined();
      expect(document.activeElement).toBe(input);
    });

    it('shows error text for invalid folder name', async () => {
      renderPicker();
      await switchToBrowse();

      fireEvent.click(screen.getByLabelText('New folder'));
      const input = screen.getByLabelText('New folder name');

      fireEvent.change(input, { target: { value: 'INVALID_NAME' } });

      expect(
        screen.getByText('Lowercase letters, numbers, and hyphens only. Must start with a letter.')
      ).toBeDefined();
    });

    it('enables confirm button for valid name', async () => {
      renderPicker();
      await switchToBrowse();

      fireEvent.click(screen.getByLabelText('New folder'));
      const input = screen.getByLabelText('New folder name');

      fireEvent.change(input, { target: { value: 'my-new-folder' } });

      const confirmBtn = screen.getByLabelText('Confirm new folder');
      expect(confirmBtn).not.toHaveProperty('disabled', true);
    });

    it('disables confirm button when name has error', async () => {
      renderPicker();
      await switchToBrowse();

      fireEvent.click(screen.getByLabelText('New folder'));
      const input = screen.getByLabelText('New folder name');

      fireEvent.change(input, { target: { value: '-bad' } });

      const confirmBtn = screen.getByLabelText('Confirm new folder');
      expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    });

    it('calls transport.createDirectory on Enter key', async () => {
      vi.mocked(mockTransport.createDirectory).mockResolvedValue({
        path: '/home/user/my-folder',
      });

      renderPicker();
      await switchToBrowse();

      fireEvent.click(screen.getByLabelText('New folder'));
      const input = screen.getByLabelText('New folder name');

      fireEvent.change(input, { target: { value: 'my-folder' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(mockTransport.createDirectory).toHaveBeenCalledWith('/home/user', 'my-folder');
      });
    });

    it('cancels inline input on Escape key', async () => {
      renderPicker();
      await switchToBrowse();

      fireEvent.click(screen.getByLabelText('New folder'));
      expect(screen.getByLabelText('New folder name')).toBeDefined();

      fireEvent.keyDown(screen.getByLabelText('New folder name'), { key: 'Escape' });

      expect(screen.queryByLabelText('New folder name')).toBeNull();
    });

    it('cancels inline input on X button click', async () => {
      renderPicker();
      await switchToBrowse();

      fireEvent.click(screen.getByLabelText('New folder'));
      expect(screen.getByLabelText('New folder name')).toBeDefined();

      fireEvent.click(screen.getByLabelText('Cancel new folder'));

      expect(screen.queryByLabelText('New folder name')).toBeNull();
    });

    it('refetches directory listing on success', async () => {
      vi.mocked(mockTransport.createDirectory).mockResolvedValue({
        path: '/home/user/new-dir',
      });

      renderPicker();
      await switchToBrowse();

      // Record call count before create
      const callsBefore = vi.mocked(mockTransport.browseDirectory).mock.calls.length;

      fireEvent.click(screen.getByLabelText('New folder'));
      fireEvent.change(screen.getByLabelText('New folder name'), {
        target: { value: 'new-dir' },
      });
      fireEvent.keyDown(screen.getByLabelText('New folder name'), { key: 'Enter' });

      await waitFor(() => {
        // browseDirectory should have been called again after folder creation
        expect(vi.mocked(mockTransport.browseDirectory).mock.calls.length).toBeGreaterThan(
          callsBefore
        );
      });
    });

    it('shows toast on creation error', async () => {
      vi.mocked(mockTransport.createDirectory).mockRejectedValue(new Error('Permission denied'));

      renderPicker();
      await switchToBrowse();

      fireEvent.click(screen.getByLabelText('New folder'));
      fireEvent.change(screen.getByLabelText('New folder name'), {
        target: { value: 'my-folder' },
      });
      fireEvent.keyDown(screen.getByLabelText('New folder name'), { key: 'Enter' });

      await waitFor(() => {
        // The authored line is the headline and the server's own words sit
        // under it, so a person meets a sentence rather than "EACCES" (DOR-1755).
        expect(toast.error).toHaveBeenCalledWith(
          "Couldn't make that folder.",
          expect.objectContaining({ description: 'Permission denied' })
        );
      });
    });
  });
});
