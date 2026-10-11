/**
 * @vitest-environment jsdom
 */
import { StrictMode, useState, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { onboardingStageSearchSchema } from '../model/onboarding-stage';
import type { FirstRunAccountLink, FirstRunSlots } from '../model/first-run-slots';

const mockStartOnboarding = vi.fn();
vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => ({ startOnboarding: mockStartOnboarding, completeOnboarding: vi.fn() }),
}));

const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock('sonner', () => ({ toast: mockToast }));

// Landing posts the welcome and navigates to Home; its own behaviour is not what
// this file is about, only that the flow reaches it.
vi.mock('../ui/LandingStep', () => ({
  LandingStep: () => <div data-testid="landing-step" />,
}));

import { OnboardingFlow } from '../ui/OnboardingFlow';

const CODE = 'DORK-2F7Q';
const COMPLETE = `https://dorkos.ai/activate?code=${CODE}&from=complete`;

/** A link that behaves like the real one: start puts a code in flight. */
function useFakeLink(): FirstRunAccountLink {
  const [state, setState] = useState<FirstRunAccountLink['state']>('idle');
  return {
    state,
    pending:
      state === 'pending'
        ? {
            userCode: CODE,
            verificationUri: 'https://dorkos.ai/activate',
            verificationUriComplete: COMPLETE,
          }
        : null,
    starting: false,
    startError: null,
    start: async () => {
      fakeStart();
      setState('pending');
      return CODE;
    },
    cancel: async () => {
      fakeCancel();
      setState('idle');
    },
    openBilling: fakeOpenBilling,
    billingPending: false,
    billingNotice: null,
  };
}
const fakeStart = vi.fn();
const fakeCancel = vi.fn();
const fakeOpenBilling = vi.fn();

function FakeLinkBridge({ render }: { render: (link: FirstRunAccountLink) => ReactNode }) {
  return <>{render(useFakeLink())}</>;
}

const SLOTS: FirstRunSlots = {
  renderAccountLink: (render) => <FakeLinkBridge render={render} />,
};

function credits(readiness: CloudCreditsStatus['readiness']): CloudCreditsStatus {
  return { linked: readiness !== 'unlinked', runtimes: {}, readiness } as CloudCreditsStatus;
}

function buildHarness(initialUrl: string, transport: Transport) {
  const rootRoute = createRootRoute({ staticData: { header: null } });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(onboardingStageSearchSchema),
    component: () => <OnboardingFlow onComplete={vi.fn()} slots={SLOTS} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper() {
    // StrictMode, as the app mounts it: its development double mount once
    // closed the tab Continue had just opened, before the code could reach it.
    return (
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <RouterProvider router={router} />
          </TransportProvider>
        </QueryClientProvider>
      </StrictMode>
    );
  }
  const readStage = () => (router.state.location.search as { onboarding?: string }).onboarding;
  return { router, Wrapper, readStage };
}

async function renderFlow(initialUrl = '/', overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    getCloudCredits: vi.fn().mockResolvedValue(credits('unlinked')),
    ...overrides,
  });
  const harness = buildHarness(initialUrl, transport);
  render(<harness.Wrapper />);
  await waitFor(() => expect(harness.router.state.status).toBe('idle'));
  return { ...harness, transport };
}

