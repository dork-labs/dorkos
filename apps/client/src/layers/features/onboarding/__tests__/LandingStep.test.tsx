/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { onboardingStageSearchSchema } from '../model/onboarding-stage';

const mockCompleteOnboarding = vi.fn();
vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => ({ completeOnboarding: mockCompleteOnboarding }),
}));

import { LandingStep } from '../ui/LandingStep';

async function renderLanding(transport: Transport) {
  const onComplete = vi.fn();
  const rootRoute = createRootRoute({ staticData: { header: null } });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(onboardingStageSearchSchema),
    component: () => <LandingStep onComplete={onComplete} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/?onboarding=landing'] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RouterProvider router={router} />
      </TransportProvider>
    </QueryClientProvider>
  );
  await waitFor(() => expect(router.state.status).toBe('idle'));
  return { router, onComplete };
}

describe('LandingStep', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('posts the welcome, finishes setup and opens #team', async () => {
    const transport = createMockTransport();
    const { router, onComplete } = await renderLanding(transport);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(transport.postOnboardingWelcome).toHaveBeenCalledTimes(1);
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect((router.state.location.search as { onboarding?: string }).onboarding).toBeUndefined()
    );
  });

  it('offers a way on to #team beside the retry when the welcome cannot be posted', async () => {
    const transport = createMockTransport({
      postOnboardingWelcome: vi.fn().mockRejectedValue(new Error('Couldn’t reach #team.')),
    });
    const { onComplete } = await renderLanding(transport);
    expect(await screen.findByText('Couldn’t reach #team.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Go to #team' }));
    // Setup is finished either way, so the first run never comes back.
    expect(mockCompleteOnboarding).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
