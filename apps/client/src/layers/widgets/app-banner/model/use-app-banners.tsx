import { useConfig } from '@/layers/entities/config';
import { TelemetryConsentBanner } from '@/layers/features/telemetry-consent';

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
 * The case it was right about is **unattended** autonomy — an agent left running
 * without asking behind a relay binding or a scheduled task, where nobody is
 * watching the strip. That banner is not built: it needs binding and task state
 * this widget does not fetch (and must not fetch on every route), and its own
 * rules about what counts as unattended. It is written down as a follow-up in
 * `specs/trust-dial/04-design-decisions.md`, under "Follow-ups opened by the
 * implementation".
 *
 * @param sessionId - The active session id, or null when none is selected.
 */
export function useAppBanners(_sessionId: string | null): BannerDescriptor[] {
  const telemetry = useTelemetryBannerDescriptor();
  return [telemetry].filter((d): d is BannerDescriptor => d !== null);
}
