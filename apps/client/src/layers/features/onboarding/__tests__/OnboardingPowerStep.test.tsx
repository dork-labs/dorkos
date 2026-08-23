/**
 * @vitest-environment jsdom
 *
 * The onboarding power stage hosts the shared full-power door. These pin the two
 * things the STAGE owns — flow-step bookkeeping and advancing — on top of the
 * door's own writes (which are pinned exhaustively in FullPowerDoor.test):
 *
 *   - answering either way records `completeStep('power')` and advances;
 *   - "Decide later" records `skipStep('power')`, advances, and writes NO config;
 *   - the stage writes no consent field itself — that stays the door's job.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useSetOpenMesh } from '@/layers/entities/mesh';
import { useAppStore } from '@/layers/shared/model';

import { OnboardingPowerStep } from '../ui/OnboardingPowerStep';

// The hosted door reads `useConfig` (for `auth.enabled`) and writes via
// `useUpdateConfig` + `useSetOpenMesh`; mocking all three lets the stage's
// behaviour be observed without real writes. `configKeys` is preserved
// (importOriginal) because the door invalidates the config prefix through the
// real query client.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useConfig: vi.fn(), useUpdateConfig: vi.fn() };
});
vi.mock('@/layers/entities/mesh', () => ({ useSetOpenMesh: vi.fn() }));

// The step's own flow-progress writes, which are what these tests assert.
const completeStep = vi.fn();
const skipStep = vi.fn();
vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => ({ completeStep, skipStep }),
}));

const configMutateAsync = vi.fn();
const meshMutateAsync = vi.fn();
const onAdvance = vi.fn();

function setMutations() {
  vi.mocked(useConfig).mockReturnValue({
    data: { auth: { enabled: false } },
    isFetchedAfterMount: true,
  } as unknown as ReturnType<typeof useConfig>);
  vi.mocked(useUpdateConfig).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: configMutateAsync,
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateConfig>);
  vi.mocked(useSetOpenMesh).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: meshMutateAsync,
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useSetOpenMesh>);
}

/** The stage as OnboardingFlow mounts it — inside the frame, with a live client. */
function renderStage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <OnboardingPowerStep onAdvance={onAdvance} />
    </QueryClientProvider>
  );
}

const ACCEPT = /unlock full power/i;
const DECLINE = /keep asking me first/i;
const CUSTOMIZE = /customize/i;
const DECIDE_LATER = /decide later/i;

describe('OnboardingPowerStep', () => {
  beforeEach(() => {
    configMutateAsync.mockReset().mockResolvedValue(undefined);
    meshMutateAsync.mockReset().mockResolvedValue(undefined);
    onAdvance.mockReset();
    completeStep.mockReset();
    skipStep.mockReset();
    useAppStore.setState({ controlCenterOpen: false });
    setMutations();
  });

  afterEach(cleanup);

  it('renders the door with the onboarding heading', () => {
    renderStage();
    expect(screen.getByText('Choose your power level')).toBeInTheDocument();
    // The shared door copy, not a second copy written here.
    expect(screen.getByText(/no approval prompts/i)).toBeInTheDocument();
  });

  it('accept performs the door writes, completes the step, and advances', async () => {
    const user = userEvent.setup();
    renderStage();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    // The door's own atomic write (full body pinned in FullPowerDoor.test) fired,
    // then the mesh opened — the stage did not re-implement any of it.
    expect(configMutateAsync).toHaveBeenCalledTimes(1);
    expect(meshMutateAsync).toHaveBeenCalledWith(true);
    // What the STAGE owns: the step is marked complete and the flow advances.
    await waitFor(() => expect(completeStep).toHaveBeenCalledWith('power'));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(skipStep).not.toHaveBeenCalled();
  });

  it('decline records supervised, completes the step, and advances', async () => {
    const user = userEvent.setup();
    renderStage();

    await user.click(screen.getByRole('button', { name: DECLINE }));

    // The door writes only the supervised decision — no stop, no mesh.
    expect(configMutateAsync).toHaveBeenCalledWith({
      ui: { fullPowerDecidedAt: expect.any(String), fullPowerChoice: 'supervised' },
    });
    expect(meshMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(completeStep).toHaveBeenCalledWith('power'));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(skipStep).not.toHaveBeenCalled();
  });

  it('offers no Customize… during setup, and never opens the Control Center', async () => {
    const user = userEvent.setup();
    renderStage();

    // The Control Center host is unmounted while the onboarding overlay shows, so
    // the stage passes no `onCustomize` and the door hides the link entirely.
    expect(screen.queryByRole('button', { name: CUSTOMIZE })).not.toBeInTheDocument();

    // Exercising the whole stage never flips the Control Center flag — nothing
    // here can open a surface that is not mounted.
    await user.click(screen.getByRole('button', { name: DECLINE }));
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().controlCenterOpen).toBe(false);
  });

  it('"Decide later" skips the step and advances, writing no consent field', async () => {
    const user = userEvent.setup();
    renderStage();

    await user.click(screen.getByRole('button', { name: DECIDE_LATER }));

    expect(skipStep).toHaveBeenCalledWith('power');
    expect(onAdvance).toHaveBeenCalledTimes(1);
    // A deferral touches nothing: no consent write, no mesh, no completed step.
    expect(configMutateAsync).not.toHaveBeenCalled();
    expect(meshMutateAsync).not.toHaveBeenCalled();
    expect(completeStep).not.toHaveBeenCalled();
  });
});
