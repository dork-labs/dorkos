import { useConfig } from '@/layers/entities/config';
import { TelemetryConsentMoment } from '@/layers/features/telemetry-consent';

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
  const telemetry = useTelemetryMomentDescriptor();
  return [telemetry].filter((d): d is MomentDescriptor => d !== null);
}
