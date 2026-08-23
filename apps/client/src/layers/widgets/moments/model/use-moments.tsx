import { useConfig } from '@/layers/entities/config';
import { TelemetryConsentMoment } from '@/layers/features/telemetry-consent';
import { FullPowerDoorMoment } from '@/layers/features/full-power-door';

import { MOMENT_PRIORITY, type MomentDescriptor } from './moment-descriptor';

/**
 * Telemetry-consent descriptor — the low rung, eligible until the user makes an
 * explicit telemetry choice. Nothing is sent either way until they answer, so
 * this is an invitation and yields to any door above it.
 *
 * Exported so the rail's extension contract is testable: this is the shape every
 * future moment copies.
 */
export function useTelemetryMomentDescriptor(): MomentDescriptor | null {
  const { data: config } = useConfig();
  if (config?.telemetry?.userHasDecided) return null;
  return {
    id: 'telemetry-consent',
    priority: MOMENT_PRIORITY.low,
    // The moment closes itself by answering: both buttons write
    // `userHasDecided`, this hook then returns null, and the host takes the
    // dialog down. It has no "not now" of its own, so it ignores `onClose`.
    render: () => <TelemetryConsentMoment />,
  };
}

/**
 * Full-power door descriptor — the high rung, shown once to existing users who
 * have not yet answered the power question. This is a consent door: its accept
 * flips full power on, so it outranks the telemetry invitation below it.
 *
 * Eligible when config has loaded, onboarding is over (`completedAt ?? dismissedAt`
 * is set), and `ui.fullPowerDecidedAt` is still null — a nullable timestamp plus
 * an "onboarding already over" gate, the same existing-user re-ask idiom as
 * `use-profile-prompt`. The rail's own rules (no moment over the onboarding
 * overlay, at most one moment per launch, nothing from an unconfirmed cache) are
 * the host's job and are deliberately not repeated here.
 *
 * This hook reads only `useConfig`, never a router hook, so the collector stays
 * renderable without a `RouterProvider`; the destination "Customize…" navigates
 * to lives in {@link FullPowerDoorMoment}, reached only when the door renders.
 */
export function useFullPowerMomentDescriptor(): MomentDescriptor | null {
  const { data: config } = useConfig();
  if (!config) return null;
  const onboardingOver =
    config.onboarding?.completedAt != null || config.onboarding?.dismissedAt != null;
  if (!onboardingOver) return null;
  if (config.ui?.fullPowerDecidedAt != null) return null;
  return {
    id: 'full-power-door',
    priority: MOMENT_PRIORITY.high,
    render: ({ onClose }) => <FullPowerDoorMoment onClose={onClose} />,
  };
}

/**
 * Collects every eligible one-time moment for the current app state. The host
 * ranks the result and opens the highest-priority one — at most one per app
 * launch. Add a moment by writing a descriptor hook and appending its result
 * here — no other wiring is required.
 *
 * Persistence is each moment's own concern, expressed through a real state field
 * the moment already owns (telemetry has `telemetry.userHasDecided`). There is
 * deliberately no `shownMoments` ledger: a parallel record of what has been shown
 * drifts from the state it is supposed to mirror, and there is nothing it could
 * record that the moment's own field cannot.
 */
export function useMoments(): MomentDescriptor[] {
  const fullPower = useFullPowerMomentDescriptor();
  const telemetry = useTelemetryMomentDescriptor();
  return [fullPower, telemetry].filter((d): d is MomentDescriptor => d !== null);
}
