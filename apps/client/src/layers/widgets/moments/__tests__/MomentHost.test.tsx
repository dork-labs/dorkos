/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { useConfig } from '@/layers/entities/config';
import { useAppStore } from '@/layers/shared/model';
import { DialogTitle } from '@/layers/shared/ui';

import { MomentHost, MOMENT_PRIORITY, type MomentDescriptor } from '@/layers/widgets/moments';

import { useMoments } from '../model/use-moments';

// The host reads only `useConfig` from the config entity (the onboarding
// timestamps). Everything else on the barrel is preserved so the shared UI it
// pulls in keeps working.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useConfig: vi.fn() };
});

// Arbitration is what this suite is about, so the collector is driven directly.
// What the real collector puts in the array is `use-moments.test.tsx`.
vi.mock('../model/use-moments', () => ({ useMoments: vi.fn() }));

/** A minimal moment whose modal body is identifiable by text. */
function fakeMoment(id: string, priority: number): MomentDescriptor {
  return {
    id,
    priority,
    render: () => (
      <>
        <DialogTitle>{id} moment</DialogTitle>
        <p>{id} body</p>
      </>
    ),
  };
}

/**
 * Drive the config half of the gate.
 *
 * @param onboarding - The onboarding timestamps, or `null` for "config has not loaded".
 * @param fetchedAfterMount - Whether this config came from the server on THIS page
 *   load. `false` models a warm boot serving the persisted cache, which is the
 *   default the tests below opt out of deliberately.
 */
