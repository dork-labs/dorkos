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
 * **`AgentOnboardingCard` has since been deleted** (DOR-1138): it hung off an
 * empty-Library branch that `ensureDorkBot` made unreachable, and day-one
 * guidance moved to the Getting started zone. Only the runtime-sense card is
 * left, so the collision is now impossible by construction rather than by
 * agreement — and what still needs guarding is the half that can regress: this
 * file mounts the real `ProgressCard`, not a copy of its strings, so reverting
 * its rename fails here instead of shipping silently.
 */
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

  it('leaves the fleet sense with no sidebar card to collide with', async () => {
    // The other half of the original pair is gone, and its absence is the point:
    // with one card left there is no second surface that could reclaim the
    // string. Asserted from the runtime-sense card's own render so this is a
    // fact about what ships, not a note about what was removed.
    await renderProgressCard();

    expect(screen.queryByText(/Add more agents to your fleet/)).not.toBeInTheDocument();
    expect(screen.getByText('Connect more runtimes')).toBeInTheDocument();
  });
});
