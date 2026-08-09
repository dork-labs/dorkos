/**
 * @vitest-environment jsdom
 *
 * The /workspaces view (DOR-84): workspaces grouped by project, each card listing
 * its attached sessions, with an empty state when there are none.
 *
 * Also pins the page's own scroll container (DOR-1036). The route panel clips its
 * overflow, so a page that renders its content outside a scroller loses everything
 * past the first screenful. jsdom cannot measure that clipping, so the tests assert
 * the structure instead: the content must be inside the scroller `PageContainer`
 * wraps it in.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { WorkspaceWithSessions } from '@dorkos/shared/workspace';
import { WorkspacesPage } from '../ui/WorkspacesPage';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

function makeWorkspace(over: Partial<WorkspaceWithSessions>): WorkspaceWithSessions {
  return {
    id: 'w',
    projectKey: 'core',
    key: 'DOR-84',
    path: '/r/core/DOR-84',
    source: '/r',
    branch: 'dork/DOR-84',
    provider: 'worktree',
    status: 'ready',
    portBase: 4290,
    portBlockSize: 10,
    hostname: null,
    url: null,
    pinned: false,
    createdAt: '2026-06-16T00:00:00.000Z',
    lastUsedAt: '2026-06-16T00:00:00.000Z',
    sessions: [],
    dirty: { dirty: false, uncommitted: [], untracked: [], unpushed: 0 },
    ...over,
  };
}

function renderWith(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <WorkspacesPage />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * The element that actually scrolls: the wrapper `PageContainer` puts around its
 * content box when it owns the page's scrolling. Null when the page renders no
 * container, or one that declined the scroller.
 */
function scrollViewport(container: HTMLElement) {
  const content = container.querySelector<HTMLElement>('[data-slot="page-container"]');
  const scroller = content?.parentElement ?? null;
  return scroller?.classList.contains('overflow-y-auto') ? scroller : null;
}

describe('WorkspacesPage', () => {
  it('renders workspaces grouped by project with their attached sessions', async () => {
    const workspaces: WorkspaceWithSessions[] = [
      makeWorkspace({
        id: 'w1',
        projectKey: 'core',
        key: 'DOR-84',
        pinned: true,
        sessions: [{ sessionId: 's1', cwd: '/r/core/DOR-84', title: 'refactor allocator' }],
        dirty: { dirty: true, uncommitted: ['a'], untracked: [], unpushed: 0 },
      }),
      makeWorkspace({ id: 'w2', projectKey: 'dunny', key: 'feat-x', provider: 'clone' }),
    ];
    const transport = createMockTransport({
      listWorkspaces: vi.fn().mockResolvedValue(workspaces),
    });

    const { container } = renderWith(transport);

    expect(await screen.findByText('DOR-84')).toBeInTheDocument();
    expect(screen.getByText('refactor allocator')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /core/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /dunny/ })).toBeInTheDocument();
    expect(screen.getByText(/1 changes/)).toBeInTheDocument();

    // Every group sits inside the scroller, so a long list stays reachable.
    const viewport = scrollViewport(container);
    expect(viewport).not.toBeNull();
    expect(viewport).toContainElement(screen.getByRole('heading', { name: /core/ }));
    expect(viewport).toContainElement(screen.getByRole('heading', { name: /dunny/ }));
  });

  it('shows the empty state when there are no workspaces', async () => {
    const transport = createMockTransport({ listWorkspaces: vi.fn().mockResolvedValue([]) });
    const { container } = renderWith(transport);
    const empty = await screen.findByText('No workspaces yet');
    expect(empty).toBeInTheDocument();

    const viewport = scrollViewport(container);
    expect(viewport).not.toBeNull();
    expect(viewport).toContainElement(empty);
  });
});
