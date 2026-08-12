/**
 * @vitest-environment jsdom
 *
 * DOR-853 (plans/language-ia-simplification.md §D0): bare "agent" in user copy
 * must resolve to exactly one sense — a named teammate in your fleet (DorkBot,
 * security-auditor…). The runtime sense (Claude Code / Codex / OpenCode) never
 * borrows that word; the SDK-subagent sense always says "subagent".
 *
 * The evidence line for the invariant was two sidebar cards that, before this
 * sweep, shipped the IDENTICAL string "Add more agents" for two different
 * concepts: `ProgressCard`'s row opens Settings → Runtimes (runtime sense),
 * while `AgentOnboardingCard`'s row added a fleet teammate (fleet sense).
 *
 * **`AgentOnboardingCard` has since been deleted** (DOR-1138). Its
 * empty-Library branch was reachable, but only before the fleet query answered
 * or while it failed — a hydration gap, not day one — so it flashed on cold
 * loads instead of greeting anyone; day-one guidance is the Getting started
 * zone's. One card is left, so the two-card collision cannot recur in the shape
 * it took.
 *
 * Two halves still need guarding, and each is checked the way it can actually
 * fail. The rename can be reverted, so this file mounts the real `ProgressCard`
 * rather than a copy of its strings. And the fleet-sense string could be
 * reintroduced anywhere in the sidebar by a component nobody thought to test,
 * so that half is a source scan over the whole feature — a rendered tree can
 * only ever speak for the components it mounts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { mergeDialogSearch, TransportProvider } from '@/layers/shared/model';

vi.mock('motion/react', () => ({
  motion: { div: 'div' },
  useReducedMotion: () => false,
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAgentCreationStore: { getState: () => ({ open: vi.fn() }) },
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ requestTour: vi.fn() }),
  };
});

vi.mock('@/layers/entities/config', () => ({
  useDefaultAgentSession: () => ({
    startSession: vi.fn(),
    defaultAgentDir: '~/.dork/agents/dorkbot',
  }),
}));

// Imported after the mocks above so ProgressCard picks up the mocked stores.
// Internal path (not the feature barrel), matching ProgressCard.test.tsx — the
// barrel pulls in far more of the feature than this file needs to mount one
// presentational card.
import { ProgressCard } from '@/layers/features/onboarding/ui/ProgressCard';

/**
 * Every sidebar source file, tests and fixtures excluded.
 *
 * The three directories an operator experiences as "the sidebar": the panel
 * itself, the embedded variant, and the phone's four tabs. Same set the
 * `one-create-surface` scan uses, for the same reason — a claim about the
 * sidebar that reads one directory is a claim about one directory.
 */
function sidebarSource(): Map<string, string> {
  const roots: [string, string][] = [
    ['dashboard-sidebar', join(__dirname, '..', 'layers', 'features', 'dashboard-sidebar')],
    ['session-list', join(__dirname, '..', 'layers', 'features', 'session-list')],
    ['mobile-tabs', join(__dirname, '..', 'layers', 'widgets', 'mobile-tabs')],
  ];
  const walk = (dir: string, prefix: string): [string, string][] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'fixtures') return [];
        return walk(full, `${prefix}${entry}/`);
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) return [];
      return [[`${prefix}${entry}`, readFileSync(full, 'utf8')] as [string, string]];
    });
  return new Map(roots.flatMap(([label, dir]) => walk(dir, `${label}/`)));
}

const SIDEBAR_SOURCE = sidebarSource();

/** Which sidebar files mention a pattern. */
function sidebarFilesMatching(pattern: RegExp): string[] {
  return [...SIDEBAR_SOURCE]
    .filter(([, text]) => pattern.test(text))
    .map(([file]) => file)
    .sort();
}

afterEach(cleanup);

const searchSchema = mergeDialogSearch(z.object({}));

async function renderProgressCard() {
  const mockTransport = createMockTransport();
  vi.mocked(mockTransport.getConfig).mockResolvedValue({
    profile: { roles: ['engineer'], tools: [], displayName: null, rolePromptDismissedAt: null },
  } as unknown as Awaited<ReturnType<typeof mockTransport.getConfig>>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(searchSchema),
    component: () => <ProgressCard onDismiss={vi.fn()} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        <RouterProvider router={router} />
      </TransportProvider>
    </QueryClientProvider>
  );
  await waitFor(() => expect(router.state.status).toBe('idle'));
  await waitFor(() => expect(mockTransport.getConfig).toHaveBeenCalled());
}

describe('DOR-853: the "agent" overload is resolved to one sense per surface', () => {
  it('ProgressCard opens Runtimes and never says bare "agent" for it (runtime sense)', async () => {
    await renderProgressCard();

    // The runtime-sense row names what it actually does — connects a runtime —
    // and does not borrow "agent" to say so.
    expect(screen.getByText('Connect more runtimes')).toBeInTheDocument();
    expect(screen.queryByText('Add more agents')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Add more agents$/)).not.toBeInTheDocument();
  });

  it('has no sidebar source carrying the fleet-sense string for it to collide with', () => {
    // A rendered tree proves nothing here: the string could come back in any
    // component this file does not mount. So the claim is checked against the
    // source of the whole sidebar, in the `one-create-surface` style.
    //
    // Positive half first — the scan really read the feature — because "no file
    // matches" is also what an empty scan says.
    expect(SIDEBAR_SOURCE.size).toBeGreaterThan(20);
    expect(sidebarFilesMatching(/\bSidebarZones\b/).length).toBeGreaterThan(0);

    expect(sidebarFilesMatching(/Add more agents/)).toEqual([]);
  });
});