describe('OnboardingFlow', () => {
  const fakeWindow = { opener: null, close: vi.fn(), location: { replace: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'open').mockReturnValue(fakeWindow as unknown as Window);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens on Welcome with the account first, and anchors the stage param', async () => {
    const { readStage } = await renderFlow();
    expect(screen.getByRole('heading', { name: 'You, Multiplied.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with DorkOS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use my own AI' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue without an account' })).toBeTruthy();
    await waitFor(() => expect(readStage()).toBe('welcome'));
    expect(mockStartOnboarding).toHaveBeenCalledTimes(1);
  });

  it('names no runtime, model or vendor on Welcome', async () => {
    await renderFlow();
    const text = document.body.textContent ?? '';
    for (const name of ['Claude', 'Anthropic', 'OpenAI', 'GPT', 'Codex', 'OpenCode', 'runtime']) {
      expect(text).not.toContain(name);
    }
  });

  it('Continue with DorkOS records the path, then asks for a code, and sends the waiting tab to the filled-in page', async () => {
    const order: string[] = [];
    const chooseFirstRunPath = vi.fn(async () => {
      order.push('first-run');
      return { path: 'dorkos' as const, runtime: 'doe' };
    });
    fakeStart.mockImplementation(() => order.push('start'));
    const { readStage } = await renderFlow('/', { chooseFirstRunPath });

    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));

    // The tab is opened in the click itself, before any request.
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(readStage()).toBe('connecting'));
    await waitFor(() => expect(fakeWindow.location.replace).toHaveBeenCalledWith(COMPLETE));
    expect(fakeWindow.close).not.toHaveBeenCalled();
    expect(chooseFirstRunPath).toHaveBeenCalledWith({ path: 'dorkos' });
    expect(order).toEqual(['first-run', 'start']);
    expect(await screen.findByText('Finish in your browser.')).toBeTruthy();
    expect(screen.getByText(CODE)).toBeTruthy();
  });

  it('moves on to Landing by itself once credits are ready', async () => {
    const getCloudCredits = vi
      .fn()
      .mockResolvedValueOnce(credits('linked'))
      .mockResolvedValue(credits('ready'));
    const { readStage } = await renderFlow('/', { getCloudCredits });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    await waitFor(() => expect(readStage()).toBe('landing'), { timeout: 6000 });
    expect(screen.getByTestId('landing-step')).toBeTruthy();
  }, 10_000);

  it('asks for a card when the account has none, and opens the billing page', async () => {
    await renderFlow('/', { getCloudCredits: vi.fn().mockResolvedValue(credits('needs-card')) });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    expect(await screen.findByText('Add a card to finish.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a card' }));
    expect(fakeOpenBilling).toHaveBeenCalledTimes(1);
  });

  it('points a refused account at Own AI', async () => {
    const { readStage } = await renderFlow('/', {
      getCloudCredits: vi.fn().mockResolvedValue(credits('refused')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    expect(await screen.findByText('Paid plans are US only.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use my own AI' }));
    await waitFor(() => expect(readStage()).toBe('own-ai'));
  });

  it('Cancel drops the code and returns to Welcome', async () => {
    const { readStage } = await renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    await screen.findByText(CODE);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(readStage()).toBe('welcome'));
    expect(fakeCancel).toHaveBeenCalledTimes(1);
  });

  it('says why when recording the path fails, and closes the waiting tab', async () => {
    const chooseFirstRunPath = vi
      .fn()
      .mockRejectedValue(new Error('Setup is only available on this computer.'));
    await renderFlow('/', { chooseFirstRunPath });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    expect(await screen.findByText('Setup is only available on this computer.')).toBeTruthy();
    expect(fakeWindow.close).toHaveBeenCalled();
    expect(fakeStart).not.toHaveBeenCalled();
  });

  it('Continue without an account records the path and lands', async () => {
    const chooseFirstRunPath = vi.fn().mockResolvedValue({ path: 'none', runtime: 'claude-code' });
    const { readStage } = await renderFlow('/', { chooseFirstRunPath });
    fireEvent.click(screen.getByRole('button', { name: 'Continue without an account' }));
    await waitFor(() => expect(readStage()).toBe('landing'));
    expect(chooseFirstRunPath).toHaveBeenCalledWith({ path: 'none' });
  });

  it('Use my own AI opens the list, and Back returns to Welcome', async () => {
    const { readStage } = await renderFlow();
    fireEvent.click(screen.getByRole('button', { name: 'Use my own AI' }));
    await waitFor(() => expect(readStage()).toBe('own-ai'));
    expect(screen.getByText('An OpenAI API key')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(readStage()).toBe('welcome'));
  });

  it('a key saved in Own AI records the pick and lands', async () => {
    const chooseFirstRunPath = vi.fn().mockResolvedValue({ path: 'own', runtime: 'doe' });
    const { readStage } = await renderFlow('/?onboarding=own-ai', { chooseFirstRunPath });
    fireEvent.click(screen.getByRole('button', { name: /An OpenRouter key/ }));
    fireEvent.change(screen.getByLabelText('OpenRouter key'), { target: { value: 'sk-or-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(readStage()).toBe('landing'));
    expect(chooseFirstRunPath).toHaveBeenCalledWith({
      path: 'own',
      choice: { kind: 'openrouter', apiKey: 'sk-or-1' },
    });
  });

  it('shows the server’s sentence when a key is refused, and stays put', async () => {
    const refusal = Object.assign(new Error('That key was refused.'), { code: 'invalid_key' });
    const chooseFirstRunPath = vi.fn().mockRejectedValue(refusal);
    const { readStage } = await renderFlow('/?onboarding=own-ai', { chooseFirstRunPath });
    fireEvent.click(screen.getByRole('button', { name: /An OpenAI API key/ }));
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'sk-bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('That key was refused.')).toBeTruthy();
    expect(readStage()).toBe('own-ai');
  });

  it('refuses an Anthropic subscription token before anything is sent', async () => {
    const chooseFirstRunPath = vi.fn();
    await renderFlow('/?onboarding=own-ai', { chooseFirstRunPath });
    fireEvent.click(screen.getByRole('button', { name: /An Anthropic API key/ }));
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: 'sk-ant-oat01-x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Subscription tokens can’t run agents/)).toBeTruthy();
    expect(chooseFirstRunPath).not.toHaveBeenCalled();
  });

  it('a stale stage value lands on Welcome', async () => {
    const { readStage } = await renderFlow('/?onboarding=power');
    await waitFor(() => expect(readStage()).toBe('welcome'));
  });

  it('drops a code still waiting before another path is recorded', async () => {
    const order: string[] = [];
    fakeCancel.mockImplementation(() => order.push('cancel'));
    const chooseFirstRunPath = vi.fn(async (request: { path: string }) => {
      order.push(`first-run ${request.path}`);
      return { path: request.path, runtime: 'claude-code' };
    });
    const { router, readStage } = await renderFlow('/', {
      chooseFirstRunPath: chooseFirstRunPath as unknown as Transport['chooseFirstRunPath'],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    await screen.findByText(CODE);

    // Browser Back leaves Connecting with the code still out in the open tab.
    router.history.back();
    await waitFor(() => expect(readStage()).toBe('welcome'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue without an account' }));
    await waitFor(() => expect(readStage()).toBe('landing'));

    expect(order).toEqual(['first-run dorkos', 'cancel', 'first-run none']);
  });

  it('drops a code still waiting before an own-AI pick is recorded', async () => {
    const order: string[] = [];
    fakeCancel.mockImplementation(() => order.push('cancel'));
    const chooseFirstRunPath = vi.fn(async (request: { path: string }) => {
      order.push(`first-run ${request.path}`);
      return { path: request.path, runtime: 'doe' };
    });
    const { router, readStage } = await renderFlow('/', {
      chooseFirstRunPath: chooseFirstRunPath as unknown as Transport['chooseFirstRunPath'],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
    await screen.findByText(CODE);
    router.history.back();
    await waitFor(() => expect(readStage()).toBe('welcome'));

    fireEvent.click(screen.getByRole('button', { name: 'Use my own AI' }));
    fireEvent.click(await screen.findByRole('button', { name: /An OpenAI API key/ }));
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'sk-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(readStage()).toBe('landing'));

    expect(order).toEqual(['first-run dorkos', 'cancel', 'first-run own']);
  });

  it('says so quietly when DorkOS could not read the service’s model list', async () => {
    const chooseFirstRunPath = vi
      .fn()
      .mockResolvedValue({ path: 'own', runtime: 'doe', modelListed: false });
    const { readStage } = await renderFlow('/?onboarding=own-ai', { chooseFirstRunPath });
    fireEvent.click(screen.getByRole('button', { name: /An OpenRouter key/ }));
    fireEvent.change(screen.getByLabelText('OpenRouter key'), { target: { value: 'sk-or-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(readStage()).toBe('landing'));
    expect(mockToast).toHaveBeenCalledWith('Using a default model. Change it in Settings.');
  });
});
