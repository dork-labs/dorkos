/**
 * Every Dev Playground page renders, and nothing in it crashes (DOR-1117).
 *
 * **The hole this closes.** `ShowcaseErrorBoundary` wraps each
 * `PlaygroundSection`, so a showcase that throws becomes a tidy red card
 * instead of a white screen — which is right for a person browsing the
 * playground and terrible for a repository, because nothing loaded `/dev/*` in
 * any test. Caught live: two of three sections on a page were error cards while
 * `pnpm verify` was entirely green. The boundary was doing its job; the job it
 * was doing was hiding the failure from everyone who could have fixed it.
 *
 * **Why this is a unit sweep and not a browser one.** The playground is a
 * dev-only surface — `main.tsx` only lazy-loads it under `import.meta.env.DEV`
 * — so a Playwright leg would have to run a Vite dev server just for it, and
 * would pay a page load per page. jsdom mounts all twenty-two in a couple of
 * seconds, and the thing being asserted (did any component throw during render)
 * is not a thing a real browser knows better than jsdom does. Existing dev
 * tests already mount whole pages this way; this generalizes them.
 *
 * **What makes it not rot.** The list of pages comes from `PAGE_CONFIGS`, which
 * is the same array that draws the sidebar nav and the overview cards, and the
 * first case below refuses any page that is in one of the two registries and
 * not the other. So a playground page added tomorrow is covered by this file
 * without anybody editing it — which a hard-coded list of twenty-two names
 * would not be.
 *
 * **What it does NOT claim.** It renders each page once, at its initial state,
 * with no interaction. A showcase that only throws after a click is out of
 * scope; the point is the class of failure that was actually observed, which is
 * a section that is broken the moment you open the page.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { createPlaygroundTransport } from '../playground-transport';
import { PAGE_CONFIGS } from '../playground-config';
import { PAGE_COMPONENTS } from '../playground-pages';

// The onboarding showcase fires real confetti, which paints on a rAF loop
// against a 2D canvas context jsdom does not implement — so the loop throws
// `Cannot read properties of null (reading 'clearRect')` from a timer, AFTER
// the test that started it has finished. Vitest reports that as an unhandled
// error and warns it may have caused false positives, which would make this
// gate's own result untrustworthy. Nothing here asserts on confetti; a no-op is
// the honest substitute.
vi.mock('canvas-confetti', () => ({ default: vi.fn(), create: () => vi.fn() }));

beforeEach(() => {
  // jsdom has neither of these, and showcases reach for both: the TOC observes
  // its own anchors, and anything that scrolls a selection into view calls
  // `scrollIntoView`. Both are no-ops here — nothing below asserts on scroll
  // position, only on whether rendering threw.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  Element.prototype.scrollIntoView = vi.fn();
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/**
 * Render one page inside the same providers the playground shell supplies.
 *
 * Deliberately mirrors `DevPlayground.tsx` rather than importing it: the shell
 * builds its `QueryClient`, transport and router at module scope and owns the
 * page-switching state, so importing it would mount one page and give this
 * sweep no way to ask for the others. The stack itself is small and stable —
 * query client, transport, router context, tooltip and sidebar context — and
 * the drift risk is covered by the fact that a missing provider makes the page
 * throw, which is precisely what this file fails on.
 *
 * The router is memory-history for the same reason the shell's is: showcases
 * call `useNavigate`/`useSearch` transitively, and those hooks throw outside a
 * router. Nothing here navigates.
 *
 * @param pageId - The page to render, keyed as in `PAGE_COMPONENTS`.
 * @returns The rendered container element, once the router has settled.
 */
async function renderPage(pageId: string): Promise<HTMLElement> {
  const PageComponent = PAGE_COMPONENTS[pageId];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <TooltipProvider>
        <SidebarProvider defaultOpen>
          <PageComponent />
        </SidebarProvider>
      </TooltipProvider>
    ),
    // THE SECOND WAY A SHOWCASE CAN CRASH, and the one that nearly slipped
    // through this gate. `ShowcaseErrorBoundary` sits INSIDE `PlaygroundSection`
    // and so only catches a throw from that section's children. A showcase
    // component that throws in its own body — before it renders any section at
    // all — sails past it and lands in the router's `CatchBoundary` instead,
    // which renders its own error UI and swallows the throw. Verified by
    // mutation: a `throw` at the top of `ButtonShowcases` left this file GREEN
    // until this component existed, because the page still rendered *something*
    // (the router's error page) and produced no `data-showcase-error` node.
    //
    // Marking the router's error the same way the boundary marks its own is
    // what makes the two failure modes one assertion. In the playground proper
    // this is the whole-page white screen, so it is the more serious of the two.
    errorComponent: ({ error }) => (
      <div data-showcase-error={`the whole /dev/${pageId} page`}>
        {error instanceof Error ? error.message : String(error)}
      </div>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/dev/${pageId}`] }),
  });
  // A freshly created router renders nothing until it has resolved its initial
  // location, and `RouterProvider` does that resolution asynchronously. Without
  // the load-then-flush below, every page here mounted an EMPTY container —
  // which the "something rendered at all" assertion catches, but which a
  // crashed-showcase count on its own would have read as a clean bill of
  // health for twenty-two pages that never rendered.
  await router.load();
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createPlaygroundTransport()}>
        <RouterProvider router={router} />
      </TransportProvider>
    </QueryClientProvider>
  );
  // Let effects, and anything they resolved synchronously, land before the
  // caller looks at the DOM.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

/**
 * Every showcase on the page that the error boundary caught, by name.
 *
 * Keyed on the `data-showcase-error` attribute rather than the card's visible
 * copy: the copy is prose somebody will improve, and a gate that a wording
 * change can silently disarm is not a gate.
 */
function crashedShowcases(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-showcase-error]')).map(
    (el) => el.getAttribute('data-showcase-error') ?? 'unknown'
  );
}

describe('the dev playground', () => {
  it('has a component for every page, and a page for every component', () => {
    // Both directions. A page in PAGE_CONFIGS with no component renders blank
    // and is unreachable; a component with no config is dead code no nav item
    // points at. Either way the two lists have drifted, and this sweep would
    // quietly stop covering something.
    const configured = PAGE_CONFIGS.map((c) => c.id).sort();
    const drawn = Object.keys(PAGE_COMPONENTS).sort();
    // `overview` is the one page with no PAGE_CONFIGS entry: it is the index
    // that lists the others, reached from its own nav item rather than from the
    // page array it renders cards for.
    expect(drawn.filter((id) => id !== 'overview')).toEqual(configured);
  });

  // One case per page, named after the page, so a failure says which one broke
  // in the test name — before anybody opens the assertion message.
  it.each([...PAGE_CONFIGS.map((c) => c.id), 'overview'])(
    'renders /dev/%s with no crashed showcases',
    async (pageId) => {
      const container = await renderPage(pageId);

      // Something rendered at all. Without this a page that returned `null`
      // would sail through the crash check by having nothing to crash.
      expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);

      expect(
        crashedShowcases(container),
        `these showcases threw while rendering /dev/${pageId} — the playground would ` +
          `show them as red error cards, and nothing else in the suite would notice`
      ).toEqual([]);
    }
  );
});
