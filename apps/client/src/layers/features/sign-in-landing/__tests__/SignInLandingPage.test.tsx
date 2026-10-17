// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createMockTransport } from '@dorkos/test-utils';
import type { SignInLanding } from '@dorkos/shared/sign-in-landing';
import { TransportProvider } from '@/layers/shared/model';
import { SignInLandingPage } from '../ui/SignInLandingPage';

const LANDING: SignInLanding = {
  id: 'land-1',
  service: 'mcp',
  serviceName: 'Linear',
  status: 'connected',
  agentId: 'agent-1',
  resumesConversation: true,
  returnPath: '/session?session=abc',
  returnSurface: 'browser',
  canRetry: false,
};

function mount(landing: SignInLanding | null, overrides: Record<string, unknown> = {}) {
  const transport = createMockTransport({
    getSignInLanding: landing
      ? vi.fn().mockResolvedValue(landing)
      : vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { status: 404 })),
    getMeshAgent: vi.fn().mockResolvedValue({ id: 'agent-1', name: 'Scout' }),
    ...overrides,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The page sits on the router, for its link home; a two-route tree is enough.
  const rootRoute = createRootRoute({ staticData: { header: null } });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: '/signed-in',
    staticData: { header: null },
    component: () => <SignInLandingPage landingId="land-1" />,
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    staticData: { header: null },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, home]),
    history: createMemoryHistory({ initialEntries: ['/signed-in'] }),
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <RouterProvider router={router} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SignInLandingPage', () => {
  it('names the service and the agent, and links back to the conversation', async () => {
    mount(LANDING);
    expect(await screen.findByRole('heading', { name: 'Signed in to Linear' })).toBeVisible();
    expect(await screen.findByText('Scout is picking up where it left off.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to DorkOS' })).toHaveAttribute(
      'href',
      '/session?session=abc'
    );
    expect(screen.getByText('Or close this tab.')).toBeVisible();
    await waitFor(() => expect(document.title).toBe('Signed in to Linear · DorkOS'));
  });

  it('renders a hostile service name as text', async () => {
    mount({ ...LANDING, serviceName: '<img src=x onerror=alert(1)>' });
    expect(
      await screen.findByRole('heading', { name: 'Signed in to <img src=x onerror=alert(1)>' })
    ).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });

  it('offers to open the desktop app, by its deep link, when the sign-in began there', async () => {
    mount({ ...LANDING, returnSurface: 'desktop' });
    const open = await screen.findByRole('link', { name: /Open DorkOS/ });
    expect(open).toHaveAttribute('href', 'dorkos://session?session=abc');
    expect(screen.getByText('Opening DorkOS…')).toBeVisible();
  });

  it('words a cancelled sign-in plainly and offers Try again', async () => {
    const transport = mount(
      { ...LANDING, status: 'failed', reason: 'cancelled', canRetry: true },
      { retrySignIn: vi.fn().mockResolvedValue({ kind: 'connected' }) }
    );
    expect(await screen.findByRole('heading', { name: 'Sign-in cancelled' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(transport.retrySignIn).toHaveBeenCalledWith('land-1'));
    // Already signed in by the time it ran: the page shows the finished state.
    expect(await screen.findByRole('heading', { name: 'Signed in to Linear' })).toBeVisible();
  });

  it('refuses to follow a Try again link that is not a safe sign-in page', async () => {
    mount(
      { ...LANDING, status: 'failed', reason: 'failed', canRetry: true },
      {
        retrySignIn: vi
          .fn()
          .mockResolvedValue({ kind: 'authorize', authorizeUrl: 'javascript:alert(1)' }),
      }
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Couldn’t start a new sign-in. Try again from DorkOS.')
    ).toBeVisible();
  });

  it('says DorkOS could not be reached when the read fails for another reason', async () => {
    mount(null, {
      getSignInLanding: vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 502 })),
    });
    expect(await screen.findByRole('heading', { name: 'Couldn’t reach DorkOS' })).toBeVisible();
  });

  it('hands a finished desktop sign-in to the app once, by its deep link', async () => {
    const assigned: string[] = [];
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...original,
        set href(url: string) {
          assigned.push(url);
        },
      },
    });
    try {
      mount({ ...LANDING, returnSurface: 'desktop' });
      await screen.findByRole('link', { name: /Open DorkOS/ });
      await waitFor(() => expect(assigned).toEqual(['dorkos://session?session=abc']));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('says the page expired when its record is gone', async () => {
    mount(null);
    expect(await screen.findByRole('heading', { name: 'This page expired' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to DorkOS' })).toHaveAttribute('href', '/');
  });
});
