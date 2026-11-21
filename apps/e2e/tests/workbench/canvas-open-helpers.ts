import type { Locator, Page, Request, Route } from '@playwright/test';
import type { CanvasDocument } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { expect } from '../../fixtures';

type CanvasOpen =
  | { type: 'file'; sourcePath: string }
  | { type: 'image'; src: string }
  | { type: 'markdown'; title: string };

/** Opt into observing the stream echo while the real POST reply is held by Playwright. */
export const observeCanvasOpenOrdering = process.env.DORKOS_E2E_HOLD_CANVAS_OPEN === '1';

function openMatches(request: Request, routePath: string, expected: CanvasOpen): boolean {
  if (request.method() !== 'POST' || new URL(request.url()).pathname !== routePath) return false;
  const content = (request.postDataJSON() as { content?: UiCanvasContent } | null)?.content;
  switch (expected.type) {
    case 'file':
      return content?.type === 'file' && content.sourcePath === expected.sourcePath;
    case 'image':
      return content?.type === 'image' && content.src === expected.src;
    case 'markdown':
      return content?.type === 'markdown' && content.title === expected.title;
  }
}

const tabId = (id: string) => `right-panel-tab-resource/${id}`;
const visibleTabs = (tabs: Locator) =>
  tabs.evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.id,
      selected: element.getAttribute('aria-selected'),
    }))
  );

/** Wait for the exact normal canvas open and one selected tab for its persisted row. */
export async function openSettledCanvasTab(options: {
  page: Page;
  tabs: Locator;
  sessionId: string;
  expected: CanvasOpen;
  open: () => Promise<void>;
  observeBeforeResponse?: boolean;
}): Promise<void> {
  const { page, tabs, sessionId, expected, open, observeBeforeResponse } = options;
  const routePath = `/api/sessions/${encodeURIComponent(sessionId)}/canvas`;
  const routeUrl = (url: URL) => url.pathname === routePath;
  const matches = (request: Request) => openMatches(request, routePath, expected);
  let orderingFailure: unknown;
  const hold = async (route: Route) => {
    if (!matches(route.request())) return route.fallback();
    const response = await route.fetch();
    try {
      expect(response.status()).toBe(201);
      const row = (await response.json()) as CanvasDocument;
      await expect
        .poll(async () => {
          const current = await visibleTabs(tabs);
          return {
            count: current.length,
            selectedPending: current.some(
              (tab) => tab.id.startsWith(tabId('pending:')) && tab.selected === 'true'
            ),
            streamedRow: current.some(
              (tab) => tab.id === tabId(row.id) && tab.selected === 'false'
            ),
          };
        })
        .toEqual({ count: 2, selectedPending: true, streamedRow: true });
    } catch (error) {
      orderingFailure = error;
    } finally {
      // Let the exact response settle even if the temporary-order assertion failed.
      await route.fulfill({ response });
    }
  };

  if (observeBeforeResponse) await page.route(routeUrl, hold);
  try {
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => matches(candidate.request())),
      open(),
    ]);
    if (orderingFailure) throw orderingFailure;
    expect(response.status()).toBe(201);
    const row = (await response.json()) as CanvasDocument;
    expect(row.id).toBeTruthy();
    // Poll the whole set so a brief second match neither fails a strict locator
    // nor lets an arbitrary matching tab satisfy the uniqueness assertion.
    await expect.poll(() => visibleTabs(tabs)).toEqual([{ id: tabId(row.id), selected: 'true' }]);
  } finally {
    if (observeBeforeResponse) await page.unroute(routeUrl, hold);
  }
}
