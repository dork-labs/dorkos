/**
 * @vitest-environment jsdom
 *
 * The /workspaces view (DOR-1056): the read-only adoption scan — the checkouts
 * that really exist on disk, grouped by project folder, with an honest empty
 * state when the scan found none.
 *
 * The page's job is honesty, so the tests concentrate on the ways it could lie:
 * claiming a branch is in sync with a remote it never compared against, hiding a
 * folder git could not read, or offering an action that would change one.
 *
 * Also pins the page's own scroll container (DOR-1036). The route panel clips its
 * overflow, so a page that renders its content outside a scroller loses everything
 * past the first screenful. jsdom cannot measure that clipping, so the tests assert
 * the structure instead: the content must be inside the scroller `PageContainer`
 * wraps it in.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { WorktreeScanEntry, WorktreeScanResult } from '@dorkos/shared/workspace';
import { WorkspacesPage } from '../ui/WorkspacesPage';

function makeWorktree(over: Partial<WorktreeScanEntry>): WorktreeScanEntry {
  return {
    path: '/root/core/DOR-84',
    name: 'DOR-84',
    project: 'core',
    repoPath: '/repos/core',
    branch: 'feat/DOR-84',
    changedFiles: 0,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    lastCommitAt: new Date().toISOString(),
    readable: true,
    ...over,
  };
}

function renderWithScan(result: Partial<WorktreeScanResult>) {
  return renderWithTransport(
    createMockTransport({
      scanWorktrees: vi
        .fn()
        .mockResolvedValue({ root: '/root', worktrees: [], warnings: [], ...result }),
    }) as Transport
  );
}

function renderWithTransport(transport: Transport) {
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
  it('groups the scanned checkouts by project folder', async () => {
    const { container } = renderWithScan({
      worktrees: [
        makeWorktree({ name: 'DOR-84', path: '/root/core/DOR-84', project: 'core' }),
        makeWorktree({ name: 'DOR-91', path: '/root/core/DOR-91', project: 'core' }),
        makeWorktree({ name: 'flow', path: '/root/mkt/flow', project: 'mkt' }),
      ],
    });

    expect(await screen.findByRole('heading', { name: /core/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /mkt/ })).toBeInTheDocument();
    // The count badge beside each project heading reports that group's size.
    expect(screen.getByRole('heading', { name: /core/ })).toHaveTextContent('2');
    expect(screen.getByRole('heading', { name: /mkt/ })).toHaveTextContent('1');

    // Every group sits inside the scroller, so a long list stays reachable.
    const viewport = scrollViewport(container);
    expect(viewport).not.toBeNull();
    expect(viewport).toContainElement(screen.getByRole('heading', { name: /core/ }));
    expect(viewport).toContainElement(screen.getByRole('heading', { name: /mkt/ }));
  });

  it('shows the branch, the unsaved-work count, and the remote comparison', async () => {
    renderWithScan({
      worktrees: [makeWorktree({ branch: 'feat/x', changedFiles: 3, ahead: 2, behind: 1 })],
    });

    expect(await screen.findByText('feat/x')).toBeInTheDocument();
    expect(screen.getByText('3 changed')).toBeInTheDocument();
    expect(screen.getByText('2 ahead · 1 behind')).toBeInTheDocument();
  });

  it('says a checkout with no changes is clean', async () => {
    renderWithScan({ worktrees: [makeWorktree({ changedFiles: 0, ahead: 0, behind: 0 })] });

    expect(await screen.findByText('Clean')).toBeInTheDocument();
    expect(screen.getByText('In sync')).toBeInTheDocument();
  });

  it('never claims a branch with no upstream is in sync', async () => {
    renderWithScan({ worktrees: [makeWorktree({ ahead: null, behind: null })] });

    await screen.findByText('DOR-84');
    // "In sync" would be a claim about a comparison that was never made.
    expect(screen.queryByText('In sync')).not.toBeInTheDocument();
    expect(screen.queryByText(/ahead/)).not.toBeInTheDocument();
  });

  it('says a checkout whose upstream is gone is done, not in sync', async () => {
    renderWithScan({
      worktrees: [makeWorktree({ upstreamGone: true, ahead: null, behind: null })],
    });

    // The single most common state in a real workspaces folder: the PR merged
    // and the remote branch was deleted. Calling that "In sync" is the lie this
    // page exists to stop telling.
    expect(await screen.findByText('Branch merged or deleted')).toBeInTheDocument();
    expect(screen.queryByText('In sync')).not.toBeInTheDocument();
  });

  it('still lists a checkout git could not read, and marks it as such', async () => {
    renderWithScan({
      worktrees: [
        makeWorktree({
          name: 'broken',
          path: '/root/core/broken',
          readable: false,
          branch: null,
          changedFiles: null,
          ahead: null,
          behind: null,
          lastCommitAt: null,
        }),
      ],
    });

    // The unreadable folder is the one most worth seeing, so it gets a row.
    expect(await screen.findByText('broken')).toBeInTheDocument();
    expect(screen.getByText(/Can't read/)).toBeInTheDocument();
    // And it claims nothing it does not know.
    expect(screen.queryByText('Clean')).not.toBeInTheDocument();
  });

  it('distinguishes a detached checkout from an unreadable one', async () => {
    renderWithScan({ worktrees: [makeWorktree({ branch: null, readable: true })] });

    expect(await screen.findByText('No branch')).toBeInTheDocument();
    expect(screen.queryByText(/Can't read/)).not.toBeInTheDocument();
  });

  it('offers no way to create, pin, or delete a checkout', async () => {
    const { container } = renderWithScan({ worktrees: [makeWorktree({})] });

    await screen.findByText('DOR-84');
    // Read-only is the whole point: a page that lists other agents' live trees
    // must not put a destructive control next to them.
    expect(within(container).queryAllByRole('button')).toHaveLength(0);
  });

  it('says the scan failed rather than claiming there is nothing', async () => {
    const transport = createMockTransport({
      scanWorktrees: vi.fn().mockRejectedValue(new Error('Failed to fetch')),
    }) as Transport;

    renderWithTransport(transport);

    // A dropped connection must never render as "No worktrees yet" — that is a
    // confident claim about a folder the app never managed to read.
    expect(await screen.findByText('Couldn’t check your worktrees')).toBeInTheDocument();
    expect(screen.queryByText('No worktrees yet')).not.toBeInTheDocument();
  });

  it('warns that the list is incomplete when a folder could not be opened', async () => {
    renderWithScan({
      worktrees: [makeWorktree({})],
      warnings: [{ path: '/home/me/.dork/workspaces/locked', reason: 'EACCES' }],
    });

    expect(await screen.findByText(/couldn’t be read/i)).toBeInTheDocument();
    expect(screen.getByText(/~\/\.dork\/workspaces\/locked \(EACCES\)/)).toBeInTheDocument();
    // The checkouts it DID find still render — a partial answer beats none.
    expect(screen.getByText('DOR-84')).toBeInTheDocument();
  });

  it('introduces the page with a gist, not a second explanation of worktrees', async () => {
    renderWithScan({ root: '/home/me/.dork/workspaces', worktrees: [] });

    await screen.findByText('No worktrees yet');
    // The concept is explained once, in the empty-state card. The intro used to
    // explain it again in three sentences directly above that card.
    expect(screen.getByText('Copies of your code, per agent.')).toBeInTheDocument();
    expect(screen.queryByText(/Agents work in these/)).not.toBeInTheDocument();
  });

  it('keeps the workspaces path out of running prose, so it cannot escape the card', async () => {
    renderWithScan({ root: '/home/me/.dork/workspaces', worktrees: [] });

    await screen.findByText('No worktrees yet');
    // A path has no spaces to break at. Spliced into the sentence it ran off
    // the card and off a 390px screen; on its own line, in a code element that
    // breaks mid-token, it cannot.
    const path = screen.getByText('~/.dork/workspaces');
    expect(path.tagName).toBe('CODE');
    expect(path.className).toMatch(/break-all/);
  });

  it('shows an honest empty state naming where it looked', async () => {
    const { container } = renderWithScan({ root: '/home/me/.dork/workspaces', worktrees: [] });

    const empty = await screen.findByText('No worktrees yet');
    expect(empty).toBeInTheDocument();
    expect(screen.getByText(/~\/\.dork\/workspaces/)).toBeInTheDocument();

    const viewport = scrollViewport(container);
    expect(viewport).not.toBeNull();
    expect(viewport).toContainElement(empty);
  });
});
