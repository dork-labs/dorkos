import { useConfig } from '@/layers/entities/config';
import { useAppStore } from '@/layers/shared/model';
import { TelemetryConsentMoment } from '@/layers/features/telemetry-consent';
import { TrustNoticeMoment, isTrustNoticeEligible } from '@/layers/features/trust-notice';

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
 * Trust-notice descriptor — the high rung, shown once to say agents now work
 * without asking (spec `trusted-by-default-flip` §5.8). It outranks the
 * telemetry invitation below it: it describes how the install already behaves.
 *
 * Eligibility is {@link isTrustNoticeEligible}: config loaded, onboarding over,
 * `ui.trustNoticeSeenAt` still null, and the install on Trusted. The rail's own
 * rules (no moment over the onboarding overlay or in the launch the first run
 * ended in, at most one moment per launch, nothing from an unconfirmed cache)
 * are the host's job and are deliberately not repeated here.
 */
export function useTrustNoticeMomentDescriptor(): MomentDescriptor | null {
  const { data: config } = useConfig();
  if (!isTrustNoticeEligible(config)) return null;
  return {
    id: 'trust-notice',
    priority: MOMENT_PRIORITY.high,
    render: ({ onClose }) => <TrustNoticeMoment onClose={onClose} />,
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
  const trustNotice = useTrustNoticeMomentDescriptor();
  const telemetry = useTelemetryMomentDescriptor();
  // The first run ended in this launch, so #team and DorkBot's welcome are on
  // screen with the chips that start the first job (spec
  // `one-minute-onboarding` §2.4). No moment covers them: each waits for the
  // next launch, which is when the rail asks an existing user anyway.
  const firstRunThisLaunch = useAppStore((s) => s.onboardingHiddenForSession);
  if (firstRunThisLaunch) return [];
  return [trustNotice, telemetry].filter((d): d is MomentDescriptor => d !== null);
}