function setOnboarding(
  onboarding: { completedAt?: string | null; dismissedAt?: string | null } | null,
  fetchedAfterMount = true
) {
  vi.mocked(useConfig).mockReturnValue({
    data:
      onboarding === null
        ? undefined
        : {
            onboarding: {
              completedAt: onboarding.completedAt ?? null,
              dismissedAt: onboarding.dismissedAt ?? null,
            },
          },
    isLoading: false,
    isFetchedAfterMount: fetchedAfterMount,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useConfig>);
}

const FINISHED_ONBOARDING = { completedAt: '2026-08-01T10:00:00.000Z' };

describe('MomentHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A fresh page life: the rail has not spent its one moment yet.
    useAppStore.setState({ momentShownThisLaunch: false });
    setOnboarding(FINISHED_ONBOARDING);
    vi.mocked(useMoments).mockReturnValue([]);
  });

  afterEach(cleanup);

  it('renders nothing when no moment is eligible', () => {
    const { container } = render(<MomentHost />);
    expect(container).toBeEmptyDOMElement();
    expect(document.body.textContent).toBe('');
  });

  it('renders the sole eligible moment in a modal', async () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);

    render(<MomentHost />);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('telemetry body')).toBeInTheDocument();
  });

  it('shows the highest-priority moment and never stacks', async () => {
    vi.mocked(useMoments).mockReturnValue([
      fakeMoment('telemetry', MOMENT_PRIORITY.low),
      fakeMoment('full-power', MOMENT_PRIORITY.high),
    ]);

    render(<MomentHost />);

    expect(await screen.findByText('full-power body')).toBeInTheDocument();
    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('breaks a priority tie on collector order', async () => {
    vi.mocked(useMoments).mockReturnValue([
      fakeMoment('first', MOMENT_PRIORITY.low),
      fakeMoment('second', MOMENT_PRIORITY.low),
    ]);

    render(<MomentHost />);

    expect(await screen.findByText('first body')).toBeInTheDocument();
    expect(screen.queryByText('second body')).not.toBeInTheDocument();
  });

  it('spends at most one moment per app launch', async () => {
    const user = userEvent.setup();
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);

    const { rerender } = render(<MomentHost />);
    await screen.findByText('telemetry body');
    expect(useAppStore.getState().momentShownThisLaunch).toBe(true);

    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();

    // A second moment becomes eligible in the same page life. It must wait.
    vi.mocked(useMoments).mockReturnValue([fakeMoment('full-power', MOMENT_PRIORITY.high)]);
    rerender(<MomentHost />);

    expect(screen.queryByText('full-power body')).not.toBeInTheDocument();
  });

  it('opens again on a fresh launch, because the latch is not persisted', async () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    render(<MomentHost />);
    await screen.findByText('telemetry body');
    expect(useAppStore.getState().momentShownThisLaunch).toBe(true);

    // A reload is a new page life: the store starts over.
    cleanup();
    useAppStore.setState({ momentShownThisLaunch: false });
    render(<MomentHost />);

    expect(await screen.findByText('telemetry body')).toBeInTheDocument();
  });

  it('never renders while the onboarding overlay is mounted, and does not spend the launch', () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);

    render(<MomentHost onboardingOverlayVisible />);

    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();
    // Suppression must not burn the launch's one moment — otherwise finishing
    // onboarding would silently cost the user the moment they never saw.
    expect(useAppStore.getState().momentShownThisLaunch).toBe(false);
  });

  it('closes an open moment when the onboarding overlay comes back up', async () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    const { rerender } = render(<MomentHost />);
    await screen.findByText('telemetry body');

    // "Replay setup" reopens the first-run overlay. A moment left on top of it
    // would be a modal painted over the flow that outranks it.
    rerender(<MomentHost onboardingOverlayVisible />);

    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();
  });

  it('never renders while onboarding is neither finished nor dismissed', () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    setOnboarding({ completedAt: null, dismissedAt: null });

    render(<MomentHost />);

    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();
  });

  // ── The config in hand must be this page load's, not last week's ──
  //
  // `['config','current']` is on the warm-boot persister's allow-list, so a
  // reload paints from localStorage and — inside the 30s staleTime — may serve
  // that copy without asking the server at all. Opening a moment off it means
  // re-asking a question answered in another window, at the CLI or by hand,
  // then overwriting the real answer with the reply to a question that should
  // never have been posed.

  it('does not open from a restored cache the server has not confirmed', () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    setOnboarding(FINISHED_ONBOARDING, false);

    render(<MomentHost />);

    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();
    // And the launch is not spent, so the ask survives the confirmation.
    expect(useAppStore.getState().momentShownThisLaunch).toBe(false);
  });

  it('opens once the server confirms the question is still unanswered', async () => {
    // Warm boot: the cached copy says "already decided", so the collector is
    // empty and nothing should open yet — not even on the strength of that.
    vi.mocked(useMoments).mockReturnValue([]);
    setOnboarding(FINISHED_ONBOARDING, false);
    const { rerender } = render(<MomentHost />);
    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();

    // The refetch lands and the server says the question is open after all.
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    setOnboarding(FINISHED_ONBOARDING, true);
    rerender(<MomentHost />);

    expect(await screen.findByText('telemetry body')).toBeInTheDocument();
  });

  it('never opens when the confirmed config says the question is already answered', () => {
    // The stale copy says undecided. Without the gate this opens immediately
    // and the user answers a question they already answered somewhere else.
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    setOnboarding(FINISHED_ONBOARDING, false);
    const { rerender } = render(<MomentHost />);
    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();

    // The refetch lands: decided. The moment drops out and was never shown.
    vi.mocked(useMoments).mockReturnValue([]);
    setOnboarding(FINISHED_ONBOARDING, true);
    rerender(<MomentHost />);

    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();
    expect(useAppStore.getState().momentShownThisLaunch).toBe(false);
  });

  it('puts initial focus on the dialog itself, never on the affirmative button', async () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);

    render(<MomentHost />);
    const dialog = await screen.findByRole('dialog');

    // The title and description are announced before any control, and no
    // keystroke can land on a consent button the user has not read up to.
    await waitFor(() => expect(document.activeElement).toBe(dialog));
  });

  it('never renders before config has loaded', () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    setOnboarding(null);

    render(<MomentHost />);

    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();
  });

  it('renders once onboarding has been deliberately dismissed', async () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    setOnboarding({ dismissedAt: '2026-08-01T10:00:00.000Z' });

    render(<MomentHost />);

    expect(await screen.findByText('telemetry body')).toBeInTheDocument();
  });

  it('closes when its moment stops being eligible', async () => {
    vi.mocked(useMoments).mockReturnValue([fakeMoment('telemetry', MOMENT_PRIORITY.low)]);
    const { rerender } = render(<MomentHost />);
    await screen.findByText('telemetry body');

    // The moment answered its own question (the write landed), so its
    // descriptor hook now returns null and it drops out of the collector.
    vi.mocked(useMoments).mockReturnValue([]);
    rerender(<MomentHost />);

    expect(screen.queryByText('telemetry body')).not.toBeInTheDocument();
  });
});
