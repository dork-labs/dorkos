/**
 * @vitest-environment jsdom
 *
 * The Activity page's "All actions" toggle (spec `audit-trail` PR4): one
 * switch between the Activity feed and every action the audit log recorded,
 * and only the list on screen is fetched.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import type { ActivityItem } from '@dorkos/shared/activity-schemas';
import type { AuditEvent } from '@dorkos/shared/audit-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { activitySearchSchema } from '@/app/route-search';

// The week summary counts sessions off the session list; this file is about the
// two lists below it, so the count stays unknown and draws nothing.
vi.mock('../model/use-session-activity', () => ({ useSessionActivity: () => null }));

import { ActivityPage } from '../ActivityPage';

const ACTIVITY_ITEM: ActivityItem = {
  id: 'act-1',
  occurredAt: new Date().toISOString(),
  actorType: 'agent',
  actorId: 'agent-1',
  actorLabel: 'Scout',
  category: 'agent',
  eventType: 'session.completed',
  resourceType: null,
  resourceId: null,
  resourceLabel: null,
  summary: 'Scout finished a run',
  linkPath: null,
  metadata: null,
};

const AUDIT_EVENT = {
  seq: 7,
  id: 'aud-7',
  at: new Date().toISOString(),
  spaceId: null,
  actor: { accountId: 'person-1', kind: 'person', name: 'Dorian' },
  source: { surface: 'app', sessionId: 'sess-1' },
  action: 'config.changed',
  operation: 'modify',
  target: null,
  outcome: 'ok',
  summary: 'Dorian changed the default model',
  visibility: 'space',
  prevHash: '0'.repeat(64),
  hash: '1'.repeat(64),
} as AuditEvent;

const SlotContext = createContext<ReactNode>(null);
function Slot() {
  return <>{useContext(SlotContext)}</>;
}

/** Mount the page at `/activity` under a router that validates its real search schema. */
function renderPage(initialUrl: string) {
  const transport = createMockTransport({
    listActivityEvents: vi.fn().mockResolvedValue({ items: [ACTIVITY_ITEM], nextCursor: null }),
    listAuditEvents: vi.fn().mockResolvedValue({ events: [AUDIT_EVENT] }),
  });
  const rootRoute = createRootRoute({ staticData: { header: null }, component: () => <Outlet /> });
  const activityRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/activity',
    staticData: { header: null },
    validateSearch: zodValidator(activitySearchSchema),
    component: Slot,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([activityRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <SlotContext.Provider value={<ActivityPage />}>
          <RouterProvider router={router} />
        </SlotContext.Provider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, router };
}

afterEach(() => cleanup());

describe('ActivityPage — All actions', () => {
  it('opens on the Activity feed and never reads the audit log', async () => {
    const { transport } = renderPage('/activity');

    expect(await screen.findByText('Scout finished a run')).toBeInTheDocument();
    expect(transport.listActivityEvents).toHaveBeenCalled();
    expect(transport.listAuditEvents).not.toHaveBeenCalled();
  });

  it('switches to every recorded action, and keeps the choice in the URL', async () => {
    const { transport, router } = renderPage('/activity');
    await screen.findByText('Scout finished a run');

    await userEvent.click(screen.getByRole('radio', { name: 'All actions' }));

    expect(await screen.findByText('Dorian changed the default model')).toBeInTheDocument();
    expect(screen.queryByText('Scout finished a run')).not.toBeInTheDocument();
    expect(transport.listAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    expect((router.state.location.search as { view?: string }).view).toBe('all');
    // The audit log has no categories, so the category chips go with the feed.
    expect(screen.queryByRole('button', { name: 'Messages' })).not.toBeInTheDocument();
    // The row happened in a chat, so it opens it.
    expect(screen.getByRole('button', { name: /Open/ })).toBeInTheDocument();
  });

  it('lands on All actions from a link, without fetching the feed', async () => {
    const { transport } = renderPage('/activity?view=all');

    expect(await screen.findByText('Dorian changed the default model')).toBeInTheDocument();
    await waitFor(() => expect(transport.listAuditEvents).toHaveBeenCalled());
    expect(transport.listActivityEvents).not.toHaveBeenCalled();
  });
});
