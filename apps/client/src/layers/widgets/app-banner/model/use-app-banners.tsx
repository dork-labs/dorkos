import { useConfig } from '@/layers/entities/config';
import { useUnattendedAutonomy } from '@/layers/entities/unattended-autonomy';
import { TelemetryConsentBanner } from '@/layers/features/telemetry-consent';

import { UnattendedAutonomyBanner } from '../ui/UnattendedAutonomyBanner';
import { BANNER_PRIORITY, type BannerDescriptor } from './banner-descriptor';

/**
 * First-run telemetry-consent descriptor — neutral severity, eligible until the
 * user makes an explicit telemetry choice. Mirrors the gate inside
 * {@link TelemetryConsentBanner} so an ineligible banner never suppresses others.
 */
function useTelemetryBannerDescriptor(): BannerDescriptor | null {
  const { data: config } = useConfig();
  if (config?.telemetry?.userHasDecided) return null;
  return {
    id: 'telemetry-consent',
    variant: 'neutral',
    priority: BANNER_PRIORITY.neutral,
    render: () => <TelemetryConsentBanner />,
  };
}

/**
 * Unattended-autonomy descriptor — warning severity, eligible whenever at least
 * one live binding or scheduled task is set to run without asking. Reads the
 * server's single cheap aggregate rather than the binding and task lists, which
 * is what lets a banner about them be app-wide at all.
 */
function useUnattendedAutonomyDescriptor(): BannerDescriptor | null {
  const state = useUnattendedAutonomy();
  if (!state || state.drivers.length === 0) return null;
  return {
    id: 'unattended-autonomy',
    variant: 'warning',
    priority: BANNER_PRIORITY.warning,
    render: () => <UnattendedAutonomyBanner drivers={state.drivers} />,
  };
}

/**
 * Collects every eligible app banner for the current app state. The slot ranks
 * the result and shows the highest-priority one. Add a banner by writing a
 * descriptor hook and appending its result here — no other wiring is required.
 *
 * ## The bypass banner that used to live here
 *
 * A session running with every permission bypassed raised a standing app-wide
 * banner. It is gone (spec `trust-dial`, decision 3A): it said the same thing the
 * status strip already says, in a second voice, about a session the person was
 * sitting in front of — and two alarms for one fact teach people to read neither.
 * The signal now lives where the setting does: the strip's word and tint, and the
 * per-row glyph in the session list.
 *
 * The case it WAS right about — **unattended** autonomy, an agent left running
 * without asking behind a relay binding or a scheduled task, where nobody is
 * watching a strip — is the descriptor above (DOR-814). It could not simply be
 * narrowed into place: the old banner only ever read the session in front of the
 * person, so the unattended case needed binding and task state this widget must
 * not fetch on every route, plus its own definition of unattended. Both now live
 * on the server (`services/core/unattended-autonomy/`), which is why
 * this hook reads one small aggregate and no lists.
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function useAppBanners(_sessionId: string | null): BannerDescriptor[] {
  const telemetry = useTelemetryBannerDescriptor();
  const unattended = useUnattendedAutonomyDescriptor();
  return [telemetry, unattended].filter((d): d is BannerDescriptor => d !== null);
}
